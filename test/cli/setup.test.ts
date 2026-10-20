import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { type CliIO, EXIT_OK, EXIT_USAGE, main } from '../../src/cli/main.ts'
import { EXIT_SETUP_FAILED } from '../../src/cli/setup.ts'
import type { SetupHost } from '../../src/setup/host.ts'
import { canSymlink, makeProject, makeTempDir, runCli, TEST_NOW } from '../helpers.ts'

const posixOnly = process.platform === 'win32' ? it.skip : it
const symlinkOnly = process.platform !== 'win32' && canSymlink ? it : it.skip

const PROJECT = {
  'package.json': JSON.stringify({
    name: 'web',
    packageManager: 'pnpm@10.17.1',
    engines: { node: '>=22' },
    scripts: { dev: 'vite', postinstall: 'node scripts/setup.js' },
  }),
  '.env.example': 'DATABASE_URL=postgres://localhost:5432/app\nAPI_TOKEN=\n',
  'compose.yaml': 'services:\n  app:\n    build: .\n  db:\n    image: postgres:17\n',
}

interface FakeOptions {
  /** Programs on PATH, by name. */
  installed?: string[]
  /** Exit codes by program name (default 0). */
  exitCodes?: Record<string, number>
  nodeVersion?: string
}

interface Call {
  file: string
  args: readonly string[]
  cwd: string
}

function fakeHost(options: FakeOptions = {}): { host: SetupHost; calls: Call[] } {
  const installed = options.installed ?? ['docker', 'pnpm', 'npm', 'node', 'go']
  const calls: Call[] = []
  return {
    calls,
    host: {
      which: async (program) => (installed.includes(program) ? `/usr/bin/${program}` : null),
      run: async (file, args, cwd) => {
        calls.push({ file, args, cwd })
        return options.exitCodes?.[path.basename(file)] ?? 0
      },
      read: async () => options.nodeVersion ?? 'v24.1.0',
    },
  }
}

interface SetupRunResult {
  code: number
  stdout: string
  stderr: string
  calls: Call[]
  questions: string[]
}

async function runSetup(
  dir: string,
  argv: string[] = [],
  options: FakeOptions & { answer?: boolean | undefined; terminal?: boolean } = {},
): Promise<SetupRunResult> {
  const { host, calls } = fakeHost(options)
  const questions: string[] = []
  let stdout = ''
  let stderr = ''
  const io: CliIO = {
    stdout: { write: (chunk: string) => (stdout += chunk), isTTY: false, columns: 100 },
    stderr: { write: (chunk: string) => (stderr += chunk), isTTY: false },
    env: { NO_COLOR: '1' },
    cwd: dir,
    platform: 'linux',
    now: TEST_NOW,
    setupHost: host,
    ...(options.terminal === false
      ? {}
      : {
          confirm: async (question: string) => {
            questions.push(question)
            return options.answer ?? false
          },
        }),
  }
  const code = await main(['setup', ...argv], io)
  return { code, stdout, stderr, calls, questions }
}

async function exists(file: string): Promise<boolean> {
  return fs.lstat(file).then(
    () => true,
    () => false,
  )
}

describe('repolens setup', () => {
  it('--dry-run shows the plan with what it would run, and runs nothing', async () => {
    const dir = await makeProject(PROJECT)
    const run = await runSetup(dir, ['--dry-run'])
    expect(run.code).toBe(EXIT_OK)
    expect(run.stdout).toBe(
      [
        'Setup plan for web',
        '',
        '  1. cp .env.example .env     create your local environment file',
        '     · Then fill in your own values: the file starts as a copy of .env.example.',
        '  2. docker compose up -d db  start the backing services',
        '     · Pulls images if needed: postgres:17',
        '  3. pnpm install             install dependencies',
        '     · Runs these scripts from the repository:',
        '       postinstall (package.json): node scripts/setup.js',
        '     · Dependencies can run their own install scripts too. Use --ignore-scripts to skip them all.',
        '',
        'Dry run: nothing was run.',
        '',
      ].join('\n'),
    )
    expect(run.calls).toEqual([])
    expect(run.questions).toEqual([])
    expect(await exists(path.join(dir, '.env'))).toBe(false)
  })

  it('asks before running anything, and runs nothing on no', async () => {
    const dir = await makeProject(PROJECT)
    const run = await runSetup(dir, [], { answer: false })
    expect(run.questions).toEqual(['\nRun these 3 steps? [y/N] '])
    expect(run.code).toBe(EXIT_SETUP_FAILED)
    expect(run.stderr).toContain('Cancelled. Nothing was run.')
    expect(run.calls).toEqual([])
    expect(await exists(path.join(dir, '.env'))).toBe(false)
  })

  it('refuses to run without a terminal to ask in, unless --yes', async () => {
    const dir = await makeProject(PROJECT)
    const run = await runSetup(dir, [], { terminal: false })
    expect(run.code).toBe(EXIT_USAGE)
    expect(run.stderr).toContain('setup asks before running anything')
    expect(run.calls).toEqual([])
  })

  it('carries out the plan on yes', async () => {
    const dir = await makeProject(PROJECT)
    const run = await runSetup(dir, [], { answer: true })
    expect(run.code).toBe(EXIT_OK)
    expect(run.calls).toEqual([
      { file: '/usr/bin/docker', args: ['compose', 'up', '-d', 'db'], cwd: dir },
      { file: '/usr/bin/pnpm', args: ['install'], cwd: dir },
    ])
    expect(await fs.readFile(path.join(dir, '.env'), 'utf8')).toBe(PROJECT['.env.example'])
    expect(run.stdout).toContain('→ [1/3] cp .env.example .env')
    expect(run.stdout).toContain('✓ Setup finished.')
    expect(run.stdout).toContain('Next: pnpm dev  start the development server')
  })

  posixOnly('creates the env file readable by its owner only', async () => {
    const dir = await makeProject(PROJECT)
    await runSetup(dir, ['--yes'])
    expect((await fs.stat(path.join(dir, '.env'))).mode & 0o777).toBe(0o600)
  })

  it('--yes runs without asking, and --ignore-scripts installs without lifecycle scripts', async () => {
    const dir = await makeProject(PROJECT)
    const run = await runSetup(dir, ['--yes', '--ignore-scripts'])
    expect(run.code).toBe(EXIT_OK)
    expect(run.questions).toEqual([])
    expect(run.calls.at(-1)).toEqual({ file: '/usr/bin/pnpm', args: ['install', '--ignore-scripts'], cwd: dir })
  })

  it('stops at the first failing step', async () => {
    const dir = await makeProject(PROJECT)
    const run = await runSetup(dir, ['--yes'], { exitCodes: { docker: 1 } })
    expect(run.code).toBe(EXIT_SETUP_FAILED)
    expect(run.calls.map((call) => call.file)).toEqual(['/usr/bin/docker'])
    expect(run.stderr).toContain('docker compose up -d db failed with exit code 1')
  })

  it('runs nothing when a program is missing', async () => {
    const dir = await makeProject(PROJECT)
    const run = await runSetup(dir, ['--yes'], { installed: ['pnpm', 'node'] })
    expect(run.code).toBe(EXIT_SETUP_FAILED)
    expect(run.stderr).toContain('docker is not installed (not found on PATH)')
    expect(run.stderr).toContain('Nothing was run.')
    expect(run.calls).toEqual([])
    expect(await exists(path.join(dir, '.env'))).toBe(false)
  })

  it('runs nothing when the active Node.js is outside engines.node', async () => {
    const dir = await makeProject(PROJECT)
    const run = await runSetup(dir, ['--yes'], { nodeVersion: 'v20.11.0' })
    expect(run.code).toBe(EXIT_SETUP_FAILED)
    expect(run.stderr).toContain('Node.js v20.11.0 is active, but package.json requires >=22 (engines.node)')
    expect(run.calls).toEqual([])
  })

  it('only points out a Node.js version that differs from the .nvmrc pin', async () => {
    const dir = await makeProject({ ...PROJECT, '.nvmrc': '24\n' })
    const run = await runSetup(dir, ['--yes'], { nodeVersion: 'v26.0.0' })
    expect(run.code).toBe(EXIT_OK)
    expect(run.stdout).toContain('Node.js v26.0.0 is active, but .nvmrc pins 24')
    expect(run.calls).toHaveLength(2)
  })

  it('never overwrites an env file created after the scan', async () => {
    const dir = await makeProject(PROJECT)
    const { host } = fakeHost()
    let stdout = ''
    const io: CliIO = {
      stdout: { write: (chunk: string) => (stdout += chunk) },
      stderr: { write: () => true },
      env: { NO_COLOR: '1' },
      cwd: dir,
      platform: 'linux',
      setupHost: host,
      // The developer creates .env while setup waits for an answer.
      confirm: async () => {
        await fs.writeFile(path.join(dir, '.env'), 'MINE=1\n')
        return true
      },
    }
    expect(await main(['setup'], io)).toBe(EXIT_OK)
    expect(await fs.readFile(path.join(dir, '.env'), 'utf8')).toBe('MINE=1\n')
    expect(stdout).toContain('.env already exists; left it untouched')
  })

  symlinkOnly('refuses an example env file that links outside the project', async () => {
    const outside = path.join(await makeTempDir(), 'id_rsa')
    await fs.writeFile(outside, 'PRIVATE KEY\n')
    const dir = await makeProject({ 'package.json': JSON.stringify({ name: 'web' }) })
    await fs.symlink(outside, path.join(dir, '.env.example'))
    const run = await runSetup(dir, ['--yes'])
    expect(await exists(path.join(dir, '.env'))).toBe(false)
    expect(run.stdout + run.stderr).not.toContain('PRIVATE KEY')
  })

  it('says when there is nothing to do', async () => {
    const dir = await makeProject({ 'README.md': '# hi\n' })
    const run = await runSetup(dir, ['--yes'])
    expect(run.code).toBe(EXIT_OK)
    expect(run.stdout).toContain('Nothing for setup to do.')
    expect(run.calls).toEqual([])
  })

  it('rejects options that do not apply', async () => {
    for (const argv of [
      ['setup', '--json'],
      ['setup', '-o', 'x.md'],
      ['setup', '--yes', '--dry-run'],
      ['--yes'],
      ['doctor', '--ignore-scripts'],
    ]) {
      const run = await runCli(argv)
      expect(run.code, argv.join(' ')).toBe(EXIT_USAGE)
    }
  })

  it('has its own help', async () => {
    const run = await runCli(['setup', '--help'])
    expect(run.code).toBe(EXIT_OK)
    expect(run.stdout).toContain('repolens setup [path] [options]')
    expect(run.stdout).toContain('--ignore-scripts')
  })
})
