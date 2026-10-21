import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadProjectConfigs } from '../../src/config/load.ts'
import type { ScanResult } from '../../src/types.ts'
import { canSymlink, expectNoPath, gitInit, makeProject, makeTempDir, runCli, scanDir } from '../helpers.ts'

const symlinkOnly = process.platform !== 'win32' && canSymlink ? it : it.skip

/** A pnpm-style monorepo with a web app that reads two env vars and has generated code. */
const MONOREPO = {
  'package.json': JSON.stringify({ name: 'acme', private: true, workspaces: ['apps/*'] }),
  'package-lock.json': '{"lockfileVersion":3}',
  'apps/web/package.json': JSON.stringify({ name: 'web', scripts: { dev: 'vite' } }),
  'apps/web/src/main.ts': 'console.log(process.env.API_URL, process.env.FLY_REGION)\n',
  'apps/web/legacy/client.ts': 'console.log(process.env.LEGACY_ONLY)\n',
}

async function monorepo(rootConfig: unknown, extra: Record<string, string> = {}): Promise<string> {
  const dir = await makeProject({
    ...MONOREPO,
    ...(rootConfig === undefined ? {} : { 'repolens.config.json': JSON.stringify(rootConfig) }),
    ...extra,
  })
  gitInit(dir)
  return dir
}

const variables = (result: ScanResult) => result.environment.variables.map((variable) => variable.name)
const status = (result: ScanResult, code: string) => result.doctor.checks.find((check) => check.code === code)?.status

describe('repository root configuration', () => {
  it('applies the root config when a subdirectory is scanned, named by its relative path', async () => {
    const dir = await monorepo({
      doctor: { rules: { SCRIPT_MISSING_TEST: 'off' } },
      environment: { provided: ['FLY_*'] },
    })
    const result = await scanDir(path.join(dir, 'apps/web'))
    expect(result.meta.config.sources).toEqual([{ kind: 'project', file: '../../repolens.config.json' }])
    expect(status(result, 'SCRIPT_MISSING_TEST')).toBe('disabled')
    expect(result.meta.config.settings.environment).toEqual({ provided: ['FLY_*'] })
    expectNoPath(JSON.stringify(result), dir)
  })

  it('matches the root config ignore patterns relative to the root', async () => {
    const dir = await monorepo({ ignore: ['apps/web/legacy/', 'packages/'] })
    const result = await scanDir(path.join(dir, 'apps/web'))
    expect(result.meta.config.rootIgnore).toEqual({
      prefix: 'apps/web',
      patterns: ['apps/web/legacy/', 'packages/'],
    })
    expect(result.meta.config.settings.ignore).toBeUndefined()
    expect(variables(result)).toContain('API_URL')
    expect(variables(result)).not.toContain('LEGACY_ONLY')
    // Without the root config the legacy code is scanned.
    expect(variables(await scanDir(path.join(dir, 'apps/web'), { config: false }))).toContain('LEGACY_ONLY')
  })

  it('lets the scanned directory override single values and add to lists', async () => {
    const dir = await monorepo(
      { doctor: { failOn: 'info', rules: { SCRIPT_MISSING_TEST: 'off' } }, environment: { provided: ['FLY_*'] } },
      {
        'apps/web/repolens.config.json': JSON.stringify({
          doctor: { failOn: 'warning', rules: { SCRIPT_MISSING_TEST: 'error' } },
          environment: { provided: ['API_URL'] },
        }),
      },
    )
    const result = await scanDir(path.join(dir, 'apps/web'))
    expect(result.meta.config.sources).toEqual([
      { kind: 'project', file: '../../repolens.config.json' },
      { kind: 'project', file: 'repolens.config.json' },
    ])
    expect(result.meta.config.settings.doctor?.failOn).toBe('warning')
    expect(result.meta.config.settings.doctor?.rules).toEqual({ SCRIPT_MISSING_TEST: 'error' })
    expect(result.meta.config.settings.environment).toEqual({ provided: ['FLY_*', 'API_URL'] })
  })

  it('reads the root config once when the root itself is scanned', async () => {
    const dir = await monorepo({ doctor: { failOn: 'warning' } })
    const result = await scanDir(dir)
    expect(result.meta.config.sources).toEqual([{ kind: 'project', file: 'repolens.config.json' }])
    expect(result.meta.config.rootIgnore).toBeUndefined()
  })

  it('reads nothing above the scanned directory outside a Git repository', async () => {
    const dir = await makeProject({
      ...MONOREPO,
      'repolens.config.json': JSON.stringify({ doctor: { failOn: 'info' } }),
    })
    expect(await loadProjectConfigs(path.join(dir, 'apps/web'))).toEqual([])
    expect((await scanDir(path.join(dir, 'apps/web'))).meta.config.sources).toEqual([])
  })

  it('stops at the repository root, never reading a config above it', async () => {
    const outer = await makeTempDir()
    await fs.writeFile(path.join(outer, 'repolens.config.json'), JSON.stringify({ doctor: { failOn: 'info' } }))
    const dir = path.join(outer, 'repo')
    await fs.mkdir(dir)
    for (const [file, content] of Object.entries(MONOREPO)) {
      await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true })
      await fs.writeFile(path.join(dir, file), content)
    }
    gitInit(dir)
    expect((await scanDir(path.join(dir, 'apps/web'))).meta.config.sources).toEqual([])
  })

  it('reads the "repolens" key of the root package.json too', async () => {
    const dir = await monorepo(undefined, {
      'package.json': JSON.stringify({ name: 'acme', private: true, repolens: { doctor: { failOn: 'never' } } }),
    })
    const result = await scanDir(path.join(dir, 'apps/web'))
    expect(result.meta.config.sources).toEqual([{ kind: 'project', file: '../../package.json' }])
    expect(result.meta.config.settings.doctor?.failOn).toBe('never')
  })

  it("holds the root config to a project's limits on security checks", async () => {
    const dir = await monorepo({
      doctor: { rules: { TRACKED_ENV_FILE: 'off' }, ignore: [{ code: 'ENV_PUBLIC_SECRET', subject: '*' }] },
    })
    const result = await scanDir(path.join(dir, 'apps/web'))
    expect(status(result, 'TRACKED_ENV_FILE')).not.toBe('disabled')
    expect(result.meta.warnings.filter((w) => w.kind === 'config').map((w) => w.message)).toEqual([
      '../../repolens.config.json can only raise the security check TRACKED_ENV_FILE to "error"; turning it off or changing its severity takes your user config or a file passed with --config',
      "../../repolens.config.json can't ignore findings of the security check ENV_PUBLIC_SECRET; that takes your user config or a file passed with --config",
    ])
  })

  symlinkOnly('refuses a root config that links outside the repository', async () => {
    const outside = path.join(await makeTempDir(), 'evil.json')
    await fs.writeFile(outside, JSON.stringify({ doctor: { failOn: 'never' } }))
    const dir = await monorepo(undefined)
    await fs.symlink(outside, path.join(dir, 'repolens.config.json'))
    const result = await scanDir(path.join(dir, 'apps/web'))
    expect(result.meta.config.settings).toEqual({})
    expect(result.meta.warnings.map((w) => w.message).join('\n')).toContain(
      '../../repolens.config.json is a symbolic link to a file outside the scanned directory; it was ignored',
    )
  })

  it('lets --config replace both project files, and --no-config turn them off', async () => {
    const dir = await monorepo({ doctor: { failOn: 'info' } })
    const web = path.join(dir, 'apps/web')
    await fs.writeFile(path.join(web, 'ci.json'), JSON.stringify({ doctor: { failOn: 'never' } }))
    const withFile = JSON.parse((await runCli(['config', '--json', '--config', 'ci.json', web], { cwd: web })).stdout)
    expect(withFile.files.map((file: { kind: string }) => file.kind)).toEqual(['file'])
    expect(withFile.settings).toEqual({ doctor: { failOn: 'never' } })
    const off = JSON.parse((await runCli(['config', '--json', '--no-config', web])).stdout)
    expect(off.settings).toEqual({})
  })

  it('lists the root config in repolens config and in the configured-by note', async () => {
    const dir = await monorepo({ ignore: ['apps/web/legacy/'], doctor: { rules: { SCRIPT_MISSING_TEST: 'off' } } })
    const web = path.join(dir, 'apps/web')
    const info = await runCli(['config', web])
    expect(info.stdout).toMatch(/Repository root config +\.\.\/\.\.\/repolens\.config\.json/)
    expect(info.stdout).toContain('Ignore patterns from the repository root (matched as apps/web/<path>)')
    expect(info.stdout).toContain('  apps/web/legacy/')
    const json = JSON.parse((await runCli(['config', '--json', web])).stdout)
    expect(json.rootIgnore).toEqual({ prefix: 'apps/web', patterns: ['apps/web/legacy/'] })
    const doctor = await runCli(['doctor', web])
    expect(doctor.stdout).toContain('Configured by ../../repolens.config.json: 1 check turned off, 1 ignore pattern.')
  })
})
