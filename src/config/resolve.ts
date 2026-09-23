import type { DoctorRule, EffectiveConfig, FailOn, LoadedConfig, RuleSetting, ScanWarning } from '../types.ts'
import { compareText } from '../utils/compare.ts'
import { closestMatch } from '../utils/suggest.ts'
import { quoted } from './validate.ts'

export const NO_CONFIG: EffectiveConfig = Object.freeze({ sources: [], settings: {} }) as EffectiveConfig

type RuleInfo = Pick<DoctorRule, 'code' | 'category'>

/**
 * Merge configuration files, lowest precedence first. Later files override
 * single values (`maxFiles`, `doctor.failOn`, each `doctor.rules` entry);
 * lists (`ignore`, `environment.provided`) accumulate.
 *
 * Settings for checks that don't exist are dropped with a suggestion. A
 * project's own file can't turn off or lower a security check: RepoLens is
 * often pointed at repositories nobody has reviewed yet, and those must not
 * be able to hide their own security findings. The user config and --config
 * files can.
 */
export function resolveConfig(
  layers: readonly LoadedConfig[],
  rules: readonly RuleInfo[],
): { config: EffectiveConfig; warnings: ScanWarning[] } {
  const warnings: ScanWarning[] = layers.flatMap((layer) => layer.warnings)
  if (layers.length === 0) return { config: NO_CONFIG, warnings }

  const byCode = new Map(rules.map((rule) => [rule.code, rule]))
  const ignore: string[] = []
  const provided: string[] = []
  const ruleSettings = new Map<string, RuleSetting>()
  let maxFiles: number | undefined
  let failOn: FailOn | undefined

  for (const { source, label, config } of layers) {
    const warn = (message: string) =>
      warnings.push({ kind: 'config', ...(source.file ? { file: source.file } : {}), message })
    for (const pattern of config.ignore ?? []) if (!ignore.includes(pattern)) ignore.push(pattern)
    maxFiles = config.maxFiles ?? maxFiles
    failOn = config.doctor?.failOn ?? failOn
    for (const [code, setting] of Object.entries(config.doctor?.rules ?? {})) {
      const rule = byCode.get(code)
      if (!rule) {
        const suggestion = closestMatch(code, byCode.keys())
        warn(
          `Unknown check ${quoted(code)} in ${label}${suggestion ? ` (did you mean ${suggestion}?)` : ''}; the setting was ignored`,
        )
        continue
      }
      if (source.kind === 'project' && rule.category === 'security' && setting !== 'error') {
        warn(
          `${label} can only raise the security check ${code} to "error"; turning it off or changing its severity takes your user config or a file passed with --config`,
        )
        continue
      }
      ruleSettings.set(code, setting)
    }
    for (const name of config.environment?.provided ?? []) if (!provided.includes(name)) provided.push(name)
  }

  // Built in a fixed key order, so JSON output doesn't depend on which file set what.
  const settings: EffectiveConfig['settings'] = {}
  if (ignore.length > 0) settings.ignore = ignore
  if (maxFiles !== undefined) settings.maxFiles = maxFiles
  if (failOn !== undefined || ruleSettings.size > 0) {
    settings.doctor = {
      ...(failOn !== undefined ? { failOn } : {}),
      ...(ruleSettings.size > 0
        ? { rules: Object.fromEntries([...ruleSettings].sort(([a], [b]) => compareText(a, b))) }
        : {}),
    }
  }
  if (provided.length > 0) settings.environment = { provided }
  return { config: { sources: layers.map((layer) => layer.source), settings }, warnings }
}

/** Does a variable name match one of the `environment.provided` patterns (`*` matches any characters)? */
export function isProvided(name: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchWildcard(pattern, name))
}

/**
 * `*` wildcard matching without regular expressions: linear in practice and
 * never exponential, whatever pattern a configuration file holds.
 */
export function matchWildcard(pattern: string, text: string): boolean {
  let p = 0
  let t = 0
  let star = -1
  let resume = 0
  while (t < text.length) {
    if (p < pattern.length && pattern[p] !== '*' && pattern[p] === text[t]) {
      p++
      t++
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p++
      resume = t
    } else if (star !== -1) {
      p = star + 1
      t = ++resume
    } else {
      return false
    }
  }
  while (pattern[p] === '*') p++
  return p === pattern.length
}
