/**
 * Environment variables: which env files exist, where each variable is
 * defined or documented, and where source code, Prisma schemas and Compose
 * files reference it. Values never leave src/core/dotenv.ts; this module only
 * sees names and the derived facts the parser returns.
 */
import { useOr } from '../core/context.ts'
import { classifyEnvFile, type EnvFileEntry, isEnvFileName, isPlausibleEnvName, parseEnvFile } from '../core/dotenv.ts'
import { type ComposeFiles, composeFiles } from '../facts/compose.ts'
import { gitTrackedFiles } from '../facts/git.ts'
import { manifests, type ProjectManifests } from '../facts/manifests.ts'
import {
  blankComments,
  isGenerated,
  MAX_SOURCE_FILE_BYTES,
  type SourceFiles,
  sourceFiles,
} from '../facts/source-files.ts'
import type {
  Analyzer,
  Detector,
  EnvEndpoint,
  EnvFile,
  EnvironmentSection,
  EnvVariable,
  ProjectContext,
} from '../types.ts'
import { compareText } from '../utils/compare.ts'
import { mapLimit } from '../utils/limit.ts'
import { isTestFileName, isUnder, NON_PROJECT_ROLES, type PathRole, pathRoles } from '../utils/path-roles.ts'
import { baseName, depthOf, dirOf, extOf } from '../utils/paths.ts'
import { isSensitiveName } from '../utils/redact.ts'

/** Env files deeper than this many directories are not read. */
const MAX_ENV_FILE_DEPTH = 3
/** EnvVariable.usedIn lists at most this many files. */
export const MAX_USED_IN = 5
const ENV_FILE_CONCURRENCY = 8
const SOURCE_CONCURRENCY = 32

/**
 * Prefixes that frameworks inline into client-side bundles. The one list used
 * everywhere (the `public` flag, ENV_PUBLIC_SECRET).
 */
export const PUBLIC_PREFIXES: readonly string[] = [
  'NEXT_PUBLIC_',
  'NUXT_PUBLIC_',
  'EXPO_PUBLIC_',
  'REACT_APP_',
  'VUE_APP_',
  'STORYBOOK_',
  'GATSBY_',
  'PUBLIC_',
  'VITE_',
]

/** `import.meta.env` keys provided by Vite and Astro themselves, not by the environment. */
const IMPORT_META_BUILTINS: ReadonlySet<string> = new Set([
  'MODE',
  'BASE_URL',
  'PROD',
  'DEV',
  'SSR',
  'SITE',
  'ASSETS_PREFIX',
])

const JS_EXTENSIONS: ReadonlySet<string> = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.ts',
  '.mts',
  '.cts',
  '.tsx',
  '.vue',
  '.svelte',
  '.astro',
])

// ---------------------------------------------------------------------------
// File roles
// ---------------------------------------------------------------------------

/** Code under these directories belongs to samples, not the project: its env usages are ignored entirely. */
const IGNORED_USAGE_ROLES: readonly PathRole[] = ['fixture', 'example', 'template', 'playground', 'benchmark']

/** Fixture, example, template, playground and benchmark code, whose env usages are not the project's. */
export function isIgnoredUsagePath(file: string): boolean {
  return isUnder(file, IGNORED_USAGE_ROLES)
}

/** Test runner configuration and setup files, which configure tests only. */
const TEST_SUPPORT_FILE =
  /^(?:(?:vitest|jest|playwright|cypress|karma|wdio|ava)\.(?:config|setup|workspace)(?:\.[\w-]+)?|setupTests|test-setup)\.[cm]?[jt]sx?$/

/** Test code: test files, files in test directories, and test runner configuration. */
export function isTestUsagePath(file: string): boolean {
  return isTestFileName(file) || pathRoles(file).has('test') || TEST_SUPPORT_FILE.test(baseName(file))
}

// ---------------------------------------------------------------------------
// Usage extraction (pure)
// ---------------------------------------------------------------------------

/**
 * References found in one file: variable name → whether some reference reads
 * it without supplying a default.
 */
export type FileReferences = Map<string, boolean>

/** Not followed by more identifier characters or a call: `process.env.hasOwnProperty(` is not a variable. */
const NAME_END = String.raw`(?![A-Za-z0-9_$]|[ \t]*\()`
const NAME = '[A-Za-z_][A-Za-z0-9_]*'
/** Bracket access allows the full dotenv key syntax: `process.env["my-var"]`. */
const BRACKET = String.raw`\[\s*(['"\x60])([A-Za-z_][A-Za-z0-9_.-]*)\1\s*\]`

const PROCESS_ENV_DOT = new RegExp(String.raw`\bprocess\??\.env\??\.(${NAME})${NAME_END}`, 'g')
const PROCESS_ENV_BRACKET = new RegExp(String.raw`\bprocess\??\.env(?:\?\.)?${BRACKET}`, 'g')
const IMPORT_META_DOT = new RegExp(String.raw`\bimport\.meta\.env\??\.(${NAME})${NAME_END}`, 'g')
const IMPORT_META_BRACKET = new RegExp(String.raw`\bimport\.meta\.env(?:\?\.)?${BRACKET}`, 'g')
const BUN_ENV_DOT = new RegExp(String.raw`\bBun\.env\??\.(${NAME})${NAME_END}`, 'g')
const BUN_ENV_BRACKET = new RegExp(String.raw`\bBun\.env(?:\?\.)?${BRACKET}`, 'g')
const DENO_ENV_GET = new RegExp(String.raw`\bDeno\.env\.get\(\s*(['"\x60])(${NAME})\1\s*\)`, 'g')
/** `const { A, B: alias, C = 'x', ...rest }: Env = process.env` (also import.meta.env and Bun.env). */
const DESTRUCTURING =
  /\{([^{}]*)\}\s*(?::[^=;{}]*)?=\s*(process\??\.env|import\.meta\.env|Bun\.env)(?!\s*(?:\?\.|\.|\[)|[A-Za-z0-9_$])/g
// Import bodies stop at "{" as well as "}": with `[^}]*`, every unclosed "import {" in a
// hostile file would scan to the end of the file (quadratic time).
const SVELTEKIT_STATIC = /\bimport\s*\{([^{}]*)\}\s*from\s*(['"])\$env\/static\/(?:private|public)\2/g
const SVELTEKIT_DYNAMIC = /\bimport\s*\{([^{}]*)\}\s*from\s*(['"])\$env\/dynamic\/(?:private|public)\2/g
const ASTRO_ENV_IMPORT = /\bimport\s*\{([^{}]*)\}\s*from\s*(['"])astro:env\/(?:client|server)\2/g
// The type annotation is bounded for the same reason: `const a: …` without "=" repeated
// thousands of times must not rescan the rest of the file from each occurrence.
const LOAD_ENV_BINDING =
  /\b(?:const|let|var)\s+(?:([A-Za-z_$][\w$]*)|\{([^{}]*)\})\s*(?::[^=;{}]{0,200})?=\s*(?:await\s+)?loadEnv\s*\(/g
/** `binding.NAME` / `binding["NAME"]` for any identifier; callers keep the bindings that hold an env object. */
const MEMBER_DOT = new RegExp(String.raw`(?<![\w$.])([A-Za-z_$][\w$]*)\??\.(${NAME})${NAME_END}`, 'g')
// Same as BRACKET, but the quote is group 2 because group 1 is the binding.
const MEMBER_BRACKET = /(?<![\w$.])([A-Za-z_$][\w$]*)(?:\?\.)?\[\s*(['"`])([A-Za-z_][A-Za-z0-9_.-]*)\2\s*\]/g
/** NestJS `configService.get('NAME')`, `.get<string>('NAME', fallback)`, `.getOrThrow('NAME')`. */
const CONFIG_SERVICE_GET =
  /(?<![\w$])([A-Za-z_$][\w$]*)\s*\.\s*(get|getOrThrow)\s*(?:<[^<>()]*>)?\s*\(\s*(['"\x60])([A-Z][A-Z0-9_]*)\3\s*([,)])/g
/** `env('NAME')` from `prisma/config` (prisma.config.ts). */
const PRISMA_CONFIG_ENV = new RegExp(String.raw`(?<![\w$.])env\(\s*(['"\x60])(${NAME})\1\s*\)`, 'g')

const GO_GETENV = new RegExp(String.raw`\bos\.(Getenv|LookupEnv)\(\s*(["\x60])(${NAME})\2\s*\)`, 'g')
/** Struct tags `env:"NAME,required"` (caarlos0/env, cleanenv) and `envconfig:"NAME"`. */
const GO_STRUCT_TAG = new RegExp(String.raw`(?<![\w-])(?:env|envconfig):"(${NAME})(?:,[^"]*)?"`, 'g')
/** A default in the same struct tag: `envDefault:"8080"` (caarlos0/env), `default:"8080"` (envconfig, cleanenv's env-default). */
const GO_TAG_DEFAULT = /\b(?:envDefault|default|env-default):"/
/** `cmp.Or(os.Getenv("PORT"), "8080")`: the first non-empty value wins, so a later argument is the default. */
const GO_CMP_OR = /\bcmp\.Or\(/

const PRISMA_ENV = new RegExp(String.raw`\benv\(\s*"(${NAME})"\s*\)`, 'g')

/**
 * `process.env` (or import.meta.env, Bun.env) passed whole to a validation
 * schema: zod `.parse(process.env)`, Joi `.validate(process.env)`, envalid
 * `cleanEnv(process.env, …)`, valibot `parse(schema, process.env)`, t3-env
 * `createEnv({ …, runtimeEnv: process.env })`, or any t3-env `createEnv`. The
 * schema's keys are then the variables the file reads.
 */
const ENV_OBJECT = String.raw`(?:process\??\.env|import\.meta\.env|Bun\.env)(?![\w$]|\s*(?:\?\.|\.|\[))`
const WHOLE_ENV_ARGUMENT = new RegExp(
  String.raw`\b(?:parse|safeParse|parseAsync|safeParseAsync|validate|validateSync|validateAsync|assert|cleanEnv|createEnv|envsafe|parseEnv)\s*(?:<[^<>()]{0,200}>)?\s*\(\s*(?:[^()]{0,200}?,\s*)?(?:\{\s*\.\.\.\s*)?${ENV_OBJECT}`,
)
const WHOLE_ENV_RUNTIME = new RegExp(String.raw`\b\w*[rR]untimeEnv\w*\s*:\s*${ENV_OBJECT}`)
/** t3-env reads its `server`/`client`/`shared` keys from the environment whatever `runtimeEnv` lists. */
const T3_CREATE_ENV = /\bcreateEnv\s*\(/
/** UPPER_SNAKE object keys (schema entries): `DATABASE_URL: z.string()`, `{ SMTP_HOST: str() }`, `'PORT': Joi.number()`. */
const SCHEMA_KEY = /(?:^|[{,])[ \t]*(['"]?)([A-Z][A-Z0-9_]*[A-Z0-9])\1[ \t]*\??:/gm
/** A schema entry that makes the variable optional: `.default(…)`, envalid `{ default: … }`, `.optional()`. */
const SCHEMA_DEFAULT = /\.default\s*\(|\b(?:default|devDefault)\s*:|\.optional\s*\(/
/** Characters of a schema entry inspected for a default. */
const MAX_SCHEMA_ENTRY = 400

/** `?? x` or `|| x` right after a read (closing parentheses of a wrapping call allowed): the code supplies a default. */
const DEFAULT_AFTER = /[\s)]{0,40}(?:\?\?|\|\|)/y

function defaultFollows(code: string, end: number): boolean {
  DEFAULT_AFTER.lastIndex = end
  return DEFAULT_AFTER.test(code)
}

function addReference(
  refs: FileReferences,
  name: string | undefined,
  hasDefault: boolean,
  exclude?: ReadonlySet<string>,
): void {
  if (!name || exclude?.has(name)) return
  refs.set(name, (refs.get(name) ?? false) || !hasDefault)
}

/** Direct reads such as `process.env.NAME` / `process.env["NAME"]`; `nameGroup` is the capture group holding the name. */
function addReads(
  code: string,
  pattern: RegExp,
  nameGroup: number,
  refs: FileReferences,
  exclude?: ReadonlySet<string>,
) {
  for (const m of code.matchAll(pattern)) {
    addReference(refs, m[nameGroup], defaultFollows(code, m.index + m[0].length), exclude)
  }
}

/**
 * `binding.NAME` and `binding["NAME"]` for local variables that hold an env
 * object. One pass for all bindings: a regex per binding would rescan the
 * file once per `loadEnv()` call or `$env/dynamic` import.
 */
function addMemberUsages(code: string, bindings: ReadonlySet<string>, refs: FileReferences): void {
  if (bindings.size === 0) return
  for (const m of code.matchAll(MEMBER_DOT)) {
    if (bindings.has(m[1] as string)) addReference(refs, m[2], defaultFollows(code, m.index + m[0].length))
  }
  for (const m of code.matchAll(MEMBER_BRACKET)) {
    if (bindings.has(m[1] as string)) addReference(refs, m[3], defaultFollows(code, m.index + m[0].length))
  }
}

/** Keys of an object destructuring pattern body, and whether each has a default: "A, B: b = 1" → A (no), B (yes). */
export function destructuredEntries(body: string): Array<{ key: string; hasDefault: boolean }> {
  const entries: Array<{ key: string; hasDefault: boolean }> = []
  for (const part of blankComments(body, 'js').split(',')) {
    const trimmed = part.trim()
    if (trimmed === '' || trimmed.startsWith('...') || trimmed.startsWith('[')) continue
    const key = (trimmed.split(/[:=]/)[0] ?? '').trim().replace(/^(['"])(.*)\1$/, '$2')
    if (/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) entries.push({ key, hasDefault: trimmed.includes('=') })
  }
  return entries
}

/** Keys of an object destructuring pattern body: "A, B: alias, C = 'x', ...rest" → A, B, C. */
export function destructuredKeys(body: string): string[] {
  return destructuredEntries(body).map((entry) => entry.key)
}

/** Import specifiers: "A, type B, C as D" → [{ imported: "A", local: "A" }, …]. */
function importSpecifiers(body: string): Array<{ imported: string; local: string }> {
  const specifiers: Array<{ imported: string; local: string }> = []
  for (const part of blankComments(body, 'js').split(',')) {
    const match = /^\s*(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(part)
    if (match?.[1]) specifiers.push({ imported: match[1], local: match[2] ?? match[1] })
  }
  return specifiers
}

/** Schema keys of a file that validates the whole environment object, with their defaults. */
function addSchemaKeys(code: string, refs: FileReferences): void {
  const t3 = code.includes('@t3-oss/env') && T3_CREATE_ENV.test(code)
  const runtimeEnv = code.includes('untimeEnv') && WHOLE_ENV_RUNTIME.test(code)
  if (!t3 && !runtimeEnv && !WHOLE_ENV_ARGUMENT.test(code)) return
  const keys = [...code.matchAll(SCHEMA_KEY)]
  keys.forEach((m, i) => {
    const start = m.index + m[0].length
    const next = keys[i + 1]?.index ?? code.length
    const entry = code.slice(start, Math.min(next, start + MAX_SCHEMA_ENTRY))
    addReference(refs, m[2], SCHEMA_DEFAULT.test(entry))
  })
}

function extractJsReferences(code: string, refs: FileReferences): void {
  addReads(code, PROCESS_ENV_DOT, 1, refs)
  addReads(code, PROCESS_ENV_BRACKET, 2, refs)
  addReads(code, IMPORT_META_DOT, 1, refs, IMPORT_META_BUILTINS)
  addReads(code, IMPORT_META_BRACKET, 2, refs, IMPORT_META_BUILTINS)
  addReads(code, BUN_ENV_DOT, 1, refs)
  addReads(code, BUN_ENV_BRACKET, 2, refs)
  addReads(code, DENO_ENV_GET, 2, refs)

  for (const m of code.matchAll(DESTRUCTURING)) {
    const exclude = m[2]?.startsWith('import') ? IMPORT_META_BUILTINS : undefined
    for (const { key, hasDefault } of destructuredEntries(m[1] ?? '')) addReference(refs, key, hasDefault, exclude)
  }

  // Local names bound to an env object: SvelteKit `$env/dynamic` imports and Vite `loadEnv()` results.
  const bindings = new Set<string>()
  if (code.includes('$env/')) {
    for (const m of code.matchAll(SVELTEKIT_STATIC)) {
      for (const specifier of importSpecifiers(m[1] ?? '')) addReference(refs, specifier.imported, false)
    }
    for (const m of code.matchAll(SVELTEKIT_DYNAMIC)) {
      for (const specifier of importSpecifiers(m[1] ?? '')) {
        if (specifier.imported === 'env') bindings.add(specifier.local)
      }
    }
  }

  if (code.includes('astro:env')) {
    for (const m of code.matchAll(ASTRO_ENV_IMPORT)) {
      for (const specifier of importSpecifiers(m[1] ?? '')) {
        if (specifier.imported !== 'getSecret') addReference(refs, specifier.imported, false)
      }
    }
  }

  // Vite configs: `const env = loadEnv(mode, cwd, '')` then `env.NAME`, or `const { A } = loadEnv(…)`.
  if (code.includes('loadEnv')) {
    for (const m of code.matchAll(LOAD_ENV_BINDING)) {
      if (m[1]) bindings.add(m[1])
      else for (const { key, hasDefault } of destructuredEntries(m[2] ?? '')) addReference(refs, key, hasDefault)
    }
  }
  addMemberUsages(code, bindings, refs)

  // Only UPPER_SNAKE keys on a receiver named like a config service, and only
  // in files that mention ConfigService: `map.get('KEY')` is not an env lookup.
  if (code.includes('ConfigService')) {
    for (const m of code.matchAll(CONFIG_SERVICE_GET)) {
      // `get('KEY', fallback)` supplies a default; getOrThrow never does.
      if (/config/i.test(m[1] ?? '')) addReference(refs, m[4], m[2] === 'get' && m[5] === ',')
    }
  }

  if (code.includes('prisma/config')) {
    for (const m of code.matchAll(PRISMA_CONFIG_ENV)) addReference(refs, m[2], false)
  }

  addSchemaKeys(code, refs)
}

/** The line around `index`, capped so a huge single-line file costs little per match. */
function lineAround(code: string, index: number): { before: string; after: string } {
  const start = Math.max(code.lastIndexOf('\n', index) + 1, index - 200)
  const newline = code.indexOf('\n', index)
  const end = Math.min(newline === -1 ? code.length : newline, index + 200)
  return { before: code.slice(start, index), after: code.slice(index, end) }
}

function extractGoReferences(code: string, refs: FileReferences): void {
  for (const m of code.matchAll(GO_GETENV)) {
    // LookupEnv reports whether the variable is set, so the code handles its absence.
    const hasDefault = m[1] === 'LookupEnv' || GO_CMP_OR.test(lineAround(code, m.index).before)
    addReference(refs, m[3], hasDefault)
  }
  for (const m of code.matchAll(GO_STRUCT_TAG)) {
    const { before, after } = lineAround(code, m.index)
    addReference(refs, m[1], GO_TAG_DEFAULT.test(before) || GO_TAG_DEFAULT.test(after))
  }
}

/**
 * Cheap pre-check, so only files that can reference a variable pay for
 * comment blanking: every pattern contains one of these.
 */
const ENV_ACCESS_HINT =
  /process\??\.env|import\.meta\.env|Bun\.env|Deno\.env|\$env\/|astro:env|loadEnv|ConfigService|prisma\/config|Getenv|LookupEnv|env(?:config)?:"|\benv\(/

function mayReferenceEnv(text: string): boolean {
  return ENV_ACCESS_HINT.test(text)
}

/** References in code whose comments are already blanked (see `blankComments`). */
function referencesInCode(code: string, ext: string): FileReferences {
  const refs: FileReferences = new Map()
  if (JS_EXTENSIONS.has(ext)) extractJsReferences(code, refs)
  else if (ext === '.go') extractGoReferences(code, refs)
  else if (ext === '.prisma') for (const m of code.matchAll(PRISMA_ENV)) addReference(refs, m[1], false)
  return refs
}

/** Comment syntax of a file extension; JavaScript for everything that is not Go or Prisma. */
function syntaxOf(ext: string): 'js' | 'c' {
  return ext === '.go' || ext === '.prisma' ? 'c' : 'js'
}

/**
 * Environment variables referenced by a source file, and whether any
 * reference reads one without a default (`?? x`, `|| x`, a destructuring
 * default, a schema `.default()`, Go `cmp.Or`, an `envDefault` tag, …).
 * `ext` is the lowercase extension with dot (".ts", ".vue", ".go",
 * ".prisma", …); unknown extensions yield nothing. Comments are ignored.
 * Vite/Astro `import.meta.env` built-ins (MODE, DEV, BASE_URL, …) are
 * excluded; NODE_ENV is kept.
 */
export function extractEnvReferences(text: string, ext: string): FileReferences {
  if (!mayReferenceEnv(text)) return new Map()
  return referencesInCode(blankComments(text, syntaxOf(ext)), ext)
}

/** Names of the environment variables a source file references (see extractEnvReferences). */
export function extractEnvUsages(text: string, ext: string): Set<string> {
  return new Set(extractEnvReferences(text, ext).keys())
}

/** `%VITE_TITLE%` in index.html: Vite and Create React App replace these at build time. */
const HTML_ENV_REFERENCE = /%([A-Z_][A-Z0-9_]*)%/g

/**
 * Variables an index.html reads through `%NAME%` placeholders. Only names the
 * bundlers expose (public prefixes, NODE_ENV): `%s%`-style text is not a variable.
 */
export function extractHtmlEnvUsages(text: string): Set<string> {
  const names = new Set<string>()
  if (!text.includes('%')) return names
  for (const m of text.matchAll(HTML_ENV_REFERENCE)) {
    const name = m[1] as string
    if ((isPublicName(name) || name === 'NODE_ENV') && !IMPORT_META_BUILTINS.has(name)) names.add(name)
  }
  return names
}

/** The part of a YAML line before its comment: a `#` at the start or after whitespace, outside quotes. */
function stripYamlComment(line: string): string {
  let quote: string | null = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote !== null) {
      if (quote === '"' && ch === '\\') i++
      else if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '#' && (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t')) {
      return line.slice(0, i)
    }
  }
  return line
}

/** `$$` is Compose's escape for a literal dollar sign and must be consumed first. */
const COMPOSE_VARIABLE = new RegExp(String.raw`\$(?:\$|\{(${NAME})(:?[-+?])?|(${NAME}))`, 'g')

/**
 * Variables interpolated by a Compose file: `${NAME}`, `${NAME:-default}`,
 * `${NAME?error}`, `$NAME`, and whether a reference lacks a default
 * (`${NAME:-x}` and `${NAME:+x}` never fail when the variable is unset).
 * Names under `environment:` are definitions, not usages, and are not
 * returned unless they are also interpolated.
 *
 * Committed passwords and htpasswd hashes often contain an unescaped `$`
 * ("hunter$secret42", "admin:$apr1$H6uskkkW$…"). Compose would interpolate
 * those too, but reporting "secret42" as a variable name would print part of
 * the secret. So the bare `$NAME` form only counts for conventional UPPER_SNAKE
 * names that do not continue a word; the braced form is always deliberate.
 */
export function composeReferences(text: string): FileReferences {
  const refs: FileReferences = new Map()
  if (!text.includes('$')) return refs
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes('$') || /^\s*#/.test(line)) continue
    const code = stripYamlComment(line)
    for (const m of code.matchAll(COMPOSE_VARIABLE)) {
      if (m[1]) {
        addReference(refs, m[1], m[2] !== undefined && !m[2].endsWith('?'))
      } else if (m[3] && !/[a-z]/.test(m[3]) && !/[\w]/.test(code[m.index - 1] ?? '')) {
        addReference(refs, m[3], false)
      }
    }
  }
  return refs
}

/** Names of the variables a Compose file interpolates (see composeReferences). */
export function extractComposeUsages(text: string): Set<string> {
  return new Set(composeReferences(text).keys())
}

// ---------------------------------------------------------------------------
// Nuxt runtime config (pure)
// ---------------------------------------------------------------------------

const NUXT_CONFIG = /^nuxt\.config\.[cm]?[jt]s$/
/** runtimeConfig is shallow in practice; a cap keeps hostile nesting from costing O(depth²). */
const MAX_RUNTIME_CONFIG_DEPTH = 8
const RUNTIME_CONFIG = /\bruntimeConfig\s*:\s*\{/
const IDENTIFIER_KEY = /[A-Za-z_$][\w$]*/y
const QUOTED_KEY = /'([^'\\\n]*)'|"([^"\\\n]*)"/y

/** Skip whitespace and comments. */
function skipTrivia(text: string, at: number): number {
  let i = at
  while (i < text.length) {
    const ch = text[i]
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++
    } else if (ch === '/' && text[i + 1] === '/') {
      const newline = text.indexOf('\n', i)
      i = newline === -1 ? text.length : newline + 1
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 2
    } else {
      break
    }
  }
  return i
}

function skipString(text: string, at: number): number {
  const quote = text[at]
  for (let i = at + 1; i < text.length; i++) {
    if (text[i] === '\\') i++
    else if (text[i] === quote) return i + 1
  }
  return text.length
}

function readObjectKey(text: string, at: number): { key: string; end: number } | null {
  IDENTIFIER_KEY.lastIndex = at
  const identifier = IDENTIFIER_KEY.exec(text)
  if (identifier) return { key: identifier[0], end: at + identifier[0].length }
  QUOTED_KEY.lastIndex = at
  const quoted = QUOTED_KEY.exec(text)
  if (quoted) return { key: quoted[1] ?? quoted[2] ?? '', end: at + quoted[0].length }
  return null
}

/** Nuxt's key → env segment conversion (scule snakeCase, upper-cased): "apiBase" → "API_BASE". */
function nuxtEnvSegment(key: string): string {
  // "APIKey" → "API_Key". A lookahead instead of `([A-Z]+)([A-Z][a-z])`, which
  // backtracks quadratically on a long run of capitals.
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])(?=[A-Z][a-z])/g, '$1_')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toUpperCase()
}

/**
 * Env names Nuxt reads for `runtimeConfig` keys in nuxt.config: `apiSecret` →
 * NUXT_API_SECRET, `public.apiBase` → NUXT_PUBLIC_API_BASE. Nuxt applies these
 * overrides itself, so a documented NUXT_PUBLIC_API_BASE is in use even though
 * no code mentions it. Only the first `runtimeConfig: { … }` literal is read.
 */
export function nuxtRuntimeConfigNames(text: string): Set<string> {
  const names = new Set<string>()
  const start = RUNTIME_CONFIG.exec(text)
  if (!start) return names
  // Object-literal frames carry their key path; null frames are other brackets inside values.
  const stack: Array<{ path: string[] } | null> = [{ path: [] }]
  let expectKey = true
  let i = start.index + start[0].length
  while (stack.length > 0) {
    i = skipTrivia(text, i)
    if (i >= text.length) break
    const ch = text[i]
    const frame = stack[stack.length - 1]
    if (frame && expectKey) {
      if (ch === ',') {
        i++
        continue
      }
      if (ch === '}') {
        stack.pop()
        expectKey = false
        i++
        continue
      }
      expectKey = false
      const key = readObjectKey(text, i)
      // Spread or computed key: parse the rest of the property as a value.
      if (!key) continue
      const path = [...frame.path, key.key]
      i = skipTrivia(text, key.end)
      if (text[i] === ':') {
        i = skipTrivia(text, i + 1)
        if (text[i] === '{' && path.length >= MAX_RUNTIME_CONFIG_DEPTH) {
          // Too deep to be real config: read the object as an opaque value.
          stack.push(null)
          i++
        } else if (text[i] === '{') {
          stack.push({ path })
          expectKey = true
          i++
        } else {
          names.add(['NUXT', ...path.map(nuxtEnvSegment)].join('_'))
        }
      } else if (text[i] === ',' || text[i] === '}') {
        names.add(['NUXT', ...path.map(nuxtEnvSegment)].join('_'))
      }
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(text, i)
      continue
    }
    if (ch === '{' || ch === '(' || ch === '[') stack.push(null)
    else if (ch === '}' || ch === ')' || ch === ']') stack.pop()
    else if (ch === ',' && frame) expectKey = true
    i++
  }
  return names
}

export function isNuxtConfig(path: string): boolean {
  return NUXT_CONFIG.test(baseName(path))
}

// ---------------------------------------------------------------------------
// next.config `env` (pure)
// ---------------------------------------------------------------------------

const NEXT_CONFIG = /^next\.config\.[cm]?[jt]s$/
const NEXT_ENV_BLOCK = /\benv\s*:\s*\{/
/** An `env: { … }` block longer than this is not read to its end. */
const MAX_OBJECT_LENGTH = 50_000

export function isNextConfig(path: string): boolean {
  return NEXT_CONFIG.test(baseName(path))
}

/** Keys of the object literal whose "{" is at `open` (depth 1 only; spreads and computed keys skipped). */
function objectKeys(code: string, open: number): string[] {
  const keys: string[] = []
  const limit = Math.min(code.length, open + MAX_OBJECT_LENGTH)
  let depth = 0
  let entryStart = open + 1
  const take = (end: number) => {
    const key = /^\s*(['"]?)([A-Za-z_$][\w$]*)\1\s*(?::|$)/.exec(code.slice(entryStart, end))?.[2]
    if (key) keys.push(key)
  }
  for (let i = open; i < limit; i++) {
    const ch = code[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(code, i) - 1
    } else if (ch === '{' || ch === '(' || ch === '[') {
      depth++
    } else if (ch === '}' || ch === ')' || ch === ']') {
      depth--
      if (depth === 0) {
        take(i)
        break
      }
    } else if (ch === ',' && depth === 1) {
      take(i)
      entryStart = i + 1
    }
  }
  return keys
}

/**
 * Names that a Next.js config provides to code through its `env` block
 * (`env: { API_URL: 'https://…' }` makes `process.env.API_URL` work), so
 * nobody has to set them. A key the config itself reads from the environment
 * (`API_URL: process.env.API_URL`) is passed through and still has to be set.
 * `code` must already be comment-free.
 */
export function nextConfigProvidedNames(code: string): Set<string> {
  const names = new Set<string>()
  const block = NEXT_ENV_BLOCK.exec(code)
  if (!block) return names
  const read = referencesInCode(code, '.js')
  for (const key of objectKeys(code, block.index + block[0].length - 1)) {
    if (/^[A-Z][A-Z0-9_]*$/.test(key) && !read.has(key)) names.add(key)
  }
  return names
}

// ---------------------------------------------------------------------------
// Env files and merging (pure)
// ---------------------------------------------------------------------------

/**
 * Directories where env files are looked for: the root, package/module
 * directories, Compose directories and the directories of env files that
 * Compose services load. Directories of tests, fixtures and samples are left out.
 */
export function envFileDirectories(
  project: ProjectManifests,
  composePaths: readonly string[],
  serviceFiles: readonly string[] = [],
): Set<string> {
  const dirs = new Set<string>(['.'])
  for (const pkg of project.packages) dirs.add(pkg.dir)
  for (const mod of project.goModules) dirs.add(mod.dir)
  for (const file of [...composePaths, ...serviceFiles]) {
    if (!isUnder(file, NON_PROJECT_ROLES)) dirs.add(dirOf(file))
  }
  return dirs
}

/** Env files among `candidates` that live in one of `dirs`, at most MAX_ENV_FILE_DEPTH deep. Sorted. */
export function selectEnvFiles(candidates: readonly string[], dirs: ReadonlySet<string>): string[] {
  const selected = candidates.filter(
    (file) => isEnvFileName(baseName(file)) && depthOf(file) <= MAX_ENV_FILE_DEPTH && dirs.has(dirOf(file)),
  )
  return [...new Set(selected)].sort(compareText)
}

export function isPublicName(name: string): boolean {
  return PUBLIC_PREFIXES.some((prefix) => name.startsWith(prefix))
}

export interface ParsedEnvFile {
  file: EnvFile
  entries: EnvFileEntry[]
}

/** Where a variable is referenced, and whether any reference lacks a default. */
export interface Usage {
  files: Set<string>
  /** Some reference reads the variable without supplying a default. */
  required: boolean
}

function compareEndpoints(a: EnvEndpoint, b: EnvEndpoint): number {
  return (
    compareText(a.file, b.file) ||
    compareText(a.scheme, b.scheme) ||
    (a.port ?? -1) - (b.port ?? -1) ||
    Number(a.local) - Number(b.local)
  )
}

/**
 * Merge env file entries and source usages into variables, sorted by name
 * (code-unit order). Local, mode and service files define; example files
 * document (commented-out entries included); other files (.env.vault,
 * backups, env files nothing loads) contribute nothing. Credential-pattern
 * matches are only reported for example files. `implicitUsages` (framework
 * conventions such as Nuxt runtime config, whose config supplies the value)
 * only mark variables that an env file declares; they never add new names.
 */
export function mergeVariables(
  envFiles: readonly ParsedEnvFile[],
  usages: ReadonlyMap<string, Usage>,
  implicitUsages: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): EnvVariable[] {
  interface Accumulator {
    definedIn: Set<string>
    documentedIn: Set<string>
    endpoints: Map<string, EnvEndpoint>
    suspicious: Set<string>
  }
  const byName = new Map<string, Accumulator>()
  const get = (name: string): Accumulator => {
    let acc = byName.get(name)
    if (!acc) {
      acc = { definedIn: new Set(), documentedIn: new Set(), endpoints: new Map(), suspicious: new Set() }
      byName.set(name, acc)
    }
    return acc
  }

  for (const { file, entries } of envFiles) {
    if (file.kind === 'other') continue
    for (const entry of entries) {
      const acc = get(entry.name)
      if (file.kind === 'example') acc.documentedIn.add(file.path)
      else if (!entry.commented) acc.definedIn.add(file.path)
      if (entry.endpoint) {
        const { scheme, port, local } = entry.endpoint
        acc.endpoints.set(`${file.path}\0${scheme}\0${port}\0${local}`, { file: file.path, scheme, port, local })
      }
      if (file.kind === 'example' && entry.credentialPattern !== null) acc.suspicious.add(file.path)
    }
  }
  const used = new Map<string, Usage>()
  for (const [name, files] of implicitUsages) {
    if (byName.has(name)) used.set(name, { files: new Set(files), required: false })
  }
  for (const [name, usage] of usages) {
    const existing = used.get(name)
    if (existing) {
      for (const file of usage.files) existing.files.add(file)
      existing.required ||= usage.required
    } else {
      used.set(name, { files: new Set(usage.files), required: usage.required })
    }
    get(name)
  }

  const variables: EnvVariable[] = []
  for (const [name, acc] of byName) {
    if (!isPlausibleEnvName(name)) continue
    const usage = used.get(name)
    const usedIn = [...(usage?.files ?? [])].sort(compareText)
    variables.push({
      name,
      defined: acc.definedIn.size > 0,
      documented: acc.documentedIn.size > 0,
      used: usedIn.length > 0,
      definedIn: [...acc.definedIn].sort(compareText),
      documentedIn: [...acc.documentedIn].sort(compareText),
      usedIn: usedIn.slice(0, MAX_USED_IN),
      fallback: usage !== undefined && usedIn.length > 0 && !usage.required,
      testOnly: usedIn.length > 0 && usedIn.every(isTestUsagePath),
      public: isPublicName(name),
      sensitive: isSensitiveName(name),
      endpoints: [...acc.endpoints.values()].sort(compareEndpoints),
      suspiciousValueIn: [...acc.suspicious].sort(compareText),
    })
  }
  return variables.sort((a, b) => compareText(a.name, b.name))
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

async function loadEnvFile(
  ctx: ProjectContext,
  path: string,
  tracked: ReadonlySet<string> | null,
  serviceFiles: ReadonlySet<string>,
): Promise<ParsedEnvFile> {
  const kind = classifyEnvFile(path, serviceFiles)
  let entries: EnvFileEntry[] = []
  // .env.vault holds encrypted values; there is nothing useful to parse.
  if (baseName(path) !== '.env.vault') {
    // Not cached: the raw text holds secrets and nothing else needs it.
    const text = await ctx.readText(path, { cache: false })
    const example = kind === 'example'
    if (text !== null) entries = parseEnvFile(text, path, { checkCredentials: example, commentedEntries: example })
  }
  return {
    file: {
      path,
      kind,
      variables: entries.filter((entry) => !entry.commented).length,
      ignored: ctx.files.isIgnored(path),
      tracked: tracked ? tracked.has(path) : null,
    },
    entries,
  }
}

function record(map: Map<string, Usage>, refs: FileReferences, file: string): void {
  for (const [name, required] of refs) {
    const usage = map.get(name)
    if (usage) {
      usage.files.add(file)
      usage.required ||= required
    } else {
      map.set(name, { files: new Set([file]), required })
    }
  }
}

/** UPPER_SNAKE words; a mention check only needs these. */
const UPPER_WORD = /(?<![\w$])[A-Z][A-Z0-9_]{2,}(?![\w$])/g

/** Candidate names that appear in `text` as whole words. */
function wordsIn(text: string, candidates: ReadonlySet<string>): string[] {
  const found: string[] = []
  for (const m of text.matchAll(UPPER_WORD)) if (candidates.has(m[0])) found.push(m[0])
  return found
}

/** index.html files that Vite (root) or Create React App (public/) read, not build output. */
function isAppHtml(file: string): boolean {
  if (baseName(file) !== 'index.html' || depthOf(file) > MAX_ENV_FILE_DEPTH || isIgnoredUsagePath(file)) return false
  return !isGenerated(file) || /(?:^|\/)public\/index\.html$/.test(file)
}

interface CollectedUsages {
  usages: Map<string, Usage>
  implicit: Map<string, Set<string>>
  mentioned: Set<string>
  configProvided: Set<string>
}

async function collectUsages(
  ctx: ProjectContext,
  sources: SourceFiles,
  composePaths: readonly string[],
  documented: ReadonlySet<string>,
): Promise<CollectedUsages> {
  const usages = new Map<string, Usage>()
  const implicit = new Map<string, Set<string>>()
  const mentioned = new Set<string>()
  const configProvided = new Set<string>()

  // Many files share a directory: decide once per directory whether it holds sample code.
  const ignoredDirs = new Map<string, boolean>()
  const ignored = (file: string) => {
    const dir = dirOf(file)
    let result = ignoredDirs.get(dir)
    if (result === undefined) {
      result = isIgnoredUsagePath(file)
      ignoredDirs.set(dir, result)
    }
    return result
  }

  await mapLimit(sources.files, SOURCE_CONCURRENCY, async (source) => {
    if (ignored(source.path)) return
    const text = await ctx.readText(source.path, { cache: false, maxBytes: MAX_SOURCE_FILE_BYTES })
    if (text === null) return
    let code: string | undefined
    const lexed = () => {
      code ??= blankComments(text, syntaxOf(source.ext))
      return code
    }
    if (mayReferenceEnv(text)) record(usages, referencesInCode(lexed(), source.ext), source.path)
    if (isNuxtConfig(source.path)) {
      for (const name of nuxtRuntimeConfigNames(text)) {
        const files = implicit.get(name)
        if (files) files.add(source.path)
        else implicit.set(name, new Set([source.path]))
      }
    }
    if (isNextConfig(source.path)) for (const name of nextConfigProvidedNames(lexed())) configProvided.add(name)
    // Mentions only matter for documented names nothing reads; only files whose raw text
    // names one that is not known to be used yet pay for comment blanking.
    if (documented.size > 0 && wordsIn(text, documented).some((name) => !usages.has(name) && !mentioned.has(name))) {
      for (const name of wordsIn(lexed(), documented)) mentioned.add(name)
    }
  })
  for (const file of ctx.files.byExtension('.prisma')) {
    if (isIgnoredUsagePath(file)) continue
    const text = await ctx.readText(file)
    if (text !== null) record(usages, extractEnvReferences(text, extOf(file)), file)
  }
  for (const file of ctx.files.files.filter(isAppHtml)) {
    const text = await ctx.readText(file, { cache: false })
    if (text === null) continue
    const refs: FileReferences = new Map()
    for (const name of extractHtmlEnvUsages(text)) refs.set(name, true)
    record(usages, refs, file)
  }
  for (const file of composePaths) {
    const text = await ctx.readText(file)
    if (text !== null) record(usages, composeReferences(text), file)
  }
  return { usages, implicit, mentioned, configProvided }
}

export interface EnvironmentAnalysis {
  section: EnvironmentSection
  /**
   * Documented names that nothing reads through a recognized pattern but that
   * appear as a word in source code (an identifier or a string, not a
   * comment): a library may read them by name (`const MODE_ENV = "GIN_MODE"`).
   */
  mentioned: ReadonlySet<string>
  /** Names a framework config provides to code (next.config `env`), which need no env file. */
  configProvided: ReadonlySet<string>
}

const NO_COMPOSE: ComposeFiles = { files: [], envFiles: [] }

/**
 * Everything the environment section is built from, plus facts doctor rules
 * need but the JSON output does not carry. Memoized, so the doctor reuses
 * the detector's work.
 */
export const environmentAnalysis: Analyzer<EnvironmentAnalysis> = {
  id: 'environment-analysis',
  async run(ctx) {
    const [project, tracked, sources, compose] = await Promise.all([
      ctx.use(manifests),
      ctx.use(gitTrackedFiles),
      ctx.use(sourceFiles),
      useOr(ctx, composeFiles, NO_COMPOSE),
    ])
    const composePaths = compose.files.map((file) => file.path)
    const serviceFiles = new Set(compose.envFiles.map((reference) => reference.path))
    const dirs = envFileDirectories(project, composePaths, [...serviceFiles])
    // Gitignored env files are exactly the ones that matter most, so ignored files are included.
    // Filtering both lists directly avoids re-sorting the whole index the way glob({ includeIgnored }) does.
    const mentionsEnv = (file: string) => file.includes('env')
    const candidates = [...ctx.files.files.filter(mentionsEnv), ...ctx.files.ignoredFiles.filter(mentionsEnv)]
    const envPaths = selectEnvFiles(candidates, dirs)

    const envFiles = await mapLimit(envPaths, ENV_FILE_CONCURRENCY, (path) =>
      loadEnvFile(ctx, path, tracked, serviceFiles),
    )
    const documented = new Set(
      envFiles
        .filter((parsed) => parsed.file.kind === 'example')
        .flatMap((parsed) => parsed.entries.map((e) => e.name)),
    )
    const collected = await collectUsages(ctx, sources, composePaths, documented)
    const variables = mergeVariables(envFiles, collected.usages, collected.implicit)
    const unused = new Set(variables.filter((variable) => !variable.used).map((variable) => variable.name))
    ctx.debug(`environment: ${envFiles.length} env files, ${variables.length} variables`)
    return {
      section: {
        files: envFiles.map((parsed) => parsed.file),
        variables,
        usageTruncated: sources.truncated,
      },
      // Files are read concurrently: keep only the mentions that matter, so the set is deterministic.
      mentioned: new Set([...collected.mentioned].filter((name) => unused.has(name)).sort(compareText)),
      configProvided: new Set([...collected.configProvided].sort(compareText)),
    }
  },
}

export const environmentDetector: Detector<'environment'> = {
  id: 'environment',
  title: 'Environment',
  async run(ctx) {
    return (await ctx.use(environmentAnalysis)).section
  },
}
