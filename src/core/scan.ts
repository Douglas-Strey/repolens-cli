import fs from 'node:fs/promises'
import path from 'node:path'
import { loadProjectConfig } from '../config/load.ts'
import { NO_CONFIG, resolveConfig } from '../config/resolve.ts'
import { type DetectorRegistry, detectors } from '../detectors/index.ts'
import { runDoctor } from '../doctor/index.ts'
import { doctorRules } from '../doctor/rules/index.ts'
import type {
  Detector,
  LoadedConfig,
  ProjectContext,
  ResolvedScanOptions,
  ScanOptions,
  ScanResult,
  ScanWarning,
  SectionId,
  Sections,
} from '../types.ts'
import { SCHEMA_VERSION } from '../types.ts'
import { compareText } from '../utils/compare.ts'
import { VERSION } from '../version.ts'
import { Context } from './context.ts'
import { emptySections } from './empty.ts'
import { errorSummary, RepoLensError } from './errors.ts'
import { createFileIndex } from './file-index.ts'
import { walk } from './walker.ts'

export const DEFAULT_MAX_FILES = 100_000
export const DEFAULT_MAX_DEPTH = 20
export const DEFAULT_MAX_FILE_SIZE = 1024 * 1024

function limitOption(name: string, value: number | undefined, fallback: number, min: number): number {
  if (value === undefined) return fallback
  if (value === Number.POSITIVE_INFINITY || (Number.isSafeInteger(value) && value >= min)) return value
  throw new RepoLensError('INVALID_ARGUMENT', `${name} must be an integer >= ${min}`)
}

/** Fill in defaults. Throws RepoLensError INVALID_ARGUMENT for invalid limits (NaN would silently disable them). */
export function resolveOptions(options: ScanOptions = {}): ResolvedScanOptions {
  return {
    cwd: path.resolve(options.cwd ?? process.cwd()),
    maxFiles: limitOption('maxFiles', options.maxFiles, DEFAULT_MAX_FILES, 1),
    maxDepth: limitOption('maxDepth', options.maxDepth, DEFAULT_MAX_DEPTH, 0),
    maxFileSize: limitOption('maxFileSize', options.maxFileSize, DEFAULT_MAX_FILE_SIZE, 0),
    now: options.now ?? new Date(),
    debug: options.debug ?? (() => {}),
    config: NO_CONFIG,
  }
}

async function configLayers(option: ScanOptions['config'], root: string): Promise<readonly LoadedConfig[]> {
  if (option === false) return []
  if (option === undefined || option === 'project') {
    const project = await loadProjectConfig(root)
    return project ? [project] : []
  }
  return option
}

async function resolveRoot(cwd: string): Promise<string> {
  let real: string
  try {
    real = await fs.realpath(cwd)
  } catch {
    throw new RepoLensError('INVALID_ROOT', `Directory not found: ${cwd}`)
  }
  let isDir = false
  try {
    isDir = (await fs.stat(real)).isDirectory()
  } catch (error) {
    throw new RepoLensError('INVALID_ROOT', `Cannot read ${cwd}`, (error as NodeJS.ErrnoException).code)
  }
  if (!isDir) throw new RepoLensError('INVALID_ROOT', `Not a directory: ${cwd}`)
  return real
}

/** Create a project context (file index + caches) without running detectors. Useful for tests and tools. */
export async function createContext(options: ScanOptions = {}): Promise<Context> {
  const resolved = resolveOptions(options)
  const root = await resolveRoot(resolved.cwd)
  const { config, warnings } = resolveConfig(await configLayers(options.config, root), doctorRules)
  resolved.config = config
  // An explicit maxFiles (--max-files) wins over the configuration's.
  if (options.maxFiles === undefined && config.settings.maxFiles !== undefined) {
    resolved.maxFiles = config.settings.maxFiles
  }
  const started = performance.now()
  const walked = await walk(root, {
    maxFiles: resolved.maxFiles,
    maxDepth: resolved.maxDepth,
    ...(config.settings.ignore ? { exclude: config.settings.ignore } : {}),
    debug: resolved.debug,
  })
  resolved.debug(
    `walk: ${walked.files.length} files, ${walked.directories.size} directories in ${Math.round(performance.now() - started)}ms`,
  )
  const ctx = new Context(root, resolved, createFileIndex(walked))
  for (const warning of warnings) ctx.warn(warning)
  for (const warning of walked.warnings ?? []) ctx.warn(warning)
  if (walked.truncated) {
    ctx.warn({ kind: 'limit', message: `Stopped indexing after ${resolved.maxFiles} files; results may be incomplete` })
  }
  return ctx
}

/**
 * Warnings in a stable order: by file (warnings without a file first), then
 * message, then detail. They are recorded in the completion order of
 * concurrent reads, which differs from run to run.
 */
export function sortWarnings(warnings: readonly ScanWarning[]): ScanWarning[] {
  return [...warnings].sort(
    (a, b) =>
      compareText(a.file ?? '', b.file ?? '') ||
      compareText(a.message, b.message) ||
      compareText(a.detail ?? '', b.detail ?? ''),
  )
}

/** Run every detector and return their sections. A failing detector yields an empty section plus a warning. */
export async function detect(ctx: ProjectContext, registry: DetectorRegistry = detectors): Promise<Sections> {
  const fallback = emptySections(path.basename(ctx.root))
  const ids = Object.keys(registry) as SectionId[]
  const entries = await Promise.all(
    ids.map(async (id) => {
      const detector = registry[id] as Detector
      const started = performance.now()
      try {
        const value = await ctx.use(detector)
        ctx.debug(`detector ${id}: ${Math.round(performance.now() - started)}ms`)
        return [id, value] as const
      } catch (error) {
        // JSON output must not carry absolute paths, so the stack goes to debug output only.
        ctx.warn({
          kind: 'error',
          message: `The ${detector.title} detector failed`,
          detail: errorSummary(error, ctx.root),
        })
        ctx.debug(`detector ${id} failed: ${String((error as Error)?.stack ?? error)}`)
        return [id, fallback[id]] as const
      }
    }),
  )
  return Object.fromEntries(entries) as unknown as Sections
}

/** Scan a repository. This is the main programmatic entry point. */
export async function scan(options: ScanOptions = {}): Promise<ScanResult> {
  const started = performance.now()
  const ctx = await createContext(options)
  const sections = await detect(ctx)
  const doctor = await runDoctor(sections, ctx)
  ctx.debug(`scan: ${Math.round(performance.now() - started)}ms total`)
  return {
    schemaVersion: SCHEMA_VERSION,
    tool: { name: 'repolens', version: VERSION },
    ...sections,
    doctor,
    meta: {
      files: ctx.files.files.length,
      truncated: ctx.files.truncated,
      warnings: sortWarnings(ctx.warnings),
      config: ctx.options.config,
    },
  }
}
