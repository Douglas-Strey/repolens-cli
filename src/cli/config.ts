import { PROJECT_CONFIG_FILE } from '../config/load.ts'
import type { Style } from '../output/style.ts'
import type { EffectiveConfig } from '../types.ts'
import { cleanUntrusted } from '../utils/text.ts'
import type { CliConfig } from './main.ts'

const DOCS_URL = 'https://github.com/Douglas-Strey/repolens-cli/blob/main/docs/configuration.md'

interface ConfigFileInfo {
  kind: 'user' | 'project' | 'file'
  /** As shown to the user: "~/.config/repolens/config.json", "repolens.config.json". */
  path: string
  found: boolean
}

/** The files `repolens config` lists, in precedence order, found or not. */
export function configFiles(config: CliConfig, typedConfig: string | undefined): ConfigFileInfo[] {
  const files: ConfigFileInfo[] = []
  if (config.userPath) files.push({ kind: 'user', path: config.userPath, found: config.user !== null })
  if (typedConfig !== undefined) {
    files.push({ kind: 'file', path: typedConfig, found: config.second !== null })
  } else {
    files.push({
      kind: 'project',
      path: config.second?.source.file ?? PROJECT_CONFIG_FILE,
      found: config.second !== null,
    })
  }
  return files
}

const KIND_LABEL: Record<ConfigFileInfo['kind'], string> = {
  user: 'User config',
  project: 'Project config',
  file: '--config',
}

/** Settings as indented JSON, cleaned: a project's file is untrusted and could hold terminal escapes. */
function settingsLines(settings: EffectiveConfig['settings']): string[] {
  return JSON.stringify(settings, null, 2)
    .split('\n')
    .map((line) => (/^ */.exec(line)?.[0] ?? '') + cleanUntrusted(line, { oneLine: true }))
}

/**
 * What `repolens config` prints: the files RepoLens reads, which exist, and
 * the settings in effect after merging them.
 */
export function renderConfigInfo(
  config: CliConfig,
  effective: EffectiveConfig,
  options: { json: boolean; noConfig: boolean; typedConfig?: string; style: Style },
): string {
  const files = options.noConfig ? [] : configFiles(config, options.typedConfig)
  const output = config.user?.config.output ?? {}
  if (options.json) {
    const document = { files, settings: effective.settings, output }
    return `${JSON.stringify(document, null, 2)}\n`
  }

  const s = options.style
  const lines: string[] = [s.bold('RepoLens configuration'), '']
  if (options.noConfig) {
    lines.push(s.dim('Configuration files are turned off (--no-config).'), '')
  } else {
    lines.push(`${s.bold('Files')} ${s.dim('(later ones take precedence)')}`)
    const width = Math.max(...files.map((file) => KIND_LABEL[file.kind].length))
    for (const file of files) {
      const mark = file.found ? s.green(s.symbols.pass) : s.dim(s.symbols.dot)
      const status = file.found ? '' : `  ${s.dim('not found')}`
      lines.push(
        `  ${mark} ${KIND_LABEL[file.kind].padEnd(width)}  ${cleanUntrusted(file.path, { oneLine: true })}${status}`,
      )
    }
    lines.push('')
  }

  lines.push(s.bold('Settings'))
  if (Object.keys(effective.settings).length === 0) {
    lines.push(`  ${s.dim('None: RepoLens uses its defaults.')}`)
  } else {
    for (const line of settingsLines(effective.settings)) lines.push(`  ${line}`)
  }
  if (Object.keys(output).length > 0) {
    lines.push('', s.bold('Output'))
    if (output.color !== undefined) lines.push(`  color  ${output.color}`)
    if (output.ascii !== undefined) lines.push(`  ascii  ${output.ascii}`)
  }
  lines.push('', s.dim(`Docs: ${DOCS_URL}`))
  return `${lines.join('\n')}\n`
}
