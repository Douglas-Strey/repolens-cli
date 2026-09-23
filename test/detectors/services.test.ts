// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Compose and Dockerfile ${VAR} interpolation is the syntax under test
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { imageRepository, recognizeImage } from '../../src/detectors/knowledge/images.ts'
import {
  environmentNames,
  mergeServices,
  parseComposeService,
  parseComposeServices,
  parsePort,
  servicesDetector,
} from '../../src/detectors/services.ts'
import { composeFileRole, findComposeFiles } from '../../src/facts/compose.ts'
import {
  dockerInstructions,
  findDockerfiles,
  isDockerfileName,
  MAX_ARG_EXPANSION,
  MAX_DOCKERFILE_EXPANSION,
  parseDockerfile as parseDockerfileStages,
  redactInterpolation,
  substituteArgs,
} from '../../src/facts/docker.ts'
import type { Service, ServicesSection } from '../../src/types.ts'
import { canSymlink, contextFor, fixtureContext, makeProject, SECRET_SENTINEL, timeBudget } from '../helpers.ts'

async function servicesOf(dir: string): Promise<{ section: ServicesSection; warnings: readonly unknown[] }> {
  const ctx = await contextFor(dir)
  const section = await ctx.use(servicesDetector)
  return { section, warnings: ctx.warnings }
}

function byName(section: ServicesSection, name: string): Service {
  const service = section.services.find((s) => s.name === name)
  if (!service) throw new Error(`service ${name} not found`)
  return service
}

/** Built at runtime so no credential-shaped literal is committed. */
const GITHUB_TOKEN = `ghp_${'d'.repeat(36)}`

/** Hostile inputs must be handled in linear time. The old quadratic code took minutes at these sizes. */
function expectFast(fn: () => unknown, ms = 2_000): void {
  const start = performance.now()
  fn()
  expect(performance.now() - start).toBeLessThan(timeBudget(ms))
}

const MIB = 1024 * 1024

/** A parsed Dockerfile the way the services section lists it. */
function parseDockerfile(text: string) {
  const parsed = parseDockerfileStages(text)
  return {
    baseImages: parsed.stages.map((stage) => stage.image),
    stages: parsed.stages.length,
    exposes: parsed.exposes,
    args: parsed.args,
  }
}

describe('parsePort', () => {
  it('parses a container-only port (string and number)', () => {
    expect(parsePort('3000')).toEqual([{ host: null, container: 3000, protocol: 'tcp', raw: '3000' }])
    expect(parsePort(3000)).toEqual([{ host: null, container: 3000, protocol: 'tcp', raw: '3000' }])
  })

  it('parses host:container', () => {
    expect(parsePort('3000:3000')).toEqual([{ host: 3000, container: 3000, protocol: 'tcp', raw: '3000:3000' }])
    expect(parsePort(' 8080:80 ')).toEqual([{ host: 8080, container: 80, protocol: 'tcp', raw: '8080:80' }])
  })

  it('parses an IPv4 host binding', () => {
    expect(parsePort('127.0.0.1:5432:5432')).toEqual([
      { host: 5432, container: 5432, protocol: 'tcp', hostIp: '127.0.0.1', raw: '127.0.0.1:5432:5432' },
    ])
  })

  it('parses a bracketed IPv6 host binding', () => {
    expect(parsePort('[::1]:6001:6001')).toEqual([
      { host: 6001, container: 6001, protocol: 'tcp', hostIp: '::1', raw: '[::1]:6001:6001' },
    ])
  })

  it('parses an explicit protocol', () => {
    expect(parsePort('5432:5432/udp')).toEqual([{ host: 5432, container: 5432, protocol: 'udp', raw: '5432:5432/udp' }])
    expect(parsePort('53/UDP')).toEqual([{ host: null, container: 53, protocol: 'udp', raw: '53/UDP' }])
  })

  it('keeps ranges as strings', () => {
    expect(parsePort('8000-8002:8000-8002')).toEqual([
      { host: '8000-8002', container: '8000-8002', protocol: 'tcp', raw: '8000-8002:8000-8002' },
    ])
  })

  it('keeps interpolated host ports as written', () => {
    expect(parsePort('${PORT:-3000}:3000')).toEqual([
      { host: '${PORT:-3000}', container: 3000, protocol: 'tcp', raw: '${PORT:-3000}:3000' },
    ])
    expect(parsePort('${HOST_IP}:${PORT}:80')).toEqual([
      { host: '${PORT}', container: 80, protocol: 'tcp', hostIp: '${HOST_IP}', raw: '${HOST_IP}:${PORT}:80' },
    ])
  })

  it('parses a host IP with an empty (random) host port', () => {
    expect(parsePort('127.0.0.1::5000')).toEqual([
      { host: null, container: 5000, protocol: 'tcp', hostIp: '127.0.0.1', raw: '127.0.0.1::5000' },
    ])
  })

  it('parses the long syntax and rebuilds a comparable raw form', () => {
    expect(parsePort({ target: 9229, published: '9230', protocol: 'tcp' })).toEqual([
      { host: 9230, container: 9229, protocol: 'tcp', raw: '9230:9229' },
    ])
    expect(parsePort({ target: 80, published: 8080, host_ip: '127.0.0.1', protocol: 'udp', mode: 'host' })).toEqual([
      { host: 8080, container: 80, protocol: 'udp', hostIp: '127.0.0.1', raw: '127.0.0.1:8080:80/udp' },
    ])
    expect(parsePort({ target: '3000' })).toEqual([{ host: null, container: 3000, protocol: 'tcp', raw: '3000' }])
    expect(parsePort({ target: 80, published: '8000-8001', host_ip: '::1' })).toEqual([
      { host: '8000-8001', container: 80, protocol: 'tcp', hostIp: '::1', raw: '[::1]:8000-8001:80' },
    ])
  })

  it('returns [] for invalid entries', () => {
    for (const entry of [
      null,
      undefined,
      true,
      '',
      '   ',
      'abc',
      'web:80',
      -1,
      1.5,
      [],
      {},
      { published: 80 },
      { target: 'x' },
      { target: 80, protocol: 'tcp; rm -rf /' },
      { target: 80, protocol: GITHUB_TOKEN },
    ]) {
      expect(parsePort(entry)).toEqual([])
    }
  })

  it('redacts secrets echoed through interpolated or long-syntax ports', () => {
    const [short] = parsePort(`\${API_TOKEN:-${GITHUB_TOKEN}}:80`)
    expect(short).toEqual({ host: '${API_TOKEN:-***}', container: 80, protocol: 'tcp', raw: '${API_TOKEN:-***}:80' })
    const [long] = parsePort({ target: 80, published: `\${P:-${GITHUB_TOKEN}}`, host_ip: GITHUB_TOKEN })
    expect(JSON.stringify(long)).not.toContain(GITHUB_TOKEN)
    // Numeric fallbacks are ports, even for a secret-looking name.
    expect(parsePort('${AUTH_PORT:-9000}:9000')[0]?.host).toBe('${AUTH_PORT:-9000}')
  })

  it('stays linear on hostile port strings', () => {
    expectFast(() => parsePort(`${'${A:-'.repeat(MIB / 5)}:80`))
    expectFast(() => parsePort(`${'{['.repeat(MIB / 2)}:80`))
  })
})

describe('redactInterpolation', () => {
  it('hides fallbacks of secret-looking variables only', () => {
    expect(redactInterpolation('${DB_PASSWORD:-hunter2}/x ${REGISTRY_TOKEN-abc} ${SECRET:?set it}')).toBe(
      '${DB_PASSWORD:-***}/x ${REGISTRY_TOKEN-***} ${SECRET:?***}',
    )
    expect(redactInterpolation('${TAG:-17-alpine} ${API_TOKEN} ${API_KEY:-} ${AUTH_PORT:-8000-8002}')).toBe(
      '${TAG:-17-alpine} ${API_TOKEN} ${API_KEY:-} ${AUTH_PORT:-8000-8002}',
    )
  })
})

describe('image recognition', () => {
  it('normalizes repository names', () => {
    expect(imageRepository('postgres:17-alpine')).toBe('postgres')
    expect(imageRepository('docker.io/library/postgres:17')).toBe('postgres')
    expect(imageRepository('library/redis')).toBe('redis')
    expect(imageRepository('docker.elastic.co/elasticsearch/elasticsearch:9.1.0')).toBe('elasticsearch/elasticsearch')
    expect(imageRepository('localhost:5000/team/api@sha256:abcdef')).toBe('team/api')
    expect(imageRepository('ghcr.io/Acme/Web:latest')).toBe('acme/web')
    expect(imageRepository('postgres@sha256:0123')).toBe('postgres')
    expect(imageRepository('postgres:${PG_VERSION:-17}')).toBe('postgres')
    expect(imageRepository('${REGISTRY}/postgres:17')).toBe('postgres')
    expect(imageRepository('${DB_IMAGE:-postgis/postgis:17-3.5}')).toBe('postgis/postgis')
  })

  it.each([
    ['postgres:17', 'postgresql', 'database'],
    ['postgis/postgis:17-3.5', 'postgresql', 'database'],
    ['timescale/timescaledb:latest-pg17', 'postgresql', 'database'],
    ['bitnami/postgresql:17', 'postgresql', 'database'],
    ['mysql:8.4', 'mysql', 'database'],
    ['mariadb:11', 'mariadb', 'database'],
    ['mongo:8', 'mongodb', 'database'],
    ['redis:8-alpine', 'redis', 'cache'],
    ['redis/redis-stack:latest', 'redis', 'cache'],
    ['bitnami/redis:7.4', 'redis', 'cache'],
    ['valkey/valkey:8', 'valkey', 'cache'],
    ['docker.dragonflydb.io/dragonflydb/dragonfly', 'dragonfly', 'cache'],
    ['memcached:1.6', 'memcached', 'cache'],
    ['cockroachdb/cockroach:v25.1.0', 'cockroachdb', 'database'],
    ['clickhouse/clickhouse-server:25.8', 'clickhouse', 'database'],
    ['mcr.microsoft.com/mssql/server:2022-latest', 'mssql', 'database'],
    ['rabbitmq:4-management', 'rabbitmq', 'queue'],
    ['apache/kafka:4.1.0', 'kafka', 'queue'],
    ['bitnami/kafka:3.9', 'kafka', 'queue'],
    ['confluentinc/cp-kafka:8.0.0', 'kafka', 'queue'],
    ['redpandadata/redpanda', 'redpanda', 'queue'],
    ['zookeeper:3.9', 'zookeeper', 'other'],
    ['docker.elastic.co/elasticsearch/elasticsearch:9.1.0', 'elasticsearch', 'search'],
    ['opensearchproject/opensearch:3', 'opensearch', 'search'],
    ['getmeili/meilisearch:v1.20', 'meilisearch', 'search'],
    ['minio/minio', 'minio', 'storage'],
    ['quay.io/minio/minio:latest', 'minio', 'storage'],
    ['mcr.microsoft.com/azure-storage/azurite', 'azurite', 'storage'],
    ['localstack/localstack:4', 'localstack', 'other'],
    ['axllent/mailpit:v1.27', 'mailpit', 'mail'],
    ['mailhog/mailhog', 'mailhog', 'mail'],
    ['maildev/maildev', 'maildev', 'mail'],
    ['nginx:1.29', 'nginx', 'proxy'],
    ['traefik:v3.5', 'traefik', 'proxy'],
    ['envoyproxy/envoy:v1.35-latest', 'envoy', 'proxy'],
    ['prom/prometheus', 'prometheus', 'observability'],
    ['grafana/grafana', 'grafana', 'observability'],
    ['jaegertracing/all-in-one:1.72', 'jaeger', 'observability'],
    ['otel/opentelemetry-collector-contrib:0.135.0', 'opentelemetry-collector', 'observability'],
    ['quay.io/keycloak/keycloak:26.3', 'keycloak', 'other'],
    ['temporalio/auto-setup:1.28', 'temporal', 'other'],
    ['dpage/pgadmin4', 'pgadmin', 'other'],
  ])('recognizes %s', (image, id, kind) => {
    expect(recognizeImage(image)).toMatchObject({ id, kind })
  })

  it('returns undefined for unknown or opaque images', () => {
    expect(recognizeImage('acme/api:1.2.3')).toBeUndefined()
    expect(recognizeImage('ghcr.io/acme/server')).toBeUndefined()
    expect(recognizeImage('temporalio/admin-tools')).toBeUndefined()
    expect(recognizeImage('${IMAGE}')).toBeUndefined()
    expect(recognizeImage('')).toBeUndefined()
  })

  it('stays linear on a flood of unterminated ${VAR:- defaults', () => {
    expectFast(() => expect(recognizeImage('${A:-'.repeat(MIB / 5))).toBeUndefined())
  })
})

describe('parseDockerfile', () => {
  it('parses a multi-stage build with stage references', () => {
    const parsed = parseDockerfile(
      [
        '# syntax=docker/dockerfile:1',
        'FROM --platform=$BUILDPLATFORM node:22-alpine AS deps',
        'ARG NPM_TOKEN',
        'RUN npm ci',
        'FROM deps AS build',
        'RUN npm run build',
        'from gcr.io/distroless/nodejs22-debian12 as runner',
        'EXPOSE 3000 9229/tcp',
        'EXPOSE 3000',
      ].join('\n'),
    )
    expect(parsed).toEqual({
      baseImages: ['node:22-alpine', 'deps', 'gcr.io/distroless/nodejs22-debian12'],
      stages: 3,
      exposes: ['3000', '9229/tcp'],
      args: ['NPM_TOKEN'],
    })
  })

  it('substitutes ARG defaults declared before the first FROM', () => {
    const parsed = parseDockerfile(
      [
        'ARG NODE_VERSION=22',
        'ARG BASE=node:${NODE_VERSION}-alpine',
        'ARG GO_VERSION',
        'FROM $BASE AS build',
        'ARG NODE_VERSION=18',
        'FROM golang:${GO_VERSION:-1.25} AS go',
        'FROM node:${NODE_VERSION}',
        'FROM alpine:${ALPINE_VERSION}',
      ].join('\n'),
    )
    // Redeclaring NODE_VERSION inside a stage does not affect FROM lines.
    expect(parsed.baseImages).toEqual(['node:22-alpine', 'golang:1.25', 'node:22', 'alpine:${ALPINE_VERSION}'])
    expect(parsed.args).toEqual(['BASE', 'GO_VERSION', 'NODE_VERSION'])
  })

  it('never substitutes ARGs with secret-looking names and never returns ARG values', () => {
    const value = `${SECRET_SENTINEL}_token`
    const parsed = parseDockerfile(
      [`ARG REGISTRY_TOKEN=${value}`, 'ARG TAG="22-alpine"', 'FROM node:${TAG}', 'RUN echo ${REGISTRY_TOKEN}'].join(
        '\n',
      ),
    )
    expect(parsed.baseImages).toEqual(['node:22-alpine'])
    expect(parsed.args).toEqual(['REGISTRY_TOKEN', 'TAG'])
    expect(JSON.stringify(parsed)).not.toContain(SECRET_SENTINEL)
    expect(substituteArgs('img:${REGISTRY_TOKEN}', new Map([['REGISTRY_TOKEN', value]]))).toBe('img:${REGISTRY_TOKEN}')
  })

  it('joins line continuations and skips comments inside them', () => {
    const parsed = parseDockerfile(
      [
        'FROM node:22 \\',
        '  # a comment in the middle',
        '  AS base',
        'ARG A=1 \\',
        '    B="two words" C',
        'EXPOSE \\',
        ' 80',
      ].join('\n'),
    )
    expect(parsed).toEqual({ baseImages: ['node:22'], stages: 1, exposes: ['80'], args: ['A', 'B', 'C'] })
  })

  it('honors the escape parser directive', () => {
    const parsed = parseDockerfile(
      ['# escape=`', 'FROM mcr.microsoft.com/windows/servercore:ltsc2022 `', '  AS base'].join('\r\n'),
    )
    expect(parsed.baseImages).toEqual(['mcr.microsoft.com/windows/servercore:ltsc2022'])
  })

  it('does not treat heredoc bodies as instructions', () => {
    const parsed = parseDockerfile(
      [
        'FROM alpine:3.22',
        'RUN <<EOF',
        'FROM not-an-image',
        'EXPOSE 1234',
        'EOF',
        'COPY <<-"A" <<B /x',
        'FROM nope',
        'A',
        'EXPOSE 9',
        'B',
        'EXPOSE 80',
      ].join('\n'),
    )
    expect(parsed).toEqual({ baseImages: ['alpine:3.22'], stages: 1, exposes: ['80'], args: [] })
  })

  it('handles empty, comment-only and malformed files', () => {
    expect(parseDockerfile('')).toEqual({ baseImages: [], stages: 0, exposes: [], args: [] })
    expect(parseDockerfile('# just a comment\n\n')).toEqual({ baseImages: [], stages: 0, exposes: [], args: [] })
    expect(parseDockerfile('FROM\nFROM --platform=linux/amd64\nARG 1BAD=x\nWHATEVER')).toEqual({
      baseImages: [],
      stages: 0,
      exposes: [],
      args: [],
    })
    expect(dockerInstructions('\uFEFFFROM scratch')).toEqual([{ keyword: 'FROM', args: 'scratch' }])
  })

  it('substituteArgs supports the documented operators', () => {
    const args = new Map([
      ['SET', 'value'],
      ['EMPTY', ''],
    ])
    expect(substituteArgs('$SET ${SET} ${SET:-d} ${SET:+alt}', args)).toBe('value value value alt')
    expect(substituteArgs('${EMPTY:-d} ${EMPTY:+alt}|', args)).toBe('d |')
    expect(substituteArgs('${UNKNOWN:-d} ${UNKNOWN} $UNKNOWN ${UNKNOWN:+alt}', args)).toBe(
      'd ${UNKNOWN} $UNKNOWN ${UNKNOWN:+alt}',
    )
  })

  it('bounds self-referencing ARG chains instead of doubling until the string limit throws', () => {
    const text = [
      'ARG A=x',
      ...Array.from({ length: 60 }, () => 'ARG A=$A$A'),
      'FROM $A AS doubled',
      'FROM $A$A$A',
    ].join('\n')
    const parsed = parseDockerfile(text)
    expect(parsed.stages).toBe(2)
    expect(parsed.args).toEqual(['A'])
    expect(parsed.baseImages.join('').length).toBeLessThanOrEqual(MAX_DOCKERFILE_EXPANSION + 10)
    const big = 'y'.repeat(MAX_ARG_EXPANSION + 1)
    expect(
      substituteArgs(
        '$BIG:${SMALL}',
        new Map([
          ['BIG', big],
          ['SMALL', 's'],
        ]),
      ),
    ).toBe('$BIG:s')
  })

  it('bounds ARG expansion across the whole Dockerfile, not per FROM line', () => {
    const long = `registry.example.com/${'a'.repeat(400)}`
    const parsed = parseDockerfile(
      [`ARG IMAGE=${long}`, ...Array.from({ length: 5_000 }, () => 'FROM $IMAGE')].join('\n'),
    )
    expect(parsed.stages).toBe(5_000)
    expect(parsed.baseImages.slice(0, 2)).toEqual([long, long])
    expect(parsed.baseImages.at(-1)).toBe('$IMAGE')
    expect(parsed.baseImages.join('').length).toBeLessThanOrEqual(MAX_DOCKERFILE_EXPANSION + 5_000 * '$IMAGE'.length)
  })

  it('stays linear on hostile Dockerfiles', () => {
    expectFast(() => parseDockerfile(`FROM ${'${A:-'.repeat(MIB / 5)}`))
    expectFast(() => parseDockerfile(`FROM a\nRUN ${'<<A '.repeat(MIB / 8)}\n${'A\n'.repeat(MIB / 8)}EXPOSE 80`))
    expectFast(() => parseDockerfile(`${'ARG A=$A$A$A$A\n'.repeat(MIB / 16)}FROM $A`))
    const heredocs = parseDockerfile(`FROM a\nRUN ${'<<A '.repeat(1000)}\n${'A\n'.repeat(1000)}EXPOSE 80`)
    expect(heredocs).toEqual({ baseImages: ['a'], stages: 1, exposes: ['80'], args: [] })
  })
})

describe('compose file discovery', () => {
  it('classifies compose file names', () => {
    expect(composeFileRole('compose.yaml')).toBe('base')
    expect(composeFileRole('docker/docker-compose.yml')).toBe('base')
    expect(composeFileRole('compose.override.yml')).toBe('override')
    expect(composeFileRole('docker-compose.override.yaml')).toBe('override')
    expect(composeFileRole('docker-compose.prod.yml')).toBe('variant')
    expect(composeFileRole('compose.dev.local.yaml')).toBe('variant')
    expect(composeFileRole('compose.json')).toBeNull()
    expect(composeFileRole('my-compose.yml')).toBeNull()
    expect(composeFileRole('docker-compose.yml.bak')).toBeNull()
  })

  it('orders base files, overrides and variants per directory, root first, and limits depth', () => {
    const files = [
      'docker/compose.yaml',
      'docker-compose.prod.yml',
      'docker-compose.override.yml',
      'compose.yml',
      'compose.yaml',
      'a/b/compose.yaml',
      'a/b/c/compose.yaml',
      '.devcontainer/docker-compose.yml',
      'examples/demo/compose.yaml',
      'test/fixtures/compose.yaml',
      'src/compose.ts',
    ]
    expect(findComposeFiles(files)).toEqual([
      'compose.yaml',
      'compose.yml',
      'docker-compose.override.yml',
      'docker-compose.prod.yml',
      '.devcontainer/docker-compose.yml',
      'a/b/compose.yaml',
      'docker/compose.yaml',
    ])
  })

  it('recognizes Dockerfile names', () => {
    for (const name of [
      'Dockerfile',
      'Dockerfile.dev',
      'api.Dockerfile',
      'web.dockerfile',
      'Containerfile',
      'dockerfile',
    ]) {
      expect(isDockerfileName(name)).toBe(true)
    }
    for (const name of ['Dockerfile.dockerignore', '.dockerignore', 'Dockerfiles', 'docker-compose.yml', 'README.md']) {
      expect(isDockerfileName(name)).toBe(false)
    }
    expect(
      findDockerfiles(['b/Dockerfile', 'Dockerfile', 'a/b/c/d/Dockerfile', 'a/b/c/d/e/Dockerfile', 'tests/Dockerfile']),
    ).toEqual(['Dockerfile', 'a/b/c/d/Dockerfile', 'b/Dockerfile'])
  })
})

describe('compose services', () => {
  it('keeps only environment variable names (list and map forms)', () => {
    expect(
      environmentNames([`B=${SECRET_SENTINEL}`, 'A', ' C = x ', 'not a name=1', 42, `=${SECRET_SENTINEL}`]),
    ).toEqual(['A', 'B', 'C'])
    expect(environmentNames({ Z: SECRET_SENTINEL, A: null, 'bad name': 'x' })).toEqual(['A', 'Z'])
    expect(environmentNames('KEY=value')).toEqual([])
    expect(environmentNames(null)).toEqual([])
  })

  it('parses every supported field', () => {
    const service = parseComposeService(
      'api',
      {
        image: 'ghcr.io/acme/api:1.0',
        build: { context: './api', dockerfile: 'Dockerfile.dev' },
        ports: ['3000:3000', '3000:3000', { target: 9229 }, 'garbage'],
        expose: ['4000', 4001],
        depends_on: { redis: { condition: 'service_started' }, db: { condition: 'service_healthy' } },
        volumes: [
          './src:/app/src',
          { type: 'volume', source: 'data', target: '/data' },
          { type: 'tmpfs', target: '/tmp' },
          7,
        ],
        environment: { NODE_ENV: 'development', API_KEY: SECRET_SENTINEL },
        env_file: ['.env', { path: '.env.local', required: false }],
        profiles: ['debug', 'api'],
        healthcheck: { test: ['CMD', 'true'] },
      },
      'compose.yaml',
    )
    expect(service).toEqual({
      name: 'api',
      source: 'compose.yaml',
      image: 'ghcr.io/acme/api:1.0',
      build: './api',
      dockerfile: 'Dockerfile.dev',
      kind: 'app',
      ports: [
        { host: 3000, container: 3000, protocol: 'tcp', raw: '3000:3000' },
        { host: null, container: 9229, protocol: 'tcp', raw: '9229' },
      ],
      expose: ['4000', '4001'],
      dependsOn: ['db', 'redis'],
      volumes: ['./src:/app/src', 'data:/data', '/tmp'],
      environment: ['API_KEY', 'NODE_ENV'],
      envFiles: ['.env', '.env.local'],
      profiles: ['api', 'debug'],
      healthcheck: true,
    })
    expect(JSON.stringify(service)).not.toContain(SECRET_SENTINEL)
  })

  it('classifies services by image, then by build', () => {
    expect(parseComposeService('db', { image: 'postgres:17', build: './db' }, 'compose.yaml')).toMatchObject({
      technology: { id: 'postgresql', name: 'PostgreSQL' },
      kind: 'database',
    })
    expect(parseComposeService('web', { build: '.' }, 'compose.yaml')).toMatchObject({ build: '.', kind: 'app' })
    expect(parseComposeService('web', { build: {} }, 'compose.yaml')).toMatchObject({ build: '.', kind: 'app' })
    const other = parseComposeService('x', { image: 'acme/thing' }, 'compose.yaml')
    expect(other.kind).toBe('other')
    expect(other).not.toHaveProperty('technology')
    expect(parseComposeService('y', {}, 'compose.yaml')).toMatchObject({ kind: 'other', ports: [], healthcheck: false })
  })

  it('treats disabled healthchecks as absent', () => {
    expect(parseComposeService('a', { healthcheck: { disable: true } }, 'c.yml').healthcheck).toBe(false)
    expect(parseComposeService('a', { healthcheck: { test: ['NONE'] } }, 'c.yml').healthcheck).toBe(false)
    expect(parseComposeService('a', { healthcheck: 'yes' }, 'c.yml').healthcheck).toBe(false)
    expect(parseComposeService('a', { healthcheck: {} }, 'c.yml').healthcheck).toBe(true)
  })

  it('redacts secret-looking interpolation fallbacks and credential formats in echoed fields', () => {
    const service = parseComposeService(
      'app',
      {
        image: `\${REGISTRY_PASSWORD:-${SECRET_SENTINEL}}/acme/app:1`,
        expose: [GITHUB_TOKEN],
        volumes: [`\${DB_PASSWORD:-${SECRET_SENTINEL}}:/data`],
        env_file: [`\${ENV_TOKEN:-${SECRET_SENTINEL}}.env`],
      },
      'compose.yaml',
    )
    const json = JSON.stringify(service)
    expect(json).not.toContain(SECRET_SENTINEL)
    expect(json).not.toContain(GITHUB_TOKEN)
    expect(service).toMatchObject({
      image: '${REGISTRY_PASSWORD:-***}/acme/app:1',
      volumes: ['${DB_PASSWORD:-***}:/data'],
      envFiles: ['${ENV_TOKEN:-***}.env'],
    })
  })

  it('removes control and bidi characters from echoed names and values', () => {
    const rlo = String.fromCharCode(0x202e)
    const bell = String.fromCharCode(7)
    const service = parseComposeService(
      `we${rlo}b`,
      { image: `nginx${rlo}:1.29`, profiles: [`de${bell}bug`], depends_on: [`d${rlo}b`], ports: [`80${rlo}:80`] },
      'compose.yaml',
    )
    expect(service).toMatchObject({ name: 'web', image: 'nginx:1.29', profiles: ['debug'], dependsOn: ['db'] })
    expect(JSON.stringify(service)).not.toContain(rlo)
  })

  it('strips credentials from Git build contexts', () => {
    const token = `ghp_${'a'.repeat(36)}`
    const service = parseComposeService(
      'app',
      { build: { context: `https://deploy:${token}@github.com/acme/app.git#main` } },
      'compose.yaml',
    )
    expect(service.build).toBe('https://github.com/acme/app.git')
    expect(JSON.stringify(service)).not.toContain(token)
  })

  it('ignores malformed documents and service definitions', () => {
    expect(parseComposeServices(null, 'compose.yaml')).toEqual([])
    expect(parseComposeServices('text', 'compose.yaml')).toEqual([])
    expect(parseComposeServices({ services: ['a', 'b'] }, 'compose.yaml')).toEqual([])
    expect(
      parseComposeServices(
        { services: { a: null, b: 'x', c: { image: 42, ports: 'nope', environment: 5 } } },
        'compose.yaml',
      ),
    ).toEqual([
      {
        name: 'c',
        source: 'compose.yaml',
        kind: 'other',
        ports: [],
        expose: [],
        dependsOn: [],
        volumes: [],
        environment: [],
        envFiles: [],
        profiles: [],
        healthcheck: false,
      },
    ])
  })

  it('merges same-named services per directory and keeps other directories separate', () => {
    const services = [
      ...parseComposeServices(
        { services: { web: { build: '.', ports: ['80:80'], environment: ['A=1'] }, db: { image: 'postgres:17' } } },
        'compose.yaml',
      ),
      ...parseComposeServices(
        {
          services: {
            web: {
              image: 'acme/web',
              ports: ['80:80', '9229:9229'],
              environment: { B: '2' },
              healthcheck: { test: 'x' },
            },
          },
        },
        'compose.override.yaml',
      ),
      ...parseComposeServices({ services: { web: { image: 'nginx' } } }, 'docker/compose.yaml'),
    ]
    const merged = mergeServices(services)
    expect(merged.map((s) => `${s.source}:${s.name}`)).toEqual([
      'compose.yaml:db',
      'compose.yaml:web',
      'docker/compose.yaml:web',
    ])
    expect(merged[1]).toMatchObject({
      source: 'compose.yaml',
      image: 'acme/web',
      build: '.',
      kind: 'app',
      ports: [
        { host: 80, container: 80, protocol: 'tcp', raw: '80:80' },
        { host: 9229, container: 9229, protocol: 'tcp', raw: '9229:9229' },
      ],
      environment: ['A', 'B'],
      healthcheck: true,
    })
    expect(merged[2]).toMatchObject({ source: 'docker/compose.yaml', kind: 'proxy', technology: { id: 'nginx' } })
  })

  it('keeps services of variant files separate instead of merging them into the default project', () => {
    const merged = mergeServices([
      ...parseComposeServices({ services: { app: { build: '.', ports: ['3000:3000'] } } }, 'compose.yaml'),
      ...parseComposeServices({ services: { app: { environment: ['DEBUG=1'] } } }, 'compose.override.yaml'),
      ...parseComposeServices({ services: { app: { image: 'acme/app', profiles: ['never'] } } }, 'compose.prod.yaml'),
    ])
    expect(merged.map((s) => [s.source, s.name, s.profiles, s.environment])).toEqual([
      ['compose.yaml', 'app', [], ['DEBUG']],
      ['compose.prod.yaml', 'app', ['never'], []],
    ])
    expect(merged[0]).toMatchObject({ build: '.', kind: 'app' })
    expect(merged[0]).not.toHaveProperty('image')
  })
})

describe('services detector on fixtures', () => {
  it('docker-project: merges the override and keeps only names', async () => {
    const ctx = await fixtureContext('docker-project')
    const section = await ctx.use(servicesDetector)
    expect(JSON.stringify(section)).not.toContain(SECRET_SENTINEL)
    expect(section.composeFiles).toEqual(['compose.yaml', 'docker-compose.override.yml'])
    expect(section.services.map((s) => s.name)).toEqual(['app', 'cache', 'db', 'mail', 'worker'])

    const app = byName(section, 'app')
    expect(app).toMatchObject({ source: 'compose.yaml', build: '.', dockerfile: 'Dockerfile', kind: 'app' })
    expect(app.ports.map((p) => p.raw)).toEqual(['3000:3000', '9229:9229'])
    expect(app.dependsOn).toEqual(['cache', 'db'])
    expect(app.environment).toEqual(['DATABASE_URL', 'NODE_ENV', 'SESSION_SECRET'])
    expect(app.envFiles).toEqual(['.env'])

    const db = byName(section, 'db')
    expect(db).toMatchObject({
      image: 'postgres:17-alpine',
      technology: { id: 'postgresql', name: 'PostgreSQL' },
      kind: 'database',
      environment: ['POSTGRES_DB', 'POSTGRES_PASSWORD', 'POSTGRES_USER'],
      volumes: ['db-data:/var/lib/postgresql/data'],
      healthcheck: true,
    })
    expect(byName(section, 'cache')).toMatchObject({
      technology: { id: 'redis' },
      kind: 'cache',
      ports: [{ host: 6379, container: 6379, protocol: 'tcp', hostIp: '127.0.0.1', raw: '127.0.0.1:6379:6379' }],
      healthcheck: false,
    })
    expect(byName(section, 'mail')).toMatchObject({ technology: { id: 'mailpit' }, kind: 'mail' })
    expect(byName(section, 'worker')).toMatchObject({
      kind: 'app',
      profiles: ['workers'],
      dependsOn: ['cache', 'db'],
      ports: [{ host: 9230, container: 9229, protocol: 'tcp', raw: '9230:9229' }],
    })

    expect(section.dockerfiles).toEqual([
      {
        path: 'Dockerfile',
        baseImages: ['node:22-alpine', 'node:22-alpine', 'node:22-alpine'],
        stages: 3,
        exposes: ['3000'],
        args: ['NPM_TOKEN'],
      },
    ])
  })

  it('monorepo: recognizes postgres, redis and minio', async () => {
    const ctx = await fixtureContext('monorepo')
    const section = await ctx.use(servicesDetector)
    expect(JSON.stringify(section)).not.toContain(SECRET_SENTINEL)
    expect(section.composeFiles).toEqual(['docker-compose.yml'])
    expect(section.services.map((s) => [s.name, s.technology?.id, s.kind])).toEqual([
      ['minio', 'minio', 'storage'],
      ['postgres', 'postgresql', 'database'],
      ['redis', 'redis', 'cache'],
    ])
    expect(byName(section, 'minio').ports.map((p) => p.host)).toEqual([9000, 9001])
    expect(byName(section, 'minio').environment).toEqual(['MINIO_ROOT_PASSWORD', 'MINIO_ROOT_USER'])
  })

  it('legacy-config: reports both services publishing host port 8080', async () => {
    const ctx = await fixtureContext('legacy-config')
    const section = await ctx.use(servicesDetector)
    const on8080 = section.services.filter((s) => s.ports.some((p) => p.host === 8080)).map((s) => s.name)
    expect(on8080).toEqual(['admin', 'web'])
    expect(byName(section, 'admin')).toMatchObject({ technology: { id: 'nginx' }, kind: 'proxy' })
    expect(byName(section, 'web')).toMatchObject({ build: '.', kind: 'app' })
    expect(section.dockerfiles).toEqual([
      { path: 'Dockerfile', baseImages: ['nginx:1.29-alpine'], stages: 1, exposes: ['80'], args: [] },
    ])
  })

  it('broken-config: survives an invalid compose file and records a warning', async () => {
    const ctx = await fixtureContext('broken-config')
    const section = await ctx.use(servicesDetector)
    expect(section.composeFiles).toEqual(['docker-compose.yml'])
    expect(section.services).toEqual([])
    expect(ctx.warnings).toContainEqual(expect.objectContaining({ file: 'docker-compose.yml' }))
    expect(JSON.stringify(section)).not.toContain(SECRET_SENTINEL)
    expect(JSON.stringify(ctx.warnings)).not.toContain(SECRET_SENTINEL)
  })

  it('go-api: parses the multi-stage Go Dockerfile', async () => {
    const ctx = await fixtureContext('go-api')
    const section = await ctx.use(servicesDetector)
    expect(section).toEqual({
      composeFiles: [],
      services: [],
      dockerfiles: [
        {
          path: 'Dockerfile',
          baseImages: ['golang:1.25-alpine', 'gcr.io/distroless/static-debian12'],
          stages: 2,
          exposes: ['8080'],
          args: [],
        },
      ],
    })
  })
})

describe('services detector on generated projects', () => {
  it('finds nested compose files and Dockerfiles, keeping directories separate', async () => {
    const dir = await makeProject({
      'compose.yaml': 'services:\n  web:\n    image: nginx\n',
      'compose.prod.yaml': 'services:\n  web:\n    ports: ["443:443"]\n',
      'docker/compose.yml': 'services:\n  web:\n    build: ..\n',
      'deploy/local/docker-compose.yml': 'services:\n  cache:\n    image: valkey/valkey:8\n',
      'deep/er/than/two/compose.yaml': 'services:\n  hidden:\n    image: redis\n',
      'examples/demo/compose.yaml': 'services:\n  demo:\n    image: redis\n',
      'services/api/Dockerfile': 'FROM node:22\n',
      'services/api/Dockerfile.dev': 'FROM node:22 AS dev\n',
      'worker.Dockerfile': 'FROM golang:1.25\n',
    })
    const { section } = await servicesOf(dir)
    expect(section.composeFiles).toEqual([
      'compose.yaml',
      'compose.prod.yaml',
      'deploy/local/docker-compose.yml',
      'docker/compose.yml',
    ])
    // compose.prod.yaml is used on its own with -f: its `web` is not merged into the default project's.
    expect(section.services.map((s) => `${s.source}:${s.name}:${s.kind}`)).toEqual([
      'compose.yaml:web:proxy',
      'compose.prod.yaml:web:other',
      'deploy/local/docker-compose.yml:cache:cache',
      'docker/compose.yml:web:app',
    ])
    expect(section.services[0]?.ports).toEqual([])
    expect(section.services[1]?.ports.map((p) => p.raw)).toEqual(['443:443'])
    expect(section.dockerfiles.map((d) => d.path)).toEqual([
      'services/api/Dockerfile',
      'services/api/Dockerfile.dev',
      'worker.Dockerfile',
    ])
  })

  it('never outputs environment values, even credential-shaped ones', async () => {
    const token = `ghp_${'b'.repeat(36)}`
    const dir = await makeProject({
      'docker-compose.yml': [
        'x-env: &env',
        `  SHARED_TOKEN: ${token}`,
        'services:',
        '  app:',
        '    image: acme/app',
        '    environment:',
        '      <<: *env',
        `      DB_PASSWORD: ${SECRET_SENTINEL}`,
        '  job:',
        '    image: acme/job',
        '    environment:',
        `      - GITHUB_TOKEN=${token}`,
        `      - "WEIRD=${SECRET_SENTINEL} with spaces"`,
        '      - PASSTHROUGH',
        '',
      ].join('\n'),
    })
    const { section } = await servicesOf(dir)
    const json = JSON.stringify(section)
    expect(json).not.toContain(token)
    expect(json).not.toContain(SECRET_SENTINEL)
    expect(section.services.find((s) => s.name === 'app')?.environment).toEqual(['DB_PASSWORD', 'SHARED_TOKEN'])
    expect(section.services.find((s) => s.name === 'job')?.environment).toEqual([
      'GITHUB_TOKEN',
      'PASSTHROUGH',
      'WEIRD',
    ])
  })

  it.skipIf(!canSymlink)(
    'skips an empty compose file and a Dockerfile that is a symlink escaping the root',
    async () => {
      const outside = await makeProject({ Dockerfile: 'FROM secret-outside-image\n' })
      const dir = await makeProject({ 'compose.yaml': '', 'app/placeholder.txt': 'x' })
      await fs.symlink(path.join(outside, 'Dockerfile'), path.join(dir, 'app', 'Dockerfile'))
      const { section } = await servicesOf(dir)
      expect(section.composeFiles).toEqual(['compose.yaml'])
      expect(section.services).toEqual([])
      expect(JSON.stringify(section)).not.toContain('secret-outside-image')
    },
  )

  it('keeps working when a Dockerfile would expand its ARGs without bound', async () => {
    const dir = await makeProject({
      'compose.yaml': 'services:\n  db:\n    image: postgres:17\n',
      Dockerfile: ['ARG A=x', ...Array.from({ length: 60 }, () => 'ARG A=$A$A'), 'FROM $A', 'EXPOSE 80'].join('\n'),
    })
    const { section } = await servicesOf(dir)
    expect(section.services.map((s) => s.name)).toEqual(['db'])
    expect(section.dockerfiles).toHaveLength(1)
    expect(section.dockerfiles[0]).toMatchObject({ path: 'Dockerfile', stages: 1, exposes: ['80'], args: ['A'] })
  })

  it('is deterministic', async () => {
    const dir = await makeProject({
      'compose.yaml': 'services:\n  b:\n    image: redis\n  a:\n    image: postgres\n    depends_on: [b]\n',
      'docker-compose.override.yml': 'services:\n  a:\n    ports: ["5432:5432"]\n',
      Dockerfile: 'FROM node:22\n',
    })
    const first = JSON.stringify((await servicesOf(dir)).section)
    const second = JSON.stringify((await servicesOf(dir)).section)
    expect(second).toBe(first)
  })
})
