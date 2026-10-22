// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Compose ${VAR} interpolation is the syntax under test
import { describe, expect, it } from 'vitest'
import { servicesDetector } from '../../src/detectors/services.ts'
import {
  composeFiles,
  composeReference,
  includedPaths,
  MAX_EXTENDS_DEPTH,
  MAX_REFERENCED_COMPOSE_FILES,
  mergeServiceDefinitions,
  rebaseServicePaths,
} from '../../src/facts/compose.ts'
import { composeUp } from '../../src/output/commands.ts'
import { contextFor, makeProject, scanDir } from '../helpers.ts'

async function services(files: Record<string, string>) {
  return (await contextFor(await makeProject(files))).use(servicesDetector)
}

describe('composeReference and includedPaths', () => {
  it('resolves paths against the Compose file and refuses what it cannot read', () => {
    expect(composeReference('docker/compose.yaml', 'db.yaml')).toBe('docker/db.yaml')
    expect(composeReference('docker/compose.yaml', '../infra/db.yaml')).toBe('infra/db.yaml')
    for (const raw of ['../../x.yaml', '/abs/x.yaml', 'C:\\x.yaml', '${DIR}/x.yaml', '~/x.yaml', 'oci://x', '']) {
      expect(composeReference('docker/compose.yaml', raw), raw).toBeNull()
    }
  })

  it('reads the short form and the long form, whose path may be a list', () => {
    const doc = {
      include: ['infra/db.yaml', { path: 'infra/cache.yaml' }, { path: ['a.yaml', 'b.yaml'] }, 'infra/db.yaml', 42],
    }
    expect(includedPaths('compose.yaml', doc)).toEqual(['infra/db.yaml', 'infra/cache.yaml', 'a.yaml', 'b.yaml'])
    expect(includedPaths('compose.yaml', { include: 'nope' })).toEqual([])
  })
})

describe('mergeServiceDefinitions', () => {
  it('follows the Compose merge rules', () => {
    const base = {
      image: 'node:22',
      ports: ['3000:3000'],
      environment: ['A=1', 'B'],
      env_file: '.env.base',
      depends_on: ['db'],
      build: { context: '.', dockerfile: 'Dockerfile' },
      profiles: ['dev'],
    }
    const own = {
      extends: { service: 'base' },
      image: 'node:24',
      ports: ['3000:3000', '9229:9229'],
      environment: { C: '3' },
      env_file: ['.env.own'],
      build: { dockerfile: 'Dockerfile.dev' },
    }
    expect(mergeServiceDefinitions(base, own)).toEqual({
      image: 'node:24',
      ports: ['3000:3000', '9229:9229'],
      environment: { A: '1', B: null, C: '3' },
      env_file: ['.env.base', '.env.own'],
      build: { context: '.', dockerfile: 'Dockerfile.dev' },
      profiles: ['dev'],
    })
  })

  it('keeps a "__proto__" key a plain key', () => {
    const merged = mergeServiceDefinitions(JSON.parse('{"__proto__": {"polluted": true}}'), { image: 'x' })
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('rebases build and env_file paths for another directory', () => {
    const definition = { build: '../app', env_file: ['.env', { path: 'x.env', required: false }, '${E}'], image: 'i' }
    expect(rebaseServicePaths(definition, 'common', 'deploy/local')).toEqual({
      build: '../../app',
      env_file: ['../../common/.env', { path: '../../common/x.env', required: false }, '${E}'],
      image: 'i',
    })
    expect(rebaseServicePaths({ build: { context: 'api' } }, 'common', '.')).toEqual({
      build: { context: 'common/api' },
    })
  })
})

describe('include', () => {
  it("adds an included file's services to the including file's project", async () => {
    const section = await services({
      'compose.yaml': 'include:\n  - infra/db.yaml\nservices:\n  app:\n    build: .\n    ports: ["3000:3000"]\n',
      'infra/db.yaml': 'services:\n  db:\n    image: postgres:17\n    env_file: db.env\n    ports: ["5432:5432"]\n',
    })
    expect(section.composeFiles).toEqual(['compose.yaml'])
    expect(section.services.map((s) => [s.name, s.source, s.includedFrom, s.envFiles])).toEqual([
      ['app', 'compose.yaml', undefined, []],
      ['db', 'infra/db.yaml', 'compose.yaml', ['db.env']],
    ])
  })

  it('follows nested includes, keeps the top-level file as the project and stops at cycles', async () => {
    const ctx = await contextFor(
      await makeProject({
        'compose.yaml': 'include: [a/one.yaml]\nservices:\n  app:\n    image: app\n',
        'a/one.yaml': 'include: [../b/two.yaml]\nservices:\n  one:\n    image: one\n',
        'b/two.yaml': 'include: [../a/one.yaml]\nservices:\n  two:\n    image: two\n',
      }),
    )
    const found = await ctx.use(composeFiles)
    expect(found.included.map((file) => file.path)).toEqual(['a/one.yaml', 'b/two.yaml'])
    expect(found.services.map((s) => [s.name, s.file, s.includedFrom])).toEqual([
      ['app', 'compose.yaml', undefined],
      ['one', 'a/one.yaml', 'compose.yaml'],
      ['two', 'b/two.yaml', 'compose.yaml'],
    ])
  })

  it('keeps the declared service when an included file reuses its name, but lets an override change it', async () => {
    const section = await services({
      'compose.yaml': 'include: [extra.yaml]\nservices:\n  db:\n    image: postgres:17\n',
      'extra.yaml': 'services:\n  db:\n    image: mysql:8\n  cache:\n    image: redis:7\n',
      'compose.override.yaml': 'services:\n  cache:\n    ports: ["6379:6379"]\n',
    })
    expect(section.services.map((s) => [s.name, s.image, s.ports.map((p) => p.raw)])).toEqual([
      ['cache', 'redis:7', ['6379:6379']],
      ['db', 'postgres:17', []],
    ])
  })

  it('never reads outside the project and stops at the file budget', async () => {
    const files: Record<string, string> = {
      'compose.yaml': `include:\n  - ../outside.yaml\n  - /etc/compose.yaml\n${Array.from(
        { length: MAX_REFERENCED_COMPOSE_FILES + 5 },
        (_, i) => `  - parts/p${i}.yaml\n`,
      ).join('')}`,
    }
    for (let i = 0; i < MAX_REFERENCED_COMPOSE_FILES + 5; i++)
      files[`parts/p${i}.yaml`] = `services:\n  s${i}:\n    image: x\n`
    const ctx = await contextFor(await makeProject(files))
    const found = await ctx.use(composeFiles)
    expect(found.included).toHaveLength(MAX_REFERENCED_COMPOSE_FILES)
    expect(found.services).toHaveLength(MAX_REFERENCED_COMPOSE_FILES)
  })

  it('reports a port clash between a service and an included one, and starts both', async () => {
    const dir = await makeProject({
      'compose.yaml': 'include: [infra/db.yaml]\nservices:\n  app:\n    build: .\n    ports: ["5432:5432"]\n',
      'infra/db.yaml': 'services:\n  db:\n    image: postgres:17\n    ports: ["5432:5432"]\n',
    })
    const result = await scanDir(dir)
    expect(result.doctor.diagnostics.filter((d) => d.code === 'DOCKER_PORT_CONFLICT').map((d) => d.files)).toEqual([
      ['compose.yaml', 'infra/db.yaml'],
    ])
    expect(composeUp(result)?.services).toEqual(['db'])
  })

  it('checks env_file entries and version keys of included files', async () => {
    const result = await scanDir(
      await makeProject({
        'compose.yaml': 'include: [infra/db.yaml]\nservices:\n  app:\n    image: app\n',
        'infra/db.yaml': 'version: "3"\nservices:\n  db:\n    image: postgres:17\n    env_file: db.env\n',
      }),
    )
    const found = result.doctor.diagnostics.filter((d) => d.code.startsWith('COMPOSE_'))
    expect(found.map((d) => [d.code, d.subject])).toEqual(
      expect.arrayContaining([
        ['COMPOSE_ENV_FILE_MISSING', 'infra/db.env'],
        ['COMPOSE_VERSION_OBSOLETE', 'infra/db.yaml'],
      ]),
    )
  })
})

describe('extends', () => {
  it('inherits from a service in the same file or another one, with its paths', async () => {
    const section = await services({
      'compose.yaml': [
        'services:',
        '  base:',
        '    image: node:22',
        '    environment: [NODE_ENV]',
        '  web:',
        '    extends: base',
        '    ports: ["3000:3000"]',
        '  worker:',
        '    extends: { file: common/services.yaml, service: job }',
        '    depends_on: [web]',
        '',
      ].join('\n'),
      'common/services.yaml':
        'services:\n  job:\n    build: ../app\n    env_file: job.env\n    environment: { QUEUE: jobs }\n    depends_on: [db]\n',
    })
    const byName = new Map(section.services.map((s) => [s.name, s]))
    expect(byName.get('web')).toMatchObject({
      image: 'node:22',
      environment: ['NODE_ENV'],
      ports: [{ raw: '3000:3000' }],
    })
    expect(byName.get('worker')).toMatchObject({
      source: 'compose.yaml',
      build: 'app',
      envFiles: ['common/job.env'],
      environment: ['QUEUE'],
      dependsOn: ['web'],
    })
    // The file named by extends is not part of the project: its services are not listed.
    expect(byName.has('job')).toBe(false)
  })

  it('follows chains, stops at cycles and at the depth limit', async () => {
    const chain = Array.from({ length: MAX_EXTENDS_DEPTH + 3 }, (_, i) =>
      i === 0 ? '  s0:\n    image: deep\n' : `  s${i}:\n    extends: s${i - 1}\n`,
    ).join('')
    const section = await services({
      'compose.yaml': `services:\n  a:\n    extends: b\n    image: a\n  b:\n    extends: a\n    expose: ["1"]\n${chain}`,
    })
    const byName = new Map(section.services.map((s) => [s.name, s]))
    expect(byName.get('a')).toMatchObject({ image: 'a', expose: ['1'] })
    expect(byName.get(`s${MAX_EXTENDS_DEPTH}`)?.image).toBe('deep')
    expect(byName.get(`s${MAX_EXTENDS_DEPTH + 2}`)?.image).toBeUndefined()
  })

  it('ignores an extends it cannot resolve', async () => {
    const section = await services({
      'compose.yaml':
        'services:\n  a:\n    extends: { file: ../x.yaml, service: s }\n    image: a\n  b:\n    extends: missing\n    image: b\n',
    })
    expect(section.services.map((s) => [s.name, s.image])).toEqual([
      ['a', 'a'],
      ['b', 'b'],
    ])
  })
})
