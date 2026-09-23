/**
 * Table-driven detection of build tools, test runners, linters, formatters
 * and git hooks. A `ToolSpec` lists the ways a tool can show up (dependency,
 * config file, package.json field, script, Python requirement); every match
 * becomes a `Signal`, and the signals are merged into one `Tool`.
 */
import { type DependencyIndex, type DependencyRef, dependencies } from '../../facts/dependencies.ts'
import type { Analyzer, Confidence, Tool, ToolKind } from '../../types.ts'
import { compareText } from '../../utils/compare.ts'
import { dirOf, joinPath, normalizeRelative } from '../../utils/paths.ts'
import { type Invocation, parseInvocations } from './commands.ts'
import { type LocatedFile, locateFiles, type ProjectLayout, projectLayout } from './layout.ts'
import { hasTable, normalizePythonName, type PythonFacts } from './python.ts'
import {
  configEvidence,
  dependencyEvidence,
  displayRange,
  displayScriptName,
  displayVersion,
  mergeSignals,
  minConfidence,
  type Signal,
} from './signals.ts'

/** Extensions a JS/TS config file can have, as a glob alternative. */
export const JS_EXTENSIONS = '{js,mjs,cjs,ts,mts,cts}'

export interface ConfigPattern {
  /** Path relative to a package directory; see `locateFiles`. */
  pattern: string
  /** Appended to the evidence, e.g. "flat config". */
  note?: string
  /** Generic file name (e.g. build.config.ts): alone it is only a low-confidence hint. */
  weak?: boolean
}

export interface PackageJsonField {
  key: string
  note?: string
}

export interface ScriptMatcher {
  /** What the evidence says the script runs, e.g. "tsc" or "node --test". */
  label: string
  /** `script` holds every program the script runs, `invocation` included. */
  test(invocation: Invocation, scriptName: string, script: readonly Invocation[]): boolean
}

export interface ToolSpec {
  id: string
  name: string
  kind: ToolKind
  /** npm packages or Go modules that identify the tool. */
  dependencies?: readonly string[]
  /** Packages that suggest the tool but are also used without it; at most medium confidence. */
  weakDependencies?: readonly string[]
  /** Package name prefixes, e.g. "@testing-library/". */
  dependencyPrefixes?: readonly string[]
  /** Python distributions, normalized (see normalizePythonName). */
  pythonPackages?: readonly string[]
  /** pyproject.toml tables that configure the tool, e.g. "tool.ruff". */
  pyprojectTables?: readonly string[]
  configs?: readonly (string | ConfigPattern)[]
  packageJsonFields?: readonly PackageJsonField[]
  scripts?: readonly ScriptMatcher[]
  /**
   * The tool's executables. A package.json script that runs one with
   * `--config <file>` or `-c <file>` names a config file outside the usual
   * locations (e.g. `jest --config ./test/jest-e2e.json`).
   */
  bins?: readonly string[]
  /** False when the tool's `-c` is not `--config` (prettier: --check, mocha: --colors). */
  shortConfigFlag?: boolean
  /** Dependency whose version is reported when the spec's own signals carry none (tsc → typescript). */
  versionFrom?: string
  /** False for families of packages with unrelated versions (Testing Library). */
  reportVersion?: boolean
}

export interface ToolFacts {
  dependencies: DependencyIndex
  layout: ProjectLayout
  python?: PythonFacts
  /**
   * Package directories whose dependencies only say what a shared config
   * package needs (an eslint-config depending on @babel/core), not what the
   * project uses. Their dependency signals are lowered to low confidence.
   */
  configOnlyPackages?: ReadonlySet<string>
}

/** Tools declared in dependencies/devDependencies are the norm; peers only hint at them. */
export function toolDependencyConfidence(ref: DependencyRef): Confidence {
  if (ref.type === 'go') return ref.indirect ? 'low' : 'high'
  return ref.type === 'peerDependencies' ? 'low' : 'high'
}

export function toConfigPattern(config: string | ConfigPattern): ConfigPattern {
  return typeof config === 'string' ? { pattern: config } : config
}

/** Config files for a list of patterns; a file matched by several patterns keeps the first. */
export function locateConfigs(
  layout: ProjectLayout,
  configs: readonly (string | ConfigPattern)[],
): Array<LocatedFile & { config: ConfigPattern }> {
  const seen = new Set<string>()
  const out: Array<LocatedFile & { config: ConfigPattern }> = []
  for (const config of configs.map(toConfigPattern)) {
    for (const located of locateFiles(layout, [config.pattern])) {
      if (seen.has(located.path)) continue
      seen.add(located.path)
      out.push({ ...located, config })
    }
  }
  return out
}

function dependencySignals(spec: ToolSpec, deps: DependencyIndex, configOnly?: ReadonlySet<string>): Signal[] {
  const refs: Array<{ ref: DependencyRef; weak: boolean }> = []
  const seen = new Set<DependencyRef>()
  const add = (list: DependencyRef[], weak: boolean) => {
    for (const ref of list) {
      if (seen.has(ref)) continue
      seen.add(ref)
      refs.push({ ref, weak })
    }
  }
  for (const name of spec.dependencies ?? []) add(deps.get(name), false)
  for (const prefix of spec.dependencyPrefixes ?? []) add(deps.withPrefix(prefix), false)
  for (const name of spec.weakDependencies ?? []) add(deps.get(name), true)

  return refs.map(({ ref, weak }) => {
    const confidence = toolDependencyConfidence(ref)
    const inConfigPackage = configOnly?.has(ref.package) === true
    const signal: Signal = {
      package: ref.package,
      confidence: inConfigPackage ? 'low' : weak ? minConfidence(confidence, 'medium') : confidence,
      evidence: `${dependencyEvidence(ref)}${inConfigPackage ? ' (a shared config package)' : ''}`,
    }
    const version = spec.reportVersion === false ? undefined : displayVersion(ref.range)
    if (version !== undefined) signal.version = version
    return signal
  })
}

function pythonSignals(spec: ToolSpec, python: PythonFacts | undefined): Signal[] {
  if (!python) return []
  const signals: Signal[] = []
  const wanted = new Set((spec.pythonPackages ?? []).map(normalizePythonName))
  if (wanted.size > 0) {
    for (const requirement of python.requirements) {
      if (!wanted.has(requirement.name)) continue
      const range = requirement.spec ? displayRange(requirement.spec) : undefined
      const signal: Signal = {
        package: requirement.package,
        confidence: 'high',
        evidence: `dependency ${requirement.name}${range ?? ''} in ${requirement.file}`,
      }
      const version = displayVersion(requirement.spec)
      if (version !== undefined) signal.version = version
      signals.push(signal)
    }
  }
  for (const table of spec.pyprojectTables ?? []) {
    for (const pyproject of python.pyprojects) {
      if (!hasTable(pyproject.tables, table)) continue
      signals.push({
        package: pyproject.package,
        confidence: 'high',
        evidence: `[${table}] in ${pyproject.file}`,
        configFile: pyproject.file,
      })
    }
  }
  return signals
}

function manifestSignals(spec: ToolSpec, layout: ProjectLayout): Signal[] {
  const signals: Signal[] = []
  for (const manifest of layout.manifests) {
    for (const field of spec.packageJsonFields ?? []) {
      if (!manifest.fields.includes(field.key)) continue
      signals.push({
        package: manifest.dir,
        confidence: 'high',
        evidence: `"${field.key}" field in ${manifest.file}${field.note ? ` (${field.note})` : ''}`,
        configFile: manifest.file,
      })
    }
    if (!spec.scripts && !spec.bins) continue
    for (const [name, command] of Object.entries(manifest.scripts)) {
      const invocations = parseInvocations(command)
      for (const matcher of spec.scripts ?? []) {
        if (!invocations.some((invocation) => matcher.test(invocation, name, invocations))) continue
        signals.push({
          package: manifest.dir,
          confidence: 'high',
          evidence: `"${displayScriptName(name)}" script runs ${matcher.label} in ${manifest.file}`,
        })
      }
      for (const invocation of invocations) {
        if (!spec.bins?.includes(invocation.bin)) continue
        const value = configArgument(invocation.args, spec.shortConfigFlag !== false)
        const configFile = value === undefined ? undefined : existingFile(layout, manifest.dir, value)
        if (!configFile) continue
        signals.push({
          package: manifest.dir,
          confidence: 'high',
          evidence: `config file ${configFile} (used by the "${displayScriptName(name)}" script)`,
          configFile,
        })
      }
    }
  }
  return signals
}

/**
 * The value of `--config <file>`, `--config=<file>` or, when `shortFlag` is
 * set, `-c <file>`. Some tools use `-c` for something else (`prettier -c` is
 * --check, `mocha -c` is --colors).
 */
export function configArgument(args: readonly string[], shortFlag = true): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg.startsWith('--config=')) return arg.slice('--config='.length)
    if (arg === '--config' || (shortFlag && arg === '-c')) {
      const value = args[i + 1]
      return value !== undefined && !value.startsWith('-') ? value : undefined
    }
  }
  return undefined
}

/** Resolve a script argument against the package directory; only indexed files inside the root count. */
function existingFile(layout: ProjectLayout, packageDir: string, value: string): string | undefined {
  const relative = normalizeRelative(value)
  if (relative === null) return undefined
  const path = joinPath(packageDir, relative)
  return layout.filesByDir.get(dirOf(path))?.includes(path) ? path : undefined
}

/** Every observation of one tool. `extra` adds signals computed elsewhere (e.g. from test files). */
export function toolSignals(spec: ToolSpec, facts: ToolFacts, extra: readonly Signal[] = []): Signal[] {
  const signals = [
    ...dependencySignals(spec, facts.dependencies, facts.configOnlyPackages),
    ...pythonSignals(spec, facts.python),
  ]
  const hasDependency = signals.length > 0
  for (const located of locateConfigs(facts.layout, spec.configs ?? [])) {
    signals.push({
      package: located.package,
      confidence: located.config.weak && !hasDependency ? 'low' : 'high',
      evidence: configEvidence(located.path, located.config.note),
      configFile: located.path,
    })
  }
  signals.push(...manifestSignals(spec, facts.layout), ...extra)
  return signals
}

/** Merge signals into a Tool; null when there are none. */
export function toolFromSignals(
  spec: Pick<ToolSpec, 'id' | 'name' | 'kind'>,
  signals: readonly Signal[],
  fallbackVersion?: string,
): Tool | null {
  const merged = mergeSignals(signals)
  if (!merged) return null
  const version = merged.version ?? fallbackVersion
  // Built key by key so JSON output keeps the documented field order.
  return {
    id: spec.id,
    name: spec.name,
    kind: spec.kind,
    ...(version === undefined ? {} : { version }),
    configFiles: merged.configFiles,
    packages: merged.packages,
    confidence: merged.confidence,
    evidence: merged.evidence,
  }
}

export function detectTool(spec: ToolSpec, facts: ToolFacts, extra: readonly Signal[] = []): Tool | null {
  const signals = toolSignals(spec, facts, extra)
  if (signals.length === 0) return null
  const fallback = spec.versionFrom ? displayVersion(facts.dependencies.get(spec.versionFrom)[0]?.range) : undefined
  return toolFromSignals(spec, signals, spec.reportVersion === false ? undefined : fallback)
}

/** Detect every spec; `extra` maps tool ids to additional signals. */
export function detectTools(
  specs: readonly ToolSpec[],
  facts: ToolFacts,
  extra: Readonly<Record<string, readonly Signal[]>> = {},
): Tool[] {
  const tools: Tool[] = []
  for (const spec of specs) {
    const tool = detectTool(spec, facts, extra[spec.id] ?? [])
    if (tool) tools.push(tool)
  }
  return tools
}

/** Sort by the position of the kind in `kindOrder`, then by name (case-insensitive), then id. */
export function sortTools(tools: readonly Tool[], kindOrder: readonly ToolKind[]): Tool[] {
  const rank = (kind: ToolKind) => {
    const index = kindOrder.indexOf(kind)
    return index === -1 ? kindOrder.length : index
  }
  return [...tools].sort((a, b) => {
    const byKind = rank(a.kind) - rank(b.kind)
    if (byKind !== 0) return byKind
    return compareText(a.name.toLowerCase(), b.name.toLowerCase()) || compareText(a.id, b.id)
  })
}

/** Dependencies and project layout, shared by the build, testing and linting detectors. */
export const toolFacts: Analyzer<ToolFacts> = {
  id: 'knowledge:tool-facts',
  async run(ctx) {
    const [deps, layout] = await Promise.all([ctx.use(dependencies), ctx.use(projectLayout)])
    return { dependencies: deps, layout }
  },
}
