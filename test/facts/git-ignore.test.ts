import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { gitExcludesFile, globalGitConfigFiles, outerIgnoreFiles } from '../../src/facts/git-ignore.ts'
import {
  canSymlink,
  contextFor,
  GIT_TEST_ENV,
  gitInit,
  makeProject,
  makeTempDir,
  runCli,
  writeFiles,
} from '../helpers.ts'

const symlinkIt = canSymlink ? it : it.skip
const HEAD = { '.git/HEAD': 'ref: refs/heads/main\n' }

describe('gitExcludesFile', () => {
  it('defaults to git/ignore in the XDG config directory', async () => {
    const home = await makeTempDir()
    const xdg = await makeTempDir()
    expect(await gitExcludesFile({ HOME: home }, 'linux')).toBe(path.join(home, '.config', 'git', 'ignore'))
    expect(await gitExcludesFile({ HOME: home, XDG_CONFIG_HOME: xdg }, 'linux')).toBe(path.join(xdg, 'git', 'ignore'))
    // A relative XDG_CONFIG_HOME is invalid per the spec and ignored.
    expect(await gitExcludesFile({ HOME: home, XDG_CONFIG_HOME: 'xdg' }, 'linux')).toBe(
      path.join(home, '.config', 'git', 'ignore'),
    )
    expect(await gitExcludesFile({}, 'linux')).toBeUndefined()
  })

  it('reads core.excludesFile from the global config, expanding ~/', async () => {
    const home = await makeProject({ '.gitconfig': '[core]\n\texcludesFile = ~/.gitignore_global\n' })
    expect(await gitExcludesFile({ HOME: home }, 'linux')).toBe(path.join(home, '.gitignore_global'))
  })

  it('lets ~/.gitconfig override the XDG config file, last value winning', async () => {
    const home = await makeProject({
      '.config/git/config': '[core]\n\texcludesfile = /from/xdg\n',
      '.gitconfig': '[core]\n\texcludesFile = /first\n[Core]\n\tExcludesFile = /second\n',
    })
    expect(await gitExcludesFile({ HOME: home }, 'linux')).toBe(path.resolve('/second'))
    await fs.rm(path.join(home, '.gitconfig'))
    expect(await gitExcludesFile({ HOME: home }, 'linux')).toBe(path.resolve('/from/xdg'))
  })

  it('reads only $GIT_CONFIG_GLOBAL when it is set', async () => {
    const home = await makeProject({ '.gitconfig': '[core]\n\texcludesFile = /from/home\n', other: '' })
    const config = path.join(await makeProject({ config: '[core]\n\texcludesFile = /from/env\n' }), 'config')
    expect(globalGitConfigFiles({ HOME: home, GIT_CONFIG_GLOBAL: config }, 'linux')).toEqual([config])
    expect(await gitExcludesFile({ HOME: home, GIT_CONFIG_GLOBAL: config }, 'linux')).toBe(path.resolve('/from/env'))
    // Unset in that file: the default location, not ~/.gitconfig's value.
    const empty = path.join(home, 'other')
    expect(await gitExcludesFile({ HOME: home, GIT_CONFIG_GLOBAL: empty }, 'linux')).toBe(
      path.join(home, '.config', 'git', 'ignore'),
    )
  })

  it('gives up on a relative path', async () => {
    const home = await makeProject({ '.gitconfig': '[core]\n\texcludesFile = rules/ignore\n' })
    expect(await gitExcludesFile({ HOME: home }, 'linux')).toBeUndefined()
  })

  symlinkIt('follows a linked ~/.gitconfig, as dotfile managers set it up', async () => {
    const dotfiles = await makeProject({ gitconfig: '[core]\n\texcludesFile = /linked\n' })
    const home = await makeTempDir()
    await fs.symlink(path.join(dotfiles, 'gitconfig'), path.join(home, '.gitconfig'))
    expect(await gitExcludesFile({ HOME: home }, 'linux')).toBe(path.resolve('/linked'))
  })
})

describe('outerIgnoreFiles', () => {
  it('is empty outside a Git repository, even with a global excludes file', async () => {
    const rules = path.join(await makeProject({ ignore: '*.log\n' }), 'ignore')
    expect(await outerIgnoreFiles(await makeProject({ 'a.txt': '' }), rules)).toEqual([])
  })

  it('reads the global excludes file and info/exclude at the repository root', async () => {
    const rules = path.join(await makeProject({ ignore: '*.log\n' }), 'ignore')
    const root = await makeProject({ ...HEAD, '.git/info/exclude': '*.tmp\n', '.gitignore': 'own\n' })
    expect(await outerIgnoreFiles(root, rules)).toEqual([
      { prefix: '', text: '*.log\n', file: 'core.excludesFile', personal: true },
      { prefix: '', text: '*.tmp\n', file: '.git/info/exclude', personal: true },
    ])
    // A missing excludes file is skipped.
    expect(await outerIgnoreFiles(root, path.join(root, 'missing'))).toEqual([
      { prefix: '', text: '*.tmp\n', file: '.git/info/exclude', personal: true },
    ])
  })

  it('reads the .gitignore files above a subdirectory, farthest first', async () => {
    const repo = await makeProject({
      ...HEAD,
      '.git/info/exclude': '*.tmp\n',
      '.gitignore': 'root\n',
      'apps/.gitignore': 'apps\n',
      'apps/web/.gitignore': 'own\n',
    })
    expect(await outerIgnoreFiles(path.join(repo, 'apps', 'web'))).toEqual([
      { prefix: 'apps/web', text: '*.tmp\n', file: '../../.git/info/exclude', personal: true },
      { prefix: 'apps/web', text: 'root\n', file: '../../.gitignore' },
      { prefix: 'web', text: 'apps\n', file: '../.gitignore' },
    ])
  })

  symlinkIt('skips a symlinked .gitignore above the root, like Git', async () => {
    const repo = await makeProject({ ...HEAD, rules: '*\n', 'apps/web/a.txt': '' })
    await fs.symlink(path.join(repo, 'rules'), path.join(repo, 'apps', '.gitignore'))
    expect(await outerIgnoreFiles(path.join(repo, 'apps', 'web'))).toEqual([])
  })

  symlinkIt('does not follow an info/exclude symlink out of the Git directory', async () => {
    const outside = await makeProject({ rules: '*\n' })
    const root = await makeProject({ ...HEAD, 'a.txt': '' })
    await fs.mkdir(path.join(root, '.git', 'info'), { recursive: true })
    await fs.symlink(path.join(outside, 'rules'), path.join(root, '.git', 'info', 'exclude'))
    expect(await outerIgnoreFiles(root)).toEqual([])
    expect((await contextFor(root)).files.files).toEqual(['a.txt'])
  })

  it("reads a linked worktree's info/exclude from the main repository", async () => {
    const main = await makeProject({ 'a.txt': '' })
    gitInit(main)
    const worktree = path.join(await makeTempDir(), 'wt')
    execFileSync('git', ['worktree', 'add', '-q', worktree], {
      cwd: main,
      stdio: 'ignore',
      env: { ...process.env, ...GIT_TEST_ENV },
    })
    await writeFiles(main, { '.git/info/exclude': '*.tmp\n' })
    await writeFiles(worktree, { 'b.tmp': '' })
    const ctx = await contextFor(await fs.realpath(worktree))
    expect(ctx.files.ignoredFiles).toEqual(['b.tmp'])
  })
})

describe('ignore files above the scanned directory', () => {
  it('matches git check-ignore when scanning a subdirectory', async () => {
    const repo = await makeProject({
      '.gitignore': '*.log\n/apps/web/generated/\n',
      'apps/.gitignore': 'web/tmp/\n!web/keep.log\n',
      'apps/web/.gitignore': 'local.txt\n',
      'apps/web/a.log': '',
      'apps/web/keep.log': '',
      'apps/web/generated/x.ts': '',
      'apps/web/tmp/y.ts': '',
      'apps/web/b.cache': '',
      'apps/web/c.tmp': '',
      'apps/web/local.txt': '',
      'apps/web/src/index.ts': '',
      'apps/web/src/d.log': '',
    })
    gitInit(repo, ['.gitignore', 'apps/.gitignore', 'apps/web/.gitignore', 'apps/web/src/index.ts'])
    await writeFiles(repo, { '.git/info/exclude': '*.tmp\n' })
    const global = await makeProject({ ignore: '*.cache\n', config: '' })
    await writeFiles(global, {
      config: `[core]\n\texcludesFile = ${path.join(global, 'ignore').replaceAll('\\', '/')}\n`,
    })

    const web = path.join(repo, 'apps', 'web')
    const paths = [
      'a.log',
      'keep.log',
      'generated/x.ts',
      'tmp/y.ts',
      'b.cache',
      'c.tmp',
      'local.txt',
      'src/index.ts',
      'src/d.log',
    ]
    const checked = spawnSync('git', ['check-ignore', '--no-index', ...paths], {
      cwd: web,
      encoding: 'utf8',
      env: { ...process.env, ...GIT_TEST_ENV, GIT_CONFIG_GLOBAL: path.join(global, 'config') },
    })
    const ignoredByGit = checked.stdout.split(/\r?\n/).filter(Boolean).sort()
    expect(ignoredByGit).toEqual(['a.log', 'b.cache', 'c.tmp', 'generated/x.ts', 'local.txt', 'src/d.log', 'tmp/y.ts'])

    const ctx = await contextFor(web, { gitExcludesFile: path.join(global, 'ignore') })
    expect(paths.filter((file) => ctx.files.isIgnored(file)).sort()).toEqual(ignoredByGit)
    expect(ctx.files.files).toEqual(['.gitignore', 'keep.log', 'src/index.ts'])
  })

  it('applies the global excludes file only when it is passed', async () => {
    const repo = await makeProject({ ...HEAD, 'a.cache': '', 'b.ts': '' })
    const rules = path.join(await makeProject({ ignore: '*.cache\n' }), 'ignore')
    expect((await contextFor(repo)).files.ignoredFiles).toEqual([])
    expect((await contextFor(repo, { gitExcludesFile: rules })).files.ignoredFiles).toEqual(['a.cache'])
  })

  it('is applied by the CLI from the user Git configuration', async () => {
    const repo = await makeProject({ ...HEAD, '.env.example': 'A=\n', '.env': 'A=1\n' })
    const home = await makeProject({ '.config/git/ignore': '.env\n' })
    const files = async (env: Record<string, string>) => {
      const run = await runCli(['--json', repo], { env })
      return JSON.parse(run.stdout).environment.files.map((file: { path: string; ignored: boolean }) => [
        file.path,
        file.ignored,
      ])
    }
    expect(await files({ HOME: home })).toContainEqual(['.env', true])
    expect(await files({})).toContainEqual(['.env', false])
  })
})
