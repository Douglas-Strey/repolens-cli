import { intersects, minVersion, satisfies, valid, validRange } from 'semver'
import { manifests, type PackageManifest } from '../../facts/manifests.ts'
import type { Diagnostic, DoctorRule, ProjectContext, Runtime, Sections, VersionSource } from '../../types.ts'
import { compareText } from '../../utils/compare.ts'
import { baseName, dirOf, isInDir } from '../../utils/paths.ts'
import { majorOf } from '../../utils/versions.ts'
import { formatList, parseFailed, safeText, uniqueSorted } from './shared.ts'

// ---------------------------------------------------------------------------
// Node.js pins
// ---------------------------------------------------------------------------

/** End-of-life dates of Node.js release lines (https://github.com/nodejs/Release). */
export const NODE_EOL: Readonly<Record<number, string>> = {
  10: '2021-04-30',
  12: '2022-04-30',
  14: '2023-04-30',
  16: '2023-09-11',
  17: '2022-06-01',
  18: '2025-04-30',
  19: '2023-06-01',
  20: '2026-04-30',
  21: '2024-06-01',
  22: '2027-04-30',
  23: '2025-06-01',
  24: '2028-04-30',
  25: '2026-06-01',
  26: '2029-04-30',
}

export interface NodePin {
  file: string
  version: string
  major: number
}

/**
 * Exact Node.js pins (.nvmrc, .node-version, Docker FROM, CI setup-node, …),
 * de-duplicated and sorted by file. A file that pins several majors is a test
 * matrix, not a conflicting pin, so it is left out.
 */
export function nodePins(runtimes: readonly Runtime[]): NodePin[] {
  const node = runtimes.find((runtime) => runtime.id === 'node')
  if (!node) return []
  const pins: NodePin[] = []
  const seen = new Set<string>()
  const majorsByFile = new Map<string, Set<number>>()
  for (const source of node.sources) {
    if (source.kind !== 'exact' || !source.version) continue
    const major = majorOf(source.version)
    if (major === null) continue
    const version = safeText(source.version, 40)
    const key = `${source.file}\0${version}`
    if (seen.has(key)) continue
    seen.add(key)
    pins.push({ file: source.file, version, major })
    const majors = majorsByFile.get(source.file) ?? new Set<number>()
    majors.add(major)
    majorsByFile.set(source.file, majors)
  }
  return pins
    .filter((pin) => majorsByFile.get(pin.file)?.size === 1)
    .sort((a, b) => compareText(a.file, b.file) || compareText(a.version, b.version))
}

/**
 * Can `version` (full "22.11.0" or partial "22" / "22.11") satisfy `range`?
 * Returns null when either side can't be interpreted.
 */
export function versionFitsRange(version: string, range: string): boolean | null {
  try {
    if (!validRange(range)) return null
    const full = valid(version.trim().replace(/^v/, ''))
    if (full) return satisfies(full, range, { includePrerelease: true })
    const partial = /^v?(\d+)(?:\.(\d+))?$/.exec(version.trim())
    if (!partial?.[1]) return null
    const target = partial[2] !== undefined ? `${partial[1]}.${partial[2]}.x` : `${partial[1]}.x`
    return intersects(range, target)
  } catch {
    return null
  }
}

/** The major to standardize on: the most pinned one that fits engines.node, else the lowest the range allows. */
export function suggestNodeMajor(pins: readonly NodePin[], range?: string): number | null {
  const counts = new Map<number, number>()
  for (const pin of pins) counts.set(pin.major, (counts.get(pin.major) ?? 0) + 1)
  let candidates = [...counts.keys()]
  if (range) {
    candidates = candidates.filter((major) => versionFitsRange(String(major), range) === true)
    if (candidates.length === 0) {
      try {
        return validRange(range) ? (minVersion(range)?.major ?? null) : null
      } catch {
        return null
      }
    }
  }
  candidates.sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || b - a)
  return candidates[0] ?? null
}

/** Files that pin Node.js for the directory they are in (as opposed to CI workflows or Dockerfiles). */
const NODE_VERSION_FILES: ReadonlySet<string> = new Set([
  '.nvmrc',
  '.node-version',
  '.tool-versions',
  '.prototools',
  'mise.toml',
  '.mise.toml',
  'package.json',
])

/**
 * Split pins into scopes that must agree. A directory with its own version
 * file (a monorepo package with its own .nvmrc or volta pin) may run a
 * different Node.js major on purpose; every other pin (CI workflows,
 * Dockerfiles, packages without their own pin) belongs to the root scope.
 * Returns scope directory → pins, root first, then sorted.
 */
export function pinScopes(pins: readonly NodePin[]): Map<string, NodePin[]> {
  const dirs = new Set(['.'])
  for (const pin of pins) if (NODE_VERSION_FILES.has(baseName(pin.file))) dirs.add(dirOf(pin.file))
  const scopes = [...dirs].sort((a, b) => (a === '.' ? -1 : b === '.' ? 1 : compareText(a, b)))
  const out = new Map<string, NodePin[]>(scopes.map((dir) => [dir, []]))
  for (const pin of pins) {
    let scope = '.'
    for (const dir of scopes) if (isInDir(pin.file, dir) && dir.length > scope.length) scope = dir
    out.get(scope)?.push(pin)
  }
  return out
}

/** `scope` is the directory the pins belong to ("." = the whole repository). */
export function findNodeVersionConflict(pins: readonly NodePin[], range?: string, scope = '.'): Diagnostic[] {
  if (new Set(pins.map((pin) => pin.major)).size < 2) return []
  const suggestion = suggestNodeMajor(pins, range)
  const where = scope === '.' ? '' : ` in ${scope}`
  return [
    {
      code: 'NODE_VERSION_CONFLICT',
      severity: 'warning',
      category: 'runtime',
      message: `Node.js versions disagree${where} (${pins.map((pin) => `${pin.file}: ${pin.version}`).join(', ')})`,
      hint:
        suggestion === null
          ? 'Pin the same Node.js major version in every file'
          : `Pin the same Node.js major version in every file, e.g. ${suggestion}`,
      files: uniqueSorted(pins.map((pin) => pin.file)),
      subject: scope === '.' ? 'node' : `node:${scope}`,
    },
  ]
}

export interface EnginesRange {
  range: string
  /** package.json declaring it. */
  file: string
}

/**
 * engines.node that applies to a file: the one of the deepest package
 * containing it, else the root's. `packages` must include the root.
 */
export function enginesRangeFor(
  file: string,
  packages: readonly Pick<PackageManifest, 'dir' | 'file' | 'engines'>[],
): EnginesRange | undefined {
  let best: EnginesRange | undefined
  let bestDepth = -1
  for (const pkg of packages) {
    const range = pkg.engines.node?.trim()
    if (!range || !isInDir(file, pkg.dir)) continue
    const depth = pkg.dir === '.' ? 0 : pkg.dir.split('/').length
    if (depth > bestDepth) {
      best = { range, file: pkg.file }
      bestDepth = depth
    }
  }
  return best
}

/** `engines` is the root engines.node range, or a lookup of the range that applies to a pin's file. */
export function findNodeOutOfRange(
  pins: readonly NodePin[],
  engines: string | ((file: string) => EnginesRange | undefined),
): Diagnostic[] {
  const lookup = typeof engines === 'string' ? () => ({ range: engines, file: 'package.json' }) : engines
  const out: Diagnostic[] = []
  const reported = new Set<string>()
  for (const pin of pins) {
    const applicable = lookup(pin.file)
    if (!applicable || reported.has(pin.file) || versionFitsRange(pin.version, applicable.range) !== false) continue
    reported.add(pin.file)
    const shown = safeText(applicable.range, 60)
    out.push({
      code: 'NODE_VERSION_OUT_OF_RANGE',
      severity: 'warning',
      category: 'runtime',
      message: `${pin.file} pins Node.js ${pin.version}, which does not satisfy engines.node "${shown}" in ${applicable.file}`,
      hint: `Use a version matching "${shown}" in ${pin.file}, or update engines.node`,
      files: uniqueSorted([pin.file, applicable.file]),
      subject: pin.file,
    })
  }
  return out
}

/** Approximate start of Active LTS for an even major (late October of its release year). */
function ltsStart(major: number): number {
  return Date.UTC(2013 + major / 2, 9, 31)
}

function eolTime(major: number): number | null {
  const date = NODE_EOL[major]
  return date ? Date.parse(`${date}T00:00:00Z`) : null
}

/** LTS majors that are supported at `now`, oldest first. */
export function supportedLtsMajors(now: Date): number[] {
  return Object.keys(NODE_EOL)
    .map(Number)
    .filter((major) => major % 2 === 0 && ltsStart(major) <= now.getTime() && (eolTime(major) ?? 0) > now.getTime())
    .sort((a, b) => a - b)
}

export function findEndOfLife(pins: readonly NodePin[], now: Date): Diagnostic[] {
  const filesByMajor = new Map<number, string[]>()
  for (const pin of pins) {
    const eol = eolTime(pin.major)
    if (eol === null || now.getTime() < eol) continue
    filesByMajor.set(pin.major, [...(filesByMajor.get(pin.major) ?? []), pin.file])
  }
  const lts = supportedLtsMajors(now).map((major) => String(major))
  const out: Diagnostic[] = []
  for (const [major, files] of [...filesByMajor].sort(([a], [b]) => a - b)) {
    const pinnedIn = uniqueSorted(files)
    out.push({
      code: 'RUNTIME_EOL',
      severity: 'warning',
      category: 'runtime',
      message: `Node.js ${major} reached end-of-life on ${NODE_EOL[major]} (pinned in ${formatList(pinnedIn)})`,
      hint:
        lts.length > 0
          ? `Upgrade to a supported LTS release (Node.js ${formatList(lts, 'or')})`
          : 'Upgrade to a supported LTS release',
      files: pinnedIn,
      subject: `node@${major}`,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Go toolchains
// ---------------------------------------------------------------------------

export interface GoToolVersion {
  file: string
  version: string
  kind: 'docker' | 'ci'
}

export interface GoModuleVersion {
  dir: string
  file: string
  goVersion: string
}

const GOLANG_IMAGE = /^(?:[\w.-]+(?::\d+)?\/)*golang:(\d+\.\d+(?:\.\d+)?)(?![\d.])/
const DOCKERFILE_NAME = /^(?:Dockerfile|Containerfile)(?:\..+)?$|\.(?:dockerfile|containerfile)$/i

function isCiFile(file: string): boolean {
  return (
    file.startsWith('.github/workflows/') ||
    file.startsWith('.circleci/') ||
    file === '.gitlab-ci.yml' ||
    file === 'azure-pipelines.yml' ||
    file === 'bitbucket-pipelines.yml'
  )
}

function classifyGoSource(source: VersionSource): GoToolVersion['kind'] | null {
  if (source.field === 'FROM' || DOCKERFILE_NAME.test(baseName(source.file))) return 'docker'
  if (source.field === 'setup-go' || isCiFile(source.file)) return 'ci'
  return null
}

/** Go versions used to build the project: golang base images and CI setup-go versions. */
export function goToolVersions(scan: Pick<Sections, 'runtimes' | 'services'>): GoToolVersion[] {
  const out: GoToolVersion[] = []
  const seen = new Set<string>()
  const add = (tool: GoToolVersion) => {
    const key = `${tool.file}\0${tool.version}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(tool)
  }
  for (const source of scan.runtimes.find((runtime) => runtime.id === 'go')?.sources ?? []) {
    if (source.kind !== 'exact' || !source.version) continue
    const kind = classifyGoSource(source)
    if (kind) add({ file: source.file, version: safeText(source.version, 40), kind })
  }
  for (const dockerfile of scan.services.dockerfiles) {
    for (const image of dockerfile.baseImages) {
      const version = GOLANG_IMAGE.exec(image)?.[1]
      if (version) add({ file: dockerfile.path, version, kind: 'docker' })
    }
  }
  return out
}

interface GoVersionParts {
  major: number
  minor: number
  patch?: number
}

export function parseGoVersion(version: string): GoVersionParts | null {
  const match = /^(?:go)?v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(version.trim())
  if (!match?.[1] || !match[2]) return null
  const parts: GoVersionParts = { major: Number(match[1]), minor: Number(match[2]) }
  if (match[3] !== undefined) parts.patch = Number(match[3])
  return parts
}

/**
 * Is the toolchain older than the go directive? A floating tag such as
 * golang:1.25 always gets the newest patch, so patches are only compared when
 * the toolchain pins one.
 */
export function isGoToolchainOlder(tool: string, required: string): boolean {
  const t = parseGoVersion(tool)
  const r = parseGoVersion(required)
  if (!t || !r) return false
  if (t.major !== r.major) return t.major < r.major
  if (t.minor !== r.minor) return t.minor < r.minor
  return t.patch !== undefined && t.patch < (r.patch ?? 0)
}

/** The module a Dockerfile or workflow builds: the deepest module containing it, or the only module. */
function owningModule(file: string, modules: readonly GoModuleVersion[]): GoModuleVersion | undefined {
  let best: GoModuleVersion | undefined
  for (const mod of modules) {
    if (isInDir(file, mod.dir) && (!best || mod.dir.length > best.dir.length)) best = mod
  }
  return best ?? (modules.length === 1 ? modules[0] : undefined)
}

export function findGoVersionConflicts(
  tools: readonly GoToolVersion[],
  modules: readonly GoModuleVersion[],
): Diagnostic[] {
  const out: Diagnostic[] = []
  const reported = new Set<string>()
  for (const tool of tools) {
    if (reported.has(tool.file)) continue
    const mod = owningModule(tool.file, modules)
    if (!mod || !isGoToolchainOlder(tool.version, mod.goVersion)) continue
    reported.add(tool.file)
    const required = safeText(mod.goVersion, 40)
    // Toolchain switching (and GOTOOLCHAIN=local in the official images) only exists since Go 1.21.
    const switches = !isGoToolchainOlder(tool.version, '1.21')
    const dockerOutcome = switches
      ? 'and the official golang image sets GOTOOLCHAIN=local so the build fails'
      : 'which Go versions before 1.21 do not enforce, so the build may fail on newer language features'
    const ciOutcome = switches
      ? 'so the job must download a newer toolchain or fails with GOTOOLCHAIN=local'
      : 'which Go versions before 1.21 cannot switch to, so the build may fail on newer language features'
    out.push({
      code: 'GO_VERSION_CONFLICT',
      severity: 'warning',
      category: 'runtime',
      message:
        tool.kind === 'docker'
          ? `${tool.file} builds with Go ${tool.version}, but ${mod.file} requires go ${required}, ${dockerOutcome}`
          : `${tool.file} sets up Go ${tool.version}, but ${mod.file} requires go ${required}, ${ciOutcome}`,
      hint:
        tool.kind === 'docker'
          ? `Use golang:${required} or newer in ${tool.file}`
          : `Set go-version to ${required} or newer, or use go-version-file: ${mod.file}`,
      files: [tool.file, mod.file],
      subject: tool.file,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

function hasExactNodePin(scan: Sections): boolean {
  return scan.runtimes.some((runtime) => runtime.id === 'node' && runtime.sources.some((s) => s.kind === 'exact'))
}

/** engines.node is declared somewhere: the range NODE_VERSION_OUT_OF_RANGE compares pins with. */
function hasEnginesNode(scan: Sections): boolean {
  return scan.runtimes.some(
    (runtime) => runtime.id === 'node' && runtime.sources.some((s) => s.field === 'engines.node'),
  )
}

async function packageManifests(ctx: ProjectContext): Promise<readonly PackageManifest[]> {
  return (await ctx.use(manifests)).packages
}

export const nodeVersionConflict: DoctorRule = {
  code: 'NODE_VERSION_CONFLICT',
  category: 'runtime',
  title: 'Node.js version pins agree',
  // Agreement needs at least two pins.
  applies: (scan) => nodePins(scan.runtimes).length >= 2,
  async check(scan, ctx) {
    const packages = await packageManifests(ctx)
    const out: Diagnostic[] = []
    for (const [scope, pins] of pinScopes(nodePins(scan.runtimes))) {
      const range = enginesRangeFor(scope === '.' ? 'package.json' : `${scope}/package.json`, packages)?.range
      out.push(...findNodeVersionConflict(pins, range, scope))
    }
    return out
  },
}

export const nodeVersionOutOfRange: DoctorRule = {
  code: 'NODE_VERSION_OUT_OF_RANGE',
  category: 'runtime',
  title: 'Node.js pins satisfy engines.node',
  applies: (scan) => hasExactNodePin(scan) && hasEnginesNode(scan),
  async check(scan, ctx) {
    const packages = await packageManifests(ctx)
    return findNodeOutOfRange(nodePins(scan.runtimes), (file) => enginesRangeFor(file, packages))
  },
}

export const runtimeEol: DoctorRule = {
  code: 'RUNTIME_EOL',
  category: 'runtime',
  title: 'Pinned runtimes are supported',
  applies: hasExactNodePin,
  check: (scan, ctx) => findEndOfLife(nodePins(scan.runtimes), ctx.options.now),
}

export const goVersionConflict: DoctorRule = {
  code: 'GO_VERSION_CONFLICT',
  category: 'runtime',
  title: 'Go toolchains satisfy go.mod',
  applies: (scan, ctx) =>
    goToolVersions(scan).length > 0 && ctx.files.byName('go.mod').some((file) => !parseFailed(ctx, file)),
  async check(scan, ctx) {
    const project = await ctx.use(manifests)
    const modules: GoModuleVersion[] = []
    for (const mod of project.goModules) {
      if (mod.goVersion) modules.push({ dir: mod.dir, file: mod.file, goVersion: mod.goVersion })
    }
    return findGoVersionConflicts(goToolVersions(scan), modules)
  },
}

export const runtimeRules: DoctorRule[] = [nodeVersionConflict, nodeVersionOutOfRange, runtimeEol, goVersionConflict]
