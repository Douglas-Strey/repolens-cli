import { isRecord } from '../../core/parse.ts'
import { type DependencyIndex, dependencies } from '../../facts/dependencies.ts'
import { type GoRequire, manifests } from '../../facts/manifests.ts'
import type { Diagnostic, DoctorRule, ProjectContext, Sections, Severity } from '../../types.ts'
import { shellQuote } from '../../utils/commands.ts'
import { compareText } from '../../utils/compare.ts'
import { isUnder, NON_PROJECT_ROLES } from '../../utils/path-roles.ts'
import { baseName, dirOf, extOf, joinPath } from '../../utils/paths.ts'
import { cleanVersion, majorOf } from '../../utils/versions.ts'
import { countOf, parseFailed } from './shared.ts'

// ---------------------------------------------------------------------------
// ESLint
// ---------------------------------------------------------------------------

export const LEGACY_ESLINT_FILES: readonly string[] = [
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc.yaml',
  '.eslintrc.yml',
]

export interface LegacyEslintConfig {
  /** The .eslintrc* file, or the package.json holding "eslintConfig". */
  file: string
  /** Package directory the config belongs to. */
  dir: string
  kind: 'file' | 'package.json'
}

/** Major version of `name` declared by the package in `dir`, else by the root, else anywhere. */
export function dependencyMajor(deps: DependencyIndex, name: string, dir: string): number | null {
  const refs = deps.get(name).filter((ref) => ref.ecosystem === 'node')
  const ref = refs.find((r) => r.package === dir) ?? refs.find((r) => r.package === '.') ?? refs[0]
  return ref ? majorOf(cleanVersion(ref.range)) : null
}

const FLAT_CONFIG_OPT_OUT = /\bESLINT_USE_FLAT_CONFIG=(["']?)false\1(?![\w-])/

/** Does a script opt ESLint 9 back into eslintrc with `ESLINT_USE_FLAT_CONFIG=false`? */
export function optsOutOfFlatConfig(scripts: Readonly<Record<string, string>>): boolean {
  return Object.values(scripts).some((command) => FLAT_CONFIG_OPT_OUT.test(command.slice(0, 1000)))
}

/**
 * `majorFor(dir)` returns the ESLint major used by that package, or null when
 * unknown. `optedOut(dir)` tells whether the package's (or the root's) scripts
 * set ESLINT_USE_FLAT_CONFIG=false, which ESLint 9 still honors.
 */
export function findLegacyEslintConfigs(
  configs: readonly LegacyEslintConfig[],
  majorFor: (dir: string) => number | null,
  optedOut: (dir: string) => boolean = () => false,
): Diagnostic[] {
  const out: Diagnostic[] = []
  for (const config of configs) {
    const major = majorFor(config.dir)
    if (major !== null && major < 9) continue
    const explicit = major === 9 && optedOut(config.dir)
    const severity: Severity = major === null || explicit ? 'info' : major >= 10 ? 'error' : 'warning'
    const what =
      config.kind === 'file'
        ? `${config.file} is a legacy ESLint config`
        : `"eslintConfig" in ${config.file} is legacy ESLint config`
    const consequence =
      major === null
        ? 'which ESLint 9 and newer no longer use by default'
        : major >= 10
          ? `which ESLint ${major} no longer reads`
          : explicit
            ? 'which ESLint 9 only reads because a script sets ESLINT_USE_FLAT_CONFIG=false, an option ESLint 10 removes'
            : `but ESLint ${major} only reads eslint.config.js by default`
    const flatConfig = joinPath(config.dir, 'eslint.config.js')
    out.push({
      code: 'ESLINT_LEGACY_CONFIG',
      severity,
      category: 'tooling',
      message: `${what}, ${consequence}`,
      hint:
        config.kind === 'file'
          ? `Migrate to ${flatConfig} with \`npx @eslint/migrate-config ${shellQuote(config.file)}\``
          : `Move the "eslintConfig" settings into ${flatConfig} and delete the field`,
      files: [config.file],
      subject: config.kind === 'file' ? config.file : `${config.file}#eslintConfig`,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// go.sum
// ---------------------------------------------------------------------------

/** Module paths replaced by a local directory (`replace x => ../x`), which need no checksum. */
export function localReplacements(goMod: string): Set<string> {
  const replaced = new Set<string>()
  let inBlock = false
  for (const rawLine of goMod.split(/\r?\n/)) {
    const line = rawLine.replace(/\/\/.*$/, '').trim()
    if (line === '') continue
    if (inBlock) {
      if (line === ')') {
        inBlock = false
        continue
      }
    } else if (/^replace\s*\($/.test(line)) {
      inBlock = true
      continue
    } else if (!line.startsWith('replace ')) {
      continue
    }
    const match = /^(?:replace\s+)?(\S+)(?:\s+\S+)?\s*=>\s*(\S+)/.exec(line)
    if (match?.[1] && match[2] && /^(?:\.{1,2}\/|\/)/.test(match[2])) replaced.add(match[1].replace(/^["`]|["`]$/g, ''))
  }
  return replaced
}

export interface GoSumState {
  /** go.mod path. */
  file: string
  dir: string
  requires: readonly GoRequire[]
  /** Module paths replaced by local directories or provided by other modules of the repository (go.work). */
  replaced: ReadonlySet<string>
  sum: 'present' | 'missing' | 'ignored'
}

export function findMissingGoSum(modules: readonly GoSumState[]): Diagnostic[] {
  const out: Diagnostic[] = []
  for (const mod of modules) {
    if (mod.sum === 'present') continue
    const needed = mod.requires.filter((req) => !req.indirect && !mod.replaced.has(req.path))
    if (needed.length === 0) continue
    const sumPath = joinPath(mod.dir, 'go.sum')
    const where = mod.dir === '.' ? '' : ` in ${mod.dir}`
    out.push({
      code: 'GO_SUM_MISSING',
      severity: 'warning',
      category: 'tooling',
      message:
        mod.sum === 'ignored'
          ? `${sumPath} is ignored by Git, so the checksums for ${mod.file} are not committed`
          : `${mod.file} requires ${countOf(needed.length, 'module')} but there is no go.sum next to it`,
      hint:
        mod.sum === 'ignored'
          ? `Remove go.sum from .gitignore and commit ${sumPath}`
          : `Run \`go mod tidy\`${where} and commit ${sumPath}`,
      files: [mod.file],
      subject: mod.file,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Next.js middleware → proxy
// ---------------------------------------------------------------------------

export interface NextApp {
  dir: string
  major: number | null
}

const MIDDLEWARE_FILES = ['middleware.ts', 'middleware.js']
const PROXY_FILES = ['proxy.ts', 'proxy.js']

export function findNextMiddleware(apps: readonly NextApp[], exists: (path: string) => boolean): Diagnostic[] {
  const out: Diagnostic[] = []
  for (const app of apps) {
    if (app.major === null || app.major < 16) continue
    const bases = [app.dir, joinPath(app.dir, 'src')]
    const middleware = bases.flatMap((base) => MIDDLEWARE_FILES.map((name) => joinPath(base, name))).find(exists)
    if (!middleware) continue
    if (bases.some((base) => PROXY_FILES.some((name) => exists(joinPath(base, name))))) continue
    const proxy = joinPath(dirOf(middleware), `proxy${extOf(middleware)}`)
    out.push({
      code: 'NEXT_MIDDLEWARE_DEPRECATED',
      severity: 'info',
      category: 'tooling',
      message: `${middleware} uses the middleware convention, which Next.js 16 renamed to proxy`,
      hint: `Rename it to ${proxy} and rename the exported middleware function to proxy`,
      files: [middleware],
      subject: middleware,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

function mayUseNext(scan: Sections): boolean {
  return (
    scan.project.manifests.length === 0 ||
    scan.frameworks.some((framework) => framework.id === 'next') ||
    scan.dependencies.packages.some((pkg) => pkg.dependencies.some((dep) => dep.name === 'next'))
  )
}

/**
 * A file of the project itself rather than of a fixture or example: at the
 * root, or outside test/fixture/example/template directories.
 */
function isProjectFile(file: string): boolean {
  return dirOf(file) === '.' || !isUnder(file, NON_PROJECT_ROLES)
}

/** Legacy config files next to a package.json of the project, or an "eslintConfig" field found by the linting section. */
function mayHaveLegacyEslintConfig(scan: Sections, ctx: ProjectContext): boolean {
  const besidePackage = (file: string) =>
    isProjectFile(file) && (dirOf(file) === '.' || ctx.files.has(joinPath(dirOf(file), 'package.json')))
  if (LEGACY_ESLINT_FILES.some((name) => ctx.files.byName(name).some(besidePackage))) return true
  const eslint = scan.linting.tools.find((tool) => tool.id === 'eslint')
  return eslint?.configFiles.some((file) => baseName(file) === 'package.json') ?? false
}

export const eslintLegacyConfig: DoctorRule = {
  code: 'ESLINT_LEGACY_CONFIG',
  category: 'tooling',
  title: 'ESLint uses flat config',
  applies: mayHaveLegacyEslintConfig,
  async check(_scan, ctx) {
    const project = await ctx.use(manifests)
    const packageDirs = new Set(['.', ...project.packages.map((p) => p.dir)])
    const configs: LegacyEslintConfig[] = []
    for (const name of LEGACY_ESLINT_FILES) {
      for (const file of ctx.files.byName(name)) {
        const dir = dirOf(file)
        if (packageDirs.has(dir)) configs.push({ file, dir, kind: 'file' })
      }
    }
    for (const manifest of project.packages) {
      if (isRecord(manifest.raw.eslintConfig))
        configs.push({ file: manifest.file, dir: manifest.dir, kind: 'package.json' })
    }
    if (configs.length === 0) return []
    configs.sort((a, b) => compareText(a.file, b.file))
    const deps = await ctx.use(dependencies)
    const scriptsOf = (dir: string) => project.packages.find((p) => p.dir === dir)?.scripts ?? {}
    return findLegacyEslintConfigs(
      configs,
      (dir) => dependencyMajor(deps, 'eslint', dir),
      (dir) => optsOutOfFlatConfig(scriptsOf(dir)) || optsOutOfFlatConfig(scriptsOf('.')),
    )
  },
}

export const goSumMissing: DoctorRule = {
  code: 'GO_SUM_MISSING',
  category: 'tooling',
  title: 'Go modules have a committed go.sum',
  // go.mod files without a module line are reported by CONFIG_PARSE_ERROR and give this check nothing to read.
  applies: (_scan, ctx) => ctx.files.byName('go.mod').some((file) => isProjectFile(file) && !parseFailed(ctx, file)),
  async check(_scan, ctx) {
    const project = await ctx.use(manifests)
    // Requirements on sibling modules of a go.work workspace need no checksums.
    const inGoWork = project.workspaces.some((declaration) => declaration.source === 'go.work')
    const localModules = inGoWork ? project.goModules.map((mod) => mod.module) : []
    const states: GoSumState[] = []
    for (const mod of project.goModules) {
      if (mod.hasGoSum) continue
      const sumPath = joinPath(mod.dir, 'go.sum')
      const ignored = ctx.files.has(sumPath, { includeIgnored: true })
      // A truncated file walk can stop between go.mod and go.sum.
      if (!ignored && ctx.files.truncated) continue
      const text = await ctx.readText(mod.file)
      states.push({
        file: mod.file,
        dir: mod.dir,
        requires: mod.requires,
        replaced: new Set([...localModules, ...(text === null ? [] : localReplacements(text))]),
        sum: ignored ? 'ignored' : 'missing',
      })
    }
    return findMissingGoSum(states)
  },
}

export const nextMiddlewareDeprecated: DoctorRule = {
  code: 'NEXT_MIDDLEWARE_DEPRECATED',
  category: 'tooling',
  title: 'Next.js apps use the proxy convention',
  applies: (scan, ctx) => MIDDLEWARE_FILES.some((name) => ctx.files.byName(name).length > 0) && mayUseNext(scan),
  async check(_scan, ctx) {
    const deps = await ctx.use(dependencies)
    const apps = new Map<string, NextApp>()
    for (const ref of deps.get('next')) {
      // A peer dependency marks a library for Next.js apps, not an app.
      if (ref.ecosystem !== 'node' || ref.type === 'peerDependencies' || apps.has(ref.package)) continue
      apps.set(ref.package, { dir: ref.package, major: majorOf(cleanVersion(ref.range)) })
    }
    return findNextMiddleware([...apps.values()], (path) => ctx.files.has(path))
  },
}

export const toolingRules: DoctorRule[] = [eslintLegacyConfig, goSumMissing, nextMiddlewareDeprecated]
