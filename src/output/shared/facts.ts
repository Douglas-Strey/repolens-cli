/**
 * Pure helpers that turn scan data into plain display values and orderings,
 * shared by the terminal renderer, the Markdown report and the agent files.
 * They know nothing about styles, widths or Markdown; callers escape.
 */
import { isPlatformVariable } from '../../doctor/rules/environment.ts'
import type {
  CiJob,
  CiTask,
  CiWorkflow,
  ConfigCategory,
  ConfigFile,
  Diagnostic,
  Dockerfile,
  EnvEndpoint,
  EnvFile,
  EnvVariable,
  Framework,
  GitRemote,
  GitSection,
  HttpMethod,
  LanguageStat,
  PackageManagerInfo,
  PortMapping,
  ProjectSection,
  Route,
  Runtime,
  ScanResult,
  ScanWarning,
  Script,
  ScriptCategory,
  Service,
  Severity,
  Tool,
  VersionSource,
  WorkspaceSection,
} from '../../types.ts'
import { compareText } from '../../utils/compare.ts'
import { dirOf } from '../../utils/paths.ts'
import { sanitizeUrl } from '../../utils/redact.ts'
import { projectTypeLabel } from './labels.ts'
import { maskAbsolutePaths, plural, safeText } from './text.ts'

export { isPlatformVariable }

// ---------------------------------------------------------------------------
// Project and stack
// ---------------------------------------------------------------------------

/** "Monorepo · 4 packages (pnpm workspaces, Turborepo)", or null when nothing is known. */
export function describeProjectType(
  project: ProjectSection,
  workspace: WorkspaceSection | null,
  options: { separator?: string; tools?: boolean } = {},
): string | null {
  const separator = options.separator ?? ' · '
  const label = projectTypeLabel(project.type)
  const packages = workspace?.packages.length ?? 0
  const tools = options.tools === false ? [] : (workspace?.tools.map((tool) => tool.name) ?? [])
  const parts: string[] = []
  if (label) parts.push(label)
  if (packages > 0) parts.push(plural(packages, 'package'))
  // Workspace tools without resolved packages (e.g. a broken pnpm-workspace.yaml): still say what it is.
  if (parts.length === 0) return tools.length > 0 ? `Workspace (${tools.join(', ')})` : null
  return tools.length > 0 ? `${parts.join(separator)} (${tools.join(', ')})` : parts.join(separator)
}

/** Programming and markup languages first (largest share first), then style languages (CSS, …). */
export function sortLanguages(languages: readonly LanguageStat[]): LanguageStat[] {
  const group = (language: LanguageStat) => (language.kind === 'style' ? 1 : 0)
  return [...languages].sort(
    (a, b) => group(a) - group(b) || b.share - a.share || b.files - a.files || compareText(a.name, b.name),
  )
}

export function topLanguages(languages: readonly LanguageStat[], limit: number): LanguageStat[] {
  return sortLanguages(languages).slice(0, limit)
}

/** The source that declares the displayed version (e.g. `.nvmrc`), falling back to the first one. */
export function runtimeSource(runtime: Runtime): VersionSource | undefined {
  return runtime.sources.find((source) => source.version === runtime.version) ?? runtime.sources[0]
}

/** Primary package manager first, then the other detected ones, without duplicates. */
export function packageManagers(result: ScanResult): PackageManagerInfo[] {
  const { primary, detected } = result.packageManagers
  const out: PackageManagerInfo[] = primary ? [primary] : []
  for (const manager of detected) if (!out.some((m) => m.id === manager.id)) out.push(manager)
  return out
}

/** Names of the frameworks used by one package, in detector order. */
export function frameworksIn(path: string, frameworks: readonly Framework[]): string[] {
  return frameworks.filter((framework) => framework.packages.includes(path)).map((framework) => framework.name)
}

/** Frameworks grouped by package directory (root first, then by path). */
export function frameworksByPackage(
  frameworks: readonly Framework[],
): Array<{ path: string; frameworks: Framework[] }> {
  const groups = new Map<string, Framework[]>()
  for (const framework of frameworks) {
    for (const path of framework.packages) {
      const list = groups.get(path) ?? []
      list.push(framework)
      groups.set(path, list)
    }
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === '.' ? -1 : b === '.' ? 1 : compareText(a, b)))
    .map(([path, list]) => ({ path, frameworks: list }))
}

/** Workspace package directory that contains `file` (longest match), or "." for the root. */
export function ownerPackage(file: string, packagePaths: readonly string[]): string {
  let best = '.'
  for (const path of packagePaths) {
    if (path === '.' || path === '') continue
    if ((file === path || file.startsWith(`${path}/`)) && path.length > best.length) best = path
  }
  return best
}

/** True when a package list says more than "the root of a single-package repository". */
export function showPackages(packages: readonly string[]): boolean {
  return packages.some((path) => path !== '.' && path !== '')
}

export type ToolingLabel = 'Testing' | 'Linting' | 'Formatting' | 'Types' | 'Git hooks' | 'Build'

/**
 * Tools grouped the way every renderer lists them. EditorConfig is left out:
 * it configures editors rather than checking anything, and is listed with the
 * configuration files instead.
 */
export function toolingGroups(result: ScanResult): Array<{ label: ToolingLabel; tools: Tool[] }> {
  const lint = result.linting.tools.filter((tool) => tool.id !== 'editorconfig')
  const groups: Array<{ label: ToolingLabel; tools: Tool[] }> = [
    { label: 'Testing', tools: result.testing.tools },
    { label: 'Linting', tools: lint.filter((tool) => tool.kind === 'linter' || tool.kind === 'other') },
    { label: 'Formatting', tools: lint.filter((tool) => tool.kind === 'formatter') },
    { label: 'Types', tools: lint.filter((tool) => tool.kind === 'typechecker') },
    { label: 'Git hooks', tools: lint.filter((tool) => tool.kind === 'git-hooks') },
    { label: 'Build', tools: result.build.tools },
  ]
  return groups.filter((group) => group.tools.length > 0)
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

const LOCAL_REMOTE = /^(?:file:|[/~.\\]|[A-Za-z]:[\\/])/i

/**
 * Remote URL for display: credentials, scheme, query and ".git" removed,
 * scp-style URLs turned into host/path. Local paths are never shown.
 */
export function displayRemote(url: string): string {
  const trimmed = url.trim()
  if (trimmed === '') return ''
  if (LOCAL_REMOTE.test(trimmed)) return 'local path'
  let out = sanitizeUrl(trimmed)
  const query = out.search(/[?#]/)
  if (query !== -1) out = out.slice(0, query)
  // The last "://" also covers transport prefixes such as "git::https://".
  const scheme = out.lastIndexOf('://')
  if (scheme !== -1) {
    if (/file$/i.test(out.slice(0, scheme))) return 'local path'
    out = out.slice(scheme + 3)
  }
  // Credentials: everything up to the last "@" before the path. sanitizeUrl
  // leaves URLs without a scheme ("user:token@host/repo") alone.
  const slash = out.indexOf('/')
  const at = out.lastIndexOf('@', slash === -1 ? out.length : slash)
  if (at !== -1) out = out.slice(at + 1)
  if (out.startsWith('/')) return 'local path'
  const scp = out.startsWith('[') ? null : /^([^:/]+):(?!\d+\/)([^/].*)$/.exec(out)
  if (scp) out = `${scp[1]}/${scp[2]}`
  let end = out.length
  while (end > 0 && out[end - 1] === '/') end--
  return safeText(out.slice(0, end).replace(/\.git$/, ''))
}

/** "origin" when present, otherwise the first remote. */
export function primaryRemote(remotes: readonly GitRemote[]): GitRemote | undefined {
  return remotes.find((remote) => remote.name === 'origin') ?? remotes[0]
}

/** Parts of the Git summary: ["main @ 3f2a1c9", "github.com/acme/acme-api", "2 submodules", "LFS"]. */
export function describeGit(git: GitSection | null, repository?: string): string[] {
  const parts: string[] = []
  if (git) {
    const branch = git.branch ?? (git.head ? 'detached HEAD' : null)
    if (branch && git.head) parts.push(`${branch} @ ${git.head}`)
    else if (branch) parts.push(branch)
  }
  const remote = git ? primaryRemote(git.remotes) : undefined
  const shown = displayRemote(remote?.url ?? '') || displayRemote(repository ?? '')
  if (shown !== '') parts.push(shown)
  if (git && git.submodules.length > 0) parts.push(plural(git.submodules.length, 'submodule'))
  if (git?.lfs) parts.push('LFS')
  return parts
}

// ---------------------------------------------------------------------------
// Services and Dockerfiles
// ---------------------------------------------------------------------------

const ABSOLUTE_PATH = /^(?:[/\\~]|[A-Za-z]:[\\/]|file:)/
/** "https://…", "git://…", "ssh://…" or scp-style "git@host:org/repo". */
const REMOTE_LOCATION = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:\/\/|[^@/\s]+@[^:/\s]+:)/

/** True for a URL or scp-style Git location, e.g. a Compose build context fetched from a repository. */
export function isRemoteLocation(value: string): boolean {
  return REMOTE_LOCATION.test(value.trim())
}

/**
 * A path from a committed file (Compose build context, …) relative to the
 * root, or null when it points outside the repository (including remote
 * URLs). Output never contains absolute paths.
 */
export function repoPath(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed === '' || ABSOLUTE_PATH.test(trimmed) || isRemoteLocation(trimmed)) return null
  const parts: string[] = []
  for (const part of trimmed.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length === 0) return null
      parts.pop()
    } else parts.push(part)
  }
  return parts.length === 0 ? '.' : parts.join('/')
}

/** `relative` resolved against a directory of the repository, or null when it leaves it. */
function resolveIn(dir: string, relative: string): string | null {
  const trimmed = relative.trim()
  if (trimmed === '' || ABSOLUTE_PATH.test(trimmed) || isRemoteLocation(trimmed)) return null
  return repoPath(dir === '.' ? trimmed : `${dir}/${trimmed}`)
}

/**
 * Directory a Compose service is built from, relative to the root. Compose
 * resolves the build context against the directory of the Compose file.
 * Null for remote contexts and contexts outside the repository.
 */
export function buildContext(service: Service): string | null {
  if (service.build === undefined) return null
  return resolveIn(dirOf(service.source), service.build)
}

/** The Dockerfile a built service uses, when RepoLens found it. */
export function serviceDockerfile(service: Service, dockerfiles: readonly Dockerfile[]): Dockerfile | undefined {
  const context = buildContext(service)
  if (context === null) return undefined
  const path = resolveIn(context, service.dockerfile ?? 'Dockerfile')
  return path === null ? undefined : dockerfiles.find((dockerfile) => dockerfile.path === path)
}

/** Dockerfiles that no Compose service builds from. */
export function unusedDockerfiles(services: readonly Service[], dockerfiles: readonly Dockerfile[]): Dockerfile[] {
  const used = new Set(services.map((service) => serviceDockerfile(service, dockerfiles)?.path))
  return dockerfiles.filter((dockerfile) => !used.has(dockerfile.path))
}

/** "node:22-alpine (3 stages)": the final stage's base image. */
export function dockerfileSummary(dockerfile: Dockerfile): string {
  const base = dockerfile.baseImages[dockerfile.baseImages.length - 1]
  const stages = dockerfile.stages > 1 ? `${dockerfile.stages} stages` : ''
  if (!base) return stages
  return stages ? `${safeText(base)} (${stages})` : safeText(base)
}

export interface PortText {
  text: string
  /** False for ports only reachable from other containers. */
  published: boolean
}

function protocolSuffix(port: PortMapping): string {
  return port.protocol && port.protocol !== 'tcp' ? `/${port.protocol}` : ''
}

function hostAddress(port: PortMapping): string {
  const ip = port.hostIp && port.hostIp !== '0.0.0.0' && port.hostIp !== '::' ? port.hostIp : ''
  return ip.includes(':') ? `[${ip}]` : ip
}

function isPublished(port: PortMapping): boolean {
  return port.host !== null && port.host !== ''
}

/** Compact form for the terminal: ":5432", "127.0.0.1:6379", "9229" (container only). */
export function formatPort(port: PortMapping): PortText {
  const protocol = protocolSuffix(port)
  if (!isPublished(port)) return { text: safeText(`${port.container}${protocol}`), published: false }
  return { text: safeText(`${hostAddress(port)}:${port.host}${protocol}`), published: true }
}

/** Long form for documents: "5432 → 5432", "127.0.0.1:8080 → 80", "6379 (internal)", "53 → 53/udp". */
export function portLabel(port: PortMapping): string {
  const container = `${safeText(String(port.container))}${protocolSuffix(port)}`
  if (!isPublished(port)) return `${container} (internal)`
  const ip = hostAddress(port)
  return `${safeText(ip ? `${ip}:${port.host}` : String(port.host))} → ${container}`
}

/** Published ports first, then container-only ports, then `expose` entries; duplicates removed. */
function orderedPorts<T>(service: Service, format: (port: PortMapping) => T, expose: (value: string) => T): T[] {
  const published = service.ports.filter(isPublished)
  const internal = service.ports.filter((port) => !isPublished(port))
  return [...published.map(format), ...internal.map(format), ...service.expose.map(expose)]
}

export function servicePorts(service: Service): PortText[] {
  const seen = new Set<string>()
  return orderedPorts(service, formatPort, (value) => ({ text: safeText(value), published: false })).filter((port) => {
    if (seen.has(port.text)) return false
    seen.add(port.text)
    return true
  })
}

export function servicePortLabels(service: Service): string[] {
  return [...new Set(orderedPorts(service, portLabel, (value) => `${safeText(value)} (internal)`))]
}

/** Host ports a service publishes, as numbers (interpolated or ranged ports are skipped). */
export function publishedHostPorts(service: Service): number[] {
  const out: number[] = []
  for (const port of service.ports) {
    const value = typeof port.host === 'number' ? port.host : Number(port.host)
    if (isPublished(port) && Number.isInteger(value)) out.push(value)
  }
  return out
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/** Env files that hold values (local, mode and service files), as opposed to examples. */
export function hasValueFiles(files: readonly EnvFile[]): boolean {
  return files.some((file) => file.kind === 'local' || file.kind === 'mode' || file.kind === 'service')
}

export function hasExampleFiles(files: readonly EnvFile[]): boolean {
  return files.some((file) => file.kind === 'example')
}

/** Used in code but missing from the examples, and not a variable the OS, CI or a runner provides. */
export function isUndocumented(variable: EnvVariable): boolean {
  return variable.used && !variable.documented && !variable.testOnly && !isPlatformVariable(variable.name)
}

/**
 * Lower is more urgent: used but undocumented, local-only, missing from an
 * existing local file, documented but unused, fine.
 */
export function variableRank(variable: EnvVariable, hasLocalFile: boolean): number {
  if (isUndocumented(variable)) return 0
  if (!variable.documented && !variable.used) return 1
  if (hasLocalFile && variable.used && !variable.defined && !variable.fallback && !variable.testOnly) return 2
  if (!variable.used) return 3
  return 4
}

/** Problems first, then alphabetical. */
export function sortByUrgency(variables: readonly EnvVariable[], hasLocalFile: boolean): EnvVariable[] {
  return [...variables].sort(
    (a, b) => variableRank(a, hasLocalFile) - variableRank(b, hasLocalFile) || compareText(a.name, b.name),
  )
}

export function sortByName(variables: readonly EnvVariable[]): EnvVariable[] {
  return [...variables].sort((a, b) => compareText(a.name, b.name))
}

/** Only the scheme and port of an endpoint are ever shown. */
export function endpointLabel(endpoint: EnvEndpoint): string {
  return endpoint.port === null ? endpoint.scheme : `${endpoint.scheme}, port ${endpoint.port}`
}

/** Distinct endpoint labels of a variable. */
export function variableEndpoints(variable: EnvVariable): string[] {
  return [...new Set(variable.endpoints.map(endpointLabel))].sort(compareText)
}

/** Problems and properties of a variable, most important first. */
export function variableNotes(variable: EnvVariable, hasLocalFile: boolean): string[] {
  const notes: string[] = []
  const platform = isPlatformVariable(variable.name)
  if (isUndocumented(variable)) notes.push('undocumented')
  if (hasLocalFile && variable.used && !variable.defined && !variable.fallback && !variable.testOnly && !platform) {
    notes.push('not set locally')
  }
  if (!variable.used && (variable.defined || variable.documented)) notes.push('not referenced in code')
  if (variable.suspiciousValueIn.length > 0) {
    notes.push(`example value looks like a real credential (${variable.suspiciousValueIn.join(', ')})`)
  }
  // A variable exposed to the browser is public by definition, whatever its name suggests.
  if (variable.public) notes.push('exposed to the client')
  else if (variable.sensitive) notes.push('secret')
  if (variable.fallback) notes.push('optional (has a default)')
  if (variable.testOnly) notes.push('only used in tests')
  if (platform) notes.push('set by the platform')
  return notes
}

// ---------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------

const SCRIPT_CATEGORY_ORDER: readonly ScriptCategory[] = [
  'dev',
  'start',
  'build',
  'test',
  'lint',
  'typecheck',
  'format',
  'database',
  'setup',
  'deploy',
  'release',
  'other',
]

export function scriptRank(category: ScriptCategory): number {
  const index = SCRIPT_CATEGORY_ORDER.indexOf(category)
  return index === -1 ? SCRIPT_CATEGORY_ORDER.length : index
}

/** Stable sort by category, keeping file order within a category. */
export function sortScripts(scripts: readonly Script[]): Script[] {
  return scripts
    .map((script, index) => ({ script, index }))
    .sort((a, b) => scriptRank(a.script.category) - scriptRank(b.script.category) || a.index - b.index)
    .map(({ script }) => script)
}

export interface ScriptGroups {
  /** Root package.json scripts, ordered by category. */
  root: Script[]
  /** Makefile / justfile / Taskfile / deno.json tasks, in file order. */
  targets: Script[]
  /** Scripts of other packages, grouped by package directory (sorted), each ordered by category. */
  packages: Array<{ path: string; scripts: Script[] }>
}

export function groupScripts(scripts: readonly Script[]): ScriptGroups {
  const root: Script[] = []
  const targets: Script[] = []
  const packages = new Map<string, Script[]>()
  for (const script of scripts) {
    if (script.source === 'package.json') root.push(script)
    else if (script.source.endsWith('/package.json')) {
      const path = script.package ?? script.source.slice(0, -'/package.json'.length)
      const list = packages.get(path) ?? []
      list.push(script)
      packages.set(path, list)
    } else targets.push(script)
  }
  return {
    root: sortScripts(root),
    targets,
    packages: [...packages.entries()]
      .sort(([a], [b]) => compareText(a, b))
      .map(([path, list]) => ({ path, scripts: sortScripts(list) })),
  }
}

// ---------------------------------------------------------------------------
// CI
// ---------------------------------------------------------------------------

const CI_TASK_ORDER: readonly CiTask[] = [
  'lint',
  'format',
  'typecheck',
  'test',
  'e2e',
  'build',
  'deploy',
  'release',
  'security',
  'docs',
]

/** Union of the tasks of every job, in a fixed order. */
export function workflowTasks(workflow: CiWorkflow): CiTask[] {
  const tasks = new Set(workflow.jobs.flatMap((job) => job.tasks))
  return CI_TASK_ORDER.filter((task) => tasks.has(task))
}

/** "ci.yml" for GitHub Actions workflows, the full path otherwise. */
export function workflowLabel(file: string): string {
  return file.startsWith('.github/workflows/') ? file.slice('.github/workflows/'.length) : file
}

/** Provider display name for a workflow ("GitHub Actions"), falling back to its id. */
export function ciProviderName(result: ScanResult, id: string): string {
  return result.ci.providers.find((provider) => provider.id === id)?.name ?? id
}

/** Text with GitHub Actions `${{ … }}` expressions removed; they only mean something at run time. */
export function withoutExpressions(value: string): string {
  let out = ''
  let from = 0
  for (let open = value.indexOf('${{'); open !== -1; open = value.indexOf('${{', from)) {
    const close = value.indexOf('}}', open + 3)
    // Without a closing "}}" here there is none further on either.
    if (close === -1) break
    out += value.slice(from, open)
    from = close + 2
  }
  out += value.slice(from)
  return out
    .replace(/\(\s*[,\s]*\)|\[\s*[,\s]*\]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s:,/-]+|[\s:,/-]+$/g, '')
}

/** Display name of a job ("Test" for "Test (${{ matrix.os }})"), or null when only an id is left. */
export function jobName(job: CiJob): string | null {
  if (!job.name) return null
  const name = withoutExpressions(safeText(job.name))
  return name === '' ? null : name
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const METHOD_ORDER: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'ANY']

function methodRank(method: HttpMethod): number {
  const index = METHOD_ORDER.indexOf(method)
  return index === -1 ? METHOD_ORDER.length : index
}

/** Grouped by package, then path, method and location. */
export function sortRoutes(routes: readonly Route[]): Route[] {
  return [...routes].sort(
    (a, b) =>
      compareText(a.package ?? '.', b.package ?? '.') ||
      compareText(a.path, b.path) ||
      methodRank(a.method) - methodRank(b.method) ||
      compareText(a.file, b.file) ||
      (a.line ?? 0) - (b.line ?? 0),
  )
}

/** "apps/api/src/routes/users.ts:12" */
export function routeLocation(route: Route): string {
  return route.line ? `${route.file}:${route.line}` : route.file
}

/** Confidence and detector note, for routes that are not certain. */
export function routeNote(route: Route): string {
  if (route.confidence === 'high') return route.note ?? ''
  const label = `${route.confidence} confidence`
  return route.note ? `${label}: ${route.note}` : label
}

// ---------------------------------------------------------------------------
// Configuration files
// ---------------------------------------------------------------------------

const CONFIG_PRIORITY: readonly ConfigCategory[] = [
  'package',
  'workspace',
  'runtime',
  'framework',
  'build',
  'docker',
  'database',
  'deploy',
  'test',
  'lint',
  'format',
  'typescript',
  'ci',
  'environment',
  'git',
  'editor',
  'other',
]

/** The `limit` most informative config files (by category), listed by path. */
export function pickKeyFiles(files: readonly ConfigFile[], limit: number): ConfigFile[] {
  const rank = (file: ConfigFile) => {
    const index = CONFIG_PRIORITY.indexOf(file.category)
    return index === -1 ? CONFIG_PRIORITY.length : index
  }
  return [...files]
    .sort((a, b) => rank(a) - rank(b) || compareText(a.path, b.path))
    .slice(0, limit)
    .sort((a, b) => compareText(a.path, b.path))
}

// ---------------------------------------------------------------------------
// Diagnostics and scan warnings
// ---------------------------------------------------------------------------

export const SEVERITY_RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 }

/** Errors, then warnings, then info; the doctor's order is kept within a severity. */
export function sortBySeverity(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return diagnostics
    .map((diagnostic, index) => ({ diagnostic, index }))
    .sort((a, b) => SEVERITY_RANK[a.diagnostic.severity] - SEVERITY_RANK[b.diagnostic.severity] || a.index - b.index)
    .map(({ diagnostic }) => diagnostic)
}

/** Worst severity in a list, or null when it is empty. */
export function worstSeverity(severities: readonly Severity[]): Severity | null {
  let worst: Severity | null = null
  for (const severity of severities) {
    if (worst === null || SEVERITY_RANK[severity] < SEVERITY_RANK[worst]) worst = severity
  }
  return worst
}

/** ["1 error", "2 warnings", "1 info"]: non-zero counts in the order every summary uses. */
export function severityParts(counts: { errors: number; warnings: number; infos: number }): string[] {
  const parts: string[] = []
  if (counts.errors > 0) parts.push(plural(counts.errors, 'error'))
  if (counts.warnings > 0) parts.push(plural(counts.warnings, 'warning'))
  if (counts.infos > 0) parts.push(plural(counts.infos, 'info', 'info'))
  return parts
}

export function countSeverities(diagnostics: readonly Diagnostic[]): {
  errors: number
  warnings: number
  infos: number
} {
  const count = (severity: Severity) => diagnostics.filter((d) => d.severity === severity).length
  return { errors: count('error'), warnings: count('warning'), infos: count('info') }
}

/**
 * A scan warning as a sentence. "Couldn't parse x" reads as "RepoLens
 * couldn't parse x", so it is clear who had the problem.
 */
export function warningText(warning: ScanWarning): string {
  const message = maskAbsolutePaths(safeText(warning.message.trim()))
  if (/^(?:couldn't|could not|can't|cannot|failed to)\b/i.test(message)) {
    return `RepoLens ${message.charAt(0).toLowerCase()}${message.slice(1)}`
  }
  return message
}

const TRUNCATION_WARNING = /^stopped indexing after \d+ files\b/i

/**
 * Scan warnings worth a note of their own. The file-limit warning is left out
 * when `meta.truncated` already produces RepoLens's own notice, so the same
 * thing is not said twice.
 */
export function noteWarnings(meta: ScanResult['meta']): ScanWarning[] {
  // Configuration problems are about how RepoLens was run, not the repository; the CLI prints them to stderr.
  const warnings = meta.warnings.filter((warning) => warning.kind !== 'config')
  if (!meta.truncated) return warnings
  return warnings.filter((warning) => warning.file !== undefined || !TRUNCATION_WARNING.test(warning.message))
}

/**
 * "Configured by repolens.config.json: 2 checks turned off, 1 ignore pattern."
 * Shown whenever the scanned repository's own configuration (or a --config
 * file) shaped the results, so nobody mistakes a trimmed report for a clean
 * one. The user's own config is only mentioned with `verbose`.
 */
export function configNote(result: ScanResult, verbose: boolean): string | null {
  const config = result.meta.config
  if (!config) return null
  const shown = config.sources.filter((source) => verbose || source.kind !== 'user')
  if (shown.length === 0) return null
  const names = shown.map((source) =>
    source.kind === 'user' ? 'your user config' : (source.file ?? 'the --config file'),
  )
  const { settings } = config
  const effects: string[] = []
  const disabled = result.doctor.summary.disabled ?? 0
  if (disabled > 0) effects.push(`${plural(disabled, 'check')} turned off`)
  const changed = Object.values(settings.doctor?.rules ?? {}).filter((setting) => setting !== 'off').length
  if (changed > 0) effects.push(`${plural(changed, 'check')} with a custom severity`)
  if (settings.ignore?.length) effects.push(plural(settings.ignore.length, 'ignore pattern'))
  if (settings.environment?.provided?.length) {
    effects.push(plural(settings.environment.provided.length, 'provided variable'))
  }
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  return `Configured by ${list}${effects.length > 0 ? `: ${effects.join(', ')}` : ''}.`
}

/**
 * Scan warnings that no diagnostic already reports: none with the same
 * message and, for a file that could not be parsed, none about that file
 * (PACKAGE_JSON_INVALID already says package.json is broken).
 */
export function uncoveredWarnings(warnings: readonly ScanWarning[], diagnostics: readonly Diagnostic[]): ScanWarning[] {
  const messages = new Set(diagnostics.map((diagnostic) => diagnostic.message))
  const files = new Set(diagnostics.flatMap((diagnostic) => diagnostic.files ?? []))
  return warnings.filter(
    (warning) =>
      !messages.has(warning.message) && !(warning.kind === 'parse' && warning.file && files.has(warning.file)),
  )
}
