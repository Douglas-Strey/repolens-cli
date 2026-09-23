import { describe, expect, it } from 'vitest'
import {
  denoImports,
  isProjectPath,
  MAX_WORKSPACE_PATTERNS,
  manifests,
  memberRole,
  normalizeManifest,
  type PackageManifest,
  parseDenoSpecifier,
  parseGoMod,
  parseGoWork,
  readCatalogs,
  resolveCatalogs,
} from '../../src/facts/manifests.ts'
import { contextFor, fixtureContext, makeProject, timeBudget } from '../helpers.ts'

const json = (value: unknown) => JSON.stringify(value, null, 2)

async function manifestsOf(files: Record<string, string>) {
  const ctx = await contextFor(await makeProject(files))
  return { ctx, project: await ctx.use(manifests) }
}

describe('manifests on fixtures', () => {
  it('monorepo: pnpm workspace members, catalogs and a nested Go module', async () => {
    const ctx = await fixtureContext('monorepo')
    const project = await ctx.use(manifests)
    expect(project.rootInvalid).toBe(false)
    expect(project.root?.name).toBe('acme')
    expect(project.root?.packageManager).toBe('pnpm@10.17.1')
    expect(project.packages.map((p) => [p.dir, p.role, p.name])).toEqual([
      ['.', 'root', 'acme'],
      ['apps/api', 'workspace', '@acme/api'],
      ['apps/web', 'workspace', '@acme/web'],
      ['packages/shared', 'workspace', '@acme/shared'],
      ['packages/ui', 'workspace', '@acme/ui'],
    ])
    expect(project.workspaces).toEqual([
      { source: 'pnpm-workspace.yaml', file: 'pnpm-workspace.yaml', patterns: ['apps/*', 'packages/*'] },
    ])
    expect(project.effectivePatterns).toEqual(['apps/*', 'packages/*'])
    expect(project.catalogs).toEqual({ default: { vue: '^3.5.22', typescript: '^5.9.2' } })
    // `catalog:` references are resolved in place.
    expect(project.root?.devDependencies.typescript).toBe('^5.9.2')
    const web = project.packages.find((p) => p.dir === 'apps/web') as PackageManifest
    expect(web.dependencies.vue).toBe('^3.5.22')
    expect(web.dependencies['@acme/ui']).toBe('workspace:*')
    expect(project.goModules).toMatchObject([
      {
        dir: 'services/billing',
        file: 'services/billing/go.mod',
        role: 'nested',
        module: 'github.com/acme/billing',
        goVersion: '1.25',
        hasGoSum: true,
        requires: [{ path: 'github.com/google/uuid', version: 'v1.6.0', indirect: false }],
      },
    ])
    expect(ctx.warnings).toEqual([])
  })

  it('legacy-config: both package.json workspaces and pnpm-workspace.yaml are recorded; pnpm wins', async () => {
    const project = await (await fixtureContext('legacy-config')).use(manifests)
    expect(project.workspaces.map((w) => [w.source, w.patterns])).toEqual([
      ['package.json', ['packages/*']],
      ['pnpm-workspace.yaml', ['packages/*', 'tools/*']],
    ])
    expect(project.effectivePatterns).toEqual(['packages/*', 'tools/*'])
    expect(project.packages.map((p) => p.dir)).toEqual(['.', 'packages/core', 'packages/utils'])
  })

  it('broken-manifest: a malformed root package.json is flagged, not fatal', async () => {
    const ctx = await fixtureContext('broken-manifest')
    const project = await ctx.use(manifests)
    expect(project.root).toBeNull()
    expect(project.rootInvalid).toBe(true)
    expect(project.packages).toEqual([])
    expect(ctx.warnings).toHaveLength(1)
    expect(ctx.warnings[0]).toMatchObject({ file: 'package.json', message: "Couldn't parse package.json" })
  })

  it('broken-config: invalid pnpm-workspace.yaml and go.mod produce warnings and partial data', async () => {
    const ctx = await fixtureContext('broken-config')
    const project = await ctx.use(manifests)
    expect(project.root?.name).toBe('broken-config')
    expect(project.workspaces).toEqual([])
    expect(project.effectivePatterns).toEqual([])
    expect(project.goModules).toEqual([])
    const files = ctx.warnings.map((w) => w.file)
    expect(files).toContain('pnpm-workspace.yaml')
    expect(files).toContain('go.mod')
    expect(ctx.warnings.find((w) => w.file === 'go.mod')?.detail).toBe('No module directive found')
  })

  it('go-api: go.mod with direct and indirect requirement blocks', async () => {
    const project = await (await fixtureContext('go-api')).use(manifests)
    expect(project.root).toBeNull()
    expect(project.rootInvalid).toBe(false)
    const [mod] = project.goModules
    expect(mod).toMatchObject({ dir: '.', role: 'root', module: 'github.com/acme/go-api', goVersion: '1.25.1' })
    expect(mod?.requires.filter((r) => !r.indirect).map((r) => r.path)).toEqual([
      'github.com/gin-gonic/gin',
      'github.com/jackc/pgx/v5',
      'github.com/redis/go-redis/v9',
    ])
    expect(mod?.requires.filter((r) => r.indirect)).toHaveLength(7)
  })
})

describe('manifests on inline projects', () => {
  it('npm workspaces in object form, with negations', async () => {
    const { project } = await manifestsOf({
      'package.json': json({ name: 'root', workspaces: { packages: ['packages/*', '!packages/internal'] } }),
      'packages/a/package.json': json({ name: 'a' }),
      'packages/internal/package.json': json({ name: 'internal' }),
      'tools/x/package.json': json({ name: 'x' }),
    })
    expect(project.effectivePatterns).toEqual(['packages/*', '!packages/internal'])
    expect(project.packages.map((p) => p.dir)).toEqual(['.', 'packages/a'])
    expect(project.root?.workspaces).toEqual(['packages/*', '!packages/internal'])
  })

  it('npm workspaces in array form, including globstars and ./ prefixes', async () => {
    const { project } = await manifestsOf({
      'package.json': json({ workspaces: ['./apps/*', 'libs/**'] }),
      'apps/web/package.json': json({ name: 'web' }),
      'libs/a/b/package.json': json({ name: 'b' }),
    })
    expect(project.packages.map((p) => [p.dir, p.role])).toEqual([
      ['.', 'root'],
      ['apps/web', 'workspace'],
      ['libs/a/b', 'workspace'],
    ])
  })

  it('lerna.json is used only when nothing else declares packages', async () => {
    const lernaOnly = await manifestsOf({
      'package.json': json({ name: 'root' }),
      'lerna.json': json({ packages: ['modules/*'] }),
      'modules/m/package.json': json({ name: 'm' }),
      'other/o/package.json': json({ name: 'o' }),
    })
    expect(lernaOnly.project.effectivePatterns).toEqual(['modules/*'])
    expect(lernaOnly.project.packages.map((p) => p.dir)).toEqual(['.', 'modules/m'])

    const both = await manifestsOf({
      'package.json': json({ workspaces: ['packages/*'] }),
      'lerna.json': json({ packages: ['modules/*'] }),
    })
    expect(both.project.effectivePatterns).toEqual(['packages/*'])
    expect(both.project.workspaces.map((w) => w.source)).toEqual(['package.json', 'lerna.json'])
  })

  it('discovers shallow nested packages outside test, fixture and example directories', async () => {
    const { project } = await manifestsOf({
      'package.json': json({ name: 'root' }),
      'site/package.json': json({ name: 'site' }),
      'a/b/c/package.json': json({ name: 'depth-3' }),
      'a/b/c/d/package.json': json({ name: 'depth-4' }),
      'test/fixtures/app/package.json': json({ name: 'fixture' }),
      'examples/demo/package.json': json({ name: 'example' }),
      '__tests__/x/package.json': json({ name: 'tests' }),
      '_archive/package.json': json({ name: 'archived' }),
      'templates/starter/package.json': json({ name: 'template' }),
    })
    expect(project.packages.map((p) => [p.dir, p.role])).toEqual([
      ['.', 'root'],
      ['a/b/c', 'nested'],
      ['site', 'nested'],
    ])
  })

  it('an explicit workspace pattern can include an example directory', async () => {
    const { project } = await manifestsOf({
      'pnpm-workspace.yaml': 'packages:\n  - examples/*\n',
      'package.json': json({ name: 'root' }),
      'examples/demo/package.json': json({ name: 'demo' }),
    })
    expect(project.packages.map((p) => p.dir)).toEqual(['.', 'examples/demo'])
  })

  it('resolves default and named pnpm catalogs', async () => {
    const { project } = await manifestsOf({
      'pnpm-workspace.yaml': [
        'packages: [apps/*]',
        'catalog:',
        '  zod: ^4.0.0',
        'catalogs:',
        '  react18:',
        '    react: ^18.3.1',
        '  legacy:',
        '    lodash: 4.17.21',
        '    version-number: 5',
      ].join('\n'),
      'package.json': json({ name: 'root' }),
      'apps/web/package.json': json({
        dependencies: {
          zod: 'catalog:',
          react: 'catalog:react18',
          lodash: 'catalog:legacy',
          missing: 'catalog:nope',
          'not-in-catalog': 'catalog:',
          'version-number': 'catalog:legacy',
        },
      }),
    })
    const web = project.packages.find((p) => p.dir === 'apps/web') as PackageManifest
    expect(web.dependencies).toEqual({
      zod: '^4.0.0',
      react: '^18.3.1',
      lodash: '4.17.21',
      missing: 'catalog:nope',
      'not-in-catalog': 'catalog:',
      'version-number': '5',
    })
  })

  it('warns when package.json is valid JSON but not an object', async () => {
    const { ctx, project } = await manifestsOf({
      'package.json': '["not", "an", "object"]',
      'pnpm-workspace.yaml': 'packages: [apps/*]\n',
      'apps/a/package.json': '"just a string"',
      'apps/b/package.json': '{ broken',
      'apps/c/package.json': json({ name: 'c' }),
    })
    expect(project.root).toBeNull()
    expect(project.rootInvalid).toBe(true)
    expect(project.packages.map((p) => p.dir)).toEqual(['apps/c'])
    // Warnings are recorded in the completion order of concurrent reads.
    expect(ctx.warnings.map((w) => [w.file, w.message]).sort()).toEqual([
      ['apps/a/package.json', "Couldn't parse apps/a/package.json"],
      ['apps/b/package.json', "Couldn't parse apps/b/package.json"],
      ['package.json', "Couldn't parse package.json"],
    ])
    expect(ctx.warnings.find((w) => w.file === 'package.json')?.detail).toBe('Expected a JSON object')
  })

  it('normalizes loosely typed fields', async () => {
    const { project } = await manifestsOf({
      'package.json': json({
        name: 42,
        version: '1.0.0',
        private: 'yes',
        scripts: { build: 'tsc', broken: 1 },
        dependencies: ['not', 'a', 'map'],
        bin: { tool: './cli.js' },
        workspaces: 'packages/*',
        engines: { node: '>=22' },
      }),
    })
    const root = project.root as PackageManifest
    expect(root.name).toBeUndefined()
    expect(root.version).toBe('1.0.0')
    expect(root.private).toBeUndefined()
    expect(root.scripts).toEqual({ build: 'tsc' })
    expect(root.dependencies).toEqual({})
    expect(root.hasBin).toBe(true)
    expect(root.workspaces).toEqual(['packages/*'])
    expect(root.engines).toEqual({ node: '>=22' })
  })

  it('go.work: use directives mark workspace modules', async () => {
    const { project } = await manifestsOf({
      'go.work': 'go 1.25\n\nuse (\n\t./api // the API\n\t"./worker"\n)\nuse ./tools\n',
      'api/go.mod': 'module example.com/api\n',
      'worker/go.mod': 'module example.com/worker\n',
      'tools/go.mod': 'module example.com/tools\n',
      'a/b/c/d/e/go.mod': 'module example.com/deep\n',
      'testdata/mod/go.mod': 'module example.com/testdata\n',
    })
    expect(project.workspaces).toEqual([
      { source: 'go.work', file: 'go.work', patterns: ['./api', './worker', './tools'] },
    ])
    expect(project.goModules.map((m) => [m.dir, m.role])).toEqual([
      ['api', 'workspace'],
      ['tools', 'workspace'],
      ['worker', 'workspace'],
    ])
  })

  it('ignores prototype keys in catalogs', () => {
    const catalogs = readCatalogs({
      catalog: { __proto__: 'x', constructor: '1', zod: '^4' },
      catalogs: JSON.parse('{"__proto__": {"a": "1"}, "ok": {"b": "2"}}'),
    })
    expect(catalogs).toEqual({ default: { zod: '^4' }, ok: { b: '2' } })
    expect(Object.getPrototypeOf(catalogs)).toBe(Object.prototype)
    const manifest = normalizeManifest(
      { dependencies: { a: 'catalog:toString', b: 'catalog:' } },
      'package.json',
      'root',
    )
    resolveCatalogs(manifest, catalogs)
    expect(manifest.dependencies).toEqual({ a: 'catalog:toString', b: 'catalog:' })
  })
})

describe('manifests on hostile workspace declarations', () => {
  it('uses only the first MAX_WORKSPACE_PATTERNS patterns, warns, and stays fast', async () => {
    const patterns = Array.from({ length: 30_000 }, (_, i) => `  - "packages/p${i}/x"`)
    patterns[10] = '  - "packages/q1"'
    patterns[20_000] = '  - "packages/q2"'
    const files: Record<string, string> = {
      'package.json': json({ name: 'root' }),
      'pnpm-workspace.yaml': `packages:\n${patterns.join('\n')}\n`,
    }
    for (let i = 0; i < 300; i++) files[`packages/q${i}/package.json`] = json({ name: `q${i}` })
    const started = performance.now()
    const { ctx, project } = await manifestsOf(files)
    expect(performance.now() - started).toBeLessThan(timeBudget(3000))
    expect(project.effectivePatterns).toHaveLength(MAX_WORKSPACE_PATTERNS)
    expect(project.workspaces[0]?.patterns).toBe(project.effectivePatterns)
    expect(project.packages.map((p) => p.dir)).toEqual(['.', 'packages/q1'])
    expect(ctx.warnings).toContainEqual({
      kind: 'limit',
      file: 'pnpm-workspace.yaml',
      message: `Used only the first ${MAX_WORKSPACE_PATTERNS} of 30000 workspace patterns in pnpm-workspace.yaml`,
    })
  }, 15_000)

  it('caps package.json workspaces too, keeping one shared array', async () => {
    const workspaces = Array.from({ length: MAX_WORKSPACE_PATTERNS + 1 }, (_, i) => `apps/a${i}`)
    const { ctx, project } = await manifestsOf({ 'package.json': json({ name: 'root', workspaces }) })
    expect(project.root?.workspaces).toHaveLength(MAX_WORKSPACE_PATTERNS)
    expect(project.effectivePatterns).toBe(project.root?.workspaces)
    expect(ctx.warnings.map((w) => w.message)).toEqual([
      `Used only the first ${MAX_WORKSPACE_PATTERNS} of ${MAX_WORKSPACE_PATTERNS + 1} workspace patterns in package.json`,
    ])
  })
})

describe('memberRole / isProjectPath', () => {
  it('classifies package.json files', () => {
    expect(memberRole('apps/web/package.json', ['apps/*'])).toBe('workspace')
    expect(memberRole('tools/x/package.json', ['apps/*'])).toBeNull()
    expect(memberRole('site/package.json', [])).toBe('nested')
    expect(memberRole('a/b/c/d/package.json', [])).toBeNull()
    expect(memberRole('examples/x/package.json', [])).toBeNull()
    expect(isProjectPath('src/fixtures/package.json')).toBe(false)
    expect(isProjectPath('fixtures.json')).toBe(true)
  })

  it('uses the shared path roles: demo, sandbox and e2e projects are samples too, in any case', () => {
    for (const file of [
      'demo/package.json',
      'Examples/basic/package.json',
      'sandbox/package.json',
      'e2e/package.json',
      '_archive/package.json',
    ]) {
      expect(isProjectPath(file), file).toBe(false)
    }
    for (const file of ['docs/package.json', 'site/package.json', 'packages/testing-utils/package.json']) {
      expect(isProjectPath(file), file).toBe(true)
    }
    // Workspace declarations still decide for themselves.
    expect(memberRole('examples/x/package.json', ['examples/*'])).toBe('workspace')
  })
})

describe('Deno import maps', () => {
  it('parseDenoSpecifier reads jsr: and npm: specifiers', () => {
    expect(parseDenoSpecifier('jsr:@hono/hono@^4')).toEqual({ name: '@hono/hono', range: '^4', registry: 'jsr' })
    expect(parseDenoSpecifier('npm:express@^4.18.2')).toEqual({ name: 'express', range: '^4.18.2', registry: 'npm' })
    expect(parseDenoSpecifier('npm:@types/node@22/sub/path')).toEqual({
      name: '@types/node',
      range: '22',
      registry: 'npm',
    })
    expect(parseDenoSpecifier('jsr:@std/assert')).toEqual({ name: '@std/assert', range: '*', registry: 'jsr' })
    expect(parseDenoSpecifier('npm:/preact@10.5.13/hooks')).toEqual({
      name: 'preact',
      range: '10.5.13',
      registry: 'npm',
    })
  })

  it('skips URLs, paths and prefix mappings', () => {
    for (const specifier of ['https://deno.land/x/oak@v12/mod.ts', './src/', 'jsr:/@std/', 'npm:', 'node:fs']) {
      expect(parseDenoSpecifier(specifier), specifier).toBeNull()
    }
    expect(denoImports({ a: 'jsr:@std/path@1', b: 'jsr:@std/path@1', c: 42, d: './x/' })).toEqual([
      { name: '@std/path', range: '1', registry: 'jsr' },
    ])
    expect(denoImports(['jsr:@std/path'])).toEqual([])
  })

  it('reads deno.json, deno.jsonc with comments, a separate import map and workspace members', async () => {
    const { project } = await manifestsOf({
      'deno.jsonc': `{
        // the app
        "name": "@acme/app",
        "imports": { "@hono/hono": "jsr:@hono/hono@^4.6.0", "zod": "npm:zod@^3.23.0" },
        "workspace": ["./packages/*"],
      }`,
      'packages/db/deno.json': json({ name: '@acme/db', importMap: './import_map.json' }),
      'packages/db/import_map.json': json({ imports: { postgres: 'npm:postgres@^3.4.0' } }),
      'other/deno.json': json({ imports: { lodash: 'npm:lodash@4' } }),
    })
    expect(project.deno).toEqual([
      {
        dir: '.',
        file: 'deno.jsonc',
        role: 'root',
        name: '@acme/app',
        imports: [
          { name: '@hono/hono', range: '^4.6.0', registry: 'jsr' },
          { name: 'zod', range: '^3.23.0', registry: 'npm' },
        ],
      },
      {
        dir: 'packages/db',
        file: 'packages/db/deno.json',
        role: 'workspace',
        name: '@acme/db',
        imports: [{ name: 'postgres', range: '^3.4.0', registry: 'npm' }],
      },
    ])
  })

  it('never reads an import map outside the project', async () => {
    const { project } = await manifestsOf({ 'deno.json': json({ importMap: '../outside.json' }) })
    expect(project.deno).toEqual([{ dir: '.', file: 'deno.json', role: 'root', imports: [] }])
  })
})

describe('parseGoMod', () => {
  it('parses module, go, toolchain and requirements', () => {
    const parsed = parseGoMod(
      [
        '// Leading comment',
        'module "example.com/quoted" // trailing comment',
        '',
        'go 1.25.1',
        'toolchain go1.25.2',
        '',
        'require example.com/single v1.2.3',
        'require example.com/single-indirect v0.1.0 // indirect',
        'require (',
        '\texample.com/a v1.0.0',
        '\t`example.com/b` v2.0.0+incompatible // indirect',
        '\t// a comment line',
        ')',
        'require(',
        '\texample.com/c v0.0.0-20240101000000-abcdef123456',
        ')',
        'replace (',
        '\texample.com/a => ../a',
        ')',
        'replace example.com/b v2.0.0 => example.com/b v2.0.1',
        'exclude example.com/x v1.0.0',
        'retract [v1.0.0, v1.1.0]',
      ].join('\r\n'),
    )
    expect(parsed).toEqual({
      module: 'example.com/quoted',
      goVersion: '1.25.1',
      toolchain: '1.25.2',
      requires: [
        { path: 'example.com/single', version: 'v1.2.3', indirect: false },
        { path: 'example.com/single-indirect', version: 'v0.1.0', indirect: true },
        { path: 'example.com/a', version: 'v1.0.0', indirect: false },
        { path: 'example.com/b', version: 'v2.0.0+incompatible', indirect: true },
        { path: 'example.com/c', version: 'v0.0.0-20240101000000-abcdef123456', indirect: false },
      ],
    })
  })

  it('returns null without a module directive', () => {
    expect(parseGoMod('go 1.25\nrequire example.com/a v1.0.0\n')).toBeNull()
    expect(parseGoMod('')).toBeNull()
    expect(parseGoMod('<<<<<<< HEAD\nmodule\n=======\n')).toBeNull()
  })

  it('skips requirements without a version and survives an unclosed block', () => {
    expect(parseGoMod('module m\nrequire example.com/a\nrequire (\n\texample.com/b v1.0.0\n')).toEqual({
      module: 'm',
      requires: [{ path: 'example.com/b', version: 'v1.0.0', indirect: false }],
    })
  })

  it('stays fast on large hostile input', () => {
    const started = performance.now()
    parseGoMod(`module m\nrequire (\n${'\texample.com/x v1.0.0 // indirect\n'.repeat(50_000)})\n`)
    expect(performance.now() - started).toBeLessThan(timeBudget(2000))
  })
})

describe('parseGoWork', () => {
  it('reads block and single use directives', () => {
    expect(parseGoWork('go 1.25\nuse (\n  ./a\n  "./b" // comment\n\n)\nuse ./c // x\nuse .\n')).toEqual([
      './a',
      './b',
      './c',
      '.',
    ])
    expect(parseGoWork('go 1.25\n')).toEqual([])
  })
})
