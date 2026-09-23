import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  branchOf,
  displayRemoteUrl,
  gitDetector,
  isSafeRefName,
  parseHead,
  parsePackedRefs,
  remoteHostKind,
  remoteHostname,
  remotesFromConfig,
  submodulePaths,
  usesLfs,
} from '../../src/detectors/git.ts'
import { parseGitConfig } from '../../src/facts/git.ts'
import type { GitSection } from '../../src/types.ts'
import {
  canSymlink,
  contextFor,
  GIT_TEST_ENV,
  gitAtLeast,
  gitInit,
  makeProject,
  makeTempDir,
  scanDir,
  writeFiles,
} from '../helpers.ts'

const GIT_ENV = { ...process.env, ...GIT_TEST_ENV }

/** Run git in tests only. RepoLens itself never runs git. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

async function detectGit(dir: string): Promise<GitSection | null> {
  return (await contextFor(dir)).use(gitDetector)
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  )
}

describe('git detector on real repositories', () => {
  it('reports branch, head, remotes and tracked files, stripping credentials from remote URLs', async () => {
    const repo = await makeProject({ 'a.txt': 'a', 'src/b.ts': 'b' })
    gitInit(repo)
    git(repo, 'remote', 'add', 'origin', 'https://user:s3cr3t-token@github.com/acme/app.git')
    git(repo, 'remote', 'add', 'backup', 'git@gitlab.com:acme/app.git')

    const section = await detectGit(repo)
    expect(section).toEqual({
      branch: 'main',
      head: git(repo, 'rev-parse', '--short=7', 'HEAD'),
      remotes: [
        { name: 'origin', url: 'https://github.com/acme/app.git', host: 'github' },
        { name: 'backup', url: 'git@gitlab.com:acme/app.git', host: 'gitlab' },
      ],
      submodules: [],
      lfs: false,
      trackedFiles: 2,
      linkedWorktree: false,
    })
    expect(JSON.stringify(section)).not.toContain('token')
    expect(JSON.stringify(section)).not.toContain('s3cr3t')
  })

  it('reports a detached HEAD with a null branch', async () => {
    const repo = await makeProject({ 'a.txt': 'a' })
    gitInit(repo)
    git(repo, 'checkout', '-q', '--detach')
    const section = await detectGit(repo)
    expect(section?.branch).toBeNull()
    expect(section?.head).toBe(git(repo, 'rev-parse', '--short=7', 'HEAD'))
  })

  it('resolves HEAD through packed-refs', async () => {
    const repo = await makeProject({ 'a.txt': 'a' })
    gitInit(repo)
    git(repo, 'checkout', '-q', '-b', 'feature/x')
    git(repo, 'pack-refs', '--all')
    expect(await exists(path.join(repo, '.git', 'refs', 'heads', 'feature', 'x'))).toBe(false)
    const section = await detectGit(repo)
    expect(section?.branch).toBe('feature/x')
    expect(section?.head).toBe(git(repo, 'rev-parse', '--short=7', 'HEAD'))
  })

  it('handles a fresh repository without commits', async () => {
    const repo = await makeProject({ 'a.txt': 'a' })
    git(repo, 'init', '-q', '-b', 'main')
    expect(await detectGit(repo)).toMatchObject({ branch: 'main', head: null, trackedFiles: null, remotes: [] })

    git(repo, 'add', 'a.txt')
    expect(await detectGit(repo)).toMatchObject({ branch: 'main', head: null, trackedFiles: 1 })
  })

  it('counts tracked files from a version 4 index', async () => {
    const repo = await makeProject({ 'a.txt': 'a', 'x/y/z.txt': 'z', 'x/y/zz.txt': 'zz' })
    gitInit(repo)
    git(repo, 'update-index', '--index-version', '4')
    expect((await detectGit(repo))?.trackedFiles).toBe(3)
  })

  it('reads a linked worktree through its common directory', async () => {
    const repo = await makeProject({ 'a.txt': 'a' })
    gitInit(repo)
    git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/app.git')
    const worktree = path.join(await makeTempDir(), 'wt')
    git(repo, 'worktree', 'add', '-q', worktree, '-b', 'feature')

    const section = await detectGit(worktree)
    expect(section).toMatchObject({
      branch: 'feature',
      head: git(worktree, 'rev-parse', '--short=7', 'HEAD'),
      remotes: [{ name: 'origin', url: 'https://github.com/acme/app.git', host: 'github' }],
      trackedFiles: 1,
      linkedWorktree: true,
    })
  })

  it('maps the index when the scan root is a subdirectory of the repository', async () => {
    const repo = await makeProject({
      'root.txt': 'r',
      'apps/web/a.ts': 'a',
      'apps/web/lib/b.ts': 'b',
      'apps/api/c.ts': 'c',
    })
    gitInit(repo)
    const section = await detectGit(path.join(repo, 'apps', 'web'))
    expect(section).toMatchObject({ branch: 'main', trackedFiles: 2, linkedWorktree: false })
  })

  it('never runs git: a core.fsmonitor hook in the repository config is not triggered', async () => {
    const repo = await makeProject({ 'a.txt': 'a' })
    gitInit(repo)
    const trap = await makeTempDir('repolens-trap-')
    const marker = path.join(trap, 'MARKER')
    const hook = path.join(trap, 'hook.sh')
    // Forward slashes: Git for Windows runs hooks through sh, which would strip backslashes.
    const sh = (p: string) => p.replaceAll('\\', '/')
    await fs.writeFile(hook, `#!/bin/sh\ntouch "${sh(marker)}"\necho 1\n`, { mode: 0o755 })
    git(repo, 'config', 'core.fsmonitor', sh(hook))
    git(repo, 'config', 'core.pager', `touch "${sh(marker)}"`)

    const result = await scanDir(repo)
    expect(result.git?.branch).toBe('main')
    expect(await exists(marker)).toBe(false)

    // Prove the trap is armed: running git in the repository fires the hook.
    git(repo, 'status')
    expect(await exists(marker)).toBe(true)
  })

  it('returns null for a malicious .git file pointing outside Git metadata', async () => {
    const dir = await makeProject({ '.git': 'gitdir: /etc\n', 'a.txt': 'a' })
    expect(await detectGit(dir)).toBeNull()
  })

  it('returns null outside any repository', async () => {
    const dir = await makeProject({ 'a.txt': 'a' })
    expect(await detectGit(dir)).toBeNull()
  })

  it('reads submodules from .gitmodules and LFS from .gitattributes', async () => {
    const repo = await makeProject({
      '.gitmodules': '[submodule "vendor/lib"]\n\tpath = vendor/lib\n\turl = https://github.com/acme/lib.git\n',
      '.gitattributes': '* text=auto\n*.psd filter=lfs diff=lfs merge=lfs -text\n',
      'a.txt': 'a',
    })
    gitInit(repo)
    expect(await detectGit(repo)).toMatchObject({ submodules: ['vendor/lib'], lfs: true })
  })

  // --ref-format=reftable needs git 2.45+.
  it.skipIf(!gitAtLeast(2, 45))('does not report a branch or head for reftable repositories', async () => {
    const repo = await makeProject({ 'a.txt': 'a' })
    git(repo, 'init', '-q', '--ref-format=reftable', '-b', 'main')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '--no-gpg-sign', '-m', 'init')
    expect(await detectGit(repo)).toMatchObject({ branch: null, head: null, trackedFiles: 1 })
  })

  it.skipIf(!canSymlink)('ignores a symlinked ref pointing outside the git directory', async () => {
    const outside = await makeProject({ sha: `${'a'.repeat(40)}\n` })
    const repo = await makeProject({ 'a.txt': 'a' })
    gitInit(repo)
    const ref = path.join(repo, '.git', 'refs', 'heads', 'main')
    await fs.rm(ref)
    await fs.symlink(path.join(outside, 'sha'), ref)
    expect(await detectGit(repo)).toMatchObject({ branch: 'main', head: null })
  })

  it('handles a corrupted HEAD, config and index without crashing', async () => {
    const repo = await makeProject({ 'a.txt': 'a' })
    gitInit(repo)
    await writeFiles(repo, {
      '.git/config': '[remote "origin"\n\turl = \n[[[\n',
      '.git/index': 'DIRC garbage',
    })
    await fs.writeFile(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    const section = await detectGit(repo)
    expect(section).toMatchObject({ branch: 'main', remotes: [], trackedFiles: null })
  })
})

describe('HEAD and refs', () => {
  it('parses symbolic and detached HEAD', () => {
    expect(parseHead('ref: refs/heads/main\n')).toEqual({ kind: 'ref', ref: 'refs/heads/main' })
    const sha = '0123456789abcdef0123456789abcdef01234567'
    expect(parseHead(`${sha}\n`)).toEqual({ kind: 'detached', sha })
    expect(parseHead('garbage')).toBeNull()
    expect(parseHead('')).toBeNull()
  })

  it('extracts branch names', () => {
    expect(branchOf('refs/heads/feature/login')).toBe('feature/login')
    expect(branchOf('refs/heads/.invalid')).toBeNull()
    expect(branchOf('refs/remotes/origin/main')).toBeNull()
  })

  it('refuses ref names that could escape the git directory', () => {
    expect(isSafeRefName('refs/heads/main')).toBe(true)
    expect(isSafeRefName('refs/heads/feature/ümlaut')).toBe(true)
    expect(isSafeRefName('refs/heads/../../../etc/passwd')).toBe(false)
    expect(isSafeRefName('/etc/passwd')).toBe(false)
    expect(isSafeRefName('refs/heads/a\\b')).toBe(false)
    expect(isSafeRefName('refs/heads/x.lock')).toBe(false)
    expect(isSafeRefName('HEAD')).toBe(false)
  })

  it('parses packed-refs, skipping comments and peeled lines', () => {
    const a = 'a'.repeat(40)
    const b = 'b'.repeat(40)
    const refs = parsePackedRefs(
      `# pack-refs with: peeled fully-peeled sorted \n${a} refs/heads/main\n${b} refs/tags/v1\n^${a}\nnot a line\n`,
    )
    expect([...refs]).toEqual([
      ['refs/heads/main', a],
      ['refs/tags/v1', b],
    ])
  })
})

describe('remotes', () => {
  it.each([
    ['https://github.com/acme/app.git', 'github.com', 'github'],
    ['git@github.com:acme/app.git', 'github.com', 'github'],
    ['ssh://git@ssh.github.com:443/acme/app.git', 'ssh.github.com', 'github'],
    ['https://www.gitlab.com/acme/app', 'www.gitlab.com', 'gitlab'],
    ['git@bitbucket.org:acme/app.git', 'bitbucket.org', 'bitbucket'],
    ['https://acme@dev.azure.com/acme/proj/_git/app', 'dev.azure.com', 'azure'],
    ['git@ssh.dev.azure.com:v3/acme/proj/app', 'ssh.dev.azure.com', 'azure'],
    ['https://acme.visualstudio.com/proj/_git/app', 'acme.visualstudio.com', 'azure'],
    ['https://codeberg.org/acme/app.git', 'codeberg.org', 'codeberg'],
    ['https://git.example.com/acme/app.git', 'git.example.com', undefined],
    ['../local/repo', null, undefined],
    ['C:\\repos\\app', null, undefined],
  ])('recognizes the host of %s', (url, hostname, kind) => {
    expect(remoteHostname(url)).toBe(hostname)
    expect(remoteHostKind(url)).toBe(kind)
  })

  it('removes credentials, query strings and absolute local paths', () => {
    expect(displayRemoteUrl('https://user:ghp_notreal@github.com/acme/app.git?token=abc#frag')).toBe(
      'https://github.com/acme/app.git',
    )
    expect(displayRemoteUrl('https://oauth2:token123@gitlab.com/acme/app.git')).toBe('https://gitlab.com/acme/app.git')
    expect(displayRemoteUrl('git@github.com:acme/app.git')).toBe('git@github.com:acme/app.git')
    expect(displayRemoteUrl('user:pass word@host.example:repo.git')).toBe('host.example:repo.git')
    // No scheme and no scp-style colon: git reads it as a path, but the userinfo must still go.
    expect(displayRemoteUrl('user:tok3n@host.test/org/repo.git')).toBe('host.test/org/repo.git')
    expect(displayRemoteUrl('deploy@host.test:repo')).toBe('deploy@host.test:repo')
    // A 40-character hex token used as the scp user name is not a login name.
    expect(displayRemoteUrl(`${'a1b2c3d4e5'.repeat(4)}@github.com:org/repo.git`)).toBe('github.com:org/repo.git')
    expect(displayRemoteUrl('/Users/someone/private/repos/app.git')).toBe('…/app.git')
    expect(displayRemoteUrl('file:///home/someone/repos/app.git')).toBe('file://…/app.git')
    expect(displayRemoteUrl('../sibling')).toBe('../sibling')
  })

  it('lists remotes with origin first, then by name, using the first url of each', () => {
    const config = parseGitConfig(
      [
        '[remote "zeta"]',
        '\turl = https://example.com/z.git',
        '[remote "upstream"]',
        '\turl = git@github.com:up/app.git',
        '\turl = https://mirror.example.com/app.git',
        '[remote "origin"]',
        '\turl = "https://x:y@github.com/me/app.git"',
        '[remote "nourl"]',
        '\tfetch = +refs/heads/*:refs/remotes/nourl/*',
      ].join('\n'),
    )
    expect(remotesFromConfig(config)).toEqual([
      { name: 'origin', url: 'https://github.com/me/app.git', host: 'github' },
      { name: 'upstream', url: 'git@github.com:up/app.git', host: 'github' },
      { name: 'zeta', url: 'https://example.com/z.git' },
    ])
  })
})

describe('.gitmodules and .gitattributes', () => {
  it('lists submodule paths, dropping paths that escape the repository', () => {
    const text = [
      '[submodule "b"]',
      '\tpath = libs/b',
      '[submodule "a"]',
      '\tpath = "libs/a"',
      '[submodule "evil"]',
      '\tpath = ../../outside',
      '[submodule "abs"]',
      '\tpath = /etc',
    ].join('\n')
    expect(submodulePaths(text)).toEqual(['libs/a', 'libs/b'])
    expect(submodulePaths('not a config')).toEqual([])
  })

  it('detects the LFS filter outside comments', () => {
    expect(usesLfs('*.bin filter=lfs diff=lfs merge=lfs -text')).toBe(true)
    expect(usesLfs('# *.bin filter=lfs\n* text=auto')).toBe(false)
    expect(usesLfs('*.bin filter=lfsx')).toBe(false)
  })
})
