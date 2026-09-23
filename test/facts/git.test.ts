import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  gitConfigValues,
  gitIndex,
  gitLayout,
  gitTrackedFiles,
  indexFacts,
  parseGitConfig,
  parseGitIndex,
  readGitFile,
} from '../../src/facts/git.ts'
import {
  canSymlink,
  contextFor,
  GIT_TEST_ENV,
  gitInit,
  makeProject,
  makeTempDir,
  timeBudget,
  writeFiles,
} from '../helpers.ts'

const GIT_ENV = { ...process.env, ...GIT_TEST_ENV }

/** Run git in tests only. RepoLens itself never runs git. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

function lsFiles(cwd: string): string[] {
  return git(cwd, 'ls-files', '-z').split('\0').filter(Boolean).sort()
}

async function indexVersion(repo: string): Promise<number> {
  return (await fs.readFile(path.join(repo, '.git', 'index'))).readUInt32BE(4)
}

async function trackedFor(dir: string): Promise<string[] | null> {
  const tracked = await (await contextFor(dir)).use(gitTrackedFiles)
  return tracked ? [...tracked].sort() : null
}

describe('parseGitConfig', () => {
  it('parses sections, quoted subsections and case-insensitive keys', () => {
    const entries = parseGitConfig(
      [
        '[core]',
        '\trepositoryformatversion = 0',
        '\tBare = false',
        '[Remote "Origin"]',
        '\tURL = https://github.com/acme/app.git',
        '\tfetch = +refs/heads/*:refs/remotes/origin/*',
        '[branch "feature/a \\"quoted\\""]',
        '\tremote = origin',
      ].join('\n'),
    )
    expect(gitConfigValues(entries, 'core', null, 'bare')).toEqual(['false'])
    // Subsections are case-sensitive, section and key names are not.
    expect(gitConfigValues(entries, 'remote', 'Origin', 'url')).toEqual(['https://github.com/acme/app.git'])
    expect(gitConfigValues(entries, 'REMOTE', 'Origin', 'URL')).toEqual(['https://github.com/acme/app.git'])
    expect(gitConfigValues(entries, 'remote', 'origin', 'url')).toEqual([])
    expect(gitConfigValues(entries, 'branch', 'feature/a "quoted"', 'remote')).toEqual(['origin'])
  })

  it('handles comments, quotes, escapes, continuations and bare keys', () => {
    const entries = parseGitConfig(
      [
        '# leading comment',
        '; another comment',
        '[alias]',
        '\tsemi = "a;b" ; trailing comment',
        '\thash = value # comment',
        '\tquoted = "  padded  "',
        '\tescaped = tab\\there\\nnewline \\"q\\"',
        '\tspaced =   several   words   ',
        '\tcontinued = first \\',
        '  second',
        '\tflag',
        '[core] editor = vim',
      ].join('\n'),
    )
    const value = (key: string, section = 'alias') =>
      entries.find((entry) => entry.section === section && entry.key === key)?.value
    expect(value('semi')).toBe('a;b')
    expect(value('hash')).toBe('value')
    expect(value('quoted')).toBe('  padded  ')
    expect(value('escaped')).toBe('tab\there\nnewline "q"')
    expect(value('spaced')).toBe('several   words')
    // Like git: whitespace around the continuation is kept (one space before, two after).
    expect(value('continued')).toBe('first   second')
    expect(entries.find((entry) => entry.key === 'flag')?.value).toBeNull()
    expect(value('editor', 'core')).toBe('vim')
  })

  it('supports the deprecated [section.subsection] form', () => {
    const entries = parseGitConfig('[remote.Origin]\n\turl = git@github.com:a/b.git\n')
    expect(gitConfigValues(entries, 'remote', 'origin', 'url')).toEqual(['git@github.com:a/b.git'])
  })

  it('skips malformed lines without throwing', () => {
    const entries = parseGitConfig('key = before any section\n[broken\n= novalue\n[ok]\n\t9bad = x\n\tgood = y\n')
    expect(entries).toEqual([{ section: 'ok', subsection: null, key: 'good', value: 'y' }])
  })
})

describe('parseGitIndex', () => {
  it('rejects data that is not a Git index', () => {
    expect(parseGitIndex(Buffer.alloc(0))).toBeNull()
    expect(parseGitIndex(Buffer.from('not an index at all'))).toBeNull()
    const header = Buffer.alloc(12)
    header.write('DIRC', 0, 'latin1')
    header.writeUInt32BE(5, 4)
    expect(parseGitIndex(header)).toBeNull()
    header.writeUInt32BE(2, 4)
    header.writeUInt32BE(0, 8)
    expect(parseGitIndex(header)).toEqual([])
    // Claims one entry but has no entry data.
    header.writeUInt32BE(1, 8)
    expect(parseGitIndex(header)).toBeNull()
  })

  it('rejects a truncated real index', async () => {
    const repo = await makeProject({ 'a.txt': 'a', 'dir/b.txt': 'b' })
    gitInit(repo)
    const buffer = await fs.readFile(path.join(repo, '.git', 'index'))
    expect(parseGitIndex(buffer)).toEqual(['a.txt', 'dir/b.txt'])
    expect(parseGitIndex(buffer.subarray(0, 80))).toBeNull()
  })

  it.each([2, 3, 4])('reads index version %i like git ls-files', async (version) => {
    const repo = await makeProject({
      'README.md': '# x',
      'src/index.ts': 'export {}',
      'src/lib/deep/util.ts': 'export {}',
      'src/lib/deep/util.test.ts': 'export {}',
      'docs/guide.md': 'guide',
      'ünïcödé.txt': 'u',
    })
    gitInit(repo)
    git(repo, 'update-index', '--index-version', String(version))
    // Version 3 is only written when an entry needs extended flags.
    if (version === 3) git(repo, 'update-index', '--skip-worktree', 'README.md')
    expect(await indexVersion(repo)).toBe(version)

    const parsed = parseGitIndex(await fs.readFile(path.join(repo, '.git', 'index')))
    expect(parsed?.slice().sort()).toEqual(lsFiles(repo))
  })

  it('refuses a version 4 index whose prefix compression expands far beyond its size', () => {
    // First entry: a 100 KB path. Every later entry strips nothing and adds nothing, repeating it.
    const entries = 20_000
    const fixed = 62
    const header = Buffer.alloc(12)
    header.write('DIRC', 0, 'latin1')
    header.writeUInt32BE(4, 4)
    header.writeUInt32BE(entries, 8)
    const first = Buffer.alloc(fixed + 1 + 100_000 + 1)
    first.fill(0x61, fixed + 1, fixed + 1 + 100_000)
    const repeat = Buffer.alloc(fixed + 2)
    const buffer = Buffer.concat([header, first, ...Array.from({ length: entries - 1 }, () => repeat)])

    const started = performance.now()
    expect(parseGitIndex(buffer)).toBeNull()
    expect(performance.now() - started).toBeLessThan(timeBudget(500))
    // The same layout with a few entries is a valid (if odd) index.
    header.writeUInt32BE(3, 8)
    expect(parseGitIndex(Buffer.concat([header, first, repeat, repeat]))).toHaveLength(3)
  })

  it('reads SHA-256 repositories', async () => {
    const repo = await makeProject({ 'a.txt': 'a', 'b/c.txt': 'c' })
    git(repo, 'init', '-q', '--object-format=sha256', '-b', 'main')
    git(repo, 'add', '-A')
    expect(await trackedFor(repo)).toEqual(['a.txt', 'b/c.txt'])
  })
})

describe('indexFacts', () => {
  const paths = [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'README.md',
    'apps/.yarnrc.yml',
    'apps/secret-notes.txt',
    'apps/web/package.json',
    'apps/web/src/index.ts',
    'apps/webby/package-lock.json',
    'packages/ui/package-lock.json',
    'sparse/',
  ]

  it('maps tracked files onto the scan root', () => {
    expect([...indexFacts(paths, 'apps/web').tracked]).toEqual(['package.json', 'src/index.ts'])
    expect(indexFacts(paths, '').tracked.size).toBe(paths.length - 1)
  })

  it('keeps only package-manager files of the directories above the scan root, nearest first', () => {
    expect(indexFacts(paths, 'apps/web').ancestors).toEqual([
      { dir: 'apps', levels: 1, files: ['.yarnrc.yml'] },
      { dir: '', levels: 2, files: ['pnpm-lock.yaml', 'pnpm-workspace.yaml'] },
    ])
    expect(indexFacts(paths, '').ancestors).toEqual([])
  })

  it('is read from the real index of a repository scanned in a subdirectory', async () => {
    const repo = await makeProject({ 'yarn.lock': '', 'pkg/a/package.json': '{}' })
    gitInit(repo)
    const facts = await (await contextFor(path.join(repo, 'pkg/a'))).use(gitIndex)
    expect(facts?.ancestors).toEqual([{ dir: '', levels: 2, files: ['yarn.lock'] }])
    expect([...(facts?.tracked ?? [])]).toEqual(['package.json'])
  })
})

describe('gitLayout', () => {
  it('is null outside any repository', async () => {
    const dir = await makeProject({ 'file.txt': 'x' })
    expect(await (await contextFor(dir)).use(gitLayout)).toBeNull()
    expect(await trackedFor(dir)).toBeNull()
  })

  it('finds the repository at the root', async () => {
    const repo = await makeProject({ 'a.txt': 'a' })
    gitInit(repo)
    const layout = await (await contextFor(repo)).use(gitLayout)
    expect(layout).toMatchObject({ linkedWorktree: false, prefix: '' })
    expect(layout?.gitDir).toBe(path.join(repo, '.git'))
    expect(layout?.commonDir).toBe(layout?.gitDir)
  })

  it('maps index paths when the scan root is a subdirectory', async () => {
    const repo = await makeProject({
      'root.txt': 'r',
      'packages/app/index.ts': 'x',
      'packages/app/src/deep.ts': 'x',
      'packages/other/index.ts': 'x',
    })
    gitInit(repo)
    const sub = path.join(repo, 'packages', 'app')
    const layout = await (await contextFor(sub)).use(gitLayout)
    expect(layout?.prefix).toBe('packages/app')
    expect(await trackedFor(sub)).toEqual(['index.ts', 'src/deep.ts'])
  })

  it('follows a linked worktree to its per-worktree and common git dirs', async () => {
    const repo = await makeProject({ 'a.txt': 'a' })
    gitInit(repo)
    const worktree = path.join(await makeTempDir(), 'wt')
    git(repo, 'worktree', 'add', '-q', worktree, '-b', 'feature')
    const layout = await (await contextFor(worktree)).use(gitLayout)
    expect(layout?.linkedWorktree).toBe(true)
    expect(layout?.commonDir).toBe(path.join(repo, '.git'))
    expect(layout?.gitDir).toBe(path.join(repo, '.git', 'worktrees', 'wt'))
    expect(await readGitFile(layout as NonNullable<typeof layout>, 'HEAD')).toContain('refs/heads/feature')
    expect(await trackedFor(worktree)).toEqual(['a.txt'])
  })

  it('follows a submodule checkout to .git/modules', async () => {
    const base = await makeTempDir()
    const sub = path.join(base, 'sub')
    await writeFiles(sub, { 'lib.txt': 'lib' })
    gitInit(sub)
    const superRepo = path.join(base, 'super')
    await writeFiles(superRepo, { 'main.txt': 'main' })
    gitInit(superRepo)
    git(superRepo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'libs/sub')

    const checkout = path.join(superRepo, 'libs', 'sub')
    const layout = await (await contextFor(checkout)).use(gitLayout)
    expect(layout?.linkedWorktree).toBe(true)
    expect(layout?.gitDir).toBe(path.join(superRepo, '.git', 'modules', 'libs', 'sub'))
    expect(await trackedFor(checkout)).toEqual(['lib.txt'])
  })

  it('rejects malformed .git files', async () => {
    for (const content of ['gitdir:\n', 'gitdir:    \n', 'not a pointer\n', '', `gitdir: ${'x'.repeat(5000)}\n`]) {
      const dir = await makeProject({ '.git': content })
      expect(await (await contextFor(dir)).use(gitLayout)).toBeNull()
    }
  })

  it('rejects a .git file pointing outside Git metadata ("gitdir: /etc")', async () => {
    const dir = await makeProject({ '.git': 'gitdir: /etc\n', 'a.txt': 'a' })
    const ctx = await contextFor(dir)
    expect(await ctx.use(gitLayout)).toBeNull()
    expect(await ctx.use(gitTrackedFiles)).toBeNull()
    expect(ctx.warnings.some((warning) => warning.file === '.git')).toBe(true)
  })

  it('rejects a .git file pointing at another repository on the machine', async () => {
    const victim = await makeProject({ 'secret.txt': 'x' })
    gitInit(victim)
    git(victim, 'remote', 'add', 'origin', 'https://example.com/private/victim.git')
    const attacker = await makeProject({ '.git': `gitdir: ${path.join(victim, '.git')}\n` })
    expect(await (await contextFor(attacker)).use(gitLayout)).toBeNull()

    // A relative pointer is just as unwelcome.
    const relative = await makeProject({})
    await writeFiles(relative, { '.git': `gitdir: ${path.relative(relative, path.join(victim, '.git'))}\n` })
    expect(await (await contextFor(relative)).use(gitLayout)).toBeNull()
  })

  it("rejects a .git file pointing at another checkout's worktree metadata", async () => {
    const victim = await makeProject({ 'a.txt': 'a' })
    gitInit(victim)
    const victimWorktree = path.join(await makeTempDir(), 'victim-wt')
    git(victim, 'worktree', 'add', '-q', victimWorktree, '-b', 'private-branch')
    const attacker = await makeProject({ '.git': `gitdir: ${path.join(victim, '.git', 'worktrees', 'victim-wt')}\n` })
    expect(await (await contextFor(attacker)).use(gitLayout)).toBeNull()
  })

  it('rejects in-repo metadata whose commondir escapes to another repository', async () => {
    const victim = await makeProject({ 'a.txt': 'a' })
    gitInit(victim)
    const attacker = await makeProject({
      '.git': 'gitdir: fake\n',
      'fake/HEAD': 'ref: refs/heads/main\n',
      'fake/gitdir': '../.git\n',
      'fake/commondir': `${path.join(victim, '.git')}\n`,
    })
    expect(await (await contextFor(attacker)).use(gitLayout)).toBeNull()
  })

  it.skipIf(!canSymlink)('does not follow symlinks out of the git directory', async () => {
    const outside = await makeProject({ config: '[remote "origin"]\n\turl = https://example.com/outside.git\n' })
    const repo = await makeProject({ 'a.txt': 'a' })
    gitInit(repo)
    await fs.rm(path.join(repo, '.git', 'config'))
    await fs.symlink(path.join(outside, 'config'), path.join(repo, '.git', 'config'))
    const layout = await (await contextFor(repo)).use(gitLayout)
    expect(layout).not.toBeNull()
    expect(await readGitFile(layout as NonNullable<typeof layout>, 'config', 'common')).toBeNull()
    expect(await readGitFile(layout as NonNullable<typeof layout>, '../outside/config', 'common')).toBeNull()
    expect(await readGitFile(layout as NonNullable<typeof layout>, 'HEAD')).toContain('ref: refs/heads/main')
  })

  it('stops at an unusable .git directory instead of climbing to a parent repository', async () => {
    const parent = await makeProject({ 'child/a.txt': 'a' })
    gitInit(parent)
    const child = path.join(parent, 'child')
    expect((await (await contextFor(child)).use(gitLayout))?.prefix).toBe('child')
    await fs.mkdir(path.join(child, '.git'))
    expect(await (await contextFor(child)).use(gitLayout)).toBeNull()
  })
})
