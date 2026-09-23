import type { ServiceKind } from '../../types.ts'

/** What a container image is, e.g. { id: "postgresql", name: "PostgreSQL", kind: "database" }. */
export interface ImageTechnology {
  /** Stable id. Database technologies use the same id as the databases section ("postgresql", "redis", …). */
  id: string
  name: string
  kind: ServiceKind
}

export interface ImageRule extends ImageTechnology {
  /**
   * Repository names without registry host, "library/" prefix, tag or digest.
   * A name without "/" also matches the last path segment of any repository,
   * so "redis" covers "bitnami/redis" and "postgres" covers "cimg/postgres".
   */
  images: readonly string[]
}

export const IMAGE_RULES: readonly ImageRule[] = [
  // Databases
  {
    id: 'postgresql',
    name: 'PostgreSQL',
    kind: 'database',
    images: ['postgres', 'postgresql', 'postgis', 'timescaledb', 'timescaledb-ha', 'pgvector'],
  },
  { id: 'mysql', name: 'MySQL', kind: 'database', images: ['mysql', 'mysql-server', 'mysql/community-server'] },
  { id: 'mariadb', name: 'MariaDB', kind: 'database', images: ['mariadb'] },
  { id: 'mongodb', name: 'MongoDB', kind: 'database', images: ['mongo', 'mongodb', 'mongodb-community-server'] },
  { id: 'cockroachdb', name: 'CockroachDB', kind: 'database', images: ['cockroach', 'cockroachdb'] },
  { id: 'clickhouse', name: 'ClickHouse', kind: 'database', images: ['clickhouse', 'clickhouse-server'] },
  { id: 'cassandra', name: 'Cassandra', kind: 'database', images: ['cassandra'] },
  { id: 'scylladb', name: 'ScyllaDB', kind: 'database', images: ['scylla', 'scylladb'] },
  { id: 'neo4j', name: 'Neo4j', kind: 'database', images: ['neo4j'] },
  { id: 'influxdb', name: 'InfluxDB', kind: 'database', images: ['influxdb'] },
  { id: 'couchdb', name: 'CouchDB', kind: 'database', images: ['couchdb'] },
  { id: 'surrealdb', name: 'SurrealDB', kind: 'database', images: ['surrealdb'] },
  { id: 'mssql', name: 'SQL Server', kind: 'database', images: ['mssql/server', 'azure-sql-edge'] },
  { id: 'dynamodb', name: 'DynamoDB', kind: 'database', images: ['dynamodb-local'] },
  // Caches
  {
    id: 'redis',
    name: 'Redis',
    kind: 'cache',
    images: ['redis', 'redis-stack', 'redis-stack-server', 'redis/redis-stack', 'redis/redis-stack-server'],
  },
  { id: 'valkey', name: 'Valkey', kind: 'cache', images: ['valkey'] },
  { id: 'keydb', name: 'KeyDB', kind: 'cache', images: ['keydb'] },
  { id: 'dragonfly', name: 'Dragonfly', kind: 'cache', images: ['dragonfly'] },
  { id: 'memcached', name: 'Memcached', kind: 'cache', images: ['memcached'] },
  // Queues and streaming
  { id: 'rabbitmq', name: 'RabbitMQ', kind: 'queue', images: ['rabbitmq'] },
  { id: 'nats', name: 'NATS', kind: 'queue', images: ['nats', 'nats-streaming'] },
  { id: 'kafka', name: 'Kafka', kind: 'queue', images: ['kafka', 'kafka-native', 'cp-kafka', 'cp-server'] },
  { id: 'redpanda', name: 'Redpanda', kind: 'queue', images: ['redpanda'] },
  { id: 'zookeeper', name: 'ZooKeeper', kind: 'other', images: ['zookeeper', 'cp-zookeeper'] },
  // Search
  { id: 'elasticsearch', name: 'Elasticsearch', kind: 'search', images: ['elasticsearch'] },
  { id: 'opensearch', name: 'OpenSearch', kind: 'search', images: ['opensearch'] },
  { id: 'meilisearch', name: 'Meilisearch', kind: 'search', images: ['meilisearch'] },
  { id: 'typesense', name: 'Typesense', kind: 'search', images: ['typesense'] },
  { id: 'solr', name: 'Solr', kind: 'search', images: ['solr'] },
  // Storage and cloud emulators
  { id: 'minio', name: 'MinIO', kind: 'storage', images: ['minio'] },
  { id: 'azurite', name: 'Azurite', kind: 'storage', images: ['azurite'] },
  { id: 'localstack', name: 'LocalStack', kind: 'other', images: ['localstack'] },
  // Mail catchers
  { id: 'mailpit', name: 'Mailpit', kind: 'mail', images: ['mailpit'] },
  { id: 'mailhog', name: 'MailHog', kind: 'mail', images: ['mailhog'] },
  { id: 'maildev', name: 'MailDev', kind: 'mail', images: ['maildev'] },
  { id: 'smtp4dev', name: 'smtp4dev', kind: 'mail', images: ['smtp4dev'] },
  // Proxies
  { id: 'nginx', name: 'nginx', kind: 'proxy', images: ['nginx', 'nginx-unprivileged'] },
  { id: 'traefik', name: 'Traefik', kind: 'proxy', images: ['traefik'] },
  { id: 'caddy', name: 'Caddy', kind: 'proxy', images: ['caddy'] },
  { id: 'haproxy', name: 'HAProxy', kind: 'proxy', images: ['haproxy'] },
  { id: 'envoy', name: 'Envoy', kind: 'proxy', images: ['envoy'] },
  // Observability
  { id: 'prometheus', name: 'Prometheus', kind: 'observability', images: ['prometheus'] },
  {
    id: 'grafana',
    name: 'Grafana',
    kind: 'observability',
    images: ['grafana', 'grafana-oss', 'grafana-enterprise', 'otel-lgtm'],
  },
  { id: 'jaeger', name: 'Jaeger', kind: 'observability', images: ['jaeger', 'jaegertracing/all-in-one'] },
  {
    id: 'opentelemetry-collector',
    name: 'OpenTelemetry Collector',
    kind: 'observability',
    images: ['opentelemetry-collector', 'opentelemetry-collector-contrib', 'opentelemetry-collector-k8s'],
  },
  { id: 'loki', name: 'Loki', kind: 'observability', images: ['loki'] },
  { id: 'tempo', name: 'Tempo', kind: 'observability', images: ['tempo'] },
  { id: 'zipkin', name: 'Zipkin', kind: 'observability', images: ['zipkin'] },
  { id: 'kibana', name: 'Kibana', kind: 'observability', images: ['kibana'] },
  // Other infrastructure and admin tools
  { id: 'keycloak', name: 'Keycloak', kind: 'other', images: ['keycloak'] },
  {
    id: 'temporal',
    name: 'Temporal',
    kind: 'other',
    images: ['temporalio/auto-setup', 'temporalio/server', 'temporalio/temporal'],
  },
  { id: 'adminer', name: 'Adminer', kind: 'other', images: ['adminer'] },
  { id: 'pgadmin', name: 'pgAdmin', kind: 'other', images: ['pgadmin4'] },
  { id: 'phpmyadmin', name: 'phpMyAdmin', kind: 'other', images: ['phpmyadmin'] },
]

const BY_IMAGE: ReadonlyMap<string, ImageRule> = new Map(
  IMAGE_RULES.flatMap((rule) => rule.images.map((image) => [image, rule] as const)),
)

/**
 * `${VAR:-default}` / `${VAR-default}` interpolation: recognition uses the default.
 * `[^}$]` stops at the next variable, so a flood of unterminated `${A:-` stays linear.
 */
const DEFAULTED_VARIABLE = /\$\{[A-Za-z_][A-Za-z0-9_]*:?-([^}$]*)\}/g

function isRegistryHost(segment: string): boolean {
  return segment.includes('.') || segment.includes(':') || segment === 'localhost' || segment.startsWith('$')
}

/**
 * Repository name of an image reference, lowercased, without registry host,
 * "library/" prefix, tag or digest:
 *
 *   "docker.io/library/postgres:17-alpine"            → "postgres"
 *   "docker.elastic.co/elasticsearch/elasticsearch:9" → "elasticsearch/elasticsearch"
 *   "localhost:5000/team/api@sha256:…"                → "team/api"
 */
export function imageRepository(image: string): string {
  let ref = image.trim().replace(DEFAULTED_VARIABLE, '$1').toLowerCase()
  const at = ref.indexOf('@')
  if (at !== -1) ref = ref.slice(0, at)
  // A tag can't contain "/", so its ":" is the first one after the last "/".
  const tag = ref.indexOf(':', ref.lastIndexOf('/') + 1)
  if (tag !== -1) ref = ref.slice(0, tag)
  const segments = ref.split('/').filter((segment) => segment !== '')
  if (segments.length > 1 && isRegistryHost(segments[0] as string)) segments.shift()
  if (segments.length > 1 && segments[0] === 'library') segments.shift()
  return segments.join('/')
}

/** Recognize well-known images (databases, caches, queues, proxies, …). Returns undefined for anything else. */
export function recognizeImage(image: string): ImageTechnology | undefined {
  const repository = imageRepository(image)
  if (repository === '') return undefined
  const rule = BY_IMAGE.get(repository) ?? BY_IMAGE.get(repository.slice(repository.lastIndexOf('/') + 1))
  return rule ? { id: rule.id, name: rule.name, kind: rule.kind } : undefined
}
