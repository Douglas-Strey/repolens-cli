/**
 * Parser for `.env`-style files.
 *
 * SECURITY: this is the only place in RepoLens that sees environment variable
 * values. A value lives in a local variable just long enough to derive a few
 * non-sensitive facts (is it empty, does it point at a URL, does it look like
 * a known credential format) and is then dropped. Values are never stored,
 * returned, logged, thrown or included in error messages. Nothing in this
 * module may call `new URL()` either: its TypeError carries the input.
 */
import type { EnvEndpoint, EnvFileKind } from '../types.ts'
import { baseName } from '../utils/paths.ts'
import { findCredentialPattern } from '../utils/redact.ts'

export interface EnvFileEntry {
  /** Variable name exactly as written (dots and dashes are kept). */
  name: string
  /** 1-based line of the first definition. */
  line: number
  /** The effective (last) value is empty, `""` or `''`. */
  empty: boolean
  /** Scheme/port/locality when the effective value is URL-shaped. */
  endpoint: EnvEndpoint | null
  /** Id of a well-known credential format found in any value for this name (only with `checkCredentials`). */
  credentialPattern: string | null
  /**
   * Only present in commented-out form (`# NAME=`), read with
   * `commentedEntries`. Such an entry documents the name but sets nothing,
   * so it never has an endpoint.
   */
  commented?: true
}

export interface ParseEnvOptions {
  /**
   * Match values against well-known credential formats. Enable it for
   * documentation files only: local files are expected to hold real secrets.
   */
  checkCredentials: boolean
  /**
   * Also read commented-out assignments (`# NAME=`, `#NAME=value`) with a
   * conventional UPPER_SNAKE name. Example files use them to document
   * optional variables.
   */
  commentedEntries?: boolean
}

const ASSIGNMENT = /^(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*=[ \t]*/
/** `# NAME=value` / `#export NAME=`: only UPPER_SNAKE names, so prose such as "# see docs=…" doesn't count. */
const COMMENTED_ASSIGNMENT = /^#+[ \t]*(?:export[ \t]+)?([A-Z_][A-Z0-9_]*)[ \t]*=[ \t]*/
const QUOTES = new Set(['"', "'", '`'])
const MAX_NAME_LENGTH = 128

/** Case changes in a segment: camelCase words have few, random base64 has many. */
function caseChanges(segment: string): number {
  let changes = 0
  let previous: 'upper' | 'lower' | null = null
  for (const ch of segment) {
    const kind = ch >= 'A' && ch <= 'Z' ? 'upper' : ch >= 'a' && ch <= 'z' ? 'lower' : null
    if (kind === null) continue
    if (previous !== null && kind !== previous) changes++
    previous = kind
  }
  return changes
}

/** A separator-free run of characters that looks like encoded data rather than a word. */
function looksRandom(segment: string): boolean {
  const length = segment.length
  if (length < 16) return false
  const hasLower = /[a-z]/.test(segment)
  const hasUpper = /[A-Z]/.test(segment)
  if (/[0-9]/.test(segment) && (hasLower || length >= 24)) return true
  if (hasLower && hasUpper && (length >= 32 || caseChanges(segment) * 3 >= length)) return true
  return false
}

/**
 * Keys never come from secret material in a well-formed file, but an unquoted
 * multi-line value (a pasted private key or base64 blob) can put a line such
 * as "Qm9vN2x…=" where a key is expected. Reporting that "name" would leak part
 * of the secret, so names that look random or match a credential format are
 * dropped. Base64url data contains "-" and "_" too, so every separator-delimited
 * segment is judged on its own, and a long name must be built from words.
 */
export function isPlausibleEnvName(name: string): boolean {
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) return false
  if (findCredentialPattern(name) !== null) return false
  const segments = name.split(/[_.-]+/)
  if (segments.some(looksRandom)) return false
  // 24+ characters without separators: a long camelCase or mixed-case run is data, not a variable name.
  if (name.length >= 24 && segments.length === 1 && /[a-z]/.test(name) && /[A-Z]/.test(name)) return false
  return true
}

/** Index of the first unescaped `quote` at or after `start`, or -1. */
function closingQuote(text: string, start: number, quote: string): number {
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\\') i++
    else if (ch === quote) return i
  }
  return -1
}

/**
 * Marks the lines inside PEM blocks: every line after a "-----BEGIN " header,
 * up to and including its "-----END" line. These lines are never read as keys,
 * however the quotes around them pair up. A short base64 tail such as "Qm9v="
 * looks like an assignment, and printing its "name" would print part of the key.
 * A header with no END line marks nothing, so a truncated value can't hide the
 * rest of the file. One pass, linear.
 */
export function pemBodyLines(lines: readonly string[]): boolean[] {
  const body = new Array<boolean>(lines.length).fill(false)
  let begin = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    const at = line.lastIndexOf('-----BEGIN ')
    if (at !== -1) {
      // A new header (or a complete one-line block) supersedes an earlier header
      // that never got an END line: that one was a truncated value.
      begin = line.includes('-----END', at) || line.trimStart().startsWith('#') ? -1 : i
    } else if (begin !== -1 && line.includes('-----END')) {
      body.fill(true, begin + 1, i + 1)
      begin = -1
    }
  }
  return body
}

/** Unquoted value: an inline comment starts at a `#` that begins the value or follows whitespace. */
function unquotedValue(rest: string): string {
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '#' && (i === 0 || rest[i - 1] === ' ' || rest[i - 1] === '\t')) return rest.slice(0, i).trim()
  }
  return rest.trim()
}

/**
 * Parse a dotenv file into names plus derived facts.
 *
 * Supports comments, blank lines, `export KEY=value`, spaces around `=`,
 * single/double/backtick quotes (which may span lines, like dotenv), inline
 * comments after unquoted values, PEM blocks (their body lines are never
 * read as keys, however the quotes pair up), CRLF and a BOM.
 * Lines without `=` or with an invalid key are ignored. Duplicate keys keep
 * the first line number; `empty` and `endpoint` describe the last value (the
 * one dotenv ends up with). Entries are returned in order of first appearance.
 */
export function parseEnvFile(text: string, file: string, options: ParseEnvOptions): EnvFileEntry[] {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const lines = source.split(/\r\n|\r|\n/)
  const entries = new Map<string, EnvFileEntry>()
  // Once a search for a closing delimiter runs off the end of the file, later
  // searches for the same delimiter can't succeed either. Remembering that keeps
  // parsing linear on hostile input (thousands of unterminated quotes).
  const unterminated = new Set<string>()
  const pemBody = pemBodyLines(lines)

  let index = 0
  while (index < lines.length) {
    const lineNumber = index + 1
    const inPem = pemBody[index] === true
    const line = (lines[index] as string).trimStart()
    index++
    if (inPem || line === '') continue
    if (line.startsWith('#')) {
      if (options.commentedEntries) addCommented(entries, line, lineNumber, options)
      continue
    }
    const match = ASSIGNMENT.exec(line)
    if (!match) continue
    const name = match[1] as string
    const rest = line.slice(match[0].length)

    let value: string | null = null
    const quote = rest[0]
    if (quote !== undefined && QUOTES.has(quote)) {
      const close = closingQuote(rest, 1, quote)
      if (close !== -1) {
        value = rest.slice(1, close)
      } else if (!unterminated.has(quote)) {
        const parts = [rest.slice(1)]
        for (let next = index; next < lines.length; next++) {
          const continuation = lines[next] as string
          const end = closingQuote(continuation, 0, quote)
          if (end !== -1) {
            parts.push(continuation.slice(0, end))
            value = parts.join('\n')
            index = next + 1
            break
          }
          parts.push(continuation)
        }
        if (value === null) unterminated.add(quote)
      }
    }
    // Unquoted, or an unterminated quote, which dotenv reads as a plain value.
    // An unquoted PEM body on the following lines is skipped through `pemBody`.
    value ??= unquotedValue(rest)

    if (!isPlausibleEnvName(name)) continue
    const trimmed = value.trim()
    const empty = trimmed === ''
    const endpoint = empty ? null : parseEndpoint(trimmed, file)
    const credentialPattern = options.checkCredentials && !empty ? findCredentialPattern(value) : null

    const existing = entries.get(name)
    if (existing) {
      existing.empty = empty
      existing.endpoint = endpoint
      existing.credentialPattern ??= credentialPattern
      // A real assignment after a commented-out one: the name is set after all.
      delete existing.commented
    } else {
      entries.set(name, { name, line: lineNumber, empty, endpoint, credentialPattern })
    }
  }
  return [...entries.values()]
}

/**
 * Record a commented-out assignment. It documents the name and may still hold
 * a pasted credential, but it sets nothing: no endpoint, and an active
 * assignment of the same name takes precedence.
 */
function addCommented(entries: Map<string, EnvFileEntry>, line: string, lineNumber: number, options: ParseEnvOptions) {
  const match = COMMENTED_ASSIGNMENT.exec(line)
  const name = match?.[1]
  if (!match || !name || !isPlausibleEnvName(name)) return
  const value = unquotedValue(line.slice(match[0].length)).replace(/^(["'`])(.*)\1$/, '$2')
  const credentialPattern = options.checkCredentials && value !== '' ? findCredentialPattern(value) : null
  const existing = entries.get(name)
  if (existing) {
    existing.credentialPattern ??= credentialPattern
    return
  }
  entries.set(name, {
    name,
    line: lineNumber,
    empty: value.trim() === '',
    endpoint: null,
    credentialPattern,
    commented: true,
  })
}

/**
 * Does any value in the file (commented-out ones included) match a
 * well-known credential format? Only the answer leaves this function.
 */
export function envTextHasCredential(text: string): boolean {
  return parseEnvFile(text, '', { checkCredentials: true, commentedEntries: true }).some(
    (entry) => entry.credentialPattern !== null,
  )
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/**
 * Schemes RepoLens reports. Anything else yields no endpoint: the scheme is
 * echoed in the output, and a random password that happens to contain "://"
 * must not have its first characters printed as a "scheme".
 */
const KNOWN_SCHEMES: ReadonlySet<string> = new Set([
  'http',
  'https',
  'ws',
  'wss',
  'ftp',
  'ftps',
  'sftp',
  'ssh',
  'tcp',
  'udp',
  'tls',
  'ssl',
  'unix',
  'grpc',
  'grpcs',
  'postgres',
  'postgresql',
  'postgis',
  'pgsql',
  'cockroachdb',
  'cockroach',
  'mysql',
  'mysqlx',
  'mysql2',
  'mariadb',
  'mssql',
  'sqlserver',
  'oracle',
  'sqlite',
  'sqlite3',
  'libsql',
  'prisma',
  'prisma+postgres',
  'file',
  'mongodb',
  'mongodb+srv',
  'redis',
  'rediss',
  'redis+sentinel',
  'valkey',
  'valkeys',
  'memcached',
  'memcache',
  'amqp',
  'amqps',
  'kafka',
  'nats',
  'mqtt',
  'mqtts',
  'stomp',
  'clickhouse',
  'cassandra',
  'neo4j',
  'neo4j+s',
  'neo4j+ssc',
  'bolt',
  'bolt+s',
  'bolt+ssc',
  'couchbase',
  'couchbases',
  'couchdb',
  'elasticsearch',
  'opensearch',
  'influxdb',
  'surrealdb',
  'rethinkdb',
  'arangodb',
  's3',
  'gs',
  'smtp',
  'smtps',
  'imap',
  'imaps',
  'pop3',
  'pop3s',
  'ldap',
  'ldaps',
])

/** Schemes that may be written without "//" (e.g. Prisma's `file:./dev.db`). */
const OPAQUE_LOCAL_SCHEMES = /^(file|sqlite|sqlite3):(?!\/\/)/i
const URL_PREFIX = /^([A-Za-z][A-Za-z0-9+.-]{0,31}):\/\//
const HOST_CHARS = /^[A-Za-z0-9._~%-]*$/
const IPV6_CHARS = /^[0-9A-Fa-f:.]+(?:%[A-Za-z0-9._~-]+)?$/

/**
 * True for loopback and "all interfaces" addresses. `*.localhost` counts as
 * local because resolvers map it to loopback (RFC 6761).
 */
export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '')
  return (
    h === '' ||
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h === '0.0.0.0' ||
    h === '::1' ||
    h === '::' ||
    h === '0:0:0:0:0:0:0:1' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
  )
}

interface HostPort {
  host: string
  port: number | null
}

/** Split "host", "host:port" or "[v6]:port". Returns null when the text is not a valid authority. */
function splitHostPort(authority: string): HostPort | null {
  let host: string
  let port: string | null = null
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']')
    if (end === -1) return null
    host = authority.slice(1, end)
    const after = authority.slice(end + 1)
    if (after !== '') {
      if (!after.startsWith(':')) return null
      port = after.slice(1)
    }
    if (!IPV6_CHARS.test(host)) return null
  } else {
    const colon = authority.indexOf(':')
    if (colon !== authority.lastIndexOf(':')) return null
    host = colon === -1 ? authority : authority.slice(0, colon)
    if (colon !== -1) port = authority.slice(colon + 1)
    if (!HOST_CHARS.test(host)) return null
  }
  if (port === null || port === '') return { host, port: null }
  if (!/^\d{1,5}$/.test(port)) return null
  const number = Number(port)
  return number > 65535 ? null : { host, port: number }
}

/**
 * Reduce a URL-shaped value to scheme, explicit port and locality.
 *
 *   "postgres://u:p@localhost:5433/db" → { scheme: "postgres", port: 5433, local: true }
 *   "redis://cache:6379"               → { scheme: "redis", port: 6379, local: false }
 *   "localhost:6379"                   → { scheme: "tcp", port: 6379, local: true }
 *
 * Returns null for anything else, including values with `${…}` interpolation
 * and unknown schemes. A bare "host:port" only counts when the host is local:
 * "admin:12345" is far more likely a credential than an endpoint.
 */
export function parseEndpoint(value: string, file: string): EnvEndpoint | null {
  let text = value.trim()
  if (text === '' || text.includes('${') || /\s/.test(text)) return null
  if (/^jdbc:/i.test(text)) text = text.slice('jdbc:'.length)

  const opaque = OPAQUE_LOCAL_SCHEMES.exec(text)
  if (opaque?.[1]) return { file, scheme: opaque[1].toLowerCase(), port: null, local: true }

  const prefix = URL_PREFIX.exec(text)
  if (prefix?.[1]) {
    const scheme = prefix[1].toLowerCase()
    if (!KNOWN_SCHEMES.has(scheme)) return null
    let rest = text.slice(prefix[0].length)
    // Split at the LAST "@" anywhere, not only inside the authority: passwords
    // are often pasted unencoded ("u:12/x@db"), and cutting at the first "/"
    // would read "u:12" as host:port and report part of the password as a port.
    // An "@" in a path or query costs accuracy, never a leak.
    const at = rest.lastIndexOf('@')
    if (at !== -1) rest = rest.slice(at + 1)
    // ";" ends the authority in JDBC SQL Server URLs (host:1433;databaseName=x).
    const end = rest.search(/[/?#;]/)
    const authority = end === -1 ? rest : rest.slice(0, end)
    // Multi-host URIs (mongodb://a:27017,b:27017) are described by their first host.
    const first = authority.split(',')[0] ?? ''
    const hostPort = splitHostPort(first)
    if (!hostPort) return null
    return { file, scheme, port: hostPort.port, local: isLocalHost(hostPort.host) }
  }

  const bare = splitHostPort(text)
  if (bare && bare.host !== '' && bare.port !== null && isLocalHost(bare.host)) {
    return { file, scheme: 'tcp', port: bare.port, local: true }
  }
  return null
}

// ---------------------------------------------------------------------------
// File names
// ---------------------------------------------------------------------------

/** `.env.<suffix>` files that are code or structured data, not dotenv files. */
const NON_DOTENV_SUFFIX = /\.(?:[cm]?[jt]sx?|json[c5]?|ya?ml|toml|md|go|py|rb|swp|swo)$/i
const EXAMPLE_HINT = /example|sample|template|dist|defaults|schema/i
/** `env.example`, `env.sample`: templates some projects name without the leading dot. */
const UNDOTTED_EXAMPLE = /^env\.(?:example|sample|template|dist)$/i
/** `.env.<mode>` and `<mode>.env`: per-environment files that frameworks load and projects often commit. */
const MODE_NAMES: ReadonlySet<string> = new Set([
  'development',
  'develop',
  'dev',
  'production',
  'prod',
  'test',
  'testing',
  'ci',
  'staging',
  'stage',
  'preview',
  'qa',
  'uat',
  'e2e',
  'integration',
])

/**
 * Is this basename an env file RepoLens reads? ".env", ".env.<anything>"
 * (except code/data files such as ".env.ts"), "<x>.env", ".envrc", and
 * undotted templates ("env.example").
 */
export function isEnvFileName(name: string): boolean {
  if (name === '.env' || name === '.envrc') return true
  if (name.startsWith('.env.')) return !NON_DOTENV_SUFFIX.test(name)
  return name.endsWith('.env') || UNDOTTED_EXAMPLE.test(name)
}

function isLocalName(name: string): boolean {
  return name === '.env' || name === '.envrc' || name === 'local.env' || /^\.env(?:\..+)?\.local$/.test(name)
}

function modeOf(name: string): string | undefined {
  return (/^\.env\.([^.]+)$/.exec(name) ?? /^([^.]+)\.env$/.exec(name))?.[1]?.toLowerCase()
}

/**
 * The kind of an env file (see EnvFileKind):
 * - "example": documentation templates (.env.example, .env.sample, example.env, env.example, …)
 * - "local": .env, .env.local, .env.<mode>.local, local.env, .envrc
 * - "mode": .env.development, .env.production, .env.test, prod.env, …
 * - "service": any other env file that a Compose service loads (`serviceFiles`, root-relative paths)
 * - "other": everything else, e.g. the encrypted .env.vault or a .env.backup
 */
export function classifyEnvFile(path: string, serviceFiles: ReadonlySet<string> = new Set()): EnvFileKind {
  const name = baseName(path)
  if (name === '.env.vault' || !isEnvFileName(name)) return 'other'
  if (EXAMPLE_HINT.test(name)) return 'example'
  if (isLocalName(name)) return 'local'
  const mode = modeOf(name)
  if (mode !== undefined && MODE_NAMES.has(mode)) return 'mode'
  return serviceFiles.has(path) ? 'service' : 'other'
}
