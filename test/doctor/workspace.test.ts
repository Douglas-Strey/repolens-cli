import { describe, expect, it } from 'vitest'
import { workspaceDetector } from '../../src/detectors/workspace.ts'
import {
  findDuplicateWorkspaceConfig,
  findEmptyWorkspacePatterns,
  findTurboPipeline,
  turboConfigPaths,
  turboPipelineKey,
  workspaceDuplicateConfig,
  workspacePatternEmpty,
} from '../../src/doctor/rules/workspace.ts'
import type { WorkspaceDeclaration } from '../../src/facts/manifests.ts'
import { expectWellFormed, makeSections, projectContext, runCheck, runRule } from './support.ts'

const pnpmDecl = (patterns: string[]): WorkspaceDeclaration => ({
  source: 'pnpm-workspace.yaml',
  file: 'pnpm-workspace.yaml',
  patterns,
})
const pkgDecl = (patterns: string[]): WorkspaceDeclaration => ({
  source: 'package.json',
  file: 'package.json',
  patterns,
})

describe('WORKSPACE_DUPLICATE_CONFIG', () => {
  it('reports workspaces declared in both files', () => {
    const found = findDuplicateWorkspaceConfig([pkgDecl(['packages/*']), pnpmDecl(['packages/*'])], 'pnpm')
    expect(found).toEqual([
      {
        code: 'WORKSPACE_DUPLICATE_CONFIG',
        severity: 'warning',
        category: 'workspace',
        message:
          'Workspaces are declared in both pnpm-workspace.yaml and package.json, but pnpm only reads pnpm-workspace.yaml',
        hint: 'Remove "workspaces" from package.json and keep the patterns in pnpm-workspace.yaml',
        files: ['package.json', 'pnpm-workspace.yaml'],
        subject: 'workspaces',
      },
    ])
  })

  it('mentions differing patterns and adapts the hint to other package managers', () => {
    const found = findDuplicateWorkspaceConfig([pkgDecl(['packages/*']), pnpmDecl(['packages/*', 'tools/*'])], 'yarn')
    expect(found[0]?.message).toContain('with different patterns')
    expect(found[0]?.hint).toBe(
      'yarn reads "workspaces" from package.json, so remove the packages list from pnpm-workspace.yaml',
    )
  })

  it('does not report a single declaration', () => {
    expect(findDuplicateWorkspaceConfig([pnpmDecl(['a/*'])], 'pnpm')).toEqual([])
    expect(
      findDuplicateWorkspaceConfig(
        [pkgDecl(['a/*']), { source: 'go.work', file: 'go.work', patterns: ['.'] }],
        undefined,
      ),
    ).toEqual([])
  })

  it('reads declarations through the manifests fact', async () => {
    const ctx = await projectContext({
      'package.json': JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
      'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
      'packages/a/package.json': '{"name":"a"}',
    })
    expect((await runCheck(workspaceDuplicateConfig, makeSections(), ctx)).map((d) => d.code)).toEqual([
      'WORKSPACE_DUPLICATE_CONFIG',
    ])
  })

  it('is skipped for single-package projects', async () => {
    const single = makeSections({
      project: { ...makeSections().project, manifests: ['package.json'], type: 'application' },
    })
    expect((await runRule(workspaceDuplicateConfig, single)).checks[0]?.status).toBe('skipped')
  })

  it('is skipped when pnpm-workspace.yaml failed to parse', async () => {
    const ctx = await projectContext({ 'package.json': '{}', 'pnpm-workspace.yaml': 'packages: [\n' })
    await ctx.readYaml('pnpm-workspace.yaml')
    expect((await runRule(workspaceDuplicateConfig, makeSections(), ctx)).checks[0]?.status).toBe('skipped')
    expect((await runRule(workspacePatternEmpty, makeSections(), ctx)).checks[0]?.status).toBe('skipped')
  })
})

describe('WORKSPACE_PATTERN_EMPTY', () => {
  it('reports patterns that match no package directory', () => {
    const patterns = ['packages/*', 'tools/*', '!packages/legacy', './apps/*']
    const found = findEmptyWorkspacePatterns({ effectivePatterns: patterns, workspaces: [pnpmDecl(patterns)] }, [
      '.',
      'apps/web',
      'packages/a',
    ])
    expect(found).toEqual([
      {
        code: 'WORKSPACE_PATTERN_EMPTY',
        severity: 'warning',
        category: 'workspace',
        message: 'Workspace pattern "tools/*" in pnpm-workspace.yaml matches no package',
        hint: 'Remove "tools/*" from pnpm-workspace.yaml, or add a package.json in a matching directory',
        files: ['pnpm-workspace.yaml'],
        subject: 'tools/*',
      },
    ])
  })

  it('skips patterns under directories RepoLens never walks', () => {
    const found = findEmptyWorkspacePatterns(
      { effectivePatterns: ['generated/*'], workspaces: [pkgDecl(['generated/*'])] },
      ['.'],
      (dir) => dir === 'generated',
    )
    expect(found).toEqual([])
  })

  it('strips terminal control characters from echoed patterns', () => {
    const pattern = 'evil\u001b[31m/*'
    const found = findEmptyWorkspacePatterns({ effectivePatterns: [pattern], workspaces: [pkgDecl([pattern])] }, ['.'])
    expect(found[0]?.message).toBe('Workspace pattern "evil[31m/*" in package.json matches no package')
  })

  it('checks the real project through the rule', async () => {
    const ctx = await projectContext({
      'package.json': '{"name":"root"}',
      'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n  - 'tools/*'\n",
      'packages/core/package.json': '{"name":"core"}',
      'tools/README.md': 'no package here',
    })
    const found = await runCheck(workspacePatternEmpty, makeSections(), ctx)
    expect(found.map((d) => d.subject)).toEqual(['tools/*'])
    expectWellFormed(found)
  })
})

describe('TURBO_PIPELINE_KEY', () => {
  const pipeline = [{ file: 'turbo.json', hasPipeline: true }]

  it('warns when turbo 2 or newer is declared', () => {
    expect(findTurboPipeline(pipeline, 2)).toEqual([
      {
        code: 'TURBO_PIPELINE_KEY',
        severity: 'warning',
        category: 'workspace',
        message: 'turbo.json uses "pipeline", which Turborepo 2 renamed to "tasks"',
        hint: 'Rename "pipeline" to "tasks" (`npx @turbo/codemod migrate` upgrades the whole configuration)',
        files: ['turbo.json'],
        subject: 'turbo.json',
      },
    ])
  })

  it('is informational when the version is unknown and silent for turbo 1', () => {
    expect(findTurboPipeline(pipeline, null)[0]?.severity).toBe('info')
    expect(findTurboPipeline(pipeline, 1)).toEqual([])
    expect(findTurboPipeline([{ file: 'turbo.json', hasPipeline: false }], 2)).toEqual([])
  })

  it('finds turbo.json files at the root and in packages only', async () => {
    const ctx = await projectContext({
      'turbo.json': '{}',
      'apps/web/turbo.json': '{}',
      'examples/demo/turbo.json': '{}',
    })
    expect(turboConfigPaths(ctx.files, ['apps/web'])).toEqual(['apps/web/turbo.json', 'turbo.json'])
  })

  it('reads turbo.json (with comments) and the turbo version through the rule', async () => {
    const ctx = await projectContext({
      'package.json': JSON.stringify({ devDependencies: { turbo: '^2.5.8' } }),
      'turbo.json': '{\n  // legacy\n  "pipeline": { "build": {} },\n}\n',
    })
    expect((await runCheck(turboPipelineKey, makeSections(), ctx)).map((d) => d.severity)).toEqual(['warning'])
  })

  it('does not crash on malformed turbo.json', async () => {
    const ctx = await projectContext({ 'package.json': '{}', 'turbo.json': '{ "pipeline": ' })
    expect(await runCheck(turboPipelineKey, makeSections(), ctx)).toEqual([])
    expect(ctx.warnings.map((w) => w.file)).toContain('turbo.json')
  })

  it('is skipped, not passed, when turbo.json is missing or failed to parse', async () => {
    expect((await runRule(turboPipelineKey, makeSections())).checks[0]?.status).toBe('skipped')
    const ctx = await projectContext({ 'package.json': '{}', 'turbo.json': '{ "pipeline": ' })
    await ctx.use(workspaceDetector)
    expect((await runRule(turboPipelineKey, makeSections(), ctx)).checks[0]?.status).toBe('skipped')
    const valid = await projectContext({ 'package.json': '{}', 'turbo.json': '{ "tasks": {} }' })
    expect((await runRule(turboPipelineKey, makeSections(), valid)).checks[0]?.status).toBe('passed')
  })
})
