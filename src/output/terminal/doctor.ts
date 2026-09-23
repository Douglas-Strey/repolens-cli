import type { CheckResult, Diagnostic, ScanResult } from '../../types.ts'
import { compareText } from '../../utils/compare.ts'
import {
  configNote,
  noteWarnings,
  sortBySeverity,
  uncoveredWarnings,
  warningText,
  worstSeverity,
} from '../shared/facts.ts'
import { categoryTitle, DOCTOR_CATEGORIES } from '../shared/labels.ts'
import { detailLine, formatNumber, ownText, plural } from '../shared/text.ts'
import type { RenderOptions } from '../style.ts'
import {
  type DiagnosticExtra,
  diagnosticLines,
  flow,
  heading,
  longest,
  makeContext,
  passSpan,
  type RenderContext,
  renderBlocks,
  statusSpan,
  summaryItems,
} from './common.ts'
import { append, hanging, type Line, spaces, span } from './text.ts'

const DIAGNOSTIC_INDENT = 4

/** Known categories in their fixed order (security first), then any others alphabetically. */
export function categoryOrder(checks: readonly CheckResult[], diagnostics: readonly Diagnostic[]): string[] {
  const known = new Set<string>(DOCTOR_CATEGORIES)
  const extra = new Set<string>()
  for (const item of [...checks, ...diagnostics]) if (!known.has(item.category)) extra.add(item.category)
  return [...DOCTOR_CATEGORIES, ...[...extra].sort(compareText)]
}

function diagnosticExtras(diagnostic: Diagnostic, ctx: RenderContext): DiagnosticExtra[] {
  const { s } = ctx
  const extras: DiagnosticExtra[] = []
  if (!ctx.quiet && diagnostic.hint) {
    // Hints are RepoLens's own advice ("Add API_KEY=, PORT= to .env.example"), not echoed commands.
    extras.push({ marker: [span(`${s.symbols.arrow} `, s.dim)], text: ownText(diagnostic.hint), paint: s.dim })
  }
  if (ctx.verbose && diagnostic.files && diagnostic.files.length > 0) {
    extras.push({ text: `Files: ${diagnostic.files.join(', ')}`, paint: s.dim })
  }
  return extras
}

function categoryLines(result: ScanResult, ctx: RenderContext): Line[] {
  const { s } = ctx
  const { checks } = result.doctor
  const diagnostics = sortBySeverity(result.doctor.diagnostics)
  const codeWidth = longest(
    diagnostics.map((diagnostic) => diagnostic.code),
    32,
  )
  const lines: Line[] = []
  for (const category of categoryOrder(checks, diagnostics)) {
    const own = diagnostics.filter((diagnostic) => diagnostic.category === category)
    const categoryChecks = checks.filter((check) => check.category === category)
    const applicable = categoryChecks.filter((check) => check.status === 'passed' || check.status === 'failed')
    if (own.length === 0 && (applicable.length === 0 || ctx.quiet)) continue

    const header: Line = [
      statusSpan(worstSeverity(own.map((diagnostic) => diagnostic.severity)), s),
      spaces(1),
      span(categoryTitle(category), s.bold),
    ]
    const skipped = categoryChecks.filter((check) => check.status === 'skipped').length
    if (ctx.verbose && skipped > 0) header.push(span(`  ${formatNumber(skipped)} skipped`, s.dim))
    const disabled = categoryChecks.filter((check) => check.status === 'disabled').length
    if (ctx.verbose && disabled > 0) header.push(span(`  ${formatNumber(disabled)} turned off`, s.dim))
    lines.push(header)

    for (const diagnostic of own) {
      append(lines, diagnosticLines(diagnostic, codeWidth, DIAGNOSTIC_INDENT, ctx, diagnosticExtras(diagnostic, ctx)))
    }
    if (ctx.verbose) {
      for (const check of applicable) {
        if (check.status === 'passed') {
          lines.push([spaces(DIAGNOSTIC_INDENT), span(`${s.symbols.pass} ${check.title}`, s.dim)])
        }
      }
    }
  }
  return lines
}

function notesLines(result: ScanResult, ctx: RenderContext): Line[] {
  const { s } = ctx
  const all = noteWarnings(result.meta)
  const warnings = ctx.verbose ? all : uncoveredWarnings(all, result.doctor.diagnostics)
  if (warnings.length === 0 || ctx.quiet) return []
  if (!ctx.verbose) {
    const message = `${plural(warnings.length, 'scan warning')}; some checks may be incomplete. Run with --verbose for details.`
    return hanging([span(`${s.symbols.info} `, s.dim)], message, s.dim, ctx.width)
  }
  const lines: Line[] = [[span('Notes', s.bold)]]
  for (const warning of warnings) {
    append(
      lines,
      hanging([spaces(2), span(s.symbols.bullet, s.dim), spaces(1)], warningText(warning), undefined, ctx.width),
    )
    const detail = warning.detail ? detailLine(warning.detail) : ''
    if (detail) append(lines, hanging([spaces(4)], detail, s.dim, ctx.width))
  }
  return lines
}

function summaryLines(result: ScanResult, ctx: RenderContext): Line[] {
  const { s } = ctx
  const items = summaryItems(result.doctor.summary, ctx, {
    passedLabel: (count) => `${formatNumber(count)} passed`,
    skipped: ctx.verbose,
  })
  const label = 'Summary'
  // The ASCII dot is "-", which reads like part of the "!" and "x" symbols next to it.
  const separator: Line = ctx.unicode ? [spaces(1), span(s.symbols.dot, s.dim), spaces(1)] : [span(', ')]
  if (items.length === 0) return [[span(label, s.bold), spaces(2), span('no checks apply to this repository', s.dim)]]
  return flow(items, separator, [span(label, s.bold), spaces(2)], label.length + 2, ctx.width)
}

export function renderDoctorReport(result: ScanResult, options: RenderOptions): string {
  const ctx = makeContext(options)
  const { s } = ctx
  const blocks: Line[][] = [[heading('RepoLens Doctor', result.project.name, ctx)]]
  blocks.push(categoryLines(result, ctx))
  if (result.doctor.diagnostics.length === 0) blocks.push([[passSpan(s), span(' No problems found')]])
  blocks.push(notesLines(result, ctx))
  const summary = summaryLines(result, ctx)
  // Always shown: findings a configuration turned off must not pass for a clean result.
  const configured = configNote(result, ctx.verbose)
  if (configured) append(summary, hanging([], configured, s.dim, ctx.width))
  // A pointer for people reading the report, not for scripts that asked for a short answer.
  if (!ctx.quiet) append(summary, hanging([], 'Run with --json for machine-readable output.', s.dim, ctx.width))
  blocks.push(summary)
  return renderBlocks(blocks, ctx)
}
