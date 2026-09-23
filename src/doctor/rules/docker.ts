import { isRecord } from '../../core/parse.ts'
import { ALWAYS_IGNORED_DIRS } from '../../core/walker.ts'
import {
  type ComposeFile,
  type ComposeFiles,
  composeFiles,
  composeProjectOf,
  type EnvFileReference,
  findComposeFiles,
} from '../../facts/compose.ts'
import type {
  Diagnostic,
  DoctorRule,
  EnvironmentSection,
  FileIndex,
  PortMapping,
  ProjectContext,
  Service,
  Severity,
} from '../../types.ts'
import { shellQuote } from '../../utils/commands.ts'
import { compareText } from '../../utils/compare.ts'
import { baseName, dirOf, joinPath } from '../../utils/paths.ts'
import { formatLimitedList, formatList, safeText, uniqueSorted } from './shared.ts'

/**
 * Compose files the checks read, parsed once by the shared compose-files fact.
 * The fact reads the file index itself, so the checks work even when the
 * services detector failed. Files that failed to parse are left out (the
 * parse failure is its own scan warning).
 */
async function parsedComposeFiles(ctx: ProjectContext): Promise<ComposeFiles> {
  const found = await ctx.use(composeFiles)
  return { ...found, files: found.files.filter((file) => file.doc !== null) }
}

/**
 * The checks have something to read: a Compose file exists and at least one
 * of them parsed (a "parse" scan warning names the ones that did not).
 */
function hasReadableComposeFile(ctx: ProjectContext): boolean {
  const failed = new Set(ctx.warnings.filter((warning) => warning.kind === 'parse').map((warning) => warning.file))
  return findComposeFiles(ctx.files.files).some((file) => !failed.has(file))
}

// ---------------------------------------------------------------------------
// Port conflicts
// ---------------------------------------------------------------------------

/** Literal host port, or null for unpublished, interpolated (${PORT}) or ranged ports. */
export function numericPort(host: PortMapping['host']): number | null {
  const port = typeof host === 'number' ? host : typeof host === 'string' && /^\d{1,5}$/.test(host) ? Number(host) : NaN
  // Port 0 asks Docker for an ephemeral port, which never clashes.
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null
}

function normalizeIp(ip: string | undefined): string {
  const trimmed = (ip ?? '').trim().replace(/^\[|\]$/g, '')
  return trimmed === '' || trimmed === '0.0.0.0' || trimmed === '::' ? '*' : trimmed
}

/** An unspecified or wildcard host IP binds every interface, so it overlaps any other binding. */
export function ipsOverlap(a: string | undefined, b: string | undefined): boolean {
  const left = normalizeIp(a)
  const right = normalizeIp(b)
  return left === '*' || right === '*' || left === right
}

interface Binding {
  service: Service
  hostIp: string | undefined
  container: PortMapping['container']
}

/**
 * The first clashing binding of every service that shares the port with
 * another service on an overlapping host IP. The same service in a base file
 * and its override is one service. Linear in the number of bindings: a
 * hostile Compose file can declare tens of thousands of services.
 */
function clashingBindings(bindings: readonly Binding[]): Map<string, Binding> {
  const allNames = new Set<string>()
  const namesByIp = new Map<string, Set<string>>()
  for (const binding of bindings) {
    const ip = normalizeIp(binding.hostIp)
    const names = namesByIp.get(ip) ?? new Set<string>()
    names.add(binding.service.name)
    namesByIp.set(ip, names)
    allNames.add(binding.service.name)
  }
  const wildcard = namesByIp.get('*') ?? new Set<string>()
  const clashes = (binding: Binding): boolean => {
    const ip = normalizeIp(binding.hostIp)
    // A wildcard binding overlaps every binding of every other service.
    if (ip === '*') return allNames.size > 1
    if ((namesByIp.get(ip)?.size ?? 0) > 1) return true
    return wildcard.size > 1 || (wildcard.size === 1 && !wildcard.has(binding.service.name))
  }
  const involved = new Map<string, Binding>()
  for (const binding of bindings) {
    if (!involved.has(binding.service.name) && clashes(binding)) involved.set(binding.service.name, binding)
  }
  return involved
}

export function findPortConflicts(services: readonly Service[]): Diagnostic[] {
  const groups = new Map<string, { project: string; port: number; protocol: string; bindings: Binding[] }>()
  for (const service of services) {
    for (const mapping of service.ports) {
      const port = numericPort(mapping.host)
      if (port === null) continue
      const protocol = (mapping.protocol || 'tcp').toLowerCase()
      const project = composeProjectOf(service.source)
      const key = `${project}\0${port}\0${protocol}`
      const group = groups.get(key) ?? { project, port, protocol, bindings: [] }
      group.bindings.push({ service, hostIp: mapping.hostIp, container: mapping.container })
      groups.set(key, group)
    }
  }

  const out: Diagnostic[] = []
  for (const { project, port, protocol, bindings } of groups.values()) {
    const involved = clashingBindings(bindings)
    if (involved.size < 2) continue
    const names = [...involved.keys()].sort(compareText)
    const files = uniqueSorted([...involved.values()].map((binding) => binding.service.source))
    const profiledNames = names.filter((name) => (involved.get(name)?.service.profiles.length ?? 0) > 0)
    // Service names are keys of a repository file: cap their length before echoing them.
    const shown = names.map((name) => safeText(name, 60))
    const profiled = profiledNames.map((name) => safeText(name, 60))
    const severity: Severity = profiled.length > 0 ? 'warning' : 'error'
    const label = protocol === 'tcp' ? String(port) : `${port}/${protocol}`
    const last = involved.get(names[names.length - 1] as string)
    const suggested = port < 65535 ? port + 1 : port - 1
    const example = `"${suggested}:${last ? safeText(String(last.container), 40) : port}"`
    out.push({
      code: 'DOCKER_PORT_CONFLICT',
      severity,
      category: 'docker',
      message: `Services ${formatLimitedList(shown)}${files.length === 1 ? ` in ${files[0]}` : ''} ${names.length === 2 ? 'both' : 'all'} publish host port ${label}`,
      hint:
        profiled.length > 0
          ? `Give each service its own host port, e.g. ${example}; the clash only happens when ${formatLimitedList(profiled)} ${profiled.length === 1 ? 'is' : 'are'} started with ${profiled.length === 1 ? 'its profile' : 'their profiles'}`
          : `Give each service its own host port, e.g. ${example}, or only one of them can start`,
      files,
      // Other Compose projects can clash on the same port; keep one subject per project.
      subject: project === '.' ? `${port}/${protocol}` : `${files[0]}:${port}/${protocol}`,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Compose file contents
// ---------------------------------------------------------------------------

export function hasObsoleteVersionKey(doc: unknown): boolean {
  return isRecord(doc) && Object.hasOwn(doc, 'version')
}

export function findObsoleteVersionKeys(documents: readonly Pick<ComposeFile, 'path' | 'doc'>[]): Diagnostic[] {
  return documents
    .filter((document) => hasObsoleteVersionKey(document.doc))
    .map(
      (document): Diagnostic => ({
        code: 'COMPOSE_VERSION_OBSOLETE',
        severity: 'info',
        category: 'docker',
        message: `${document.path} sets the obsolete top-level "version" key`,
        hint: 'Remove the "version" line; Docker Compose ignores it and prints a warning on every run',
        files: [document.path],
        subject: document.path,
      }),
    )
}

/**
 * Whether a referenced file is known to be missing. Files inside directories
 * RepoLens never walks (ignored or always-skipped directories, below the depth
 * limit) are unknown, so they are not reported.
 */
export function isKnownMissing(files: FileIndex, path: string, maxDepth: number): boolean {
  if (files.has(path, { includeIgnored: true })) return false
  const segments = path.split('/')
  if (segments.length - 1 > maxDepth) return false
  for (let i = 1; i < segments.length; i++) {
    const dir = segments.slice(0, i).join('/')
    if (ALWAYS_IGNORED_DIRS.has(segments[i - 1] as string) || files.isIgnored(dir, { directory: true })) return false
  }
  return true
}

const EXAMPLE_SUFFIXES = ['.example', '.sample', '.template', '.dist']

function exampleFor(files: FileIndex, path: string): string | undefined {
  const candidates = EXAMPLE_SUFFIXES.map((suffix) => `${path}${suffix}`)
  if (baseName(path) !== '.env') candidates.push(joinPath(dirOf(path), '.env.example'))
  return candidates.find((candidate) => files.has(candidate))
}

/** Missing env_file entries; entries marked `required: false` are skipped, Compose tolerates those. */
export function findMissingEnvFiles(
  references: readonly EnvFileReference[],
  files: FileIndex,
  maxDepth: number,
): Diagnostic[] {
  const groups = new Map<string, EnvFileReference[]>()
  for (const reference of references) {
    if (reference.required === false) continue
    const group = groups.get(reference.path)
    if (group) group.push(reference)
    else groups.set(reference.path, [reference])
  }
  const out: Diagnostic[] = []
  for (const [missing, group] of groups) {
    if (!isKnownMissing(files, missing, maxDepth)) continue
    const composeFiles = uniqueSorted(group.map((reference) => reference.composeFile))
    // Name the Compose file once when every reference comes from it, otherwise per service.
    const services = uniqueSorted(
      group.map((reference) => {
        const name = safeText(reference.service, 60)
        return composeFiles.length === 1 ? name : `${name} (${reference.composeFile})`
      }),
    )
    const where = composeFiles.length === 1 ? ` in ${composeFiles[0]}` : ''
    const path = safeText(missing)
    const example = exampleFor(files, missing)
    out.push({
      code: 'COMPOSE_ENV_FILE_MISSING',
      severity: 'warning',
      category: 'docker',
      message: `${services.length === 1 ? 'Service' : 'Services'} ${formatLimitedList(services)}${where} ${services.length === 1 ? 'loads' : 'load'} env_file ${path}, which does not exist`,
      hint: example
        ? `Run \`cp ${shellQuote(example)} ${shellQuote(missing)}\` and fill in the values, or mark the entry optional with required: false`
        : `Create ${path}, or mark the entry optional with required: false`,
      files: composeFiles,
      subject: path,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Env URLs vs published ports
// ---------------------------------------------------------------------------

const REDIS_LIKE = ['redis', 'valkey', 'keydb', 'dragonfly', 'dragonflydb']

/** URL scheme → technology ids of Compose services that serve it. */
const SCHEME_TECHNOLOGIES: Readonly<Record<string, readonly string[]>> = {
  postgres: ['postgresql'],
  postgresql: ['postgresql'],
  mysql: ['mysql', 'mariadb'],
  mariadb: ['mariadb', 'mysql'],
  mongodb: ['mongodb'],
  redis: REDIS_LIKE,
  rediss: REDIS_LIKE,
}

/** "postgresql+asyncpg" → "postgresql". */
function baseScheme(scheme: string): string {
  return scheme.toLowerCase().split('+')[0] ?? ''
}

interface Publisher {
  service: Service
  /** Literal host ports, ascending. */
  published: number[]
}

interface PortMismatch {
  file: string
  port: number
  publisher: Publisher
}

/**
 * Services of the given technologies that publish literal host ports, by
 * name. Null when one of them publishes an interpolated or ranged port, which
 * could be anything.
 */
function publishersOf(services: readonly Service[], technologies: readonly string[]): Publisher[] | null {
  const matching = services
    .filter((service) => service.technology && technologies.includes(service.technology.id))
    .sort((a, b) => compareText(a.name, b.name))
  if (matching.some((s) => s.ports.some((p) => p.host !== null && numericPort(p.host) === null))) return null
  return matching
    .map((service) => {
      const ports = new Set<number>()
      for (const mapping of service.ports) {
        const port = numericPort(mapping.host)
        if (port !== null) ports.add(port)
      }
      return { service, published: [...ports].sort((a, b) => a - b) }
    })
    .filter((entry) => entry.published.length > 0)
}

const MAX_LISTED_PORTS = 5

export function findEnvPortMismatches(env: EnvironmentSection, services: readonly Service[]): Diagnostic[] {
  // Publishers depend only on the scheme, so compute them once per scheme instead of per endpoint.
  const publishersByScheme = new Map<string, Publisher[] | null>()
  const publishersFor = (scheme: string): Publisher[] | null => {
    if (!Object.hasOwn(SCHEME_TECHNOLOGIES, scheme)) return null
    let publishers = publishersByScheme.get(scheme)
    if (publishers === undefined) {
      publishers = publishersOf(services, SCHEME_TECHNOLOGIES[scheme] as readonly string[])
      publishersByScheme.set(scheme, publishers)
    }
    return publishers
  }

  const out: Diagnostic[] = []
  for (const variable of env.variables) {
    const mismatches: PortMismatch[] = []
    for (const endpoint of variable.endpoints) {
      const port = endpoint.port
      if (!endpoint.local || port === null) continue
      const publishers = publishersFor(baseScheme(endpoint.scheme))
      if (!publishers?.[0] || publishers.some((entry) => entry.published.includes(port))) continue
      mismatches.push({ file: endpoint.file, port, publisher: publishers[0] })
    }
    const first = mismatches[0]
    if (!first) continue
    const { service, published } = first.publisher
    const serviceName = safeText(service.name, 60)
    const listed = published.slice(0, MAX_LISTED_PORTS).map(String)
    const ports = published.length > MAX_LISTED_PORTS ? `${listed.join(', ')}, …` : formatList(listed, 'or')
    out.push({
      code: 'ENV_PORT_MISMATCH',
      severity: 'warning',
      category: 'docker',
      message: `${variable.name} in ${first.file} uses port ${first.port}, but the ${serviceName} service publishes ${ports}`,
      hint: `Use port ${published[0]} in ${first.file}, or publish ${first.port} from the ${serviceName} service in ${service.source}`,
      files: uniqueSorted([...mismatches.map((m) => m.file), service.source]),
      subject: variable.name,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export const dockerPortConflict: DoctorRule = {
  code: 'DOCKER_PORT_CONFLICT',
  category: 'docker',
  title: 'Compose services publish distinct host ports',
  applies: (scan) => scan.services.services.filter((service) => service.ports.length > 0).length > 1,
  check: (scan) => findPortConflicts(scan.services.services),
}

export const composeVersionObsolete: DoctorRule = {
  code: 'COMPOSE_VERSION_OBSOLETE',
  category: 'docker',
  title: 'Compose files omit the obsolete version key',
  applies: (_scan, ctx) => hasReadableComposeFile(ctx),
  async check(_scan, ctx) {
    return findObsoleteVersionKeys((await parsedComposeFiles(ctx)).files)
  },
}

export const composeEnvFileMissing: DoctorRule = {
  code: 'COMPOSE_ENV_FILE_MISSING',
  category: 'docker',
  title: 'Compose env_file entries exist',
  applies: (_scan, ctx) => hasReadableComposeFile(ctx),
  async check(_scan, ctx) {
    if (ctx.files.truncated) return []
    const { envFiles } = await parsedComposeFiles(ctx)
    return findMissingEnvFiles(envFiles, ctx.files, ctx.options.maxDepth)
  },
}

export const envPortMismatch: DoctorRule = {
  code: 'ENV_PORT_MISMATCH',
  category: 'docker',
  title: 'Env URLs point at published service ports',
  applies: (scan) =>
    scan.services.services.some((service) => service.ports.length > 0) &&
    scan.environment.variables.some((variable) => variable.endpoints.length > 0),
  check: (scan) => findEnvPortMismatches(scan.environment, scan.services.services),
}

export const dockerRules: DoctorRule[] = [
  dockerPortConflict,
  composeEnvFileMissing,
  envPortMismatch,
  composeVersionObsolete,
]
