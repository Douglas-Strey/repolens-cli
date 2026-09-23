import { isRecord } from '../core/parse.ts'
import { ignoreRuleCost, MAX_IGNORE_RULES_PER_PATH } from '../core/walker.ts'
import type { ConfigSource, FailOn, LoadedConfig, RepoLensConfig, RuleSetting, ScanWarning } from '../types.ts'
import { findCredentialPattern } from '../utils/redact.ts'
import { closestMatch } from '../utils/suggest.ts'
import { cleanUntrusted } from '../utils/text.ts'

/** Highest `maxFiles` a configuration file may set; --max-files has no limit. */
export const MAX_CONFIG_FILES = 1_000_000
/** Entries read from one list (`ignore`, `environment.provided`); the rest are dropped with a warning. */
export const MAX_CONFIG_LIST = 1000
const MAX_PATTERN_LENGTH = 500

export const FAIL_ON_VALUES: readonly FailOn[] = ['error', 'warning', 'info', 'never']
export const RULE_SETTINGS: readonly RuleSetting[] = ['off', 'info', 'warning', 'error']
const COLOR_VALUES = ['auto', 'always', 'never'] as const

/** Shape of a diagnostic code: `ENV_UNDOCUMENTED`. Also keeps keys like `__proto__` out of the rules map. */
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/
/** A variable name, where `*` matches any characters: `FLY_*`, `*_URL`. */
const VARIABLE_PATTERN = /^[A-Za-z0-9_*]{1,128}$/

const KEYS: Record<string, readonly string[]> = {
  '': ['$schema', 'ignore', 'maxFiles', 'doctor', 'environment', 'output'],
  doctor: ['failOn', 'rules'],
  environment: ['provided'],
  output: ['color', 'ascii'],
}

/**
 * A key from the file, safe to put in a message: one line, printable, short,
 * and never something shaped like a credential. Values are never quoted.
 */
export function quoted(key: string): string {
  if (findCredentialPattern(key) !== null) return '(a key that looks like a credential)'
  const text = cleanUntrusted(key, { oneLine: true })
  return `"${text.length > 48 ? `${text.slice(0, 47)}…` : text}"`
}

function oneOf(values: readonly string[]): string {
  return values.join(', ')
}

class Validator {
  readonly warnings: ScanWarning[] = []
  readonly source: ConfigSource
  readonly label: string

  constructor(source: ConfigSource, label: string) {
    this.source = source
    this.label = label
  }

  warn(message: string): void {
    this.warnings.push({ kind: 'config', ...(this.source.file ? { file: this.source.file } : {}), message })
  }

  invalid(key: string, requirement: string): void {
    this.warn(`"${key}" in ${this.label} ${requirement}; the setting was ignored`)
  }

  /** The object at `key`, warning about keys RepoLens doesn't know. */
  object(value: unknown, key: string): Record<string, unknown> | undefined {
    if (!isRecord(value)) {
      if (key === '') this.warn(`${this.label} must contain a JSON object; it was ignored`)
      else this.invalid(key, 'must be an object')
      return undefined
    }
    const known = KEYS[key] ?? []
    for (const name of Object.keys(value)) {
      if (known.includes(name)) continue
      const path = key === '' ? name : `${key}.${name}`
      const suggestion = closestMatch(name, known)
      this.warn(
        `Unknown setting ${quoted(path)} in ${this.label}${suggestion ? ` (did you mean "${suggestion}"?)` : ''}`,
      )
    }
    return value
  }

  /** Strings of a list that pass `accept`; the others are reported once. */
  list(value: unknown, key: string, accept: (item: string) => string | null): string[] | undefined {
    if (value === undefined) return undefined
    if (!Array.isArray(value)) {
      this.invalid(key, 'must be a list of strings')
      return undefined
    }
    if (value.length > MAX_CONFIG_LIST) {
      this.warn(`"${key}" in ${this.label} has more than ${MAX_CONFIG_LIST} entries; the rest were ignored`)
    }
    const out: string[] = []
    // Entries are named by position: a value from the file is never echoed back.
    value.slice(0, MAX_CONFIG_LIST).forEach((item: unknown, index) => {
      const problem = typeof item === 'string' ? accept(item) : 'entries must be strings'
      if (problem !== null) {
        this.warn(`Ignored entry ${index + 1} of "${key}" in ${this.label}: ${problem}`)
      } else if (!out.includes(item as string)) {
        out.push(item as string)
      }
    })
    return out
  }
}

function ignorePatterns(v: Validator, value: unknown): string[] | undefined {
  let budget = MAX_IGNORE_RULES_PER_PATH
  return v.list(value, 'ignore', (pattern) => {
    if (pattern.trim() === '' || pattern.startsWith('#')) return 'it is not a pattern'
    if (pattern.length > MAX_PATTERN_LENGTH) return `patterns are limited to ${MAX_PATTERN_LENGTH} characters`
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
    if (/[\x00-\x1f\x7f]/.test(pattern)) return 'patterns must be one line of printable text'
    const cost = ignoreRuleCost(pattern)
    if (cost === Number.POSITIVE_INFINITY) return 'it uses too many "**" segments'
    if (cost > budget) return 'the patterns are too many or too complex to match quickly'
    budget -= cost
    return null
  })
}

function doctorSettings(v: Validator, value: unknown): RepoLensConfig['doctor'] {
  const doctor = v.object(value, 'doctor')
  if (!doctor) return undefined
  const out: NonNullable<RepoLensConfig['doctor']> = {}
  if (doctor.failOn !== undefined) {
    if (FAIL_ON_VALUES.includes(doctor.failOn as FailOn)) out.failOn = doctor.failOn as FailOn
    else v.invalid('doctor.failOn', `must be one of: ${oneOf(FAIL_ON_VALUES)}`)
  }
  if (doctor.rules !== undefined) {
    if (!isRecord(doctor.rules)) {
      v.invalid('doctor.rules', 'must be an object that maps check codes to a setting')
    } else {
      const rules: Record<string, RuleSetting> = {}
      for (const [code, setting] of Object.entries(doctor.rules)) {
        if (!CODE.test(code)) {
          v.warn(`Ignored ${quoted(code)} in "doctor.rules" of ${v.label}: it is not a check code like ENV_UNUSED`)
        } else if (!RULE_SETTINGS.includes(setting as RuleSetting)) {
          v.warn(`Ignored "doctor.rules.${code}" in ${v.label}: it must be one of: ${oneOf(RULE_SETTINGS)}`)
        } else {
          rules[code] = setting as RuleSetting
        }
      }
      out.rules = rules
    }
  }
  return out
}

function environmentSettings(v: Validator, value: unknown): RepoLensConfig['environment'] {
  const environment = v.object(value, 'environment')
  if (!environment) return undefined
  const provided = v.list(environment.provided, 'environment.provided', (name) =>
    VARIABLE_PATTERN.test(name) ? null : 'use variable names, with * as a wildcard',
  )
  return provided ? { provided } : {}
}

function outputSettings(v: Validator, value: unknown, source: ConfigSource): RepoLensConfig['output'] {
  if (source.kind !== 'user') {
    v.warn(`"output" is only read from your user config; the one in ${v.label} was ignored`)
    return undefined
  }
  const output = v.object(value, 'output')
  if (!output) return undefined
  const out: NonNullable<RepoLensConfig['output']> = {}
  if (output.color !== undefined) {
    if ((COLOR_VALUES as readonly unknown[]).includes(output.color)) out.color = output.color as 'auto'
    else v.invalid('output.color', `must be one of: ${oneOf(COLOR_VALUES)}`)
  }
  if (output.ascii !== undefined) {
    if (typeof output.ascii === 'boolean') out.ascii = output.ascii
    else v.invalid('output.ascii', 'must be true or false')
  }
  return out
}

/**
 * Check a parsed configuration file. Valid settings are kept; anything else
 * (unknown keys, wrong types, values out of range) is dropped with a
 * warning, so a file written for a newer RepoLens still works with this one.
 * `label` names the file in messages ("repolens.config.json", "your user config").
 */
export function validateConfig(raw: unknown, source: ConfigSource, label: string): LoadedConfig {
  const v = new Validator(source, label)
  const config: RepoLensConfig = {}
  const top = v.object(raw, '')
  if (top) {
    const ignore = ignorePatterns(v, top.ignore)
    if (ignore) config.ignore = ignore
    if (top.maxFiles !== undefined) {
      const n = top.maxFiles
      if (typeof n === 'number' && Number.isSafeInteger(n) && n >= 1 && n <= MAX_CONFIG_FILES) config.maxFiles = n
      else v.invalid('maxFiles', `must be a whole number from 1 to ${MAX_CONFIG_FILES}`)
    }
    if (top.doctor !== undefined) {
      const doctor = doctorSettings(v, top.doctor)
      if (doctor) config.doctor = doctor
    }
    if (top.environment !== undefined) {
      const environment = environmentSettings(v, top.environment)
      if (environment) config.environment = environment
    }
    if (top.output !== undefined) {
      const output = outputSettings(v, top.output, source)
      if (output) config.output = output
    }
  }
  return { source, label, config, warnings: v.warnings }
}
