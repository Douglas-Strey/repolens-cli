/**
 * The project's Docker Compose files, found and parsed once for every
 * consumer: the services and environment sections and the Docker doctor
 * checks. Discovery reads the file index directly, so the doctor checks keep
 * working when the services detector failed. Local `include` files and
 * service `extends` are followed, the way `docker compose` resolves them.
 */
import path from 'node:path'
import { getString, isRecord } from '../core/parse.ts'
import type { Analyzer, ProjectContext, Service } from '../types.ts'
import { compareText } from '../utils/compare.ts'
import { mapLimit } from '../utils/limit.ts'
import { isUnder, NON_PROJECT_ROLES } from '../utils/path-roles.ts'
import { baseName, depthOf, dirOf, joinPath, normalizeRelative, toPosix } from '../utils/paths.ts'

/** Compose files are looked for at the root and up to two directories deep (docker/, .devcontainer/, deploy/local/). */
export const MAX_COMPOSE_DEPTH = 2
const READ_CONCURRENCY = 8

/**
 * - "base": compose.yaml, docker-compose.yml, … (what `docker compose` loads by default)
 * - "override": compose.override.yaml, docker-compose.override.yml (merged into the base automatically)
 * - "variant": any other compose.<name>.yaml, used on its own with `-f`
 */
export type ComposeRole = 'base' | 'override' | 'variant'

const COMPOSE_NAME = /^(?:docker-)?compose(?:\.([\w.-]+))?\.ya?ml$/
const ROLE_RANK: Record<ComposeRole, number> = { base: 0, override: 1, variant: 2 }

/** "compose.yaml" → base, "docker-compose.override.yml" → override, "compose.prod.yaml" → variant, else null. */
export function composeFileRole(file: string): ComposeRole | null {
  const match = COMPOSE_NAME.exec(baseName(file))
  if (!match) return null
  if (match[1] === undefined) return 'base'
  return match[1] === 'override' ? 'override' : 'variant'
}

/**
 * Files that run together as one Compose project: a directory's base and
 * override files form one project; every variant file is a project of its own.
 */
export function composeProjectOf(file: string): string {
  return composeFileRole(file) === 'variant' ? `${dirOf(file)}\0${baseName(file)}` : dirOf(file)
}

/** The Compose project a service runs in: the one of the file that includes it, if it was included. */
export function serviceProject(service: Pick<Service, 'source' | 'includedFrom'>): string {
  return composeProjectOf(service.includedFrom ?? service.source)
}

/** Root first, then other directories by path. */
export function compareDirectories(a: string, b: string): number {
  if (a === b) return 0
  if (a === '.') return -1
  if (b === '.') return 1
  return compareText(a, b)
}

/** Order: by directory (root first), then base files, overrides, variants, then by name. */
export function compareComposeFiles(a: string, b: string): number {
  return (
    compareDirectories(dirOf(a), dirOf(b)) ||
    ROLE_RANK[composeFileRole(a) ?? 'variant'] - ROLE_RANK[composeFileRole(b) ?? 'variant'] ||
    compareText(baseName(a), baseName(b))
  )
}

/** A Compose file of the project itself: shallow enough, and not a test fixture, example or template. */
export function isProjectComposeFile(file: string): boolean {
  return depthOf(file) <= MAX_COMPOSE_DEPTH && composeFileRole(file) !== null && !isUnder(file, NON_PROJECT_ROLES)
}

/** Project Compose files among indexed paths, sorted with `compareComposeFiles`. */
export function findComposeFiles(files: readonly string[]): string[] {
  return files.filter(isProjectComposeFile).sort(compareComposeFiles)
}

// ---------------------------------------------------------------------------
// References to other files
// ---------------------------------------------------------------------------

/**
 * A path written in a Compose file (include, extends.file, env_file),
 * resolved against the file's directory. Null when it can't be known
 * statically (interpolation, `~`, a URL) or points outside the project
 * (absolute, or above the root).
 */
export function composeReference(from: string, raw: string): string | null {
  if (/[$~]/.test(raw) || raw.includes('://')) return null
  const relative = toPosix(raw.trim())
  // Absolute paths point outside the project; joinPath would silently make them relative.
  if (relative === '' || relative.startsWith('/') || /^[a-zA-Z]:/.test(relative)) return null
  const resolved = normalizeRelative(joinPath(dirOf(from), relative))
  return resolved && resolved !== '.' ? resolved : null
}

/** Files a top-level `include` names, in order: short entries and the long form's `path` (a string or a list). */
export function includedPaths(file: string, doc: unknown): string[] {
  if (!isRecord(doc) || !Array.isArray(doc.include)) return []
  const out: string[] = []
  for (const entry of doc.include) {
    const raw = typeof entry === 'string' ? [entry] : isRecord(entry) ? toStrings(entry.path) : []
    for (const item of raw) {
      const resolved = composeReference(file, item)
      if (resolved && !out.includes(resolved)) out.push(resolved)
    }
  }
  return out
}

function toStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

// ---------------------------------------------------------------------------
// extends
// ---------------------------------------------------------------------------

/** Not inherited through `extends`: they name other services or volumes the extending file must declare itself. */
const NOT_INHERITED = new Set(['extends', 'depends_on', 'links', 'volumes_from'])
/** Merged key by key, the extending service winning. `environment` and `labels` may also be written as lists. */
const MAPPINGS = new Set(['environment', 'labels', 'annotations', 'healthcheck', 'sysctls', 'ulimits', 'storage_opt'])
/**
 * Combined, the extended service's items first. The specification merges
 * `volumes` and `devices` by target path; a combined list is close enough for
 * what RepoLens reports.
 */
const SEQUENCES = new Set([
  'ports',
  'expose',
  'env_file',
  'volumes',
  'devices',
  'cap_add',
  'cap_drop',
  'configs',
  'secrets',
  'security_opt',
  'dns',
  'dns_search',
  'tmpfs',
  'external_links',
  'extra_hosts',
  'device_cgroup_rules',
])

/** A mapping or a list of "KEY=value" / "KEY" entries as one mapping. */
function asMapping(value: unknown): Map<string, unknown> {
  const out = new Map<string, unknown>()
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) out.set(key, item)
  } else if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== 'string') continue
      const eq = item.indexOf('=')
      out.set(eq === -1 ? item : item.slice(0, eq), eq === -1 ? null : item.slice(eq + 1))
    }
  }
  return out
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]
}

/**
 * The definition a service gets from `extends`: `base` (the extended
 * service, already resolved) merged with `own`, following the Compose
 * specification's merge rules. Built with Object.fromEntries, so keys such as
 * "__proto__" in a hostile file stay plain keys.
 */
export function mergeServiceDefinitions(
  base: Record<string, unknown>,
  own: Record<string, unknown>,
): Record<string, unknown> {
  const merged = new Map<string, unknown>()
  for (const [key, value] of Object.entries(base)) if (!NOT_INHERITED.has(key)) merged.set(key, value)
  for (const [key, value] of Object.entries(own)) {
    if (key === 'extends') continue
    const inherited = merged.get(key)
    if (inherited === undefined) {
      merged.set(key, value)
    } else if (MAPPINGS.has(key)) {
      merged.set(key, Object.fromEntries([...asMapping(inherited), ...asMapping(value)]))
    } else if (SEQUENCES.has(key)) {
      const seen = new Set<string>()
      merged.set(
        key,
        [...asList(inherited), ...asList(value)].filter((item) => {
          const id = JSON.stringify(item)
          if (seen.has(id)) return false
          seen.add(id)
          return true
        }),
      )
    } else if (key === 'build' && isRecord(inherited) && isRecord(value)) {
      merged.set(key, Object.fromEntries([...Object.entries(inherited), ...Object.entries(value)]))
    } else {
      merged.set(key, value)
    }
  }
  return Object.fromEntries(merged)
}

/** `relative`, written in a file of directory `from`, as seen from directory `to`. Unresolvable values stay as written. */
function rebase(relative: string, from: string, to: string): string {
  if (/[$~]/.test(relative) || relative.includes('://') || /^(?:\/|[a-zA-Z]:)/.test(toPosix(relative.trim()))) {
    return relative
  }
  return path.posix.relative(to === '.' ? '' : to, joinPath(from, toPosix(relative.trim()))) || '.'
}

/**
 * Relative `build` and `env_file` paths of a service defined in another
 * file, rewritten for the extending file's directory: Compose resolves them
 * against the file that wrote them.
 */
export function rebaseServicePaths(
  definition: Record<string, unknown>,
  from: string,
  to: string,
): Record<string, unknown> {
  if (from === to) return definition
  const entries = Object.entries(definition).map(([key, value]): [string, unknown] => {
    if (key === 'build') {
      if (typeof value === 'string') return [key, rebase(value, from, to)]
      if (isRecord(value)) {
        const context = typeof value.context === 'string' ? value.context : '.'
        return [key, Object.fromEntries([...Object.entries(value), ['context', rebase(context, from, to)]])]
      }
    }
    if (key === 'env_file') {
      return [
        key,
        asList(value).map((item) => {
          if (typeof item === 'string') return rebase(item, from, to)
          if (isRecord(item) && typeof item.path === 'string') {
            return Object.fromEntries([...Object.entries(item), ['path', rebase(item.path, from, to)]])
          }
          return item
        }),
      ]
    }
    return [key, value]
  })
  return Object.fromEntries(entries)
}

function serviceDefinition(doc: unknown, name: string): Record<string, unknown> | null {
  if (!isRecord(doc) || !isRecord(doc.services) || !Object.hasOwn(doc.services, name)) return null
  const definition = doc.services[name]
  return isRecord(definition) ? definition : null
}

// ---------------------------------------------------------------------------
// env_file references
// ---------------------------------------------------------------------------

export interface EnvFileReference {
  composeFile: string
  service: string
  /** Path relative to the project root. */
  path: string
  /** False for entries marked `required: false`, which Compose skips when the file is missing. */
  required?: boolean
}

/**
 * env_file entries of one service, resolved relative to the Compose file.
 * Entries with interpolation, absolute paths or paths outside the project are
 * skipped: where they point can't be known statically.
 */
export function serviceEnvFiles(
  composeFile: string,
  service: string,
  definition: Record<string, unknown>,
): EnvFileReference[] {
  const out: EnvFileReference[] = []
  for (const entry of asList(definition.env_file)) {
    let raw: string | undefined
    let required = true
    if (typeof entry === 'string') {
      raw = entry
    } else if (isRecord(entry)) {
      required = !(entry.required === false || entry.required === 'false')
      raw = getString(entry, 'path')
    }
    const resolved = raw === undefined ? null : composeReference(composeFile, raw)
    if (resolved) out.push({ composeFile, service, path: resolved, required })
  }
  return out
}

/** env_file entries of every service of a Compose document (see serviceEnvFiles). */
export function envFileReferences(composeFile: string, doc: unknown): EnvFileReference[] {
  if (!isRecord(doc) || !isRecord(doc.services)) return []
  return Object.entries(doc.services).flatMap(([service, definition]) =>
    isRecord(definition) ? serviceEnvFiles(composeFile, service, definition) : [],
  )
}

// ---------------------------------------------------------------------------
// Fact
// ---------------------------------------------------------------------------

export interface ComposeDocument {
  path: string
  /**
   * The parsed document; null when the file is empty, unreadable or not valid
   * YAML (a parse failure is recorded as a scan warning for the file).
   */
  doc: unknown
}

export interface ComposeFile extends ComposeDocument {
  role: ComposeRole
}

export interface ComposeService {
  name: string
  /** Compose file that declares the service. */
  file: string
  /** Top-level Compose file whose `include` brought it in; absent when it declares the service itself. */
  includedFrom?: string
  /**
   * The definition with `extends` applied. Relative `build` and `env_file`
   * paths are relative to `file`'s directory, as in the file itself.
   */
  definition: Record<string, unknown>
}

export interface ComposeFiles {
  /** The project's own Compose files, sorted with `compareComposeFiles`. */
  files: ComposeFile[]
  /** Files loaded through `include`, in the order they were first included. */
  included: ComposeDocument[]
  /**
   * Services of every file, in file order: each file's own services, then
   * those of the files it includes. A service included under a name the
   * project already declares is listed too; `docker compose` refuses it.
   */
  services: ComposeService[]
  /** env_file entries of every service, in service order. */
  envFiles: EnvFileReference[]
}

/** Most files read through `include` and `extends.file` in one scan. Real projects use a handful. */
export const MAX_REFERENCED_COMPOSE_FILES = 64
/** Longest `extends` chain followed; Compose itself only stops at a cycle. */
export const MAX_EXTENDS_DEPTH = 16

/**
 * Follows `include` and `extends` from the project's Compose files. Files
 * are read one at a time, in file order, so the MAX_REFERENCED_COMPOSE_FILES
 * budget is spent deterministically.
 */
async function resolveCompose(
  ctx: ProjectContext,
  files: readonly ComposeFile[],
): Promise<Omit<ComposeFiles, 'files'>> {
  const docs = new Map<string, unknown>(files.map((file) => [file.path, file.doc]))
  const included: ComposeDocument[] = []
  const services: ComposeService[] = []
  let budget = MAX_REFERENCED_COMPOSE_FILES

  const load = async (file: string): Promise<unknown> => {
    if (docs.has(file)) return docs.get(file)
    if (budget <= 0) {
      ctx.debug(`compose: not reading ${file}, more than ${MAX_REFERENCED_COMPOSE_FILES} files referenced`)
      return null
    }
    budget--
    const doc = await ctx.readYaml(file)
    docs.set(file, doc)
    return doc
  }

  const extend = async (
    file: string,
    doc: unknown,
    definition: Record<string, unknown>,
    seen: readonly string[],
  ): Promise<Record<string, unknown>> => {
    const reference = definition.extends
    if (reference === undefined) return definition
    const own = mergeServiceDefinitions({}, definition)
    const name = typeof reference === 'string' ? reference : getString(reference, 'service')
    const other = isRecord(reference) ? getString(reference, 'file') : undefined
    const baseFile = other === undefined ? file : composeReference(file, other)
    if (!name || !baseFile || seen.length > MAX_EXTENDS_DEPTH) return own
    const key = `${baseFile}\0${name}`
    if (seen.includes(key)) {
      ctx.debug(`compose: extends cycle at service ${name} of ${baseFile}`)
      return own
    }
    const baseDoc = baseFile === file ? doc : await load(baseFile)
    const base = serviceDefinition(baseDoc, name)
    if (!base) return own
    const resolved = await extend(baseFile, baseDoc, base, [...seen, key])
    return mergeServiceDefinitions(rebaseServicePaths(resolved, dirOf(baseFile), dirOf(file)), definition)
  }

  const collect = async (file: string, doc: unknown, includedFrom: string | undefined, chain: readonly string[]) => {
    if (isRecord(doc) && isRecord(doc.services)) {
      for (const [name, definition] of Object.entries(doc.services)) {
        if (!isRecord(definition)) continue
        services.push({
          name,
          file,
          ...(includedFrom !== undefined ? { includedFrom } : {}),
          definition: await extend(file, doc, definition, [`${file}\0${name}`]),
        })
      }
    }
    for (const target of includedPaths(file, doc)) {
      if (chain.includes(target)) {
        ctx.debug(`compose: include cycle at ${target}`)
        continue
      }
      const targetDoc = await load(target)
      if (targetDoc === null) continue
      if (!included.some((entry) => entry.path === target)) included.push({ path: target, doc: targetDoc })
      await collect(target, targetDoc, includedFrom ?? file, [...chain, target])
    }
  }

  for (const file of files) await collect(file.path, file.doc, undefined, [file.path])
  return {
    included,
    services,
    envFiles: services.flatMap((service) => serviceEnvFiles(service.file, service.name, service.definition)),
  }
}

export const composeFiles: Analyzer<ComposeFiles> = {
  id: 'compose-files',
  async run(ctx) {
    const paths = findComposeFiles(ctx.files.files)
    const files = await mapLimit(
      paths,
      READ_CONCURRENCY,
      // Parse errors are recorded as scan warnings by readYaml.
      async (path): Promise<ComposeFile> => ({
        path,
        role: composeFileRole(path) as ComposeRole,
        doc: await ctx.readYaml(path),
      }),
    )
    return { files, ...(await resolveCompose(ctx, files)) }
  },
}
