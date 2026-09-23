import { describe, expect, it } from 'vitest'
import { packageManagersDetector } from '../../src/detectors/package-managers.ts'
import {
  comparePackages,
  declaresPnpmPackages,
  nxProjectFrom,
  packageJsonWorkspaceTool,
  workspaceDetector,
} from '../../src/detectors/workspace.ts'
import type { WorkspaceSection } from '../../src/types.ts'
import { contextFor, fixtureContext, makeProject } from '../helpers.ts'

async function detectFiles(files: Record<string, string>): Promise<WorkspaceSection | null> {
  const ctx = await contextFor(await makeProject(files))
  return ctx.use(workspaceDetector)
}

describe('packageJsonWorkspaceTool', () => {
  it('names the tool after the primary package manager', () => {
    expect(packageJsonWorkspaceTool('yarn')).toEqual({
      id: 'yarn',
      name: 'Yarn workspaces',
      configFile: 'package.json',
    })
    expect(packageJsonWorkspaceTool('bun')).toEqual({ id: 'bun', name: 'Bun workspaces', configFile: 'package.json' })
    expect(packageJsonWorkspaceTool('npm').name).toBe('npm workspaces')
  })

  it('defaults to npm (pnpm ignores package.json workspaces)', () => {
    expect(packageJsonWorkspaceTool(null).id).toBe('npm')
    expect(packageJsonWorkspaceTool('pnpm').id).toBe('npm')
  })
})

describe('declaresPnpmPackages', () => {
  it('needs a packages list, but trusts a file that could not be parsed', () => {
    expect(declaresPnpmPackages({ packages: ['apps/*'] })).toBe(true)
    expect(declaresPnpmPackages({ packages: [] })).toBe(true)
    expect(declaresPnpmPackages({ onlyBuiltDependencies: ['esbuild'] })).toBe(false)
    expect(declaresPnpmPackages({ catalog: { vue: '^3.5.0' } })).toBe(false)
    expect(declaresPnpmPackages(null)).toBe(true)
    expect(declaresPnpmPackages('packages')).toBe(false)
  })
})

describe('nxProjectFrom', () => {
  it('reads the name and falls back to the directory', () => {
    expect(nxProjectFrom({ name: 'web', targets: {} }, 'apps/web/project.json')).toEqual({
      name: 'web',
      path: 'apps/web',
      ecosystem: 'node',
    })
    expect(nxProjectFrom({ projectType: 'library' }, 'libs/ui/project.json')?.name).toBe('libs/ui')
  })

  it('ignores files that do not look like Nx projects', () => {
    expect(nxProjectFrom({ foo: 1 }, 'x/project.json')).toBeNull()
    expect(nxProjectFrom(null, 'x/project.json')).toBeNull()
    expect(nxProjectFrom(['name'], 'x/project.json')).toBeNull()
  })
})

describe('comparePackages', () => {
  it('sorts by path, then node before go', () => {
    const sorted = [
      { name: 'b', path: 'b', ecosystem: 'node' as const },
      { name: 'a-go', path: 'a', ecosystem: 'go' as const },
      { name: 'a', path: 'a', ecosystem: 'node' as const },
    ].sort(comparePackages)
    expect(sorted.map((pkg) => pkg.name)).toEqual(['a', 'a-go', 'b'])
  })
})

describe('workspaceDetector on fixtures', () => {
  it('monorepo: pnpm workspaces + Turborepo with four packages; the nested Go module is not a member', async () => {
    const ctx = await fixtureContext('monorepo')
    const section = await ctx.use(workspaceDetector)
    expect(section).toEqual({
      tools: [
        { id: 'pnpm', name: 'pnpm workspaces', configFile: 'pnpm-workspace.yaml' },
        { id: 'turbo', name: 'Turborepo', configFile: 'turbo.json' },
      ],
      patterns: ['apps/*', 'packages/*'],
      packages: [
        { name: '@acme/api', path: 'apps/api', version: '0.0.0', private: true, ecosystem: 'node' },
        { name: '@acme/web', path: 'apps/web', private: true, ecosystem: 'node' },
        { name: '@acme/shared', path: 'packages/shared', version: '0.0.0', private: true, ecosystem: 'node' },
        { name: '@acme/ui', path: 'packages/ui', version: '0.0.0', private: true, ecosystem: 'node' },
      ],
    })
  })

  it('legacy-config: reports both JS declarations; pnpm-workspace.yaml patterns win', async () => {
    const ctx = await fixtureContext('legacy-config')
    const section = await ctx.use(workspaceDetector)
    expect(section?.tools.map((tool) => tool.id)).toEqual(['pnpm', 'npm', 'turbo'])
    expect(section?.patterns).toEqual(['packages/*', 'tools/*'])
    expect(section?.packages.map((pkg) => pkg.name)).toEqual(['@legacy/core', '@legacy/utils'])
  })

  it('returns null for single-package projects', async () => {
    for (const fixture of ['nuxt-app', 'go-api', 'plain-repo', 'broken-manifest']) {
      const ctx = await fixtureContext(fixture)
      expect(await ctx.use(workspaceDetector)).toBeNull()
    }
  })

  it('broken-config: keeps the tool even when pnpm-workspace.yaml is malformed', async () => {
    const ctx = await fixtureContext('broken-config')
    const section = await ctx.use(workspaceDetector)
    expect(section?.tools.map((tool) => tool.id)).toEqual(['pnpm', 'turbo'])
    expect(section?.packages).toEqual([])
  })
})

describe('workspaceDetector on inline projects', () => {
  it('names package.json workspaces after Yarn', async () => {
    const section = await detectFiles({
      'package.json': JSON.stringify({ private: true, workspaces: ['packages/*'] }),
      'yarn.lock': '__metadata:\n  version: 8\n',
      'packages/a/package.json': '{"name":"a","version":"1.0.0"}',
      'packages/b/package.json': '{"private":false}',
    })
    expect(section?.tools).toEqual([{ id: 'yarn', name: 'Yarn workspaces', configFile: 'package.json' }])
    expect(section?.packages).toEqual([
      { name: 'a', path: 'packages/a', version: '1.0.0', ecosystem: 'node' },
      { name: 'packages/b', path: 'packages/b', private: false, ecosystem: 'node' },
    ])
  })

  it('names package.json workspaces after Bun', async () => {
    const section = await detectFiles({
      'package.json': JSON.stringify({ workspaces: { packages: ['apps/*'] } }),
      'bun.lock': '{}',
      'apps/x/package.json': '{"name":"x"}',
    })
    expect(section?.tools).toEqual([{ id: 'bun', name: 'Bun workspaces', configFile: 'package.json' }])
    expect(section?.patterns).toEqual(['apps/*'])
  })

  it('reads go.work members, including the root module', async () => {
    const section = await detectFiles({
      'go.work': 'go 1.25\n\nuse (\n\t.\n\t./api\n\t./worker\n)\n',
      'go.mod': 'module example.com/root\n',
      'api/go.mod': 'module example.com/api\n',
      'worker/go.mod': 'module example.com/worker\n',
      'tools/go.mod': 'module example.com/tools\n',
    })
    expect(section?.tools).toEqual([{ id: 'go-work', name: 'Go workspace', configFile: 'go.work' }])
    expect(section?.patterns).toEqual(['.', 'api', 'worker'])
    expect(section?.packages).toEqual([
      { name: 'example.com/root', path: '.', ecosystem: 'go' },
      { name: 'example.com/api', path: 'api', ecosystem: 'go' },
      { name: 'example.com/worker', path: 'worker', ecosystem: 'go' },
    ])
  })

  it('adds Nx projects that are not already listed', async () => {
    const section = await detectFiles({
      'package.json': JSON.stringify({ workspaces: ['packages/*'] }),
      'package-lock.json': '{}',
      'nx.json': '{}',
      'packages/core/package.json': '{"name":"@x/core"}',
      'packages/core/project.json': '{"name":"core"}',
      'apps/web/project.json': '{"name":"web","targets":{}}',
      'libs/ui/project.json': '{"projectType":"library"}',
      'tools/misc/project.json': '{"foo":true}',
      'libs/broken/project.json': '{ not json',
      'project.json': '{"name":"root"}',
    })
    expect(section?.tools.map((tool) => tool.id)).toEqual(['npm', 'nx'])
    expect(section?.packages).toEqual([
      { name: 'web', path: 'apps/web', ecosystem: 'node' },
      { name: 'libs/ui', path: 'libs/ui', ecosystem: 'node' },
      { name: '@x/core', path: 'packages/core', ecosystem: 'node' },
    ])
  })

  it('ignores project.json files when there is no nx.json', async () => {
    const section = await detectFiles({ 'lerna.json': '{"version":"1.0.0"}', 'a/project.json': '{"name":"a"}' })
    expect(section).toEqual({
      tools: [{ id: 'lerna', name: 'Lerna', configFile: 'lerna.json' }],
      patterns: [],
      packages: [],
    })
  })

  it('supports turbo.jsonc', async () => {
    const section = await detectFiles({ 'turbo.jsonc': '{ // comment\n}' })
    expect(section?.tools).toEqual([{ id: 'turbo', name: 'Turborepo', configFile: 'turbo.jsonc' }])
  })

  it('does not report pnpm workspaces for a settings-only pnpm-workspace.yaml (pnpm 10)', async () => {
    const dir = await makeProject({
      'package.json': '{"name":"app"}',
      'pnpm-lock.yaml': '',
      'pnpm-workspace.yaml': 'onlyBuiltDependencies:\n  - esbuild\n',
    })
    const ctx = await contextFor(dir)
    expect(await ctx.use(workspaceDetector)).toBeNull()
    expect((await ctx.use(packageManagersDetector)).primary?.evidence).toContain('workspace file pnpm-workspace.yaml')
  })

  it('does not treat an empty workspaces array as a workspace', async () => {
    expect(await detectFiles({ 'package.json': '{"workspaces":[]}' })).toBeNull()
  })

  it('keeps the workspace when the package managers detector fails (falls back to npm workspaces)', async () => {
    const original = packageManagersDetector.run
    packageManagersDetector.run = async () => {
      throw new Error('boom')
    }
    try {
      const section = await detectFiles({
        'package.json': JSON.stringify({ workspaces: ['packages/*'] }),
        'packages/a/package.json': '{"name":"a"}',
      })
      expect(section?.tools).toEqual([{ id: 'npm', name: 'npm workspaces', configFile: 'package.json' }])
      expect(section?.packages.map((pkg) => pkg.path)).toEqual(['packages/a'])
    } finally {
      packageManagersDetector.run = original
    }
  })

  it('parses turbo.json so a syntax error is recorded before doctor checks run', async () => {
    const ctx = await contextFor(await makeProject({ 'turbo.json': '{ "tasks": ' }))
    expect((await ctx.use(workspaceDetector))?.tools.map((tool) => tool.id)).toEqual(['turbo'])
    expect(ctx.warnings).toEqual([expect.objectContaining({ kind: 'parse', file: 'turbo.json' })])
  })
})
