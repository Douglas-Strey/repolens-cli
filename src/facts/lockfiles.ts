/**
 * Exact package versions installed by a project, read from its lockfiles:
 * npm, pnpm, Yarn (classic and Berry), Bun (text lockfile), Composer and Go
 * modules. Used by `repolens doctor --online` to look the versions up in
 * OSV.dev; nothing else reads them yet.
 */
import { valid } from 'semver'
import { isRecord, parseJson, parseJsonc, parseYaml } from '../core/parse.ts'
import type { Analyzer, ProjectContext } from '../types.ts'
import { compareText } from '../utils/compare.ts'
import { isUnder, NON_PROJECT_ROLES } from '../utils/path-roles.ts'
import { baseName, depthOf } from '../utils/paths.ts'
import { manifests } from './manifests.ts'

/** OSV ecosystem names. */
export type PackageEcosystem = 'npm' | 'Packagist' | 'Go'

export interface LockedPackage {
  ecosystem: PackageEcosystem
  name: string
  /** Exact version without a "v" prefix, e.g. "4.17.21". */
  version: string
}

export interface LockedPackages {
  /** Distinct packages, sorted by ecosystem, name, version. */
  packages: Array<LockedPackage & { lockfiles: string[] }>
  /** Lockfiles that were read. */
  lockfiles: string[]
}

/** Lockfiles are often several megabytes; this keeps a hostile one bounded. */
export const MAX_LOCKFILE_BYTES = 32 * 1024 * 1024
/** Lockfiles are looked for at the root and up to two directories deep. */
const MAX_LOCKFILE_DEPTH = 2

/** "1.2.3", "v1.2.3", "1.2.3-beta.1" → "1.2.3…"; anything else (git URLs, file:, dev-main) → null. */
export function exactVersion(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const version = raw.trim().replace(/^v(?=\d)/, '')
  return valid(version) === version ? version : null
}

/** Name of the package installed at a node_modules path ("node_modules/a/node_modules/@s/b" → "@s/b"). */
function nameFromInstallPath(path: string): string | null {
  const index = path.lastIndexOf('node_modules/')
  if (index === -1) return null
  const name = path.slice(index + 'node_modules/'.length)
  return /^(?:@[^/]+\/)?[^/@][^/]*$/.test(name) ? name : null
}

/** package-lock.json / npm-shrinkwrap.json, lockfile versions 1 to 3. */
export function parsePackageLock(doc: unknown): LockedPackage[] {
  if (!isRecord(doc)) return []
  const out: LockedPackage[] = []
  if (isRecord(doc.packages)) {
    for (const [path, entry] of Object.entries(doc.packages)) {
      if (path === '' || !isRecord(entry) || entry.link === true) continue
      const name = typeof entry.name === 'string' ? entry.name : nameFromInstallPath(path)
      const version = exactVersion(entry.version)
      if (name && version) out.push({ ecosystem: 'npm', name, version })
    }
    return out
  }
  // Version 1: a nested tree under "dependencies".
  const walk = (deps: unknown, depth: number) => {
    if (!isRecord(deps) || depth > 64) return
    for (const [name, entry] of Object.entries(deps)) {
      if (!isRecord(entry)) continue
      const version = exactVersion(entry.version)
      if (version) out.push({ ecosystem: 'npm', name, version })
      walk(entry.dependencies, depth + 1)
    }
  }
  walk(doc.dependencies, 0)
  return out
}

/**
 * A pnpm-lock.yaml package key, any lockfile version: "/lodash/4.17.21"
 * (5.x), "/lodash@4.17.21(peer@1)" (6.x), "lodash@4.17.21" (9.x).
 */
export function parsePnpmKey(key: string): { name: string; version: string } | null {
  const value = key.replace(/^\//, '').replace(/\(.*$/, '')
  // 5.x: "name/1.2.3" or "@scope/name/1.2.3_peer@1", peers after "_" (and their "@").
  const legacy = /^((?:@[^/@]+\/)?[^/@]+)\/(\d[^/_]*)(?:_.*)?$/.exec(value)
  if (legacy?.[1] && legacy[2]) {
    const version = exactVersion(legacy[2])
    return version ? { name: legacy[1], version } : null
  }
  const at = value.lastIndexOf('@')
  if (at <= 0) return null
  const version = exactVersion(value.slice(at + 1))
  return version ? { name: value.slice(0, at), version } : null
}

export function parsePnpmLock(doc: unknown): LockedPackage[] {
  if (!isRecord(doc) || !isRecord(doc.packages)) return []
  const out: LockedPackage[] = []
  for (const key of Object.keys(doc.packages)) {
    const parsed = parsePnpmKey(key)
    if (parsed) out.push({ ecosystem: 'npm', ...parsed })
  }
  return out
}

/** Package name of a yarn.lock descriptor: "lodash@^4", "@s/a@npm:^1", "\"x@1\"". */
function yarnName(descriptor: string): string | null {
  const value = descriptor.trim().replace(/^"|"$/g, '')
  const at = value.indexOf('@', 1)
  return at > 0 ? value.slice(0, at) : null
}

/** yarn.lock, classic (v1) and Berry (YAML) formats. Workspace and local packages are skipped. */
export function parseYarnLock(text: string): LockedPackage[] {
  const out: LockedPackage[] = []
  let names: string[] = []
  for (const line of text.split(/\r?\n/)) {
    if (line === '' || line.startsWith('#')) continue
    if (!/^\s/.test(line)) {
      names = []
      if (!line.endsWith(':') || line.startsWith('__metadata')) continue
      const descriptors = line.slice(0, -1).split(',')
      // Workspaces, links and local folders are not registry packages.
      if (descriptors.some((d) => /@(?:workspace|link|portal|file):/.test(d))) continue
      names = [...new Set(descriptors.map(yarnName).filter((name): name is string => name !== null))]
      continue
    }
    const match = /^\s+version:?\s+"?([^"\s]+)"?\s*$/.exec(line)
    if (!match || names.length === 0) continue
    const version = exactVersion(match[1])
    if (version) for (const name of names) out.push({ ecosystem: 'npm', name, version })
    names = []
  }
  return out
}

/** Remove trailing commas before "}" or "]", outside strings (bun.lock allows them). */
function stripTrailingCommas(text: string): string {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string
    if (inString) {
      out += ch
      if (ch === '\\') {
        out += text[i + 1] ?? ''
        i++
      } else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    if (ch === ',') {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j] as string)) j++
      if (text[j] === '}' || text[j] === ']') continue
    }
    out += ch
  }
  return out
}

/** bun.lock (text format): `packages` entries are `[ "name@version", … ]`. */
export function parseBunLock(text: string): LockedPackage[] {
  const doc = parseJsonc(stripTrailingCommas(text))
  if (!isRecord(doc) || !isRecord(doc.packages)) return []
  const out: LockedPackage[] = []
  for (const entry of Object.values(doc.packages)) {
    const spec = Array.isArray(entry) ? entry[0] : undefined
    if (typeof spec !== 'string') continue
    const at = spec.lastIndexOf('@')
    const version = at > 0 ? exactVersion(spec.slice(at + 1)) : null
    if (version) out.push({ ecosystem: 'npm', name: spec.slice(0, at), version })
  }
  return out
}

/** composer.lock: `packages` and `packages-dev`. Branch versions ("dev-main") are skipped. */
export function parseComposerLock(doc: unknown): LockedPackage[] {
  if (!isRecord(doc)) return []
  const out: LockedPackage[] = []
  for (const list of [doc.packages, doc['packages-dev']]) {
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      if (!isRecord(entry) || typeof entry.name !== 'string') continue
      const version = exactVersion(entry.version)
      if (version) out.push({ ecosystem: 'Packagist', name: entry.name, version })
    }
  }
  return out
}

const LOCKFILE_PARSERS: Readonly<Record<string, (text: string) => LockedPackage[]>> = {
  'package-lock.json': (text) => parsePackageLock(parseJson(text)),
  'npm-shrinkwrap.json': (text) => parsePackageLock(parseJson(text)),
  'pnpm-lock.yaml': (text) => parsePnpmLock(parseYaml(text)),
  'yarn.lock': parseYarnLock,
  'bun.lock': parseBunLock,
  'composer.lock': (text) => parseComposerLock(parseJson(text)),
}

/** The project's lockfiles (root and up to two directories deep), sorted. */
export function findLockfiles(files: readonly string[]): string[] {
  return files
    .filter((file) => Object.hasOwn(LOCKFILE_PARSERS, baseName(file)) && depthOf(file) <= MAX_LOCKFILE_DEPTH)
    .filter((file) => !isUnder(file, NON_PROJECT_ROLES))
    .sort(compareText)
}

async function readLockfile(ctx: ProjectContext, file: string): Promise<LockedPackage[]> {
  const text = await ctx.readText(file, { maxBytes: MAX_LOCKFILE_BYTES, cache: false })
  if (text === null) return []
  const parse = LOCKFILE_PARSERS[baseName(file)]
  try {
    return parse ? parse(text) : []
  } catch (error) {
    ctx.debug(`lockfiles: could not parse ${file} (${(error as Error).message})`)
    return []
  }
}

export const lockedPackages: Analyzer<LockedPackages> = {
  id: 'locked-packages',
  async run(ctx) {
    const byKey = new Map<string, LockedPackage & { lockfiles: string[] }>()
    const add = (found: LockedPackage, lockfile: string) => {
      const key = `${found.ecosystem}\0${found.name}\0${found.version}`
      const entry = byKey.get(key)
      if (!entry) byKey.set(key, { ...found, lockfiles: [lockfile] })
      else if (!entry.lockfiles.includes(lockfile)) entry.lockfiles.push(lockfile)
    }
    const files = findLockfiles(ctx.files.files)
    for (const file of files) for (const found of await readLockfile(ctx, file)) add(found, file)
    // go.mod lists every module the build uses (Go 1.17 and later).
    const project = await ctx.use(manifests)
    const lockfiles = [...files]
    for (const mod of project.goModules) {
      let used = false
      for (const required of mod.requires) {
        const version = exactVersion(required.version)
        if (!version) continue
        add({ ecosystem: 'Go', name: required.path, version }, mod.file)
        used = true
      }
      if (used) lockfiles.push(mod.file)
    }
    const packages = [...byKey.values()]
      .map((entry) => ({ ...entry, lockfiles: entry.lockfiles.sort(compareText) }))
      .sort(
        (a, b) =>
          compareText(a.ecosystem, b.ecosystem) || compareText(a.name, b.name) || compareText(a.version, b.version),
      )
    return { packages, lockfiles: lockfiles.sort(compareText) }
  },
}
