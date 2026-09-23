// biome-ignore-all lint/suspicious/noTemplateCurlyInString: "${…}" is literal GitHub Actions / Dockerfile syntax in these fixtures
import { describe, expect, it } from 'vitest'
import { parseYaml } from '../../src/core/parse.ts'
import {
  buildRuntimes,
  displayVersion,
  dockerfileSources,
  gitlabImages,
  imageRuntime,
  normalizeNodeVersion,
  normalizeVersion,
  parseGoWorkVersions,
  parseImageRef,
  parseMiseTools,
  parseToolVersions,
  parseVersionFile,
  presentRuntimes,
  type RuntimeSource,
  rankRuntimes,
  runtimesDetector,
  setupActionVersions,
  versionFromImageTag,
} from '../../src/detectors/runtimes.ts'
import { isDockerfileName, parseDockerfile, substituteArgs } from '../../src/facts/docker.ts'
import type { Runtime } from '../../src/types.ts'
import { contextFor, fixtureContext, makeProject, SECRET_SENTINEL, timeBudget } from '../helpers.ts'

async function runtimesOf(files: Record<string, string>): Promise<Runtime[]> {
  return (await contextFor(await makeProject(files))).use(runtimesDetector)
}

function runtime(runtimes: Runtime[], id: string): Runtime | undefined {
  return runtimes.find((r) => r.id === id)
}

describe('normalizeNodeVersion', () => {
  it.each([
    ['v22.1.0', '22.1.0', 'exact'],
    ['22', '22', 'exact'],
    ['22.x', '22', 'exact'],
    ['22.11.x', '22.11', 'exact'],
    [' "22.11.0" ', '22.11.0', 'exact'],
    ['lts/iron', '20', 'alias'],
    ['LTS/Jod', '22', 'alias'],
    ['lts/krypton', '24', 'alias'],
    ['iron', '20', 'alias'],
    ['lts/*', null, 'alias'],
    ['lts/-1', null, 'alias'],
    ['lts/unknown', null, 'alias'],
    ['node', null, 'alias'],
    ['stable', null, 'alias'],
    ['latest', null, 'alias'],
    ['constructor', null, 'alias'],
    ['', null, 'alias'],
    ['>=22', '>=22', 'range'],
    ['^20.9.0', '^20.9.0', 'range'],
    ['20 || 22', '20 || 22', 'range'],
    ['>=18 <23', '>=18 <23', 'range'],
  ])('%j → %j (%s)', (raw, version, kind) => {
    expect(normalizeNodeVersion(raw)).toEqual({ version, kind })
  })

  it('handles Go-style and prerelease versions', () => {
    expect(normalizeVersion('1.25.1')).toEqual({ version: '1.25.1', kind: 'exact' })
    expect(normalizeVersion('1.25.x')).toEqual({ version: '1.25', kind: 'exact' })
    expect(normalizeVersion('1.26rc1')).toEqual({ version: '1.26rc1', kind: 'exact' })
    expect(normalizeVersion('22.0.0-rc.1')).toEqual({ version: '22.0.0-rc.1', kind: 'exact' })
    expect(normalizeVersion('stable')).toEqual({ version: null, kind: 'alias' })
    expect(normalizeVersion('oldstable')).toEqual({ version: null, kind: 'alias' })
  })
})

describe('version files', () => {
  it('reads the first meaningful value of .nvmrc-style files', () => {
    expect(parseVersionFile('22\n')).toBe('22')
    expect(parseVersionFile('# pinned for CI\n\n  v22.11.0  # current LTS\n')).toBe('v22.11.0')
    expect(parseVersionFile('\n\n')).toBeNull()
  })

  it('reads .tool-versions', () => {
    expect(parseToolVersions('# tools\nnodejs 22.11.0 20.18.0\ngolang 1.25.1 # go\n\npython\n')).toEqual([
      { tool: 'nodejs', version: '22.11.0' },
      { tool: 'golang', version: '1.25.1' },
    ])
  })

  it('reads mise tools in their common forms', () => {
    const text = [
      '[env]',
      'node = "not a tool"',
      '[tools]',
      'node = "22" # comment',
      "go = ['1.25', '1.24']",
      'bun = { version = "1.3.0", os = ["linux"] }',
      '"core:deno" = "2.5"',
      'python = "3.13"',
      '[settings]',
      'node = "ignored"',
      '',
      'tools.erlang = "27"',
    ].join('\n')
    expect(parseMiseTools(text)).toEqual([
      { tool: 'node', version: '22' },
      { tool: 'go', version: '1.25' },
      { tool: 'bun', version: '1.3.0' },
      { tool: 'deno', version: '2.5' },
      { tool: 'python', version: '3.13' },
      { tool: 'erlang', version: '27' },
    ])
  })

  it('reads go.work directives', () => {
    expect(parseGoWorkVersions('go 1.25.0\ntoolchain go1.25.2\n\nuse (\n\t./api\n)\n')).toEqual({
      go: '1.25.0',
      toolchain: '1.25.2',
    })
    expect(parseGoWorkVersions('use ./api\n')).toEqual({})
  })
})

describe('container images', () => {
  it('parses image references', () => {
    expect(parseImageRef('node:22-alpine')).toEqual({ registry: null, repository: 'node', tag: '22-alpine' })
    expect(parseImageRef('docker.io/library/node:22@sha256:abcdef')).toEqual({
      registry: 'docker.io',
      repository: 'library/node',
      tag: '22',
    })
    expect(parseImageRef('localhost:5000/team/app')).toEqual({
      registry: 'localhost:5000',
      repository: 'team/app',
      tag: null,
    })
    expect(parseImageRef('')).toBeNull()
    expect(parseImageRef('two words')).toBeNull()
  })

  it.each([
    ['node', 'node:22-alpine', '22', 'exact'],
    ['node', 'node:22.11.0-bookworm-slim', '22.11.0', 'exact'],
    ['node', 'node:lts', null, 'alias'],
    ['node', 'node:current-alpine', null, 'alias'],
    ['node', 'node', null, 'alias'],
    ['node', 'node:iron-alpine', '20', 'alias'],
    ['node', 'docker.io/library/node:20', '20', 'exact'],
    ['node', 'index.docker.io/node:18', '18', 'exact'],
    ['node', 'public.ecr.aws/docker/library/node:24-slim', '24', 'exact'],
    ['node', 'node:22@sha256:0123456789abcdef', '22', 'exact'],
    ['go', 'golang:1.25-alpine', '1.25', 'exact'],
    ['go', 'golang:1.25.1', '1.25.1', 'exact'],
    ['go', 'golang:alpine', null, 'alias'],
    ['bun', 'oven/bun:1.3-alpine', '1.3', 'exact'],
    ['bun', 'oven/bun:canary', null, 'alias'],
    ['deno', 'denoland/deno:alpine-2.5.0', '2.5.0', 'exact'],
    ['deno', 'denoland/deno:2.5.0', '2.5.0', 'exact'],
  ])('%s: %s → %j', (id, image, version, kind) => {
    expect(imageRuntime(image)).toEqual({ runtime: id, version: { version, kind } })
  })

  it.each(['ghcr.io/acme/node:22', 'nginx:1.29', 'mynode:22', 'gcr.io/distroless/nodejs22', 'build'])(
    'ignores %s',
    (image) => {
      expect(imageRuntime(image)).toBeNull()
    },
  )

  it('reads unresolved variables in tags as unknown', () => {
    expect(versionFromImageTag('node', '${NODE_VERSION}-alpine')).toEqual({ version: null, kind: 'alias' })
    expect(versionFromImageTag('node', null)).toEqual({ version: null, kind: 'alias' })
  })

  it('recognizes Dockerfile names with the shared rule', () => {
    for (const name of [
      'Dockerfile',
      'Dockerfile.prod',
      'dockerfile.dev',
      'api.Dockerfile',
      'Containerfile',
      'dockerfile',
    ]) {
      expect(isDockerfileName(name), name).toBe(true)
    }
    for (const name of [
      'Dockerfile.dockerignore',
      '.dockerignore',
      'docker-compose.yml',
      'dockerfile.go',
      'readme.md',
    ]) {
      expect(isDockerfileName(name), name).toBe(false)
    }
  })
})

describe('Dockerfile base images', () => {
  const sources = (text: string) =>
    dockerfileSources({ files: [{ path: 'Dockerfile', ...parseDockerfile(text) }], truncated: false }).map(
      (source) => source.image,
    )

  it('substitutes global ARG defaults and handles flags, stages and continuations', () => {
    const text = [
      '# syntax=docker/dockerfile:1',
      'ARG NODE_VERSION=22.11.0',
      'ARG VARIANT="bookworm-slim" DISTRO',
      'FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-${VARIANT} AS deps',
      'ARG NODE_VERSION=18',
      'RUN npm ci',
      'FROM \\',
      '  golang:$GO_VERSION AS tools',
      'from node:${NODE_MAJOR:-20}-alpine as runner',
      'FROM deps AS final',
      'FROM scratch',
    ].join('\n')
    expect(sources(text)).toEqual(['node:22.11.0-bookworm-slim', 'golang:$GO_VERSION', 'node:20-alpine', 'scratch'])
  })

  it('does not treat heredoc bodies as instructions', () => {
    const text = [
      'FROM node:22',
      'RUN <<EOF',
      'FROM node:12',
      'echo hi',
      'EOF',
      'COPY <<-"CONF" /etc/x',
      'FROM x',
      'CONF',
    ].join('\n')
    expect(sources(text)).toEqual(['node:22'])
  })

  it('substitutes shell-style variables', () => {
    const args = new Map([['A', '1']])
    expect(substituteArgs('${A}-$A-${B:-2}-${A:+set}-${B:+unset}-$B', args)).toBe('1-1-2-set-${B:+unset}-$B')
  })

  it('reads quoted ARG defaults and joins continuations across blank lines', () => {
    const text = ['ARG TAG="22-alpine"', 'FROM node:${TAG} \\', '', '  AS build', 'FROM build'].join('\n')
    expect(sources(text)).toEqual(['node:22-alpine'])
  })

  it('skips references too long to be images', () => {
    expect(sources(`FROM node:${'1'.repeat(600)}\nFROM node:22\n`)).toEqual(['node:22'])
  })

  it('survives garbage', () => {
    expect(sources('')).toEqual([])
    expect(sources('FROM\n\\\n\u0000\nFROM   \n')).toEqual([])
  })
})

describe('CI version declarations', () => {
  it('reads setup-* actions, expanding literal matrices and env', () => {
    const doc = parseYaml(`
env:
  GO: '1.25'
jobs:
  test:
    strategy:
      matrix:
        node: [20, 22.x, lts/*]
    steps:
      - uses: actions/setup-node@v5
        with:
          node-version: \${{ matrix.node }}
      - uses: actions/setup-node@v5
        with:
          node-version-file: .nvmrc
      - uses: actions/setup-go@v6
        with:
          go-version: \${{ env.GO }}
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - uses: denoland/setup-deno@v2
        with:
          deno-version: v2.x
      - uses: actions/setup-node@v5
        with:
          node-version: \${{ inputs.node }}
  other: nope
`)
    expect(setupActionVersions(doc)).toEqual([
      { runtime: 'node', field: 'setup-node', raw: '20' },
      { runtime: 'node', field: 'setup-node', raw: '22.x' },
      { runtime: 'node', field: 'setup-node', raw: 'lts/*' },
      { runtime: 'go', field: 'setup-go', raw: '1.25' },
      { runtime: 'bun', field: 'setup-bun', raw: 'latest' },
      { runtime: 'deno', field: 'setup-deno', raw: 'v2.x' },
    ])
    expect(setupActionVersions(null)).toEqual([])
    expect(setupActionVersions({ jobs: 'x' })).toEqual([])
  })

  it('reads GitLab images with variables', () => {
    const doc = parseYaml(`
variables:
  NODE_VERSION: "22"
image: node:\${NODE_VERSION}
default:
  image: node:22
.template:
  image: node:12
test:
  image:
    name: golang:1.25
build:
  variables:
    NODE_VERSION: "24"
  image: node:$NODE_VERSION-alpine
`)
    expect(gitlabImages(doc)).toEqual(['node:22', 'golang:1.25', 'node:24-alpine'])
  })

  it('stays fast on GitLab files with many jobs and variables', () => {
    const variables = Object.fromEntries(Array.from({ length: 20_000 }, (_, i) => [`V${i}`, 'x']))
    const doc: Record<string, unknown> = { variables }
    for (let i = 0; i < 20_000; i++) doc[`job${i}`] = { image: `node:${i}`, variables: { LOCAL: 'y' } }
    const started = performance.now()
    expect(gitlabImages(doc)).toHaveLength(20_000)
    expect(performance.now() - started).toBeLessThan(timeBudget(1000))
  })
})

describe('display version and presence', () => {
  const src = (
    runtime: RuntimeSource['runtime'],
    origin: RuntimeSource['origin'],
    version: string | null,
    kind: 'exact' | 'range' | 'alias',
    extra: Partial<RuntimeSource['source']> = {},
    root = true,
  ): RuntimeSource => ({ runtime, origin, root, source: { file: 'f', raw: version ?? 'x', version, kind, ...extra } })

  it('prefers pins, then root engines, then Docker, then CI for Node.js', () => {
    expect(
      displayVersion('node', [src('node', 'engines', '>=22', 'range'), src('node', 'version-file', '22', 'exact')]),
    ).toBe('22')
    expect(displayVersion('node', [src('node', 'version-file', '20', 'alias')])).toBe('20')
    expect(
      displayVersion('node', [
        src('node', 'ci', '24', 'exact'),
        src('node', 'docker', '22', 'exact'),
        src('node', 'engines', '>=20', 'range', {}, false),
        src('node', 'engines', '>=22', 'range'),
      ]),
    ).toBe('>=22')
    expect(displayVersion('node', [src('node', 'ci', '24', 'exact'), src('node', 'docker', '22', 'exact')])).toBe('22')
    expect(displayVersion('node', [src('node', 'version-file', null, 'alias')])).toBeNull()
  })

  it('prefers the root go directive for Go', () => {
    expect(
      displayVersion('go', [
        src('go', 'go-mod', '1.24', 'exact', { field: 'go directive' }, false),
        src('go', 'go-mod', '1.25.2', 'exact', { field: 'toolchain' }),
        src('go', 'go-mod', '1.25', 'exact', { field: 'go directive' }),
      ]),
    ).toBe('1.25')
  })

  it('infers Node.js from package.json only when Bun or Deno do not explain it', () => {
    const none = { packageDirs: ['.'], goModule: false, bunDirs: [], denoDirs: [] }
    expect([...presentRuntimes(none, [])]).toEqual(['node'])
    expect([...presentRuntimes({ ...none, bunDirs: ['.'] }, [])]).toEqual(['bun'])
    expect([...presentRuntimes({ ...none, denoDirs: ['.'] }, [])]).toEqual(['deno'])
    expect([...presentRuntimes({ ...none, bunDirs: ['.'] }, [src('node', 'version-file', '22', 'exact')])]).toEqual([
      'node',
      'bun',
    ])
    expect([...presentRuntimes({ ...none, packageDirs: [] }, [src('node', 'docker', '22', 'exact')])]).toEqual(['node'])
    expect([...presentRuntimes({ ...none, packageDirs: [] }, [src('bun', 'docker', '1', 'exact')])]).toEqual([])
    // packageManager "bun@…" in the root package.json explains the root package.
    expect([...presentRuntimes(none, [src('bun', 'package-manager', '1.3.1', 'exact')])]).toEqual(['bun'])
  })

  it('keeps Node.js when Bun only explains some packages of a workspace', () => {
    const workspace = { packageDirs: ['.', 'apps/web', 'tools/bench'], goModule: false, bunDirs: [], denoDirs: [] }
    expect([...presentRuntimes({ ...workspace, bunDirs: ['tools/bench'] }, [])]).toEqual(['node', 'bun'])
    expect([...presentRuntimes({ ...workspace, bunDirs: ['.'] }, [])]).toEqual(['bun'])
    const nested = src('bun', 'engines', '>=1.2', 'range', { file: 'tools/bench/package.json' }, false)
    expect([...presentRuntimes(workspace, [nested])]).toEqual(['node', 'bun'])
    expect(buildRuntimes([], new Set(['deno', 'node']))).toEqual([
      { id: 'node', name: 'Node.js', version: null, sources: [] },
      { id: 'deno', name: 'Deno', version: null, sources: [] },
    ])
  })
})

describe('runtimes detector', () => {
  it('reads .nvmrc in the nuxt-app fixture', async () => {
    const runtimes = await (await fixtureContext('nuxt-app')).use(runtimesDetector)
    expect(runtimes).toEqual([
      {
        id: 'node',
        name: 'Node.js',
        version: '22',
        sources: [{ file: '.nvmrc', raw: '22', version: '22', kind: 'exact' }],
      },
    ])
  })

  it('reports every conflicting source in the mixed-lockfiles fixture', async () => {
    const runtimes = await (await fixtureContext('mixed-lockfiles')).use(runtimesDetector)
    expect(runtimes).toEqual([
      {
        id: 'node',
        name: 'Node.js',
        version: '20',
        sources: [
          { file: '.node-version', raw: '18.20.4', version: '18.20.4', kind: 'exact' },
          { file: '.nvmrc', raw: '20', version: '20', kind: 'exact' },
          { file: 'package.json', field: 'engines.node', raw: '>=22', version: '>=22', kind: 'range' },
        ],
      },
    ])
  })

  it('reads go.mod and the Dockerfile in the go-api fixture', async () => {
    const runtimes = await (await fixtureContext('go-api')).use(runtimesDetector)
    expect(runtimes).toEqual([
      {
        id: 'go',
        name: 'Go',
        version: '1.25.1',
        sources: [
          { file: 'Dockerfile', field: 'FROM', raw: 'golang:1.25-alpine', version: '1.25', kind: 'exact' },
          { file: 'go.mod', field: 'go directive', raw: 'go 1.25.1', version: '1.25.1', kind: 'exact' },
        ],
      },
    ])
  })

  it('combines CI and Docker sources in the fastify-api fixture', async () => {
    const node = runtime(await (await fixtureContext('fastify-api')).use(runtimesDetector), 'node')
    expect(node?.version).toBe('22')
    expect(node?.sources.map((s) => [s.file, s.field, s.version])).toEqual([
      ['.github/workflows/ci.yml', 'setup-node', '22'],
      ['Dockerfile', 'FROM', '22'],
    ])
  })

  it('reports Node.js and Go in the monorepo fixture', async () => {
    const runtimes = await (await fixtureContext('monorepo')).use(runtimesDetector)
    expect(runtimes.map((r) => [r.id, r.version])).toEqual([
      ['node', '22'],
      ['go', '1.25'],
    ])
    expect(runtime(runtimes, 'go')?.sources).toEqual([
      { file: 'services/billing/go.mod', field: 'go directive', raw: 'go 1.25', version: '1.25', kind: 'exact' },
    ])
  })

  it('keeps Node.js for a workspace where only one package uses Bun', async () => {
    const runtimes = await runtimesOf({
      'package.json': JSON.stringify({ name: 'root', workspaces: ['apps/*', 'tools/*'] }),
      'apps/web/package.json': '{"name":"web"}',
      'tools/bench/package.json': '{"name":"bench"}',
      'tools/bench/bunfig.toml': '',
    })
    expect(runtimes.map((r) => r.id)).toEqual(['node', 'bun'])
  })

  it('reports only Bun for the bun-app fixture', async () => {
    const runtimes = await (await fixtureContext('bun-app')).use(runtimesDetector)
    expect(runtimes).toEqual([{ id: 'bun', name: 'Bun', version: null, sources: [] }])
  })

  it('returns nothing for a project without runtime evidence', async () => {
    expect(await (await fixtureContext('plain-repo')).use(runtimesDetector)).toEqual([])
  })

  it('survives broken manifests and configs', async () => {
    const broken = await (await fixtureContext('broken-config')).use(runtimesDetector)
    expect(broken.map((r) => r.id)).toEqual(['node', 'go'])
    const manifest = await (await fixtureContext('broken-manifest')).use(runtimesDetector)
    expect(manifest).toEqual([{ id: 'node', name: 'Node.js', version: null, sources: [] }])
  })

  it('collects package.json fields, workspace version files and tool managers', async () => {
    const runtimes = await runtimesOf({
      'package.json': JSON.stringify({
        name: 'root',
        workspaces: ['apps/*'],
        engines: { node: ' >=22 ' },
        volta: { node: '22.11.0' },
        devEngines: {
          runtime: [
            { name: 'node', version: '^22' },
            { name: 'other', version: '1' },
          ],
        },
      }),
      'apps/web/package.json': JSON.stringify({ name: 'web', engines: { node: '>=20' } }),
      'apps/web/.nvmrc': 'lts/iron\n',
      '.tool-versions': 'nodejs 22.11.0\ngolang 1.25.1\npython 3.13.0\n',
      'mise.toml': '[tools]\nnode = "22"\n',
    })
    const node = runtime(runtimes, 'node')
    expect(node?.version).toBe('22.11.0')
    expect(node?.sources).toEqual([
      { file: '.tool-versions', field: 'nodejs', raw: '22.11.0', version: '22.11.0', kind: 'exact' },
      { file: 'apps/web/.nvmrc', raw: 'lts/iron', version: '20', kind: 'alias' },
      { file: 'apps/web/package.json', field: 'engines.node', raw: '>=20', version: '>=20', kind: 'range' },
      { file: 'mise.toml', field: 'tools.node', raw: '22', version: '22', kind: 'exact' },
      { file: 'package.json', field: 'devEngines.runtime', raw: '^22', version: '^22', kind: 'range' },
      { file: 'package.json', field: 'engines.node', raw: '>=22', version: '>=22', kind: 'range' },
      { file: 'package.json', field: 'volta.node', raw: '22.11.0', version: '22.11.0', kind: 'exact' },
    ])
    // .tool-versions declares Go, but without go.mod or go.work there is no Go project.
    expect(runtime(runtimes, 'go')).toBeUndefined()
  })

  it('resolves Dockerfile ARGs and CI matrices', async () => {
    const runtimes = await runtimesOf({
      'package.json': '{"name":"app"}',
      Dockerfile: 'ARG NODE_VERSION=22.11.0\nFROM node:${NODE_VERSION}-alpine AS build\nFROM build\n',
      'docker/worker.Dockerfile': 'FROM --platform=linux/amd64 node:lts-slim\n',
      'a/b/c/d/e/Dockerfile': 'FROM node:10\n',
      'test/fixtures/app/Dockerfile': 'FROM node:12\n',
      '.github/workflows/ci.yml': [
        'jobs:',
        '  test:',
        '    strategy:',
        '      matrix:',
        '        node: [20, 22]',
        '    steps:',
        '      - uses: actions/setup-node@v5',
        '        with:',
        '          node-version: ${{ matrix.node }}',
      ].join('\n'),
      '.gitlab-ci.yml': 'image: node:24\n',
    })
    expect(runtime(runtimes, 'node')).toEqual({
      id: 'node',
      name: 'Node.js',
      version: '22.11.0',
      sources: [
        { file: '.github/workflows/ci.yml', field: 'setup-node', raw: '20', version: '20', kind: 'exact' },
        { file: '.github/workflows/ci.yml', field: 'setup-node', raw: '22', version: '22', kind: 'exact' },
        { file: '.gitlab-ci.yml', field: 'image', raw: 'node:24', version: '24', kind: 'exact' },
        { file: 'Dockerfile', field: 'FROM', raw: 'node:22.11.0-alpine', version: '22.11.0', kind: 'exact' },
        { file: 'docker/worker.Dockerfile', field: 'FROM', raw: 'node:lts-slim', version: null, kind: 'alias' },
      ],
    })
  })

  it('reads Go workspaces, toolchains and setup-go', async () => {
    const runtimes = await runtimesOf({
      'go.work': 'go 1.25.0\n\nuse (\n\t./api\n\t./worker\n)\n',
      'api/go.mod': 'module example.com/api\n\ngo 1.25.1\n\ntoolchain go1.25.3\n',
      'worker/go.mod': 'module example.com/worker\n\ngo 1.24\n',
      '.github/workflows/go.yml': [
        'jobs:',
        '  test:',
        '    steps:',
        '      - uses: actions/setup-go@v6',
        '        with:',
        '          go-version: "1.25.x"',
        '      - uses: actions/setup-go@v6',
        '        with:',
        '          go-version-file: go.mod',
      ].join('\n'),
    })
    expect(runtimes).toEqual([
      {
        id: 'go',
        name: 'Go',
        version: '1.25.1',
        sources: [
          { file: '.github/workflows/go.yml', field: 'setup-go', raw: '1.25.x', version: '1.25', kind: 'exact' },
          { file: 'api/go.mod', field: 'go directive', raw: 'go 1.25.1', version: '1.25.1', kind: 'exact' },
          { file: 'api/go.mod', field: 'toolchain', raw: 'toolchain go1.25.3', version: '1.25.3', kind: 'exact' },
          { file: 'go.work', field: 'go directive', raw: 'go 1.25.0', version: '1.25.0', kind: 'exact' },
          { file: 'worker/go.mod', field: 'go directive', raw: 'go 1.24', version: '1.24', kind: 'exact' },
        ],
      },
    ])
  })

  it('reads Bun and Deno declarations', async () => {
    const runtimes = await runtimesOf({
      'package.json': JSON.stringify({
        name: 'x',
        packageManager: 'bun@1.3.1+sha512.abcdef',
        engines: { bun: '>=1.2' },
      }),
      'deno.jsonc': '{ // config\n "tasks": {} }',
      '.dvmrc': 'v2.5.4\n',
      Dockerfile: 'FROM oven/bun:1.3-alpine\n',
    })
    expect(runtimes.map((r) => r.id)).toEqual(['bun', 'deno'])
    expect(runtime(runtimes, 'bun')).toEqual({
      id: 'bun',
      name: 'Bun',
      version: '1.3.1',
      sources: [
        { file: 'Dockerfile', field: 'FROM', raw: 'oven/bun:1.3-alpine', version: '1.3', kind: 'exact' },
        { file: 'package.json', field: 'engines.bun', raw: '>=1.2', version: '>=1.2', kind: 'range' },
        { file: 'package.json', field: 'packageManager', raw: 'bun@1.3.1', version: '1.3.1', kind: 'exact' },
      ],
    })
    expect(runtime(runtimes, 'deno')).toEqual({
      id: 'deno',
      name: 'Deno',
      version: '2.5.4',
      sources: [{ file: '.dvmrc', raw: 'v2.5.4', version: '2.5.4', kind: 'exact' }],
    })
  })

  it('reports Deno without a version when nothing declares one', async () => {
    expect(await runtimesOf({ 'deno.json': '{}' })).toEqual([{ id: 'deno', name: 'Deno', version: null, sources: [] }])
  })

  it('never echoes credential-shaped values and drops implausible ones', async () => {
    const token = `ghp_${'A1b2C3d4'.repeat(5)}`
    const runtimes = await runtimesOf({
      'package.json': JSON.stringify({
        name: 'x',
        workspaces: ['apps/*'],
        engines: { node: `>=22 ${'9'.repeat(300)}` },
      }),
      'apps/a/package.json': JSON.stringify({ name: 'a', engines: { node: token }, volta: { node: token } }),
      '.nvmrc': `${token}\n`,
      '.node-version': '/Users/someone/.nvm/versions/node/v22.11.0\n',
      '.tool-versions': 'nodejs path:/Users/someone/node\n',
      'mise.toml': '[tools]\nnode = "~/node"\n',
    })
    const json = JSON.stringify(runtimes)
    expect(json).not.toContain(token)
    expect(json).not.toContain('/Users/someone')
    expect(json).not.toContain('9'.repeat(300))
    expect(runtime(runtimes, 'node')?.sources).toEqual([
      { file: '.nvmrc', raw: '***', version: null, kind: 'alias' },
      { file: 'apps/a/package.json', field: 'engines.node', raw: '***', version: null, kind: 'alias' },
      { file: 'apps/a/package.json', field: 'volta.node', raw: '***', version: null, kind: 'alias' },
    ])
  })

  it('finishes quickly on a 1 MB Dockerfile whose ARG expansion used to exhaust memory', async () => {
    const value = 'x'.repeat(400_000)
    const lines = `FROM node:${'$A'.repeat(250)}\n`.repeat(1_200)
    const dir = await makeProject({
      'package.json': '{"name":"app"}',
      Dockerfile: `ARG A=${value}\n${lines}FROM node:22\n`,
    })
    const started = performance.now()
    const node = runtime(await (await contextFor(dir)).use(runtimesDetector), 'node')
    expect(performance.now() - started).toBeLessThan(timeBudget(3000))
    expect(node?.sources.map((s) => s.raw)).toEqual(['node:22'])
  })

  it('never substitutes a secret ARG or CI variable into a reported image', async () => {
    const runtimes = await runtimesOf({
      'package.json': '{"name":"app"}',
      Dockerfile: [
        `ARG NPM_TOKEN=${SECRET_SENTINEL}`,
        'FROM node:${NPM_TOKEN} AS deps',
        `FROM node:\${REGISTRY_PASSWORD:-${SECRET_SENTINEL}}`,
        'FROM node:22',
      ].join('\n'),
      '.gitlab-ci.yml': `variables:\n  CI_DEPLOY_PASSWORD: "${SECRET_SENTINEL}"\nimage: node:$CI_DEPLOY_PASSWORD\n`,
    })
    const json = JSON.stringify(runtimes)
    expect(json).not.toContain(SECRET_SENTINEL)
    expect(runtime(runtimes, 'node')?.version).toBe('22')
  })

  it('reads lowercase dockerfile.* names like the services section does', async () => {
    const runtimes = await runtimesOf({ 'package.json': '{"name":"app"}', 'docker/dockerfile.dev': 'FROM node:24\n' })
    expect(runtime(runtimes, 'node')?.sources).toEqual([
      { file: 'docker/dockerfile.dev', field: 'FROM', raw: 'node:24', version: '24', kind: 'exact' },
    ])
  })

  it('lists the runtime the project declares first, before one only CI mentions', async () => {
    const runtimes = await runtimesOf({
      'go.mod': 'module example.com/app\n\ngo 1.25\n',
      'main.go': 'package main\n',
      '.github/workflows/docs.yml': [
        'jobs:',
        '  docs:',
        '    steps:',
        '      - uses: actions/setup-node@v5',
        '        with:',
        '          node-version: 22',
      ].join('\n'),
    })
    expect(runtimes.map((r) => [r.id, r.version])).toEqual([
      ['go', '1.25'],
      ['node', '22'],
    ])
  })

  it('ranks runtimes by where the project declares them', () => {
    const ci: RuntimeSource = {
      runtime: 'node',
      origin: 'ci',
      root: false,
      source: { file: 'ci.yml', raw: '22', version: '22', kind: 'exact' },
    }
    const evidence = { packageDirs: ['docs'], goModule: true, goDirs: ['.'], bunDirs: [], denoDirs: [] }
    expect([...rankRuntimes(evidence, [ci])]).toEqual([
      ['node', 1],
      ['go', 0],
      ['bun', 2],
      ['deno', 2],
    ])
    expect(rankRuntimes({ ...evidence, packageDirs: [] }, [ci]).get('node')).toBe(2)
  })

  it('stays fast on hostile version files', () => {
    const started = performance.now()
    parseGoWorkVersions('\n'.repeat(500_000))
    parseMiseTools(`[${' '.repeat(200_000)}x\n${'['.repeat(100_000)}`)
    parseDockerfile(`FROM ${'a<<'.repeat(100_000)}\n${'\\\n'.repeat(100_000)}`)
    parseDockerfile(`ARG ${'A'.repeat(500_000)}\nFROM x`)
    substituteArgs('${A:-'.repeat(200_000), new Map())
    substituteArgs(`\${${'A'.repeat(500_000)}`, new Map())
    parseVersionFile(' '.repeat(500_000))
    expect(performance.now() - started).toBeLessThan(timeBudget(1000))
  })
})
