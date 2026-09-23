import { useOr } from '../core/context.ts'
import { getString, isRecord } from '../core/parse.ts'
import type { DependencyIndex, DependencyRef } from '../facts/dependencies.ts'
import { dependencies } from '../facts/dependencies.ts'
import { manifests } from '../facts/manifests.ts'
import { createOwnerResolver, MAX_SOURCE_FILE_BYTES, sourceFiles } from '../facts/source-files.ts'
import type {
  Confidence,
  Database,
  DatabasesSection,
  Detector,
  EnvVariable,
  ProjectContext,
  Service,
  Tool,
} from '../types.ts'
import { compareText } from '../utils/compare.ts'
import { mapLimit } from '../utils/limit.ts'
import { isTestFileName, isUnder, NON_PROJECT_ROLES } from '../utils/path-roles.ts'
import { baseName, extOf } from '../utils/paths.ts'
import { redactCommand, sanitizeUrl } from '../utils/redact.ts'
import { environmentDetector } from './environment.ts'
import {
  DATABASE_CONFIG_FILE,
  DATABASES,
  DRIZZLE_DIALECTS,
  ENV_NAME_PATTERNS,
  ENV_SCHEMES,
  GO_DRIVERS,
  NODE_DRIVERS,
  ORMS,
  PRISMA_PROVIDERS,
  SQLC_ENGINES,
  TYPEORM_TYPES,
} from './knowledge/databases.ts'
import {
  configEvidence,
  displayVersion,
  type Signal,
  dependencyEvidence as toolDependencyEvidence,
} from './knowledge/signals.ts'
import { toolFromSignals } from './knowledge/tools.ts'
import { servicesDetector } from './services.ts'

type DatabaseSource = Database['sources'][number]

export interface DatabaseConfigs {
  prismaProviders: Array<{ file: string; provider: string }>
  drizzleDialects: Array<{ file: string; dialect: string }>
  sqlcEngines: Array<{ file: string; engine: string }>
  typeormTypes: Array<{ file: string; type: string }>
}

export interface DatabaseInferenceInput {
  dependencies: readonly DependencyRef[]
  services: readonly Service[]
  envVariables: readonly EnvVariable[]
  configs: DatabaseConfigs
  /** Database-related config files (drizzle.config.ts, knexfile.js, sqlc.yaml, …) used to attribute ORMs. */
  configFiles?: readonly string[]
  /** Package directory owning a file ("." = root); attributes config files to packages. Defaults to the root. */
  ownerOf?: (file: string) => string
}

/** Evidence strings kept per database, strongest first (ORMs follow the shared tool limit). */
export const MAX_EVIDENCE = 10
const MAX_CONFIG_READS = 50
const MAX_TYPEORM_SCAN_FILES = 5_000
const READ_CONCURRENCY = 16

const RANK: Record<Confidence, number> = { high: 2, medium: 1, low: 0 }

function unique(items: readonly string[]): string[] {
  return [...new Set(items)]
}

// ---------------------------------------------------------------------------
// Inference (pure)
// ---------------------------------------------------------------------------

interface Finding {
  id: string
  source: DatabaseSource
  confidence: Confidence
  evidence: string
}

/** Go module path without its major-version suffix ("github.com/jackc/pgx/v5" → "github.com/jackc/pgx"). */
export function goModuleBase(path: string): string {
  return path.replace(/\/v\d+$/, '')
}

/** Declared range for evidence strings, with URL credentials and credential formats removed. */
export function displayRange(range: string): string {
  const trimmed = range.trim()
  return redactCommand(/:\/\//.test(trimmed) ? sanitizeUrl(trimmed) : trimmed)
}

function dependencyEvidence(ref: DependencyRef): string {
  const range = displayRange(ref.range)
  return `dependency ${ref.name}${range ? `@${range}` : ''} in ${ref.file}`
}

/** Go `// indirect` requirements are transitive and say nothing about what the project uses. */
function isDirect(ref: DependencyRef): boolean {
  return !(ref.ecosystem === 'go' && ref.indirect === true)
}

function isRuntimeDependency(ref: DependencyRef): boolean {
  return ref.type === 'dependencies' || (ref.type === 'go' && ref.indirect !== true)
}

/** Driver database id for a dependency, or undefined. */
export function driverDatabase(ref: Pick<DependencyRef, 'name' | 'ecosystem'>): string | undefined {
  return ref.ecosystem === 'go' ? GO_DRIVERS.get(goModuleBase(ref.name)) : NODE_DRIVERS.get(ref.name)
}

function dockerFindings(services: readonly Service[]): Finding[] {
  const findings: Finding[] = []
  for (const service of services) {
    const id = service.technology?.id
    if (!id || !DATABASES.has(id)) continue
    const image = service.image ? ` (${service.image})` : ''
    findings.push({
      id,
      source: 'docker',
      confidence: 'high',
      evidence: `${service.name} service${image} in ${service.source}`,
    })
  }
  return findings
}

function configFindings(configs: DatabaseConfigs): Finding[] {
  const findings: Finding[] = []
  const add = (
    map: ReadonlyMap<string, string>,
    value: string,
    confidence: Confidence,
    describe: (value: string) => string,
  ) => {
    const id = map.get(value.trim().toLowerCase())
    // Only known values are echoed, never arbitrary text from the file.
    if (id) findings.push({ id, source: 'config', confidence, evidence: describe(value.trim().toLowerCase()) })
  }
  for (const { file, provider } of configs.prismaProviders) {
    add(PRISMA_PROVIDERS, provider, 'high', (v) => `Prisma datasource provider "${v}" in ${file}`)
  }
  for (const { file, dialect } of configs.drizzleDialects) {
    add(DRIZZLE_DIALECTS, dialect, 'high', (v) => `Drizzle dialect "${v}" in ${file}`)
  }
  for (const { file, engine } of configs.sqlcEngines) {
    add(SQLC_ENGINES, engine, 'high', (v) => `sqlc engine "${v}" in ${file}`)
  }
  for (const { file, type } of configs.typeormTypes) {
    add(TYPEORM_TYPES, type, 'medium', (v) => `TypeORM type "${v}" in ${file}`)
  }
  return findings
}

function dependencyFindings(refs: readonly DependencyRef[]): Finding[] {
  const findings: Finding[] = []
  for (const ref of refs) {
    if (!isDirect(ref)) continue
    const id = driverDatabase(ref)
    if (!id) continue
    findings.push({
      id,
      source: 'dependency',
      confidence: isRuntimeDependency(ref) ? 'high' : 'medium',
      evidence: dependencyEvidence(ref),
    })
  }
  return findings
}

/** Database id suggested by a variable name alone (REDIS_URL, PGHOST, MYSQL_DATABASE, …). */
export function databaseFromEnvName(name: string): string | undefined {
  return ENV_NAME_PATTERNS.find(({ pattern }) => pattern.test(name))?.id
}

function envFindings(variables: readonly EnvVariable[]): Finding[] {
  const findings: Finding[] = []
  for (const variable of variables) {
    let fromEndpoint = false
    for (const endpoint of variable.endpoints) {
      const scheme = endpoint.scheme.toLowerCase()
      // Driver-qualified schemes ("postgresql+asyncpg", "mysql+pymysql") name the database before the "+".
      const id = ENV_SCHEMES.get(scheme) ?? ENV_SCHEMES.get(scheme.split('+')[0] ?? '')
      if (!id) continue
      fromEndpoint = true
      findings.push({
        id,
        source: 'env',
        confidence: 'medium',
        evidence: `${variable.name} holds a ${scheme}:// URL in ${endpoint.file}`,
      })
    }
    if (fromEndpoint) continue
    const id = databaseFromEnvName(variable.name)
    if (id) findings.push({ id, source: 'env', confidence: 'low', evidence: `environment variable ${variable.name}` })
  }
  return findings
}

function rankEvidence(items: ReadonlyArray<{ confidence: Confidence; evidence: string }>): string[] {
  // Array.prototype.sort is stable, so equal-confidence evidence keeps discovery order.
  const sorted = [...items].sort((a, b) => RANK[b.confidence] - RANK[a.confidence])
  return unique(sorted.map((item) => item.evidence)).slice(0, MAX_EVIDENCE)
}

function maxConfidence(items: ReadonlyArray<{ confidence: Confidence }>): Confidence {
  let best: Confidence = 'low'
  for (const item of items) if (RANK[item.confidence] > RANK[best]) best = item.confidence
  return best
}

/** Confidence (strongest first), then display name ignoring case ("libSQL" between "DynamoDB" and "MySQL"). */
function compareFindings(a: { confidence: Confidence; name: string }, b: { confidence: Confidence; name: string }) {
  return (
    RANK[b.confidence] - RANK[a.confidence] ||
    compareText(a.name.toLowerCase(), b.name.toLowerCase()) ||
    compareText(a.name, b.name)
  )
}

function aggregateDatabases(findings: readonly Finding[]): Database[] {
  const byId = new Map<string, Finding[]>()
  for (const finding of findings) {
    if (!DATABASES.has(finding.id)) continue
    const list = byId.get(finding.id)
    if (list) list.push(finding)
    else byId.set(finding.id, [finding])
  }
  const databases: Database[] = []
  for (const [id, list] of byId) {
    const info = DATABASES.get(id)
    if (!info) continue
    databases.push({
      id,
      name: info.name,
      kind: info.kind,
      sources: unique(list.map((finding) => finding.source)).sort(compareText) as DatabaseSource[],
      confidence: maxConfidence(list),
      evidence: rankEvidence(list),
    })
  }
  return databases.sort(compareFindings)
}

/** Does a dependency name match one of an ORM's packages (Go paths compared without "/vN")? */
function matchesPackage(ref: DependencyRef, packages: readonly string[]): boolean {
  return packages.includes(ref.ecosystem === 'go' ? goModuleBase(ref.name) : ref.name)
}

/** Without a package resolver: the deepest package declaring a dependency that contains the file, else the root. */
function declaringPackageOf(refs: readonly DependencyRef[]): (file: string) => string {
  const dirs = [...new Set(refs.map((ref) => ref.package))].filter((dir) => dir !== '.')
  return (file) =>
    dirs
      .filter((dir) => file.startsWith(`${dir}/`))
      .reduce((best, dir) => (best === '.' || dir.length > best.length ? dir : best), '.')
}

/**
 * ORMs, query builders and SQL code generators, from dependencies and config
 * files. Built from the same signals as every other tool: a runtime
 * dependency is conclusive, a devDependency or config file alone is medium,
 * both together (or the config of a code generator such as sqlc) are high.
 */
export function inferOrms(
  refs: readonly DependencyRef[],
  configFiles: readonly string[],
  configs: Pick<DatabaseConfigs, 'prismaProviders'> = { prismaProviders: [] },
  ownerOf: (file: string) => string = declaringPackageOf(refs),
): Tool[] {
  const tools: Tool[] = []
  for (const orm of ORMS) {
    // Package order decides which declaration supplies the version: @prisma/client before prisma.
    const declared = orm.packages.flatMap((name) => refs.filter((ref) => isDirect(ref) && matchesPackage(ref, [name])))
    const files = configFiles.filter((file) => orm.configFile?.test(baseName(file)) === true)
    if (orm.id === 'prisma') {
      files.push(...configs.prismaProviders.map(({ file }) => file))
      files.push(...configFiles.filter((file) => baseName(file) === 'schema.prisma'))
    }
    const configList = unique(files).sort(compareText)
    if (declared.length === 0 && configList.length === 0) continue

    const signals: Signal[] = declared.map((ref) => {
      const signal: Signal = {
        package: ref.package,
        confidence: isRuntimeDependency(ref) ? 'high' : 'medium',
        evidence: toolDependencyEvidence(ref),
      }
      const version = displayVersion(ref.range)
      if (version !== undefined) signal.version = version
      return signal
    })
    // A config file confirms a declared dependency, and is all a code generator has.
    const configConfidence: Confidence = declared.length > 0 || orm.configOnly ? 'high' : 'medium'
    for (const file of configList) {
      signals.push({
        package: ownerOf(file),
        confidence: configConfidence,
        evidence: configEvidence(file),
        configFile: file,
      })
    }
    const tool = toolFromSignals({ id: orm.id, name: orm.name, kind: 'orm' }, signals)
    if (tool) tools.push(tool)
  }
  return tools.sort(compareFindings)
}

/**
 * Databases the project uses, combining Docker services, ORM/database config,
 * driver dependencies and environment variables. A database's confidence is
 * the strongest of its signals; databases are ordered by confidence, then name.
 */
export function inferDatabases(input: DatabaseInferenceInput): DatabasesSection {
  const findings = [
    ...dockerFindings(input.services),
    ...configFindings(input.configs),
    ...dependencyFindings(input.dependencies),
    ...envFindings(input.envVariables),
  ]
  return {
    databases: aggregateDatabases(findings),
    orms: inferOrms(input.dependencies, input.configFiles ?? [], input.configs, input.ownerOf),
  }
}

// ---------------------------------------------------------------------------
// Config extraction (pure)
// ---------------------------------------------------------------------------

const PRISMA_PROVIDER = /\bprovider\s*=\s*"([^"]+)"/

/** `provider` values of `datasource` blocks in a Prisma schema. */
export function extractPrismaProviders(text: string): string[] {
  const code = text.replace(/\/\/.*$/gm, '')
  const providers: string[] = []
  // Resume after each block's closing brace: rescanning from every `datasource … {` is quadratic on hostile input.
  const blocks = /\bdatasource\s+\w+\s*\{/g
  for (let match = blocks.exec(code); match; match = blocks.exec(code)) {
    const start = match.index + match[0].length
    const end = code.indexOf('}', start)
    if (end === -1) break
    const provider = PRISMA_PROVIDER.exec(code.slice(start, end))?.[1]
    if (provider) providers.push(provider)
    blocks.lastIndex = end + 1
  }
  return unique(providers)
}

/**
 * Remove `//` and block comments from JavaScript/TypeScript, leaving strings
 * intact: "postgres://…" and globs such as './src/db/*' are not comments. A
 * ' or " string ends at its line, so one stray quote cannot hide the rest of
 * the file. Runs in linear time on any input.
 */
export function stripJsComments(text: string): string {
  let out = ''
  let copyFrom = 0
  let quote: string | null = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote || (ch === '\n' && quote !== '`')) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      continue
    }
    if (ch !== '/') continue
    const next = text[i + 1]
    if (next === '/') {
      const end = text.indexOf('\n', i + 2)
      out += text.slice(copyFrom, i)
      copyFrom = end === -1 ? text.length : end
    } else if (next === '*') {
      const end = text.indexOf('*/', i + 2)
      out += `${text.slice(copyFrom, i)} `
      copyFrom = end === -1 ? text.length : end + 2
    } else {
      continue
    }
    i = copyFrom - 1
  }
  return out + text.slice(copyFrom)
}

/** drizzle-kit `dialect` (or the legacy `driver`) declared in a drizzle config file. */
export function extractDrizzleDialects(text: string): string[] {
  const code = stripJsComments(text)
  const dialect = /["']?\bdialect["']?\s*:\s*["'`]([\w-]+)["'`]/.exec(code)?.[1]
  if (dialect) return [dialect]
  const driver = /["']?\bdriver["']?\s*:\s*["'`]([\w-]+)["'`]/.exec(code)?.[1]
  return driver && DRIZZLE_DIALECTS.has(driver) ? [driver] : []
}

/** Engines declared in a parsed sqlc config (v2 `sql:` or v1 `packages:`, whose engine defaults to PostgreSQL). */
export function extractSqlcEngines(doc: unknown): string[] {
  if (!isRecord(doc)) return []
  const engines: string[] = []
  for (const key of ['sql', 'packages'] as const) {
    const list = doc[key]
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      if (!isRecord(entry)) continue
      const engine = getString(entry, 'engine') ?? (key === 'packages' ? 'postgresql' : undefined)
      if (engine) engines.push(engine)
    }
  }
  return unique(engines)
}

/** `type` of a parsed ormconfig.json / ormconfig.yml (one connection or a list). */
export function extractOrmconfigTypes(doc: unknown): string[] {
  const entries = Array.isArray(doc) ? doc : isRecord(doc) ? [doc] : []
  const types: string[] = []
  for (const entry of entries) {
    const type = getString(entry, 'type')
    if (type) types.push(type)
  }
  return unique(types)
}

const TYPEORM_IMPORT =
  /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|\bimport\s+)["'](?:typeorm|@nestjs\/typeorm)(?:\/[^"']*)?["']/
const TYPEORM_OPTIONS = [
  /\b(?:TypeOrmModule\s*\.\s*forRoot(?:Async)?|new\s+DataSource|createConnections?)\s*\(/g,
  /\b(?:DataSourceOptions|TypeOrmModuleOptions|ConnectionOptions)\s*=\s*\{/g,
]
const TYPE_PROPERTY = /\btype\s*:\s*["'`]([\w-]+)["'`]/g
const MAX_OPTIONS_LENGTH = 4_000
/** Option objects inspected per file; a real module declares a handful. Bounds work on hostile files. */
const MAX_OPTION_OBJECTS = 100

/**
 * Index just past the bracket that closes the one at `open`, skipping strings,
 * looking at most MAX_OPTIONS_LENGTH characters ahead. `text` must already be
 * comment-free (stripJsComments).
 */
function closingIndex(text: string, open: number): number {
  const limit = Math.min(text.length, open + MAX_OPTIONS_LENGTH)
  let depth = 0
  let quote: string | null = null
  for (let i = open; i < limit; i++) {
    const ch = text[i] as string
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote || (ch === '\n' && quote !== '`')) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch
    else if (ch === '(' || ch === '{' || ch === '[') depth++
    else if (ch === ')' || ch === '}' || ch === ']') {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return limit
}

/**
 * TypeORM connection types (`type: 'mysql'`) inside `TypeOrmModule.forRoot(…)`,
 * `new DataSource(…)` or typed option objects, in files that import TypeORM.
 * Only types TypeORM knows are returned.
 */
export function extractTypeormTypes(text: string): string[] {
  if (!TYPEORM_IMPORT.test(text)) return []
  const code = stripJsComments(text)
  const types: string[] = []
  let inspected = 0
  for (const pattern of TYPEORM_OPTIONS) {
    for (const match of code.matchAll(pattern)) {
      if (++inspected > MAX_OPTION_OBJECTS) break
      const open = match.index + match[0].length - 1
      const options = code.slice(open, closingIndex(code, open))
      for (const property of options.matchAll(TYPE_PROPERTY)) {
        const type = property[1]
        if (type && TYPEORM_TYPES.has(type)) {
          types.push(type)
          break
        }
      }
    }
  }
  return unique(types).sort(compareText)
}

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

const JS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts'])

/** Tests, fixtures, examples and templates describe someone else's database, not the project's. */
function isSampleOrTest(file: string): boolean {
  return isTestFileName(file) || isUnder(file, NON_PROJECT_ROLES)
}

function capped(ctx: ProjectContext, files: string[], what: string): string[] {
  if (files.length <= MAX_CONFIG_READS) return files
  ctx.debug(`databases: read ${MAX_CONFIG_READS} of ${files.length} ${what}`)
  return files.slice(0, MAX_CONFIG_READS)
}

async function readTypeormSourceTypes(
  ctx: ProjectContext,
  deps: DependencyIndex,
): Promise<DatabaseConfigs['typeormTypes']> {
  const packages = new Set([...deps.packagesWith('typeorm'), ...deps.packagesWith('@nestjs/typeorm')])
  if (packages.size === 0) return []
  const { files } = await ctx.use(sourceFiles)
  let candidates = files
    .filter((file) => JS_EXTENSIONS.has(file.ext) && (packages.has('.') || packages.has(file.package)))
    .map((file) => file.path)
    .filter((path) => !isSampleOrTest(path))
  if (candidates.length > MAX_TYPEORM_SCAN_FILES) {
    ctx.debug(`databases: scanned ${MAX_TYPEORM_SCAN_FILES} of ${candidates.length} files for TypeORM options`)
    candidates = candidates.slice(0, MAX_TYPEORM_SCAN_FILES)
  }
  const found = await mapLimit(candidates, READ_CONCURRENCY, async (file) => {
    const text = await ctx.readText(file, { cache: false })
    if (text === null || text.length > MAX_SOURCE_FILE_BYTES || !text.includes('typeorm')) return []
    return extractTypeormTypes(text).map((type) => ({ file, type }))
  })
  return found.flat()
}

async function gatherConfigs(
  ctx: ProjectContext,
  deps: DependencyIndex,
): Promise<{ configs: DatabaseConfigs; configFiles: string[] }> {
  const prismaFiles: string[] = []
  const configFiles: string[] = []
  for (const file of ctx.files.files) {
    const name = baseName(file)
    const isPrisma = extOf(name) === '.prisma'
    const isConfig = DATABASE_CONFIG_FILE.test(name)
    if ((!isPrisma && !isConfig) || isUnder(file, NON_PROJECT_ROLES)) continue
    if (isPrisma) prismaFiles.push(file)
    if (isConfig) configFiles.push(file)
  }
  // Split schemas (prisma/schema/*.prisma) can be many files; only schema.prisma and files declaring a datasource are listed.
  configFiles.push(...prismaFiles.filter((file) => baseName(file) === 'schema.prisma'))
  const byPattern = (pattern: RegExp) => configFiles.filter((file) => pattern.test(baseName(file)))

  const [prisma, drizzle, sqlc, ormconfig, typeormSources] = await Promise.all([
    mapLimit(capped(ctx, prismaFiles, 'Prisma schemas'), READ_CONCURRENCY, async (file) => {
      const text = await ctx.readText(file)
      return text === null ? [] : extractPrismaProviders(text).map((provider) => ({ file, provider }))
    }),
    mapLimit(capped(ctx, byPattern(/^drizzle\.config\./), 'Drizzle configs'), READ_CONCURRENCY, async (file) => {
      const text = await ctx.readText(file)
      return text === null ? [] : extractDrizzleDialects(text).map((dialect) => ({ file, dialect }))
    }),
    mapLimit(capped(ctx, byPattern(/^sqlc\./), 'sqlc configs'), READ_CONCURRENCY, async (file) => {
      const doc = file.endsWith('.json') ? await ctx.readJson(file) : await ctx.readYaml(file)
      return extractSqlcEngines(doc).map((engine) => ({ file, engine }))
    }),
    mapLimit(capped(ctx, byPattern(/^ormconfig\./), 'TypeORM configs'), READ_CONCURRENCY, async (file) => {
      const ext = extOf(file)
      if (ext === '.json' || ext === '.yml' || ext === '.yaml') {
        const doc = ext === '.json' ? await ctx.readJson(file) : await ctx.readYaml(file)
        return extractOrmconfigTypes(doc).map((type) => ({ file, type }))
      }
      if (!JS_EXTENSIONS.has(ext)) return []
      const text = await ctx.readText(file)
      if (text === null) return []
      // ormconfig.js is a bare options object: take the first known `type:`.
      const type = [...stripJsComments(text).matchAll(TYPE_PROPERTY)]
        .map((m) => m[1])
        .find((t) => t && TYPEORM_TYPES.has(t))
      return type ? [{ file, type }] : []
    }),
    readTypeormSourceTypes(ctx, deps),
  ])

  return {
    configs: {
      prismaProviders: prisma.flat(),
      drizzleDialects: drizzle.flat(),
      sqlcEngines: sqlc.flat(),
      typeormTypes: [...ormconfig.flat(), ...typeormSources],
    },
    configFiles: unique(configFiles).sort(compareText),
  }
}

export const databasesDetector: Detector<'databases'> = {
  id: 'databases',
  title: 'Databases',
  async run(ctx) {
    const [deps, project, services, environment] = await Promise.all([
      ctx.use(dependencies),
      ctx.use(manifests),
      useOr(ctx, servicesDetector, { composeFiles: [], services: [], dockerfiles: [] }),
      useOr(ctx, environmentDetector, { files: [], variables: [], usageTruncated: false }),
    ])
    const { configs, configFiles } = await gatherConfigs(ctx, deps)
    return inferDatabases({
      dependencies: deps.all,
      services: services.services,
      envVariables: environment.variables,
      configs,
      configFiles,
      ownerOf: createOwnerResolver(project),
    })
  },
}
