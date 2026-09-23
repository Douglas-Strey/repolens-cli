import { describe, expect, it } from 'vitest'
import {
  dependencyMajor,
  eslintLegacyConfig,
  findLegacyEslintConfigs,
  findMissingGoSum,
  findNextMiddleware,
  goSumMissing,
  localReplacements,
  nextMiddlewareDeprecated,
  optsOutOfFlatConfig,
} from '../../src/doctor/rules/tooling.ts'
import { createDependencyIndex } from '../../src/facts/dependencies.ts'
import { manifests } from '../../src/facts/manifests.ts'
import type { Tool } from '../../src/types.ts'
import { expectWellFormed, makeSections, projectContext, runCheck, runRule } from './support.ts'

describe('ESLINT_LEGACY_CONFIG', () => {
  const config = { file: '.eslintrc.json', dir: '.', kind: 'file' as const }

  it('warns for ESLint 9, errors for ESLint 10 and stays quiet for ESLint 8', () => {
    expect(findLegacyEslintConfigs([config], () => 9)).toEqual([
      {
        code: 'ESLINT_LEGACY_CONFIG',
        severity: 'warning',
        category: 'tooling',
        message: '.eslintrc.json is a legacy ESLint config, but ESLint 9 only reads eslint.config.js by default',
        hint: 'Migrate to eslint.config.js with `npx @eslint/migrate-config .eslintrc.json`',
        files: ['.eslintrc.json'],
        subject: '.eslintrc.json',
      },
    ])
    const ten = findLegacyEslintConfigs([config], () => 10)[0]
    expect(ten?.severity).toBe('error')
    expect(ten?.message).toBe('.eslintrc.json is a legacy ESLint config, which ESLint 10 no longer reads')
    expect(findLegacyEslintConfigs([config], () => 8)).toEqual([])
  })

  it('is informational when the ESLint version is unknown', () => {
    const found = findLegacyEslintConfigs([config], () => null)
    expect(found[0]?.severity).toBe('info')
  })

  it('handles eslintConfig in package.json', () => {
    const found = findLegacyEslintConfigs(
      [{ file: 'apps/web/package.json', dir: 'apps/web', kind: 'package.json' }],
      () => 9,
    )
    expect(found[0]).toMatchObject({
      message:
        '"eslintConfig" in apps/web/package.json is legacy ESLint config, but ESLint 9 only reads eslint.config.js by default',
      hint: 'Move the "eslintConfig" settings into apps/web/eslint.config.js and delete the field',
      subject: 'apps/web/package.json#eslintConfig',
    })
  })

  it("uses the package's own ESLint version, then the root's", () => {
    const deps = createDependencyIndex([
      {
        name: 'eslint',
        range: '^9.36.0',
        type: 'devDependencies',
        package: '.',
        file: 'package.json',
        ecosystem: 'node',
      },
      {
        name: 'eslint',
        range: '^8.57.0',
        type: 'devDependencies',
        package: 'apps/old',
        file: 'apps/old/package.json',
        ecosystem: 'node',
      },
    ])
    expect(dependencyMajor(deps, 'eslint', 'apps/old')).toBe(8)
    expect(dependencyMajor(deps, 'eslint', 'apps/new')).toBe(9)
    expect(dependencyMajor(createDependencyIndex([]), 'eslint', '.')).toBeNull()
  })

  it('finds legacy configs in package directories only', async () => {
    const ctx = await projectContext({
      'package.json': JSON.stringify({ workspaces: ['packages/*'], devDependencies: { eslint: '^9.36.0' } }),
      '.eslintrc.cjs': 'module.exports = {}',
      'packages/ui/package.json': JSON.stringify({ name: 'ui', eslintConfig: { root: true } }),
      'docs/.eslintrc.json': '{}',
    })
    const found = await runCheck(eslintLegacyConfig, makeSections(), ctx)
    expect(found.map((d) => [d.subject, d.severity])).toEqual([
      ['.eslintrc.cjs', 'warning'],
      ['packages/ui/package.json#eslintConfig', 'warning'],
    ])
    expectWellFormed(found)
  })

  it('is informational on ESLint 9 when a script opts back into eslintrc, and still an error on 10', () => {
    const optedOut = () => true
    const nine = findLegacyEslintConfigs([config], () => 9, optedOut)[0]
    expect(nine?.severity).toBe('info')
    expect(nine?.message).toBe(
      '.eslintrc.json is a legacy ESLint config, which ESLint 9 only reads because a script sets ESLINT_USE_FLAT_CONFIG=false, an option ESLint 10 removes',
    )
    expect(findLegacyEslintConfigs([config], () => 10, optedOut)[0]?.severity).toBe('error')
  })

  it('recognizes the ESLINT_USE_FLAT_CONFIG=false opt-in in scripts', () => {
    expect(optsOutOfFlatConfig({ lint: 'ESLINT_USE_FLAT_CONFIG=false eslint .' })).toBe(true)
    expect(optsOutOfFlatConfig({ lint: 'cross-env ESLINT_USE_FLAT_CONFIG="false" eslint src' })).toBe(true)
    expect(optsOutOfFlatConfig({ lint: 'ESLINT_USE_FLAT_CONFIG=true eslint .' })).toBe(false)
    expect(optsOutOfFlatConfig({ lint: 'ESLINT_USE_FLAT_CONFIG=falsey eslint .' })).toBe(false)
    expect(optsOutOfFlatConfig({ lint: 'eslint .' })).toBe(false)
  })

  it('reads the opt-in from the package scripts through the rule', async () => {
    const ctx = await projectContext({
      'package.json': JSON.stringify({
        scripts: { lint: 'ESLINT_USE_FLAT_CONFIG=false eslint .' },
        devDependencies: { eslint: '^9.36.0' },
      }),
      '.eslintrc.json': '{}',
    })
    const found = await runCheck(eslintLegacyConfig, makeSections(), ctx)
    expect(found.map((d) => [d.subject, d.severity])).toEqual([['.eslintrc.json', 'info']])
  })

  it('is skipped when there is no legacy config to look at', async () => {
    const ctx = await projectContext({
      'package.json': '{}',
      'eslint.config.js': 'export default []',
      // Sample projects are not the project's own configuration.
      'test/fixtures/old/package.json': '{}',
      'test/fixtures/old/.eslintrc.json': '{}',
      'scripts/.eslintrc.json': '{}',
    })
    expect((await runRule(eslintLegacyConfig, makeSections(), ctx)).checks[0]?.status).toBe('skipped')
    const eslint: Tool = {
      id: 'eslint',
      name: 'ESLint',
      kind: 'linter',
      configFiles: ['package.json'],
      packages: ['.'],
      confidence: 'high',
      evidence: [],
    }
    const withField = makeSections({ linting: { tools: [eslint] } })
    expect((await runRule(eslintLegacyConfig, withField, ctx)).checks[0]?.status).toBe('passed')
  })
})

describe('GO_SUM_MISSING', () => {
  const requires = [
    { path: 'github.com/gin-gonic/gin', version: 'v1.11.0', indirect: false },
    { path: 'golang.org/x/text', version: 'v0.29.0', indirect: true },
  ]

  it('parses local replace directives', () => {
    const goMod = [
      'module example.com/app',
      'replace example.com/local => ../local',
      'replace example.com/pinned v1.0.0 => example.com/fork v1.0.1',
      'replace (',
      '  example.com/a => ./a // comment',
      '  "example.com/b" v0.1.0 => /abs/b',
      ')',
    ].join('\n')
    expect([...localReplacements(goMod)].sort()).toEqual(['example.com/a', 'example.com/b', 'example.com/local'])
  })

  it('reports modules with direct requirements and no go.sum', () => {
    const found = findMissingGoSum([
      { file: 'services/api/go.mod', dir: 'services/api', requires, replaced: new Set(), sum: 'missing' },
    ])
    expect(found).toEqual([
      {
        code: 'GO_SUM_MISSING',
        severity: 'warning',
        category: 'tooling',
        message: 'services/api/go.mod requires 1 module but there is no go.sum next to it',
        hint: 'Run `go mod tidy` in services/api and commit services/api/go.sum',
        files: ['services/api/go.mod'],
        subject: 'services/api/go.mod',
      },
    ])
  })

  it('explains a go.sum that is ignored by Git', () => {
    const found = findMissingGoSum([{ file: 'go.mod', dir: '.', requires, replaced: new Set(), sum: 'ignored' }])
    expect(found[0]?.message).toBe('go.sum is ignored by Git, so the checksums for go.mod are not committed')
  })

  it('does not report indirect-only, locally replaced or present sums', () => {
    const indirect = requires.filter((r) => r.indirect)
    expect(
      findMissingGoSum([{ file: 'go.mod', dir: '.', requires: indirect, replaced: new Set(), sum: 'missing' }]),
    ).toEqual([])
    const replaced = new Set(['github.com/gin-gonic/gin'])
    expect(findMissingGoSum([{ file: 'go.mod', dir: '.', requires, replaced, sum: 'missing' }])).toEqual([])
    expect(findMissingGoSum([{ file: 'go.mod', dir: '.', requires, replaced: new Set(), sum: 'present' }])).toEqual([])
  })

  it('is skipped without a go.mod it can read', async () => {
    expect((await runRule(goSumMissing, makeSections())).checks[0]?.status).toBe('skipped')
    const ctx = await projectContext({ 'go.mod': 'not a go.mod\n' })
    await ctx.use(manifests)
    expect((await runRule(goSumMissing, makeSections(), ctx)).checks[0]?.status).toBe('skipped')
  })

  it('reads go.mod through the rule', async () => {
    const goMod = 'module example.com/app\n\ngo 1.25\n\nrequire github.com/google/uuid v1.6.0\n'
    const missing = await projectContext({ 'go.mod': goMod, 'main.go': 'package main' })
    expect((await runCheck(goSumMissing, makeSections(), missing)).map((d) => d.subject)).toEqual(['go.mod'])
    const present = await projectContext({ 'go.mod': goMod, 'go.sum': '' })
    expect(await runCheck(goSumMissing, makeSections(), present)).toEqual([])
    const ignored = await projectContext({ 'go.mod': goMod, 'go.sum': '', '.gitignore': 'go.sum\n' })
    expect((await runCheck(goSumMissing, makeSections(), ignored))[0]?.message).toContain('ignored by Git')
  })
})

describe('NEXT_MIDDLEWARE_DEPRECATED', () => {
  const has = (files: string[]) => (path: string) => files.includes(path)

  it('reports middleware in Next.js 16 apps without a proxy file', () => {
    expect(findNextMiddleware([{ dir: '.', major: 16 }], has(['middleware.ts']))).toEqual([
      {
        code: 'NEXT_MIDDLEWARE_DEPRECATED',
        severity: 'info',
        category: 'tooling',
        message: 'middleware.ts uses the middleware convention, which Next.js 16 renamed to proxy',
        hint: 'Rename it to proxy.ts and rename the exported middleware function to proxy',
        files: ['middleware.ts'],
        subject: 'middleware.ts',
      },
    ])
    const nested = findNextMiddleware([{ dir: 'apps/web', major: 17 }], has(['apps/web/src/middleware.js']))
    expect(nested[0]?.hint).toBe(
      'Rename it to apps/web/src/proxy.js and rename the exported middleware function to proxy',
    )
  })

  it('does not report older or unknown versions, or apps that already have a proxy', () => {
    expect(findNextMiddleware([{ dir: '.', major: 15 }], has(['middleware.ts']))).toEqual([])
    expect(findNextMiddleware([{ dir: '.', major: null }], has(['middleware.ts']))).toEqual([])
    expect(findNextMiddleware([{ dir: '.', major: 16 }], has(['middleware.ts', 'src/proxy.ts']))).toEqual([])
    expect(findNextMiddleware([{ dir: '.', major: 16 }], has([]))).toEqual([])
  })

  it('reads Next.js versions from dependencies, ignoring peer dependencies', async () => {
    const ctx = await projectContext({
      'package.json': JSON.stringify({ workspaces: ['apps/*', 'packages/*'] }),
      'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { next: '^16.0.1' } }),
      'apps/web/middleware.ts': 'export function middleware() {}',
      'packages/auth/package.json': JSON.stringify({ name: 'auth', peerDependencies: { next: '>=16' } }),
      'packages/auth/middleware.ts': 'export function middleware() {}',
    })
    const found = await runCheck(nextMiddlewareDeprecated, makeSections(), ctx)
    expect(found.map((d) => d.subject)).toEqual(['apps/web/middleware.ts'])
  })
})
