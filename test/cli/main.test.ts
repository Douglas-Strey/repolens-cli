import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { GENERATED_MARKER } from '../../src/agent/index.ts'
import {
  type CliIO,
  displayPath,
  doctorShouldFail,
  EXIT_INTERNAL,
  EXIT_OK,
  EXIT_USAGE,
  failureReason,
  main,
  outputWidth,
  safeLines,
} from '../../src/cli/main.ts'
import { createStyle } from '../../src/output/style.ts'
import type { Diagnostic } from '../../src/types.ts'
import { VERSION } from '../../src/version.ts'
import { makeResult } from '../factories.ts'
import { canSymlink, copyFixture, expectNoPath, makeProject, makeTempDir, runCli, SECRET_SENTINEL } from '../helpers.ts'

const posixOnly = process.platform === 'win32' ? it.skip : it
const symlinkOnly = process.platform !== 'win32' && canSymlink ? it : it.skip
// Permission tests are meaningless when running as root, which can read and write anything.
const permissionsOnly = process.platform !== 'win32' && process.getuid?.() !== 0 ? it : it.skip
const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
const SYMBOLS = createStyle({ color: false, unicode: true }).symbols
const UNICODE_SYMBOLS = Object.values(SYMBOLS)
// biome-ignore lint/suspicious/noControlCharactersInRegex: detecting ANSI escapes is the point
const ANSI = /\u001b\[/
const STACK_LINE = /^\s+at .+[:(]/m

function diagnostic(severity: Diagnostic['severity']): Diagnostic {
  return { code: 'X', severity, category: 'tooling', message: 'x' }
}

describe('main: meta commands', () => {
  it('--version and -V print the version', async () => {
    for (const flag of ['--version', '-V']) {
      const run = await runCli([flag])
      expect(run).toEqual({ code: EXIT_OK, stdout: `${VERSION}\n`, stderr: '' })
    }
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('--help and help print usage and exit 0', async () => {
    const help = await runCli(['--help'])
    expect(help.code).toBe(EXIT_OK)
    expect(help.stdout).toContain('Usage')
    expect(help.stdout).toContain('repolens doctor')
    expect(help.stdout).toContain('https://github.com/Douglas-Strey/repolens-cli')
    expect(help.stderr).toBe('')
    expect((await runCli(['help'])).stdout).toBe(help.stdout)
  })

  it('prints command help', async () => {
    const doctor = await runCli(['help', 'doctor'])
    expect(doctor.code).toBe(EXIT_OK)
    expect(doctor.stdout).toContain('--fail-on')
    expect((await runCli(['doctor', '--help'])).stdout).toBe(doctor.stdout)
    const helpHelp = await runCli(['help', 'help'])
    expect(helpHelp.stdout).toContain('repolens help')
    // Only the help command's own help, not the full overview on top of it.
    expect(helpHelp.stdout).not.toContain('Usage')
    expect(helpHelp.stdout).not.toContain('Exit codes')
  })

  it('documents every option, environment variable and exit code', async () => {
    const { stdout } = await runCli(['--help'])
    for (const text of ['--max-files', '--color', '--no-color', 'REPOLENS_ASCII', 'REPOLENS_DEBUG', 'COLUMNS']) {
      expect(stdout).toContain(text)
    }
    expect(stdout).toContain('repolens agent [init] [path] [options]')
    expect(stdout).toMatch(/^ {2}2 {2}.*output file that couldn't be written$/m)
    expect((await runCli(['help', 'doctor'])).stdout).toContain(
      '-q, --quiet            Hide passing categories and hints',
    )
  })

  it('documents both meanings of agent --output', async () => {
    const { stdout } = await runCli(['help', 'agent'])
    expect(stdout).toContain('agent: the file to write agent-context.md to')
    expect(stdout).toContain('agent init: the directory for the generated files')
  })
})

describe('main: usage errors', () => {
  it('rejects an unknown flag with exit 2, a friendly message and no stack trace', async () => {
    const run = await runCli(['--bogus'])
    expect(run.code).toBe(EXIT_USAGE)
    expect(run.stdout).toBe('')
    expect(run.stderr).toContain("Unknown option '--bogus'")
    expect(run.stderr).toContain('Run repolens --help for usage.')
    expect(run.stderr).not.toMatch(STACK_LINE)
  })

  it('reports a missing directory with exit 2, named as typed', async () => {
    const cwd = await makeTempDir()
    const run = await runCli(['does-not-exist'], { cwd })
    expect(run.code).toBe(EXIT_USAGE)
    expect(run.stderr).toBe(`${SYMBOLS.fail} Directory not found: does-not-exist\n`)
    expect(run.stderr).not.toMatch(STACK_LINE)
    expect((await runCli(['--cwd', '../gone/x'], { cwd })).stderr).toContain('Directory not found: ../gone/x\n')
  })

  it('reports a file passed as the directory with exit 2', async () => {
    const cwd = await makeProject({ 'file.txt': 'x' })
    const run = await runCli(['file.txt'], { cwd })
    expect(run.code).toBe(EXIT_USAGE)
    expect(run.stderr).toContain('Not a directory: file.txt\n')
  })

  it('suggests a command for a mistyped one instead of looking for a directory', async () => {
    const cwd = await makeProject({ 'package.json': '{}' })
    for (const argv of [['doktor'], ['docter', '.'], ['agents', 'init'], ['agent', 'inti']]) {
      const run = await runCli(argv, { cwd })
      expect(run.code).toBe(EXIT_USAGE)
      expect(run.stdout).toBe('')
      expect(run.stderr).toMatch(/^\S+ Unknown command "[a-z ]+"\. Did you mean "(doctor|agent|agent init)"\?\n/)
      expect(run.stderr).not.toContain(cwd)
    }
  })

  it('scans a directory whose name is close to a command', async () => {
    const cwd = await makeProject({ 'doktor/package.json': '{"name":"doktor"}' })
    const run = await runCli(['doktor', '--json'], { cwd })
    expect(run.code).toBe(EXIT_OK)
    expect(JSON.parse(run.stdout).project.name).toBe('doktor')
  })

  it('rejects flags the command would ignore, before scanning', async () => {
    const cwd = await makeProject({ 'package.json': '{}' })
    for (const argv of [
      ['report', '--json'],
      ['doctor', '--markdown'],
      ['--strict'],
      ['agent', '--json'],
      ['-q', '-v'],
    ]) {
      const run = await runCli([...argv, '-o', 'out.txt'], { cwd })
      expect(run.code).toBe(EXIT_USAGE)
      expect(run.stdout).toBe('')
      expect(run.stderr).toContain('Run repolens --help for usage.')
    }
    await expect(fs.access(path.join(cwd, 'out.txt'))).rejects.toThrow()
  })

  it('ignores a leading -- forwarded by pnpm (pnpm dev -- <path> --json)', async () => {
    const root = await makeProject({ 'package.json': '{"name":"dashdash"}' })
    const run = await runCli(['--', root, '--json'])
    expect(run.code).toBe(EXIT_OK)
    expect(JSON.parse(run.stdout).project.name).toBe('dashdash')
  })
})

describe('main: scanning', () => {
  it('--json prints parseable JSON with schemaVersion 1 and no secrets', async () => {
    const root = await copyFixture('monorepo')
    const run = await runCli(['--json'], { cwd: root })
    expect(run.code).toBe(EXIT_OK)
    const parsed = JSON.parse(run.stdout) as { schemaVersion: number; tool: { name: string; version: string } }
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.tool).toEqual({ name: 'repolens', version: VERSION })
    expect(run.stdout).not.toContain(SECRET_SENTINEL)
    expectNoPath(run.stdout, root)
  })

  it('accepts the directory as a positional argument or with --cwd', async () => {
    const root = await copyFixture('monorepo')
    const parent = path.dirname(root)
    const positional = await runCli(['--json', path.basename(root)], { cwd: parent })
    const flag = await runCli(['--json', '--cwd', root], { cwd: '/' })
    expect(positional.code).toBe(EXIT_OK)
    expect(positional.stdout).toBe(flag.stdout)
  })

  it('doctor --fail-on never always exits 0', async () => {
    const root = await copyFixture('legacy-config')
    const run = await runCli(['doctor', '--fail-on', 'never', '--json'], { cwd: root })
    expect(run.code).toBe(EXIT_OK)
    expect(() => JSON.parse(run.stdout)).not.toThrow()
  })

  it('--output writes to a file and reports it', async () => {
    const root = await copyFixture('monorepo')
    const out = await makeTempDir()
    const target = path.join(out, 'result.json')
    const run = await runCli(['--json', '--output', target], { cwd: root })
    expect(run.code).toBe(EXIT_OK)
    expect(run.stdout).toBe(`${SYMBOLS.pass} Wrote ${target}\n`)
    expect(JSON.parse(await fs.readFile(target, 'utf8')).schemaVersion).toBe(1)
    const quiet = await runCli(['--json', '-q', '-o', target], { cwd: root })
    expect(quiet.stdout).toBe('')
  })

  it('--output replaces an existing regular file', async () => {
    const root = await makeProject({ 'report.md': 'old content that is much longer than the new one '.repeat(100) })
    const run = await runCli(['report', '-o', 'report.md'], { cwd: root })
    expect(run.code).toBe(EXIT_OK)
    const written = await fs.readFile(path.join(root, 'report.md'), 'utf8')
    expect(written).not.toContain('old content')
  })

  posixOnly('--output refuses to write through a symlink planted in the repository', async () => {
    const victimDir = await makeProject({ '.bashrc': 'original' })
    const root = await makeProject({ 'package.json': '{}' })
    await fs.symlink(path.join(victimDir, '.bashrc'), path.join(root, 'repolens.md'))
    const run = await runCli(['report', '--output', 'repolens.md'], { cwd: root })
    expect(run.code).toBe(EXIT_USAGE)
    expect(run.stderr).toContain('Refusing to write repolens.md: it is a symbolic link')
    expect(await fs.readFile(path.join(victimDir, '.bashrc'), 'utf8')).toBe('original')
  })

  posixOnly(
    '--output refuses a FIFO instead of hanging',
    async () => {
      const root = await makeProject({ 'package.json': '{}' })
      execFileSync('mkfifo', [path.join(root, 'out.md')])
      const run = await runCli(['report', '-o', 'out.md'], { cwd: root })
      expect(run.code).toBe(EXIT_USAGE)
      expect(run.stderr).toContain('Refusing to write out.md')
    },
    10_000,
  )

  it('reports the output path exactly as typed', async () => {
    const root = await makeProject({ 'package.json': '{}', 'docs/.keep': '' })
    const run = await runCli(['report', '-o', './docs/../docs/report.md'], { cwd: root })
    expect(run.code).toBe(EXIT_OK)
    expect(run.stdout).toContain('Wrote ./docs/../docs/report.md\n')
    expect(await fs.readFile(path.join(root, 'docs', 'report.md'), 'utf8')).toContain('#')
  })

  it('--output into a missing directory fails with exit 2 and says why', async () => {
    const root = await makeProject({ 'package.json': '{}' })
    const run = await runCli(['--json', '-o', 'missing/dir/out.json'], { cwd: root })
    expect(run.code).toBe(EXIT_USAGE)
    expect(run.stderr).toContain("Couldn't write missing/dir/out.json (directory missing/dir does not exist)\n")
    // The raw system message is a technical detail for --verbose.
    expect(run.stderr).not.toContain('ENOENT')
    expect((await runCli(['--json', '-v', '-o', 'missing/dir/out.json'], { cwd: root })).stderr).toContain('ENOENT')
  })

  permissionsOnly('--output into a read-only directory says permission denied', async () => {
    const root = await makeProject({ 'package.json': '{}' })
    await fs.mkdir(path.join(root, 'locked'), { mode: 0o555 })
    try {
      const run = await runCli(['--json', '-o', 'locked/out.json'], { cwd: root })
      expect(run.code).toBe(EXIT_USAGE)
      expect(run.stderr).toContain("Couldn't write locked/out.json (permission denied)\n")
    } finally {
      await fs.chmod(path.join(root, 'locked'), 0o755)
    }
  })

  it('--output files have a fixed width and honor REPOLENS_ASCII', async () => {
    const root = await copyFixture('monorepo')
    const files: string[] = []
    for (const columns of [40, 140]) {
      const run = await runCli(['doctor', '--fail-on', 'never', '-o', `doctor-${columns}.txt`], { cwd: root, columns })
      expect(run.code).toBe(EXIT_OK)
      files.push(await fs.readFile(path.join(root, `doctor-${columns}.txt`), 'utf8'))
    }
    expect(files[0]).toBe(files[1])
    expect(files[0]).toContain(SYMBOLS.pass)

    const ascii = await runCli(['doctor', '--fail-on', 'never', '-o', 'ascii.txt'], {
      cwd: root,
      env: { REPOLENS_ASCII: '1' },
    })
    expect(ascii.code).toBe(EXIT_OK)
    const text = await fs.readFile(path.join(root, 'ascii.txt'), 'utf8')
    for (const symbol of UNICODE_SYMBOLS) expect(text).not.toContain(symbol)
  })
})

describe('main: --output and symbolic links', () => {
  symlinkOnly('refuses to write through a symlinked directory that leads out of the scanned repository', async () => {
    const victim = await makeTempDir()
    const root = await makeProject({ 'package.json': '{}' })
    await fs.symlink(victim, path.join(root, 'docs'))

    const report = await runCli(['report', '--output', 'docs/report.md'], { cwd: root })
    expect(report.code).toBe(EXIT_USAGE)
    expect(report.stderr).toContain(
      'Refusing to write docs/report.md: docs is a symbolic link that leads outside the scanned directory',
    )

    const agent = await runCli(['agent', '-o', 'docs'], { cwd: root })
    expect(agent.code).toBe(EXIT_USAGE)
    expect(agent.stderr).toContain('docs is a symbolic link that leads outside the scanned directory')

    const init = await runCli(['agent', 'init', '-o', 'docs/agents', '--force'], { cwd: root })
    expect(init.code).toBe(EXIT_USAGE)
    expect(init.stderr).toContain('Refusing to write docs/agents: docs is a symbolic link')

    const direct = await runCli(['agent', 'init', '-o', 'docs'], { cwd: root })
    expect(direct.code).toBe(EXIT_USAGE)

    expect(await fs.readdir(victim)).toEqual([])
  })

  symlinkOnly('refuses a dangling symlinked directory that would be created elsewhere', async () => {
    const victim = await makeTempDir()
    const root = await makeProject({ 'package.json': '{}' })
    await fs.symlink(path.join(victim, 'planted'), path.join(root, 'docs'))
    for (const argv of [
      ['report', '-o', 'docs/report.md'],
      ['agent', 'init', '-o', 'docs/agents'],
    ]) {
      const run = await runCli(argv, { cwd: root })
      expect(run.code).toBe(EXIT_USAGE)
      expect(run.stderr).toContain('docs is a symbolic link that leads outside the scanned directory')
    }
    expect(await fs.readdir(victim)).toEqual([])
  })

  symlinkOnly('also refuses when the repository itself is reached through a symlink', async () => {
    const victim = await makeTempDir()
    const root = await makeProject({ 'package.json': '{}' })
    await fs.symlink(victim, path.join(root, 'docs'))
    const cwd = await makeTempDir()
    await fs.symlink(root, path.join(cwd, 'repo'))
    const run = await runCli(['report', 'repo', '-o', 'repo/docs/report.md'], { cwd })
    expect(run.code).toBe(EXIT_USAGE)
    expect(run.stderr).toContain('repo/docs is a symbolic link that leads outside the scanned directory')
    expect(await fs.readdir(victim)).toEqual([])
  })

  symlinkOnly('follows symlinks that stay inside the repository or never enter it', async () => {
    const root = await makeProject({ 'package.json': '{}', 'site/docs/.keep': '' })
    await fs.symlink(path.join(root, 'site', 'docs'), path.join(root, 'docs'))
    const inside = await runCli(['report', '-o', 'docs/report.md'], { cwd: root })
    expect(inside.code).toBe(EXIT_OK)
    expect(await fs.readdir(path.join(root, 'site', 'docs'))).toContain('report.md')

    // The user's own symlink outside the scanned repository keeps normal semantics.
    const target = await makeTempDir()
    const cwd = await makeTempDir()
    await fs.symlink(target, path.join(cwd, 'reports'))
    const outside = await runCli(['report', root, '-o', 'reports/report.md'], { cwd })
    expect(outside.code).toBe(EXIT_OK)
    expect(await fs.readdir(target)).toEqual(['report.md'])
  })
})

describe('main: agent --output', () => {
  it('writes to a file, or into an existing directory', async () => {
    const root = await makeProject({ 'package.json': '{"name":"agent-out"}', 'notes/.keep': '' })
    const file = await runCli(['agent', '-o', 'context.md'], { cwd: root })
    expect(file).toMatchObject({ code: EXIT_OK, stdout: expect.stringContaining('Wrote context.md\n') })
    expect(await fs.readFile(path.join(root, 'context.md'), 'utf8')).toContain('agent-out')

    const dir = await runCli(['agent', '-o', 'notes'], { cwd: root })
    expect(dir.code).toBe(EXIT_OK)
    expect(dir.stdout).toContain(`Wrote ${path.join('notes', 'agent-context.md')}\n`)
    const written = await fs.readFile(path.join(root, 'notes', 'agent-context.md'), 'utf8')
    expect(written.startsWith(GENERATED_MARKER)).toBe(true)
  })

  it('treats a trailing slash as a directory', async () => {
    const root = await makeProject({ 'package.json': '{}' })
    const run = await runCli(['agent', '-o', 'missing/'], { cwd: root })
    expect(run.code).toBe(EXIT_USAGE)
    expect(run.stderr).toContain(
      `Couldn't write ${path.join('missing', 'agent-context.md')} (directory missing does not exist)`,
    )
  })
})

describe('main: agent init', () => {
  it('writes .repolens files and overwrites only its own files without --force', async () => {
    const root = await makeProject({ 'package.json': '{"name":"agent-demo"}' })
    const first = await runCli(['agent', 'init'], { cwd: root })
    expect(first.code).toBe(EXIT_OK)
    expect(first.stdout).toMatch(/Wrote \d+ files to \.repolens\n/)
    expect(first.stdout).toContain('Tip: point your agent at .repolens/agent-context.md from AGENTS.md or CLAUDE.md.')
    const file = path.join(root, '.repolens', 'agent-context.md')
    expect((await fs.readFile(file, 'utf8')).startsWith(GENERATED_MARKER)).toBe(true)

    // A generated file may be regenerated.
    expect((await runCli(['agent', 'init'], { cwd: root })).code).toBe(EXIT_OK)

    // A hand-written file is protected unless --force.
    await fs.writeFile(file, '# My own notes\n')
    const refused = await runCli(['agent', 'init'], { cwd: root })
    expect(refused.code).toBe(EXIT_USAGE)
    expect(refused.stderr).toContain('Refusing to overwrite files not generated by RepoLens: agent-context.md')
    expect(await fs.readFile(file, 'utf8')).toBe('# My own notes\n')

    const forced = await runCli(['agent', 'init', '--force'], { cwd: root })
    expect(forced.code).toBe(EXIT_OK)
    expect((await fs.readFile(file, 'utf8')).startsWith(GENERATED_MARKER)).toBe(true)
  })

  it('shows where files went relative to cwd, and the tip relative to the project', async () => {
    const parent = await makeTempDir()
    await fs.mkdir(path.join(parent, 'proj'))
    await fs.writeFile(path.join(parent, 'proj', 'package.json'), '{}')

    const below = await runCli(['agent', 'init', 'proj'], { cwd: parent })
    expect(below.code).toBe(EXIT_OK)
    expect(below.stdout).toContain(`Wrote 8 files to ${path.join('proj', '.repolens')}\n`)
    expect(below.stdout).toContain('point your agent at .repolens/agent-context.md')

    // A path climbing out of cwd is shown absolute instead of as ../../...
    await fs.mkdir(path.join(parent, 'elsewhere'))
    const beside = await runCli(['agent', 'init', '../proj'], { cwd: path.join(parent, 'elsewhere') })
    expect(beside.code).toBe(EXIT_OK)
    expect(beside.stdout).toContain(`Wrote 8 files to ${path.join(parent, 'proj', '.repolens')}\n`)
    expect(beside.stdout).toContain('point your agent at .repolens/agent-context.md')

    const custom = await runCli(['agent', 'init', '-o', 'docs/agents'], { cwd: path.join(parent, 'proj') })
    expect(custom.stdout).toContain('Wrote 8 files to docs/agents\n')
    expect(custom.stdout).toContain('point your agent at docs/agents/agent-context.md')
  })

  it('--quiet suppresses the summary and --output picks the directory', async () => {
    const root = await makeProject({ 'package.json': '{}' })
    const out = await makeTempDir()
    const run = await runCli(['agent', 'init', '-q', '-o', out], { cwd: root })
    expect(run).toMatchObject({ code: EXIT_OK, stdout: '' })
    expect(await fs.readdir(out)).toContain('agent-context.md')
  })

  posixOnly('never writes through a planted .repolens symlink, even with --force', async () => {
    const elsewhere = await makeTempDir()
    const root = await makeProject({ 'package.json': '{}' })
    await fs.symlink(elsewhere, path.join(root, '.repolens'))
    const run = await runCli(['agent', 'init', '--force'], { cwd: root })
    expect(run.code).toBe(EXIT_USAGE)
    expect(run.stderr).toContain('Refusing to write to .repolens: it is a symbolic link')
    expect(await fs.readdir(elsewhere)).toEqual([])
  })

  posixOnly('never writes through a planted file symlink, even with --force', async () => {
    const victimDir = await makeProject({ target: `${GENERATED_MARKER} fake -->` })
    const root = await makeProject({ 'package.json': '{}' })
    await fs.mkdir(path.join(root, '.repolens'))
    await fs.symlink(path.join(victimDir, 'target'), path.join(root, '.repolens', 'agent-context.md'))
    const run = await runCli(['agent', 'init', '--force'], { cwd: root })
    expect(run.code).toBe(EXIT_USAGE)
    expect(run.stderr).toContain('it is a symbolic link')
    expect(await fs.readFile(path.join(victimDir, 'target'), 'utf8')).toBe(`${GENERATED_MARKER} fake -->`)
  })

  posixOnly(
    'does not hang on a planted FIFO',
    async () => {
      const root = await makeProject({ 'package.json': '{}' })
      await fs.mkdir(path.join(root, '.repolens'))
      execFileSync('mkfifo', [path.join(root, '.repolens', 'agent-context.md')])
      const run = await runCli(['agent', 'init'], { cwd: root })
      expect(run.code).toBe(EXIT_USAGE)
      expect(run.stderr).toContain('not a regular file')
    },
    10_000,
  )
})

describe('main: colors', () => {
  it('emits no ANSI escapes with NO_COLOR or --no-color', async () => {
    expect((await runCli(['--help'])).stdout).not.toMatch(ANSI)
    const flag = await runCli(['--help', '--no-color'], { env: { NO_COLOR: '', FORCE_COLOR: '1' } })
    expect(flag.stdout).not.toMatch(ANSI)
  })

  it('emits ANSI escapes with FORCE_COLOR=1 or --color', async () => {
    expect((await runCli(['--help'], { env: { NO_COLOR: '', FORCE_COLOR: '1' } })).stdout).toMatch(ANSI)
    expect((await runCli(['--help', '--color'])).stdout).toMatch(ANSI)
  })

  it('never colors files written with --output', async () => {
    const root = await makeProject({ 'package.json': '{"name":"x"}' })
    const run = await runCli(['doctor', '--color', '--fail-on', 'never', '-o', 'doctor.txt'], { cwd: root })
    expect(run.code).toBe(EXIT_OK)
    expect(await fs.readFile(path.join(root, 'doctor.txt'), 'utf8')).not.toMatch(ANSI)
  })
})

describe('main: unexpected errors', () => {
  async function runWithBrokenStdout(argv: string[], cwd: string, message = 'stdout exploded') {
    let stderr = ''
    const io: CliIO = {
      stdout: {
        write: () => {
          throw new Error(message)
        },
        isTTY: false,
      },
      stderr: { write: (chunk: string) => (stderr += chunk), isTTY: false },
      env: { NO_COLOR: '1' },
      cwd,
      platform: 'linux',
    }
    return { code: await main(argv, io), stderr }
  }

  it('prints a short message without a stack trace and exits 3', async () => {
    const root = await makeProject({ 'package.json': '{}' })
    const run = await runWithBrokenStdout([], root)
    expect(run.code).toBe(EXIT_INTERNAL)
    expect(run.stderr).toContain('RepoLens hit an unexpected error: stdout exploded')
    expect(run.stderr).toContain('Run with --verbose to see technical details.')
    expect(run.stderr).toContain('https://github.com/Douglas-Strey/repolens-cli/issues')
    expect(run.stderr).not.toMatch(STACK_LINE)
  })

  it('shows the stack trace with --verbose', async () => {
    const root = await makeProject({ 'package.json': '{}' })
    const run = await runWithBrokenStdout(['--verbose'], root)
    expect(run.code).toBe(EXIT_INTERNAL)
    expect(run.stderr).toMatch(STACK_LINE)
  })

  it('strips terminal escapes from the message and the stack', async () => {
    const root = await makeProject({ 'package.json': '{}' })
    const hostile = `bad ${ESC}]52;c;SGVsbG8=${BEL} name\r${ESC}[2J`
    for (const argv of [[], ['--verbose']]) {
      const run = await runWithBrokenStdout(argv, root, hostile)
      expect(run.code).toBe(EXIT_INTERNAL)
      expect(run.stderr).toContain('RepoLens hit an unexpected error: bad ]52;c;SGVsbG8= name [2J')
      expect(run.stderr).not.toContain(ESC)
      expect(run.stderr).not.toContain(BEL)
      expect(run.stderr).not.toContain('\r')
    }
  })
})

describe('main: debug output', () => {
  it('--verbose alone prints no [debug] lines; REPOLENS_DEBUG=1 does', async () => {
    const root = await makeProject({ 'package.json': '{}' })
    const verbose = await runCli(['--verbose'], { cwd: root })
    expect(verbose.code).toBe(EXIT_OK)
    expect(verbose.stderr).not.toContain('[debug]')

    const debug = await runCli([], { cwd: root, env: { REPOLENS_DEBUG: '1' } })
    expect(debug.code).toBe(EXIT_OK)
    expect(debug.stderr).toMatch(/^\[debug\] detector project: \d+ms$/m)
    expect(debug.stdout).toBe((await runCli([], { cwd: root })).stdout)
    expect((await runCli([], { cwd: root, env: { REPOLENS_DEBUG: '0' } })).stderr).toBe('')
  })

  permissionsOnly('strips terminal escapes from repository paths in debug lines', async () => {
    const root = await makeProject({ 'package.json': '{}' })
    const evil = path.join(root, `evil${ESC}]52;c;SGVsbG8=${BEL}${ESC}[2Jx`)
    await fs.mkdir(evil, { mode: 0o000 })
    try {
      const run = await runCli([], { cwd: root, env: { REPOLENS_DEBUG: '1' } })
      expect(run.code).toBe(EXIT_OK)
      expect(run.stderr).toContain('[debug] walk: cannot read evil]52;c;SGVsbG8=[2Jx (EACCES)')
      expect(run.stderr).not.toContain(ESC)
      expect(run.stderr).not.toContain(BEL)
    } finally {
      await fs.chmod(evil, 0o755)
    }
  })

  it('never echoes escapes from a typed path', async () => {
    const cwd = await makeTempDir()
    const run = await runCli([`doc${ESC}[2Jtor`], { cwd })
    expect(run.code).toBe(EXIT_USAGE)
    expect(run.stderr).toBe(`${SYMBOLS.fail} Directory not found: doc[2Jtor\n`)
  })
})

describe('safeLines', () => {
  it('removes control characters, keeps line structure and indentation', () => {
    expect(safeLines(`Error: x${ESC}[31m\n    at f (a.ts:1:2)\r\n\tat g`)).toEqual([
      'Error: x[31m',
      '    at f (a.ts:1:2)',
      'at g',
    ])
    expect(safeLines(`a\rb${String.fromCharCode(0x2028)}c`)).toEqual(['a b c'])
  })
})

describe('outputWidth', () => {
  it('uses the terminal width, then COLUMNS, then the stream, then 100, within 40..140', () => {
    expect(outputWidth({ write: () => {}, isTTY: true, columns: 120 }, { COLUMNS: '60' })).toBe(120)
    expect(outputWidth({ write: () => {}, isTTY: false }, { COLUMNS: '60' })).toBe(60)
    expect(outputWidth({ write: () => {}, isTTY: true }, { COLUMNS: '72' })).toBe(72)
    expect(outputWidth({ write: () => {}, isTTY: false, columns: 90 }, {})).toBe(90)
    expect(outputWidth({ write: () => {} }, {})).toBe(100)
    expect(outputWidth({ write: () => {} }, { COLUMNS: '20' })).toBe(40)
    expect(outputWidth({ write: () => {} }, { COLUMNS: '500' })).toBe(140)
    for (const COLUMNS of ['', '0', 'wide', '-5', '8e1'])
      expect(outputWidth({ write: () => {} }, { COLUMNS })).toBe(100)
  })
})

describe('failureReason and displayPath', () => {
  const failure = (code: string) => Object.assign(new Error(code), { code })

  it('explains common write failures in plain words', () => {
    expect(failureReason(failure('ENOENT'), 'out')).toBe('directory out does not exist')
    expect(failureReason(failure('EACCES'), 'out')).toBe('permission denied')
    expect(failureReason(failure('EPERM'), 'out')).toBe('permission denied')
    expect(failureReason(failure('EISDIR'), 'out')).toBe('it is a directory')
    expect(failureReason(failure('EWHATEVER'), 'out')).toBeUndefined()
    expect(failureReason(new Error('no code'), 'out')).toBeUndefined()
  })

  it('shows a path relative to cwd unless it climbs out of it', () => {
    const cwd = path.resolve('/work/project')
    expect(displayPath(path.join(cwd, '.repolens'), cwd)).toBe('.repolens')
    expect(displayPath(cwd, cwd)).toBe('.')
    expect(displayPath(path.resolve('/work/other/.repolens'), cwd)).toBe(path.resolve('/work/other/.repolens'))
    expect(displayPath(path.join(cwd, '..foo'), cwd)).toBe('..foo')
  })
})

describe('doctorShouldFail', () => {
  const result = (...severities: Diagnostic['severity'][]) =>
    makeResult({
      doctor: {
        checks: [],
        diagnostics: severities.map(diagnostic),
        summary: { passed: 0, failed: 0, skipped: 0, disabled: 0, errors: 0, warnings: 0, infos: 0 },
      },
    })

  it.each([
    [[], 'error', false],
    [['error'], 'error', true],
    [['warning'], 'error', false],
    [['warning'], 'warning', true],
    [['info'], 'warning', false],
    [['info'], 'info', true],
    [['error'], 'never', false],
  ] as const)('%j with --fail-on %s → %s', (severities, failOn, expected) => {
    expect(doctorShouldFail(result(...severities), failOn)).toBe(expected)
  })
})
