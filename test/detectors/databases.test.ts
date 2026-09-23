import { describe, expect, it } from 'vitest'
import {
  type DatabaseConfigs,
  type DatabaseInferenceInput,
  databaseFromEnvName,
  databasesDetector,
  displayRange,
  driverDatabase,
  extractDrizzleDialects,
  extractOrmconfigTypes,
  extractPrismaProviders,
  extractSqlcEngines,
  extractTypeormTypes,
  goModuleBase,
  inferDatabases,
  inferOrms,
  MAX_EVIDENCE,
  stripJsComments,
} from '../../src/detectors/databases.ts'
import { parseComposeService } from '../../src/detectors/services.ts'
import type { DependencyRef } from '../../src/facts/dependencies.ts'
import type { DatabasesSection, EnvVariable } from '../../src/types.ts'
import { contextFor, fixtureContext, makeProject, SECRET_SENTINEL, timeBudget } from '../helpers.ts'

const NO_CONFIGS: DatabaseConfigs = { prismaProviders: [], drizzleDialects: [], sqlcEngines: [], typeormTypes: [] }

function input(overrides: Partial<DatabaseInferenceInput> = {}): DatabaseInferenceInput {
  return { dependencies: [], services: [], envVariables: [], configs: NO_CONFIGS, ...overrides }
}

function nodeDep(name: string, range = '^1.0.0', overrides: Partial<DependencyRef> = {}): DependencyRef {
  return { name, range, type: 'dependencies', package: '.', file: 'package.json', ecosystem: 'node', ...overrides }
}

function goDep(name: string, range = 'v1.0.0', indirect = false): DependencyRef {
  return { name, range, type: 'go', package: '.', file: 'go.mod', ecosystem: 'go', indirect }
}

function envVar(name: string, endpoints: EnvVariable['endpoints'] = []): EnvVariable {
  return {
    name,
    defined: true,
    documented: true,
    used: true,
    definedIn: ['.env'],
    documentedIn: ['.env.example'],
    usedIn: [],
    fallback: false,
    testOnly: false,
    public: false,
    sensitive: false,
    endpoints,
    suspiciousValueIn: [],
  }
}

async function databasesOf(dir: string): Promise<DatabasesSection> {
  const ctx = await contextFor(dir)
  return ctx.use(databasesDetector)
}

function database(section: DatabasesSection, id: string) {
  const found = section.databases.find((db) => db.id === id)
  if (!found) throw new Error(`database ${id} not found in ${JSON.stringify(section.databases)}`)
  return found
}

function orm(section: DatabasesSection, id: string) {
  const found = section.orms.find((tool) => tool.id === id)
  if (!found) throw new Error(`ORM ${id} not found in ${JSON.stringify(section.orms)}`)
  return found
}

/** Hostile inputs must be handled in linear time. The old quadratic code took seconds to minutes at these sizes. */
function expectFast(fn: () => unknown, ms = 2_000): void {
  const start = performance.now()
  fn()
  expect(performance.now() - start).toBeLessThan(timeBudget(ms))
}

const MIB = 1024 * 1024

describe('inferDatabases', () => {
  it('returns nothing without signals', () => {
    expect(inferDatabases(input())).toEqual({ databases: [], orms: [] })
  })

  it('rates a connection-string scheme as medium and a name-only variable as low', () => {
    const result = inferDatabases(
      input({
        envVariables: [
          envVar('DATABASE_URL', [{ file: '.env.example', scheme: 'postgres', port: 5432, local: true }]),
          envVar('REDIS_URL'),
        ],
      }),
    )
    expect(result.databases).toEqual([
      {
        id: 'postgresql',
        name: 'PostgreSQL',
        kind: 'relational',
        sources: ['env'],
        confidence: 'medium',
        evidence: ['DATABASE_URL holds a postgres:// URL in .env.example'],
      },
      {
        id: 'redis',
        name: 'Redis',
        kind: 'key-value',
        sources: ['env'],
        confidence: 'low',
        evidence: ['environment variable REDIS_URL'],
      },
    ])
  })

  it('maps connection-string schemes and conventional names', () => {
    const endpoint = (scheme: string) => [{ file: '.env', scheme, port: null, local: false }]
    const result = inferDatabases(
      input({
        envVariables: [
          envVar('MONGO', endpoint('mongodb+srv')),
          envVar('CACHE', endpoint('rediss')),
          envVar('SQL', endpoint('MySQL')),
          envVar('API_URL', endpoint('https')),
          envVar('PGHOST'),
          envVar('MYSQL_DATABASE'),
          envVar('PG_SOMETHING_ELSE'),
        ],
      }),
    )
    expect(result.databases.map((db) => [db.id, db.confidence])).toEqual([
      ['mongodb', 'medium'],
      ['mysql', 'medium'],
      ['redis', 'medium'],
      ['postgresql', 'low'],
    ])
    expect(databaseFromEnvName('MONGODB_URI')).toBe('mongodb')
    expect(databaseFromEnvName('POSTGRES_PASSWORD')).toBe('postgresql')
    expect(databaseFromEnvName('REDIS')).toBe('redis')
    expect(databaseFromEnvName('REDISH_THING')).toBeUndefined()
    expect(databaseFromEnvName('PGP_KEY')).toBeUndefined()
  })

  it('maps driver-qualified schemes by the database before the "+"', () => {
    const endpoint = (scheme: string) => [{ file: '.env.example', scheme, port: null, local: true }]
    const result = inferDatabases(
      input({
        envVariables: [
          envVar('DB', endpoint('postgresql+asyncpg')),
          envVar('LEGACY', endpoint('mysql+pymysql')),
          envVar('ATLAS', endpoint('mongodb+srv')),
          envVar('OTHER', endpoint('unknown+postgres')),
        ],
      }),
    )
    expect(result.databases.map((db) => [db.id, db.confidence])).toEqual([
      ['mongodb', 'medium'],
      ['mysql', 'medium'],
      ['postgresql', 'medium'],
    ])
    expect(database(result, 'postgresql').evidence).toEqual(['DB holds a postgresql+asyncpg:// URL in .env.example'])
  })

  it('does not fall back to the variable name when its URL already identified a database', () => {
    const result = inferDatabases(
      input({ envVariables: [envVar('REDIS_URL', [{ file: '.env', scheme: 'redis', port: 6379, local: true }])] }),
    )
    expect(database(result, 'redis')).toMatchObject({
      confidence: 'medium',
      evidence: ['REDIS_URL holds a redis:// URL in .env'],
    })
  })

  it('combines sources, takes the strongest confidence and orders by confidence then name', () => {
    const db = parseComposeService('db', { image: 'postgres:17' }, 'compose.yaml')
    const cache = parseComposeService('cache', { image: 'redis:8' }, 'compose.yaml')
    const storage = parseComposeService('s3', { image: 'minio/minio' }, 'compose.yaml')
    const result = inferDatabases(
      input({
        services: [cache, db, storage],
        dependencies: [nodeDep('pg', '^8.16.3'), nodeDep('mongodb', '^6.0.0', { type: 'devDependencies' })],
        envVariables: [envVar('DATABASE_URL', [{ file: '.env', scheme: 'postgresql', port: 5432, local: true }])],
        configs: { ...NO_CONFIGS, prismaProviders: [{ file: 'prisma/schema.prisma', provider: 'postgresql' }] },
      }),
    )
    expect(result.databases.map((d) => [d.id, d.confidence])).toEqual([
      ['postgresql', 'high'],
      ['redis', 'high'],
      ['mongodb', 'medium'],
    ])
    expect(database(result, 'postgresql')).toEqual({
      id: 'postgresql',
      name: 'PostgreSQL',
      kind: 'relational',
      sources: ['config', 'dependency', 'docker', 'env'],
      confidence: 'high',
      evidence: [
        'db service (postgres:17) in compose.yaml',
        'Prisma datasource provider "postgresql" in prisma/schema.prisma',
        'dependency pg@^8.16.3 in package.json',
        'DATABASE_URL holds a postgresql:// URL in .env',
      ],
    })
    expect(database(result, 'redis').sources).toEqual(['docker'])
    expect(result.databases.some((d) => d.id === 'minio')).toBe(false)
  })

  it('recognizes Node and Go drivers, ignoring Go indirect requirements', () => {
    const result = inferDatabases(
      input({
        dependencies: [
          goDep('github.com/jackc/pgx/v5', 'v5.7.6'),
          goDep('github.com/redis/go-redis/v9', 'v9.14.0'),
          goDep('github.com/go-sql-driver/mysql', 'v1.9.3', true),
          goDep('gorm.io/driver/sqlite', 'v1.6.0'),
          nodeDep('@libsql/client'),
          nodeDep('@aws-sdk/client-dynamodb'),
          nodeDep('mssql', '^11.0.0', { type: 'peerDependencies' }),
        ],
      }),
    )
    expect(result.databases.map((d) => [d.id, d.confidence])).toEqual([
      ['dynamodb', 'high'],
      ['libsql', 'high'],
      ['postgresql', 'high'],
      ['redis', 'high'],
      ['sqlite', 'high'],
      ['mssql', 'medium'],
    ])
    expect(database(result, 'postgresql').evidence).toEqual(['dependency github.com/jackc/pgx/v5@v5.7.6 in go.mod'])
    expect(result.databases.some((d) => d.id === 'mysql')).toBe(false)
  })

  it('maps config values and ignores unknown ones without echoing them', () => {
    const result = inferDatabases(
      input({
        configs: {
          prismaProviders: [
            { file: 'a.prisma', provider: 'sqlserver' },
            { file: 'b.prisma', provider: `evil ${SECRET_SENTINEL}` },
          ],
          drizzleDialects: [{ file: 'drizzle.config.ts', dialect: 'turso' }],
          sqlcEngines: [{ file: 'sqlc.yaml', engine: 'mysql' }],
          typeormTypes: [
            { file: 'src/data-source.ts', type: 'postgres' },
            { file: 'src/x.ts', type: 'made-up' },
          ],
        },
      }),
    )
    expect(result.databases.map((d) => [d.id, d.confidence, d.sources])).toEqual([
      ['libsql', 'high', ['config']],
      ['mysql', 'high', ['config']],
      ['mssql', 'high', ['config']],
      ['postgresql', 'medium', ['config']],
    ])
    expect(database(result, 'postgresql').evidence).toEqual(['TypeORM type "postgres" in src/data-source.ts'])
    expect(JSON.stringify(result)).not.toContain(SECRET_SENTINEL)
  })

  it('caps evidence and keeps the strongest first', () => {
    const deps = Array.from({ length: 15 }, (_, i) =>
      nodeDep('pg', '^8.0.0', { package: `apps/a${i}`, file: `apps/a${i}/package.json` }),
    )
    const result = inferDatabases(
      input({
        dependencies: [nodeDep('pg', '^8.0.0', { type: 'devDependencies', file: 'dev/package.json' }), ...deps],
        envVariables: [envVar('PGHOST')],
      }),
    )
    const evidence = database(result, 'postgresql').evidence
    expect(evidence).toHaveLength(MAX_EVIDENCE)
    expect(evidence[0]).toBe('dependency pg@^8.0.0 in apps/a0/package.json')
    expect(evidence).not.toContain('environment variable PGHOST')
  })

  it('redacts credentials from dependency ranges in evidence', () => {
    const token = `ghp_${'c'.repeat(36)}`
    const result = inferDatabases(
      input({ dependencies: [nodeDep('pg', `git+https://deploy:${token}@github.com/acme/pg.git#v8`)] }),
    )
    expect(JSON.stringify(result)).not.toContain(token)
    expect(database(result, 'postgresql').evidence).toEqual([
      'dependency pg@git+https://github.com/acme/pg.git in package.json',
    ])
    expect(displayRange(`npm:pg@${token}`)).not.toContain(token)
  })

  it('ignores prototype keys as dependency names', () => {
    const result = inferDatabases(
      input({ dependencies: [nodeDep('constructor'), nodeDep('__proto__'), goDep('toString')] }),
    )
    expect(result).toEqual({ databases: [], orms: [] })
  })
})

describe('driver helpers', () => {
  it('strips Go major-version suffixes', () => {
    expect(goModuleBase('github.com/jackc/pgx/v5')).toBe('github.com/jackc/pgx')
    expect(goModuleBase('go.mongodb.org/mongo-driver/v2')).toBe('go.mongodb.org/mongo-driver')
    expect(goModuleBase('github.com/lib/pq')).toBe('github.com/lib/pq')
    expect(driverDatabase({ name: 'go.mongodb.org/mongo-driver/v2', ecosystem: 'go' })).toBe('mongodb')
    expect(driverDatabase({ name: 'github.com/ClickHouse/clickhouse-go/v2', ecosystem: 'go' })).toBe('clickhouse')
    expect(driverDatabase({ name: 'pg', ecosystem: 'go' })).toBeUndefined()
    expect(driverDatabase({ name: 'github.com/lib/pq', ecosystem: 'node' })).toBeUndefined()
  })
})

describe('inferOrms', () => {
  it('reports Prisma with version, packages, config files and high confidence for a runtime dependency', () => {
    const tools = inferOrms(
      [
        nodeDep('@prisma/client', '^6.16.2', { package: 'apps/api', file: 'apps/api/package.json' }),
        nodeDep('prisma', '^6.16.2', { type: 'devDependencies', package: 'apps/api', file: 'apps/api/package.json' }),
      ],
      ['apps/api/prisma/schema.prisma', 'apps/api/prisma.config.ts', 'drizzle.config.ts'],
    )
    expect(tools).toEqual([
      {
        id: 'prisma',
        name: 'Prisma',
        kind: 'orm',
        version: '6.16.2',
        configFiles: ['apps/api/prisma.config.ts', 'apps/api/prisma/schema.prisma'],
        packages: ['apps/api'],
        confidence: 'high',
        evidence: [
          'dependency @prisma/client@^6.16.2 in apps/api/package.json',
          'config file apps/api/prisma.config.ts',
          'config file apps/api/prisma/schema.prisma',
          'devDependency prisma@^6.16.2 in apps/api/package.json',
        ],
      },
      {
        id: 'drizzle',
        name: 'Drizzle',
        kind: 'orm',
        configFiles: ['drizzle.config.ts'],
        packages: ['.'],
        confidence: 'medium',
        evidence: ['config file drizzle.config.ts'],
      },
    ])
  })

  it('rates dev-only dependencies medium unless a config file backs them up', () => {
    const dev = { type: 'devDependencies' as const }
    expect(inferOrms([nodeDep('knex', '^3.1.0', dev)], [])[0]).toMatchObject({ id: 'knex', confidence: 'medium' })
    expect(inferOrms([nodeDep('knex', '^3.1.0', dev)], ['knexfile.js'])[0]).toMatchObject({
      id: 'knex',
      confidence: 'high',
      configFiles: ['knexfile.js'],
    })
  })

  it('attributes Prisma schemas that declare a datasource', () => {
    const tools = inferOrms([nodeDep('prisma', '^6.0.0', { type: 'devDependencies' })], [], {
      prismaProviders: [{ file: 'prisma/schema/main.prisma', provider: 'postgresql' }],
    })
    expect(tools[0]).toMatchObject({ id: 'prisma', confidence: 'high', configFiles: ['prisma/schema/main.prisma'] })
  })

  it('recognizes Go ORMs and sqlc from its config alone', () => {
    const tools = inferOrms(
      [
        goDep('gorm.io/gorm', 'v1.31.0'),
        goDep('entgo.io/ent', 'v0.14.5', true),
        goDep('github.com/uptrace/bun', 'v1.2.15'),
      ],
      ['db/sqlc.yaml'],
    )
    expect(tools.map((t) => [t.id, t.name, t.confidence, t.version])).toEqual([
      ['bun', 'Bun ORM', 'high', '1.2.15'],
      ['gorm', 'GORM', 'high', '1.31.0'],
      ['sqlc', 'sqlc', 'high', undefined],
    ])
    expect(tools.find((t) => t.id === 'sqlc')?.configFiles).toEqual(['db/sqlc.yaml'])
  })

  it('names Mongoose and orders ORMs by confidence then name', () => {
    const tools = inferOrms(
      [nodeDep('mongoose', '^8.18.2'), nodeDep('kysely', '^0.28.0', { type: 'devDependencies' })],
      [],
    )
    expect(tools.map((t) => [t.name, t.confidence])).toEqual([
      ['Mongoose', 'high'],
      ['Kysely', 'medium'],
    ])
    expect(tools.every((t) => t.kind === 'orm')).toBe(true)
  })

  it('builds ORMs from the shared tool signals: labels, safe versions, capped evidence, root first', () => {
    const token = `ghp_${'e'.repeat(36)}`
    const refs = Array.from({ length: 8 }, (_, i) =>
      nodeDep('knex', i === 0 ? `git+https://x:${token}@github.com/k/knex.git` : '^3.1.0', {
        type: 'devDependencies',
        package: i === 0 ? '.' : `apps/a${i}`,
        file: i === 0 ? 'package.json' : `apps/a${i}/package.json`,
      }),
    )
    const [knex] = inferOrms(refs, ['apps/a1/knexfile.js'], undefined, (file) =>
      file.startsWith('apps/a1/') ? 'apps/a1' : '.',
    )
    expect(JSON.stringify(knex)).not.toContain(token)
    expect(knex).toMatchObject({
      id: 'knex',
      version: '3.1.0',
      confidence: 'high',
      configFiles: ['apps/a1/knexfile.js'],
    })
    expect(knex?.packages[0]).toBe('.')
    expect(knex?.evidence).toHaveLength(6)
    expect(knex?.evidence[0]).toBe('config file apps/a1/knexfile.js')
    expect(knex?.evidence[1]).toBe('devDependency knex in package.json')
    expect(knex?.evidence.at(-1)).toMatch(/^and \d+ more$/)
  })

  it('merges packages across a monorepo', () => {
    const tools = inferOrms(
      [
        nodeDep('drizzle-orm', 'workspace:*', { package: 'packages/db', file: 'packages/db/package.json' }),
        nodeDep('drizzle-orm', '^0.44.5', { package: 'apps/api', file: 'apps/api/package.json' }),
      ],
      [],
    )
    expect(tools[0]).toMatchObject({ id: 'drizzle', version: '0.44.5', packages: ['apps/api', 'packages/db'] })
  })
})

describe('config extraction', () => {
  it('extracts Prisma datasource providers, ignoring generators and comments', () => {
    const schema = [
      'generator client {',
      '  provider = "prisma-client-js"',
      '}',
      '// datasource old { provider = "mysql" }',
      'datasource db {',
      '  // provider = "sqlite"',
      '  provider = "postgresql"',
      '  url      = env("DATABASE_URL") // postgres://example',
      '}',
    ].join('\n')
    expect(extractPrismaProviders(schema)).toEqual(['postgresql'])
    expect(extractPrismaProviders('model User { id Int @id }')).toEqual([])
    expect(extractPrismaProviders('datasource db {')).toEqual([])
    expect(
      extractPrismaProviders('datasource a {\n provider = "sqlite"\n}\ndatasource b {\n provider = "mysql"'),
    ).toEqual(['sqlite'])
  })

  it('strips comments but keeps strings that look like comments', () => {
    const code = [
      "const url = 'postgres://localhost/db' // trailing",
      '/* block',
      "   dialect: 'mysql' */",
      "const glob = './src/db/schema/*'",
      '// whole line',
      'const t = `a // b /* c`',
      "const stray = don't",
      "dialect: 'sqlite'",
    ].join('\n')
    expect(stripJsComments(code)).toBe(
      [
        "const url = 'postgres://localhost/db' ",
        ' ',
        "const glob = './src/db/schema/*'",
        '',
        'const t = `a // b /* c`',
        "const stray = don't",
        "dialect: 'sqlite'",
      ].join('\n'),
    )
    expect(stripJsComments('a /* never closed')).toBe('a  ')
  })

  it('extracts drizzle dialects and legacy drivers', () => {
    expect(extractDrizzleDialects("export default defineConfig({ dialect: 'postgresql', schema: './s.ts' })")).toEqual([
      'postgresql',
    ])
    expect(extractDrizzleDialects('{ "dialect": "sqlite" }')).toEqual(['sqlite'])
    expect(extractDrizzleDialects("export default { driver: 'pg', schema: './s.ts' }")).toEqual(['pg'])
    expect(extractDrizzleDialects("export default { driver: 'aws-data-api' }")).toEqual([])
    expect(
      extractDrizzleDialects("// dialect: 'mysql'\n/* dialect: 'sqlite' */\nexport default { dialect: \"turso\" }"),
    ).toEqual(['turso'])
    expect(extractDrizzleDialects('export default { dialect: process.env.DIALECT }')).toEqual([])
  })

  it('reads the dialect when a schema glob precedes a block comment', () => {
    const config = [
      "import { defineConfig } from 'drizzle-kit'",
      'export default defineConfig({',
      "  schema: './src/db/schema/*',",
      "  dialect: 'postgresql',",
      '  /** Where generated migrations go */',
      "  out: './drizzle',",
      '  dbCredentials: { url: process.env.DATABASE_URL! }, // e.g. postgres://localhost',
      '})',
    ].join('\n')
    expect(extractDrizzleDialects(config)).toEqual(['postgresql'])
  })

  it('extracts sqlc engines from v1 and v2 configs', () => {
    expect(extractSqlcEngines({ version: '2', sql: [{ engine: 'postgresql' }, { engine: 'sqlite' }, 'x'] })).toEqual([
      'postgresql',
      'sqlite',
    ])
    expect(extractSqlcEngines({ version: '1', packages: [{ name: 'db' }, { engine: 'mysql' }] })).toEqual([
      'postgresql',
      'mysql',
    ])
    expect(extractSqlcEngines(null)).toEqual([])
    expect(extractSqlcEngines({ sql: 'nope' })).toEqual([])
  })

  it('extracts ormconfig types', () => {
    expect(extractOrmconfigTypes({ type: 'postgres' })).toEqual(['postgres'])
    expect(extractOrmconfigTypes([{ type: 'mysql' }, { name: 'x' }, { type: 'mysql' }])).toEqual(['mysql'])
    expect(extractOrmconfigTypes('nope')).toEqual([])
  })

  it('extracts TypeORM types only from option objects in files that import TypeORM', () => {
    const nest = [
      "import { TypeOrmModule } from '@nestjs/typeorm'",
      'TypeOrmModule.forRoot({',
      "  type: 'mysql', // don't forget the port",
      "  host: 'localhost',",
      '})',
      "const unrelated = { type: 'postgres' }",
    ].join('\n')
    expect(extractTypeormTypes(nest)).toEqual(['mysql'])

    const dataSource = [
      "import { DataSource } from 'typeorm'",
      "export const ds = new DataSource({ type: 'postgres', entities: [] })",
      "export const opts: DataSourceOptions = { type: 'better-sqlite3', database: ':memory:' }",
      "new DataSource({ type: 'not-a-database' })",
    ].join('\n')
    expect(extractTypeormTypes(dataSource)).toEqual(['better-sqlite3', 'postgres'])

    expect(extractTypeormTypes("new DataSource({ type: 'postgres' })")).toEqual([])
    expect(
      extractTypeormTypes("const { DataSource } = require('typeorm')\n// new DataSource({ type: 'mysql' })\n"),
    ).toEqual([])
    expect(
      extractTypeormTypes(
        "import 'typeorm'\nTypeOrmModule.forRootAsync({ useFactory: () => ({ type: 'mariadb', host: cfg.get('h') }) })",
      ),
    ).toEqual(['mariadb'])
    expect(
      extractTypeormTypes(
        [
          "import { DataSource } from 'typeorm'",
          'new DataSource({',
          "  url: 'postgres://localhost/app', // local only",
          "  /* type: 'mysql', */",
          "  type: 'postgres',",
          '})',
        ].join('\n'),
      ),
    ).toEqual(['postgres'])
  })

  it('stays linear on hostile config and source files', () => {
    const typeorm = "import { DataSource } from 'typeorm'\n"
    expectFast(() => expect(extractDrizzleDialects('\n'.repeat(MIB))).toEqual([]))
    expectFast(() => expect(extractDrizzleDialects(' \n'.repeat(MIB / 2))).toEqual([]))
    expectFast(() => expect(extractDrizzleDialects('/* a'.repeat(MIB / 4))).toEqual([]))
    expectFast(() => expect(extractPrismaProviders('datasource a {'.repeat(MIB / 14))).toEqual([]))
    expectFast(() => expect(extractPrismaProviders(`${'datasource a {'.repeat(MIB / 14)}}`)).toEqual([]))
    expectFast(() => expect(extractTypeormTypes(typeorm + '\n'.repeat(MIB / 2))).toEqual([]))
    expectFast(() => expect(extractTypeormTypes(typeorm + 'x;new DataSource(/* a'.repeat(MIB / 40))).toEqual([]))
    expectFast(() => expect(extractTypeormTypes(typeorm + "new DataSource({ type: 'x',".repeat(MIB / 54))).toEqual([]))
  })
})

describe('databases detector on fixtures', () => {
  it('monorepo: PostgreSQL via Docker and Prisma, Redis via Docker', async () => {
    const ctx = await fixtureContext('monorepo')
    const section = await ctx.use(databasesDetector)
    expect(JSON.stringify(section)).not.toContain(SECRET_SENTINEL)
    const postgres = database(section, 'postgresql')
    expect(postgres.confidence).toBe('high')
    expect(postgres.sources).toEqual(expect.arrayContaining(['config', 'docker']))
    expect(postgres.evidence).toEqual(
      expect.arrayContaining([
        'postgres service (postgres:17) in docker-compose.yml',
        'Prisma datasource provider "postgresql" in apps/api/prisma/schema.prisma',
      ]),
    )
    expect(database(section, 'redis')).toMatchObject({ confidence: 'high', kind: 'key-value' })
    expect(database(section, 'redis').sources).toContain('docker')
    expect(section.databases.some((d) => d.id === 'minio')).toBe(false)
    expect(orm(section, 'prisma')).toMatchObject({
      version: '6.16.2',
      configFiles: ['apps/api/prisma/schema.prisma'],
      packages: ['apps/api'],
      confidence: 'high',
    })
  })

  it('docker-project: drivers and Compose services agree', async () => {
    const ctx = await fixtureContext('docker-project')
    const section = await ctx.use(databasesDetector)
    expect(JSON.stringify(section)).not.toContain(SECRET_SENTINEL)
    expect(database(section, 'postgresql').sources).toEqual(expect.arrayContaining(['dependency', 'docker']))
    expect(database(section, 'redis').sources).toEqual(expect.arrayContaining(['dependency', 'docker']))
    expect(section.orms).toEqual([])
  })

  it('go-api: pgx and go-redis', async () => {
    const section = await (await fixtureContext('go-api')).use(databasesDetector)
    expect(database(section, 'postgresql')).toMatchObject({ confidence: 'high' })
    expect(database(section, 'postgresql').evidence).toContain('dependency github.com/jackc/pgx/v5@v5.7.6 in go.mod')
    expect(database(section, 'redis')).toMatchObject({ confidence: 'high' })
    expect(section.orms).toEqual([])
  })

  it('next-app: Prisma with PostgreSQL', async () => {
    const section = await (await fixtureContext('next-app')).use(databasesDetector)
    expect(JSON.stringify(section)).not.toContain(SECRET_SENTINEL)
    expect(database(section, 'postgresql')).toMatchObject({ confidence: 'high' })
    expect(database(section, 'postgresql').sources).toContain('config')
    expect(orm(section, 'prisma')).toMatchObject({
      version: '6.16.2',
      configFiles: ['prisma/schema.prisma'],
      packages: ['.'],
      confidence: 'high',
    })
  })

  it('fastify-api: Drizzle on PostgreSQL plus ioredis', async () => {
    const section = await (await fixtureContext('fastify-api')).use(databasesDetector)
    expect(database(section, 'postgresql').sources).toEqual(expect.arrayContaining(['config', 'dependency']))
    expect(database(section, 'postgresql').evidence).toEqual(
      expect.arrayContaining([
        'Drizzle dialect "postgresql" in drizzle.config.ts',
        'dependency pg@^8.16.3 in package.json',
      ]),
    )
    expect(database(section, 'redis').evidence).toContain('dependency ioredis@^5.8.0 in package.json')
    expect(orm(section, 'drizzle')).toMatchObject({
      version: '0.44.5',
      configFiles: ['drizzle.config.ts'],
      confidence: 'high',
    })
  })

  it('express-api: Mongoose means MongoDB', async () => {
    const section = await (await fixtureContext('express-api')).use(databasesDetector)
    expect(database(section, 'mongodb')).toMatchObject({ name: 'MongoDB', kind: 'document', confidence: 'high' })
    expect(orm(section, 'mongoose')).toMatchObject({ name: 'Mongoose', version: '8.18.2', confidence: 'high' })
  })

  it('nest-api: TypeORM on MySQL', async () => {
    const section = await (await fixtureContext('nest-api')).use(databasesDetector)
    const mysql = database(section, 'mysql')
    expect(mysql.confidence).toBe('high')
    expect(mysql.sources).toEqual(expect.arrayContaining(['config', 'dependency']))
    expect(mysql.evidence).toEqual(
      expect.arrayContaining([
        'dependency mysql2@^3.15.1 in package.json',
        'TypeORM type "mysql" in src/app.module.ts',
      ]),
    )
    expect(orm(section, 'typeorm')).toMatchObject({ version: '0.3.27', packages: ['.'], confidence: 'high' })
  })

  it('broken-config: does not crash', async () => {
    const section = await (await fixtureContext('broken-config')).use(databasesDetector)
    expect(section.databases.some((d) => d.sources.includes('docker'))).toBe(false)
    expect(section.orms).toEqual([])
  })
})

describe('databases detector on generated projects', () => {
  it('reads sqlc, ormconfig and split Prisma schemas, skipping examples and tests', async () => {
    const dir = await makeProject({
      'go.mod': 'module example.com/app\n\ngo 1.25\n\nrequire github.com/lib/pq v1.10.9\n',
      'db/sqlc.yaml': 'version: "2"\nsql:\n  - engine: "postgresql"\n    queries: q.sql\n    schema: s.sql\n',
      'package.json': JSON.stringify({ dependencies: { typeorm: '^0.3.27', prisma: '^6.0.0' } }),
      'ormconfig.json': JSON.stringify({ type: 'mariadb', password: SECRET_SENTINEL }),
      'prisma/schema/main.prisma': 'datasource db {\n  provider = "cockroachdb"\n  url = env("DATABASE_URL")\n}\n',
      'prisma/schema/user.prisma': 'model User { id Int @id }\n',
      'examples/demo/prisma/schema.prisma': 'datasource db {\n  provider = "mongodb"\n}\n',
      'src/data-source.ts':
        "import { DataSource } from 'typeorm'\nexport default new DataSource({ type: 'postgres' })\n",
      'src/data-source.test.ts': "import { DataSource } from 'typeorm'\nnew DataSource({ type: 'sqlite' })\n",
    })
    const section = await databasesOf(dir)
    expect(JSON.stringify(section)).not.toContain(SECRET_SENTINEL)
    expect(section.databases.map((d) => [d.id, d.confidence, d.sources])).toEqual([
      ['cockroachdb', 'high', ['config']],
      ['postgresql', 'high', ['config', 'dependency']],
      ['mariadb', 'medium', ['config']],
    ])
    expect(database(section, 'postgresql').evidence).toEqual([
      'sqlc engine "postgresql" in db/sqlc.yaml',
      'dependency github.com/lib/pq@v1.10.9 in go.mod',
      'TypeORM type "postgres" in src/data-source.ts',
    ])
    expect(orm(section, 'prisma').configFiles).toEqual(['prisma/schema/main.prisma'])
    expect(orm(section, 'typeorm').configFiles).toEqual(['ormconfig.json'])
    expect(orm(section, 'sqlc')).toMatchObject({ configFiles: ['db/sqlc.yaml'], confidence: 'high' })
  })

  it('survives malformed database config files', async () => {
    const dir = await makeProject({
      'package.json': JSON.stringify({ dependencies: { 'drizzle-orm': '^0.44.0', typeorm: '^0.3.0' } }),
      'drizzle.config.ts': 'export default {{{ dialect: ',
      'sqlc.json': '{ not json',
      'ormconfig.yml': 'type: [unclosed',
      'schema.prisma': 'datasource db { provider = ',
      'src/index.ts': "import 'typeorm'\nnew DataSource({ type: 'mysql'",
    })
    const ctx = await contextFor(dir)
    const section = await ctx.use(databasesDetector)
    expect(ctx.warnings.map((w) => w.file)).toEqual(expect.arrayContaining(['sqlc.json', 'ormconfig.yml']))
    expect(section.databases.map((d) => d.id)).toEqual(['mysql'])
    // An unparseable sqlc.json still shows sqlc is in use; its engine is simply unknown.
    expect(section.orms.map((o) => [o.id, o.confidence])).toEqual([
      ['drizzle', 'high'],
      ['sqlc', 'high'],
      ['typeorm', 'high'],
      ['prisma', 'medium'],
    ])
  })
})
