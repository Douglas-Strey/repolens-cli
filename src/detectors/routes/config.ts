/**
 * Static reading of framework config files that change routes
 * (`next.config.*`, `nuxt.config.*`). Nothing is executed: a property counts
 * only when its value is a string literal, an array of them, or a same-file
 * string constant. Anything else is reported as dynamic, so callers keep their
 * defaults and say so in a note.
 */
import { normalizeRelative } from '../../utils/paths.ts'
import { argValue, type JsFile, parseJsFile, stringValues } from './js.ts'
import { skipSpaces } from './source.ts'

export type ConfigValue<T> = { kind: 'none' } | { kind: 'value'; value: T } | { kind: 'dynamic' }

const NONE = { kind: 'none' } as const
const DYNAMIC = { kind: 'dynamic' } as const

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Characters that may follow a property value in an object literal. */
const VALUE_END = new Set([',', '}', ';', ''])

/** End offset (after the closing quote) of the string or template literal at `start`, or -1. */
function literalEnd(code: string, start: number): number {
  const quote = code[start]
  for (let j = start + 1; j < code.length && j - start <= 2048; j++) {
    const ch = code[j]
    if (ch === '\\') j++
    else if (ch === quote) return j + 1
    else if (ch === '\n' && quote !== '`') return -1
  }
  return -1
}

/** End of the simple value (literal, array, identifier) starting at `start`, or -1 for anything else. */
function valueEnd(js: JsFile, start: number): number {
  const { code } = js.src
  const first = code[start]
  if (first === '[') {
    const close = js.src.closeOf.get(start)
    return close === undefined ? -1 : close + 1
  }
  if (first === '"' || first === "'" || first === '`') return literalEnd(code, start)
  const identifier = /^[A-Za-z_$][\w$]*/.exec(code.slice(start, start + 256))
  return identifier ? start + identifier[0].length : -1
}

/**
 * Values of every `key: value` property (and `{ key }` shorthand) in the file.
 * Booleans are skipped: `basePath: false` in a rewrite rule is not the
 * config option. Null marks a value that is not a literal.
 */
function propertyValues(js: JsFile, key: string): Array<string | string[] | null> {
  const { code } = js.src
  const name = escapeRegExp(key)
  const pattern = new RegExp(`(?<![\\w$.])(?:${name}|'${name}'|"${name}")\\s*(:|(?=[,}]))`, 'g')
  const out: Array<string | string[] | null> = []
  for (const match of code.matchAll(pattern)) {
    // A quoted key starts a literal of its own; only text around it must be code.
    const quoted = code[match.index] === "'" || code[match.index] === '"'
    if (quoted ? match.index > 0 && js.src.inLiteral(match.index - 1) : js.src.inLiteral(match.index)) continue
    if (match[1] !== ':') {
      let before = match.index - 1
      while (before >= 0 && /\s/.test(code[before] as string)) before--
      if (code[before] === '{' || code[before] === ',') out.push(js.constants.get(key) ?? null)
      continue
    }
    const start = skipSpaces(code, match.index + match[0].length)
    if (/^(?:true|false)\b/.test(code.slice(start, start + 6))) continue
    const end = valueEnd(js, start)
    if (end === -1 || !VALUE_END.has(code[skipSpaces(code, end)] ?? '')) {
      out.push(null)
      continue
    }
    const value = argValue(js.src, { start, end })
    if (value.kind === 'strings') {
      out.push(value.values)
    } else {
      const strings = stringValues(value, js.constants)
      out.push(strings?.length === 1 ? (strings[0] as string) : null)
    }
  }
  return out
}

/** The one value of `key`, when every occurrence agrees and is a literal. */
export function configValue(js: JsFile, key: string): ConfigValue<string | string[]> {
  const values = propertyValues(js, key)
  if (values.length === 0) return NONE
  const first = values[0]
  if (first === null || first === undefined) return DYNAMIC
  const same = JSON.stringify(first)
  return values.every((value) => value !== null && JSON.stringify(value) === same)
    ? { kind: 'value', value: first }
    : DYNAMIC
}

function parseConfig(file: string, text: string): JsFile {
  return parseJsFile(file, '.', text)
}

export interface NextConfig {
  /** Prefix of every route ("" when unset). */
  basePath: string
  /** Extensions of page and route files (`page.tsx`, `mdx`), or null for the defaults. */
  pageExtensions: string[] | null
  /** Options that are set but could not be read statically. */
  dynamic: Array<'basePath' | 'pageExtensions'>
}

/** Routing options of a `next.config.*` file (null text: no config file). */
export function parseNextConfig(text: string | null): NextConfig {
  const config: NextConfig = { basePath: '', pageExtensions: null, dynamic: [] }
  if (text === null) return config
  const js = parseConfig('next.config.js', text)
  const basePath = configValue(js, 'basePath')
  if (basePath.kind === 'value') {
    const value = basePath.value
    // Next.js requires a leading "/" and no trailing "/"; anything else would fail its own validation.
    if (typeof value === 'string' && /^\/[^\s?#]*[^/\s?#]$/.test(value)) config.basePath = value
    else if (value !== '') config.dynamic.push('basePath')
  } else if (basePath.kind === 'dynamic') {
    config.dynamic.push('basePath')
  }
  const extensions = configValue(js, 'pageExtensions')
  if (extensions.kind === 'value') {
    const list = Array.isArray(extensions.value) ? extensions.value : null
    const valid = list?.map((ext) => ext.replace(/^\./, '')).filter((ext) => /^[\w.-]{1,32}$/.test(ext))
    if (list && valid && valid.length === list.length && valid.length > 0) config.pageExtensions = valid
    else config.dynamic.push('pageExtensions')
  } else if (extensions.kind === 'dynamic') {
    config.dynamic.push('pageExtensions')
  }
  return config
}

export interface NuxtConfig {
  /** Source directory relative to the Nuxt package ("." for the package itself), or null for the default. */
  srcDir: string | null
  dynamic: Array<'srcDir'>
}

/** Routing options of a `nuxt.config.*` file (null text: no config file). */
export function parseNuxtConfig(text: string | null): NuxtConfig {
  const config: NuxtConfig = { srcDir: null, dynamic: [] }
  if (text === null) return config
  const srcDir = configValue(parseConfig('nuxt.config.ts', text), 'srcDir')
  if (srcDir.kind === 'value') {
    const value = typeof srcDir.value === 'string' ? srcDir.value : null
    // Aliases (`~`, `@`) and paths outside the package are not resolved.
    const normalized = value === null || /^[~@]/.test(value) ? null : normalizeRelative(value)
    if (normalized !== null) config.srcDir = normalized
    else if (value !== '') config.dynamic.push('srcDir')
  } else if (srcDir.kind === 'dynamic') {
    config.dynamic.push('srcDir')
  }
  return config
}

/** Config file names in lookup order. */
export const NEXT_CONFIG_FILES = [
  'next.config.ts',
  'next.config.mts',
  'next.config.mjs',
  'next.config.js',
  'next.config.cjs',
]
export const NUXT_CONFIG_FILES = [
  'nuxt.config.ts',
  'nuxt.config.mts',
  'nuxt.config.mjs',
  'nuxt.config.js',
  'nuxt.config.cjs',
]
