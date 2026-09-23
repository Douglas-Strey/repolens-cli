/**
 * Structural checks for generated Markdown, shared by the report and agent
 * tests. They follow GitHub's (cmark-gfm) rules closely enough to catch
 * broken tables, dangling <details> blocks and empty headings.
 */

/**
 * Number of cells in a table row. A pipe splits cells unless it is escaped,
 * i.e. preceded by an odd number of backslashes (cmark-gfm scans `\x` pairs).
 */
export function cellCount(row: string): number {
  let pipes = 0
  let slashes = 0
  for (const char of row) {
    if (char === '\\') {
      slashes++
      continue
    }
    if (char === '|' && slashes % 2 === 0) pipes++
    slashes = 0
  }
  // "| a | b |" has 3 pipes and 2 cells.
  return pipes - 1
}

export interface TableProblem {
  line: number
  text: string
  reason: string
}

/** Every table: a delimiter row after the header and the same cell count on every row. */
export function tableProblems(markdown: string): TableProblem[] {
  const lines = markdown.split('\n')
  const problems: TableProblem[] = []
  let i = 0
  while (i < lines.length) {
    if (!(lines[i] ?? '').startsWith('|')) {
      i++
      continue
    }
    const start = i
    while (i < lines.length && (lines[i] ?? '').startsWith('|')) i++
    const block = lines.slice(start, i)
    const header = block[0] ?? ''
    const delimiter = block[1] ?? ''
    const columns = cellCount(header)
    if (!/^\|(?: :?-{3,}:? \|)+$/.test(delimiter)) {
      problems.push({ line: start + 2, text: delimiter, reason: 'missing or malformed delimiter row' })
    }
    block.forEach((row, offset) => {
      if (!row.endsWith('|'))
        problems.push({ line: start + offset + 1, text: row, reason: 'row does not end with a pipe' })
      if (cellCount(row) !== columns) {
        problems.push({
          line: start + offset + 1,
          text: row,
          reason: `expected ${columns} cells, got ${cellCount(row)}`,
        })
      }
    })
    if (start > 0 && (lines[start - 1] ?? '') !== '') {
      problems.push({ line: start + 1, text: header, reason: 'table not preceded by a blank line' })
    }
  }
  return problems
}

/** Headings immediately followed by a heading of the same or a higher level, a rule, or the end. */
export function emptyHeadings(markdown: string): string[] {
  const lines = markdown.split('\n')
  const empty: string[] = []
  lines.forEach((line, index) => {
    const match = /^(#{1,6}) /.exec(line)
    if (!match) return
    const level = match[1]?.length ?? 0
    const next = lines.slice(index + 1).find((candidate) => candidate.trim() !== '')
    const nextLevel = next ? (/^(#{1,6}) /.exec(next)?.[1]?.length ?? 0) : 0
    if (next === undefined || next === '---' || (nextLevel > 0 && nextLevel <= level)) empty.push(line)
  })
  return empty
}

/** <details> blocks are balanced and keep the blank line GitHub needs after <summary>. */
export function detailsProblems(markdown: string): string[] {
  const problems: string[] = []
  const opens = markdown.match(/<details>/g)?.length ?? 0
  const closes = markdown.match(/<\/details>/g)?.length ?? 0
  if (opens !== closes) problems.push(`${opens} <details> but ${closes} </details>`)
  for (const match of markdown.matchAll(/<summary>.*<\/summary>\n(.*)/g)) {
    if (match[1] !== '') problems.push(`no blank line after ${match[0].split('\n')[0]}`)
  }
  return problems
}

/** Strings that betray a rendering bug or a leaked value. */
export const BAD_TOKENS = [/\bundefined\b/, /\bnull\b/, /\[object Object\]/, /\bNaN\b/]

/** Absolute paths from a developer machine or CI runner. */
export const ABSOLUTE_PATH = /(?:^|[\s(`'"])(?:\/(?:Users|home|tmp|private|var|root)\/|[A-Za-z]:\\)/m

/** All generic invariants at once; returns a list of human-readable problems (empty when fine). */
export function markdownProblems(markdown: string): string[] {
  const problems: string[] = []
  for (const problem of tableProblems(markdown))
    problems.push(`table line ${problem.line}: ${problem.reason}: ${problem.text}`)
  for (const heading of emptyHeadings(markdown)) problems.push(`empty heading: ${heading}`)
  problems.push(...detailsProblems(markdown))
  for (const token of BAD_TOKENS) if (token.test(markdown)) problems.push(`contains ${token}`)
  if (ABSOLUTE_PATH.test(markdown)) problems.push('contains an absolute path')
  if (!markdown.endsWith('\n') || markdown.endsWith('\n\n')) problems.push('does not end with exactly one newline')
  if (/\n{3,}/.test(markdown)) problems.push('contains more than one consecutive blank line')
  if (/[ \t]+$/m.test(markdown)) problems.push('contains trailing whitespace')
  // biome-ignore lint/suspicious/noControlCharactersInRegex: detecting control characters is the point
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(markdown)) problems.push('contains control characters')
  return problems
}

/** Every string that is not an enum gets Markdown, HTML, table and terminal syntax appended. */
const HOSTILE = ' |a`b` \n# H <b>&amp;x ` \\| --> $m$ _u_ *s* [l](http://e) \u001b[31m\u202e 1. x #'
const ENUM_KEYS = new Set(['kind', 'category', 'confidence', 'method', 'severity', 'type', 'ecosystem', 'status'])

export function hostile<T>(value: T, key = ''): T {
  if (typeof value === 'string') return (ENUM_KEYS.has(key) ? value : value + HOSTILE) as T
  if (Array.isArray(value)) return value.map((item) => hostile(item, key)) as T
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = hostile(v, k)
    return out as T
  }
  return value
}

/** The text outside inline code spans (CommonMark: a run of N backticks closes at the next run of exactly N). */
export function withoutCodeSpans(markdown: string): string {
  let out = ''
  let i = 0
  while (i < markdown.length) {
    if (markdown[i] !== '`' || markdown[i - 1] === '\\') {
      out += markdown[i]
      i++
      continue
    }
    let n = 0
    while (markdown[i + n] === '`') n++
    const fence = '`'.repeat(n)
    let close = markdown.indexOf(fence, i + n)
    while (close !== -1 && markdown[close + n] === '`') close = markdown.indexOf(fence, close + n + 1)
    if (close === -1) {
      out += fence
      i += n
    } else i = close + n
  }
  return out
}
