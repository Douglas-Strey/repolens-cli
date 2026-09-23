/**
 * Plain-text helpers shared by every renderer: the terminal, the Markdown
 * report and the agent files. They return plain strings; escaping for a
 * format stays in terminal/text.ts and markdown/syntax.ts.
 */
import { CREDENTIAL_PATTERNS, REDACTED, redactCommand } from '../../utils/redact.ts'
import { cleanUntrusted } from '../../utils/text.ts'

/** Thousands separators without depending on the machine's locale. */
export function formatNumber(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${formatNumber(count)} ${count === 1 ? singular : pluralForm}`
}

/** Rounded percentage; shares that round to zero show as "<1%". */
export function formatShare(share: number): string {
  const percent = Math.round(share * 100)
  if (percent === 0 && share > 0) return '<1%'
  return `${percent}%`
}

/** "a", "a and b", "a, b and c". */
export function joinWords(items: readonly string[], conjunction = 'and'): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} ${conjunction} ${items[items.length - 1]}`
}

/** Ends a sentence with a period unless it already ends with punctuation (including a truncation "…"). */
export function sentence(value: string): string {
  const trimmed = value.trim()
  return trimmed === '' || /[.!?:…]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

/**
 * At most `max` characters, cut at a word boundary when one is close, with
 * "…" appended. Keeps free text from manifests (a description can be up to
 * the read limit) from swamping output meant to be skimmed.
 */
export function truncate(value: string, max: number): string {
  const trimmed = value.trim()
  if (trimmed.length <= max) return trimmed
  const cut = trimmed.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/**
 * Committed text echoed back (commands, versions, images, URLs) with likely
 * secrets masked. Cleaning comes first: a credential split by a control or
 * zero-width character would otherwise dodge the patterns and then be joined
 * back together when the output is cleaned for printing.
 */
export function safeText(text: string): string {
  return redactCommand(cleanUntrusted(text))
}

/** "name 1.2.3", or just the name. */
export function nameWithVersion(name: string, version?: string | null): string {
  return version ? `${name} ${safeText(version)}` : name
}

const CREDENTIALS = CREDENTIAL_PATTERNS.map(({ pattern }) => new RegExp(pattern.source, 'g'))

/**
 * RepoLens's own sentences (diagnostic hints) that quote repository names.
 * They never hold values, so shell-style redaction would only mangle them:
 * "Add API_KEY=, PORT= to .env.example" is advice, not an assignment.
 * Well-known credential formats are still masked as a second line of defense.
 */
export function ownText(text: string): string {
  let out = cleanUntrusted(text)
  for (const pattern of CREDENTIALS) out = out.replace(pattern, REDACTED)
  return out
}

/**
 * Mask absolute paths inside free text such as parser errors or detector
 * stack traces, which can mention paths on the machine running RepoLens.
 */
export function maskAbsolutePaths(value: string): string {
  return value
    .replace(/file:\/\/\S+/g, '<path>')
    .replace(/(^|[\s'"(=:])[A-Za-z]:\\[^\s'"()]*/g, '$1<path>')
    .replace(/(^|[\s'"(=:])~?\/(?:[^\s/'"():]+\/)+[^\s'"():]*/g, '$1<path>')
}

const JSON_SNIPPET_SUFFIX = ' is not valid JSON'

/**
 * First non-empty line of a technical detail (parser message, stack trace),
 * with secrets and absolute paths masked. V8's JSON.parse errors quote the
 * file around the error (`Unexpected token 'h', ..."password": hunter2"... is
 * not valid JSON`), and that quote can hold a secret no pattern recognizes,
 * so it is dropped.
 */
export function detailLine(text: string): string {
  let line =
    cleanUntrusted(text)
      .split(/[\r\n\u2028\u2029]+/)
      .find((candidate) => candidate.trim() !== '')
      ?.trim() ?? ''
  if (line.endsWith(JSON_SNIPPET_SUFFIX)) {
    const quote = line.search(/, (?:\.\.\.)?"/)
    line = quote === -1 ? 'Not valid JSON' : `${line.slice(0, quote)} (not valid JSON)`
  }
  return maskAbsolutePaths(redactCommand(line))
}
