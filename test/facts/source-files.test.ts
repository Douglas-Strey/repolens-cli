// biome-ignore-all lint/suspicious/noTemplateCurlyInString: template literal source text is the input under test
import { describe, expect, it } from 'vitest'
import type { ProjectManifests } from '../../src/facts/manifests.ts'
import {
  blankComments,
  createOwnerResolver,
  isGenerated,
  ownerOf,
  SOURCE_EXTENSIONS,
  sourceFiles,
} from '../../src/facts/source-files.ts'
import { contextFor, fixtureContext, makeProject, timeBudget } from '../helpers.ts'

function projectWith(packageDirs: string[], goDirs: string[] = []): ProjectManifests {
  return {
    root: null,
    rootInvalid: false,
    packages: packageDirs.map((dir) => ({
      dir,
      file: dir === '.' ? 'package.json' : `${dir}/package.json`,
      role: dir === '.' ? 'root' : 'workspace',
      scripts: {},
      dependencies: {},
      devDependencies: {},
      peerDependencies: {},
      optionalDependencies: {},
      engines: {},
      workspaces: [],
      hasBin: false,
      raw: {},
    })),
    goModules: goDirs.map((dir) => ({
      dir,
      file: `${dir}/go.mod`,
      role: 'nested',
      module: `example.com/${dir}`,
      requires: [],
      hasGoSum: false,
    })),
    workspaces: [],
    effectivePatterns: [],
    catalogs: {},
  }
}

describe('ownerOf', () => {
  const project = projectWith(['.', 'apps/web', 'apps/web/sub', 'apps/api'], ['services/billing'])

  it('picks the deepest package that contains the file', () => {
    expect(ownerOf(project, 'apps/web/src/main.ts')).toBe('apps/web')
    expect(ownerOf(project, 'apps/web/sub/x.ts')).toBe('apps/web/sub')
    expect(ownerOf(project, 'apps/api/index.ts')).toBe('apps/api')
    expect(ownerOf(project, 'services/billing/main.go')).toBe('services/billing')
    expect(ownerOf(project, 'scripts/x.ts')).toBe('.')
  })

  it('respects directory boundaries', () => {
    expect(ownerOf(project, 'apps/web2/x.ts')).toBe('.')
    expect(ownerOf(project, 'apps/webx.ts')).toBe('.')
  })

  it('treats a package directory as owned by itself and terminates on odd input', () => {
    expect(ownerOf(project, 'apps/web')).toBe('apps/web')
    expect(ownerOf(project, 'apps')).toBe('.')
    expect(ownerOf(project, '.')).toBe('.')
    expect(ownerOf(project, '')).toBe('.')
    expect(ownerOf(project, '/abs/apps/web/x.ts')).toBe('.')
    expect(ownerOf(project, '../apps/web/x.ts')).toBe('.')
  })

  it('resolves owners in time proportional to path depth, not package count', () => {
    const dirs = Array.from({ length: 5000 }, (_, i) => `packages/p${i}`)
    const owner = createOwnerResolver(projectWith(['.', ...dirs], []))
    const started = performance.now()
    for (let i = 0; i < 20_000; i++) expect(owner(`packages/p${i % 5000}/src/x.ts`)).toBe(`packages/p${i % 5000}`)
    expect(owner('packages/other/x.ts')).toBe('.')
    expect(performance.now() - started).toBeLessThan(timeBudget(1000))
  })

  it('createOwnerResolver gives the same answers', () => {
    const owner = createOwnerResolver(project)
    for (const file of ['apps/web/sub/x.ts', 'apps/web/x.ts', 'x.ts', 'services/billing/a/b.go']) {
      expect(owner(file)).toBe(ownerOf(project, file))
    }
  })
})

describe('isGenerated', () => {
  it.each([
    'src/types.d.ts',
    'src/types.d.mts',
    'lib/index.d.cts',
    'public/app.min.js',
    'assets/vendor.min.mjs',
    'x/main.bundle.js',
    'x/123.chunk.cjs',
    'api/service.pb.go',
    'models/models_gen.go',
    'models/x.gen.go',
    'dist/index.js',
    'packages/a/build/index.js',
    'app/out/page.js',
    'src/generated/client.ts',
    'storybook-static/main.js',
  ])('%s is generated', (file) => {
    expect(isGenerated(file)).toBe(true)
  })

  it.each(['src/index.ts', 'src/distance.ts', 'src/build.ts', 'cmd/api/main.go', 'src/min.js', 'src/d.ts'])(
    '%s is source',
    (file) => {
      expect(isGenerated(file)).toBe(false)
    },
  )
})

describe('sourceFiles analyzer', () => {
  it('lists source files of the monorepo fixture with their owning package', async () => {
    const { files, truncated } = await (await fixtureContext('monorepo')).use(sourceFiles)
    expect(truncated).toBe(false)
    expect(files).toEqual([
      { path: 'apps/api/src/index.ts', ext: '.ts', package: 'apps/api' },
      { path: 'apps/web/app/pages/index.vue', ext: '.vue', package: 'apps/web' },
      { path: 'apps/web/nuxt.config.ts', ext: '.ts', package: 'apps/web' },
      { path: 'apps/web/server/api/stats.get.ts', ext: '.ts', package: 'apps/web' },
      { path: 'packages/shared/src/index.ts', ext: '.ts', package: 'packages/shared' },
      { path: 'packages/ui/src/Button.vue', ext: '.vue', package: 'packages/ui' },
      { path: 'packages/ui/src/index.ts', ext: '.ts', package: 'packages/ui' },
      { path: 'services/billing/main.go', ext: '.go', package: 'services/billing' },
    ])
  })

  it('skips declarations, bundles, generated directories and non-source files', async () => {
    const ctx = await contextFor(
      await makeProject({
        'package.json': '{}',
        'src/app.tsx': '',
        'src/env.d.ts': '',
        'src/Page.svelte': '',
        'src/page.astro': '',
        'src/util.MJS': '',
        'public/lib.min.js': '',
        'dist/server.js': '',
        'README.md': '',
        'styles.css': '',
      }),
    )
    const { files } = await ctx.use(sourceFiles)
    expect(files.map((f) => [f.path, f.ext])).toEqual([
      ['src/Page.svelte', '.svelte'],
      ['src/app.tsx', '.tsx'],
      ['src/page.astro', '.astro'],
      ['src/util.MJS', '.mjs'],
    ])
  })

  it('covers JS, TS, framework and Go extensions', () => {
    for (const ext of ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx', '.vue', '.svelte', '.go']) {
      expect(SOURCE_EXTENSIONS.has(ext)).toBe(true)
    }
    expect(SOURCE_EXTENSIONS.has('.json')).toBe(false)
  })
})

describe('blankComments', () => {
  it('blanks JavaScript comments and keeps strings, templates and regexes intact', () => {
    const cases: Array<[string, string]> = [
      ['const u = "http://x" // c\nnext', 'const u = "http://x"     \nnext'],
      ["a = 'x' /* b */ + c", "a = 'x'         + c"],
      ['const r = /\\/\\//g; // c', 'const r = /\\/\\//g;     '],
      ['const t = `a ${ b /* c */ } // d` // e', 'const t = `a ${ b         } // d`     '],
      ['const t = `${`${a}`}` // c', 'const t = `${`${a}`}`     '],
      ['x = a / b // c', 'x = a / b     '],
      ['return /re/.test(x) // c', 'return /re/.test(x)     '],
      ['/** doc\n * @example x\n */\ny', '       \n             \n   \ny'],
    ]
    for (const [input, expected] of cases) {
      expect(blankComments(input, 'js'), input).toBe(expected)
      expect(blankComments(input, 'js')).toHaveLength(input.length)
    }
  })

  it('blanks C-like comments around double-quoted, raw and rune literals', () => {
    expect(blankComments('s := "a//b" // c\nr := `x /* y */`\nq := \'/\' /* z */', 'c')).toBe(
      's := "a//b"     \nr := `x /* y */`\nq := \'/\'        ',
    )
  })

  it('stays linear on hostile input', () => {
    const started = performance.now()
    blankComments(`${'a = 1 / '.repeat(100_000)}\n`, 'js')
    blankComments('x = [ /'.repeat(100_000), 'js')
    blankComments('`${'.repeat(100_000), 'js')
    blankComments('/*'.repeat(100_000), 'js')
    blankComments('"\\'.repeat(100_000), 'c')
    expect(performance.now() - started).toBeLessThan(timeBudget(1000))
  })
})
