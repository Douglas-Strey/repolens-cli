import { describe, expect, it } from 'vitest'
import {
  findEndOfLife,
  findGoVersionConflicts,
  findNodeOutOfRange,
  findNodeVersionConflict,
  goToolVersions,
  goVersionConflict,
  isGoToolchainOlder,
  NODE_EOL,
  nodePins,
  nodeVersionConflict,
  nodeVersionOutOfRange,
  parseGoVersion,
  runtimeEol,
  suggestNodeMajor,
  supportedLtsMajors,
  versionFitsRange,
} from '../../src/doctor/rules/runtime.ts'
import type { Runtime, VersionSource } from '../../src/types.ts'
import { exact, expectWellFormed, makeSections, nodeRuntime, projectContext, runCheck, runRule } from './support.ts'

const range = (file: string, version: string, field = 'engines.node'): VersionSource => ({
  file,
  field,
  raw: version,
  version,
  kind: 'range',
})

describe('nodePins', () => {
  it('keeps exact pins, de-duplicates them and sorts by file', () => {
    const pins = nodePins([
      nodeRuntime([
        exact('Dockerfile', '22', 'FROM'),
        exact('Dockerfile', '22', 'FROM'),
        exact('.nvmrc', '22.11.0'),
        range('package.json', '>=22'),
        { file: '.node-version', raw: 'lts/*', version: null, kind: 'alias' },
      ]),
    ])
    expect(pins).toEqual([
      { file: '.nvmrc', version: '22.11.0', major: 22 },
      { file: 'Dockerfile', version: '22', major: 22 },
    ])
  })

  it('leaves out CI matrices that test several majors', () => {
    const pins = nodePins([
      nodeRuntime([
        exact('.github/workflows/ci.yml', '20', 'setup-node'),
        exact('.github/workflows/ci.yml', '22', 'setup-node'),
        exact('.nvmrc', '22'),
      ]),
    ])
    expect(pins.map((pin) => pin.file)).toEqual(['.nvmrc'])
  })

  it('returns nothing without a Node.js runtime', () => {
    expect(nodePins([])).toEqual([])
  })
})

describe('versionFitsRange', () => {
  it('compares full and partial versions', () => {
    expect(versionFitsRange('20', '>=22')).toBe(false)
    expect(versionFitsRange('22', '>=20.9')).toBe(true)
    expect(versionFitsRange('20', '>=20.9')).toBe(true)
    expect(versionFitsRange('20.1.0', '>=20.9')).toBe(false)
    expect(versionFitsRange('v22.11.0', '^22.11')).toBe(true)
    expect(versionFitsRange('20.5', '^20.9')).toBe(false)
    expect(versionFitsRange('24.0.0-rc.1', '>=22')).toBe(true)
  })

  it('returns null when a side cannot be interpreted', () => {
    expect(versionFitsRange('22', 'not a range')).toBeNull()
    expect(versionFitsRange('lts/iron', '>=20')).toBeNull()
  })
})

describe('NODE_VERSION_CONFLICT', () => {
  const pins = [
    { file: '.node-version', version: '18.20.4', major: 18 },
    { file: '.nvmrc', version: '20', major: 20 },
  ]

  it('lists every pin when majors disagree and suggests a major that fits engines.node', () => {
    const found = findNodeVersionConflict(pins, '>=22')
    expect(found).toEqual([
      {
        code: 'NODE_VERSION_CONFLICT',
        severity: 'warning',
        category: 'runtime',
        message: 'Node.js versions disagree (.node-version: 18.20.4, .nvmrc: 20)',
        hint: 'Pin the same Node.js major version in every file, e.g. 22',
        files: ['.node-version', '.nvmrc'],
        subject: 'node',
      },
    ])
    expectWellFormed(found)
  })

  it('suggests the most common pinned major', () => {
    const three = [...pins, { file: 'Dockerfile', version: '20', major: 20 }]
    expect(suggestNodeMajor(three)).toBe(20)
    expect(suggestNodeMajor(three, '>=18')).toBe(20)
    expect(suggestNodeMajor(pins, 'garbage')).toBeNull()
  })

  it('does not report agreeing pins', () => {
    expect(findNodeVersionConflict([{ file: '.nvmrc', version: '22', major: 22 }])).toEqual([])
    expect(
      findNodeVersionConflict([
        { file: '.nvmrc', version: '22', major: 22 },
        { file: 'Dockerfile', version: '22.11.0', major: 22 },
      ]),
    ).toEqual([])
  })

  it('reads engines.node from package.json through the rule', async () => {
    const sections = makeSections({
      runtimes: [nodeRuntime([exact('.nvmrc', '20'), exact('.node-version', '18.20.4')])],
    })
    const ctx = await projectContext({ 'package.json': JSON.stringify({ engines: { node: '>=18' } }) })
    expect((await runCheck(nodeVersionConflict, sections, ctx))[0]?.hint).toContain('e.g. 20')
  })

  it('is skipped without exact pins, or with a single pin that has nothing to agree with', async () => {
    const sections = makeSections({ runtimes: [nodeRuntime([range('package.json', '>=22')])] })
    expect((await runRule(nodeVersionConflict, sections)).checks[0]?.status).toBe('skipped')
    const single = makeSections({ runtimes: [nodeRuntime([exact('.nvmrc', '22')])] })
    expect((await runRule(nodeVersionConflict, single)).checks[0]?.status).toBe('skipped')
    const two = makeSections({ runtimes: [nodeRuntime([exact('.nvmrc', '22'), exact('Dockerfile', '22', 'FROM')])] })
    expect((await runRule(nodeVersionConflict, two)).checks[0]?.status).toBe('passed')
  })
})

describe('NODE_VERSION_OUT_OF_RANGE', () => {
  it('reports each file whose pin cannot satisfy engines.node', () => {
    const found = findNodeOutOfRange(
      [
        { file: '.node-version', version: '18.20.4', major: 18 },
        { file: '.nvmrc', version: '20', major: 20 },
        { file: 'Dockerfile', version: '22', major: 22 },
      ],
      '>=22',
    )
    expect(found.map((d) => d.subject)).toEqual(['.node-version', '.nvmrc'])
    expect(found[1]).toEqual({
      code: 'NODE_VERSION_OUT_OF_RANGE',
      severity: 'warning',
      category: 'runtime',
      message: '.nvmrc pins Node.js 20, which does not satisfy engines.node ">=22" in package.json',
      hint: 'Use a version matching ">=22" in .nvmrc, or update engines.node',
      files: ['.nvmrc', 'package.json'],
      subject: '.nvmrc',
    })
  })

  it('skips invalid ranges', () => {
    expect(findNodeOutOfRange([{ file: '.nvmrc', version: '20', major: 20 }], 'whatever')).toEqual([])
  })

  it('reads the range through the rule and does nothing without engines.node', async () => {
    const sections = makeSections({ runtimes: [nodeRuntime([exact('.nvmrc', '20')])] })
    const withRange = await projectContext({ 'package.json': JSON.stringify({ engines: { node: '>=22' } }) })
    expect(await runCheck(nodeVersionOutOfRange, sections, withRange)).toHaveLength(1)
    const withoutRange = await projectContext({ 'package.json': '{}' })
    expect(await runCheck(nodeVersionOutOfRange, sections, withoutRange)).toEqual([])
  })

  it('is skipped when no engines.node is declared', async () => {
    const pinOnly = makeSections({ runtimes: [nodeRuntime([exact('.nvmrc', '20')])] })
    expect((await runRule(nodeVersionOutOfRange, pinOnly)).checks[0]?.status).toBe('skipped')
    const withEngines = makeSections({
      runtimes: [nodeRuntime([exact('.nvmrc', '22'), range('package.json', '>=22')])],
    })
    const ctx = await projectContext({ 'package.json': JSON.stringify({ engines: { node: '>=22' } }) })
    expect((await runRule(nodeVersionOutOfRange, withEngines, ctx)).checks[0]?.status).toBe('passed')
  })
})

describe('RUNTIME_EOL', () => {
  const at = (iso: string) => new Date(`${iso}T00:00:00Z`)

  it('has an end-of-life date for every release line from 10 to 26', () => {
    expect(Object.keys(NODE_EOL).map(Number)).toEqual([10, 12, 14, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26])
  })

  it('reports each end-of-life major once with the files pinning it', () => {
    const found = findEndOfLife(
      [
        { file: '.node-version', version: '18.20.4', major: 18 },
        { file: '.nvmrc', version: '20', major: 20 },
        { file: 'Dockerfile', version: '20', major: 20 },
        { file: 'ci.yml', version: '22', major: 22 },
        { file: 'x', version: '25', major: 25 },
        { file: 'y', version: '27', major: 27 },
      ],
      at('2026-09-01'),
    )
    expect(found.map((d) => d.subject)).toEqual(['node@18', 'node@20', 'node@25'])
    expect(found[1]).toEqual({
      code: 'RUNTIME_EOL',
      severity: 'warning',
      category: 'runtime',
      message: 'Node.js 20 reached end-of-life on 2026-04-30 (pinned in .nvmrc and Dockerfile)',
      hint: 'Upgrade to a supported LTS release (Node.js 22 or 24)',
      files: ['.nvmrc', 'Dockerfile'],
      subject: 'node@20',
    })
  })

  it('switches exactly on the end-of-life date', () => {
    const pins = [{ file: '.nvmrc', version: '20', major: 20 }]
    expect(findEndOfLife(pins, at('2026-04-29'))).toEqual([])
    expect(findEndOfLife(pins, at('2026-04-30'))).toHaveLength(1)
  })

  it('suggests only LTS lines that are active at the reference date', () => {
    expect(supportedLtsMajors(at('2026-09-01'))).toEqual([22, 24])
    expect(supportedLtsMajors(at('2026-11-15'))).toEqual([22, 24, 26])
    expect(supportedLtsMajors(at('2030-01-01'))).toEqual([])
  })

  it('uses ctx.options.now', async () => {
    const sections = makeSections({ runtimes: [nodeRuntime([exact('.nvmrc', '22')])] })
    const before = await projectContext({}, { now: new Date('2026-09-01') })
    expect(await runCheck(runtimeEol, sections, before)).toEqual([])
    const after = await projectContext({}, { now: new Date('2027-05-01') })
    expect((await runCheck(runtimeEol, sections, after)).map((d) => d.subject)).toEqual(['node@22'])
  })
})

describe('Go versions', () => {
  it('parses and compares Go versions', () => {
    expect(parseGoVersion('1.25.1')).toEqual({ major: 1, minor: 25, patch: 1 })
    expect(parseGoVersion('go1.24')).toEqual({ major: 1, minor: 24 })
    expect(parseGoVersion('1')).toBeNull()
    expect(isGoToolchainOlder('1.24', '1.25.1')).toBe(true)
    expect(isGoToolchainOlder('1.25', '1.25.1')).toBe(false)
    expect(isGoToolchainOlder('1.25.0', '1.25.1')).toBe(true)
    expect(isGoToolchainOlder('1.26', '1.25')).toBe(false)
    expect(isGoToolchainOlder('stable', '1.25')).toBe(false)
  })

  it('collects golang base images and CI setup-go versions', () => {
    const go: Runtime = {
      id: 'go',
      name: 'Go',
      version: '1.25',
      sources: [
        exact('go.mod', '1.25.1', 'go directive'),
        exact('.github/workflows/ci.yml', '1.23', 'setup-go'),
        exact('Dockerfile', '1.24', 'FROM'),
      ],
    }
    const tools = goToolVersions({
      runtimes: [go],
      services: {
        composeFiles: [],
        services: [],
        dockerfiles: [
          { path: 'Dockerfile', baseImages: ['golang:1.24-alpine', 'alpine:3.22'], stages: 2, exposes: [], args: [] },
          {
            path: 'build/Containerfile',
            baseImages: ['docker.io/library/golang:1.22.5@sha256:abc'],
            stages: 1,
            exposes: [],
            args: [],
          },
        ],
      },
    })
    expect(tools).toEqual([
      { file: '.github/workflows/ci.yml', version: '1.23', kind: 'ci' },
      { file: 'Dockerfile', version: '1.24', kind: 'docker' },
      { file: 'build/Containerfile', version: '1.22.5', kind: 'docker' },
    ])
  })

  it('reports toolchains older than the go directive of the module they build', () => {
    const found = findGoVersionConflicts(
      [
        { file: 'Dockerfile', version: '1.24', kind: 'docker' },
        { file: '.github/workflows/ci.yml', version: '1.23', kind: 'ci' },
        { file: 'Dockerfile.dev', version: '1.25', kind: 'docker' },
      ],
      [{ dir: '.', file: 'go.mod', goVersion: '1.25.1' }],
    )
    expect(found.map((d) => d.subject)).toEqual(['Dockerfile', '.github/workflows/ci.yml'])
    expect(found[0]).toEqual({
      code: 'GO_VERSION_CONFLICT',
      severity: 'warning',
      category: 'runtime',
      message:
        'Dockerfile builds with Go 1.24, but go.mod requires go 1.25.1, and the official golang image sets GOTOOLCHAIN=local so the build fails',
      hint: 'Use golang:1.25.1 or newer in Dockerfile',
      files: ['Dockerfile', 'go.mod'],
      subject: 'Dockerfile',
    })
    expect(found[1]?.hint).toBe('Set go-version to 1.25.1 or newer, or use go-version-file: go.mod')
  })

  it('compares against the module that contains the file, and skips ambiguous files', () => {
    const modules = [
      { dir: 'services/api', file: 'services/api/go.mod', goVersion: '1.25' },
      { dir: 'services/worker', file: 'services/worker/go.mod', goVersion: '1.22' },
    ]
    const found = findGoVersionConflicts(
      [
        { file: 'services/api/Dockerfile', version: '1.24', kind: 'docker' },
        { file: 'services/worker/Dockerfile', version: '1.24', kind: 'docker' },
        { file: '.github/workflows/ci.yml', version: '1.20', kind: 'ci' },
      ],
      modules,
    )
    expect(found.map((d) => d.subject)).toEqual(['services/api/Dockerfile'])
  })

  it('reads go.mod through the rule', async () => {
    const sections = makeSections({
      services: {
        composeFiles: [],
        services: [],
        dockerfiles: [{ path: 'Dockerfile', baseImages: ['golang:1.24'], stages: 1, exposes: [], args: [] }],
      },
    })
    const ctx = await projectContext({ 'go.mod': 'module example.com/app\n\ngo 1.25.1\n' })
    expect((await runCheck(goVersionConflict, sections, ctx)).map((d) => d.code)).toEqual(['GO_VERSION_CONFLICT'])
    expect((await runRule(goVersionConflict, makeSections())).checks[0]?.status).toBe('skipped')
  })
})
