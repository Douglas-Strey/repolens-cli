import type { ScanResult } from '../types.ts'

/** Full scan result as pretty-printed JSON (see docs/json-schema.md). */
export function renderJson(result: ScanResult): string {
  return `${JSON.stringify(result, null, 2)}\n`
}

/** Doctor-only JSON document for `repolens doctor --json`. */
export function renderDoctorJson(result: ScanResult): string {
  const document = {
    schemaVersion: result.schemaVersion,
    tool: result.tool,
    project: { name: result.project.name, directory: result.project.directory },
    checks: result.doctor.checks,
    diagnostics: result.doctor.diagnostics,
    summary: result.doctor.summary,
    config: result.meta.config,
  }
  return `${JSON.stringify(document, null, 2)}\n`
}
