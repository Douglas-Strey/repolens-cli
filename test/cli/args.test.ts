import { describe, expect, it } from 'vitest'
import {
  type CliArgs,
  COMMANDS,
  closestWord,
  editDistance,
  type ParseOptions,
  parseCliArgs,
} from '../../src/cli/args.ts'
import { RepoLensError } from '../../src/core/errors.ts'

function invalid(argv: string[], options?: ParseOptions): string {
  try {
    parseCliArgs(argv, options)
  } catch (error) {
    expect(error).toBeInstanceOf(RepoLensError)
    expect((error as RepoLensError).code).toBe('INVALID_ARGUMENT')
    return (error as RepoLensError).message
  }
  throw new Error(`expected ${JSON.stringify(argv)} to be rejected`)
}

const DEFAULTS: CliArgs = {
  command: 'scan',
  json: false,
  markdown: false,
  quiet: false,
  verbose: false,
  force: false,
  noConfig: false,
  help: false,
  version: false,
}

describe('parseCliArgs', () => {
  it('defaults to scanning the current directory', () => {
    expect(parseCliArgs([])).toEqual(DEFAULTS)
  })

  it('accepts a positional path for every command', () => {
    expect(parseCliArgs(['../project'])).toEqual({ ...DEFAULTS, cwd: '../project' })
    expect(parseCliArgs(['scan', 'x'])).toMatchObject({ command: 'scan', cwd: 'x' })
    expect(parseCliArgs(['doctor', 'x'])).toMatchObject({ command: 'doctor', cwd: 'x' })
    expect(parseCliArgs(['report', 'x', '--output', 'r.md'])).toMatchObject({
      command: 'report',
      cwd: 'x',
      output: 'r.md',
    })
    expect(parseCliArgs(['./doctor'])).toMatchObject({ command: 'scan', cwd: './doctor' })
  })

  it('accepts --cwd / -C, but not together with a positional path', () => {
    expect(parseCliArgs(['--cwd', 'x'])).toMatchObject({ cwd: 'x' })
    expect(parseCliArgs(['-C', 'x'])).toMatchObject({ cwd: 'x' })
    expect(parseCliArgs(['--cwd=x'])).toMatchObject({ cwd: 'x' })
    expect(invalid(['a', '--cwd', 'b'])).toContain('either as an argument or with --cwd')
  })

  it('rejects unknown options with a short message', () => {
    const message = invalid(['--nope'])
    expect(message).toContain("'--nope'")
    expect(message).not.toContain('positional argument')
    expect(invalid(['-z'])).toContain("'-z'")
  })

  it('rejects extra positionals', () => {
    expect(invalid(['a', 'b'])).toBe('Unexpected argument "b"')
    expect(invalid(['doctor', 'a', 'b'])).toBe('Unexpected argument "b"')
    expect(invalid(['help', 'doctor', 'extra'])).toBe('Unexpected argument "extra"')
  })

  it('rejects missing option values', () => {
    expect(invalid(['--output'])).toContain('--output')
    expect(invalid(['--cwd'])).toContain('--cwd')
  })

  it('rejects --json together with --markdown', () => {
    expect(invalid(['--json', '--markdown'])).toBe('Use either --json or --markdown, not both')
    expect(parseCliArgs(['--json'])).toMatchObject({ json: true, markdown: false })
    expect(parseCliArgs(['--markdown'])).toMatchObject({ json: false, markdown: true })
  })

  it('validates --fail-on and maps --strict to warning', () => {
    for (const level of ['error', 'warning', 'info', 'never'] as const) {
      expect(parseCliArgs(['doctor', '--fail-on', level]).failOn).toBe(level)
    }
    expect(parseCliArgs(['doctor', '--strict']).failOn).toBe('warning')
    expect(parseCliArgs(['doctor', '--strict', '--fail-on', 'info']).failOn).toBe('info')
    expect(parseCliArgs(['doctor', '--fail-on', 'never', '--strict']).failOn).toBe('never')
    expect(invalid(['doctor', '--fail-on', 'fatal'])).toBe('--fail-on must be one of: error, warning, info, never')
  })

  it('validates --max-files', () => {
    expect(parseCliArgs(['--max-files', '5000']).maxFiles).toBe(5000)
    expect(parseCliArgs(['--max-files=1']).maxFiles).toBe(1)
    for (const value of ['0', '-1', '1.5', 'abc', '1e3', '0x10', ' 5', '', '99999999999999999999']) {
      expect(invalid([`--max-files=${value}`])).toBe('--max-files must be a positive integer')
    }
  })

  it('parses color flags', () => {
    expect(parseCliArgs([]).color).toBeUndefined()
    expect(parseCliArgs(['--no-color']).color).toBe(false)
    expect(parseCliArgs(['--color']).color).toBe(true)
    expect(parseCliArgs(['--color', '--no-color']).color).toBe(false)
  })

  it('parses boolean shorthands', () => {
    expect(parseCliArgs(['-q', '-o', 'out.json'])).toMatchObject({ quiet: true, output: 'out.json' })
    expect(parseCliArgs(['-v'])).toMatchObject({ verbose: true })
    expect(parseCliArgs(['agent', 'init', '-f'])).toMatchObject({ force: true })
  })

  it('parses agent and agent init', () => {
    expect(parseCliArgs(['agent'])).toMatchObject({ command: 'agent' })
    expect(parseCliArgs(['agent'])).not.toHaveProperty('subcommand')
    expect(parseCliArgs(['agent', 'init'])).toMatchObject({ command: 'agent', subcommand: 'init' })
    expect(parseCliArgs(['agent', 'init', '../p', '--force'])).toMatchObject({
      command: 'agent',
      subcommand: 'init',
      cwd: '../p',
      force: true,
    })
    expect(parseCliArgs(['agent', '../p'])).toMatchObject({ command: 'agent', cwd: '../p' })
  })

  it('parses help, help topics, -h and -V', () => {
    expect(parseCliArgs(['help'])).toMatchObject({ command: 'help' })
    expect(parseCliArgs(['help'])).not.toHaveProperty('helpTopic')
    expect(parseCliArgs(['help', 'doctor'])).toMatchObject({ command: 'help', helpTopic: 'doctor' })
    expect(parseCliArgs(['help', 'help'])).toMatchObject({ command: 'help', helpTopic: 'help' })
    expect(invalid(['help', 'bogus'])).toBe('Unknown command "bogus"')
    expect(invalid(['help', 'doktor'])).toBe('Unknown command "doktor". Did you mean "doctor"?')
    expect(parseCliArgs(['-h'])).toMatchObject({ help: true })
    expect(parseCliArgs(['-h'])).not.toHaveProperty('helpTopic')
    expect(parseCliArgs(['doctor', '--help'])).toMatchObject({ command: 'doctor', help: true, helpTopic: 'doctor' })
    expect(parseCliArgs(['scan', '-h'])).toMatchObject({ command: 'scan', helpTopic: 'scan' })
    expect(parseCliArgs(['-V'])).toMatchObject({ version: true })
    expect(parseCliArgs(['--version'])).toMatchObject({ version: true })
  })

  it('treats arguments after -- as positionals', () => {
    expect(parseCliArgs(['--', '--', '--weird-dir'])).toMatchObject({ cwd: '--weird-dir' })
    expect(parseCliArgs(['doctor', '--', '--weird-dir'])).toMatchObject({ command: 'doctor', cwd: '--weird-dir' })
  })

  it('ignores a single leading -- forwarded by package managers (pnpm dev -- ../x --verbose)', () => {
    expect(parseCliArgs(['--', '../x', '--verbose'])).toEqual({ ...DEFAULTS, cwd: '../x', verbose: true })
    expect(parseCliArgs(['--', 'doctor', '--strict'])).toMatchObject({ command: 'doctor', failOn: 'warning' })
    expect(parseCliArgs(['--'])).toEqual(DEFAULTS)
  })
})

describe('mistyped commands', () => {
  const missing = { isDirectory: () => false }
  const existing = { isDirectory: () => true }

  it('suggests the closest command when the word is not a directory', () => {
    expect(invalid(['doktor'], missing)).toBe('Unknown command "doktor". Did you mean "doctor"?')
    expect(invalid(['reprot'], missing)).toBe('Unknown command "reprot". Did you mean "report"?')
    expect(invalid(['hlep'], missing)).toBe('Unknown command "hlep". Did you mean "help"?')
    expect(invalid(['Doctor'], missing)).toBe('Unknown command "Doctor". Did you mean "doctor"?')
    expect(invalid(['agent', 'inti'], missing)).toBe('Unknown command "agent inti". Did you mean "agent init"?')
  })

  it('reports a typo followed by more arguments, whether or not the file system is known', () => {
    expect(invalid(['docter', '.'])).toBe('Unknown command "docter". Did you mean "doctor"?')
    expect(invalid(['agents', 'init'])).toBe('Unknown command "agents". Did you mean "agent"?')
    expect(invalid(['doktor', '--cwd', 'x'])).toBe('Unknown command "doktor". Did you mean "doctor"?')
    // Not close to any command: still just an extra argument.
    expect(invalid(['foo', 'bar'])).toBe('Unexpected argument "bar"')
  })

  it('reports the typo before complaining about flags that only apply to the intended command', () => {
    expect(invalid(['doktor', '--strict'], missing)).toBe('Unknown command "doktor". Did you mean "doctor"?')
  })

  it('treats the word as a path when it is an existing directory or when nothing is known', () => {
    expect(parseCliArgs(['doktor'], existing)).toMatchObject({ command: 'scan', cwd: 'doktor' })
    expect(parseCliArgs(['doktor'])).toMatchObject({ command: 'scan', cwd: 'doktor' })
    expect(parseCliArgs(['agent', 'inti'], existing)).toMatchObject({ command: 'agent', cwd: 'inti' })
    expect(invalid(['doktor', 'x'], existing)).toBe('Unexpected argument "x"')
  })

  it('never treats path-like or distant words as commands', () => {
    for (const word of ['./doktor', 'apps/doktor', 'src', 'app', 'docs', 'tests', 'ep', 'x', 'doktor.md']) {
      expect(parseCliArgs([word], missing)).toMatchObject({ command: 'scan', cwd: word })
    }
    expect(parseCliArgs(['doctor', 'doktor'], missing)).toMatchObject({ command: 'doctor', cwd: 'doktor' })
  })
})

describe('closestWord / editDistance', () => {
  it('counts insertions, deletions, substitutions and transpositions', () => {
    expect(editDistance('doctor', 'doctor')).toBe(0)
    expect(editDistance('doktor', 'doctor')).toBe(1)
    expect(editDistance('hlep', 'help')).toBe(1)
    expect(editDistance('', 'scan')).toBe(4)
    expect(editDistance('scan', '')).toBe(4)
    expect(editDistance('repo', 'report')).toBe(2)
  })

  it('allows two edits, but only one for words of three letters or fewer', () => {
    expect(closestWord('repo', COMMANDS)).toBe('report')
    expect(closestWord('sca', COMMANDS)).toBe('scan')
    expect(closestWord('hl', COMMANDS)).toBeUndefined()
    expect(closestWord('rpeort', COMMANDS)).toBe('report')
    expect(closestWord('deploy', COMMANDS)).toBeUndefined()
  })
})

describe('flags that do not apply to the command', () => {
  it('rejects --strict and --fail-on outside doctor', () => {
    expect(invalid(['--strict'])).toBe('--strict only applies to doctor (repolens doctor --strict)')
    expect(invalid(['report', '--fail-on', 'warning'])).toBe(
      '--fail-on only applies to doctor (repolens doctor --fail-on)',
    )
    expect(invalid(['agent', 'init', '--strict'])).toContain('only applies to doctor')
  })

  it('rejects --force outside agent init', () => {
    for (const argv of [['-f'], ['doctor', '--force'], ['report', '-f'], ['agent', '--force']]) {
      expect(invalid(argv)).toBe('--force only applies to agent init (repolens agent init --force)')
    }
  })

  it('parses --config and --no-config, but not both', () => {
    expect(parseCliArgs(['--config', 'ci.json'])).toMatchObject({ config: 'ci.json', noConfig: false })
    expect(parseCliArgs(['doctor', '--no-config'])).toMatchObject({ command: 'doctor', noConfig: true })
    expect(parseCliArgs(['doctor']).failOn).toBeUndefined()
    expect(invalid(['--config', 'x.json', '--no-config'])).toBe('Use either --config or --no-config, not both')
  })

  it('accepts only --json, --config and --no-config for config', () => {
    expect(parseCliArgs(['config', '../app', '--json'])).toMatchObject({ command: 'config', cwd: '../app', json: true })
    expect(invalid(['config', '--markdown'])).toBe(
      '--markdown does not apply to config, which prints the settings in effect',
    )
    for (const flag of [['-o', 'x'], ['--max-files', '5'], ['-q'], ['-v']]) {
      expect(invalid(['config', ...flag])).toContain('does not apply to config')
    }
    expect(invalid(['confg', 'x', 'y'])).toBe('Unknown command "confg". Did you mean "config"?')
  })

  it('rejects --quiet together with --verbose', () => {
    expect(invalid(['-q', '-v'])).toBe('Use either --quiet or --verbose, not both')
    expect(invalid(['doctor', '--quiet', '--verbose'])).toBe('Use either --quiet or --verbose, not both')
  })

  it('rejects output formats a command does not have', () => {
    expect(invalid(['agent', '--json'])).toContain('Use repolens --json')
    expect(invalid(['agent', 'init', '--json'])).toContain('--json is not available for agent')
    expect(invalid(['agent', '--markdown'])).toContain('always writes Markdown')
    expect(invalid(['doctor', '--markdown'])).toContain('Use repolens report')
    expect(invalid(['report', '--json'])).toContain('Use repolens --json')
  })

  it('still accepts every documented combination', () => {
    expect(parseCliArgs(['doctor', '--json', '--strict', '-q'])).toMatchObject({ json: true, failOn: 'warning' })
    expect(parseCliArgs(['report', '--markdown', '-v', '-o', 'r.md'])).toMatchObject({ markdown: true })
    expect(parseCliArgs(['--markdown', '-o', 'r.md'])).toMatchObject({ markdown: true })
    expect(parseCliArgs(['agent', 'init', '--force', '-o', 'dir'])).toMatchObject({ force: true, output: 'dir' })
    expect(parseCliArgs(['agent', '-o', 'context.md', '-v'])).toMatchObject({ output: 'context.md', verbose: true })
  })

  it('lets --help and --version win over flag conflicts', () => {
    expect(parseCliArgs(['report', '--json', '--help'])).toMatchObject({ help: true, helpTopic: 'report' })
    expect(parseCliArgs(['--strict', '-V'])).toMatchObject({ version: true })
  })
})
