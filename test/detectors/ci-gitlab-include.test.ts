import { describe, expect, it } from 'vitest'
import {
  ciDetector,
  gitlabLocalIncludes,
  MAX_GITLAB_EXTENDS_DEPTH,
  MAX_GITLAB_INCLUDES,
  mergeGitlabConfig,
  parseGitlabCi,
  resolveGitlabExtends,
} from '../../src/detectors/ci.ts'
import { contextFor, makeProject, timeBudget } from '../helpers.ts'

async function gitlab(files: Record<string, string>) {
  const section = await (await contextFor(await makeProject(files))).use(ciDetector)
  return section.workflows.find((workflow) => workflow.provider === 'gitlab-ci')
}

describe('gitlabLocalIncludes', () => {
  const files = ['ci/a.yml', 'ci/b.yaml', 'ci/nested/c.yml', 'ci/notes.md', 'other/d.yml']

  it('reads strings and local entries, relative to the repository root', () => {
    expect(gitlabLocalIncludes('/ci/a.yml', files)).toEqual(['ci/a.yml'])
    expect(
      gitlabLocalIncludes(
        [
          'ci/a.yml',
          { local: '/ci/b.yaml', rules: [{ if: '$CI' }] },
          'https://example.com/x.yml',
          { remote: 'https://example.com/y.yml' },
          { project: 'group/p', file: '/t.yml' },
          { template: 'Auto-DevOps.gitlab-ci.yml' },
          { component: 'gitlab.com/x/y@1' },
          '$CI_DIR/x.yml',
          '../outside.yml',
          'ci/notes.md',
          'ci/a.yml',
        ],
        files,
      ),
    ).toEqual(['ci/a.yml', 'ci/b.yaml'])
  })

  it('expands wildcards like GitLab', () => {
    expect(gitlabLocalIncludes('ci/*.yml', files)).toEqual(['ci/a.yml'])
    expect(gitlabLocalIncludes('ci/**.yml', files)).toEqual(['ci/a.yml', 'ci/nested/c.yml'])
    expect(gitlabLocalIncludes('ci/**/*.yml', files)).toEqual(['ci/nested/c.yml'])
    expect(gitlabLocalIncludes('ci/*.{yml,yaml}', files)).toEqual([])
  })

  it('skips patterns with too many wildcards, and stays fast on hostile ones', () => {
    const many = Array.from({ length: 2000 }, (_, i) => `${'a/'.repeat(30)}f${i}.yml`)
    const started = performance.now()
    expect(gitlabLocalIncludes('**a**a**a**b.yml', many)).toEqual([])
    expect(gitlabLocalIncludes('*a*a*a*a*b.yml', many)).toEqual([])
    // Allowed, and still fast: the worst patterns that are kept.
    expect(gitlabLocalIncludes('**a**a*b.yml', many)).toEqual([])
    expect(gitlabLocalIncludes('a/**a*a*b*c.yml', many)).toEqual([])
    expect(performance.now() - started).toBeLessThan(timeBudget(1000))
  })
})

describe('mergeGitlabConfig', () => {
  it('merges mappings deeply and replaces everything else', () => {
    const base = { test: { script: ['a'], variables: { A: '1' }, stage: 'test' }, stages: ['test'] }
    const override = { test: { script: ['b'], variables: { B: '2' } }, stages: ['build'] }
    expect(mergeGitlabConfig(base, override)).toEqual({
      test: { script: ['b'], variables: { A: '1', B: '2' }, stage: 'test' },
      stages: ['build'],
    })
  })
})

describe('GitLab CI include', () => {
  it('adds the jobs of included files, the main file winning', async () => {
    const workflow = await gitlab({
      '.gitlab-ci.yml': 'include:\n  - local: ci/test.yml\n  - ci/deploy.yml\nlint:\n  script: pnpm lint\n',
      'ci/test.yml': 'unit:\n  script: pnpm test\nlint:\n  script: echo overridden\n  tags: [docker]\n',
      'ci/deploy.yml': 'include: ci/release.yml\nproduction:\n  script: ./deploy.sh\n',
      'ci/release.yml': 'publish:\n  script: npm publish\n',
    })
    expect(workflow?.includes).toEqual(['ci/test.yml', 'ci/deploy.yml', 'ci/release.yml'])
    expect(workflow?.jobs.map((job) => [job.id, job.tasks, job.runsOn])).toEqual([
      ['unit', ['test'], []],
      ['lint', ['lint'], ['docker']],
      ['publish', ['release'], []],
      ['production', ['deploy'], []],
    ])
  })

  it('applies a default image from an included file', async () => {
    const workflow = await gitlab({
      '.gitlab-ci.yml': 'include: /ci/defaults.yml\nbuild:\n  script: make\n',
      'ci/defaults.yml': 'default:\n  image: node:22\n',
    })
    expect(workflow?.jobs).toEqual([{ id: 'build', tasks: ['build'], runsOn: ['node:22'] }])
  })

  it('has no includes field without local includes, and stops at cycles and missing files', async () => {
    expect(await gitlab({ '.gitlab-ci.yml': 'build:\n  script: make\n' })).not.toHaveProperty('includes')
    const workflow = await gitlab({
      '.gitlab-ci.yml': 'include: [a.yml, missing.yml]\nmain:\n  script: make\n',
      'a.yml': 'include: [b.yml]\na:\n  script: a\n',
      'b.yml': 'include: [a.yml, .gitlab-ci.yml]\nb:\n  script: b\n',
    })
    expect(workflow?.includes).toEqual(['a.yml', 'b.yml'])
    expect(workflow?.jobs.map((job) => job.id)).toEqual(['b', 'a', 'main'])
  })

  it(`reads at most ${MAX_GITLAB_INCLUDES} included files`, async () => {
    const files: Record<string, string> = { '.gitlab-ci.yml': 'include: ci/*.yml\n' }
    for (let i = 0; i < MAX_GITLAB_INCLUDES + 10; i++)
      files[`ci/j${String(i).padStart(3, '0')}.yml`] = `j${i}:\n  script: x\n`
    const workflow = await gitlab(files)
    expect(workflow?.includes).toHaveLength(MAX_GITLAB_INCLUDES)
    expect(workflow?.jobs).toHaveLength(MAX_GITLAB_INCLUDES)
  })
})

describe('GitLab CI job extends', () => {
  it('applies a template from an included file', async () => {
    const workflow = await gitlab({
      '.gitlab-ci.yml': 'include: ci/templates.yml\nunit:\n  extends: .node-test\n  tags: [linux]\n',
      'ci/templates.yml': '.node-test:\n  image: node:22\n  script: pnpm test\n  tags: [docker]\n',
    })
    expect(workflow?.jobs).toEqual([{ id: 'unit', tasks: ['test'], runsOn: ['node:22', 'linux'] }])
  })

  it('merges a list of templates in order, the job winning, mappings deep and arrays replaced', () => {
    const doc = {
      '.a': { script: ['a'], variables: { A: '1', X: 'a' }, image: 'a' },
      '.b': { script: ['b'], variables: { B: '2', X: 'b' } },
      job: { extends: ['.a', '.b'], variables: { C: '3' } },
    }
    expect(resolveGitlabExtends(doc).get('job')).toEqual({
      script: ['b'],
      variables: { A: '1', X: 'b', B: '2', C: '3' },
      image: 'a',
    })
  })

  it('extends visible jobs too, and keeps templates out of the job list', () => {
    const workflow = parseGitlabCi(
      { '.base': { script: 'make build' }, build: { extends: '.base' }, nightly: { extends: 'build', tags: ['big'] } },
      '.gitlab-ci.yml',
    )
    expect(workflow?.jobs).toEqual([
      { id: 'build', tasks: ['build'], runsOn: [] },
      { id: 'nightly', tasks: ['build'], runsOn: ['big'] },
    ])
  })

  it('skips cycles and unknown names', () => {
    const resolved = resolveGitlabExtends({
      a: { extends: 'b', script: 'a' },
      b: { extends: ['a', '.missing', 42], stage: 'test' },
    })
    expect(resolved.get('a')).toEqual({ stage: 'test', script: 'a' })
    expect(resolved.get('b')).toEqual({ stage: 'test' })
  })

  it(`follows at most ${MAX_GITLAB_EXTENDS_DEPTH} levels from a job declared before its templates`, () => {
    // Templates declared after the job, deepest last, so resolving the job walks the whole chain.
    const templates = (count: number) => {
      const doc: Record<string, unknown> = {}
      for (let i = count; i >= 1; i--) doc[`.t${i}`] = { extends: `.t${i - 1}` }
      doc['.t0'] = { image: 'deep' }
      return doc
    }
    const within = { job: { extends: `.t${MAX_GITLAB_EXTENDS_DEPTH - 1}` }, ...templates(MAX_GITLAB_EXTENDS_DEPTH - 1) }
    expect(resolveGitlabExtends(within).get('job')).toEqual({ image: 'deep' })
    const beyond = { job: { extends: `.t${MAX_GITLAB_EXTENDS_DEPTH}` }, ...templates(MAX_GITLAB_EXTENDS_DEPTH) }
    expect(resolveGitlabExtends(beyond).get('job')).toEqual({})
  })

  it('handles a very long chain without deep recursion', () => {
    const doc: Record<string, unknown> = { '.t0': { script: 'pnpm test' } }
    for (let i = 1; i < 50_000; i++) doc[`.t${i}`] = { extends: `.t${i - 1}` }
    doc.job = { extends: '.t49999' }
    expect(resolveGitlabExtends(doc).get('job')).toEqual({ script: 'pnpm test' })
  })

  it('stays fast when templates extend each other many times over', () => {
    const doc: Record<string, unknown> = { '.t0': { script: 'pnpm test' }, '.t1': { image: 'node' } }
    for (let i = 2; i < 300; i++) doc[`.t${i}`] = { extends: [`.t${i - 1}`, `.t${i - 2}`] }
    for (let i = 0; i < 300; i++) doc[`job${i}`] = { extends: `.t${299 - (i % 9)}` }
    const started = performance.now()
    const workflow = parseGitlabCi(doc, '.gitlab-ci.yml')
    expect(performance.now() - started).toBeLessThan(timeBudget(1000))
    expect(workflow?.jobs).toHaveLength(300)
  })
})
