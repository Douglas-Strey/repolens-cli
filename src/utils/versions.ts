const PLAIN_VERSION = /^[\^~=v]*\s*(\d+(?:\.\d+){0,2}(?:[-+][0-9A-Za-z.-]+)?)$/
const NON_VERSION_PROTOCOL = /^(?:workspace|catalog|file|link|portal|patch|git|git\+[a-z]+|github|http|https|npm|jsr):/
/** Characters a semver range can contain. Anything else (URLs, paths, `@`, quotes) is not a displayable version. */
const RANGE_CHARACTERS = /^[0-9A-Za-z.\s<>=^~|*+-]+$/
const MAX_RANGE_LENGTH = 100

/**
 * Turn a dependency range into something readable for display.
 *
 *   "^4.1.2"      → "4.1.2"
 *   "v1.11.0"     → "1.11.0"   (Go)
 *   ">=18 <23"    → ">=18 <23" (complex ranges are kept as written)
 *   "workspace:*" → undefined
 *   "latest"      → undefined
 *
 * Values that are not version ranges (URLs, paths, tarballs, anything over
 * 100 characters) return undefined, so committed text that happens to sit
 * in a version field is never echoed.
 */
export function cleanVersion(range: string | undefined): string | undefined {
  if (!range) return undefined
  let value = range.trim()
  const alias = /^npm:(?:@[^/]+\/)?[^@]+@(.+)$/.exec(value)
  if (alias?.[1]) value = alias[1].trim()
  if (value === '' || value === '*' || value === 'x' || NON_VERSION_PROTOCOL.test(value)) return undefined
  if (/^[a-z]/i.test(value) && !/^v\d/.test(value)) return undefined // dist-tags such as "latest", "next"
  const plain = PLAIN_VERSION.exec(value)
  if (plain?.[1]) return plain[1]
  if (value.length > MAX_RANGE_LENGTH || !RANGE_CHARACTERS.test(value) || !/\d/.test(value)) return undefined
  return value
}

/** Leading major version number of a version or range ("^22.1.0" → 22, ">=1.25" → 1). */
export function majorOf(version: string | undefined | null): number | null {
  if (!version) return null
  const match = /(\d+)/.exec(version)
  return match?.[1] ? Number(match[1]) : null
}
