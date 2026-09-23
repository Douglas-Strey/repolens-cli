import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isBinary, readBinaryFile, readRegularFile, readTextWithin } from '../../src/core/fs.ts'
import { contextFor, makeProject, makeTempDir, SECRET_SENTINEL } from '../helpers.ts'

const posixOnly = process.platform === 'win32' ? it.skip : it
const canChmod = process.platform !== 'win32' && process.getuid?.() !== 0 ? it : it.skip
const MAX = 1024 * 1024

describe('readTextWithin: path containment', () => {
  it.each([
    '../x',
    '../../etc/passwd',
    '/etc/passwd',
    'a/../../x',
    './../x',
    '..\\x',
    'a\\..\\..\\x',
    'C:\\x',
    'c:/x',
    '\\\\server\\share\\x',
    '',
    '   ',
  ])('refuses %j', async (relative) => {
    const root = await makeProject({ 'inside.txt': 'ok' })
    const result = await readTextWithin(root, relative, MAX)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(['outside-root', 'missing', 'not-a-file']).toContain(result.reason)
    if (!result.ok && relative.includes('..')) expect(result.reason).toBe('outside-root')
  })

  it('reads a normal file and normalizes harmless path forms', async () => {
    const root = await makeProject({ 'a/b.txt': 'hello', '..data': 'dots' })
    expect(await readTextWithin(root, 'a/b.txt', MAX)).toEqual({ ok: true, text: 'hello' })
    expect(await readTextWithin(root, './a/b.txt', MAX)).toEqual({ ok: true, text: 'hello' })
    expect(await readTextWithin(root, 'a/./x/../b.txt', MAX)).toEqual({ ok: true, text: 'hello' })
    expect(await readTextWithin(root, 'a\\b.txt', MAX)).toEqual({ ok: true, text: 'hello' })
    // "..data" is a file name inside the root, not a traversal.
    expect(await readTextWithin(root, '..data', MAX)).toEqual({ ok: true, text: 'dots' })
  })

  it('reports missing files and directories', async () => {
    const root = await makeProject({ 'dir/file.txt': 'x' })
    expect(await readTextWithin(root, 'nope.txt', MAX)).toMatchObject({ ok: false, reason: 'missing' })
    expect(await readTextWithin(root, 'dir/file.txt/child', MAX)).toMatchObject({ ok: false, reason: 'missing' })
    expect(await readTextWithin(root, 'dir', MAX)).toMatchObject({ ok: false, reason: 'not-a-file' })
    expect(await readTextWithin(root, '.', MAX)).toMatchObject({ ok: false, reason: 'not-a-file' })
  })

  it('does not throw on NUL bytes in the path', async () => {
    const root = await makeProject({ 'a.txt': 'x' })
    const result = await readTextWithin(root, 'a.txt\u0000../../etc/passwd', MAX)
    expect(result.ok).toBe(false)
  })
})

describe('readTextWithin: symlinks', () => {
  posixOnly('refuses a symlink to a file outside the root', async () => {
    const outside = await makeProject({ 'secret.txt': SECRET_SENTINEL })
    const root = await makeProject({})
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'))
    expect(await readTextWithin(root, 'link.txt', MAX)).toMatchObject({ ok: false, reason: 'outside-root' })
  })

  posixOnly('refuses a relative symlink that climbs out of the root', async () => {
    const parent = await makeTempDir()
    await fs.writeFile(path.join(parent, 'secret.txt'), SECRET_SENTINEL)
    const root = path.join(parent, 'repo')
    await fs.mkdir(root)
    await fs.symlink('../secret.txt', path.join(root, 'link.txt'))
    expect(await readTextWithin(root, 'link.txt', MAX)).toMatchObject({ ok: false, reason: 'outside-root' })
  })

  posixOnly('allows a symlink to a file inside the root', async () => {
    const root = await makeProject({ 'real/target.txt': 'inside' })
    await fs.symlink('real/target.txt', path.join(root, 'link.txt'))
    expect(await readTextWithin(root, 'link.txt', MAX)).toEqual({ ok: true, text: 'inside' })
  })

  posixOnly('refuses files below a symlinked directory that points outside the root', async () => {
    const outside = await makeProject({ 'secret.txt': SECRET_SENTINEL })
    const root = await makeProject({})
    await fs.symlink(outside, path.join(root, 'linked'))
    expect(await readTextWithin(root, 'linked/secret.txt', MAX)).toMatchObject({ ok: false, reason: 'outside-root' })
  })

  posixOnly('treats a symlink loop as unreadable instead of hanging', async () => {
    const root = await makeProject({})
    await fs.symlink('b', path.join(root, 'a'))
    await fs.symlink('a', path.join(root, 'b'))
    const result = await readTextWithin(root, 'a', MAX)
    expect(result).toMatchObject({ ok: false, reason: 'unreadable' })
  })
})

describe('readTextWithin: special and unusual files', () => {
  posixOnly(
    'skips a FIFO without blocking',
    async () => {
      const root = await makeProject({})
      execFileSync('mkfifo', [path.join(root, 'pipe')])
      expect(await readTextWithin(root, 'pipe', MAX)).toMatchObject({ ok: false, reason: 'not-a-file' })
      expect(await readRegularFile(path.join(root, 'pipe'), MAX)).toMatchObject({ ok: false, reason: 'not-a-file' })
      expect(await readBinaryFile(path.join(root, 'pipe'), MAX)).toBeNull()
    },
    5000,
  )

  posixOnly(
    'skips a symlink to a FIFO without blocking',
    async () => {
      const root = await makeProject({})
      execFileSync('mkfifo', [path.join(root, 'pipe')])
      await fs.symlink('pipe', path.join(root, 'link'))
      expect(await readTextWithin(root, 'link', MAX)).toMatchObject({ ok: false, reason: 'not-a-file' })
    },
    5000,
  )

  it('skips files larger than the limit', async () => {
    const root = await makeProject({ 'big.txt': 'x'.repeat(2048), 'small.txt': 'x'.repeat(1024) })
    expect(await readTextWithin(root, 'big.txt', 1024)).toMatchObject({ ok: false, reason: 'too-large' })
    expect(await readTextWithin(root, 'small.txt', 1024)).toEqual({ ok: true, text: 'x'.repeat(1024) })
  })

  it('skips binary files with NUL bytes', async () => {
    const root = await makeTempDir()
    await fs.writeFile(path.join(root, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))
    expect(await readTextWithin(root, 'image.png', MAX)).toMatchObject({ ok: false, reason: 'binary' })
  })

  it('only sniffs the first 8000 bytes for NUL', () => {
    expect(isBinary(Buffer.from('plain text'))).toBe(false)
    expect(isBinary(Buffer.from([0x61, 0x00]))).toBe(true)
    expect(isBinary(Buffer.concat([Buffer.alloc(8000, 0x61), Buffer.from([0])]))).toBe(false)
  })

  it('strips a UTF-8 BOM', async () => {
    const root = await makeTempDir()
    await fs.writeFile(path.join(root, 'bom.json'), Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('{"a":1}')]))
    expect(await readTextWithin(root, 'bom.json', MAX)).toEqual({ ok: true, text: '{"a":1}' })
  })

  it('reads empty files as empty text', async () => {
    const root = await makeProject({ empty: '' })
    expect(await readTextWithin(root, 'empty', MAX)).toEqual({ ok: true, text: '' })
  })

  canChmod('reports unreadable files without throwing', async () => {
    const root = await makeProject({ 'locked.txt': 'secret' })
    await fs.chmod(path.join(root, 'locked.txt'), 0o000)
    try {
      expect(await readTextWithin(root, 'locked.txt', MAX)).toMatchObject({ ok: false, reason: 'unreadable' })
    } finally {
      await fs.chmod(path.join(root, 'locked.txt'), 0o644)
    }
  })
})

describe('readRegularFile / readBinaryFile', () => {
  posixOnly('never follows a symlink in the final path component', async () => {
    const root = await makeProject({ 'target.txt': 'x' })
    await fs.symlink(path.join(root, 'target.txt'), path.join(root, 'link.txt'))
    expect(await readRegularFile(path.join(root, 'target.txt'), MAX)).toEqual({ ok: true, text: 'x' })
    expect((await readRegularFile(path.join(root, 'link.txt'), MAX)).ok).toBe(false)
    expect(await readBinaryFile(path.join(root, 'link.txt'), MAX)).toBeNull()
  })

  it('reads binary content with a size cap', async () => {
    const root = await makeTempDir()
    await fs.writeFile(path.join(root, 'data.bin'), Buffer.from([0, 1, 2, 3]))
    expect(await readBinaryFile(path.join(root, 'data.bin'), MAX)).toEqual(Buffer.from([0, 1, 2, 3]))
    expect(await readBinaryFile(path.join(root, 'data.bin'), 3)).toBeNull()
    expect(await readBinaryFile(path.join(root, 'missing.bin'), MAX)).toBeNull()
    expect(await readBinaryFile(root, MAX)).toBeNull()
  })
})

describe('Context.readText', () => {
  it('returns null for traversal attempts and never throws', async () => {
    const ctx = await contextFor(await makeProject({ 'a.txt': 'a' }))
    for (const attempt of ['../x', '/etc/passwd', 'a/../../x', '..\\x', 'C:\\x']) {
      expect(await ctx.readText(attempt)).toBeNull()
    }
    expect(ctx.warnings).toEqual([])
  })

  it('warns once about files over the size limit', async () => {
    const ctx = await contextFor(await makeProject({ 'big.json': `"${'x'.repeat(200)}"` }), { maxFileSize: 100 })
    expect(await ctx.readText('big.json')).toBeNull()
    expect(await ctx.readJson('big.json')).toBeNull()
    expect(ctx.warnings).toEqual([
      { kind: 'size', file: 'big.json', message: 'Skipped big.json because it is larger than the read limit' },
    ])
  })

  it('honors a per-read maxBytes without caching the result', async () => {
    const ctx = await contextFor(await makeProject({ 'src.ts': 'x'.repeat(50) }))
    expect(await ctx.readText('src.ts', { maxBytes: 10, cache: false })).toBeNull()
    expect(await ctx.readText('src.ts')).toBe('x'.repeat(50))
  })

  it('caches reads under a normalized key', async () => {
    const root = await makeProject({ 'pkg/a.txt': 'first' })
    const ctx = await contextFor(root)
    expect(await ctx.readText('pkg/a.txt')).toBe('first')
    await fs.writeFile(path.join(root, 'pkg', 'a.txt'), 'second')
    expect(await ctx.readText('./pkg/a.txt')).toBe('first')
    expect(await ctx.readText('pkg/a.txt', { cache: false })).toBe('second')
  })

  it('reads ignored files that exist on disk (e.g. .env) but not directories', async () => {
    const ctx = await contextFor(await makeProject({ '.gitignore': '.env\n', '.env': 'A=1\n', 'dir/x': '' }))
    expect(await ctx.readText('.env')).toBe('A=1\n')
    expect(await ctx.readText('dir')).toBeNull()
  })

  it('reports parse errors as warnings without echoing file contents', async () => {
    const ctx = await contextFor(
      await makeProject({
        'bad.json': `{"password": ${SECRET_SENTINEL}}`,
        'bad.jsonc': `{\n  // comment\n  "token": "${SECRET_SENTINEL}" "x": 1\n}`,
        'bad.yml': `a: *${SECRET_SENTINEL}\n`,
        'list.json': '[1, 2]',
      }),
    )
    expect(await ctx.readJson('bad.json')).toBeNull()
    expect(await ctx.readJsonc('bad.jsonc')).toBeNull()
    expect(await ctx.readYaml('bad.yml')).toBeNull()
    expect(await ctx.readJson('list.json')).toEqual([1, 2])
    expect(ctx.warnings.map((w) => w.message)).toEqual([
      "Couldn't parse bad.json",
      "Couldn't parse bad.jsonc",
      "Couldn't parse bad.yml",
    ])
    expect(JSON.stringify(ctx.warnings)).not.toContain(SECRET_SENTINEL)
    expect(ctx.warnings[1]?.detail).toMatch(/line 3/)
  })

  it('returns null for a missing file without a warning', async () => {
    const ctx = await contextFor(await makeProject({}))
    expect(await ctx.readJson('package.json')).toBeNull()
    expect(await ctx.readYaml('x.yml')).toBeNull()
    expect(ctx.warnings).toEqual([])
  })
})
