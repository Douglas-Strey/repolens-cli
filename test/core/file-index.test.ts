import { describe, expect, it } from 'vitest'
import { createFileIndex } from '../../src/core/file-index.ts'
import type { WalkResult } from '../../src/core/walker.ts'
import { contextFor, makeProject } from '../helpers.ts'

function fakeWalk(files: string[], ignoredFiles: string[] = [], directories: string[] = []): WalkResult {
  return {
    files: [...files].sort(),
    ignoredFiles: [...ignoredFiles].sort(),
    directories: new Set(directories),
    truncated: false,
    isIgnored: (relative, isDirectory) => relative === 'ignored-dir' && isDirectory === true,
  }
}

describe('createFileIndex on a large index', () => {
  it('byExtension returns more paths than fit in one call as arguments', () => {
    const files = Array.from({ length: 250_000 }, (_, i) => `src/f${String(i).padStart(6, '0')}.ts`)
    const index = createFileIndex(fakeWalk(files))
    const ts = index.byExtension('.ts')
    expect(ts).toHaveLength(250_000)
    expect(ts).not.toBe(index.byExtension('ts'))
    expect(index.byExtension('.ts', '.tsx')).toHaveLength(250_000)
  })
})

describe('createFileIndex', () => {
  const index = createFileIndex(
    fakeWalk(
      [
        'package.json',
        'apps/web/package.json',
        'apps/web/src/main.TS',
        'apps/web/src/app.vue',
        'packages/ui/src/index.ts',
        'packages/ui/src/index.tsx',
        'README',
      ],
      ['.env', 'apps/web/.env.local', 'apps/web/package.json.bak'],
      ['apps', 'apps/web', 'apps/web/src', 'packages', 'packages/ui', 'packages/ui/src'],
    ),
  )

  it('has() checks indexed files and optionally ignored ones', () => {
    expect(index.has('package.json')).toBe(true)
    expect(index.has('./package.json')).toBe(true)
    expect(index.has('apps\\web\\package.json')).toBe(true)
    expect(index.has('.env')).toBe(false)
    expect(index.has('.env', { includeIgnored: true })).toBe(true)
    expect(index.has('missing')).toBe(false)
    expect(index.has('apps')).toBe(false)
  })

  it('hasDirectory() knows traversed directories and the root', () => {
    expect(index.hasDirectory('.')).toBe(true)
    expect(index.hasDirectory('')).toBe(true)
    expect(index.hasDirectory('apps/web')).toBe(true)
    expect(index.hasDirectory('apps/web/')).toBe(true)
    expect(index.hasDirectory('./packages')).toBe(true)
    expect(index.hasDirectory('node_modules')).toBe(false)
    expect(index.hasDirectory('package.json')).toBe(false)
  })

  it('byName() returns sorted copies and can include ignored files', () => {
    expect(index.byName('package.json')).toEqual(['apps/web/package.json', 'package.json'])
    const copy = index.byName('package.json')
    copy.push('mutated')
    expect(index.byName('package.json')).toHaveLength(2)
    expect(index.byName('.env.local')).toEqual([])
    expect(index.byName('.env.local', { includeIgnored: true })).toEqual(['apps/web/.env.local'])
    expect(index.byName('nothing', { includeIgnored: true })).toEqual([])
  })

  it('byExtension() is case-insensitive, accepts names without a dot, and dedupes', () => {
    expect(index.byExtension('.ts')).toEqual(['apps/web/src/main.TS', 'packages/ui/src/index.ts'])
    expect(index.byExtension('.TS', 'ts', '.tsx')).toEqual([
      'apps/web/src/main.TS',
      'packages/ui/src/index.ts',
      'packages/ui/src/index.tsx',
    ])
    expect(index.byExtension('vue')).toEqual(['apps/web/src/app.vue'])
    expect(index.byExtension('.md')).toEqual([])
    expect(index.byExtension()).toEqual([])
  })

  it('glob() matches indexed files and optionally ignored ones', () => {
    expect(index.glob('**/package.json')).toEqual(['apps/web/package.json', 'package.json'])
    expect(index.glob('apps/*/src/*.{vue,TS}')).toEqual(['apps/web/src/app.vue', 'apps/web/src/main.TS'])
    expect(index.glob('**/.env*')).toEqual([])
    expect(index.glob('**/.env*', { includeIgnored: true })).toEqual(['.env', 'apps/web/.env.local'])
    expect(index.glob('README')).toEqual(['README'])
  })

  it('isIgnored() forwards the directory flag', () => {
    expect(index.isIgnored('ignored-dir', { directory: true })).toBe(true)
    expect(index.isIgnored('ignored-dir')).toBe(false)
  })
})

describe('FileIndex from a real walk', () => {
  it('exposes ignored files and truncation', async () => {
    const root = await makeProject({
      '.gitignore': '.env\nnode_modules\n',
      '.env': 'X=1',
      'apps/a/package.json': '{}',
      'package.json': '{}',
    })
    const ctx = await contextFor(root, { maxFiles: 2 })
    expect(ctx.files.truncated).toBe(true)
    expect(ctx.files.files).toEqual(['.gitignore', 'package.json'])
    expect(ctx.files.has('.env', { includeIgnored: true })).toBe(true)
    expect(ctx.files.isIgnored('node_modules', { directory: true })).toBe(true)
    expect(ctx.warnings.map((w) => w.message)).toEqual(['Stopped indexing after 2 files; results may be incomplete'])
  })
})
