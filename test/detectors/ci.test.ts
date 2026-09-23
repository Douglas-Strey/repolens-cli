// biome-ignore-all lint/suspicious/noTemplateCurlyInString: "${…}" is literal GitHub Actions / Dockerfile syntax in these fixtures
import { describe, expect, it } from 'vitest'
import { parseYaml } from '../../src/core/parse.ts'
import {
  ciDetector,
  expandExpression,
  inferTasks,
  matrixValues,
  parseCircleCi,
  parseGithubWorkflow,
  parseGitlabCi,
  resolveRunsOn,
  workflowTriggers,
} from '../../src/detectors/ci.ts'
import { contextFor, fixtureContext, makeProject, SECRET_SENTINEL, timeBudget } from '../helpers.ts'

describe('inferTasks', () => {
  it.each([
    [['pnpm lint'], ['lint']],
    [['npx eslint .'], ['lint']],
    [['biome ci .'], ['lint']],
    [['golangci/golangci-lint-action@v8'], ['lint']],
    [['go vet ./...'], ['lint']],
    [['npx stylelint "**/*.css"'], ['lint']],
    [['prettier --check .'], ['format']],
    [['pnpm format:check'], ['format']],
    [['biome format .'], ['format']],
    [['test -z "$(gofmt -l .)"'], ['format']],
    [['terraform fmt -check'], ['format']],
    [['pnpm typecheck'], ['typecheck']],
    [['npx vue-tsc --noEmit'], ['typecheck']],
    [['nuxt typecheck'], ['typecheck']],
    [['yarn test'], ['test']],
    [['go test ./...'], ['test']],
    [['pytest -q'], ['test']],
    [['make test'], ['test']],
    [['codecov/codecov-action@v5'], ['test']],
    [['npx playwright test'], ['e2e']],
    [['cypress-io/github-action@v6'], ['e2e']],
    [['pnpm test:e2e'], ['e2e']],
    [['go build ./...'], ['build']],
    [['docker build -t app .'], ['build']],
    [['docker/build-push-action@v6'], ['build']],
    [['make build'], ['build']],
    [['npx vercel deploy --prod'], ['deploy']],
    [['flyctl deploy --remote-only'], ['deploy']],
    [['npx wrangler pages deploy dist'], ['deploy']],
    [['actions/deploy-pages@v4'], ['deploy']],
    [['npm publish'], ['release']],
    [['npx semantic-release'], ['release']],
    [['changesets/action@v1'], ['release']],
    [['goreleaser/goreleaser-action@v6'], ['release']],
    [['github/codeql-action/analyze@v3'], ['security']],
    [['npm audit --audit-level=high'], ['security']],
    [['aquasecurity/trivy-action@0.28.0'], ['security']],
    [['actions/dependency-review-action@v4'], ['security']],
    [['npx typedoc'], ['docs']],
    [['mkdocs build'], ['build', 'docs']],
  ])('%j → %j', (texts, tasks) => {
    expect(inferTasks(texts)).toEqual(tasks)
  })

  it.each([
    'npm ci',
    'npm install',
    'pnpm install --frozen-lockfile',
    'yarn install --immutable',
    'actions/checkout@v5',
    'actions/setup-node@v5',
    'corepack enable',
    'curl -sSL https://github.com/acme/tool/releases/download/v1.2.3/tool.tar.gz | tar xz',
    'sudo apt-get install -y build-essential',
    'pip install --no-build-isolation -e .',
    'echo latest',
    'docker/setup-buildx-action@v3',
  ])('infers nothing from %j', (text) => {
    expect(inferTasks([text])).toEqual([])
  })

  it('ignores task words that only appear in long flags', () => {
    expect(inferTasks(['cargo build --release'])).toEqual(['build'])
    expect(inferTasks(['golangci-lint run --out-format=github-actions'])).toEqual(['lint'])
    expect(inferTasks(['next build --no-lint'])).toEqual(['build'])
    expect(inferTasks(['npx @vercel/ncc build index.js'])).toEqual(['build'])
  })

  it('treats end-to-end test commands as e2e only, and keeps unit tests from other commands', () => {
    expect(inferTasks(['e2e-tests'])).toEqual(['e2e'])
    expect(inferTasks(['test', 'npx playwright test'])).toEqual(['test', 'e2e'])
    expect(inferTasks(['npm test && npx playwright test'])).toEqual(['test', 'e2e'])
  })

  it.each([
    ['cmake -DCMAKE_BUILD_TYPE=Release ..', []],
    ['cmake --build build --config Release', ['build']],
    ['dotnet build -c Release', ['build']],
    ['cargo build --profile release', ['build']],
    ['xcodebuild -configuration Release', ['build']],
    ['msbuild /p:Configuration=Release', []],
  ])('does not read the build configuration in %j as a release', (text, tasks) => {
    expect(inferTasks([text])).toEqual(tasks)
  })

  it.each([
    ['ruff check src tests', ['lint']],
    ['mypy src tests', ['typecheck']],
    ['black --check src tests && isort --check src tests', ['format']],
    ['cp -r tests/fixtures /tmp/out', []],
    ['if test -f package.json; then npm ci; fi', []],
    ['[ -n "$CI" ] && test -d dist', []],
    ['NODE_ENV=test npm run build', ['build']],
    ['npx prisma migrate deploy', []],
  ])('does not count the test or deploy words in setup command %j', (text, tasks) => {
    expect(inferTasks([text])).toEqual(tasks)
  })

  it.each([
    ['turbo run lint test build', ['lint', 'test', 'build']],
    ['pnpm lint; pnpm test', ['lint', 'test']],
    ['go test ./test/...', ['test']],
    ['bun test -t auth', ['test']],
    ['python -m unittest discover tests/', ['test']],
    ['pytest tests/unit', ['test']],
    ['node/test', ['test']],
    ['dorny/test-reporter@v1', ['test']],
    ['gh release create v1.0.0', ['release']],
    ['npx semantic-release --config release.config.js', ['release']],
  ])('still infers tasks from %j', (text, tasks) => {
    expect(inferTasks([text])).toEqual(tasks)
  })

  it('returns tasks in canonical order and looks at every line of multi-line scripts', () => {
    expect(inferTasks(['docs', 'npm publish\nnpm run build\nnpm test\nnpm run lint'])).toEqual([
      'lint',
      'test',
      'build',
      'release',
      'docs',
    ])
  })

  it('stays fast on hostile input', () => {
    const hostile = [
      `${'fmt-'.repeat(100_000)}`,
      `gradle ${'gradle '.repeat(50_000)}`,
      'a-'.repeat(200_000),
      `${'if '.repeat(300)}\n`.repeat(1_000),
      `${'-c '.repeat(300)}\n`.repeat(1_000),
      `${'x'.repeat(900)}env=\n`.repeat(1_000),
      '&&;|'.repeat(250_000),
    ]
    const started = performance.now()
    inferTasks(hostile)
    expect(performance.now() - started).toBeLessThan(timeBudget(1000))
  })
})

describe('workflowTriggers', () => {
  it('accepts string, list and map forms, sorted and unique', () => {
    expect(workflowTriggers('push')).toEqual(['push'])
    expect(workflowTriggers(['push', 'pull_request', 'push'])).toEqual(['pull_request', 'push'])
    expect(workflowTriggers({ workflow_dispatch: null, push: { branches: ['main'] } })).toEqual([
      'push',
      'workflow_dispatch',
    ])
    expect(workflowTriggers(undefined)).toEqual([])
    expect(workflowTriggers(42)).toEqual(['42'])
  })
})

describe('matrix and expression expansion', () => {
  const matrix = {
    os: ['ubuntu-latest', 'windows-latest'],
    node: [20, 22],
    config: [{ runtime: { version: '1.25' } }],
    include: [{ os: 'macos-14' }, { node: 24 }, { os: 'ubuntu-latest' }],
  }

  it('collects literal matrix values including include entries', () => {
    expect(matrixValues(matrix, 'os')).toEqual(['ubuntu-latest', 'windows-latest', 'macos-14'])
    expect(matrixValues(matrix, 'node')).toEqual(['20', '22', '24'])
    expect(matrixValues(matrix, 'config.runtime.version')).toEqual(['1.25'])
    expect(matrixValues(matrix, 'missing')).toBeNull()
    expect(matrixValues('${{ fromJSON(needs.setup.outputs.matrix) }}', 'os')).toBeNull()
    expect(matrixValues({ os: '${{ fromJSON(x) }}' }, 'os')).toBeNull()
  })

  it('handles very large matrices quickly', () => {
    const started = performance.now()
    expect(matrixValues({ node: Array.from({ length: 100_000 }, (_, i) => i % 50_000) }, 'node')).toHaveLength(50_000)
    expect(performance.now() - started).toBeLessThan(timeBudget(500))
  })

  it('expands matrix and env expressions', () => {
    expect(expandExpression('${{ matrix.node }}', { matrix })).toEqual(['20', '22', '24'])
    expect(expandExpression('node-${{matrix.node}}.x', { matrix: { node: [22] } })).toEqual(['node-22.x'])
    expect(expandExpression('${{ env.NODE }}', { env: [{ OTHER: 'x' }, { NODE: 22 }] })).toEqual(['22'])
    expect(
      expandExpression('${{ matrix.os }}/${{ matrix.arch }}', { matrix: { os: ['a', 'b'], arch: ['x'] } }),
    ).toEqual(['a/x', 'b/x'])
    expect(expandExpression('plain', {})).toEqual(['plain'])
  })

  it('returns null when an expression cannot be resolved statically', () => {
    expect(expandExpression('${{ inputs.node }}', { matrix })).toBeNull()
    expect(expandExpression('${{ env.MISSING }}', { env: [{}] })).toBeNull()
    expect(expandExpression("${{ format('{0}', matrix.node) }}", { matrix })).toBeNull()
    expect(expandExpression(`${'x'.repeat(300)}\${{ matrix.node }}`, { matrix })).toBeNull()
  })

  it('resolves runs-on labels, keeping unresolvable expressions as written', () => {
    expect(resolveRunsOn('ubuntu-latest', {})).toEqual(['ubuntu-latest'])
    expect(resolveRunsOn('${{ matrix.os }}', { matrix })).toEqual(['ubuntu-latest', 'windows-latest', 'macos-14'])
    expect(resolveRunsOn('${{ inputs.runner }}', {})).toEqual(['${{ inputs.runner }}'])
    expect(resolveRunsOn(['self-hosted', 'linux', 'x64'], {})).toEqual(['self-hosted', 'linux', 'x64'])
    expect(resolveRunsOn({ group: 'large-runners', labels: ['ubuntu-24.04-16core'] }, {})).toEqual([
      'ubuntu-24.04-16core',
    ])
    expect(resolveRunsOn({ group: 'large-runners' }, {})).toEqual(['large-runners'])
    expect(resolveRunsOn(undefined, {})).toEqual([])
  })
})

describe('parseGithubWorkflow', () => {
  it('extracts name, triggers and jobs', () => {
    const doc = parseYaml(`
name: Release
on:
  push:
    tags: ['v*']
  workflow_dispatch:
jobs:
  test:
    name: Test (\${{ matrix.os }})
    runs-on: \${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest]
    steps:
      - uses: actions/checkout@v5
      - run: npm ci
      - name: Unit tests
        run: npm test
  publish:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - run: npm publish
  docs:
    uses: ./.github/workflows/deploy-docs.yml
  broken: "not a job"
`)
    expect(parseGithubWorkflow(doc, '.github/workflows/release.yml')).toEqual({
      provider: 'github-actions',
      file: '.github/workflows/release.yml',
      name: 'Release',
      triggers: ['push', 'workflow_dispatch'],
      jobs: [
        { id: 'test', name: 'Test (${{ matrix.os }})', tasks: ['test'], runsOn: ['ubuntu-latest', 'macos-latest'] },
        { id: 'publish', tasks: ['release'], runsOn: ['ubuntu-latest'] },
        { id: 'docs', tasks: ['deploy', 'docs'], runsOn: [] },
      ],
    })
  })

  it('returns null for documents that are not mappings and tolerates missing jobs', () => {
    expect(parseGithubWorkflow(null, 'x.yml')).toBeNull()
    expect(parseGithubWorkflow(['a'], 'x.yml')).toBeNull()
    expect(parseGithubWorkflow({ on: 'push' }, 'x.yml')).toEqual({
      provider: 'github-actions',
      file: 'x.yml',
      triggers: ['push'],
      jobs: [],
    })
  })

  it('redacts credential-shaped text in names, job ids and triggers', () => {
    const token = `ghp_${'x1Y2'.repeat(10)}`
    const workflow = parseGithubWorkflow(
      {
        name: 'Deploy API_TOKEN=abc123',
        on: { [`push-${token}`]: null },
        jobs: {
          a: { name: 'curl https://u:p4ss@example.com', steps: [] },
          [`job-${token}`]: { steps: [] },
        },
      },
      'x.yml',
    )
    const json = JSON.stringify(workflow)
    expect(json).not.toContain('abc123')
    expect(json).not.toContain('p4ss')
    expect(json).not.toContain(token)
    expect(workflow?.jobs.map((job) => job.id)).toEqual(['a', 'job-***'])
  })
})

describe('parseGitlabCi', () => {
  it('lists jobs, skipping reserved keywords and hidden jobs', () => {
    const doc = parseYaml(`
stages: [lint, test, deploy]
image: node:22
variables:
  NODE_ENV: test
default:
  tags: [docker]
.base:
  script: [echo base]
lint:
  stage: lint
  script:
    - npm ci
    - npm run lint
unit:
  stage: test
  image:
    name: node:22-alpine
  tags: [linux, docker]
  script: npm test
pages:
  script:
    - mkdir public
deploy_prod:
  stage: deploy
  script: ["./scripts/release.sh"]
`)
    expect(parseGitlabCi(doc, '.gitlab-ci.yml')).toEqual({
      provider: 'gitlab-ci',
      file: '.gitlab-ci.yml',
      triggers: [],
      jobs: [
        { id: 'lint', tasks: ['lint'], runsOn: ['node:22'] },
        { id: 'unit', tasks: ['test'], runsOn: ['node:22-alpine', 'linux', 'docker'] },
        { id: 'pages', tasks: ['deploy'], runsOn: ['node:22'] },
        { id: 'deploy_prod', tasks: ['deploy', 'release'], runsOn: ['node:22'] },
      ],
    })
    expect(parseGitlabCi('nope', '.gitlab-ci.yml')).toBeNull()
  })
})

describe('parseGitlabCi images', () => {
  it("infers tasks from a job's own image, not from an inherited default", () => {
    const doc = parseYaml(`
default:
  image: mcr.microsoft.com/playwright:v1.55.0-noble
unit:
  script: npm test
browser:
  image: cypress/included:15
  script: npm run ci
`)
    expect(parseGitlabCi(doc, '.gitlab-ci.yml')?.jobs).toEqual([
      { id: 'unit', tasks: ['test'], runsOn: ['mcr.microsoft.com/playwright:v1.55.0-noble'] },
      { id: 'browser', tasks: ['e2e'], runsOn: ['cypress/included:15'] },
    ])
  })
})

describe('parseCircleCi', () => {
  it('lists local jobs, then orb jobs referenced by workflows', () => {
    const doc = parseYaml(`
version: 2.1
orbs:
  node: circleci/node@6
jobs:
  build:
    docker:
      - image: cimg/node:22.11
      - image: cimg/postgres:17.0
    steps:
      - checkout
      - node/install-packages
      - run: npm run build
      - run:
          name: Lint
          command: npx eslint .
  integration:
    machine:
      image: ubuntu-2404:current
    steps:
      - run: npx playwright test
workflows:
  main:
    jobs:
      - build
      - node/test:
          version: '22.11'
      - integration:
          requires: [build]
`)
    expect(parseCircleCi(doc, '.circleci/config.yml')).toEqual({
      provider: 'circleci',
      file: '.circleci/config.yml',
      triggers: [],
      jobs: [
        { id: 'build', tasks: ['lint', 'build'], runsOn: ['cimg/node:22.11'] },
        { id: 'integration', tasks: ['e2e'], runsOn: ['ubuntu-2404:current'] },
        { id: 'node/test', tasks: ['test'], runsOn: [] },
      ],
    })
  })
})

describe('ci detector', () => {
  it('reads the go-api fixture workflow', async () => {
    const ci = await (await fixtureContext('go-api')).use(ciDetector)
    expect(ci).toEqual({
      providers: [{ id: 'github-actions', name: 'GitHub Actions', files: ['.github/workflows/go.yml'] }],
      workflows: [
        {
          provider: 'github-actions',
          file: '.github/workflows/go.yml',
          name: 'Go',
          triggers: ['pull_request', 'push'],
          jobs: [{ id: 'build', tasks: ['lint', 'test', 'build'], runsOn: ['ubuntu-latest'] }],
        },
      ],
    })
  })

  it('reads one job per task in the monorepo fixture', async () => {
    const ci = await (await fixtureContext('monorepo')).use(ciDetector)
    expect(ci.workflows[0]?.jobs.map((job) => [job.id, job.tasks])).toEqual([
      ['lint', ['lint']],
      ['test', ['test']],
      ['build', ['build']],
    ])
  })

  it('keeps the provider but skips a malformed workflow, recording a warning', async () => {
    const ctx = await fixtureContext('broken-config')
    const ci = await ctx.use(ciDetector)
    expect(ci.providers).toEqual([
      { id: 'github-actions', name: 'GitHub Actions', files: ['.github/workflows/ci.yml'] },
    ])
    expect(ci.workflows).toEqual([])
    expect(ctx.warnings.some((warning) => warning.file === '.github/workflows/ci.yml')).toBe(true)
  })

  it('detects every provider in catalog order and parses only the cheap formats', async () => {
    const dir = await makeProject({
      '.github/workflows/ci.yml':
        'on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n',
      '.github/workflows/nested/ignored.yml': 'on: push\n',
      '.github/workflows/README.md': '# not a workflow',
      '.gitlab-ci.yml': 'build:\n  script: make build\n',
      '.circleci/config.yml':
        'version: 2.1\njobs:\n  lint:\n    docker: [{ image: cimg/base:current }]\n    steps: [checkout]\n',
      'azure-pipelines.yml': 'trigger: [main]\n',
      Jenkinsfile: 'pipeline { agent any }\n',
      '.travis.yml': 'language: node_js\n',
      'bitbucket-pipelines.yml': 'pipelines: {}\n',
      '.buildkite/pipeline.yml': 'steps: []\n',
      '.drone.yml': 'kind: pipeline\n',
      '.woodpecker/test.yaml': 'steps: {}\n',
      '.forgejo/workflows/check.yaml':
        'on: [pull_request]\njobs:\n  fmt:\n    runs-on: docker\n    steps:\n      - run: cargo fmt --check\n',
      '.gitea/workflows/build.yml': 'on: push\njobs: {}\n',
    })
    const ci = await (await contextFor(dir)).use(ciDetector)
    expect(ci.providers.map((provider) => [provider.id, provider.files])).toEqual([
      ['github-actions', ['.github/workflows/ci.yml']],
      ['gitlab-ci', ['.gitlab-ci.yml']],
      ['circleci', ['.circleci/config.yml']],
      ['azure-pipelines', ['azure-pipelines.yml']],
      ['jenkins', ['Jenkinsfile']],
      ['travis-ci', ['.travis.yml']],
      ['bitbucket-pipelines', ['bitbucket-pipelines.yml']],
      ['buildkite', ['.buildkite/pipeline.yml']],
      ['drone', ['.drone.yml']],
      ['woodpecker', ['.woodpecker/test.yaml']],
      ['forgejo-actions', ['.forgejo/workflows/check.yaml']],
      ['gitea-actions', ['.gitea/workflows/build.yml']],
    ])
    expect(ci.workflows.map((workflow) => [workflow.file, workflow.provider])).toEqual([
      ['.circleci/config.yml', 'circleci'],
      ['.forgejo/workflows/check.yaml', 'forgejo-actions'],
      ['.gitea/workflows/build.yml', 'gitea-actions'],
      ['.github/workflows/ci.yml', 'github-actions'],
      ['.gitlab-ci.yml', 'gitlab-ci'],
    ])
    expect(ci.workflows.find((w) => w.provider === 'forgejo-actions')?.jobs).toEqual([
      { id: 'fmt', tasks: ['format'], runsOn: ['docker'] },
    ])
  })

  it('never echoes commands or secrets from workflows', async () => {
    const dir = await makeProject({
      '.github/workflows/deploy.yml': [
        'on: push',
        'env:',
        `  API_KEY: ${SECRET_SENTINEL}`,
        'jobs:',
        '  deploy:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        `      - run: 'curl -H "Authorization: Bearer ${SECRET_SENTINEL}" https://api.example.com/deploy'`,
        `      - run: DEPLOY_TOKEN=${SECRET_SENTINEL} ./deploy.sh`,
      ].join('\n'),
    })
    const ci = await (await contextFor(dir)).use(ciDetector)
    expect(ci.workflows[0]?.jobs[0]?.tasks).toEqual(['deploy'])
    expect(JSON.stringify(ci)).not.toContain(SECRET_SENTINEL)
    expect(JSON.stringify(ci)).not.toContain('curl')
  })

  it('returns an empty section without CI files', async () => {
    const dir = await makeProject({ 'README.md': '# hi' })
    expect(await (await contextFor(dir)).use(ciDetector)).toEqual({ providers: [], workflows: [] })
  })
})
