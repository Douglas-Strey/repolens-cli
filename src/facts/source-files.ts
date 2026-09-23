import type { Analyzer } from '../types.ts'
import { baseName, dirOf, extOf } from '../utils/paths.ts'
import { manifests, type ProjectManifests } from './manifests.ts'

export const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.ts',
  '.mts',
  '.cts',
  '.tsx',
  '.vue',
  '.svelte',
  '.astro',
  '.go',
])

/** Directory names that usually contain generated or vendored code. */
const GENERATED_DIRS = new Set(['dist', 'build', 'out', 'public', 'static', 'lib-cov', 'storybook-static', 'generated'])

/** Maximum number of source files handed to content scanners (env usage, routes). */
export const MAX_SOURCE_FILES = 20_000

/** Source files larger than this are skipped by content scanners (usually bundled or generated). */
export const MAX_SOURCE_FILE_BYTES = 512 * 1024

export interface SourceFile {
  path: string
  /** Lowercase extension with dot. */
  ext: string
  /** Owning package directory ("." = root). */
  package: string
}

export interface SourceFiles {
  files: SourceFile[]
  truncated: boolean
}

/**
 * Build a function returning the deepest package (package.json or go.mod
 * directory) that contains a file. Each lookup walks up the file's parent
 * directories, so it costs the path depth rather than the package count
 * (a workspace can declare thousands of packages).
 */
export function createOwnerResolver(project: ProjectManifests): (file: string) => string {
  const dirs = new Set([...project.packages.map((p) => p.dir), ...project.goModules.map((m) => m.dir)])
  return (file) => {
    // Starts at `file` itself: a package directory belongs to its own package.
    for (let dir = file, parent = dirOf(dir); dir !== parent; dir = parent, parent = dirOf(dir)) {
      if (dirs.has(dir)) return dir
    }
    return '.'
  }
}

/** Deepest package (package.json or go.mod directory) that contains `file`. */
export function ownerOf(project: ProjectManifests, file: string): string {
  return createOwnerResolver(project)(file)
}

/** Type declarations, minified bundles, generated Go code and files under build/output directories. */
export function isGenerated(file: string): boolean {
  const name = baseName(file)
  if (name.endsWith('.d.ts') || name.endsWith('.d.mts') || name.endsWith('.d.cts')) return true
  if (/\.min\.[cm]?js$/.test(name) || /\.(?:bundle|chunk)\.[cm]?js$/.test(name)) return true
  if (name.endsWith('.pb.go') || name.endsWith('_gen.go') || name.endsWith('.gen.go')) return true
  const segments = file.split('/')
  segments.pop()
  return segments.some((segment) => GENERATED_DIRS.has(segment))
}

/**
 * Source files worth reading for content analysis (environment variable usage,
 * route definitions). Excludes type declarations, minified bundles and
 * generated directories. Read them with `ctx.readText(path, { cache: false })`.
 */
export const sourceFiles: Analyzer<SourceFiles> = {
  id: 'source-files',
  async run(ctx) {
    const owner = createOwnerResolver(await ctx.use(manifests))
    const files: SourceFile[] = []
    let truncated = false
    for (const path of ctx.files.files) {
      const ext = extOf(path)
      if (!SOURCE_EXTENSIONS.has(ext) || isGenerated(path)) continue
      if (files.length >= MAX_SOURCE_FILES) {
        truncated = true
        break
      }
      files.push({ path, ext, package: owner(path) })
    }
    if (truncated) ctx.debug(`source-files: limited to ${MAX_SOURCE_FILES} files`)
    return { files, truncated }
  },
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

/** "js": JavaScript and TypeScript (also inside .vue/.svelte/.astro files). "c": Go, Prisma and other C-like syntaxes. */
export type CommentSyntax = 'js' | 'c'

const SLASH = 47
const STAR = 42
const BACKSLASH = 92
const DOUBLE_QUOTE = 34
const SINGLE_QUOTE = 39
const BACKTICK = 96
const DOLLAR = 36
const OPEN_BRACE = 123
const CLOSE_BRACE = 125
const NEWLINE = 10

/** Keywords after which a "/" starts a regular expression rather than a division. */
const REGEX_AFTER_WORD: ReadonlySet<string> = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
])

function isWordChar(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95 ||
    code === DOLLAR ||
    code > 127
  )
}

/** Index after a quoted string starting at `start`; strings that can't span lines end at the line end. */
function quotedEnd(text: string, start: number, quote: number, multiline: boolean, escapes: boolean): number {
  for (let i = start + 1; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (escapes && code === BACKSLASH) i++
    else if (code === quote) return i + 1
    else if (code === NEWLINE && !multiline) return i
  }
  return text.length
}

/** Index after the regular expression literal starting at `start`, or -1 when none closes on this line. */
function regexEnd(text: string, start: number): number {
  let inClass = false
  for (let i = start + 1; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === NEWLINE) return -1
    if (code === BACKSLASH) i++
    else if (code === 91) inClass = true
    else if (code === 93) inClass = false
    else if (code === SLASH && !inClass) {
      let end = i + 1
      while (end < text.length && /[a-z]/.test(text[end] as string)) end++
      return end
    }
  }
  return -1
}

/**
 * Scan template literal text from `from` (just inside the backtick or just
 * after a `}` that closed a `${…}` expression). Returns the index after the
 * closing backtick, or after the `${` that opens an expression.
 */
function templateChunk(text: string, from: number): { end: number; expression: boolean } {
  for (let i = from; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === BACKSLASH) i++
    else if (code === BACKTICK) return { end: i + 1, expression: false }
    else if (code === DOLLAR && text.charCodeAt(i + 1) === OPEN_BRACE) return { end: i + 2, expression: true }
  }
  return { end: text.length, expression: false }
}

/**
 * Replace every comment with spaces, keeping newlines so offsets and line
 * numbers stay valid, and leaving strings alone: "http://x" and
 * '/* not a comment *\/' are code. The "js" syntax understands template
 * literals (with nested `${…}` expressions) and regular expression literals;
 * "c" understands double-quoted strings, backtick raw strings and 'runes'.
 * Runs in linear time on any input: strings that can't span lines end at the
 * line end, and an unterminated comment or template runs to the end of the text.
 */
export function blankComments(text: string, syntax: CommentSyntax): string {
  if (!text.includes('/')) return text
  const js = syntax === 'js'
  const parts: string[] = []
  let copyFrom = 0
  const blank = (start: number, end: number) => {
    parts.push(text.slice(copyFrom, start), text.slice(start, end).replace(/[^\n]/g, ' '))
    copyFrom = end
  }
  // Brace depth at which each open `${…}` template expression started.
  const templates: number[] = []
  let braces = 0
  let regexAllowed = true
  // After a "/" that started no regex on its line, later slashes on that line are divisions:
  // retrying the regex scan from each of them would be quadratic.
  let divisionUntil = -1
  let i = 0
  while (i < text.length) {
    const code = text.charCodeAt(i)
    if (code === SLASH) {
      const next = text.charCodeAt(i + 1)
      if (next === SLASH) {
        const end = text.indexOf('\n', i + 2)
        blank(i, end === -1 ? text.length : end)
        i = end === -1 ? text.length : end
        continue
      }
      if (next === STAR) {
        const close = text.indexOf('*/', i + 2)
        const end = close === -1 ? text.length : close + 2
        blank(i, end)
        i = end
        continue
      }
      if (js && regexAllowed && i > divisionUntil) {
        const end = regexEnd(text, i)
        if (end !== -1) {
          i = end
          regexAllowed = false
          continue
        }
        const newline = text.indexOf('\n', i)
        divisionUntil = newline === -1 ? text.length : newline
      }
      regexAllowed = true
      i++
    } else if (code === DOUBLE_QUOTE || code === SINGLE_QUOTE) {
      i = quotedEnd(text, i, code, false, true)
      regexAllowed = false
    } else if (code === BACKTICK) {
      if (js) {
        const chunk = templateChunk(text, i + 1)
        if (chunk.expression) templates.push(braces++)
        i = chunk.end
      } else {
        i = quotedEnd(text, i, code, true, false)
      }
      regexAllowed = false
    } else if (code === OPEN_BRACE) {
      braces++
      regexAllowed = true
      i++
    } else if (code === CLOSE_BRACE) {
      braces = Math.max(0, braces - 1)
      if (templates.length > 0 && braces === templates[templates.length - 1]) {
        templates.pop()
        const chunk = templateChunk(text, i + 1)
        if (chunk.expression) templates.push(braces++)
        i = chunk.end
        regexAllowed = false
      } else {
        regexAllowed = true
        i++
      }
    } else if (isWordChar(code)) {
      const start = i
      while (i < text.length && isWordChar(text.charCodeAt(i))) i++
      regexAllowed = REGEX_AFTER_WORD.has(text.slice(start, i))
    } else {
      // Whitespace keeps the previous state; ")" and "]" end an operand; any other punctuation expects one.
      if (code === 41 || code === 93) regexAllowed = false
      else if (code !== 32 && code !== 9 && code !== NEWLINE && code !== 13) regexAllowed = true
      i++
    }
  }
  if (copyFrom === 0) return text
  parts.push(text.slice(copyFrom))
  return parts.join('')
}
