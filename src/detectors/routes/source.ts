/**
 * A small, linear-time lexical pass over JavaScript/TypeScript or Go source.
 *
 * Route extraction runs regular expressions over the result, so the pass does
 * just enough to make that reliable on arbitrary code: comments are blanked
 * (commented-out routes disappear, offsets and line numbers stay intact),
 * strings, template literals and regex literals are skipped so their contents
 * cannot unbalance brackets, and every bracket is matched so call arguments
 * can be split without re-scanning. It never throws and never backtracks.
 */

export type SourceLanguage = 'js' | 'go'

export interface SourceText {
  /** Original text with comments replaced by spaces (same length, same line breaks). */
  readonly code: string
  /** Opening bracket offset → matching closing bracket offset (missing when unbalanced). */
  readonly closeOf: ReadonlyMap<number, number>
  /** Closing bracket offset → opening bracket offset. */
  readonly openOf: ReadonlyMap<number, number>
  /** Opening bracket offset → offsets of the commas directly inside it (absent when there are none). */
  readonly commasOf: ReadonlyMap<number, readonly number[]>
  /** 1-based line number of an offset. */
  lineAt(offset: number): number
  /**
   * True when `offset` lies inside a string, template or regex literal (template
   * `${…}` expressions are code). Pattern matches starting inside a literal are
   * text, not code: `const doc = "app.get('/x', h)"` defines no route.
   */
  inLiteral(offset: number): boolean
}

export interface Span {
  start: number
  end: number
}

const REGEX_PRECEDERS = new Set([
  '(',
  ',',
  '=',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  '{',
  '}',
  ';',
  '+',
  '-',
  '*',
  '%',
  '<',
  '>',
  '~',
  '^',
])
const REGEX_KEYWORDS = new Set([
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

function isIdentChar(ch: string | undefined): boolean {
  if (ch === undefined) return false
  const c = ch.charCodeAt(0)
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36 || c > 127
}

function isSpace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v'
}

function skipQuoted(text: string, start: number, quote: string): number {
  let j = start + 1
  while (j < text.length) {
    const ch = text[j]
    if (ch === '\\') {
      j += 2
      continue
    }
    if (ch === quote) return j + 1
    // An unterminated string ends at the line break, which limits the damage
    // of a misread quote (for example an apostrophe in JSX text).
    if (ch === '\n') return j
    j++
  }
  return text.length
}

/**
 * Longest regex literal recognized. A failed attempt does not consume input, so
 * without a bound every "/" of a long line like "= /[= /[…" would rescan the rest
 * of the line (quadratic). Longer literals are read as division, which only
 * affects the rest of that line.
 */
const MAX_REGEX_LENGTH = 512

/** End offset of a regex literal starting at `start`, or -1 when it is not one (no closing slash on the line). */
function skipRegex(text: string, start: number): number {
  let j = start + 1
  let inClass = false
  const limit = Math.min(text.length, start + MAX_REGEX_LENGTH)
  while (j < limit) {
    const ch = text[j]
    if (ch === '\n') return -1
    if (ch === '\\') {
      j += 2
      continue
    }
    if (inClass) {
      if (ch === ']') inClass = false
    } else if (ch === '[') {
      inClass = true
    } else if (ch === '/') {
      j++
      while (j < text.length && isIdentChar(text[j])) j++
      return j
    }
    j++
  }
  return -1
}

function regexAllowed(text: string, lastSignificant: number): boolean {
  if (lastSignificant < 0) return true
  const ch = text[lastSignificant] as string
  if (REGEX_PRECEDERS.has(ch)) return true
  if (!isIdentChar(ch)) return false
  let start = lastSignificant
  while (start > 0 && isIdentChar(text[start - 1])) start--
  return REGEX_KEYWORDS.has(text.slice(start, lastSignificant + 1))
}

function lineStartsOf(text: string): number[] {
  const starts = [0]
  let index = text.indexOf('\n')
  while (index !== -1) {
    starts.push(index + 1)
    index = text.indexOf('\n', index + 1)
  }
  return starts
}

interface OpenBracket {
  at: number
  /** "(" "[" "{" or "${" for a template literal expression. */
  kind: string
}

const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' }

export function analyzeSource(text: string, language: SourceLanguage): SourceText {
  const n = text.length
  const js = language === 'js'
  const pieces: string[] = []
  let copied = 0
  const blank = (from: number, to: number) => {
    pieces.push(text.slice(copied, from), text.slice(from, to).replace(/[^\n]/g, ' '))
    copied = to
  }
  const closeOf = new Map<number, number>()
  const openOf = new Map<number, number>()
  const commasOf = new Map<number, number[]>()
  const stack: OpenBracket[] = []
  // Literal spans as [start, end) pairs, appended in order, so they stay sorted and disjoint.
  const literals: number[] = []
  const literal = (from: number, to: number) => {
    if (to > from) literals.push(from, to)
  }

  const scanTemplate = (from: number): number => {
    let j = from
    while (j < n) {
      const ch = text[j]
      if (ch === '\\') {
        j += 2
        continue
      }
      if (ch === '`') return j + 1
      if (ch === '$' && text[j + 1] === '{') {
        stack.push({ at: j + 1, kind: '${' })
        return j + 2
      }
      j++
    }
    return n
  }

  let lastSignificant = -1
  let i = 0
  while (i < n) {
    const ch = text[i] as string
    if (isSpace(ch)) {
      i++
      continue
    }
    const next = text[i + 1]
    if (ch === '/' && next === '/') {
      let end = text.indexOf('\n', i)
      if (end === -1) end = n
      blank(i, end)
      i = end
      continue
    }
    if (ch === '/' && next === '*') {
      const close = text.indexOf('*/', i + 2)
      const end = close === -1 ? n : close + 2
      blank(i, end)
      i = end
      continue
    }
    if (ch === '"' || ch === "'") {
      const end = skipQuoted(text, i, ch)
      literal(i, end)
      i = end
      lastSignificant = i - 1
      continue
    }
    if (ch === '`') {
      let end: number
      if (js) {
        end = scanTemplate(i + 1)
      } else {
        const close = text.indexOf('`', i + 1)
        end = close === -1 ? n : close + 1
      }
      literal(i, end)
      i = end
      lastSignificant = i - 1
      continue
    }
    if (js && ch === '/' && regexAllowed(text, lastSignificant)) {
      const end = skipRegex(text, i)
      if (end !== -1) {
        literal(i, end)
        i = end
        lastSignificant = i - 1
        continue
      }
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      stack.push({ at: i, kind: ch })
    } else if (ch === ')' || ch === ']' || ch === '}') {
      const top = stack[stack.length - 1]
      if (ch === '}' && top?.kind === '${') {
        stack.pop()
        const end = scanTemplate(i + 1)
        literal(i, end)
        i = end
        lastSignificant = i - 1
        continue
      }
      const expected = CLOSERS[ch]
      // Tolerate a few unmatched openers (malformed or misread code) without crossing a template boundary.
      let k = stack.length - 1
      while (k >= 0 && k >= stack.length - 4 && stack[k]?.kind !== expected && stack[k]?.kind !== '${') k--
      const opener = stack[k]
      if (opener && opener.kind === expected) {
        closeOf.set(opener.at, i)
        openOf.set(i, opener.at)
        stack.length = k
      }
    } else if (ch === ',') {
      const top = stack[stack.length - 1]
      if (top && top.kind !== '${') {
        const list = commasOf.get(top.at)
        if (list) list.push(i)
        else commasOf.set(top.at, [i])
      }
    }
    lastSignificant = i
    i++
  }
  pieces.push(text.slice(copied))
  const code = pieces.join('')
  const starts = lineStartsOf(text)

  return {
    code,
    closeOf,
    openOf,
    commasOf,
    lineAt(offset: number): number {
      let lo = 0
      let hi = starts.length - 1
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if ((starts[mid] as number) <= offset) lo = mid
        else hi = mid - 1
      }
      return lo + 1
    },
    inLiteral(offset: number): boolean {
      // Last span starting at or before `offset`.
      let lo = 0
      let hi = literals.length / 2 - 1
      let found = -1
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if ((literals[mid * 2] as number) <= offset) {
          found = mid
          lo = mid + 1
        } else {
          hi = mid - 1
        }
      }
      return found !== -1 && offset < (literals[found * 2 + 1] as number)
    },
  }
}

export function skipSpaces(code: string, from: number): number {
  let j = from
  while (j < code.length && isSpace(code[j])) j++
  return j
}

function skipSpacesBack(code: string, from: number): number {
  let j = from
  while (j >= 0 && isSpace(code[j])) j--
  return j
}

export interface StringLiteral {
  value: string
  /** Offset just past the closing quote; -1 for a template literal with `${}`. */
  end: number
  /** Template literal with interpolation: the value is unknown. */
  dynamic: boolean
}

const MAX_LITERAL_LENGTH = 2048

/** Read the string literal starting at `at` ('…', "…", `…`). Null when there is none. */
export function readStringLiteral(code: string, at: number, language: SourceLanguage): StringLiteral | null {
  const quote = code[at]
  if (quote === '`') {
    if (language === 'go') {
      const close = code.indexOf('`', at + 1)
      if (close === -1 || close - at > MAX_LITERAL_LENGTH) return null
      return { value: code.slice(at + 1, close), end: close + 1, dynamic: false }
    }
    let value = ''
    for (let j = at + 1; j < code.length && j - at <= MAX_LITERAL_LENGTH; j++) {
      const ch = code[j] as string
      if (ch === '\\') {
        value += code[j + 1] ?? ''
        j++
      } else if (ch === '`') {
        return { value, end: j + 1, dynamic: false }
      } else if (ch === '$' && code[j + 1] === '{') {
        return { value: '', end: -1, dynamic: true }
      } else {
        value += ch
      }
    }
    return null
  }
  if (quote !== '"' && quote !== "'") return null
  let value = ''
  for (let j = at + 1; j < code.length && j - at <= MAX_LITERAL_LENGTH; j++) {
    const ch = code[j] as string
    if (ch === '\\') {
      value += code[j + 1] ?? ''
      j++
    } else if (ch === quote) {
      return { value, end: j + 1, dynamic: false }
    } else if (ch === '\n') {
      return null
    } else {
      value += ch
    }
  }
  return null
}

/** Trim whitespace from both ends of a span. */
function trimSpan(code: string, start: number, end: number): Span {
  let s = start
  let e = end
  while (s < e && isSpace(code[s])) s++
  while (e > s && isSpace(code[e - 1])) e--
  return { start: s, end: e }
}

/** Argument spans of the call whose "(" is at `open`; null when its brackets are unbalanced. */
export function argumentSpans(src: SourceText, open: number): Span[] | null {
  const close = src.closeOf.get(open)
  if (close === undefined) return null
  const spans: Span[] = []
  let start = open + 1
  for (const comma of [...(src.commasOf.get(open) ?? []), close]) {
    const span = trimSpan(src.code, start, comma)
    if (span.end > span.start) spans.push(span)
    start = comma + 1
  }
  return spans
}

/**
 * Fallback for calls whose brackets could not be matched: the first argument
 * when it is a string literal, and whether more arguments follow it.
 */
export function leadingStringArgument(
  src: SourceText,
  open: number,
  language: SourceLanguage,
): { span: Span; more: boolean } | null {
  const start = skipSpaces(src.code, open + 1)
  const literal = readStringLiteral(src.code, start, language)
  if (!literal || literal.dynamic) return null
  const after = skipSpaces(src.code, literal.end)
  return { span: { start, end: literal.end }, more: src.code[after] === ',' }
}

/**
 * Skip TypeScript type arguments starting at `at` (`get<{ Body: { a: string; b: number } }>(`).
 * Returns the offset after the closing ">", `at` itself when there are none,
 * or -1 when the "<" does not start type arguments of a call.
 */
export function skipTypeArguments(code: string, at: number): number {
  if (code[at] !== '<') return at
  let depth = 0
  const limit = Math.min(code.length, at + 1024)
  for (let j = at; j < limit; j++) {
    const ch = code[j]
    if (ch === '<') depth++
    else if (ch === '>' && code[j - 1] !== '=') {
      depth--
      if (depth === 0) return code[skipSpaces(code, j + 1)] === '(' ? j + 1 : -1
    } else if (ch === '=' && code[j + 1] !== '>') {
      return -1 // an assignment or comparison, not a type
    }
  }
  return -1
}

export type ReceiverToken =
  | { kind: 'name'; name: string; start: number }
  | { kind: 'call'; close: number }
  | { kind: 'none' }

/**
 * The expression a method is called on, read backwards from the "." at `dot`:
 * an identifier (Go: a selector chain such as `s.router`), or the closing
 * parenthesis of a call when the method is chained.
 */
export function receiverBefore(code: string, dot: number, dotted: boolean): ReceiverToken {
  let j = skipSpacesBack(code, dot - 1)
  if (code[j] === '?') j-- // optional chaining
  if (code[j] === ')') return { kind: 'call', close: j }
  const end = j + 1
  while (j >= 0 && end - j <= 256 && (isIdentChar(code[j]) || (dotted && code[j] === '.'))) j--
  let start = j + 1
  while (start < end && code[start] === '.') start++
  if (start >= end) return { kind: 'none' }
  const name = code.slice(start, end)
  if (/^\d/.test(name) || name.endsWith('.')) return { kind: 'none' }
  return { kind: 'name', name, start }
}

/** Offset of the "<" opening the type arguments that end at the ">" at `close`, or -1. */
function typeArgumentsStart(code: string, close: number): number {
  let depth = 0
  // Type arguments of a call are short; the bound keeps chains of `>(…)` linear.
  const limit = Math.max(0, close - 1024)
  for (let j = close; j >= limit; j--) {
    const ch = code[j]
    if (ch === '>' && code[j - 1] !== '=') depth++
    else if (ch === '<') {
      depth--
      if (depth === 0) return j
    }
  }
  return -1
}

/** Callee of the call whose "(" is at `open`, e.g. "Hono" for `new Hono<Env>()`; `start` is where the expression begins. */
export function calleeBefore(code: string, open: number): { callee: string; isNew: boolean; start: number } | null {
  let j = skipSpacesBack(code, open - 1)
  if (code[j] === '>') {
    const start = typeArgumentsStart(code, j)
    if (start === -1) return null
    j = skipSpacesBack(code, start - 1)
  }
  const end = j + 1
  while (j >= 0 && end - j <= 256 && (isIdentChar(code[j]) || code[j] === '.')) j--
  const callee = code.slice(j + 1, end)
  if (callee === '' || callee.startsWith('.')) return null
  const before = skipSpacesBack(code, j)
  const isNew = before >= 2 && code.slice(before - 2, before + 1) === 'new' && !isIdentChar(code[before - 3])
  return { callee, isNew, start: isNew ? before - 2 : j + 1 }
}

/**
 * The method name of the call whose "(" is at `open` when it is a method call
 * (`x.disable('etag')`, `app\n  .withTypeProvider<T>()`), with the offset of
 * its ".". Null for plain function calls.
 */
export function methodBefore(code: string, open: number): { name: string; dot: number } | null {
  let j = skipSpacesBack(code, open - 1)
  if (code[j] === '>') {
    const start = typeArgumentsStart(code, j)
    if (start === -1) return null
    j = skipSpacesBack(code, start - 1)
  }
  const end = j + 1
  while (j >= 0 && end - j <= 64 && isIdentChar(code[j])) j--
  const name = code.slice(j + 1, end)
  const dot = skipSpacesBack(code, j)
  if (name === '' || code[dot] !== '.') return null
  return { name, dot }
}

/** Longest stretch searched between a parameter list and the function body (return type annotations). */
const SIGNATURE_WINDOW = 1024

/** Index of `needle` in [from, end), searching at most SIGNATURE_WINDOW characters. */
function indexInWindow(code: string, needle: string, from: number, end: number): number {
  const limit = Math.min(end, from + SIGNATURE_WINDOW)
  const index = code.slice(from, limit).indexOf(needle)
  return index === -1 ? -1 : from + index
}

export interface FunctionLiteral {
  /** First parameter name, or null when it is destructured or absent. */
  param: string | null
  /** The function body (braces included, or the expression of an arrow function). */
  body: Span
}

function firstParameter(code: string, from: number, to: number): string | null {
  const match = /^\s*(?:\.\.\.)?([A-Za-z_$][\w$]*)/.exec(code.slice(from, Math.min(to, from + 256)))
  return match?.[1] ?? null
}

function bodyFrom(src: SourceText, at: number, limit: number): Span | null {
  const start = skipSpaces(src.code, at)
  if (start >= limit) return null
  if (src.code[start] === '{') {
    const close = src.closeOf.get(start)
    return close === undefined ? null : { start, end: close + 1 }
  }
  return { start, end: limit }
}

/** Parse a JavaScript function expression or arrow function occupying `span`. */
export function jsFunctionAt(src: SourceText, span: Span): FunctionLiteral | null {
  const { code } = src
  let j = span.start
  if (code.startsWith('async', j) && !isIdentChar(code[j + 5])) j = skipSpaces(code, j + 5)
  if (code.startsWith('function', j) && !isIdentChar(code[j + 8])) {
    j = skipSpaces(code, j + 8)
    if (code[j] === '*') j = skipSpaces(code, j + 1)
    while (j < span.end && isIdentChar(code[j])) j++
    j = skipSpaces(code, j)
    if (code[j] !== '(') return null
    const close = src.closeOf.get(j)
    if (close === undefined || close >= span.end) return null
    const brace = indexInWindow(code, '{', close, span.end)
    if (brace === -1) return null
    const body = bodyFrom(src, brace, span.end)
    return body ? { param: firstParameter(code, j + 1, close), body } : null
  }
  if (code[j] === '(') {
    const close = src.closeOf.get(j)
    if (close === undefined || close >= span.end) return null
    const arrow = indexInWindow(code, '=>', close, span.end)
    if (arrow === -1) return null
    const between = code.slice(close + 1, arrow).trim()
    if (between !== '' && !between.startsWith(':')) return null
    const body = bodyFrom(src, arrow + 2, span.end)
    return body ? { param: firstParameter(code, j + 1, close), body } : null
  }
  const single = /^([A-Za-z_$][\w$]*)\s*=>/.exec(code.slice(j, Math.min(span.end, j + 256)))
  if (single?.[1]) {
    const body = bodyFrom(src, j + single[0].length, span.end)
    return body ? { param: single[1], body } : null
  }
  return null
}

/** Parse a Go function literal (`func(r chi.Router) { … }`) occupying `span`. */
export function goFunctionAt(src: SourceText, span: Span): FunctionLiteral | null {
  const { code } = src
  if (!code.startsWith('func', span.start)) return null
  const open = skipSpaces(code, span.start + 4)
  if (code[open] !== '(') return null
  const close = src.closeOf.get(open)
  if (close === undefined || close >= span.end) return null
  const brace = indexInWindow(code, '{', close, span.end)
  if (brace === -1) return null
  const end = src.closeOf.get(brace)
  if (end === undefined) return null
  return { param: firstParameter(code, open + 1, close), body: { start: brace, end: end + 1 } }
}
