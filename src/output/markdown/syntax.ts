/**
 * GitHub-flavored Markdown building blocks.
 *
 * Everything that comes from the scanned repository is untrusted: it goes
 * through `text` (prose) or `code` (identifiers, paths, commands) so committed
 * content can't inject headings, links, HTML, math or table cells, and can't
 * smuggle terminal escape sequences into output that is often printed to a TTY.
 */
import { cleanUntrusted } from '../../utils/text.ts'

/** Placeholder for an empty table cell: the en dash every output uses for "nothing here". */
export const EMPTY_CELL = '–'

/**
 * One line of text: line breaks become spaces; control, bidi ("Trojan
 * Source"), zero-width and Unicode tag characters are removed. The files are
 * read by AI agents, and invisible tag characters could smuggle instructions
 * into them.
 */
export function oneLine(value: string): string {
  return cleanUntrusted(value, { oneLine: true })
}

/** `<` opens HTML and autolinks; `>` only matters at the start of a line (blockquote). */
const INLINE_SPECIAL = new Set(['\\', '`', '*', '[', ']', '<', '~', '$'])
const WORD_CHAR = /[\p{L}\p{N}]/u

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && WORD_CHAR.test(char)
}

function escapeInline(input: string, lineStart: boolean): string {
  let out = ''
  for (let i = 0; i < input.length; i++) {
    const char = input[i] as string
    if (INLINE_SPECIAL.has(char)) out += `\\${char}`
    else if (char === '_' && !(isWordChar(input[i - 1]) && isWordChar(input[i + 1]))) out += '\\_'
    else if (char === '&' && /^&#?[A-Za-z0-9]+;/.test(input.slice(i))) out += '&amp;'
    else out += char
  }
  // Block markers only count at the start of a line and when followed by a space
  // ("# x", "- x", "1. x") or when the line is a rule ("---", "==="), so
  // "1.2.3" or "-rc" stay readable. A leading ">" always starts a blockquote.
  if (!lineStart) return out
  if (/^(?:#{1,6}|[+-]|\d{1,9}[.)])(?:\s|$)/.test(out) || /^[-=][-=\s]*$/.test(out) || out.startsWith('>')) {
    return out.replace(/^(\d{1,9})([.)])/, '$1\\$2').replace(/^([#+=>-])/, '\\$1')
  }
  return out
}

/**
 * Escape prose so it renders literally. Underscores inside words
 * (STRIPE_SECRET_KEY) are left alone because GFM never treats them as
 * emphasis, which keeps the raw Markdown readable for agents.
 */
export function text(value: string): string {
  return escapeInline(oneLine(value).replace(/\s+/g, ' '), true)
}

/**
 * `text` for the content of an ATX heading: a trailing run of "#" after a
 * space would be read as the optional closing sequence and disappear.
 */
export function headingText(value: string): string {
  return text(value).replace(/(^|\s)(#+)$/, '$1\\$2')
}

/** Like `text`, for values placed after other content on a line or in a table cell, where block markers are inert. */
export function inline(value: string): string {
  return escapeInline(oneLine(value).replace(/\s+/g, ' '), false)
}

/**
 * Prose that may contain `code spans` (diagnostic hints written by RepoLens):
 * spans are kept as code, everything else is escaped.
 */
export function prose(value: string): string {
  const input = oneLine(value).replace(/\s+/g, ' ')
  let out = ''
  let last = 0
  for (const match of input.matchAll(/(`+)(.+?)\1(?!`)/g)) {
    const index = match.index ?? 0
    out += escapeInline(input.slice(last, index), last === 0)
    out += code(match[2] ?? '')
    last = index + match[0].length
  }
  return out + escapeInline(input.slice(last), last === 0)
}

/** Escaped prose in which every occurrence of `literal` (a file path, a name) is a code span. */
export function textWith(value: string, literal: string): string {
  const input = oneLine(value).replace(/\s+/g, ' ')
  const needle = oneLine(literal)
  if (needle === '' || !input.includes(needle)) return text(input)
  return input
    .split(needle)
    .map((piece, index) => escapeInline(piece, index === 0))
    .join(code(needle))
}

/** Inline code span that survives backticks in the value. */
export function code(value: string): string {
  const input = oneLine(value)
  if (input === '') return EMPTY_CELL
  let longest = 0
  for (const run of input.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  const fence = '`'.repeat(longest + 1)
  const pad = input.startsWith('`') || input.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${input}${pad}${fence}`
}

/** Values joined by ", ", each as a code span. */
export function codeList(values: readonly string[]): string {
  return values.map(code).join(', ')
}

/** Escape text for use inside an HTML element such as `<summary>`. */
export function html(value: string): string {
  return oneLine(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Make a cell safe for a GFM table: pipes are escaped (GFM requires this even
 * inside code spans) so every row keeps its column count. A pipe that is
 * already preceded by an odd number of backslashes is escaped as it is.
 */
export function cell(value: string): string {
  const input = oneLine(value)
  if (input === '') return EMPTY_CELL
  return input.replace(/(\\*)\|/g, (_match, slashes: string) =>
    slashes.length % 2 === 1 ? `${slashes}|` : `${slashes}\\|`,
  )
}

export type Align = 'left' | 'right'

/** GFM table. Rows are padded or cut to the header's column count. */
export function table(header: readonly string[], rows: ReadonlyArray<readonly string[]>, align: readonly Align[] = []) {
  const width = header.length
  const line = (cells: readonly string[]) =>
    `| ${Array.from({ length: width }, (_, i) => cell(cells[i] ?? '')).join(' | ')} |`
  const delimiter = `| ${header.map((_, i) => (align[i] === 'right' ? '---:' : '---')).join(' | ')} |`
  return [line(header), delimiter, ...rows.map(line)].join('\n')
}

/** Bullet list; continuation lines of an item are indented under it. */
export function bullets(items: readonly string[]): string {
  return items.map((item) => `- ${item.split('\n').join('\n  ')}`).join('\n')
}

/** Numbered list. */
export function numbered(items: readonly string[]): string {
  return items
    .map((item, index) => {
      const marker = `${index + 1}. `
      return `${marker}${item.split('\n').join(`\n${' '.repeat(marker.length)}`)}`
    })
    .join('\n')
}

/** Collapsible block. GitHub needs the blank lines around the body to render Markdown inside it. */
export function details(summary: string, body: string): string {
  return `<details>\n<summary>${html(summary)}</summary>\n\n${body}\n\n</details>`
}

export type Block = string | null | undefined | false

/** Non-empty blocks separated by blank lines. */
export function blocks(...items: readonly Block[]): string {
  return items.filter((item): item is string => typeof item === 'string' && item.trim() !== '').join('\n\n')
}

/** A heading followed by its content, or null when there is no content (empty sections are omitted). */
export function section(title: string, level: number, ...content: readonly Block[]): string | null {
  const body = blocks(...content)
  if (body === '') return null
  return `${'#'.repeat(level)} ${title}\n\n${body}`
}

/** Final document: blocks separated by blank lines, ending with exactly one newline. */
export function document(...items: readonly Block[]): string {
  return `${blocks(...items)}\n`
}
