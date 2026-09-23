import type { Confidence, Diagnostic, DoctorSummary, Severity } from '../../types.ts'
import { formatNumber, plural, safeText } from '../shared/text.ts'
import type { RenderOptions, Style } from '../style.ts'
import {
  append,
  charCount,
  fitLine,
  hanging,
  joinFit,
  type Line,
  lineWidth,
  type Paint,
  paintLine,
  type Span,
  spaces,
  span,
  trimEnd,
} from './text.ts'

export interface RenderContext {
  readonly s: Style
  readonly width: number
  readonly verbose: boolean
  readonly quiet: boolean
  readonly unicode: boolean
  /** The path argument RepoLens was run with, for commands that refer back to it ("repolens doctor ../api"). */
  readonly commandPath: string | undefined
}

export function makeContext(options: RenderOptions): RenderContext {
  const width = Number.isFinite(options.width) && options.width > 0 ? Math.floor(options.width) : 100
  const { commandPath } = options
  return {
    s: options.style,
    width: Math.max(24, width),
    verbose: options.verbose,
    quiet: options.quiet,
    unicode: options.style.unicode,
    commandPath: commandPath !== undefined && commandPath.trim() !== '' ? commandPath : undefined,
  }
}

/** Blocks are separated by one blank line; every line is cut to the terminal width. */
export function renderBlocks(blocks: ReadonlyArray<ReadonlyArray<Line>>, ctx: RenderContext): string {
  const text = blocks
    .filter((block) => block.length > 0)
    .map((block) => block.map((line) => paintLine(trimEnd(fitLine(line, ctx.width, ctx.unicode)))).join('\n'))
    .join('\n\n')
  return text === '' ? '' : `${text}\n`
}

/** "RepoLens · acme-api" */
export function heading(label: string, name: string, ctx: RenderContext): Line {
  const { s } = ctx
  return [span(label, s.bold), spaces(1), span(s.symbols.dot, s.dim), spaces(1), span(name)]
}

export function severitySpan(severity: Severity, s: Style): Span {
  switch (severity) {
    case 'error':
      return span(s.symbols.fail, s.red)
    case 'warning':
      return span(s.symbols.warn, s.yellow)
    default:
      return span(s.symbols.info, s.blue)
  }
}

export function passSpan(s: Style): Span {
  return span(s.symbols.pass, s.green)
}

/** Status of a group: the worst severity, or passed. */
export function statusSpan(severity: Severity | null, s: Style): Span {
  return severity ? severitySpan(severity, s) : passSpan(s)
}

export function ellipsis(ctx: RenderContext): string {
  return ctx.unicode ? '…' : '...'
}

/** Dim "… 8 more (use --verbose)" line. */
export function moreLine(hidden: number, hint: string | null, ctx: RenderContext, indent = 2): Line {
  const suffix = hint ? ` (${hint})` : ''
  return [spaces(indent), span(`${ellipsis(ctx)} ${formatNumber(hidden)} more${suffix}`, ctx.s.dim)]
}

/** "+3 more", used when a list is cut to fit a line. */
export function moreMarker(ctx: RenderContext): (hidden: number) => Line {
  return (hidden) => [span(`+${formatNumber(hidden)} more`, ctx.s.dim)]
}

/** Items joined by ", " that fit in `max` columns. */
export function commaList(items: readonly string[], max: number, ctx: RenderContext, paint?: Paint): Line {
  return joinFit(
    items.map((item) => [span(item, paint)]),
    [span(', ', paint)],
    max,
    moreMarker(ctx),
    ctx.unicode,
  )
}

/** Items joined by a dim " · " that fit in `max` columns. */
export function dotList(items: ReadonlyArray<string | Line>, max: number, ctx: RenderContext): Line {
  return joinFit(
    items.map((item) => (typeof item === 'string' ? [span(item)] : item)),
    [spaces(1), span(ctx.s.symbols.dot, ctx.s.dim), spaces(1)],
    max,
    moreMarker(ctx),
    ctx.unicode,
  )
}

/**
 * Lay items out left to right, starting a new line when the next item does
 * not fit. Continuation lines are indented to `indent`.
 */
export function flow(items: readonly Line[], separator: Line, first: Line, indent: number, width: number): Line[] {
  const lines: Line[] = []
  let current: Line = [...first]
  let empty = true
  for (const item of items) {
    const candidate = empty ? item : [...separator, ...item]
    if (!empty && lineWidth(current) + lineWidth(candidate) > width) {
      lines.push(current)
      current = [spaces(indent), ...item]
    } else current.push(...candidate)
    empty = false
  }
  lines.push(current)
  return lines
}

/** Dim "medium confidence" tag for verbose output; nothing for high confidence. */
export function confidenceTag(confidence: Confidence, ctx: RenderContext): Line {
  return confidence === 'high' ? [] : [span(`${confidence} confidence`, ctx.s.dim)]
}

/** Append a tag after a value, keeping two spaces between them. */
export function withTag(value: Line, tag: Line): Line {
  return tag.length === 0 ? value : [...value, spaces(2), ...tag]
}

/** Dim evidence lines for verbose output. */
export function evidenceLines(evidence: readonly string[], ctx: RenderContext, prefix = ''): Line[] {
  return evidence.map((item) => [span(`${prefix}${safeText(item)}`, ctx.s.dim)])
}

export interface KeyValueRow {
  label: string | Line
  /** Builds the value given the columns available for it. */
  value: (max: number) => Line
  /** Extra lines aligned under the value (evidence, sources, …). */
  extra?: Line[]
}

export interface KeyValueOptions {
  indent?: number
  /** Minimum label column width, so consecutive sections line up. */
  minLabel?: number
  maxLabel?: number
  /** Wrap single-span values under the value column instead of cutting them at the width. */
  wrap?: boolean
}

/** Shared first-column width so sections line up ("Package manager" is the longest common label). */
export const LABEL_WIDTH = 15

/** Two-column rows: a padded label and a value that gets the rest of the line. */
export function keyValue(rows: readonly KeyValueRow[], ctx: RenderContext, options: KeyValueOptions = {}): Line[] {
  const indent = options.indent ?? 2
  const labels = rows.map((row) => (typeof row.label === 'string' ? [span(row.label)] : row.label))
  const natural = labels.reduce((most, label) => Math.max(most, lineWidth(label)), options.minLabel ?? LABEL_WIDTH)
  const maxLabel = Math.min(options.maxLabel ?? 32, Math.max(8, Math.floor((ctx.width - indent) / 2)))
  const labelWidth = Math.min(natural, maxLabel)
  const column = indent + labelWidth + 2
  const max = Math.max(8, ctx.width - column)
  const lines: Line[] = []
  const withValue = (prefix: Line, value: Line) => {
    const only = value.length === 1 ? value[0] : undefined
    if (options.wrap && only && lineWidth(value) > max) append(lines, hanging(prefix, only.text, only.paint, ctx.width))
    else lines.push([...prefix, ...value])
  }
  rows.forEach((row, index) => {
    const label = labels[index] ?? []
    if (lineWidth(label) > labelWidth) {
      // A long label (a command, a path) keeps its own line rather than being cut.
      lines.push([spaces(indent), ...label])
      const value = row.value(max)
      if (value.length > 0) withValue([spaces(column)], value)
    } else {
      withValue([spaces(indent), ...label, spaces(column - indent - lineWidth(label))], row.value(max))
    }
    for (const extra of row.extra ?? []) {
      // Single-span lines (evidence, sources) wrap; composed lines are cut at the width.
      const only = extra.length === 1 ? extra[0] : undefined
      if (only) append(lines, hanging([spaces(column)], only.text, only.paint, ctx.width))
      else lines.push([spaces(column), ...extra])
    }
  })
  return lines
}

/**
 * Items for a summary line, in the order every summary uses: "✗ 1 error",
 * "⚠ 2 warnings", "ℹ 1 info", "✓ 18 checks passed".
 */
export function summaryItems(
  summary: DoctorSummary,
  ctx: RenderContext,
  options: { passedLabel: (count: number) => string; skipped: boolean },
): Line[] {
  const { s } = ctx
  const items: Line[] = []
  if (summary.errors > 0) items.push([severitySpan('error', s), span(` ${plural(summary.errors, 'error')}`)])
  if (summary.warnings > 0) items.push([severitySpan('warning', s), span(` ${plural(summary.warnings, 'warning')}`)])
  if (summary.infos > 0) items.push([severitySpan('info', s), span(` ${plural(summary.infos, 'info', 'info')}`)])
  if (summary.passed > 0) items.push([passSpan(s), span(` ${options.passedLabel(summary.passed)}`)])
  if (options.skipped && summary.skipped > 0) items.push([span(`${formatNumber(summary.skipped)} skipped`, s.dim)])
  return items
}

/** Columns a message needs beside its code; with less, it moves below the code. */
const MIN_MESSAGE_ROOM = 20

export interface DiagnosticExtra {
  /** Shown before the first line of the text, e.g. a dim arrow. */
  marker?: Line
  text: string
  paint?: Paint
}

/**
 * "⚠ CODE  message" with the message wrapped beside the code, and extra lines
 * (hint, files) aligned under the message. In a narrow terminal the message
 * goes on the next lines instead, so it is wrapped rather than cut.
 */
export function diagnosticLines(
  diagnostic: Diagnostic,
  codeWidth: number,
  indent: number,
  ctx: RenderContext,
  extras: readonly DiagnosticExtra[] = [],
): Line[] {
  const marker: Line = [spaces(indent), severitySpan(diagnostic.severity, ctx.s), spaces(1)]
  const inline: Line = [...marker, ...padCell(diagnostic.code, codeWidth, ctx), spaces(2)]
  const stacked = ctx.width - lineWidth(inline) < MIN_MESSAGE_ROOM
  const column = stacked ? indent + 2 : lineWidth(inline)
  const lines: Line[] = stacked
    ? [
        [...marker, span(diagnostic.code)],
        ...hanging([spaces(column)], safeText(diagnostic.message), undefined, ctx.width),
      ]
    : hanging(inline, safeText(diagnostic.message), undefined, ctx.width)
  for (const extra of extras) {
    append(lines, hanging([spaces(column), ...(extra.marker ?? [])], extra.text, extra.paint, ctx.width))
  }
  return lines
}

/** Pad plain text to a column, cutting it when longer. */
export function padCell(text: string, width: number, ctx: RenderContext, paint?: Paint): Line {
  const cell = fitLine([span(text, paint)], width, ctx.unicode)
  return [...cell, spaces(width - lineWidth(cell))]
}

export function longest(texts: readonly string[], cap: number): number {
  return Math.min(
    cap,
    texts.reduce((most, text) => Math.max(most, charCount(text)), 0),
  )
}
