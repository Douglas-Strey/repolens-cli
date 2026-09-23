import type { DatabaseKind } from '../../types.ts'

export interface DatabaseInfo {
  id: string
  name: string
  kind: DatabaseKind
}

/** Every database RepoLens can report, keyed by id. Image technologies with one of these ids count as databases. */
export const DATABASES: ReadonlyMap<string, DatabaseInfo> = new Map(
  (
    [
      ['postgresql', 'PostgreSQL', 'relational'],
      ['mysql', 'MySQL', 'relational'],
      ['mariadb', 'MariaDB', 'relational'],
      ['sqlite', 'SQLite', 'relational'],
      ['libsql', 'libSQL', 'relational'],
      ['cockroachdb', 'CockroachDB', 'relational'],
      ['mssql', 'SQL Server', 'relational'],
      ['oracle', 'Oracle Database', 'relational'],
      ['singlestore', 'SingleStore', 'relational'],
      ['mongodb', 'MongoDB', 'document'],
      ['couchdb', 'CouchDB', 'document'],
      ['redis', 'Redis', 'key-value'],
      ['valkey', 'Valkey', 'key-value'],
      ['keydb', 'KeyDB', 'key-value'],
      ['dragonfly', 'Dragonfly', 'key-value'],
      ['memcached', 'Memcached', 'key-value'],
      ['dynamodb', 'DynamoDB', 'key-value'],
      ['cassandra', 'Cassandra', 'wide-column'],
      ['scylladb', 'ScyllaDB', 'wide-column'],
      ['clickhouse', 'ClickHouse', 'other'],
      ['surrealdb', 'SurrealDB', 'other'],
      ['neo4j', 'Neo4j', 'graph'],
      ['influxdb', 'InfluxDB', 'time-series'],
      ['elasticsearch', 'Elasticsearch', 'search'],
      ['opensearch', 'OpenSearch', 'search'],
    ] as const
  ).map(([id, name, kind]) => [id, { id, name, kind }]),
)

/** npm packages that connect to one specific database. */
export const NODE_DRIVERS: ReadonlyMap<string, string> = new Map([
  ['pg', 'postgresql'],
  ['pg-native', 'postgresql'],
  ['postgres', 'postgresql'],
  ['@neondatabase/serverless', 'postgresql'],
  ['@vercel/postgres', 'postgresql'],
  ['pg-promise', 'postgresql'],
  ['slonik', 'postgresql'],
  ['@prisma/adapter-pg', 'postgresql'],
  ['@prisma/adapter-neon', 'postgresql'],
  ['@mikro-orm/postgresql', 'postgresql'],
  ['mysql', 'mysql'],
  ['mysql2', 'mysql'],
  ['@planetscale/database', 'mysql'],
  ['@prisma/adapter-planetscale', 'mysql'],
  ['@mikro-orm/mysql', 'mysql'],
  ['mariadb', 'mariadb'],
  ['@prisma/adapter-mariadb', 'mariadb'],
  ['@mikro-orm/mariadb', 'mariadb'],
  ['better-sqlite3', 'sqlite'],
  ['sqlite3', 'sqlite'],
  ['sqlite', 'sqlite'],
  ['@prisma/adapter-better-sqlite3', 'sqlite'],
  ['@prisma/adapter-d1', 'sqlite'],
  ['@mikro-orm/sqlite', 'sqlite'],
  ['@mikro-orm/better-sqlite', 'sqlite'],
  ['@libsql/client', 'libsql'],
  ['@prisma/adapter-libsql', 'libsql'],
  ['@mikro-orm/libsql', 'libsql'],
  ['mongodb', 'mongodb'],
  ['mongoose', 'mongodb'],
  ['@mikro-orm/mongodb', 'mongodb'],
  ['redis', 'redis'],
  ['ioredis', 'redis'],
  ['@upstash/redis', 'redis'],
  ['@redis/client', 'redis'],
  ['iovalkey', 'valkey'],
  ['@valkey/valkey-glide', 'valkey'],
  ['memcached', 'memcached'],
  ['memjs', 'memcached'],
  ['@aws-sdk/client-dynamodb', 'dynamodb'],
  ['@aws-sdk/lib-dynamodb', 'dynamodb'],
  ['dynamoose', 'dynamodb'],
  ['mssql', 'mssql'],
  ['tedious', 'mssql'],
  ['@prisma/adapter-mssql', 'mssql'],
  ['@mikro-orm/mssql', 'mssql'],
  ['oracledb', 'oracle'],
  ['cassandra-driver', 'cassandra'],
  ['neo4j-driver', 'neo4j'],
  ['@influxdata/influxdb-client', 'influxdb'],
  ['@elastic/elasticsearch', 'elasticsearch'],
  ['@opensearch-project/opensearch', 'opensearch'],
  ['@clickhouse/client', 'clickhouse'],
])

/** Go modules (without a "/vN" major-version suffix) that connect to one specific database. */
export const GO_DRIVERS: ReadonlyMap<string, string> = new Map([
  ['github.com/lib/pq', 'postgresql'],
  ['github.com/jackc/pgx', 'postgresql'],
  ['gorm.io/driver/postgres', 'postgresql'],
  ['github.com/go-sql-driver/mysql', 'mysql'],
  ['gorm.io/driver/mysql', 'mysql'],
  ['github.com/mattn/go-sqlite3', 'sqlite'],
  ['modernc.org/sqlite', 'sqlite'],
  ['github.com/glebarez/sqlite', 'sqlite'],
  ['gorm.io/driver/sqlite', 'sqlite'],
  ['github.com/tursodatabase/libsql-client-go', 'libsql'],
  ['github.com/tursodatabase/go-libsql', 'libsql'],
  ['go.mongodb.org/mongo-driver', 'mongodb'],
  ['github.com/redis/go-redis', 'redis'],
  ['github.com/go-redis/redis', 'redis'],
  ['github.com/gomodule/redigo', 'redis'],
  ['github.com/redis/rueidis', 'redis'],
  ['github.com/valkey-io/valkey-go', 'valkey'],
  ['github.com/bradfitz/gomemcache', 'memcached'],
  ['github.com/microsoft/go-mssqldb', 'mssql'],
  ['github.com/denisenkom/go-mssqldb', 'mssql'],
  ['gorm.io/driver/sqlserver', 'mssql'],
  ['github.com/sijms/go-ora', 'oracle'],
  ['github.com/godror/godror', 'oracle'],
  ['github.com/gocql/gocql', 'cassandra'],
  ['github.com/neo4j/neo4j-go-driver', 'neo4j'],
  ['github.com/influxdata/influxdb-client-go', 'influxdb'],
  ['github.com/elastic/go-elasticsearch', 'elasticsearch'],
  ['github.com/opensearch-project/opensearch-go', 'opensearch'],
  ['github.com/ClickHouse/clickhouse-go', 'clickhouse'],
  ['gorm.io/driver/clickhouse', 'clickhouse'],
  ['github.com/aws/aws-sdk-go-v2/service/dynamodb', 'dynamodb'],
])

/** Prisma `datasource { provider = "…" }` values. */
export const PRISMA_PROVIDERS: ReadonlyMap<string, string> = new Map([
  ['postgresql', 'postgresql'],
  ['postgres', 'postgresql'],
  ['mysql', 'mysql'],
  ['sqlite', 'sqlite'],
  ['mongodb', 'mongodb'],
  ['cockroachdb', 'cockroachdb'],
  ['sqlserver', 'mssql'],
])

/** drizzle-kit `dialect` values, plus the `driver` values older drizzle-kit versions used instead. */
export const DRIZZLE_DIALECTS: ReadonlyMap<string, string> = new Map([
  ['postgresql', 'postgresql'],
  ['mysql', 'mysql'],
  ['sqlite', 'sqlite'],
  ['turso', 'libsql'],
  ['singlestore', 'singlestore'],
  ['pg', 'postgresql'],
  ['mysql2', 'mysql'],
  ['better-sqlite', 'sqlite'],
  ['libsql', 'libsql'],
  ['d1', 'sqlite'],
])

/** sqlc `engine` values. */
export const SQLC_ENGINES: ReadonlyMap<string, string> = new Map([
  ['postgresql', 'postgresql'],
  ['mysql', 'mysql'],
  ['sqlite', 'sqlite'],
])

/** TypeORM connection `type` values. */
export const TYPEORM_TYPES: ReadonlyMap<string, string> = new Map([
  ['postgres', 'postgresql'],
  ['aurora-postgres', 'postgresql'],
  ['cockroachdb', 'cockroachdb'],
  ['mysql', 'mysql'],
  ['aurora-mysql', 'mysql'],
  ['mariadb', 'mariadb'],
  ['sqlite', 'sqlite'],
  ['better-sqlite3', 'sqlite'],
  ['sqljs', 'sqlite'],
  ['capacitor', 'sqlite'],
  ['cordova', 'sqlite'],
  ['expo', 'sqlite'],
  ['nativescript', 'sqlite'],
  ['react-native', 'sqlite'],
  ['mssql', 'mssql'],
  ['oracle', 'oracle'],
  ['mongodb', 'mongodb'],
])

/** URL schemes of connection strings (EnvEndpoint.scheme). */
export const ENV_SCHEMES: ReadonlyMap<string, string> = new Map([
  ['postgres', 'postgresql'],
  ['postgresql', 'postgresql'],
  ['mysql', 'mysql'],
  ['mariadb', 'mariadb'],
  ['mongodb', 'mongodb'],
  ['mongodb+srv', 'mongodb'],
  ['redis', 'redis'],
  ['rediss', 'redis'],
  ['valkey', 'valkey'],
  ['valkeys', 'valkey'],
  ['libsql', 'libsql'],
  ['sqlserver', 'mssql'],
  ['mssql', 'mssql'],
  ['neo4j', 'neo4j'],
  ['neo4j+s', 'neo4j'],
  ['bolt', 'neo4j'],
  ['clickhouse', 'clickhouse'],
  ['cockroachdb', 'cockroachdb'],
])

/** Variable names that conventionally configure a database. Only a weak (low-confidence) signal. */
export const ENV_NAME_PATTERNS: ReadonlyArray<{ pattern: RegExp; id: string }> = [
  { pattern: /^POSTGRES(?:QL)?_/, id: 'postgresql' },
  {
    pattern:
      /^PG(?:HOST|HOSTADDR|PORT|USER|PASSWORD|DATABASE|SSLMODE|PASSFILE|SERVICE|OPTIONS|APPNAME|CONNECT_TIMEOUT)$/,
    id: 'postgresql',
  },
  { pattern: /^MYSQL_/, id: 'mysql' },
  { pattern: /^MARIADB_/, id: 'mariadb' },
  { pattern: /^MONGO(?:DB)?_/, id: 'mongodb' },
  { pattern: /^REDIS(?:_|$)/, id: 'redis' },
  { pattern: /^VALKEY_/, id: 'valkey' },
  { pattern: /^MEMCACHED?_/, id: 'memcached' },
  { pattern: /^(?:TURSO|LIBSQL)_/, id: 'libsql' },
  { pattern: /^MSSQL_/, id: 'mssql' },
  { pattern: /^CLICKHOUSE_/, id: 'clickhouse' },
  { pattern: /^CASSANDRA_/, id: 'cassandra' },
  { pattern: /^NEO4J_/, id: 'neo4j' },
  { pattern: /^INFLUX(?:DB)?_/, id: 'influxdb' },
  { pattern: /^(?:ELASTICSEARCH|ELASTIC)_/, id: 'elasticsearch' },
  { pattern: /^OPENSEARCH_/, id: 'opensearch' },
  { pattern: /^COCKROACH(?:DB)?_/, id: 'cockroachdb' },
]

export interface OrmDefinition {
  id: string
  name: string
  /** Dependencies (npm names or Go module paths without "/vN") that indicate the tool; the first declared one supplies the version. */
  packages: readonly string[]
  /** Basename of the tool's configuration files. */
  configFile?: RegExp
  /** The tool has no runtime dependency (code generators such as sqlc), so a config file alone is conclusive. */
  configOnly?: boolean
}

export const ORMS: readonly OrmDefinition[] = [
  { id: 'prisma', name: 'Prisma', packages: ['@prisma/client', 'prisma'], configFile: /^prisma\.config\.[cm]?[jt]s$/ },
  { id: 'drizzle', name: 'Drizzle', packages: ['drizzle-orm'], configFile: /^drizzle\.config\.(?:[cm]?[jt]s|json)$/ },
  {
    id: 'typeorm',
    name: 'TypeORM',
    packages: ['typeorm'],
    configFile: /^ormconfig\.(?:json|[cm]?[jt]s|ya?ml|env|xml)$/,
  },
  {
    id: 'sequelize',
    name: 'Sequelize',
    packages: ['sequelize', 'sequelize-typescript'],
    configFile: /^\.sequelizerc$/,
  },
  { id: 'mikro-orm', name: 'MikroORM', packages: ['@mikro-orm/core'], configFile: /^mikro-orm\.config\.[cm]?[jt]s$/ },
  { id: 'kysely', name: 'Kysely', packages: ['kysely'] },
  { id: 'knex', name: 'Knex', packages: ['knex'], configFile: /^knexfile\.[cm]?[jt]s$/ },
  { id: 'mongoose', name: 'Mongoose', packages: ['mongoose'] },
  { id: 'objection', name: 'Objection.js', packages: ['objection'] },
  { id: 'gorm', name: 'GORM', packages: ['gorm.io/gorm'] },
  { id: 'ent', name: 'Ent', packages: ['entgo.io/ent'] },
  { id: 'sqlx', name: 'sqlx', packages: ['github.com/jmoiron/sqlx'] },
  { id: 'bun', name: 'Bun ORM', packages: ['github.com/uptrace/bun'] },
  { id: 'sqlc', name: 'sqlc', packages: [], configFile: /^sqlc\.(?:ya?ml|json)$/, configOnly: true },
]

/** Basenames of every database-related config file RepoLens looks at. `.prisma` schemas are matched by extension. */
export const DATABASE_CONFIG_FILE =
  /^(?:prisma\.config\.[cm]?[jt]s|drizzle\.config\.(?:[cm]?[jt]s|json)|ormconfig\.(?:json|[cm]?[jt]s|ya?ml|env|xml)|\.sequelizerc|mikro-orm\.config\.[cm]?[jt]s|knexfile\.[cm]?[jt]s|sqlc\.(?:ya?ml|json))$/
