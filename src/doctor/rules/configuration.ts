import { manifests } from '../../facts/manifests.ts'
import type { Diagnostic, DoctorRule, ScanWarning } from '../../types.ts'
import { compareText } from '../../utils/compare.ts'
import { safeText } from './shared.ts'

/** Files RepoLens may parse as configuration (JSON, JSONC, YAML, go.mod). */
const CONFIG_FILE = /\.(?:json|jsonc|json5|ya?ml)$|(?:^|\/)go\.mod$/

export function findInvalidPackageJson(rootInvalid: boolean): Diagnostic[] {
  if (!rootInvalid) return []
  return [
    {
      code: 'PACKAGE_JSON_INVALID',
      severity: 'error',
      category: 'configuration',
      message: 'package.json is not valid JSON',
      hint: 'Fix the syntax error (often a trailing comma or a missing quote); until then RepoLens and your package manager cannot read scripts or dependencies',
      files: ['package.json'],
      subject: 'package.json',
    },
  ]
}

/**
 * One diagnostic per parse warning (kind "parse"; messages are never
 * matched). The parser detail is left out on purpose: parser messages can
 * quote the offending text.
 */
export function findParseErrors(warnings: readonly ScanWarning[]): Diagnostic[] {
  const out: Diagnostic[] = []
  const seen = new Set<string>()
  for (const warning of warnings) {
    if (warning.kind !== 'parse') continue
    // The root package.json is covered by PACKAGE_JSON_INVALID.
    if (warning.file === 'package.json') continue
    const message = safeText(warning.message, 200)
    const subject = warning.file ?? message
    if (seen.has(subject)) continue
    seen.add(subject)
    const diagnostic: Diagnostic = {
      code: 'CONFIG_PARSE_ERROR',
      severity: 'warning',
      category: 'configuration',
      message,
      hint: warning.file
        ? `Fix the syntax error in ${warning.file}; RepoLens skipped it (run with --verbose to see the parser message)`
        : 'Fix the syntax error; RepoLens skipped the file (run with --verbose to see the parser message)',
      subject,
    }
    if (warning.file) diagnostic.files = [warning.file]
    out.push(diagnostic)
  }
  // Warnings arrive in completion order of concurrent reads; sort for stable output.
  return out.sort((a, b) => compareText(a.subject ?? '', b.subject ?? ''))
}

export const packageJsonInvalid: DoctorRule = {
  code: 'PACKAGE_JSON_INVALID',
  category: 'configuration',
  title: 'package.json is valid JSON',
  applies: (_scan, ctx) => ctx.files.has('package.json'),
  async check(_scan, ctx) {
    const project = await ctx.use(manifests)
    return findInvalidPackageJson(project.rootInvalid)
  },
}

/**
 * Runs after every other rule (`final`): detectors and rules record parse
 * warnings while they read, so ctx.warnings is only complete at the end.
 */
export const configParseError: DoctorRule = {
  code: 'CONFIG_PARSE_ERROR',
  category: 'configuration',
  title: 'Configuration files parse',
  final: true,
  applies: (_scan, ctx) =>
    ctx.warnings.some((warning) => warning.kind === 'parse') || ctx.files.files.some((file) => CONFIG_FILE.test(file)),
  check(_scan, ctx) {
    return findParseErrors(ctx.warnings)
  },
}

export const configurationRules: DoctorRule[] = [packageJsonInvalid, configParseError]
