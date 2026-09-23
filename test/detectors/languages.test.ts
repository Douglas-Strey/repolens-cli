import { describe, expect, it } from 'vitest'
import { countLanguages, languageFiles, languageOf, languagesDetector } from '../../src/detectors/languages.ts'
import { contextFor, fixtureContext, makeProject } from '../helpers.ts'

describe('languageOf', () => {
  it.each([
    ['src/index.ts', 'TypeScript', 'programming'],
    ['src/App.tsx', 'TypeScript', 'programming'],
    ['types/env.d.ts', 'TypeScript', 'programming'],
    ['scripts/build.mjs', 'JavaScript', 'programming'],
    ['legacy/index.CJS', 'JavaScript', 'programming'],
    ['cmd/api/main.go', 'Go', 'programming'],
    ['app/main.py', 'Python', 'programming'],
    ['build.gradle.kts', 'Kotlin', 'programming'],
    ['native/lib.h', 'C', 'programming'],
    ['native/lib.hpp', 'C++', 'programming'],
    ['Program.cs', 'C#', 'programming'],
    ['lib/app.ex', 'Elixir', 'programming'],
    ['scripts/deploy.sh', 'Shell', 'programming'],
    ['scripts/setup.fish', 'Shell', 'programming'],
    ['tools/run.ps1', 'PowerShell', 'programming'],
    ['db/schema.sql', 'SQL', 'programming'],
    ['components/Button.vue', 'Vue', 'markup'],
    ['routes/+page.svelte', 'Svelte', 'markup'],
    ['pages/index.astro', 'Astro', 'markup'],
    ['public/index.htm', 'HTML', 'markup'],
    ['styles/main.css', 'CSS', 'style'],
    ['styles/theme.sass', 'SCSS', 'style'],
    ['styles/legacy.less', 'Less', 'style'],
    ['styles/old.styl', 'Stylus', 'style'],
  ])('classifies %s as %s', (file, name, kind) => {
    expect(languageOf(file)).toEqual({ name, kind })
  })

  it.each([
    'package.json',
    'pnpm-lock.yaml',
    'README.md',
    'Cargo.toml',
    'logo.png',
    'Makefile',
    'Dockerfile',
    '.env',
    'dist/app.min.js',
    'vendor/bootstrap.min.css',
    'dist/bundle.MIN.JS',
  ])('ignores %s', (file) => {
    expect(languageOf(file)).toBeNull()
  })
})

describe('countLanguages', () => {
  it('returns an empty list when nothing is counted', () => {
    expect(countLanguages([])).toEqual([])
    expect(countLanguages(['README.md', 'package.json'])).toEqual([])
  })

  it('sorts by file count, then name, with shares rounded to 3 decimals', () => {
    const stats = countLanguages([
      'a.ts',
      'b.ts',
      'c.tsx',
      'd.go',
      'e.go',
      'f.go',
      'g.css',
      'h.vue',
      'i.c',
      'README.md',
    ])
    expect(stats).toEqual([
      { name: 'Go', kind: 'programming', files: 3, share: 0.333 },
      { name: 'TypeScript', kind: 'programming', files: 3, share: 0.333 },
      { name: 'C', kind: 'programming', files: 1, share: 0.111 },
      { name: 'CSS', kind: 'style', files: 1, share: 0.111 },
      { name: 'Vue', kind: 'markup', files: 1, share: 0.111 },
    ])
  })

  it('is deterministic regardless of input order', () => {
    const files = ['x.py', 'y.rb', 'z.rs', 'w.py', 'v.cs', 'u.cpp']
    expect(countLanguages([...files].reverse())).toEqual(countLanguages(files))
  })
})

describe('languages detector', () => {
  it('counts a fixture copy', async () => {
    const ctx = await fixtureContext('nuxt-app')
    const stats = await ctx.use(languagesDetector)
    expect(stats.map((stat) => stat.name)).toEqual(['TypeScript', 'Vue', 'JavaScript'])
    expect(stats.find((stat) => stat.name === 'Vue')).toMatchObject({ kind: 'markup', files: 6 })
    expect(stats.reduce((sum, stat) => sum + stat.files, 0)).toBe(16)
  })

  it('reports Python and Shell for a project without JavaScript', async () => {
    const stats = await (await fixtureContext('plain-repo')).use(languagesDetector)
    expect(stats).toEqual([
      { name: 'Python', kind: 'programming', files: 4, share: 0.667 },
      { name: 'Shell', kind: 'programming', files: 2, share: 0.333 },
    ])
  })

  it('does not count ignored or dependency directories', async () => {
    const dir = await makeProject({
      '.gitignore': 'dist/\n',
      'src/index.ts': 'export {}',
      'dist/index.js': 'x',
      'node_modules/pkg/index.js': 'x',
    })
    expect(await (await contextFor(dir)).use(languagesDetector)).toEqual([
      { name: 'TypeScript', kind: 'programming', files: 1, share: 1 },
    ])
  })

  it('does not count fixtures, examples or templates, but does count tests', async () => {
    const dir = await makeProject({
      'src/index.ts': 'export {}',
      'test/index.test.ts': 'export {}',
      'test/fixtures/nuxt-app/app.vue': '<template />',
      'test/fixtures/go-api/main.go': 'package main\n',
      'examples/demo/main.py': 'print(1)\n',
      'templates/starter/index.js': 'x',
    })
    expect(await (await contextFor(dir)).use(languagesDetector)).toEqual([
      { name: 'TypeScript', kind: 'programming', files: 2, share: 1 },
    ])
  })

  it('counts samples when the repository is nothing but samples', () => {
    const files = ['README.md', 'examples/a/main.go', 'examples/b/index.ts']
    expect(languageFiles(files)).toEqual(files)
    expect(languageFiles(['src/a.ts', 'examples/b.go'])).toEqual(['src/a.ts'])
  })
})
