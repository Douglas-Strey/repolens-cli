/**
 * Glob matching for posix relative paths.
 *
 * Patterns can come from untrusted repositories (workspace globs), so the
 * generated regular expressions must never backtrack catastrophically. The
 * construction below keeps every match roughly linear in the path length:
 *
 * - `{a,b}` is expanded up front into top-level alternatives, so no
 *   alternation remains inside a pattern.
 * - Within a segment, every `*` except the last one is matched "atomically"
 *   at the earliest position (a lookahead capture plus a backreference, the
 *   usual way to emulate atomic groups in JavaScript). For chunks of fixed
 *   length between stars, the earliest match is always the best one.
 * - `**` segments work the same way at the segment level: every globstar
 *   except the last one matches the shortest run of directories after which
 *   the following segments match.
 */

const cache = new Map<string, RegExp>()
const MAX_CACHE_ENTRIES = 2048
const MAX_PATTERN_LENGTH = 1024
/**
 * Brace expansion limits. Every alternative becomes part of one regex, so a
 * 1 KB pattern expanding to 1024 alternatives of 900 characters compiled to
 * almost 1 MB of regex source (fifty of them took 14 s and 1.6 GB).
 */
const MAX_ALTERNATIVES = 256
const MAX_EXPANDED_LENGTH = 8192
/**
 * Every `*` becomes a lookahead with a capture group, and V8's compile time
 * grows faster than linearly with them: 10k characters of regex source took
 * 4.5 ms to compile, 40k took 65 ms. Larger patterns match nothing.
 */
const MAX_REGEX_SOURCE = 8192

/** Matches nothing: used for patterns too long or too large to expand. */
const NEVER = /(?!)/

const GLOBSTAR = Symbol('globstar')

function escapeChar(ch: string): string {
  if (ch === '?') return '[^/]'
  return /[.+^$()|[\]\\{}*/]/.test(ch) ? `\\${ch}` : ch
}

function literal(text: string): string {
  let out = ''
  for (const ch of text) out += escapeChar(ch)
  return out
}

/**
 * Expand `{a,b}` alternatives, including nested ones. An unmatched `{` is
 * kept literally. Returns null when the expansion exceeds `limit` patterns or
 * `maxLength` characters in total.
 */
export function expandBraces(
  pattern: string,
  limit = MAX_ALTERNATIVES,
  maxLength = MAX_EXPANDED_LENGTH,
): string[] | null {
  const out: string[] = []
  let length = 0
  const expand = (prefix: string, rest: string): boolean => {
    const open = rest.indexOf('{')
    if (open === -1) {
      const alternative = prefix + rest
      out.push(alternative)
      length += alternative.length
      return out.length <= limit && length <= maxLength
    }
    let depth = 0
    let close = -1
    const commas: number[] = []
    for (let i = open; i < rest.length; i++) {
      const ch = rest[i]
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          close = i
          break
        }
      } else if (ch === ',' && depth === 1) commas.push(i)
    }
    if (close === -1) return expand(prefix + rest.slice(0, open + 1), rest.slice(open + 1))
    const head = prefix + rest.slice(0, open)
    const tail = rest.slice(close + 1)
    const bounds = [open, ...commas, close]
    for (let i = 0; i < bounds.length - 1; i++) {
      const alternative = rest.slice((bounds[i] as number) + 1, bounds[i + 1])
      if (!expand(head, alternative + tail)) return false
    }
    return true
  }
  return expand('', pattern) ? out : null
}

interface Groups {
  next: number
}

/** One path segment: literals, `?`, and `*` (a `**` inside a segment is a plain `*`). */
function segmentSource(segment: string, groups: Groups): string {
  const pieces = segment.split(/\*+/)
  if (pieces.length === 1) return literal(segment)
  let re = literal(pieces[0] as string)
  for (let i = 1; i < pieces.length - 1; i++) {
    const n = ++groups.next
    re += `(?=([^/]*?${literal(pieces[i] as string)}))(?:\\${n})`
  }
  return `${re}[^/]*${literal(pieces[pieces.length - 1] as string)}`
}

function chunkSource(segments: readonly string[], groups: Groups): string {
  return segments.map((segment) => segmentSource(segment, groups)).join('/')
}

/** Regex source for a brace-free pattern. */
function patternSource(pattern: string, groups: Groups): string {
  // Chunks of ordinary segments separated by globstars (consecutive `**` collapse).
  const chunks: string[][] = [[]]
  let previous: string | typeof GLOBSTAR | undefined
  for (const segment of pattern.split('/')) {
    if (segment === '**') {
      if (previous !== GLOBSTAR) chunks.push([])
      previous = GLOBSTAR
    } else {
      ;(chunks[chunks.length - 1] as string[]).push(segment)
      previous = segment
    }
  }
  if (chunks.length === 1) return chunkSource(chunks[0] as string[], groups)

  const first = chunks[0] as string[]
  let re = first.length > 0 ? `${chunkSource(first, groups)}/` : ''
  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i] as string[]
    if (i < chunks.length - 1) {
      // Not the last globstar: skip the fewest directories after which `chunk` matches.
      const n = ++groups.next
      re += `(?=((?:[^/]*/)*?${chunkSource(chunk, groups)}/))(?:\\${n})`
    } else if (chunk.length === 0) {
      re += '.*' // trailing "/**": anything below
    } else {
      re += `(?:[^/]*/)*${chunkSource(chunk, groups)}`
    }
  }
  return re
}

/**
 * Convert a glob to an anchored RegExp matching posix relative paths.
 * Supports `*`, `**`, `?` and `{a,b}` (nested). `*` also matches dotfiles.
 * `[...]` is not a character class: brackets match literally (Next.js-style
 * `[id]` directories). A leading "./" and trailing "/" are ignored. Patterns
 * longer than 1024 characters, expanding to more than 256 alternatives or
 * 8192 characters in total, or compiling to more than 8192 characters of
 * regex, match nothing.
 */
export function globToRegExp(pattern: string): RegExp {
  let cached = cache.get(pattern)
  if (!cached) {
    const cleaned = pattern.replace(/^(?:\.\/)+/, '').replace(/\/+$/, '')
    const alternatives = cleaned.length > MAX_PATTERN_LENGTH ? null : expandBraces(cleaned)
    if (alternatives === null) {
      cached = NEVER
    } else {
      const groups: Groups = { next: 0 }
      const sources = alternatives.map((alternative) => patternSource(alternative, groups))
      const source = sources.length === 1 ? `^${sources[0]}$` : `^(?:${sources.join('|')})$`
      cached = source.length > MAX_REGEX_SOURCE ? NEVER : new RegExp(source)
    }
    if (cache.size >= MAX_CACHE_ENTRIES) cache.clear()
    cache.set(pattern, cached)
  }
  return cached
}

export function matchGlob(pattern: string, path: string): boolean {
  return globToRegExp(pattern).test(path)
}

/**
 * Match a path against workspace-style patterns where a leading "!" negates.
 * Later patterns win, like pnpm and npm workspaces.
 */
export function matchPatterns(patterns: readonly string[], path: string): boolean {
  let matched = false
  for (const raw of patterns) {
    const negated = raw.startsWith('!')
    const pattern = negated ? raw.slice(1) : raw
    if (matchGlob(pattern, path)) matched = !negated
  }
  return matched
}
