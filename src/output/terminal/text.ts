/**
 * Layout primitives for the terminal renderer.
 *
 * A line is a list of spans: plain text plus an optional paint function.
 * Widths are measured and truncated on the plain text and ANSI codes are only
 * added when the line is printed, so colors never change the layout.
 */
import { cleanUntrusted } from '../../utils/text.ts'

export type Paint = (text: string) => string

export interface Span {
  readonly text: string
  readonly paint?: Paint | undefined
}

export type Line = Span[]

// Repository content is untrusted. Line breaks become spaces here; control
// characters (ANSI escapes could rewrite the terminal) and invisible, bidi or
// tag characters (they could disguise what is printed) are removed by
// cleanUntrusted, the same rule every output format uses.
const BREAKS = /[\t\n\r\v\f\u2028\u2029]/

/** Make text safe to print on one terminal line. */
export function clean(text: string): string {
  let out = text
  if (BREAKS.test(out)) {
    const pieces = out.split(BREAKS)
    const last = pieces.length - 1
    out = pieces
      .map((piece, index) => (index === 0 ? piece.trimEnd() : index === last ? piece.trimStart() : piece.trim()))
      .filter((piece) => piece !== '')
      .join(' ')
  }
  return cleanUntrusted(out)
}

/** Display width, assuming single-width characters (same rule as `visibleLength`). */
export function charCount(text: string): number {
  let count = 0
  for (const _ of text) count++
  return count
}

export function span(text: string, paint?: Paint): Span {
  return { text: clean(text), paint }
}

export function spaces(count: number): Span {
  return { text: ' '.repeat(Math.max(0, count)) }
}

export function lineWidth(line: readonly Span[]): number {
  let width = 0
  for (const part of line) width += charCount(part.text)
  return width
}

/** Cut a line to `max` columns, ending with an ellipsis in the style of the span that was cut. */
export function fitLine(line: Line, max: number, unicode: boolean): Line {
  if (lineWidth(line) <= max) return line
  const ellipsis = (unicode ? '…' : '...').slice(0, Math.max(0, max))
  const budget = Math.max(0, max - ellipsis.length)
  const out: Line = []
  let used = 0
  for (const part of line) {
    const chars = [...part.text]
    if (used + chars.length <= budget) {
      out.push(part)
      used += chars.length
      continue
    }
    out.push({ text: chars.slice(0, budget - used).join('') + ellipsis, paint: part.paint })
    break
  }
  return out
}

/** Remove trailing whitespace so padded columns never leave spaces at the end of a line. */
export function trimEnd(line: Line): Line {
  const out = [...line]
  while (out.length > 0) {
    const last = out[out.length - 1] as Span
    const trimmed = last.text.trimEnd()
    if (trimmed === last.text) break
    out.pop()
    if (trimmed !== '') {
      out.push({ text: trimmed, paint: last.paint })
      break
    }
  }
  return out
}

/** Apply styles and join. */
export function paintLine(line: readonly Span[]): string {
  let out = ''
  for (const part of line) {
    if (part.text === '') continue
    out += part.paint ? part.paint(part.text) : part.text
  }
  return out
}

/**
 * Push items one by one. `target.push(...items)` passes every item as a call
 * argument and overflows the stack on very large lists (a verbose listing of
 * a huge repository).
 */
export function append<T>(target: T[], items: readonly T[]): T[] {
  for (const item of items) target.push(item)
  return target
}

/** Join lines of spans with a separator. */
export function joinLines(items: readonly Line[], separator: readonly Span[]): Line {
  const out: Line = []
  items.forEach((item, index) => {
    if (index > 0) out.push(...separator)
    out.push(...item)
  })
  return out
}

/**
 * Join as many items as fit in `max` columns, followed by a "+N more" marker
 * for the rest. Items are never cut in the middle unless not even one fits.
 */
export function joinFit(
  items: readonly Line[],
  separator: readonly Span[],
  max: number,
  more: (hidden: number) => Line,
  unicode: boolean,
): Line {
  const all = joinLines(items, separator)
  if (lineWidth(all) <= max) return all
  const separatorWidth = lineWidth(separator)
  let best = 0
  let used = 0
  for (let count = 1; count < items.length; count++) {
    used += (count > 1 ? separatorWidth : 0) + lineWidth(items[count - 1] as Line)
    const suffix = separatorWidth + lineWidth(more(items.length - count))
    if (used + suffix > max) break
    best = count
  }
  if (best === 0) return fitLine(all, max, unicode)
  return [...joinLines(items.slice(0, best), separator), ...separator, ...more(items.length - best)]
}

/**
 * Words of a text, keeping a backtick code span (`corepack use npm@latest`)
 * together: a command broken across lines can't be copied.
 */
function unbreakableWords(text: string): string[] {
  const words: string[] = []
  let current = ''
  let fence = ''
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string
    if (char === '`') {
      let run = 1
      while (text[i + run] === '`') run++
      const ticks = '`'.repeat(run)
      // A run of backticks opens a span only when the same run closes it later.
      if (fence === '') fence = text.indexOf(ticks, i + run) === -1 ? '' : ticks
      else if (ticks === fence) fence = ''
      current += ticks
      i += run - 1
    } else if (char === ' ' && fence === '') {
      if (current !== '') words.push(current)
      current = ''
    } else current += char
  }
  if (current !== '') words.push(current)
  return words
}

/** Word-wrap plain text to `max` columns. Words (and code spans) longer than a line are split. */
export function wrap(text: string, max: number): string[] {
  const words = unbreakableWords(text)
  if (max < 1) return [words.join(' ')]
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const chars = [...word]
    let start = 0
    if (chars.length > max) {
      if (current !== '') lines.push(current)
      current = ''
      for (; chars.length - start > max; start += max) lines.push(chars.slice(start, start + max).join(''))
    }
    if (start === chars.length) continue
    const piece = start === 0 ? word : chars.slice(start).join('')
    if (current === '') current = piece
    else if (charCount(current) + 1 + (chars.length - start) <= max) current += ` ${piece}`
    else {
      lines.push(current)
      current = piece
    }
  }
  if (current !== '' || lines.length === 0) lines.push(current)
  return lines
}

/**
 * A prefix followed by wrapped text; continuation lines are indented to the
 * column where the text started.
 */
export function hanging(prefix: Line, text: string, paint: Paint | undefined, width: number): Line[] {
  const start = lineWidth(prefix)
  const parts = wrap(clean(text), Math.max(12, width - start))
  return parts.map((part, index) => [...(index === 0 ? prefix : [spaces(start)]), span(part, paint)])
}

export type Cell = string | Span | Line

export interface TableOptions {
  width: number
  unicode: boolean
  /** Spaces before the first column (default 2). */
  indent?: number
  /** Spaces after each column but the last (default 2). A list sets it per column. */
  gap?: number | ReadonlyArray<number>
  /** Maximum width per column. The last column always takes the remaining space. */
  max?: ReadonlyArray<number | undefined>
  /** Minimum width per column; columns are never shrunk below it. */
  min?: ReadonlyArray<number | undefined>
  align?: ReadonlyArray<'left' | 'center' | undefined>
  /** Columns the last column is guaranteed before other columns stop shrinking (default 12). */
  minLast?: number
}

export interface Table {
  lines: Line[]
  /** Start column of each column, for aligning extra lines (evidence, notes) under a column. */
  offsets: number[]
}

function toLine(cell: Cell | undefined): Line {
  if (cell === undefined || cell === '') return []
  if (typeof cell === 'string') return [span(cell)]
  return Array.isArray(cell) ? cell : [cell as Span]
}

const SHRINK_FLOOR = 8

/** Align rows into columns. Cells are truncated to their column; the last column is cut at `width`. */
export function table(rows: ReadonlyArray<ReadonlyArray<Cell>>, options: TableOptions): Table {
  const indent = options.indent ?? 2
  const gapOf = (column: number) => (typeof options.gap === 'number' ? options.gap : (options.gap?.[column] ?? 2))
  const cells = rows.map((row) => row.map(toLine))
  const columns = cells.reduce((most, row) => Math.max(most, row.length), 0)

  const widths: number[] = []
  for (let column = 0; column < columns - 1; column++) {
    let natural = options.min?.[column] ?? 0
    for (const row of cells) natural = Math.max(natural, lineWidth(row[column] ?? []))
    widths.push(Math.min(natural, options.max?.[column] ?? Number.POSITIVE_INFINITY))
  }

  // Give columns back to the terminal width: shrink the widest column first.
  const gaps = widths.reduce((total, width, column) => total + (width > 0 ? gapOf(column) : 0), 0)
  const budget = options.width - indent - gaps - (options.minLast ?? 12)
  let total = widths.reduce((sum, width) => sum + width, 0)
  while (total > budget) {
    let widest = -1
    widths.forEach((width, column) => {
      const floor = Math.min(width, options.min?.[column] ?? SHRINK_FLOOR)
      if (width > floor && (widest === -1 || width > (widths[widest] as number))) widest = column
    })
    if (widest === -1) break
    widths[widest] = (widths[widest] as number) - 1
    total--
  }

  const offsets: number[] = [indent]
  widths.forEach((width, column) => {
    offsets.push((offsets[column] as number) + (width > 0 ? width + gapOf(column) : 0))
  })

  const lines = cells.map((row) => {
    const out: Line = indent > 0 ? [spaces(indent)] : []
    for (let column = 0; column < columns; column++) {
      const cell = row[column] ?? []
      const width = widths[column]
      if (width === undefined) {
        out.push(...cell)
        continue
      }
      if (width === 0) continue
      const fitted = fitLine(cell, width, options.unicode)
      const used = lineWidth(fitted)
      const left = options.align?.[column] === 'center' ? Math.floor((width - used) / 2) : 0
      if (left > 0) out.push(spaces(left))
      out.push(...fitted, spaces(width - used - left + gapOf(column)))
    }
    return trimEnd(fitLine(out, options.width, options.unicode))
  })

  return { lines, offsets }
}
