/**
 * Programmatic API.
 *
 *   import { scan } from 'repolens-cli'
 *   const result = await scan({ cwd: '/path/to/repo' })
 *
 * scan() applies the repository's own repolens.config.json; pass
 * `config: false` to ignore it, or a list from loadUserConfig /
 * loadProjectConfig / loadConfigFile to choose the files yourself.
 *
 * The result has the same shape as `repolens --json` (see docs/json-schema.md).
 */
import { defaultRenderOptions, type RenderOptions } from './output/style.ts'
import { renderDoctor as renderDoctorReport, renderScan as renderScanOverview } from './output/terminal.ts'
import type { ScanResult } from './types.ts'

export type { ContextOptions } from './agent/files.ts'
export { type AgentFile, renderAgentContext, renderAgentFiles } from './agent/index.ts'
export {
  loadConfigFile,
  loadProjectConfig,
  loadUserConfig,
  PROJECT_CONFIG_FILE,
  resolveConfig,
  userConfigPath,
  validateConfig,
} from './config/index.ts'
export { filterByConfidence } from './core/confidence.ts'
export { RepoLensError, type RepoLensErrorCode } from './core/errors.ts'
export { createContext, detect, scan } from './core/scan.ts'
export { detectors } from './detectors/index.ts'
export { runDoctor } from './doctor/index.ts'
export { doctorRules } from './doctor/rules/index.ts'
export { renderDoctorJson, renderJson } from './output/json.ts'
export { type MarkdownOptions, renderMarkdown } from './output/markdown.ts'
export { createStyle, defaultRenderOptions, type RenderOptions, type Style, type Symbols } from './output/style.ts'
export * from './types.ts'
export { VERSION } from './version.ts'

/**
 * The overview `repolens` prints. Options not given default to plain text:
 * no colors, Unicode symbols, 100 columns (see `defaultRenderOptions`).
 */
export function renderScan(result: ScanResult, options: Partial<RenderOptions> = {}): string {
  return renderScanOverview(result, defaultRenderOptions(options))
}

/** The diagnostics `repolens doctor` prints, with the same defaults as `renderScan`. */
export function renderDoctor(result: ScanResult, options: Partial<RenderOptions> = {}): string {
  return renderDoctorReport(result, defaultRenderOptions(options))
}
