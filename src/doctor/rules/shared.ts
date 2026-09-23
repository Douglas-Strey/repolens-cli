/**
 * Helpers shared by doctor rules.
 *
 * Gating principle: `applies(scan, ctx)` returns false when the rule has
 * nothing to check, so the check is reported as skipped rather than passed:
 * its input files are absent from the file index (synchronous), or failed to
 * parse (a "parse" warning recorded while detectors read them), or the
 * sections prove it irrelevant. Sections alone never make a rule skip when
 * a failed detector's empty fallback could look the same; the check itself
 * re-verifies with the file index and cached reads.
 */
import type { ProjectContext } from '../../types.ts'
import { compareText } from '../../utils/compare.ts'
import { cleanUntrusted } from '../../utils/text.ts'

/** "a", "a and b", "a, b and c" (or "a, b or c"). */
export function formatList(items: readonly string[], conjunction: 'and' | 'or' = 'and'): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} ${conjunction} ${items[items.length - 1]}`
}

/** Like formatList, but names at most `max` items: "a, b, c and 7 more". */
export function formatLimitedList(items: readonly string[], max = 8): string {
  if (items.length <= max) return formatList(items)
  return formatList([...items.slice(0, max), `${items.length - max} more`])
}

/** "1 file", "2 files". */
export function countOf(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

/** Sorted, de-duplicated copy. */
export function uniqueSorted(items: Iterable<string>): string[] {
  return [...new Set(items)].sort(compareText)
}

/** De-duplicate while keeping the first occurrence order. */
export function unique(items: Iterable<string>): string[] {
  return [...new Set(items)]
}

/**
 * Make text taken from a repository file (workspace patterns, env_file paths,
 * version ranges) safe to embed in a message: control, bidi and invisible
 * characters are removed, line breaks become spaces, and the length is capped.
 */
export function safeText(text: string, max = 120): string {
  const cleaned = cleanUntrusted(text, { oneLine: true })
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned
}

/** Did reading one of these files record a parse warning (so a check that needs it has no input)? */
export function parseFailed(ctx: Pick<ProjectContext, 'warnings'>, ...files: string[]): boolean {
  return ctx.warnings.some(
    (warning) => warning.kind === 'parse' && warning.file !== undefined && files.includes(warning.file),
  )
}

/** A root package.json exists and could be parsed. */
export function hasRootPackageJson(ctx: Pick<ProjectContext, 'files' | 'warnings'>): boolean {
  return ctx.files.has('package.json') && !parseFailed(ctx, 'package.json')
}

/** True when the path is at the project root (no directory part). */
export function isRootPath(path: string): boolean {
  return !path.includes('/')
}
