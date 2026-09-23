import type { Dirent } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import ignore, { type Ignore } from 'ignore'
import { createLimiter } from '../utils/limit.ts'
import { isWithin, normalizeRelative } from '../utils/paths.ts'
import { readRegularFile, readTextWithin } from './fs.ts'

/**
 * Directories that are never traversed, whether or not .gitignore mentions
 * them: VCS internals, installed dependencies, and framework/tool caches.
 */
export const ALWAYS_IGNORED_DIRS: ReadonlySet<string> = new Set([
  '.git',
  '.hg',
  '.svn',
  '.jj',
  'node_modules',
  'bower_components',
  'jspm_packages',
  'vendor',
  '.pnpm-store',
  // RepoLens's own `agent init` output describes the repository; it is not part of it.
  '.repolens',
  '.yarn',
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  '.astro',
  '.angular',
  '.turbo',
  '.nx',
  '.cache',
  '.parcel-cache',
  '.vercel',
  '.netlify',
  '.wrangler',
  '.expo',
  '.docusaurus',
  '.terraform',
  '.venv',
  'venv',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.tox',
  '.gradle',
  '.idea',
  'coverage',
  '.nyc_output',
  '.direnv',
  '.devenv',
])

const GITIGNORE_MAX_BYTES = 512 * 1024
const DIRECTORY_CONCURRENCY = 32

/**
 * Most ignore rules that apply to any one path (all .gitignore files on the
 * way down, plus .git/info/exclude), counted by cost (see ignoreRuleCost).
 * Matching costs one regex test per rule per file, so an unbounded count
 * would let a hostile repository stall the walk. Real repositories stay far
 * below this.
 */
export const MAX_IGNORE_RULES_PER_PATH = 2000

/**
 * Most ignore rules compiled in one walk, across every .gitignore file. Each
 * distinct rule costs ~30 µs to compile, and a repository can hold thousands
 * of .gitignore files (1,000 files of 2,000 distinct rules took a minute).
 * Budget decisions are taken in walk order, so the result is deterministic.
 */
export const MAX_IGNORE_RULES_TOTAL = 50_000

export interface WalkOptions {
  maxFiles: number
  maxDepth: number
  /**
   * Extra patterns in .gitignore syntax (the `ignore` setting), relative to
   * the root. Matching directories are not entered and matching files are
   * listed with the ignored ones, but `isIgnored` keeps answering for Git
   * alone: "is .env ignored?" must not depend on RepoLens's configuration.
   */
  exclude?: readonly string[]
  debug?: (message: string) => void
}

export interface WalkWarning {
  kind: 'limit'
  /** File that caused the warning, relative to the root. */
  file: string
  message: string
}

export interface WalkResult {
  files: string[]
  ignoredFiles: string[]
  directories: Set<string>
  truncated: boolean
  /** Is a path (file or directory, existing or not) ignored by the loaded .gitignore rules? */
  isIgnored: (relative: string, isDirectory?: boolean) => boolean
  /** Problems worth surfacing as scan warnings (sorted by file). */
  warnings?: WalkWarning[]
}

interface IgnoreLayer {
  /** Directory of the .gitignore, relative to root ("" for the root). */
  base: string
  matcher: Ignore
  /** Rule cost (see ignoreRuleCost) of this layer plus all layers above it. */
  total: number
}

function testLayers(layers: readonly IgnoreLayer[], relative: string, isDirectory: boolean): boolean {
  // Deeper .gitignore files take precedence; within a file the last match wins (handled by `ignore`).
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i] as IgnoreLayer
    const local = layer.base === '' ? relative : relative.slice(layer.base.length + 1)
    if (local === '') continue
    const result = layer.matcher.test(isDirectory ? `${local}/` : local)
    if (result.ignored) return true
    if (result.unignored) return false
  }
  return false
}

/**
 * Budget cost of a rule by its number of `**` segments, not counting a
 * trailing one. `ignore` compiles each of those to a backtracking group, so a
 * path that doesn't match costs about depth^n: measured against 20-level
 * paths, one costs ~3 plain rules, two ~20, three ~120. A rule with 12
 * consecutive `**` took 4 s per path.
 */
const GLOBSTAR_RULE_COST = [1, 3, 20, 120]

/** Cost of one ignore rule in the per-path budget; Infinity when it has too many `**` segments to use. */
export function ignoreRuleCost(rule: string): number {
  const segments = rule.trim().replace(/^!/, '').split('/')
  let globstars = segments.filter((segment) => segment === '**').length
  if (segments[segments.length - 1] === '**') globstars-- // a trailing "/**" compiles to a plain ".+"
  return GLOBSTAR_RULE_COST[globstars] ?? Number.POSITIVE_INFINITY
}

export interface LimitedIgnoreRules {
  /** The kept rules, with comments and blank lines. */
  text: string
  /** Number of kept rules. */
  kept: number
  /** Their total cost (see ignoreRuleCost). */
  cost: number
  /** Dropped rules with too many `**` segments to use at all. */
  complex: number
  /** Dropped rules that did not fit the per-path cost budget. */
  overBudget: number
  /** Dropped rules past the `maxRules` count. */
  overTotal: number
}

/**
 * Keep rules while their total cost fits in `budget` and their number in
 * `maxRules`. Blank lines and comments are not rules and are always kept.
 */
export function limitIgnoreRules(
  text: string,
  budget: number,
  maxRules = Number.POSITIVE_INFINITY,
): LimitedIgnoreRules {
  const out: LimitedIgnoreRules = { text, kept: 0, cost: 0, complex: 0, overBudget: 0, overTotal: 0 }
  const lines: string[] = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() !== '' && !line.startsWith('#')) {
      const cost = ignoreRuleCost(line)
      if (cost === Number.POSITIVE_INFINITY) out.complex++
      else if (out.kept >= maxRules) out.overTotal++
      else if (out.cost + cost > budget) out.overBudget++
      else {
        out.kept++
        out.cost += cost
        lines.push(line)
      }
      continue
    }
    lines.push(line)
  }
  if (out.complex + out.overBudget + out.overTotal > 0) out.text = lines.join('\n')
  return out
}

function rulesText(count: number): string {
  return count === 1 ? '1 rule' : `${count} rules`
}

function createLayer(
  base: string,
  text: string,
  parentTotal: number,
  maxRules: number,
  file: string,
  warnings: WalkWarning[],
): { layer: IgnoreLayer | null; kept: number } {
  const limited = limitIgnoreRules(text, Math.max(0, MAX_IGNORE_RULES_PER_PATH - parentTotal), Math.max(0, maxRules))
  const drop = (count: number, reason: string) => {
    if (count > 0) warnings.push({ kind: 'limit', file, message: `Ignored ${rulesText(count)} in ${file}${reason}` })
  }
  drop(
    limited.complex,
    ` that use${limited.complex === 1 ? 's' : ''} more than ${GLOBSTAR_RULE_COST.length - 1} "**" segments`,
  )
  drop(
    limited.overBudget,
    `: the ignore rules for one directory exceed the limit of ${MAX_IGNORE_RULES_PER_PATH} (a rule with several "**" counts as more than one)`,
  )
  drop(limited.overTotal, `: the repository's ignore files have more than ${MAX_IGNORE_RULES_TOTAL} rules in total`)
  try {
    // Case-sensitive like Git's default (core.ignoreCase=false), so results don't depend on the platform.
    const matcher = ignore({ allowRelativePaths: true, ignorecase: false }).add(limited.text)
    return { layer: { base, matcher, total: parentTotal + limited.cost }, kept: limited.kept }
  } catch {
    return { layer: null, kept: limited.kept }
  }
}

/**
 * Walk the repository and build the file list.
 *
 * - Respects .gitignore files (root and nested) and .git/info/exclude,
 *   case-sensitively, within a budget of MAX_IGNORE_RULES_PER_PATH per path
 *   and MAX_IGNORE_RULES_TOTAL rules in all, plus the configured `exclude`
 *   patterns, which no .gitignore negation can bring back.
 * - Never enters ALWAYS_IGNORED_DIRS and never lists `.git` entries.
 * - Never follows directory symlinks; file symlinks are kept only when their
 *   target resolves inside the root.
 * - Stops after `maxFiles` files or `maxDepth` levels. Traversal is breadth
 *   first in sorted order, so truncation is deterministic.
 */
export async function walk(root: string, options: WalkOptions): Promise<WalkResult> {
  const files: string[] = []
  const ignoredFiles: string[] = []
  const directories = new Set<string>()
  const layersByDir = new Map<string, IgnoreLayer>()
  const warnings: WalkWarning[] = []
  let truncated = false

  let compiledRules = 0

  let excluder: Ignore | null = null
  if (options.exclude && options.exclude.length > 0) {
    try {
      excluder = ignore({ allowRelativePaths: true, ignorecase: false }).add([...options.exclude])
    } catch (error) {
      options.debug?.(`walk: ignore patterns from the configuration were not usable (${String(error)})`)
    }
  }
  const excluded = (relative: string, isDirectory: boolean): boolean =>
    excluder?.ignores(isDirectory ? `${relative}/` : relative) === true

  const rootLayers: IgnoreLayer[] = []
  // Read through the root-contained reader: a planted .git (or info/exclude) symlink must not be followed out.
  const exclude = await readTextWithin(root, '.git/info/exclude', GITIGNORE_MAX_BYTES)
  if (exclude.ok) {
    const { layer, kept } = createLayer('', exclude.text, 0, MAX_IGNORE_RULES_TOTAL, '.git/info/exclude', warnings)
    compiledRules += kept
    if (layer) rootLayers.push(layer)
  }

  type Pending = { dir: string; layers: IgnoreLayer[] }
  type Listing = { files: string[]; ignoredFiles: string[]; subdirs: Pending[]; overflow: boolean }
  const emptyListing = (): Listing => ({ files: [], ignoredFiles: [], subdirs: [], overflow: false })

  /**
   * `turn` resolves once every earlier directory of this level has taken its
   * share of MAX_IGNORE_RULES_TOTAL; call `done` once this one has. Reads stay
   * concurrent, only the (CPU-bound) layer creation runs in walk order.
   */
  const listDirectory = async (
    { dir, layers }: Pending,
    depth: number,
    turn: Promise<void>,
    done: () => void,
  ): Promise<Listing> => {
    const listing = emptyListing()
    const absoluteDir = dir === '' ? root : path.join(root, dir)
    let entries: Dirent[]
    try {
      entries = await fs.readdir(absoluteDir, { withFileTypes: true })
    } catch (error) {
      options.debug?.(`walk: cannot read ${dir || '.'} (${(error as NodeJS.ErrnoException).code})`)
      return listing
    }

    let activeLayers = layers
    if (entries.some((entry) => entry.name === '.gitignore' && entry.isFile())) {
      const file = dir === '' ? '.gitignore' : `${dir}/.gitignore`
      const result = await readRegularFile(path.join(absoluteDir, '.gitignore'), GITIGNORE_MAX_BYTES)
      await turn
      if (result.ok) {
        const parentTotal = layers[layers.length - 1]?.total ?? 0
        const maxRules = MAX_IGNORE_RULES_TOTAL - compiledRules
        const { layer, kept } = createLayer(dir, result.text, parentTotal, maxRules, file, warnings)
        compiledRules += kept
        if (layer) {
          layersByDir.set(dir, layer)
          activeLayers = [...layers, layer]
        }
      }
    }
    done()

    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (entry.name === '.git') continue
      const relative = dir === '' ? entry.name : `${dir}/${entry.name}`

      let isDirectory = entry.isDirectory()
      let isSymlink = entry.isSymbolicLink()
      if (isSymlink && process.platform === 'win32') {
        // libuv reports every Windows reparse point as a link (e.g. OneDrive placeholders);
        // lstat only reports real symlinks and junctions as links.
        const stat = await fs.lstat(path.join(absoluteDir, entry.name)).catch(() => null)
        if (stat && !stat.isSymbolicLink()) {
          isSymlink = false
          isDirectory = stat.isDirectory()
        }
      }

      if (isDirectory) {
        if (ALWAYS_IGNORED_DIRS.has(entry.name)) continue
        if (testLayers(activeLayers, relative, true) || excluded(relative, true)) continue
        if (depth + 1 > options.maxDepth) {
          options.debug?.(`walk: depth limit reached at ${relative}`)
          continue
        }
        listing.subdirs.push({ dir: relative, layers: activeLayers })
        continue
      }
      if (!isSymlink && !entry.isFile() && !(process.platform === 'win32' && !isDirectory)) continue // sockets, FIFOs, devices

      // Files past the limit are dropped at merge time anyway; don't pay for classifying them.
      if (listing.files.length >= options.maxFiles) {
        listing.overflow = true
        continue
      }
      if (isSymlink) {
        // Directory symlinks are never followed (prevents loops and escapes).
        // File symlinks are kept only if they resolve to a regular file inside the root.
        try {
          const real = await fs.realpath(path.join(absoluteDir, entry.name))
          if (!isWithin(root, real) || !(await fs.stat(real)).isFile()) continue
        } catch {
          continue
        }
      }
      if (testLayers(activeLayers, relative, false) || excluded(relative, false)) {
        if (listing.ignoredFiles.length < options.maxFiles) listing.ignoredFiles.push(relative)
      } else {
        listing.files.push(relative)
      }
    }
    return listing
  }

  // Breadth-first, one level at a time. Directories within a level are read
  // concurrently, but results are merged in sorted order so that truncation
  // (when maxFiles is hit) is deterministic.
  let level: Pending[] = [{ dir: '', layers: rootLayers }]
  for (let depth = 0; level.length > 0 && !truncated; depth++) {
    const limit = createLimiter(DIRECTORY_CONCURRENCY)
    let stop = false
    // The limiter starts directories in order, so every `turn` a directory waits for is already running.
    let turn: Promise<void> = Promise.resolve()
    const listings = level.map((pending) => {
      const previous = turn
      let done = () => {}
      const own = new Promise<void>((resolve) => {
        done = resolve
      })
      turn = previous.then(() => own)
      return limit(async () => {
        try {
          return stop ? emptyListing() : await listDirectory(pending, depth, previous, done)
        } finally {
          done()
        }
      }).catch((error: unknown) => {
        options.debug?.(`walk: skipped ${pending.dir || '.'} (${String(error)})`)
        return emptyListing()
      })
    })
    const nextLevel: Pending[] = []
    for (const next of listings) {
      const listing = await next
      for (const file of listing.ignoredFiles) {
        if (ignoredFiles.length >= options.maxFiles) {
          // Ignored files cost work too; past the limit the index is incomplete.
          truncated = true
          break
        }
        ignoredFiles.push(file)
      }
      for (const file of listing.files) {
        if (files.length >= options.maxFiles) {
          truncated = true
          break
        }
        files.push(file)
      }
      if (listing.overflow) truncated = true
      if (truncated) {
        options.debug?.(`walk: file limit (${options.maxFiles}) reached`)
        break
      }
      for (const sub of listing.subdirs) {
        // Directories are capped like files, so trees of mostly ignored or empty
        // directories can't make the walk unbounded.
        if (directories.size >= options.maxFiles) {
          truncated = true
          break
        }
        directories.add(sub.dir)
        nextLevel.push(sub)
      }
      if (truncated) {
        options.debug?.(`walk: directory limit (${options.maxFiles}) reached`)
        break
      }
    }
    if (truncated) {
      // Let directories that are already being read finish before returning.
      stop = true
      await Promise.all(listings)
    }
    level = nextLevel
  }

  files.sort()
  ignoredFiles.sort()
  warnings.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))

  const isIgnored = (input: string, isDirectory = false): boolean => {
    const relative = normalizeRelative(input)
    if (relative === null || relative === '.') return false
    const directory = isDirectory || input.trimEnd().endsWith('/')
    const segments = relative.split('/')
    const layers: IgnoreLayer[] = [...rootLayers]
    const rootLayer = layersByDir.get('')
    if (rootLayer) layers.push(rootLayer)
    for (let i = 0; i < segments.length; i++) {
      const current = segments.slice(0, i + 1).join('/')
      const isLast = i === segments.length - 1
      if (testLayers(layers, current, isLast ? directory : true)) return true
      const nested = layersByDir.get(current)
      if (nested && !isLast) layers.push(nested)
    }
    return false
  }

  return { files, ignoredFiles, directories, truncated, isIgnored, warnings }
}
