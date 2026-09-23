/**
 * Helpers that keep secrets out of RepoLens output.
 *
 * RepoLens never outputs environment variable values. These helpers are a
 * second line of defense for places where committed text is echoed back,
 * such as package.json scripts, CI commands and Git remote URLs.
 */

export const REDACTED = '***'

const SENSITIVE_SEGMENT =
  /(?:^|_)(?:SECRETS?|TOKENS?|PASSWORD|PASSWD|PASS|PWD|PASSPHRASE|APIKEY|KEY|PRIVATE|CREDENTIALS?|AUTH|SALT)(?:_|$)/i
const SENSITIVE_WORD = /(?:secret|token|password|passwd|apikey|privatekey|credential)/i

/**
 * True when a variable name suggests it holds a secret, e.g. STRIPE_SECRET_KEY
 * or DB_PASSWORD. Intentionally broad: it is used for redaction, where a false
 * positive only hides a harmless value.
 */
export function isSensitiveName(name: string): boolean {
  return SENSITIVE_SEGMENT.test(name) || SENSITIVE_WORD.test(name)
}

/**
 * Well-known credential formats. Used to flag documentation files (such as
 * .env.example) that appear to contain a real credential. Matches are
 * reported by pattern id only; the matched text is never output.
 */
export const CREDENTIAL_PATTERNS: ReadonlyArray<{ id: string; name: string; pattern: RegExp }> = [
  { id: 'aws-access-key', name: 'AWS access key ID', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: 'github-token', name: 'GitHub token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/ },
  { id: 'github-fine-grained-token', name: 'GitHub token', pattern: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
  { id: 'gitlab-token', name: 'GitLab token', pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { id: 'stripe-live-key', name: 'Stripe live key', pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/ },
  { id: 'slack-token', name: 'Slack token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'openai-key', name: 'OpenAI API key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/ },
  { id: 'anthropic-key', name: 'Anthropic API key', pattern: /\bsk-ant-[A-Za-z0-9_-]{32,}\b/ },
  { id: 'npm-token', name: 'npm token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { id: 'google-api-key', name: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'sendgrid-key', name: 'SendGrid API key', pattern: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/ },
  { id: 'private-key', name: 'private key', pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
]

/** Returns the id of the first credential pattern found in `value`, or null. */
export function findCredentialPattern(value: string): string | null {
  for (const { id, pattern } of CREDENTIAL_PATTERNS) {
    if (pattern.test(value)) return id
  }
  return null
}

function authorityEnd(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    const ch = text[i]
    if (ch === '/' || ch === '?' || ch === '#') return i
  }
  return text.length
}

/**
 * Remove credentials from a URL: userinfo, query string and fragment.
 * Scp-style Git URLs (git@github.com:org/repo.git) keep a plain user name;
 * a user part that holds a password or a credential is dropped.
 */
export function sanitizeUrl(url: string): string {
  const trimmed = url.trim()
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(trimmed)
  if (!schemeMatch) {
    const withoutQuery = trimmed.replace(/[?#][\s\S]*$/, '')
    const scp = /^([^@/\s]+)@([^@/\s:]+:[\s\S]*)$/.exec(withoutQuery)
    if (scp?.[1] && scp[2] && (scp[1].includes(':') || findCredentialPattern(scp[1]) !== null)) return scp[2]
    return withoutQuery
  }
  const scheme = schemeMatch[0]
  const rest = trimmed.slice(scheme.length)
  let end = authorityEnd(rest, 0)
  let authority = rest.slice(0, end)
  // Raw passwords may contain "/", "?" or "#" ("user:pa/ss@host"). When the text before them
  // has a ":" that is not a port and an "@" follows later, the userinfo runs up to that "@".
  if (!authority.includes('@') && !authority.startsWith('[')) {
    const colon = authority.indexOf(':')
    const at = rest.indexOf('@', end)
    if (colon !== -1 && at !== -1 && !/^\d*$/.test(authority.slice(colon + 1))) {
      end = authorityEnd(rest, at)
      authority = rest.slice(0, end)
    }
  }
  const at = authority.lastIndexOf('@')
  const host = at === -1 ? authority : authority.slice(at + 1)
  return `${scheme}${host}${rest.slice(end).replace(/[?#][\s\S]*$/, '')}`
}

const GLOBAL_CREDENTIAL_PATTERNS = CREDENTIAL_PATTERNS.map(({ pattern }) => new RegExp(pattern.source, 'g'))

/** `NAME=value` shell assignments; the value may be quoted. */
const ASSIGNMENT = /\b([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s;&|]+)/g
/**
 * Userinfo in URLs: `scheme://token@`, `scheme://user:pass@`, including raw passwords containing "/".
 * The scheme length is bounded so text like "a.a.a.…" can't make every word boundary rescan the line,
 * and so is the password tail: unbounded, every "x://u:p" in a long token without "@" rescanned the
 * rest of the token (quadratic; 160k characters took 6 s).
 */
const URL_USERINFO =
  /\b([a-zA-Z][a-zA-Z0-9+.-]{0,31}:\/\/)(?:[^\s/@'"]+|[^\s/@'":]+:(?!\d+(?:[/\s'"?#]|$))[^\s@'"]{0,256})@/g
/** `--password x`, `--auth-token=x`, `--client-secret x`: flags whose last word is sensitive. */
const SECRET_FLAG =
  /(?<=^|[\s"'(])(--?(?:[A-Za-z0-9]+[-_])*(?:password|passwd|pass|passphrase|token|secret|api-?key|auth|access-key|secret-key|private-key|credentials?)(?:=|\s+))(?![<>])("[^"]*"|'[^']*'|[^\s;&|]+)/gi
/** `gh auth login --with-token <<< tok`: a here-string feeding a token flag. */
// Bounded name lengths keep these linear: `[\w-]*` before an alternative backtracks quadratically on `--a-a-a-…`.
const HERE_STRING_SECRET =
  /(?<=^|[\s"'(])(--?[\w-]{0,48}?(?:token|secret|password|key)[\w-]{0,48}\s*<<<?\s*)("[^"]*"|'[^']*'|[^\s;&|]+)/gi
/** `npm config set //registry/:_authToken tok`, `aws configure set aws_secret_access_key key`. */
const CONFIG_SET = /\b(config\s+set|configure\s+set)(\s+)([^\s=;&|]+)(\s+|=)("[^"]*"|'[^']*'|[^\s;&|]+)/gi
/** Webhook URLs whose path is the secret (Slack, Discord). */
const WEBHOOK_URL =
  /\b(https?:\/\/(?:hooks\.slack\.com\/(?:services|workflows|triggers)|(?:discord|discordapp)\.com\/api\/webhooks)\/)[^\s'"]+/gi
/** Credential-looking query parameters: `?token=…`, `&api_key=…`, `&sig=…`. */
const SECRET_QUERY =
  /([?&](?:token|access_token|auth|key|api_key|apikey|secret|password|sig|signature|client_secret)=)[^&\s'"#]+/gi
/** HTTP headers carrying credentials, e.g. `-H "Authorization: Bearer abc"`. */
const AUTH_HEADER =
  /(?<=^|[\s"'])((?:proxy-)?authorization|[\w-]{0,40}?(?:api-?key|-key|-token|-secret|private-token|access-token))(\s*:\s*)(?:(bearer|basic|token|bot|digest)\s+)?([^\s'"]+)/gi
/** A bearer token anywhere (long enough not to be an ordinary word). */
const BEARER_TOKEN = /\b(bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi
/** `curl -u user:password`, `--user=user:password` (not `-u scheme://…`, which URL_USERINFO handles). */
const USER_PASSWORD_FLAG = /(?<=^|[\s"'(])(-u|--user)(=|\s+)([^\s:;&|'"]+):(?!\/\/)([^\s;&|'"]+)/g
/** One shell command: the text between `;`, `&`, `|` and line breaks. */
const SHELL_SEGMENT = /[^;&|\n]+/g
/** A flag value: quoted, or up to the next space or shell operator. */
const FLAG_VALUE = `("[^"]*"|'[^']*'|[^\\s;&|'"]+)`
const MYSQL_COMMAND = /\b(?:mysql|mysqldump|mysqladmin|mysqlimport|mariadb|mariadb-dump)\b/g
/** MySQL clients take the password glued to -p: `mysql -uroot -pSECRET`. */
const MYSQL_PASSWORD_FLAG = new RegExp(`\\s-p${FLAG_VALUE}`, 'g')
const PASSWORD_FLAG_COMMAND = /\b(?:docker\s+login|sshpass)\b/g
const REDIS_COMMAND = /\bredis-cli\b/g
/** `redis-cli -a password`. */
const REDIS_PASSWORD_FLAG = new RegExp(`\\s-a\\s+${FLAG_VALUE}`, 'g')
/** `docker login -p x`, `sshpass -p x`. */
const SHORT_PASSWORD_FLAG = new RegExp(`\\s-p(?:=|\\s+)?${FLAG_VALUE}`, 'g')

/**
 * Redact the value of the first `flag` after each `command` word in the same
 * shell command. `flag` must capture the value as group 1 at the end of its
 * match. Written as a loop because a single regex (`mysql[^;]*?\s-p…`)
 * rescans the rest of the command from every occurrence of the word, which is
 * quadratic on a long command that repeats it.
 */
function redactFlagAfterCommand(text: string, command: RegExp, flag: RegExp): string {
  return text.replace(SHELL_SEGMENT, (segment) => {
    let out = ''
    let copied = 0
    command.lastIndex = 0
    for (let word = command.exec(segment); word !== null; word = command.exec(segment)) {
      flag.lastIndex = word.index + word[0].length
      const found = flag.exec(segment)
      if (!found) break
      const end = found.index + found[0].length
      out += `${segment.slice(copied, end - (found[1] as string).length)}${REDACTED}`
      copied = end
      command.lastIndex = end
    }
    return out + segment.slice(copied)
  })
}

/**
 * Redact likely secrets from a shell command (package.json script, CI step):
 * - inline assignments with sensitive names: `API_TOKEN=abc node x` → `API_TOKEN=*** node x`
 * - credentials inside URLs: `postgres://user:pw@host` → `postgres://***@host`
 * - flags such as `--password foo`, `--token=foo`, `--auth-token foo`, `-u user:pw`, `mysql -pfoo`
 * - credential headers (`Authorization: Bearer …`) and bearer tokens
 * - well-known credential formats anywhere in the text
 */
export function redactCommand(command: string): string {
  let out = command
  out = out.replace(ASSIGNMENT, (match, name: string) => (isSensitiveName(name) ? `${name}=${REDACTED}` : match))
  out = out.replace(URL_USERINFO, `$1${REDACTED}@`)
  out = out.replace(SECRET_FLAG, (_match, flag: string) => `${flag}${REDACTED}`)
  out = out.replace(HERE_STRING_SECRET, (_match, flag: string) => `${flag}${REDACTED}`)
  out = out.replace(CONFIG_SET, (match, verb: string, space: string, key: string, separator: string) =>
    isSensitiveName(key.replace(/^.*[/:]/, '')) || /auth|token|secret|password/i.test(key)
      ? `${verb}${space}${key}${separator}${REDACTED}`
      : match,
  )
  out = out.replace(WEBHOOK_URL, `$1${REDACTED}`)
  out = out.replace(SECRET_QUERY, `$1${REDACTED}`)
  out = out.replace(
    AUTH_HEADER,
    (_match, header: string, separator: string, scheme: string | undefined) =>
      `${header}${separator}${scheme ? `${scheme} ` : ''}${REDACTED}`,
  )
  out = out.replace(BEARER_TOKEN, `$1${REDACTED}`)
  out = out.replace(USER_PASSWORD_FLAG, (match, flag: string, separator: string, user: string, password: string) =>
    // `docker run -u 1000:1000` is a uid:gid pair, not a credential.
    /^\d+$/.test(user) && /^\d+$/.test(password) ? match : `${flag}${separator}${user}:${REDACTED}`,
  )
  out = redactFlagAfterCommand(out, MYSQL_COMMAND, MYSQL_PASSWORD_FLAG)
  out = redactFlagAfterCommand(out, PASSWORD_FLAG_COMMAND, SHORT_PASSWORD_FLAG)
  out = redactFlagAfterCommand(out, REDIS_COMMAND, REDIS_PASSWORD_FLAG)
  for (const pattern of GLOBAL_CREDENTIAL_PATTERNS) out = out.replace(pattern, REDACTED)
  return out
}
