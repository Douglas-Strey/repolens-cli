import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { gitignoreMissing, gitignoreNodeModules, suggestedIgnoreEntries } from '../../src/doctor/rules/git.ts'
import type { GitSection } from '../../src/types.ts'
import { contextFor, gitInit, makeProject } from '../helpers.ts'
import { expectWellFormed, makeSections, projectContext, runCheck, runRule } from './support.ts'

const GIT: GitSection = {
  branch: 'main',
  head: null,
  remotes: [],
  submodules: [],
  lfs: false,
  trackedFiles: 1,
  linkedWorktree: false,
}

describe('suggestedIgnoreEntries', () => {
  it('suggests entries for what exists in the project', async () => {
    const ctx = await projectContext({ 'package.json': '{}', 'dist/index.js': '', '.env': 'A=1\n', 'src/a.ts': '' })
    expect(suggestedIgnoreEntries(ctx.files)).toEqual(['node_modules/', 'dist/', '.env*', '!.env.example'])
  })

  it('does not suggest env entries for example files only', async () => {
    const ctx = await projectContext({ '.env.example': 'A=\n', 'main.go': '' })
    expect(suggestedIgnoreEntries(ctx.files)).toEqual([])
  })
})

describe('GITIGNORE_MISSING', () => {
  it('reports a Git repository without .gitignore', async () => {
    const dir = await makeProject({ 'package.json': '{"name":"x"}', 'index.js': '' })
    gitInit(dir)
    const found = await runCheck(gitignoreMissing, makeSections({ git: GIT }), await contextFor(dir))
    expect(found).toEqual([
      {
        code: 'GITIGNORE_MISSING',
        severity: 'warning',
        category: 'git',
        message: 'The repository has no .gitignore file',
        hint: 'Create a .gitignore that ignores node_modules/',
        subject: '.gitignore',
      },
    ])
    expectWellFormed(found)
  })

  it('passes when .gitignore exists', async () => {
    const dir = await makeProject({ '.gitignore': 'node_modules\n', 'index.js': '' })
    gitInit(dir)
    expect(await runCheck(gitignoreMissing, makeSections({ git: GIT }), await contextFor(dir))).toEqual([])
  })

  it('does not report for a subdirectory of a repository', async () => {
    const dir = await makeProject({ '.gitignore': 'node_modules\n', 'pkg/index.js': '' })
    gitInit(dir)
    expect(
      await runCheck(gitignoreMissing, makeSections({ git: GIT }), await contextFor(path.join(dir, 'pkg'))),
    ).toEqual([])
  })

  it('is skipped, not passed, for a subdirectory of a repository', async () => {
    const dir = await makeProject({ '.gitignore': 'node_modules\n', 'pkg/index.js': '' })
    gitInit(dir)
    const result = await runRule(gitignoreMissing, makeSections({ git: GIT }), await contextFor(path.join(dir, 'pkg')))
    expect(result.checks[0]?.status).toBe('skipped')
  })

  it('is skipped outside Git repositories', async () => {
    expect((await runRule(gitignoreMissing, makeSections({ git: null }))).checks[0]?.status).toBe('skipped')
  })
})

describe('GITIGNORE_NODE_MODULES', () => {
  const sections = makeSections({ project: { ...makeSections().project, manifests: ['package.json'] } })

  it('reports a .gitignore that does not ignore node_modules', async () => {
    const ctx = await projectContext({ 'package.json': '{}', '.gitignore': 'dist\n.env\n' })
    const found = await runCheck(gitignoreNodeModules, sections, ctx)
    expect(found).toEqual([
      {
        code: 'GITIGNORE_NODE_MODULES',
        severity: 'warning',
        category: 'git',
        message: '.gitignore does not ignore node_modules',
        hint: 'Add node_modules/ to .gitignore',
        files: ['.gitignore'],
        subject: 'node_modules',
      },
    ])
  })

  it('accepts the usual spellings, including rules that only match the contents', async () => {
    for (const entry of [
      'node_modules',
      'node_modules/',
      '/node_modules',
      '**/node_modules/',
      '**/node_modules/**',
      'node_modules/*',
      '/node_modules/**',
    ]) {
      const ctx = await projectContext({ 'package.json': '{}', '.gitignore': `${entry}\n` })
      expect(await runCheck(gitignoreNodeModules, sections, ctx), entry).toEqual([])
    }
  })

  it('does not report without package.json or without .gitignore', async () => {
    expect(await runCheck(gitignoreNodeModules, sections, await projectContext({ '.gitignore': 'dist\n' }))).toEqual([])
    expect(await runCheck(gitignoreNodeModules, sections, await projectContext({ 'package.json': '{}' }))).toEqual([])
  })

  it('is skipped without package.json or .gitignore', async () => {
    const goOnly = makeSections({ project: { ...makeSections().project, manifests: ['go.mod'] } })
    expect((await runRule(gitignoreNodeModules, goOnly)).checks[0]?.status).toBe('skipped')
    const noGitignore = await projectContext({ 'package.json': '{}' })
    expect((await runRule(gitignoreNodeModules, sections, noGitignore)).checks[0]?.status).toBe('skipped')
  })

  it("does not report Yarn Plug'n'Play projects, which have no node_modules", async () => {
    const yarnrcs = ['nodeLinker: pnp\n', 'yarnPath: .yarn/releases/yarn-4.5.0.cjs\n', '']
    for (const yarnrc of yarnrcs) {
      const ctx = await projectContext({
        'package.json': '{}',
        'yarn.lock': '__metadata:\n  version: 8\n',
        '.yarnrc.yml': yarnrc,
        '.gitignore': '.yarn/cache\n',
      })
      expect(await runCheck(gitignoreNodeModules, sections, ctx), yarnrc).toEqual([])
    }
    const loader = await projectContext({ 'package.json': '{}', '.pnp.cjs': '', '.gitignore': 'dist\n' })
    expect(await runCheck(gitignoreNodeModules, sections, loader)).toEqual([])
    expect((await runRule(gitignoreNodeModules, sections, loader)).checks[0]?.status).toBe('skipped')
  })

  it('still reports Yarn with the node-modules linker, and a stale .yarnrc.yml in an npm project', async () => {
    const nodeModules = await projectContext({
      'package.json': '{}',
      'yarn.lock': '',
      '.yarnrc.yml': 'nodeLinker: node-modules\n',
      '.gitignore': 'dist\n',
    })
    expect(await runCheck(gitignoreNodeModules, sections, nodeModules)).toHaveLength(1)
    const npm = await projectContext({
      'package.json': '{}',
      'package-lock.json': '{}',
      '.yarnrc.yml': '',
      '.gitignore': 'dist\n',
    })
    expect(await runCheck(gitignoreNodeModules, sections, npm)).toHaveLength(1)
  })
})
