/**
 * The project's Docker Compose files, found and parsed once for every
 * consumer: the services and environment sections and the Docker doctor
 * checks. Discovery reads the file index directly, so the doctor checks keep
 * working when the services detector failed.
 */
import { getString, isRecord } from '../core/parse.ts'
import type { Analyzer } from '../types.ts'
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
 * env_file entries of every service, resolved relative to the Compose file.
 * Entries with interpolation, absolute paths or paths outside the project are
 * skipped: where they point can't be known statically.
 */
export function envFileReferences(composeFile: string, doc: unknown): EnvFileReference[] {
  if (!isRecord(doc) || !isRecord(doc.services)) return []
  const baseDir = dirOf(composeFile)
  const out: EnvFileReference[] = []
  for (const [service, definition] of Object.entries(doc.services)) {
    if (!isRecord(definition)) continue
    const raw = definition.env_file
    const entries: unknown[] = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw]
    for (const entry of entries) {
      let path: string | undefined
      let required = true
      if (typeof entry === 'string') {
        path = entry
      } else if (isRecord(entry)) {
        required = !(entry.required === false || entry.required === 'false')
        path = getString(entry, 'path')
      }
      if (!path || /[$~]/.test(path) || path.includes('://')) continue
      const relative = toPosix(path.trim())
      // Absolute paths point outside the project; joinPath would silently make them relative.
      if (relative.startsWith('/') || /^[a-zA-Z]:/.test(relative)) continue
      const resolved = normalizeRelative(joinPath(baseDir, relative))
      if (!resolved || resolved === '.') continue
      out.push({ composeFile, service, path: resolved, required })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Fact
// ---------------------------------------------------------------------------

export interface ComposeFile {
  path: string
  role: ComposeRole
  /**
   * The parsed document; null when the file is empty, unreadable or not valid
   * YAML (a parse failure is recorded as a scan warning for the file).
   */
  doc: unknown
}

export interface ComposeFiles {
  /** Sorted with `compareComposeFiles`. */
  files: ComposeFile[]
  /** env_file entries of every service in every file, in file order. */
  envFiles: EnvFileReference[]
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
    return { files, envFiles: files.flatMap((file) => envFileReferences(file.path, file.doc)) }
  },
}
