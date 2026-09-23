import { isProvided } from '../../config/resolve.ts'
import { useOr } from '../../core/context.ts'
import {
  type EnvironmentAnalysis,
  environmentAnalysis,
  isIgnoredUsagePath,
  isTestUsagePath,
  MAX_USED_IN,
} from '../../detectors/environment.ts'
import { sourceFiles } from '../../facts/source-files.ts'
import type {
  Diagnostic,
  DoctorRule,
  EnvFile,
  EnvironmentSection,
  EnvVariable,
  ProjectContext,
  ProjectType,
  Sections,
  ServicesSection,
} from '../../types.ts'
import { compareText } from '../../utils/compare.ts'
import { baseName, dirOf, isInDir, joinPath } from '../../utils/paths.ts'
import { countOf, formatList, isRootPath, unique, uniqueSorted } from './shared.ts'

/**
 * Variables provided by the OS, shells, terminals, package managers, CI
 * platforms or test runners. Nobody documents these in .env.example.
 */
const PLATFORM_NAMES: ReadonlySet<string> = new Set([
  'NODE_ENV',
  'CI',
  'TZ',
  'HOME',
  'PATH',
  'PWD',
  'SHELL',
  'USER',
  'LANG',
  'TERM',
  'TMPDIR',
  'HOSTNAME',
  'DEBUG',
  // Windows equivalents
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  // Terminal conventions read by CLIs
  'NO_COLOR',
  'FORCE_COLOR',
  'COLORTERM',
  'COLUMNS',
  'LINES',
  'LC_ALL',
  'EDITOR',
  'VISUAL',
  // import.meta.env built-ins in Vite
  'MODE',
  'DEV',
  'PROD',
  'SSR',
  'BASE_URL',
  // GitHub Actions default variables (the families are matched below)
  'GITHUB_SHA',
  'GITHUB_WORKSPACE',
  'GITHUB_OUTPUT',
  'GITHUB_ENV',
  'GITHUB_PATH',
  'GITHUB_STATE',
  'GITHUB_STEP_SUMMARY',
  'GITHUB_JOB',
  'GITHUB_SERVER_URL',
  'GITHUB_API_URL',
  'GITHUB_GRAPHQL_URL',
  'GITHUB_TOKEN',
  'GITHUB_HEAD_REF',
  'GITHUB_BASE_REF',
  'GITHUB_TRIGGERING_ACTOR',
  'GITHUB_RETENTION_DAYS',
])

/**
 * GitHub Actions default variable families: GITHUB_ACTION, GITHUB_ACTIONS,
 * GITHUB_ACTION_PATH, GITHUB_ACTOR_ID, GITHUB_REF_NAME, GITHUB_REPOSITORY_OWNER,
 * GITHUB_RUN_ID, GITHUB_EVENT_NAME, GITHUB_WORKFLOW_REF, … Application
 * variables such as GITHUB_CLIENT_ID or GITHUB_REFRESH_TOKEN are not in it.
 */
const GITHUB_ACTIONS_FAMILY =
  /^GITHUB_(?:ACTIONS|(?:ACTION|ACTOR|REF|REPOSITORY|WORKFLOW)(?:_[A-Z0-9_]+)?|(?:RUN|EVENT)_[A-Z0-9_]+)$/

const PLATFORM_PREFIXES: readonly string[] = [
  'npm_',
  'RUNNER_',
  'VERCEL_',
  'NETLIFY',
  'RENDER_',
  'RAILWAY_',
  'FLY_',
  'CF_PAGES',
  'NEXT_RUNTIME',
  'NEXT_PHASE',
  'VITEST',
  'JEST_WORKER_ID',
  'XDG_',
]

/**
 * Variables that frameworks and tools read on their own, so they are often
 * documented without appearing in project code (Nuxt runtime config
 * overrides, Auth.js provider settings, Compose project settings, Gin and Go
 * toolchain settings, …).
 */
const TOOL_READ_NAMES: ReadonlySet<string> = new Set([
  'PORT',
  'HOST',
  'NODE_OPTIONS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'NODE_EXTRA_CA_CERTS',
  'DO_NOT_TRACK',
  'NEXT_TELEMETRY_DISABLED',
  'NEXTAUTH_URL',
  'NEXTAUTH_SECRET',
  'BROWSER',
  'GENERATE_SOURCEMAP',
  'GIN_MODE',
  'GOFLAGS',
  'GOPROXY',
  'GOPRIVATE',
  'GOTOOLCHAIN',
  'GOMAXPROCS',
  'GOMEMLIMIT',
  'GODEBUG',
  'CGO_ENABLED',
])

const TOOL_READ_PREFIXES: readonly string[] = [
  'NUXT_',
  'NITRO_',
  'AUTH_',
  'COMPOSE_',
  'DOCKER_',
  'TURBO_',
  'PRISMA_',
  'ASTRO_TELEMETRY',
  'SENTRY_',
]

/** True for OS, shell, CI-platform and runner variables that never need documenting. */
export function isPlatformVariable(name: string): boolean {
  return (
    PLATFORM_NAMES.has(name) ||
    GITHUB_ACTIONS_FAMILY.test(name) ||
    PLATFORM_PREFIXES.some((prefix) => name.startsWith(prefix))
  )
}

/** True for variables that tools consume implicitly, so "never referenced in code" is expected. */
export function isToolReadVariable(name: string): boolean {
  return TOOL_READ_NAMES.has(name) || TOOL_READ_PREFIXES.some((prefix) => name.startsWith(prefix))
}

/** Test code, test-runner configuration, fixtures and examples (the environment detector's rules). */
export function isTestPath(file: string): boolean {
  return isTestUsagePath(file) || isIgnoredUsagePath(file)
}

/**
 * Only tests read the variable (TEST_DB_URL, a fixture's API_KEY): it is not
 * configuration the project asks developers to set. The detector's `testOnly`
 * decides with every usage; sections built without it fall back to `usedIn`,
 * which is only conclusive while it is not capped.
 */
export function usedOnlyInTests(variable: EnvVariable): boolean {
  if (variable.testOnly) return true
  const { usedIn } = variable
  return usedIn.length > 0 && usedIn.length < MAX_USED_IN && usedIn.every(isTestPath)
}

/** direnv's .envrc is a shell script: it may export variables, but it is never where an app's settings go. */
function isEnvrc(path: string): boolean {
  return baseName(path) === '.envrc'
}

/**
 * The file could not be read or parsed (a "size" or "parse" scan warning names
 * it), so its contents are unknown.
 */
export function isUnreadable(ctx: Pick<ProjectContext, 'warnings'>, file: string): boolean {
  return ctx.warnings.some((warning) => warning.file === file && (warning.kind === 'parse' || warning.kind === 'size'))
}

const EXAMPLE_PREFERENCE = ['.env.example']
const LOCAL_PREFERENCE = ['.env', '.env.local']

/**
 * Choose the env file a diagnostic should point at: the one in the deepest
 * directory containing `near` (e.g. the file that uses a variable), otherwise
 * a root-level file, otherwise the first. Preferred basenames win ties.
 */
export function pickEnvFile(
  candidates: readonly string[],
  near?: string,
  preferred: readonly string[] = EXAMPLE_PREFERENCE,
): string | undefined {
  const rank = (file: string) => {
    const index = preferred.indexOf(baseName(file))
    return index === -1 ? preferred.length : index
  }
  const sorted = [...candidates].sort((a, b) => rank(a) - rank(b) || compareText(a, b))
  if (near !== undefined) {
    let best: string | undefined
    let bestDepth = -1
    for (const file of sorted) {
      const dir = dirOf(file)
      if (!isInDir(near, dir)) continue
      const depth = dir === '.' ? 0 : dir.split('/').length
      if (depth > bestDepth) {
        best = file
        bestDepth = depth
      }
    }
    if (best) return best
  }
  return sorted.find(isRootPath) ?? sorted[0]
}

/**
 * Resolver for the deepest package directory containing a file ("." when none
 * does). Walks up the file's directories, so each lookup costs the path depth,
 * not the number of packages (a workspace can have thousands).
 */
function packageResolver(packages: readonly string[]): (file: string) => string {
  const dirs = new Set(packages.filter((dir) => dir !== '.'))
  return (file) => {
    for (let dir = dirOf(file); dir !== '.'; dir = dirOf(dir)) {
      if (dirs.has(dir)) return dir
    }
    return '.'
  }
}

/**
 * Where a variable used in `usage` should be documented. In a workspace, only
 * example files of the same package or of a directory above it qualify
 * (apps/web's .env.example documents nothing for apps/api); `suggest` names
 * the file to create when none does.
 */
export function exampleFor(
  examples: readonly string[],
  usage: string | undefined,
  packages: readonly string[] = [],
  packageOf: (file: string) => string = packageResolver(packages),
): { example?: string; suggest: string } {
  if (usage === undefined || packages.length === 0) {
    const example = pickEnvFile(examples, usage)
    return example ? { example, suggest: example } : { suggest: '.env.example' }
  }
  const pkg = packageOf(usage)
  const allowed = examples.filter((file) => isInDir(pkg, dirOf(file)) || packageOf(file) === pkg)
  const example = pickEnvFile(allowed, usage)
  return example ? { example, suggest: example } : { suggest: joinPath(pkg, '.env.example') }
}

function filesOfKind(env: EnvironmentSection, kind: EnvFile['kind']): string[] {
  return uniqueSorted(env.files.filter((file) => file.kind === kind).map((file) => file.path))
}

/** Local env files where a developer keeps their own values (.envrc excluded: it is a script). */
function localFiles(env: EnvironmentSection): string[] {
  return filesOfKind(env, 'local').filter((file) => !isEnvrc(file))
}

export interface UndocumentedContext {
  /** Names a framework config provides to code (next.config `env`), which need no env file. */
  configProvided?: ReadonlySet<string>
  /** Workspace package directories; examples are then only suggested within a package or above it. */
  packages?: readonly string[]
}

/** Used in code, not documented, while an example file exists. */
export function findUndocumented(env: EnvironmentSection, context: UndocumentedContext = {}): Diagnostic[] {
  const examples = filesOfKind(env, 'example')
  if (examples.length === 0) return []
  const packages = context.packages ?? []
  const packageOf = packageResolver(packages)
  const out: Diagnostic[] = []
  for (const variable of env.variables) {
    const { name } = variable
    if (!variable.used || variable.documented || usedOnlyInTests(variable) || isPlatformVariable(name)) continue
    if (context.configProvided?.has(name)) continue
    const usage = variable.usedIn.find((file) => !isTestUsagePath(file)) ?? variable.usedIn[0]
    const { example, suggest } = exampleFor(examples, usage, packages, packageOf)
    const files = usage ? [usage] : []
    if (example) files.push(example)
    out.push({
      code: 'ENV_UNDOCUMENTED',
      // A variable with a default in code is optional: worth documenting, not a setup blocker.
      severity: variable.fallback ? 'info' : 'warning',
      category: 'environment',
      message: example
        ? variable.fallback
          ? `${name} is used in code (with a default) but missing from ${example}`
          : `${name} is used in code but missing from ${example}`
        : `${name} is used in ${usage && packageOf(usage) !== '.' ? packageOf(usage) : 'root code'} but no example env file there documents it`,
      hint: example ? `Add ${name}= to ${example}` : `Create ${suggest} with ${name}=`,
      files,
      subject: name,
    })
  }
  return out
}

/**
 * Set in a local env file but not documented. Variables that are also used in
 * (non-test) code are left to ENV_UNDOCUMENTED so each variable is reported
 * once. Mode and service files (.env.production, a Compose service's .env.db)
 * are not local configuration and are not considered.
 */
export function findLocalOnly(env: EnvironmentSection): Diagnostic[] {
  const examples = filesOfKind(env, 'example')
  if (examples.length === 0) return []
  // .envrc holds direnv settings (AWS_PROFILE, layout), not the app's configuration.
  const locals = new Set(filesOfKind(env, 'local').filter((file) => !isEnvrc(file)))
  const out: Diagnostic[] = []
  for (const variable of env.variables) {
    if (variable.documented || isPlatformVariable(variable.name)) continue
    if (variable.used && !usedOnlyInTests(variable)) continue
    const local = variable.definedIn.find((file) => locals.has(file))
    if (!local) continue
    const example = pickEnvFile(examples, local) as string
    out.push({
      code: 'ENV_LOCAL_ONLY',
      severity: 'warning',
      category: 'environment',
      message: `${variable.name} is set in ${local} but missing from ${example}`,
      hint: `Add ${variable.name}= to ${example} so other developers know to set it, or remove it from ${local}`,
      files: [local, example],
      subject: variable.name,
    })
  }
  return out
}

const MAX_LISTED_NAMES = 5

/** Variables code needs from the developer: used outside tests, without a default, not provided by the platform or a config. */
function neededFromDeveloper(variable: EnvVariable, configProvided: ReadonlySet<string>): boolean {
  return (
    variable.used &&
    !usedOnlyInTests(variable) &&
    !variable.fallback &&
    !isPlatformVariable(variable.name) &&
    !configProvided.has(variable.name)
  )
}

/**
 * No example env file at all, although code needs variables or a local env
 * file exists. Variables with a default in code, platform variables and
 * variables only tests read don't count: a server reading `PORT ?? 3000`
 * needs no template.
 */
export function findExampleMissing(
  env: EnvironmentSection,
  projectType: ProjectType,
  configProvided: ReadonlySet<string> = new Set(),
): Diagnostic[] {
  if (filesOfKind(env, 'example').length > 0) return []
  const locals = localFiles(env)
  const used = env.variables.filter((v) => neededFromDeveloper(v, configProvided))
  if (locals.length === 0 && used.length === 0) return []

  const localSet = new Set(locals)
  const names = uniqueSorted([
    ...used.map((v) => v.name),
    ...env.variables
      .filter((v) => v.definedIn.some((file) => localSet.has(file)) && !isPlatformVariable(v.name))
      .map((v) => v.name),
  ])
  const local = pickEnvFile(locals, undefined, LOCAL_PREFERENCE)
  const target = joinPath(local ? dirOf(local) : '.', '.env.example')
  const listed = names.slice(0, MAX_LISTED_NAMES).map((name) => `${name}=`)
  const more = names.length > MAX_LISTED_NAMES ? ` (and ${names.length - MAX_LISTED_NAMES} more)` : ''

  const message = local
    ? `${local} exists but there is no ${target} documenting which variables to set`
    : `No ${target} documents the ${countOf(used.length, 'environment variable')} used in code`
  // Libraries and CLIs often read optional settings (NO_COLOR-style toggles) that need no template.
  const severity = !local && (projectType === 'library' || projectType === 'cli') ? 'info' : 'warning'
  const files = local ? locals : uniqueSorted(used.flatMap((v) => v.usedIn.slice(0, 1))).slice(0, MAX_LISTED_NAMES)

  return [
    {
      code: 'ENV_EXAMPLE_MISSING',
      severity,
      category: 'environment',
      message,
      hint:
        listed.length > 0
          ? `Create ${target} with the variable names and empty values: ${listed.join(', ')}${more}`
          : `Create ${target} listing the variable names without values`,
      files,
      subject: target,
    },
  ]
}

export interface UnusedContext {
  /** False when the project has no source files RepoLens could scan. */
  hasSourceFiles: boolean
  services: ServicesSection
  /** Names that appear as a word in source code, where a library may read them by name. */
  mentioned?: ReadonlySet<string>
}

/** Documented but never referenced. Only reported when usage scanning was complete. */
export function findUnused(env: EnvironmentSection, context: UnusedContext): Diagnostic[] {
  if (env.usageTruncated || !context.hasSourceFiles) return []
  const { services } = context
  const composeNames = new Set(services.services.flatMap((s) => s.environment))
  const buildArgs = new Set(services.dockerfiles.flatMap((d) => d.args))
  // Containers receive every variable of an env_file, so usage inside images can't be ruled out.
  const envFileDirs = new Set(services.services.filter((s) => s.envFiles.length > 0).map((s) => dirOf(s.source)))

  const out: Diagnostic[] = []
  for (const variable of env.variables) {
    if (!variable.documented || variable.used) continue
    const name = variable.name
    if (composeNames.has(name) || buildArgs.has(name) || isPlatformVariable(name) || isToolReadVariable(name)) continue
    if (context.mentioned?.has(name)) continue
    if (variable.documentedIn.some((file) => envFileDirs.has(dirOf(file)))) continue
    const documentedIn = unique(variable.documentedIn)
    const first = documentedIn[0]
    if (!first) continue
    out.push({
      code: 'ENV_UNUSED',
      severity: 'info',
      category: 'environment',
      message: `${name} is documented in ${first} but never referenced in code`,
      hint: `Remove ${name} from ${formatList(documentedIn)} if nothing reads it any more`,
      files: documentedIn,
      subject: name,
    })
  }
  return out
}

/**
 * Documented and needed by code, but set in no local or mode env file while a
 * root local env file exists. Service files (.env.db) are loaded by one
 * Compose service, not by the app, so they don't count as setting it.
 */
export function findMissingLocal(env: EnvironmentSection): Diagnostic[] {
  const local = pickEnvFile(localFiles(env).filter(isRootPath), undefined, LOCAL_PREFERENCE)
  if (!local) return []
  const setting = new Set([...filesOfKind(env, 'local'), ...filesOfKind(env, 'mode')])
  const out: Diagnostic[] = []
  for (const variable of env.variables) {
    if (!variable.documented || !variable.used || usedOnlyInTests(variable) || variable.fallback) continue
    if (isPlatformVariable(variable.name) || variable.definedIn.some((file) => setting.has(file))) continue
    // Variables documented only in a nested package belong in that package's env file.
    const example = variable.documentedIn.find(isRootPath)
    if (!example) continue
    out.push({
      code: 'ENV_MISSING_LOCAL',
      severity: 'info',
      category: 'environment',
      message: `${variable.name} is not set in ${local}`,
      hint: `Add ${variable.name}= with your local value to ${local} (see ${example})`,
      files: [local, example],
      subject: variable.name,
    })
  }
  return out
}

const NO_ANALYSIS: EnvironmentAnalysis = {
  section: { files: [], variables: [], usageTruncated: false },
  mentioned: new Set(),
  configProvided: new Set(),
}

/** Facts the environment detector gathered beyond the section (memoized; nothing is read twice). */
function analysisOf(ctx: ProjectContext): Promise<EnvironmentAnalysis> {
  return useOr(ctx, environmentAnalysis, NO_ANALYSIS)
}

/** An example env file exists and could be read. */
function hasReadableExample(env: EnvironmentSection, ctx: ProjectContext): boolean {
  return env.files.some((file) => file.kind === 'example' && !isUnreadable(ctx, file.path))
}

function anyUsedOutsideTests(variables: readonly EnvVariable[]): boolean {
  return variables.some((v) => v.used && !usedOnlyInTests(v))
}

function workspacePackages(scan: Sections): string[] {
  return (scan.workspace?.packages ?? []).map((pkg) => pkg.path)
}

/**
 * The environment section without the variables the configuration declares
 * as provided by the platform (`environment.provided`): like CI or NODE_ENV,
 * no check expects them in an env file.
 */
export function environmentOf(scan: Sections, ctx: ProjectContext): EnvironmentSection {
  const provided = ctx.options.config?.settings.environment?.provided
  if (!provided || provided.length === 0) return scan.environment
  const variables = scan.environment.variables.filter((variable) => !isProvided(variable.name, provided))
  return variables.length === scan.environment.variables.length ? scan.environment : { ...scan.environment, variables }
}

export const envUndocumented: DoctorRule = {
  code: 'ENV_UNDOCUMENTED',
  category: 'environment',
  title: 'Environment variables used in code are documented',
  applies: (scan, ctx) =>
    hasReadableExample(environmentOf(scan, ctx), ctx) && anyUsedOutsideTests(environmentOf(scan, ctx).variables),
  async check(scan, ctx) {
    const { configProvided } = await analysisOf(ctx)
    return findUndocumented(environmentOf(scan, ctx), { configProvided, packages: workspacePackages(scan) })
  },
}

export const envLocalOnly: DoctorRule = {
  code: 'ENV_LOCAL_ONLY',
  category: 'environment',
  title: 'Local environment variables are documented',
  applies: (scan, ctx) =>
    hasReadableExample(environmentOf(scan, ctx), ctx) &&
    environmentOf(scan, ctx).files.some((file) => file.kind === 'local' && !isEnvrc(file.path)),
  check: (scan, ctx) => findLocalOnly(environmentOf(scan, ctx)),
}

export const envExampleMissing: DoctorRule = {
  code: 'ENV_EXAMPLE_MISSING',
  category: 'environment',
  title: 'An example env file documents the environment',
  applies: (scan, ctx) =>
    environmentOf(scan, ctx).files.length > 0 || anyUsedOutsideTests(environmentOf(scan, ctx).variables),
  async check(scan, ctx) {
    const { configProvided } = await analysisOf(ctx)
    return findExampleMissing(environmentOf(scan, ctx), scan.project.type, configProvided)
  },
}

export const envUnused: DoctorRule = {
  code: 'ENV_UNUSED',
  category: 'environment',
  title: 'Documented environment variables are used',
  // Without source files, "nothing reads it" can't be told apart from "nothing was looked at".
  applies: async (scan, ctx) =>
    hasReadableExample(environmentOf(scan, ctx), ctx) &&
    !environmentOf(scan, ctx).usageTruncated &&
    (await ctx.use(sourceFiles)).files.length > 0,
  async check(scan, ctx) {
    const [sources, { mentioned }] = await Promise.all([ctx.use(sourceFiles), analysisOf(ctx)])
    return findUnused(environmentOf(scan, ctx), {
      hasSourceFiles: sources.files.length > 0,
      services: scan.services,
      mentioned,
    })
  },
}

export const envMissingLocal: DoctorRule = {
  code: 'ENV_MISSING_LOCAL',
  category: 'environment',
  title: 'The local env file sets every documented variable',
  applies: (scan, ctx) =>
    environmentOf(scan, ctx).files.some(
      (file) => file.kind === 'local' && isRootPath(file.path) && !isEnvrc(file.path),
    ),
  check: (scan, ctx) => findMissingLocal(environmentOf(scan, ctx)),
}

export const environmentRules: DoctorRule[] = [
  envUndocumented,
  envLocalOnly,
  envExampleMissing,
  envUnused,
  envMissingLocal,
]
