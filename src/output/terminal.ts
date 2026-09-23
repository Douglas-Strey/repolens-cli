/**
 * Human-readable terminal output for `repolens` and `repolens doctor`.
 *
 * Both renderers are pure: they turn a ScanResult into text and never touch
 * the file system or the terminal. `renderScan` hides low-confidence findings
 * itself unless `verbose` is set, so given the full result it can also say
 * how many routes it left out. Status is always carried by a symbol or a
 * word, never by color alone.
 */
import type { ScanResult } from '../types.ts'
import type { RenderOptions } from './style.ts'
import { renderDoctorReport } from './terminal/doctor.ts'
import { renderScanOverview } from './terminal/scan.ts'

/** Human-readable overview printed by `repolens` / `repolens scan`. */
export function renderScan(result: ScanResult, options: RenderOptions): string {
  return renderScanOverview(result, options)
}

/** Human-readable diagnostics printed by `repolens doctor`. */
export function renderDoctor(result: ScanResult, options: RenderOptions): string {
  return renderDoctorReport(result, options)
}
