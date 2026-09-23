import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { emptySections } from '../../src/core/empty.ts'
import { errorSummary, RepoLensError } from '../../src/core/errors.ts'
import {
  createContext,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_FILE_SIZE,
  DEFAULT_MAX_FILES,
  detect,
  resolveOptions,
  scan,
  sortWarnings,
} from '../../src/core/scan.ts'
import { detectors } from '../../src/detectors/index.ts'
import type { Detector, SectionId } from '../../src/types.ts'
import {
  contextFor,
  copyFixture,
  expectNoPath,
  makeProject,
  makeTempDir,
  SECRET_SENTINEL,
  scanDir,
  TEST_NOW,
} from '../helpers.ts'

async function rejection(promise: Promise<unknown>): Promise<RepoLensError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof RepoLensError) return error
    throw error
  }
  throw new Error('expected a RepoLensError')
}

describe('resolveOptions', () => {
  it('fills in defaults', () => {
    const options = resolveOptions({ cwd: '.' })
    expect(options.cwd).toBe(path.resolve('.'))
    expect(options.maxFiles).toBe(DEFAULT_MAX_FILES)
    expect(options.maxDepth).toBe(DEFAULT_MAX_DEPTH)
    expect(options.maxFileSize).toBe(DEFAULT_MAX_FILE_SIZE)
    expect(options.now).toBeInstanceOf(Date)
    expect(() => options.debug('ignored')).not.toThrow()
  })

  it('accepts explicit limits, including 0 depth and an unlimited file count', () => {
    const options = resolveOptions({ maxFiles: Number.POSITIVE_INFINITY, maxDepth: 0, maxFileSize: 10, now: TEST_NOW })
    expect(options).toMatchObject({ maxFiles: Number.POSITIVE_INFINITY, maxDepth: 0, maxFileSize: 10, now: TEST_NOW })
  })

  it.each([
    { maxFiles: Number.NaN },
    { maxFiles: 0 },
    { maxFiles: -1 },
    { maxFiles: 1.5 },
    { maxDepth: -1 },
    { maxFileSize: Number.NaN },
  ])('rejects %o', (options) => {
    let caught: unknown
    try {
      resolveOptions(options)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(RepoLensError)
    expect((caught as RepoLensError).code).toBe('INVALID_ARGUMENT')
  })
})

describe('scan: root validation', () => {
  it('rejects a directory that does not exist', async () => {
    const dir = path.join(await makeTempDir(), 'missing')
    const error = await rejection(scan({ cwd: dir }))
    expect(error.code).toBe('INVALID_ROOT')
    expect(error.message).toContain('Directory not found')
  })

  it('rejects a file', async () => {
    const root = await makeProject({ 'file.txt': 'x' })
    const error = await rejection(scan({ cwd: path.join(root, 'file.txt') }))
    expect(error.code).toBe('INVALID_ROOT')
    expect(error.message).toContain('Not a directory')
  })

  it('resolves a symlinked root to its real path', async () => {
    if (process.platform === 'win32') return
    const real = await makeProject({ 'package.json': '{"name":"linked"}' })
    const parent = await makeTempDir()
    await fs.symlink(real, path.join(parent, 'link'))
    const ctx = await contextFor(path.join(parent, 'link'))
    expect(ctx.root).toBe(real)
    expect(ctx.files.files).toEqual(['package.json'])
  })
})

describe('createContext', () => {
  it('records walker warnings and truncation as scan warnings', async () => {
    const rules = Array.from({ length: 2100 }, (_, i) => `r${i}`).join('\n')
    const ctx = await createContext({
      cwd: await makeProject({ '.gitignore': rules, a: '', b: '', c: '' }),
      maxFiles: 2,
    })
    expect(ctx.files.truncated).toBe(true)
    expect(ctx.warnings.map((w) => w.message)).toEqual([
      'Ignored 100 rules in .gitignore: the ignore rules for one directory exceed the limit of 2000 (a rule with several "**" counts as more than one)',
      'Stopped indexing after 2 files; results may be incomplete',
    ])
  })
})

describe('Context', () => {
  it('memoizes analyzers, including concurrent calls', async () => {
    const ctx = await contextFor(await makeProject({}))
    let runs = 0
    const analyzer = {
      id: 'counter',
      async run() {
        runs++
        await new Promise((resolve) => setTimeout(resolve, 5))
        return { value: runs }
      },
    }
    const [a, b] = await Promise.all([ctx.use(analyzer), ctx.use(analyzer)])
    const c = await ctx.use(analyzer)
    expect(runs).toBe(1)
    expect(a).toBe(b)
    expect(c).toBe(a)
  })

  it('memoizes failures too, so a broken analyzer runs once', async () => {
    const ctx = await contextFor(await makeProject({}))
    let runs = 0
    const failing = {
      id: 'failing',
      async run(): Promise<never> {
        runs++
        throw new Error('boom')
      },
    }
    await expect(ctx.use(failing)).rejects.toThrow('boom')
    await expect(ctx.use(failing)).rejects.toThrow('boom')
    expect(runs).toBe(1)
  })

  it('deduplicates warnings by file and message', async () => {
    const ctx = await contextFor(await makeProject({}))
    ctx.warn({ kind: 'parse', file: 'a', message: 'm', detail: 'one' })
    ctx.warn({ kind: 'parse', file: 'a', message: 'm', detail: 'two' })
    ctx.warn({ kind: 'parse', file: 'b', message: 'm' })
    ctx.warn({ kind: 'error', message: 'm' })
    expect(ctx.warnings).toEqual([
      { kind: 'parse', file: 'a', message: 'm', detail: 'one' },
      { kind: 'parse', file: 'b', message: 'm' },
      { kind: 'error', message: 'm' },
    ])
  })

  it('forwards debug messages', async () => {
    const messages: string[] = []
    const ctx = await contextFor(await makeProject({ 'a.ts': '' }), { debug: (m) => messages.push(m) })
    ctx.debug('hello')
    expect(messages).toContain('hello')
    expect(messages.some((m) => m.startsWith('walk: 1 files'))).toBe(true)
  })
})

describe('emptySections', () => {
  it('has exactly one entry per detector', () => {
    const empty = emptySections('dir')
    expect(Object.keys(empty).sort()).toEqual(Object.keys(detectors).sort())
    expect(empty.project).toMatchObject({ name: 'dir', directory: 'dir', type: 'unknown' })
  })

  it('returns fresh objects each time', () => {
    const a = emptySections('x')
    a.frameworks.push({} as never)
    expect(emptySections('x').frameworks).toEqual([])
  })
})

describe('detect', () => {
  it('turns a throwing detector into its empty section plus a warning without paths', async () => {
    const root = await makeProject({ 'package.json': '{"name":"x"}' })
    const ctx = await contextFor(root)
    const id: SectionId = 'languages'
    const failing: Detector<'languages'> = {
      id,
      title: 'Languages',
      async run() {
        throw new Error(`cannot open ${root}/secret/file.ts\n    at somewhere (/abs/path.ts:1:1)`)
      },
    }
    {
      const sections = await detect(ctx, { ...detectors, [id]: failing })
      expect(sections.languages).toEqual([])
      const warning = ctx.warnings.find((w) => w.message === 'The Languages detector failed')
      expect(warning?.detail).toBe('Error: cannot open ./secret/file.ts')
      expectNoPath(JSON.stringify(ctx.warnings), root)
      expect(Object.keys(sections).sort()).toEqual(Object.keys(detectors).sort())
    }
    expect(Object.isFrozen(detectors)).toBe(true)
  })

  it('sortWarnings orders by file (file-less first), then message, then detail', () => {
    const warnings = [
      { kind: 'parse' as const, file: 'b.yml', message: 'x' },
      { kind: 'limit' as const, message: 'Stopped indexing' },
      { kind: 'parse' as const, file: 'a.json', message: 'y', detail: '2' },
      { kind: 'parse' as const, file: 'a.json', message: 'y', detail: '1' },
      { kind: 'parse' as const, file: 'a.json', message: 'x' },
    ]
    expect(sortWarnings(warnings)).toEqual([
      { kind: 'limit' as const, message: 'Stopped indexing' },
      { kind: 'parse' as const, file: 'a.json', message: 'x' },
      { kind: 'parse' as const, file: 'a.json', message: 'y', detail: '1' },
      { kind: 'parse' as const, file: 'a.json', message: 'y', detail: '2' },
      { kind: 'parse' as const, file: 'b.yml', message: 'x' },
    ])
    expect(warnings[0]).toEqual({ kind: 'parse', file: 'b.yml', message: 'x' })
  })

  it('errorSummary keeps the first line and hides the root', () => {
    expect(errorSummary(new TypeError('bad /root/x\nstack'), '/root')).toBe('TypeError: bad ./x')
    expect(errorSummary('plain string', '/root')).toBe('plain string')
  })
})

describe('scan', () => {
  it('produces a versioned, deterministic result without absolute paths or secrets', async () => {
    const root = await copyFixture('monorepo')
    const first = await scanDir(root)
    const second = await scanDir(root)
    expect(first.schemaVersion).toBe(1)
    expect(first.tool.name).toBe('repolens')
    expect(first.meta.files).toBeGreaterThan(0)
    expect(first.meta.truncated).toBe(false)
    const json = JSON.stringify(first)
    expect(JSON.stringify(second)).toBe(json)
    expectNoPath(json, root)
    expect(json).not.toContain(SECRET_SENTINEL)
  })

  it('sorts meta.warnings, which are recorded in read completion order', async () => {
    const root = await copyFixture('broken-config')
    const runs = await Promise.all([scanDir(root), scanDir(root), scanDir(root)])
    const warnings = runs[0]?.meta.warnings ?? []
    expect(warnings.length).toBeGreaterThan(3)
    expect(warnings).toEqual(sortWarnings(warnings))
    for (const run of runs) expect(run.meta.warnings).toEqual(warnings)
    expect(JSON.stringify(warnings)).not.toContain(SECRET_SENTINEL)
  })

  it('reports truncation in meta', async () => {
    const result = await scanDir(await makeProject({ 'a.ts': '', 'b.ts': '', 'c.ts': '' }), { maxFiles: 2 })
    expect(result.meta.truncated).toBe(true)
    expect(result.meta.files).toBe(2)
  })
})
