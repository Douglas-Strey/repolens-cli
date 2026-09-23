import type { Analyzer, FileIndex, ProjectContext, ReadOptions, ResolvedScanOptions, ScanWarning } from '../types.ts'
import { createLimiter } from '../utils/limit.ts'
import { normalizeRelative } from '../utils/paths.ts'
import { readTextWithin } from './fs.ts'
import { ParseError, parseJson, parseJsonc, parseYaml } from './parse.ts'

/** Maximum concurrent file reads. Keeps large scans away from EMFILE limits. */
const READ_CONCURRENCY = 48

export class Context implements ProjectContext {
  readonly root: string
  readonly options: ResolvedScanOptions
  readonly files: FileIndex

  readonly #memo = new Map<Analyzer<unknown>, Promise<unknown>>()
  readonly #text = new Map<string, Promise<string | null>>()
  readonly #parsed = new Map<string, Promise<unknown>>()
  readonly #warnings: ScanWarning[] = []
  /** `file` + message of every recorded warning, for O(1) deduplication. */
  readonly #warningKeys = new Set<string>()
  readonly #limit = createLimiter(READ_CONCURRENCY)

  constructor(root: string, options: ResolvedScanOptions, files: FileIndex) {
    this.root = root
    this.options = options
    this.files = files
  }

  get warnings(): readonly ScanWarning[] {
    return this.#warnings
  }

  use<T>(analyzer: Analyzer<T>): Promise<T> {
    let result = this.#memo.get(analyzer as Analyzer<unknown>) as Promise<T> | undefined
    if (!result) {
      result = analyzer.run(this)
      this.#memo.set(analyzer as Analyzer<unknown>, result)
    }
    return result
  }

  readText(file: string, options: ReadOptions = {}): Promise<string | null> {
    // "./a" and "a/" share a cache entry with "a"; invalid paths are passed through to be refused.
    const path = normalizeRelative(file) ?? file
    const maxBytes = options.maxBytes ?? this.options.maxFileSize
    const cacheable = options.cache !== false && options.maxBytes === undefined
    if (cacheable) {
      const cached = this.#text.get(path)
      if (cached) return cached
    }
    const pending = this.#limit(async () => {
      const result = await readTextWithin(this.root, path, maxBytes)
      if (result.ok) return result.text
      if (result.reason !== 'missing') {
        this.debug(`read: skipped ${path} (${result.reason}${result.detail ? `: ${result.detail}` : ''})`)
      }
      if (result.reason === 'too-large') {
        this.warn({ kind: 'size', file: path, message: `Skipped ${path} because it is larger than the read limit` })
      }
      return null
    })
    if (cacheable) this.#text.set(path, pending)
    return pending
  }

  readJson<T = unknown>(path: string): Promise<T | null> {
    return this.#parse(path, 'json', parseJson) as Promise<T | null>
  }

  readJsonc<T = unknown>(path: string): Promise<T | null> {
    return this.#parse(path, 'jsonc', parseJsonc) as Promise<T | null>
  }

  readYaml<T = unknown>(path: string): Promise<T | null> {
    return this.#parse(path, 'yaml', parseYaml) as Promise<T | null>
  }

  #parse(file: string, kind: string, parser: (text: string) => unknown): Promise<unknown> {
    const path = normalizeRelative(file) ?? file
    const key = `${kind}:${path}`
    let pending = this.#parsed.get(key)
    if (!pending) {
      pending = this.readText(path).then((text) => {
        if (text === null) return null
        try {
          return parser(text)
        } catch (error) {
          this.warn({
            kind: 'parse',
            file: path,
            message: `Couldn't parse ${path}`,
            detail: error instanceof ParseError ? error.message : String(error),
          })
          return null
        }
      })
      this.#parsed.set(key, pending)
    }
    return pending
  }

  warn(warning: ScanWarning): void {
    const key = `${warning.file ?? ''}\0${warning.message}`
    if (this.#warningKeys.has(key)) return
    this.#warningKeys.add(key)
    this.#warnings.push(warning)
  }

  debug(message: string): void {
    this.options.debug(message)
  }
}

/**
 * Use another detector (or analyzer) without letting its failure break the
 * caller: on error, log it and return `fallback`. Every detector-to-detector
 * dependency should go through this, so one bug empties one section only.
 */
export async function useOr<T>(ctx: ProjectContext, analyzer: Analyzer<T>, fallback: T): Promise<T> {
  try {
    return await ctx.use(analyzer)
  } catch (error) {
    ctx.debug(`${analyzer.id} unavailable: ${String((error as Error)?.message ?? error)}`)
    return fallback
  }
}
