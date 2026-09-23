import { useOr } from '../core/context.ts'
import { getString, isRecord, toStringArray } from '../core/parse.ts'
import {
  type ComposeFiles,
  compareComposeFiles,
  compareDirectories,
  composeFiles,
  composeProjectOf,
} from '../facts/compose.ts'
import { cleanEchoedText, type Dockerfiles, dockerfiles, redactInterpolation } from '../facts/docker.ts'
import type { Detector, Dockerfile, PortMapping, Service, ServiceKind } from '../types.ts'
import { compareText } from '../utils/compare.ts'
import { dirOf } from '../utils/paths.ts'
import { redactCommand, sanitizeUrl } from '../utils/redact.ts'
import { cleanUntrusted } from '../utils/text.ts'
import { recognizeImage } from './knowledge/images.ts'

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** A literal port, a port range, or anything using ${VAR} interpolation. */
const PORT_VALUE = /^(?:\d+(?:-\d+)?|.*\$.*)$/
const PROTOCOL_SUFFIX = /^(.+)\/([A-Za-z]+)$/

function portValue(value: string): number | string {
  return /^\d+$/.test(value) ? Number(value) : value
}

/** Split "HOST_IP:HOST:CONTAINER" on colons outside ${…} and […] (IPv6). */
function splitPortSpec(spec: string): string[] {
  const parts: string[] = []
  let current = ''
  let braces = 0
  let brackets = 0
  for (const ch of spec) {
    if (ch === '{') braces++
    else if (ch === '}') braces = Math.max(0, braces - 1)
    else if (ch === '[') brackets++
    else if (ch === ']') brackets = Math.max(0, brackets - 1)
    if (ch === ':' && braces === 0 && brackets === 0) {
      parts.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  parts.push(current)
  return parts
}

function cleanPortValue<T extends number | string | null>(value: T): T {
  return (typeof value === 'string' ? cleanEchoedText(value) : value) as T
}

/** Port strings are echoed as written, so `${VAR:-default}` defaults and credential formats are redacted. */
function mapping(
  host: number | string | null,
  container: number | string,
  protocol: string,
  hostIp: string | undefined,
  raw: string,
): PortMapping {
  return {
    host: cleanPortValue(host),
    container: cleanPortValue(container),
    protocol,
    ...(hostIp ? { hostIp: cleanEchoedText(hostIp) } : {}),
    raw: cleanEchoedText(raw),
  }
}

function parseShortPort(value: string): PortMapping | null {
  const raw = value.trim()
  if (raw === '') return null
  let spec = raw
  let protocol = 'tcp'
  const withProtocol = PROTOCOL_SUFFIX.exec(raw)
  if (withProtocol?.[1] && withProtocol[2]) {
    spec = withProtocol[1]
    protocol = withProtocol[2].toLowerCase()
  }
  const parts = splitPortSpec(spec).map((part) => part.trim())
  const container = parts.pop()
  if (!container || !PORT_VALUE.test(container)) return null
  const host = parts.pop()
  if (host !== undefined && host !== '' && !PORT_VALUE.test(host)) return null
  const hostIp = parts.length > 0 ? parts.join(':').replace(/^\[(.*)\]$/, '$1') : undefined
  return mapping(host ? portValue(host) : null, portValue(container), protocol, hostIp || undefined, raw)
}

function longPortValue(value: unknown): number | string | null {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 ? value : null
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed !== '' && PORT_VALUE.test(trimmed) ? portValue(trimmed) : null
}

function parseLongPort(entry: Record<string, unknown>): PortMapping | null {
  const container = longPortValue(entry.target)
  if (container === null) return null
  const host = longPortValue(entry.published)
  const protocol = getString(entry, 'protocol')?.trim().toLowerCase() || 'tcp'
  // Same rule as the short syntax ("80/udp"): a protocol is a plain word, anything else is not a port entry.
  if (!/^[a-z]+$/.test(protocol)) return null
  const hostIp = getString(entry, 'host_ip')?.trim() || undefined
  // Rebuild the equivalent short syntax so every mapping has a comparable `raw`.
  const segments: string[] = []
  if (hostIp) segments.push(hostIp.includes(':') ? `[${hostIp}]` : hostIp)
  if (hostIp || host !== null) segments.push(host === null ? '' : String(host))
  segments.push(String(container))
  const raw = `${segments.join(':')}${protocol === 'tcp' ? '' : `/${protocol}`}`
  return mapping(host, container, protocol, hostIp, raw)
}

/**
 * Parse one Compose `ports` entry. Handles the short syntax ("3000",
 * "3000:3000", "127.0.0.1:5432:5432", "[::1]:6001:6001", "5432:5432/udp",
 * "8000-8002:8000-8002", "${PORT:-3000}:3000"), bare numbers and the long
 * syntax ({ target, published, host_ip, protocol }). Invalid entries yield [].
 */
export function parsePort(entry: unknown): PortMapping[] {
  if (typeof entry === 'number') {
    if (!Number.isInteger(entry) || entry < 0) return []
    return [mapping(null, entry, 'tcp', undefined, String(entry))]
  }
  const parsed = typeof entry === 'string' ? parseShortPort(entry) : isRecord(entry) ? parseLongPort(entry) : null
  return parsed ? [parsed] : []
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/

/**
 * Variable names from a Compose `environment` block (list of "KEY=value" /
 * "KEY", or a map). Values are discarded here and never leave this function.
 */
export function environmentNames(value: unknown): string[] {
  const names = new Set<string>()
  const add = (candidate: string) => {
    const name = candidate.trim()
    if (ENV_NAME.test(name)) names.add(name)
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== 'string') continue
      const eq = item.indexOf('=')
      add(eq === -1 ? item : item.slice(0, eq))
    }
  } else if (isRecord(value)) {
    for (const key of Object.keys(value)) add(key)
  }
  return [...names].sort(compareText)
}

/** Service, profile and dependency names are keys of a repository file: printable, one line. */
function cleanName(value: string): string {
  return cleanUntrusted(value, { oneLine: true })
}

/** Build contexts may be Git URLs; strip any credentials before echoing them. */
function cleanLocation(value: string): string {
  const trimmed = redactInterpolation(cleanUntrusted(value, { oneLine: true }))
  return /:\/\/|^git@/.test(trimmed) ? redactCommand(sanitizeUrl(trimmed)) : redactCommand(trimmed)
}

function scalarStrings(value: unknown): string[] {
  const items = Array.isArray(value) ? value : [value]
  const out: string[] = []
  for (const item of items) {
    if (typeof item === 'string' && item.trim() !== '') out.push(item.trim())
    else if (typeof item === 'number' && Number.isFinite(item)) out.push(String(item))
  }
  return out
}

function unique<T>(items: readonly T[], key: (item: T) => string = String): T[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const k = key(item)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

function readVolume(entry: unknown): string | null {
  if (typeof entry === 'string') return entry.trim() === '' ? null : cleanEchoedText(entry)
  if (!isRecord(entry)) return null
  const target = getString(entry, 'target')?.trim()
  if (!target) return null
  const source = getString(entry, 'source')?.trim()
  return cleanEchoedText(source ? `${source}:${target}` : target)
}

function readEnvFiles(value: unknown): string[] {
  const items = Array.isArray(value) ? value : [value]
  const out: string[] = []
  for (const item of items) {
    const path = typeof item === 'string' ? item : getString(item, 'path')
    if (path && path.trim() !== '') out.push(cleanEchoedText(path))
  }
  return out
}

function readDependsOn(value: unknown): string[] {
  const names = Array.isArray(value) ? toStringArray(value) : isRecord(value) ? Object.keys(value) : []
  return unique(names.map(cleanName).filter((name) => name !== '')).sort(compareText)
}

function hasHealthcheck(value: unknown): boolean {
  if (!isRecord(value) || value.disable === true) return false
  // `test: ["NONE"]` disables an image's built-in healthcheck.
  const test = value.test
  const first = Array.isArray(test) ? test[0] : test
  return first !== 'NONE'
}

function readBuild(value: unknown): { context?: string; dockerfile?: string } {
  if (typeof value === 'string') return value.trim() === '' ? {} : { context: cleanLocation(value) }
  if (!isRecord(value)) return {}
  const context = getString(value, 'context')
  const dockerfile = getString(value, 'dockerfile')
  const out: { context?: string; dockerfile?: string } = {
    context: context && context.trim() !== '' ? cleanLocation(context) : '.',
  }
  if (dockerfile && dockerfile.trim() !== '') out.dockerfile = cleanEchoedText(dockerfile)
  return out
}

/** Recognized technology and kind of a service: known image first, then "app" for locally built services. */
export function classifyService(service: Pick<Service, 'image' | 'build'>): Pick<Service, 'technology' | 'kind'> {
  const technology = service.image ? recognizeImage(service.image) : undefined
  if (technology) return { technology: { id: technology.id, name: technology.name }, kind: technology.kind }
  const kind: ServiceKind = service.build !== undefined ? 'app' : 'other'
  return { kind }
}

type ServiceFields = Omit<Service, 'kind' | 'technology'>

/** Build a Service with a canonical key order so JSON output stays stable. */
function makeService(fields: ServiceFields): Service {
  const { technology, kind } = classifyService(fields)
  return {
    name: fields.name,
    source: fields.source,
    ...(fields.image !== undefined ? { image: fields.image } : {}),
    ...(fields.build !== undefined ? { build: fields.build } : {}),
    ...(fields.dockerfile !== undefined ? { dockerfile: fields.dockerfile } : {}),
    ...(technology ? { technology } : {}),
    kind,
    ports: fields.ports,
    expose: fields.expose,
    dependsOn: fields.dependsOn,
    volumes: fields.volumes,
    environment: fields.environment,
    envFiles: fields.envFiles,
    profiles: fields.profiles,
    healthcheck: fields.healthcheck,
  }
}

/** Parse one service definition. Environment values are dropped; only names are kept. */
export function parseComposeService(name: string, definition: Record<string, unknown>, source: string): Service {
  const image = getString(definition, 'image')
  const build = definition.build === undefined ? {} : readBuild(definition.build)
  const ports = Array.isArray(definition.ports) ? definition.ports.flatMap(parsePort) : []
  const fields: ServiceFields = {
    name: cleanName(name),
    source,
    ports: unique(ports, (port) => port.raw),
    expose: unique(scalarStrings(definition.expose).map(cleanEchoedText)),
    dependsOn: readDependsOn(definition.depends_on),
    volumes: unique(
      (Array.isArray(definition.volumes) ? definition.volumes : [])
        .map(readVolume)
        .filter((v): v is string => v !== null),
    ),
    environment: environmentNames(definition.environment),
    envFiles: unique(readEnvFiles(definition.env_file)),
    profiles: unique(
      toStringArray(definition.profiles)
        .map(cleanName)
        .filter((p) => p !== ''),
    ).sort(compareText),
    healthcheck: hasHealthcheck(definition.healthcheck),
  }
  if (image && image.trim() !== '') fields.image = cleanEchoedText(image)
  if (build.context !== undefined) fields.build = build.context
  if (build.dockerfile !== undefined) fields.dockerfile = build.dockerfile
  return makeService(fields)
}

/** Services declared in a parsed Compose document, in declaration order. */
export function parseComposeServices(doc: unknown, source: string): Service[] {
  if (!isRecord(doc) || !isRecord(doc.services)) return []
  const services: Service[] = []
  for (const [name, definition] of Object.entries(doc.services)) {
    if (isRecord(definition)) services.push(parseComposeService(name, definition, source))
  }
  return services
}

function mergeService(base: Service, other: Service): Service {
  return makeService({
    name: base.name,
    source: base.source,
    ...(base.image !== undefined || other.image !== undefined ? { image: base.image ?? other.image } : {}),
    ...(base.build !== undefined || other.build !== undefined ? { build: base.build ?? other.build } : {}),
    ...(base.dockerfile !== undefined || other.dockerfile !== undefined
      ? { dockerfile: base.dockerfile ?? other.dockerfile }
      : {}),
    ports: unique([...base.ports, ...other.ports], (port) => port.raw),
    expose: unique([...base.expose, ...other.expose]),
    dependsOn: unique([...base.dependsOn, ...other.dependsOn]).sort(compareText),
    volumes: unique([...base.volumes, ...other.volumes]),
    environment: unique([...base.environment, ...other.environment]).sort(compareText),
    envFiles: unique([...base.envFiles, ...other.envFiles]),
    profiles: unique([...base.profiles, ...other.profiles]).sort(compareText),
    healthcheck: base.healthcheck || other.healthcheck,
  })
}

/**
 * Merge services with the same name that run as one Compose project: a
 * directory's base file and its default override file (compose.yaml +
 * docker-compose.override.yml), the way `docker compose` combines them.
 * Variant files (compose.prod.yaml) are used on their own with `-f`, so their
 * services stay separate, with their own source: a production-only `app`
 * must not change what the development `app` looks like. Input must be in
 * compose-file order; the first file that declares a service becomes its
 * `source`. Output is sorted by directory (root first), service name, then
 * Compose file.
 */
export function mergeServices(services: readonly Service[]): Service[] {
  const merged = new Map<string, Service>()
  for (const service of services) {
    const key = `${composeProjectOf(service.source)}\0${service.name}`
    const existing = merged.get(key)
    merged.set(key, existing ? mergeService(existing, service) : service)
  }
  return [...merged.values()].sort(
    (a, b) =>
      compareDirectories(dirOf(a.source), dirOf(b.source)) ||
      compareText(a.name, b.name) ||
      compareComposeFiles(a.source, b.source),
  )
}

/** Dockerfiles as listed in the services section: base image per stage (stage references included), ARG names only. */
export function listDockerfiles(found: Dockerfiles): Dockerfile[] {
  return found.files.map((file) => ({
    path: file.path,
    baseImages: file.stages.map((stage) => stage.image),
    stages: file.stages.length,
    exposes: file.exposes,
    args: file.args,
  }))
}

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

const NO_COMPOSE: ComposeFiles = { files: [], envFiles: [] }
const NO_DOCKERFILES: Dockerfiles = { files: [], truncated: false }

export const servicesDetector: Detector<'services'> = {
  id: 'services',
  title: 'Docker services',
  async run(ctx) {
    const [compose, found] = await Promise.all([
      useOr(ctx, composeFiles, NO_COMPOSE),
      useOr(ctx, dockerfiles, NO_DOCKERFILES),
    ])
    const declared = compose.files.flatMap((file) => {
      if (file.doc !== null && !isRecord(file.doc)) ctx.debug(`services: ${file.path} is not a Compose mapping`)
      return parseComposeServices(file.doc, file.path)
    })
    return {
      composeFiles: compose.files.map((file) => file.path),
      services: mergeServices(declared),
      dockerfiles: listDockerfiles(found),
    }
  },
}
