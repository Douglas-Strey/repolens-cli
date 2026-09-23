import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ALWAYS_IGNORED_DIRS,
  ignoreRuleCost,
  limitIgnoreRules,
  MAX_IGNORE_RULES_PER_PATH,
  MAX_IGNORE_RULES_TOTAL,
  walk,
} from '../../src/core/walker.ts'
import { makeProject, makeTempDir, timeBudget, writeFiles } from '../helpers.ts'

const posixOnly = process.platform === 'win32' ? it.skip : it
const canChmod = process.platform !== 'win32' && process.getuid?.() !== 0 ? it : it.skip
const OPTIONS = { maxFiles: 100_000, maxDepth: 20 }

describe('walk: .gitignore', () => {
  it('respects the root .gitignore and lists ignored files separately', async () => {
    const root = await makeProject({
      '.gitignore': '.env\n*.log\nbuild/\n',
      '.env': 'SECRET=1',
      '.env.example': 'SECRET=',
      'debug.log': '',
      'build/out.js': '',
      'src/index.ts': '',
      'src/trace.log': '',
    })
    const result = await walk(root, OPTIONS)
    expect(result.files).toEqual(['.env.example', '.gitignore', 'src/index.ts'])
    expect(result.ignoredFiles).toEqual(['.env', 'debug.log', 'src/trace.log'])
    // Ignored directories are not traversed, so their files are not listed at all.
    expect(result.directories.has('build')).toBe(false)
    expect(result.directories.has('src')).toBe(true)
    expect(result.truncated).toBe(false)
  })

  it('applies nested .gitignore patterns relative to their directory', async () => {
    const root = await makeProject({
      'packages/a/.gitignore': '/generated\nlocal.txt\n',
      'packages/a/generated/x.ts': '',
      'packages/a/src/generated/y.ts': '',
      'packages/a/src/local.txt': '',
      'packages/b/local.txt': '',
      'generated/z.ts': '',
    })
    const result = await walk(root, OPTIONS)
    expect(result.files).toEqual([
      'generated/z.ts',
      'packages/a/.gitignore',
      'packages/a/src/generated/y.ts',
      'packages/b/local.txt',
    ])
    expect(result.ignoredFiles).toEqual(['packages/a/src/local.txt'])
  })

  it('supports negations, with deeper files taking precedence', async () => {
    const root = await makeProject({
      '.gitignore': '*.log\n!keep.log\n',
      'a.log': '',
      'keep.log': '',
      'sub/.gitignore': '!b.log\n',
      'sub/b.log': '',
      'sub/c.log': '',
    })
    const result = await walk(root, OPTIONS)
    expect(result.files).toEqual(['.gitignore', 'keep.log', 'sub/.gitignore', 'sub/b.log'])
    expect(result.ignoredFiles).toEqual(['a.log', 'sub/c.log'])
  })

  it('cannot re-include a file whose parent directory is ignored, like Git', async () => {
    const root = await makeProject({
      '.gitignore': 'build/\n!build/keep.txt\nout/*\n!out/keep.txt\n',
      'build/keep.txt': '',
      'out/keep.txt': '',
      'out/drop.txt': '',
    })
    const result = await walk(root, OPTIONS)
    expect(result.files).toEqual(['.gitignore', 'out/keep.txt'])
    expect(result.ignoredFiles).toEqual(['out/drop.txt'])
    expect(result.isIgnored('build/keep.txt')).toBe(true)
    expect(result.isIgnored('out/keep.txt')).toBe(false)
  })

  it('treats "name/" patterns as directories only', async () => {
    const root = await makeProject({ '.gitignore': 'cache/\n', 'cache/a.txt': '', 'src/cache': 'a file named cache' })
    const result = await walk(root, OPTIONS)
    expect(result.files).toEqual(['.gitignore', 'src/cache'])
  })

  it('reads .git/info/exclude with lower precedence than .gitignore', async () => {
    const root = await makeProject({
      '.git/info/exclude': 'secret.txt\n*.tmp\n',
      '.gitignore': '!keep.tmp\n',
      'secret.txt': '',
      'a.tmp': '',
      'keep.tmp': '',
    })
    const result = await walk(root, OPTIONS)
    expect(result.files).toEqual(['.gitignore', 'keep.tmp'])
    expect(result.ignoredFiles).toEqual(['a.tmp', 'secret.txt'])
  })

  posixOnly('does not follow a .git/info/exclude symlink out of the root', async () => {
    const outside = await makeProject({ rules: '*\n' })
    const root = await makeProject({ 'a.txt': '' })
    await fs.mkdir(path.join(root, '.git', 'info'), { recursive: true })
    await fs.symlink(path.join(outside, 'rules'), path.join(root, '.git', 'info', 'exclude'))
    expect((await walk(root, OPTIONS)).files).toEqual(['a.txt'])
  })

  it('matches case-sensitively, like Git by default', async () => {
    // Distinct names only: the test must also pass on case-insensitive file systems.
    const root = await makeProject({ '.gitignore': '.env\nBuild/\n', '.ENV': '', 'build/a.ts': '' })
    const result = await walk(root, OPTIONS)
    expect(result.files).toEqual(['.ENV', '.gitignore', 'build/a.ts'])
    expect(result.ignoredFiles).toEqual([])
    expect(result.isIgnored('.env')).toBe(true)
    expect(result.isIgnored('.Env')).toBe(false)
  })

  it('ignores comments, blank lines and CRLF line endings', async () => {
    const root = await makeProject({ '.gitignore': '# comment\r\n\r\n*.log\r\n', 'a.log': '', '# comment': '' })
    const result = await walk(root, OPTIONS)
    expect(result.ignoredFiles).toEqual(['a.log'])
    expect(result.files).toContain('# comment')
  })

  it('caps the number of rules that apply to one path and warns', async () => {
    const rules = Array.from({ length: MAX_IGNORE_RULES_PER_PATH + 10 }, (_, i) => `rule-${i}`).join('\n')
    const root = await makeProject({
      '.gitignore': rules,
      'rule-0': '',
      [`rule-${MAX_IGNORE_RULES_PER_PATH + 5}`]: '',
    })
    const result = await walk(root, OPTIONS)
    expect(result.ignoredFiles).toEqual(['rule-0'])
    expect(result.files).toContain(`rule-${MAX_IGNORE_RULES_PER_PATH + 5}`)
    expect(result.warnings).toEqual([
      {
        kind: 'limit',
        file: '.gitignore',
        message: `Ignored 10 rules in .gitignore: the ignore rules for one directory exceed the limit of ${MAX_IGNORE_RULES_PER_PATH} (a rule with several "**" counts as more than one)`,
      },
    ])
  })

  it('limitIgnoreRules keeps comments and counts only rules', () => {
    const none = { complex: 0, overBudget: 0, overTotal: 0 }
    expect(limitIgnoreRules('# c\na\n\nb\nc\n', 2)).toEqual({
      ...none,
      text: '# c\na\n\nb\n',
      kept: 2,
      cost: 2,
      overBudget: 1,
    })
    expect(limitIgnoreRules('a\nb', 5)).toEqual({ ...none, text: 'a\nb', kept: 2, cost: 2 })
    expect(limitIgnoreRules('a\nb\nc', 100, 2)).toEqual({ ...none, text: 'a\nb', kept: 2, cost: 2, overTotal: 1 })
  })

  it.each([
    ['*.log', 1],
    ['build/', 1],
    ['a/**', 1],
    ['**', 1],
    ['**/dist', 3],
    ['!**/keep.txt', 3],
    ['**/dist/**', 3],
    ['a/**/b', 3],
    ['**/a/**/b', 20],
    ['a/**/**/b', 20],
    ['**/a/**/b/**/c', 120],
    ['a/**/**/**/**/b', Number.POSITIVE_INFINITY],
  ])('ignoreRuleCost(%j) = %d', (rule, cost) => {
    expect(ignoreRuleCost(rule)).toBe(cost)
  })

  it('charges rules with several "**" more of the budget and drops the unusable ones', () => {
    const text = ['**/a/**/b', 'plain', `x/${'**/'.repeat(12)}y`, '**/c/**/d'].join('\n')
    expect(limitIgnoreRules(text, 25)).toEqual({
      text: '**/a/**/b\nplain',
      kept: 2,
      cost: 21,
      complex: 1,
      overBudget: 1,
      overTotal: 0,
    })
  })

  it('caps the rules compiled across all .gitignore files, in walk order', async () => {
    const rules = Array.from({ length: 2000 }, (_, i) => `r${i}`).join('\n')
    const files: Record<string, string> = {}
    const count = MAX_IGNORE_RULES_TOTAL / 2000 + 1
    const dir = (d: number) => `d${String(d).padStart(2, '0')}`
    for (let d = 0; d < count; d++) {
      files[`${dir(d)}/.gitignore`] = rules
      files[`${dir(d)}/r0`] = ''
    }
    const root = await makeProject(files)
    const first = await walk(root, OPTIONS)
    const last = dir(count - 1)
    expect(first.warnings).toEqual([
      {
        kind: 'limit',
        file: `${last}/.gitignore`,
        message: `Ignored 2000 rules in ${last}/.gitignore: the repository's ignore files have more than ${MAX_IGNORE_RULES_TOTAL} rules in total`,
      },
    ])
    expect(first.ignoredFiles).toContain(`${dir(count - 2)}/r0`)
    expect(first.files).toContain(`${last}/r0`)
    const second = await walk(root, OPTIONS)
    expect(second.warnings).toEqual(first.warnings)
    expect(second.files).toEqual(first.files)
  })

  // `ignore` backtracks exponentially on consecutive "**": this rule took 4 s per path before.
  it('stays fast on a .gitignore rule with many consecutive "**"', async () => {
    const deep = Array.from({ length: 18 }, () => 'a').join('/')
    const files: Record<string, string> = { '.gitignore': `x/${'**/'.repeat(12)}y\n*.log\n` }
    for (let i = 0; i < 20; i++) files[`x/${deep}/f${i}.ts`] = ''
    files[`x/${deep}/debug.log`] = ''
    const root = await makeProject(files)
    const started = performance.now()
    const result = await walk(root, OPTIONS)
    expect(performance.now() - started).toBeLessThan(timeBudget(2000))
    expect(result.files).toHaveLength(21)
    expect(result.ignoredFiles).toEqual([`x/${deep}/debug.log`])
    expect(result.warnings).toEqual([
      {
        kind: 'limit',
        file: '.gitignore',
        message: 'Ignored 1 rule in .gitignore that uses more than 3 "**" segments',
      },
    ])
  })
})

describe('walk: traversal', () => {
  it('never enters ALWAYS_IGNORED_DIRS, even when .gitignore does not mention them', async () => {
    const root = await makeProject({
      'node_modules/pkg/index.js': '',
      'vendor/lib.go': '',
      '.git/HEAD': 'ref: refs/heads/main\n',
      '.next/cache.json': '',
      'nested/node_modules/x.js': '',
      'src/app.ts': '',
    })
    const result = await walk(root, OPTIONS)
    expect(result.files).toEqual(['src/app.ts'])
    expect(result.ignoredFiles).toEqual([])
    for (const dir of ['node_modules', 'vendor', '.git', '.next', 'nested/node_modules']) {
      expect(result.directories.has(dir)).toBe(false)
    }
    expect(ALWAYS_IGNORED_DIRS.has('node_modules')).toBe(true)
  })

  it('does not index a .git file (linked worktree pointer)', async () => {
    const root = await makeProject({ '.git': 'gitdir: ../elsewhere\n', 'a.ts': '' })
    expect((await walk(root, OPTIONS)).files).toEqual(['a.ts'])
  })

  it('includes hidden files and sorts paths by code unit', async () => {
    const root = await makeProject({ 'c.ts': '', 'B.ts': '', '.hidden': '', 'a/z.ts': '', 'a.ts': '', _x: '' })
    const result = await walk(root, OPTIONS)
    expect(result.files).toEqual(['.hidden', 'B.ts', '_x', 'a.ts', 'a/z.ts', 'c.ts'])
  })

  it('handles an empty directory and an empty root', async () => {
    const root = await makeTempDir()
    await fs.mkdir(path.join(root, 'empty'))
    const result = await walk(root, OPTIONS)
    expect(result.files).toEqual([])
    expect([...result.directories]).toEqual(['empty'])
  })

  it('stops at maxDepth', async () => {
    const root = await makeProject({ 'a.ts': '', 'l1/b.ts': '', 'l1/l2/c.ts': '', 'l1/l2/l3/d.ts': '' })
    expect((await walk(root, { maxFiles: 100, maxDepth: 0 })).files).toEqual(['a.ts'])
    expect((await walk(root, { maxFiles: 100, maxDepth: 2 })).files).toEqual(['a.ts', 'l1/b.ts', 'l1/l2/c.ts'])
  })

  it('truncates deterministically at maxFiles, shallow files first', async () => {
    const files: Record<string, string> = {}
    for (let d = 0; d < 20; d++) for (let f = 0; f < 10; f++) files[`d${d}/f${f}.ts`] = ''
    files['root.ts'] = ''
    files['deep/er/x.ts'] = ''
    const root = await makeProject(files)
    const first = await walk(root, { maxFiles: 55, maxDepth: 20 })
    const second = await walk(root, { maxFiles: 55, maxDepth: 20 })
    expect(first.truncated).toBe(true)
    expect(first.files).toHaveLength(55)
    expect(second.files).toEqual(first.files)
    expect(first.files).toContain('root.ts')
    expect(first.files).not.toContain('deep/er/x.ts')
    // Breadth-first in sorted order: d0..d5 are complete.
    expect(first.files.filter((f) => f.startsWith('d0/'))).toHaveLength(10)
  })

  it('does not report truncation when the file count equals maxFiles', async () => {
    const root = await makeProject({ 'a.ts': '', 'b/c.ts': '' })
    const result = await walk(root, { maxFiles: 2, maxDepth: 20 })
    expect(result.truncated).toBe(false)
    expect(result.files).toEqual(['a.ts', 'b/c.ts'])
  })

  it('reports truncation when a single directory exceeds maxFiles', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 30; i++) files[`f${String(i).padStart(2, '0')}.ts`] = ''
    const root = await makeProject(files)
    const result = await walk(root, { maxFiles: 10, maxDepth: 20 })
    expect(result.truncated).toBe(true)
    expect(result.files).toEqual(Array.from({ length: 10 }, (_, i) => `f${String(i).padStart(2, '0')}.ts`))
  })

  canChmod('skips unreadable directories', async () => {
    const root = await makeProject({ 'ok/a.ts': '', 'locked/b.ts': '' })
    await fs.chmod(path.join(root, 'locked'), 0o000)
    try {
      const messages: string[] = []
      const result = await walk(root, { ...OPTIONS, debug: (m) => messages.push(m) })
      expect(result.files).toEqual(['ok/a.ts'])
      expect(messages.some((m) => m.includes('cannot read locked'))).toBe(true)
    } finally {
      await fs.chmod(path.join(root, 'locked'), 0o755)
    }
  })
})

describe('walk: symlinks and special files', () => {
  posixOnly(
    'terminates on directory symlink loops and never follows directory symlinks',
    async () => {
      const root = await makeProject({ 'a/file.ts': '' })
      await fs.symlink('..', path.join(root, 'a', 'up'))
      await fs.symlink('.', path.join(root, 'self'))
      await fs.symlink(path.join(root, 'a'), path.join(root, 'alias'))
      const result = await walk(root, OPTIONS)
      expect(result.files).toEqual(['a/file.ts'])
      expect([...result.directories].sort()).toEqual(['a'])
    },
    5000,
  )

  posixOnly('keeps file symlinks inside the root and drops those that escape or dangle', async () => {
    const outside = await makeProject({ 'secret.txt': 'x' })
    const root = await makeProject({ 'real.txt': '' })
    await fs.symlink('real.txt', path.join(root, 'inside-link.txt'))
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'outside-link.txt'))
    await fs.symlink('missing.txt', path.join(root, 'dangling.txt'))
    const result = await walk(root, OPTIONS)
    expect(result.files).toEqual(['inside-link.txt', 'real.txt'])
  })

  posixOnly(
    'skips FIFOs',
    async () => {
      const root = await makeProject({ 'a.ts': '' })
      execFileSync('mkfifo', [path.join(root, 'pipe')])
      await writeFiles(root, { 'b.ts': '' })
      expect((await walk(root, OPTIONS)).files).toEqual(['a.ts', 'b.ts'])
    },
    5000,
  )

  posixOnly('ignores a symlinked .gitignore, like Git', async () => {
    const root = await makeProject({ rules: '*.ts\n', 'a.ts': '' })
    await fs.symlink('rules', path.join(root, '.gitignore'))
    expect((await walk(root, OPTIONS)).ignoredFiles).toEqual([])
  })
})

describe('walk: exclude (the ignore setting)', () => {
  it('skips excluded directories and lists excluded files with the ignored ones', async () => {
    const root = await makeProject({
      'src/a.ts': '',
      'legacy/old.ts': '',
      'notes.md': '',
      '.env': '',
      '.gitignore': '!legacy/\n',
    })
    const walked = await walk(root, { ...OPTIONS, exclude: ['legacy/', '*.md', '.env'] })
    expect(walked.files).toEqual(['.gitignore', 'src/a.ts'])
    expect(walked.ignoredFiles).toEqual(['.env', 'notes.md'])
    expect([...walked.directories]).toEqual(['src'])
  })

  it('keeps isIgnored about Git alone', async () => {
    const root = await makeProject({ '.env': '', '.gitignore': 'dist/\n' })
    const walked = await walk(root, { ...OPTIONS, exclude: ['.env', 'build/'] })
    expect(walked.isIgnored('.env')).toBe(false)
    expect(walked.isIgnored('build', true)).toBe(false)
    expect(walked.isIgnored('dist', true)).toBe(true)
  })

  it('honors negations within the patterns', async () => {
    const root = await makeProject({ 'gen/a.ts': '', 'gen/keep.ts': '' })
    const walked = await walk(root, { ...OPTIONS, exclude: ['gen/*', '!gen/keep.ts'] })
    expect(walked.files).toEqual(['gen/keep.ts'])
  })
})

describe('walk: isIgnored', () => {
  it('answers for paths that do not exist', async () => {
    const root = await makeProject({ '.gitignore': '.env*\n!.env.example\ndist/\n', 'apps/web/.gitignore': 'tmp\n' })
    const { isIgnored } = await walk(root, OPTIONS)
    expect(isIgnored('.env')).toBe(true)
    expect(isIgnored('.env.local')).toBe(true)
    expect(isIgnored('.env.example')).toBe(false)
    expect(isIgnored('apps/web/.env')).toBe(true)
    expect(isIgnored('apps/web/tmp')).toBe(true)
    expect(isIgnored('apps/other/tmp')).toBe(false)
    expect(isIgnored('dist/index.js')).toBe(true)
    expect(isIgnored('src/dist')).toBe(false)
    expect(isIgnored('src/dist', true)).toBe(true)
  })

  it('reflects only .gitignore rules for directories, not the built-in skip list', async () => {
    const plain = await walk(await makeProject({ 'a.ts': '' }), OPTIONS)
    expect(plain.isIgnored('node_modules', true)).toBe(false)
    expect(plain.isIgnored('vendor', true)).toBe(false)
    const ignored = await walk(await makeProject({ '.gitignore': 'node_modules\n' }), OPTIONS)
    expect(ignored.isIgnored('node_modules', true)).toBe(true)
    expect(ignored.isIgnored('packages/x/node_modules', true)).toBe(true)
  })

  it('normalizes its input and never matches outside the root', async () => {
    const { isIgnored } = await walk(await makeProject({ '.gitignore': 'cache/\n*.log\n' }), OPTIONS)
    expect(isIgnored('./a.log')).toBe(true)
    expect(isIgnored('cache/')).toBe(true)
    expect(isIgnored('cache')).toBe(false)
    expect(isIgnored('../a.log')).toBe(false)
    expect(isIgnored('/abs/a.log')).toBe(false)
    expect(isIgnored('')).toBe(false)
    expect(isIgnored('.')).toBe(false)
  })
})

describe('walk: work limits', () => {
  it('counts directories and ignored files against the file limit', async () => {
    const files: Record<string, string> = { '.gitignore': '*.x\n' }
    for (let i = 0; i < 30; i++) files[`d${String(i).padStart(2, '0')}/a.x`] = ''
    const root = await makeProject(files)
    const result = await walk(root, { ...OPTIONS, maxFiles: 5 })
    expect(result.truncated).toBe(true)
    expect(result.directories.size).toBeLessThanOrEqual(5)
    expect(result.ignoredFiles.length).toBeLessThanOrEqual(5)
  })

  it("never indexes RepoLens's own .repolens output", async () => {
    const root = await makeProject({ 'package.json': '{}', '.repolens/agent-context.md': '# x' })
    const result = await walk(root, OPTIONS)
    expect(result.files).toEqual(['package.json'])
  })
})
