import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateConfig } from '../../src/config/validate.ts'
import type { LoadedConfig, RepoLensConfig, ScanResult } from '../../src/types.ts'
import { copyFixture, gitInit, makeProject, runCli, SECRET_SENTINEL, scanDir } from '../helpers.ts'

function codes(result: ScanResult): string[] {
  return result.doctor.diagnostics.map((diagnostic) => diagnostic.code)
}

function userLayer(config: RepoLensConfig): LoadedConfig {
  return validateConfig(config, { kind: 'user' }, 'your user config')
}

async function withConfig(fixture: string, config: unknown): Promise<string> {
  const dir = await copyFixture(fixture)
  await fs.writeFile(path.join(dir, 'repolens.config.json'), JSON.stringify(config))
  return dir
}

describe('scan with a project config', () => {
  it('applies repolens.config.json by default and reports it in meta.config', async () => {
    const dir = await withConfig('broken-env', { doctor: { rules: { ENV_UNUSED: 'off' } } })
    const result = await scanDir(dir)
    expect(result.meta.config).toEqual({
      sources: [{ kind: 'project', file: 'repolens.config.json' }],
      settings: { doctor: { rules: { ENV_UNUSED: 'off' } } },
    })
    expect(result.doctor.checks.find((check) => check.code === 'ENV_UNUSED')?.status).toBe('disabled')
    expect(result.doctor.summary.disabled).toBe(1)
    expect(codes(result)).not.toContain('ENV_UNUSED')
    expect(result.configFiles.map((file) => file.path)).toContain('repolens.config.json')
  })

  it('ignores it with config: false', async () => {
    const dir = await withConfig('broken-env', { doctor: { rules: { ENV_UNUSED: 'off' } } })
    const result = await scanDir(dir, { config: false })
    expect(result.meta.config).toEqual({ sources: [], settings: {} })
    expect(result.doctor.summary.disabled).toBe(0)
  })

  it('sets the severity of what a check finds', async () => {
    const dir = await withConfig('broken-env', { doctor: { rules: { ENV_UNDOCUMENTED: 'error' } } })
    const found = (await scanDir(dir)).doctor.diagnostics.filter((d) => d.code === 'ENV_UNDOCUMENTED')
    expect(found.length).toBeGreaterThan(1)
    expect(new Set(found.map((d) => d.severity))).toEqual(new Set(['error']))
  })

  it('treats provided variables like platform ones', async () => {
    const before = await scanDir(await copyFixture('broken-env'))
    const subjects = (result: ScanResult) =>
      result.doctor.diagnostics.filter((d) => d.code.startsWith('ENV_')).map((d) => d.subject)
    expect(subjects(before)).toEqual(expect.arrayContaining(['ANALYTICS_KEY', 'LEGACY_TOKEN', 'VITE_SENTRY_DSN']))
    const dir = await withConfig('broken-env', {
      environment: { provided: ['ANALYTICS_KEY', 'LEGACY_*', 'VITE_SENTRY_*'] },
    })
    const after = await scanDir(dir)
    expect(subjects(after)).not.toEqual(expect.arrayContaining(['ANALYTICS_KEY']))
    expect(subjects(after)).not.toContain('LEGACY_TOKEN')
    expect(subjects(after)).not.toContain('VITE_SENTRY_DSN')
    // The environment section itself still lists them: only the checks change.
    expect(after.environment.variables.map((v) => v.name)).toContain('ANALYTICS_KEY')
  })

  it('leaves ignored directories out of the scan', async () => {
    const dir = await makeProject({
      'package.json': JSON.stringify({ name: 'app', dependencies: { express: '^5.0.0' } }),
      'src/server.ts': "import express from 'express'\nconst app = express()\napp.get('/health', () => {})\n",
      'legacy/old.ts': "import express from 'express'\nconst app = express()\napp.get('/old', () => {})\n",
      'repolens.config.json': JSON.stringify({ ignore: ['legacy/'] }),
    })
    const result = await scanDir(dir)
    expect(result.routes.routes.map((route) => route.path)).toEqual(['/health'])
    const unconfigured = await scanDir(dir, { config: false })
    expect(unconfigured.routes.routes.map((route) => route.path).sort()).toEqual(['/health', '/old'])
  })

  it("doesn't let an ignore pattern hide a local env file from the security checks", async () => {
    const dir = await makeProject({
      'package.json': '{"name":"app"}',
      '.env': `API_KEY=${SECRET_SENTINEL}\n`,
      '.env.example': 'API_KEY=\n',
      'src/index.js': 'console.log(process.env.API_KEY)\n',
      'repolens.config.json': JSON.stringify({ ignore: ['.env'] }),
    })
    gitInit(dir, ['package.json'])
    const result = await scanDir(dir)
    // Ignored by the configuration, not by Git: .env could still be committed by accident.
    expect(codes(result)).toContain('ENV_FILE_NOT_IGNORED')
    expect(JSON.stringify(result)).not.toContain(SECRET_SENTINEL)
  })

  it('uses maxFiles unless the caller passes one', async () => {
    const dir = await makeProject({
      'a.txt': '',
      'b.txt': '',
      'c.txt': '',
      'repolens.config.json': '{"maxFiles": 2}',
    })
    expect((await scanDir(dir)).meta).toMatchObject({ files: 2, truncated: true })
    expect((await scanDir(dir, { maxFiles: 10 })).meta).toMatchObject({ files: 4, truncated: false })
  })

  it('layers explicit files over each other, lowest precedence first', async () => {
    const dir = await withConfig('broken-env', { doctor: { rules: { ENV_UNUSED: 'warning' } } })
    const user = userLayer({ doctor: { rules: { ENV_UNUSED: 'off', ENV_LOCAL_ONLY: 'off' } } })
    const { loadProjectConfig } = await import('../../src/config/load.ts')
    const project = await loadProjectConfig(await fs.realpath(dir))
    const result = await scanDir(dir, { config: [user, project as LoadedConfig] })
    const status = (code: string) => result.doctor.checks.find((check) => check.code === code)?.status
    expect(status('ENV_LOCAL_ONLY')).toBe('disabled')
    expect(status('ENV_UNUSED')).not.toBe('disabled')
    expect(result.meta.config.sources).toEqual([{ kind: 'user' }, { kind: 'project', file: 'repolens.config.json' }])
  })

  it('reports configuration problems as warnings, never as a failed scan', async () => {
    const dir = await withConfig('broken-env', { doctor: { rules: { TRACKED_ENV_FILE: 'off', NOT_A_CHECK: 'off' } } })
    const result = await scanDir(dir)
    const config = result.meta.warnings.filter((warning) => warning.kind === 'config')
    expect(config.map((warning) => warning.message)).toEqual([
      'Unknown check "NOT_A_CHECK" in repolens.config.json; the setting was ignored',
      'repolens.config.json can only raise the security check TRACKED_ENV_FILE to "error"; turning it off or changing its severity takes your user config or a file passed with --config',
    ])
    expect(result.doctor.checks.find((check) => check.code === 'TRACKED_ENV_FILE')?.status).not.toBe('disabled')
  })
})

describe('CLI configuration', () => {
  it('prints configuration warnings to stderr, keeping --json output parseable', async () => {
    const dir = await withConfig('broken-env', { ignroe: ['x/'] })
    const run = await runCli(['--json', dir])
    expect(run.code).toBe(0)
    expect(JSON.parse(run.stdout).meta.config.sources).toEqual([{ kind: 'project', file: 'repolens.config.json' }])
    expect(run.stderr).toBe('⚠ Unknown setting "ignroe" in repolens.config.json (did you mean "ignore"?)\n')
  })

  it('shows that a project config shaped the results', async () => {
    const dir = await withConfig('broken-env', { ignore: ['legacy/'], doctor: { rules: { ENV_UNUSED: 'off' } } })
    const scan = await runCli([dir])
    expect(scan.stdout).toContain('Configured by repolens.config.json: 1 check turned off, 1 ignore pattern.')
    const doctor = await runCli(['doctor', dir])
    expect(doctor.stdout).toContain('Configured by repolens.config.json: 1 check turned off, 1 ignore pattern.')
    const report = await runCli(['report', dir])
    expect(report.stdout).toContain('Configured by repolens.config.json: 1 check turned off, 1 ignore pattern.')
    expect((await runCli(['--no-config', dir])).stdout).not.toContain('Configured by')
  })

  it('takes the doctor threshold from the config, and --fail-on over it', async () => {
    const dir = await withConfig('broken-env', { doctor: { failOn: 'never' } })
    expect((await runCli(['doctor', dir])).code).toBe(0)
    expect((await runCli(['doctor', '--strict', dir])).code).toBe(1)
    expect((await runCli(['doctor', '--no-config', '--fail-on', 'warning', dir])).code).toBe(1)
  })

  it('uses a --config file instead of the project one', async () => {
    const dir = await withConfig('broken-env', { doctor: { failOn: 'never' } })
    const other = await makeProject({ 'strict.json': '{"doctor": {"failOn": "info"}}' })
    const run = await runCli(['doctor', '--config', path.join(other, 'strict.json'), '--json', dir])
    expect(run.code).toBe(1)
    const missing = await runCli(['doctor', '--config', 'nope.json', dir], { cwd: other })
    expect(missing.code).toBe(2)
    expect(missing.stderr).toContain('Config file not found: nope.json')
    const both = await runCli(['--config', 'x.json', '--no-config', dir])
    expect(both.code).toBe(2)
    expect(both.stderr).toContain('Use either --config or --no-config, not both')
  })

  it('lets a --config file turn off security checks', async () => {
    const dir = await copyFixture('broken-env')
    await fs.writeFile(path.join(dir, 'ci.json'), '{"doctor": {"rules": {"ENV_PUBLIC_SECRET": "off"}}}')
    const run = await runCli(['doctor', '--json', '--config', 'ci.json', dir], { cwd: dir })
    const checks = JSON.parse(run.stdout).checks as { code: string; status: string }[]
    expect(checks.find((check) => check.code === 'ENV_PUBLIC_SECRET')?.status).toBe('disabled')
    expect(JSON.parse(run.stdout).config.sources).toEqual([{ kind: 'file', file: 'ci.json' }])
  })

  it('reads the user config and its output preferences', async () => {
    const dir = await copyFixture('broken-env')
    const home = await makeProject({
      '.config/repolens/config.json': '{"doctor": {"rules": {"ENV_LOCAL_ONLY": "off"}}, "output": {"ascii": true}}',
    })
    const run = await runCli(['doctor', dir], { env: { HOME: home } })
    expect(run.stdout).not.toContain('ENV_LOCAL_ONLY')
    expect(run.stdout).not.toContain('✓')
    // The user's own config is no news to them; --verbose names it.
    expect(run.stdout).not.toContain('Configured by')
    expect((await runCli(['doctor', '-v', dir], { env: { HOME: home } })).stdout).toContain(
      'Configured by your user config: 1 check turned off.',
    )
  })

  it('stops on a user config it cannot parse', async () => {
    const home = await makeProject({ '.config/repolens/config.json': '{"doctor": ' })
    const run = await runCli([await copyFixture('plain-repo')], { env: { HOME: home } })
    expect(run.code).toBe(2)
    expect(run.stderr).toMatch(/^✗ Couldn't parse config file ~[/\\]\.config[/\\]repolens[/\\]config\.json: /)
  })

  it('lists the files and settings in effect with repolens config', async () => {
    const dir = await withConfig('plain-repo', { ignore: ['tmp/'] })
    const home = await makeProject({})
    const run = await runCli(['config', dir], { env: { HOME: home } })
    expect(run.code).toBe(0)
    const sep = path.sep
    expect(run.stdout).toBe(
      [
        'RepoLens configuration',
        '',
        'Files (later ones take precedence)',
        `  · User config     ~${sep}.config${sep}repolens${sep}config.json  not found`,
        '  ✓ Project config  repolens.config.json',
        '',
        'Settings',
        '  {',
        '    "ignore": [',
        '      "tmp/"',
        '    ]',
        '  }',
        '',
        'Docs: https://github.com/Douglas-Strey/repolens-cli/blob/main/docs/configuration.md',
        '',
      ].join('\n'),
    )
    const json = JSON.parse((await runCli(['config', '--json', dir], { env: { HOME: home } })).stdout)
    expect(json).toEqual({
      files: [
        { kind: 'user', path: `~${sep}.config${sep}repolens${sep}config.json`, found: false },
        { kind: 'project', path: 'repolens.config.json', found: true },
      ],
      settings: { ignore: ['tmp/'] },
      output: {},
    })
    const none = await runCli(['config', '--no-config', dir])
    expect(none.stdout).toContain('Configuration files are turned off (--no-config).')
    expect(none.stdout).toContain('None: RepoLens uses its defaults.')
    expect((await runCli(['config', '--markdown', dir])).code).toBe(2)
  })
})
