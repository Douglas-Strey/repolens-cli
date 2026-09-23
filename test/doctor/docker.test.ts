import { describe, expect, it } from 'vitest'
import {
  composeEnvFileMissing,
  composeVersionObsolete,
  dockerPortConflict,
  envPortMismatch,
  findEnvPortMismatches,
  findPortConflicts,
  hasObsoleteVersionKey,
  ipsOverlap,
  isKnownMissing,
  numericPort,
} from '../../src/doctor/rules/docker.ts'
import { composeFiles, envFileReferences } from '../../src/facts/compose.ts'
import type { ServicesSection } from '../../src/types.ts'
import {
  environment,
  envVar,
  expectWellFormed,
  makeSections,
  port,
  projectContext,
  runCheck,
  runRule,
  SECRET_SENTINEL,
  service,
} from './support.ts'

const postgres = { id: 'postgresql', name: 'PostgreSQL' }

/** Compose interpolation such as ${PORT}, built without a literal placeholder in a plain string. */
const interpolated = (expression: string) => `\${${expression}}`

describe('port helpers', () => {
  it('only treats literal ports as numbers', () => {
    expect(numericPort(8080)).toBe(8080)
    expect(numericPort('8080')).toBe(8080)
    expect(numericPort(interpolated('PORT:-3000'))).toBeNull()
    expect(numericPort('8000-8010')).toBeNull()
    expect(numericPort(null)).toBeNull()
  })

  it('treats unspecified and wildcard host IPs as overlapping everything', () => {
    expect(ipsOverlap(undefined, '127.0.0.1')).toBe(true)
    expect(ipsOverlap('0.0.0.0', '127.0.0.1')).toBe(true)
    expect(ipsOverlap('[::]', '127.0.0.1')).toBe(true)
    expect(ipsOverlap('127.0.0.1', '127.0.0.1')).toBe(true)
    expect(ipsOverlap('127.0.0.1', '127.0.0.2')).toBe(false)
  })
})

describe('DOCKER_PORT_CONFLICT', () => {
  it('reports two services publishing the same host port', () => {
    const found = findPortConflicts([
      service('web', { ports: [port(8080, 80)] }),
      service('admin', { ports: [port(8080, 8080)] }),
    ])
    expect(found).toEqual([
      {
        code: 'DOCKER_PORT_CONFLICT',
        severity: 'error',
        category: 'docker',
        message: 'Services admin and web in docker-compose.yml both publish host port 8080',
        hint: 'Give each service its own host port, e.g. "8081:80", or only one of them can start',
        files: ['docker-compose.yml'],
        subject: '8080/tcp',
      },
    ])
  })

  it('is a warning when a profiled service is involved', () => {
    const found = findPortConflicts([
      service('app', { ports: [port(9229, 9229)] }),
      service('worker', { ports: [port(9229, 9229)], profiles: ['workers'] }),
    ])
    expect(found[0]?.severity).toBe('warning')
    expect(found[0]?.hint).toContain('worker is started with its profile')
  })

  it('lists all services sharing a port', () => {
    const found = findPortConflicts([
      service('a', { ports: [port(80)] }),
      service('b', { ports: [port(80)] }),
      service('c', { ports: [port(80)] }),
    ])
    expect(found[0]?.message).toBe('Services a, b and c in docker-compose.yml all publish host port 80')
  })

  it('ignores different IPs, protocols, interpolated ports and the same service across override files', () => {
    const found = findPortConflicts([
      service('a', { ports: [port(5432, 5432, { hostIp: '127.0.0.1' })] }),
      service('b', { ports: [port(5432, 5432, { hostIp: '127.0.0.2' })] }),
      service('dns', { ports: [port(53, 53, { protocol: 'udp' })] }),
      service('dns-tcp', { ports: [port(53, 53)] }),
      service('x', { ports: [port(interpolated('PORT'), 3000)] }),
      service('y', { ports: [port(interpolated('PORT'), 3000)] }),
      service('app', { ports: [port(3000, 3000)] }),
      service('app', { source: 'docker-compose.override.yml', ports: [port(3000, 3000)] }),
    ])
    expect(found).toEqual([])
  })

  it('reports a clash between a base file and its override', () => {
    const found = findPortConflicts([
      service('app', { source: 'compose.yaml', ports: [port(9229, 9229)] }),
      service('debugger', { source: 'compose.override.yaml', ports: [port(9229, 9229)] }),
    ])
    expect(found[0]?.files).toEqual(['compose.override.yaml', 'compose.yaml'])
    expect(found[0]?.message).toBe('Services app and debugger both publish host port 9229')
  })

  it('keeps one subject per Compose project when several projects clash on the same port', () => {
    const found = findPortConflicts([
      service('a', { source: 'docker-compose.yml', ports: [port(8080)] }),
      service('b', { source: 'docker-compose.yml', ports: [port(8080)] }),
      service('c', { source: 'services/api/compose.yaml', ports: [port(8080)] }),
      service('d', { source: 'services/api/compose.yaml', ports: [port(8080)] }),
    ])
    expect(found.map((d) => d.subject)).toEqual(['8080/tcp', 'services/api/compose.yaml:8080/tcp'])
  })

  it('treats other directories and alternative compose files as separate projects', () => {
    const found = findPortConflicts([
      service('web', { source: 'docker-compose.yml', ports: [port(8080)] }),
      service('api', { source: 'services/api/docker-compose.yml', ports: [port(8080)] }),
      service('prod-web', { source: 'docker-compose.prod.yml', ports: [port(8080)] }),
    ])
    expect(found).toEqual([])
  })

  it('is skipped with fewer than two publishing services', async () => {
    const services: ServicesSection = {
      composeFiles: [],
      services: [service('a', { ports: [port(1)] })],
      dockerfiles: [],
    }
    expect((await runRule(dockerPortConflict, makeSections({ services }))).checks[0]?.status).toBe('skipped')
  })
})

describe('COMPOSE_VERSION_OBSOLETE', () => {
  it('detects the top-level version key', () => {
    expect(hasObsoleteVersionKey({ version: '3.9', services: {} })).toBe(true)
    expect(hasObsoleteVersionKey({ services: { version: {} } })).toBe(false)
    expect(hasObsoleteVersionKey(null)).toBe(false)
    expect(hasObsoleteVersionKey(['version'])).toBe(false)
  })

  it('reads the project Compose files itself, even when the services section is empty', async () => {
    const ctx = await projectContext({
      'compose.yaml': 'version: "3.9"\nservices:\n  app:\n    image: nginx\n',
      'docker-compose.override.yml': 'services:\n  app:\n    ports: ["80:80"]\n',
      'docker/compose.yaml': 'version: "3"\n',
      'examples/demo/compose.yaml': 'version: "3"\n',
    })
    const found = await runCheck(composeVersionObsolete, makeSections(), ctx)
    expect(found[0]).toEqual({
      code: 'COMPOSE_VERSION_OBSOLETE',
      severity: 'info',
      category: 'docker',
      message: 'compose.yaml sets the obsolete top-level "version" key',
      hint: 'Remove the "version" line; Docker Compose ignores it and prints a warning on every run',
      files: ['compose.yaml'],
      subject: 'compose.yaml',
    })
    expect(found.map((d) => d.subject)).toEqual(['compose.yaml', 'docker/compose.yaml'])
  })

  it('survives malformed YAML', async () => {
    const ctx = await projectContext({ 'docker-compose.yml': 'services:\n  app: [\n' })
    expect(await runCheck(composeVersionObsolete, makeSections(), ctx)).toEqual([])
  })

  it('is skipped without Compose files, and when every Compose file failed to parse', async () => {
    const none = await runRule(composeVersionObsolete, makeSections(), await projectContext({ 'README.md': '# x\n' }))
    expect(none.checks[0]?.status).toBe('skipped')
    const broken = await projectContext({ 'docker-compose.yml': 'services:\n  app: [\n' })
    // In a scan, the services detector has parsed the Compose files before the doctor runs.
    await broken.use(composeFiles)
    expect((await runRule(composeVersionObsolete, makeSections(), broken)).checks[0]?.status).toBe('skipped')
    expect((await runRule(composeEnvFileMissing, makeSections(), broken)).checks[0]?.status).toBe('skipped')
    const fine = await projectContext({ 'compose.yaml': 'services:\n  app:\n    image: nginx\n' })
    expect((await runRule(composeVersionObsolete, makeSections(), fine)).checks[0]?.status).toBe('passed')
  })
})

describe('COMPOSE_ENV_FILE_MISSING', () => {
  it('resolves env_file entries relative to the compose file and skips optional or unsafe ones', () => {
    const doc = {
      services: {
        api: { env_file: '.env' },
        web: { env_file: ['./web.env', { path: 'optional.env', required: false }, { path: 'required.env' }] },
        bad: { env_file: [interpolated('ENV_FILE'), '/etc/app.env', 'C:\\app.env', '~/home.env', 42, null] },
        up: { env_file: '../shared.env' },
        weird: 'not a mapping',
      },
    }
    expect(envFileReferences('deploy/compose.yaml', doc).filter((reference) => reference.required)).toEqual([
      { composeFile: 'deploy/compose.yaml', service: 'api', path: 'deploy/.env', required: true },
      { composeFile: 'deploy/compose.yaml', service: 'web', path: 'deploy/web.env', required: true },
      { composeFile: 'deploy/compose.yaml', service: 'web', path: 'deploy/required.env', required: true },
      { composeFile: 'deploy/compose.yaml', service: 'up', path: 'shared.env', required: true },
    ])
    // From the root, "../" leaves the project.
    expect(envFileReferences('compose.yaml', { services: { up: { env_file: '../shared.env' } } })).toEqual([])
    expect(envFileReferences('compose.yaml', { services: [] })).toEqual([])
    expect(envFileReferences('compose.yaml', 'nope')).toEqual([])
  })

  it('reports a missing env_file with a copy hint and never leaks compose values', async () => {
    const ctx = await projectContext({
      '.gitignore': '.env\n',
      '.env.example': 'API_KEY=\n',
      'compose.yaml': [
        'services:',
        '  app:',
        '    image: node:22',
        '    env_file: .env',
        '    environment:',
        `      - SESSION_SECRET=${SECRET_SENTINEL}`,
        '  worker:',
        '    image: node:22',
        '    env_file: [.env]',
        '',
      ].join('\n'),
    })
    const found = await runCheck(composeEnvFileMissing, makeSections(), ctx)
    expect(found).toEqual([
      {
        code: 'COMPOSE_ENV_FILE_MISSING',
        severity: 'warning',
        category: 'docker',
        message: 'Services app and worker in compose.yaml load env_file .env, which does not exist',
        hint: 'Run `cp .env.example .env` and fill in the values, or mark the entry optional with required: false',
        files: ['compose.yaml'],
        subject: '.env',
      },
    ])
    expectWellFormed(found)
  })

  it('does not report files that exist (even when gitignored) or live in unwalked directories', async () => {
    const ctx = await projectContext({
      '.gitignore': '.env\nsecrets/\n',
      '.env': `TOKEN=${SECRET_SENTINEL}\n`,
      'secrets/app.env': 'X=1\n',
      'docker-compose.yml': 'services:\n  app:\n    env_file: [.env, secrets/app.env, node_modules/x.env]\n',
    })
    expect(await runCheck(composeEnvFileMissing, makeSections(), ctx)).toEqual([])
    expect(isKnownMissing(ctx.files, 'missing/dir/app.env', 20)).toBe(true)
    expect(isKnownMissing(ctx.files, 'secrets/other.env', 20)).toBe(false)
    expect(isKnownMissing(ctx.files, 'a/b/c.env', 1)).toBe(false)
  })

  it('reports a path referenced from several Compose files once', async () => {
    const ctx = await projectContext({
      'compose.yaml': 'services:\n  app:\n    env_file: app.env\n',
      'docker-compose.prod.yml': 'services:\n  api:\n    env_file: ./app.env\n',
    })
    const found = await runCheck(composeEnvFileMissing, makeSections(), ctx)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      message:
        'Services api (docker-compose.prod.yml) and app (compose.yaml) load env_file app.env, which does not exist',
      files: ['compose.yaml', 'docker-compose.prod.yml'],
      subject: 'app.env',
    })
  })

  it('does not report optional env_file entries', async () => {
    const ctx = await projectContext({
      'compose.yaml': 'services:\n  app:\n    env_file:\n      - path: optional.env\n        required: false\n',
    })
    expect(await runCheck(composeEnvFileMissing, makeSections(), ctx)).toEqual([])
  })

  it('suggests creating the file when there is no example', async () => {
    const ctx = await projectContext({ 'compose.yml': 'services:\n  db:\n    env_file: db.env\n' })
    expect((await runCheck(composeEnvFileMissing, makeSections(), ctx))[0]?.hint).toBe(
      'Create db.env, or mark the entry optional with required: false',
    )
  })
})

describe('ENV_PORT_MISMATCH', () => {
  const db = service('db', {
    technology: postgres,
    kind: 'database',
    source: 'compose.yaml',
    ports: [port(5432, 5432)],
  })
  const databaseUrl = (portNumber: number, overrides = {}) =>
    envVar('DATABASE_URL', {
      documented: true,
      endpoints: [{ file: '.env.example', scheme: 'postgres', port: portNumber, local: true, ...overrides }],
    })

  it('reports a local URL whose port no matching service publishes', () => {
    const found = findEnvPortMismatches(environment([], [databaseUrl(5433)]), [db])
    expect(found).toEqual([
      {
        code: 'ENV_PORT_MISMATCH',
        severity: 'warning',
        category: 'docker',
        message: 'DATABASE_URL in .env.example uses port 5433, but the db service publishes 5432',
        hint: 'Use port 5432 in .env.example, or publish 5433 from the db service in compose.yaml',
        files: ['.env.example', 'compose.yaml'],
        subject: 'DATABASE_URL',
      },
    ])
  })

  it('maps schemes to service technologies', () => {
    const mariadb = service('mariadb', { technology: { id: 'mariadb', name: 'MariaDB' }, ports: [port(3306, 3306)] })
    const url = envVar('DB_URL', { endpoints: [{ file: '.env', scheme: 'mysql', port: 3307, local: true }] })
    expect(findEnvPortMismatches(environment([], [url]), [mariadb])).toHaveLength(1)
    const valkey = service('cache', { technology: { id: 'valkey', name: 'Valkey' }, ports: [port(6380, 6379)] })
    const redis = envVar('REDIS_URL', { endpoints: [{ file: '.env', scheme: 'rediss', port: 6379, local: true }] })
    expect(findEnvPortMismatches(environment([], [redis]), [valkey])[0]?.message).toBe(
      'REDIS_URL in .env uses port 6379, but the cache service publishes 6380',
    )
  })

  it('does not report matching ports, remote hosts, unknown schemes or unknown ports', () => {
    expect(findEnvPortMismatches(environment([], [databaseUrl(5432)]), [db])).toEqual([])
    expect(findEnvPortMismatches(environment([], [databaseUrl(5433, { local: false })]), [db])).toEqual([])
    expect(findEnvPortMismatches(environment([], [databaseUrl(5433, { scheme: 'http' })]), [db])).toEqual([])
    const dynamicPort = service('db', { technology: postgres, ports: [port(interpolated('DB_PORT:-5432'), 5432)] })
    expect(findEnvPortMismatches(environment([], [databaseUrl(5433)]), [dynamicPort])).toEqual([])
    const unpublished = service('db', { technology: postgres, ports: [port(null, 5432)] })
    expect(findEnvPortMismatches(environment([], [databaseUrl(5433)]), [unpublished])).toEqual([])
  })

  it('accepts any of several services of the same technology', () => {
    const test = service('db-test', { technology: postgres, ports: [port(5433, 5432)] })
    expect(findEnvPortMismatches(environment([], [databaseUrl(5433)]), [db, test])).toEqual([])
  })

  it('applies only with published ports and URL-shaped variables', async () => {
    const services: ServicesSection = { composeFiles: ['compose.yaml'], services: [db], dockerfiles: [] }
    expect((await runRule(envPortMismatch, makeSections({ services }))).checks[0]?.status).toBe('skipped')
    const env = environment([], [databaseUrl(5433)])
    const result = await runRule(envPortMismatch, makeSections({ services, environment: env }))
    expect(result.checks[0]?.status).toBe('failed')
  })
})
