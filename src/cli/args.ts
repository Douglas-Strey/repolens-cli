import { parseArgs } from 'node:util'
import { RepoLensError } from '../core/errors.ts'
import type { FailOn } from '../types.ts'
import { closestWord } from '../utils/suggest.ts'

export { closestWord, editDistance } from '../utils/suggest.ts'
export type { FailOn }

export const COMMANDS = ['scan', 'doctor', 'report', 'agent', 'config', 'help'] as const
export type Command = (typeof COMMANDS)[number]

const FAIL_ON_VALUES: readonly FailOn[] = ['error', 'warning', 'info', 'never']

export interface CliArgs {
  command: Command
  /** `agent init` */
  subcommand?: 'init'
  /** Command the user asked help for (`repolens help doctor`, `repolens doctor --help`). */
  helpTopic?: Command
  cwd?: string
  json: boolean
  markdown: boolean
  quiet: boolean
  verbose: boolean
  /** true = force color, false = disable, undefined = auto */
  color?: boolean
  output?: string
  force: boolean
  /** --fail-on / --strict; undefined when not given, so the configuration's `doctor.failOn` can apply. */
  failOn?: FailOn
  /** --config: a configuration file to use instead of the project's own. */
  config?: string
  /** --no-config: apply no configuration file at all. */
  noConfig: boolean
  help: boolean
  version: boolean
  maxFiles?: number
}

export interface ParseOptions {
  /**
   * Whether a positional path names an existing directory. Without it, a lone
   * positional is always a path; with it, a word close to a command name that
   * is not a directory (`repolens doktor`) is reported as a mistyped command.
   */
  isDirectory?: (path: string) => boolean
}

const OPTIONS = {
  json: { type: 'boolean' },
  markdown: { type: 'boolean' },
  quiet: { type: 'boolean', short: 'q' },
  verbose: { type: 'boolean', short: 'v' },
  color: { type: 'boolean' },
  'no-color': { type: 'boolean' },
  cwd: { type: 'string', short: 'C' },
  output: { type: 'string', short: 'o' },
  force: { type: 'boolean', short: 'f' },
  strict: { type: 'boolean' },
  'fail-on': { type: 'string' },
  'max-files': { type: 'string' },
  config: { type: 'string' },
  'no-config': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'V' },
} as const

function isCommand(value: string | undefined): value is Command {
  return value !== undefined && (COMMANDS as readonly string[]).includes(value)
}

function invalid(message: string): RepoLensError {
  return new RepoLensError('INVALID_ARGUMENT', message)
}

function unknownCommand(typed: string, suggestion: string | undefined): RepoLensError {
  return invalid(
    suggestion ? `Unknown command "${typed}". Did you mean "${suggestion}"?` : `Unknown command "${typed}"`,
  )
}

/** Flags that only make sense for some commands are rejected elsewhere instead of being silently ignored. */
function checkFlagsApply(args: CliArgs, values: { strict?: boolean; 'fail-on'?: string }): void {
  const { command } = args
  if (args.quiet && args.verbose) throw invalid('Use either --quiet or --verbose, not both')
  if (args.json && args.markdown) throw invalid('Use either --json or --markdown, not both')
  if (args.config !== undefined && args.noConfig) throw invalid('Use either --config or --no-config, not both')
  if (command === 'config') {
    for (const [flag, given] of [
      ['--markdown', args.markdown],
      ['--output', args.output !== undefined],
      ['--max-files', args.maxFiles !== undefined],
      ['--quiet', args.quiet],
      ['--verbose', args.verbose],
    ] as const) {
      if (given) throw invalid(`${flag} does not apply to config, which prints the settings in effect`)
    }
  }
  if (command !== 'doctor') {
    if (values.strict) throw invalid('--strict only applies to doctor (repolens doctor --strict)')
    if (values['fail-on'] !== undefined) throw invalid('--fail-on only applies to doctor (repolens doctor --fail-on)')
  }
  if (args.force && !(command === 'agent' && args.subcommand === 'init')) {
    throw invalid('--force only applies to agent init (repolens agent init --force)')
  }
  if (command === 'agent' && args.json) {
    throw invalid('--json is not available for agent. Use repolens --json for the full scan result as JSON')
  }
  if (command === 'agent' && args.markdown) {
    throw invalid('--markdown does not apply to agent, which always writes Markdown')
  }
  if (command === 'doctor' && args.markdown) {
    throw invalid(
      '--markdown is not available for doctor. Use repolens report: its "Potential problems" section lists every finding',
    )
  }
  if (command === 'report' && args.json) {
    throw invalid('--json is not available for report, which is always Markdown. Use repolens --json instead')
  }
}

export function parseCliArgs(argv: readonly string[], options: ParseOptions = {}): CliArgs {
  // `pnpm dev -- ../x --verbose` forwards the `--` separator; a single leading one carries no meaning.
  const input = argv[0] === '--' ? argv.slice(1) : [...argv]
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true; strict: true }>>
  try {
    parsed = parseArgs({ args: input, options: OPTIONS, allowPositionals: true, strict: true })
  } catch (error) {
    const message = (error as Error).message.replace(/\. To specify a positional argument.*$/s, '')
    throw invalid(message)
  }
  const { values, positionals } = parsed
  const rest = [...positionals]

  let command: Command = 'scan'
  const explicitCommand = isCommand(rest[0])
  if (explicitCommand) command = rest.shift() as Command

  const args: CliArgs = {
    command,
    json: values.json === true,
    markdown: values.markdown === true,
    quiet: values.quiet === true,
    verbose: values.verbose === true,
    force: values.force === true,
    noConfig: values['no-config'] === true,
    help: values.help === true,
    version: values.version === true,
  }

  // `repolens doctor --help` shows doctor's help; a bare `repolens --help` shows the overview.
  if (args.help && explicitCommand && command !== 'help') args.helpTopic = command

  if (command === 'help') {
    const topic = rest.shift()
    if (topic !== undefined) {
      if (!isCommand(topic)) throw unknownCommand(topic, closestWord(topic, COMMANDS))
      args.helpTopic = topic
    }
    if (rest.length > 0) throw invalid(`Unexpected argument "${rest[0]}"`)
  }

  if (command === 'agent' && rest[0] === 'init') {
    rest.shift()
    args.subcommand = 'init'
  }

  // A positional that isn't a directory but reads like a misspelled command
  // (`repolens doktor`, `repolens agents init`, `repolens agent inti`).
  const first = rest[0]
  let typo: { typed: string; suggestion: string } | undefined
  if (first !== undefined && command !== 'help' && !(options.isDirectory?.(first) ?? false)) {
    if (!explicitCommand) {
      const suggestion = closestWord(first, COMMANDS)
      if (suggestion) typo = { typed: first, suggestion }
    } else if (command === 'agent' && args.subcommand === undefined && closestWord(first, ['init'])) {
      typo = { typed: `agent ${first}`, suggestion: 'agent init' }
    }
  }
  // With a single positional it may still be a directory name; only a known-missing one is a typo.
  if (typo && (rest.length > 1 || options.isDirectory !== undefined || values.cwd !== undefined)) {
    throw unknownCommand(typo.typed, typo.suggestion)
  }

  // An optional positional path: `repolens ../project`, `repolens doctor ../project`.
  const path = rest.shift()
  if (rest.length > 0) throw invalid(`Unexpected argument "${rest[0]}"`)
  if (path !== undefined && values.cwd !== undefined) {
    throw invalid('Pass the directory either as an argument or with --cwd, not both')
  }
  const cwd = path ?? values.cwd
  if (cwd !== undefined) args.cwd = cwd

  if (values['no-color']) args.color = false
  else if (values.color) args.color = true

  if (values.output !== undefined) args.output = values.output
  if (values.config !== undefined) args.config = values.config

  if (values.strict) args.failOn = 'warning'
  const failOn = values['fail-on']
  if (failOn !== undefined) {
    if (!FAIL_ON_VALUES.includes(failOn as FailOn)) {
      throw invalid(`--fail-on must be one of: ${FAIL_ON_VALUES.join(', ')}`)
    }
    args.failOn = failOn as FailOn
  }

  const maxFiles = values['max-files']
  if (maxFiles !== undefined) {
    // Plain digits only: Number() would also accept "1e3", "0x10" and " 5".
    const n = /^\d+$/.test(maxFiles) ? Number(maxFiles) : Number.NaN
    if (!Number.isSafeInteger(n) || n <= 0) throw invalid('--max-files must be a positive integer')
    args.maxFiles = n
  }

  // Help and version win over everything else, so `repolens doctor --json --help` still shows help.
  if (!args.help && !args.version && command !== 'help') checkFlagsApply(args, values)

  return args
}
