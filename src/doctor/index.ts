import { errorSummary } from '../core/errors.ts'
import type { CheckResult, Diagnostic, DoctorResult, DoctorRule, ProjectContext, Sections, Severity } from '../types.ts'
import { compareText } from '../utils/compare.ts'
import { doctorRules } from './rules/index.ts'

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 }

export function compareDiagnostics(a: Diagnostic, b: Diagnostic): number {
  return (
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
    compareText(a.category, b.category) ||
    compareText(a.code, b.code) ||
    compareText(a.subject ?? '', b.subject ?? '') ||
    compareText(a.message, b.message)
  )
}

/**
 * Run doctor rules against detected sections. A rule that throws is reported
 * as a scan warning and skipped. The configuration's `doctor.rules` turn
 * checks off ("disabled", never run) or set the severity of what they find.
 */
export async function runDoctor(
  sections: Sections,
  ctx: ProjectContext,
  rules: readonly DoctorRule[] = doctorRules,
): Promise<DoctorResult> {
  const checks: CheckResult[] = []
  const diagnostics: Diagnostic[] = []
  const settings = ctx.options.config?.settings.doctor?.rules ?? {}

  const run = async (rule: DoctorRule) => {
    const setting = Object.hasOwn(settings, rule.code) ? settings[rule.code] : undefined
    if (setting === 'off') return { rule, status: 'disabled' as const, found: [] }
    try {
      if (rule.applies && !(await rule.applies(sections, ctx))) return { rule, status: 'skipped' as const, found: [] }
      let found = await rule.check(sections, ctx)
      if (setting !== undefined) found = found.map((diagnostic) => ({ ...diagnostic, severity: setting }))
      return { rule, status: found.length > 0 ? ('failed' as const) : ('passed' as const), found }
    } catch (error) {
      ctx.warn({
        kind: 'error',
        message: `Doctor check ${rule.code} failed to run`,
        detail: errorSummary(error, ctx.root),
      })
      ctx.debug(`doctor ${rule.code} failed: ${String((error as Error)?.stack ?? error)}`)
      return { rule, status: 'skipped' as const, found: [] }
    }
  }
  // Rules marked `final` read ctx.warnings, so they run once the others are done.
  const outcomes = [
    ...(await Promise.all(rules.filter((rule) => !rule.final).map(run))),
    ...(await Promise.all(rules.filter((rule) => rule.final).map(run))),
  ]
  // Keep the declared rule order in the check list.
  outcomes.sort((a, b) => rules.indexOf(a.rule) - rules.indexOf(b.rule))

  for (const { rule, status, found } of outcomes) {
    checks.push({ code: rule.code, title: rule.title, category: rule.category, status })
    diagnostics.push(...found)
  }
  diagnostics.sort(compareDiagnostics)

  return {
    checks,
    diagnostics,
    summary: {
      passed: checks.filter((c) => c.status === 'passed').length,
      failed: checks.filter((c) => c.status === 'failed').length,
      skipped: checks.filter((c) => c.status === 'skipped').length,
      disabled: checks.filter((c) => c.status === 'disabled').length,
      errors: diagnostics.filter((d) => d.severity === 'error').length,
      warnings: diagnostics.filter((d) => d.severity === 'warning').length,
      infos: diagnostics.filter((d) => d.severity === 'info').length,
    },
  }
}
