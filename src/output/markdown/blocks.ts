/**
 * Markdown blocks (tables and lists) shared by the report and the agent
 * files. Each builder returns null when it has nothing to show, so callers can
 * pass the result straight to `section()` and empty sections disappear.
 */
import type {
  Database,
  Diagnostic,
  EnvFile,
  EnvVariable,
  ProjectSection,
  Route,
  ScanResult,
  ScanWarning,
  Script,
  Tool,
} from '../../types.ts'
import { compareText } from '../../utils/compare.ts'
import { servicesCommand } from '../commands.ts'
import {
  buildContext,
  ciProviderName,
  displayRemote,
  frameworksIn,
  groupScripts,
  hasExampleFiles,
  hasValueFiles,
  isPlatformVariable,
  isRemoteLocation,
  isUndocumented,
  jobName,
  ownerPackage,
  packageManagers,
  primaryRemote,
  publishedHostPorts,
  routeLocation,
  routeNote,
  servicePortLabels,
  showPackages,
  sortByName,
  sortBySeverity,
  sortLanguages,
  sortRoutes,
  toolingGroups,
  variableEndpoints,
  variableNotes,
  warningText,
  workflowLabel,
} from '../shared/facts.ts'
import {
  databaseSources,
  frameworkCategory,
  projectTypeLabel,
  SEVERITY_TITLE,
  TERMS,
  toolKindLabel,
} from '../shared/labels.ts'
import { formatNumber, formatShare, joinWords, nameWithVersion, plural, safeText, truncate } from '../shared/text.ts'
import { bullets, code, codeList, EMPTY_CELL, headingText, inline, prose, table, text, textWith } from './syntax.ts'

/** Most rows any table or list shows; the rest is summarized in one line. */
export const ROW_LIMIT = 200

/** Longest project description shown; the rest of a manifest's free text adds nothing to a report. */
export const DESCRIPTION_LIMIT = 400
const NAME_LIMIT = 120

const YES = '✓'
const NO = '✗'

/** Committed text (command, image, version) as a code span, with likely secrets masked. */
export function cmd(value: string): string {
  return code(safeText(value))
}

/** A package directory: "root" for ".", a code span otherwise. */
export function pkgRef(path: string): string {
  return path === '.' || path === '' ? 'root' : code(path)
}

export function pkgRefs(paths: readonly string[]): string {
  return paths.map(pkgRef).join(', ')
}

/** "_… and 12 more routes._" */
export function moreLine(hidden: number, noun: string): string | null {
  return hidden > 0 ? `_… and ${formatNumber(hidden)} more ${noun}._` : null
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText)
}

// ---------------------------------------------------------------------------
// Project and stack
// ---------------------------------------------------------------------------

function workspaceSummary(result: ScanResult): string | null {
  const workspace = result.workspace
  if (!workspace || (workspace.packages.length === 0 && workspace.tools.length === 0)) return null
  const parts: string[] = []
  if (workspace.packages.length > 0) parts.push(plural(workspace.packages.length, 'package'))
  if (workspace.tools.length > 0) parts.push(workspace.tools.map((tool) => text(tool.name)).join(', '))
  return parts.join(' · ')
}

/** "`main` @ `3f2a1c9` · github.com/acme/acme-api" */
export function gitSummary(result: ScanResult): string | null {
  const { git, project } = result
  const parts: string[] = []
  if (git) {
    const branch = git.branch ? code(git.branch) : git.head ? 'detached HEAD' : null
    if (branch) parts.push(git.head ? `${branch} @ ${code(git.head)}` : branch)
  }
  const remote = git ? primaryRemote(git.remotes) : undefined
  const shown = displayRemote(remote?.url ?? '') || displayRemote(project.repository ?? '')
  if (shown !== '') parts.push(text(shown))
  return parts.length > 0 ? parts.join(' · ') : null
}

const OVERVIEW_LANGUAGES = 5
const OVERVIEW_ITEMS = 8

function capped(items: readonly string[]): string {
  const shown = items.slice(0, OVERVIEW_ITEMS)
  const hidden = items.length - shown.length
  return shown.join(' · ') + (hidden > 0 ? ` · +${hidden} more` : '')
}

/** ["TypeScript (74%)", "Vue (14%)", "+2 more"] */
export function languageSummary(result: ScanResult, limit: number): string[] {
  const sorted = sortLanguages(result.languages)
  const shown = sorted.slice(0, limit).map((language) => `${text(language.name)} (${formatShare(language.share)})`)
  if (sorted.length > limit) shown.push(`+${sorted.length - limit} more`)
  return shown
}

/**
 * Rows of the two-column overview table. `extended` adds the tooling rows
 * (databases, tests, linting, build, CI) for documents without their own
 * sections for them.
 */
export function overviewRows(result: ScanResult, options: { extended: boolean }): Array<[string, string]> {
  const { project } = result
  const rows: Array<[string, string]> = []
  const type = projectTypeLabel(project.type)
  // "(private)" alone reads like the repository's visibility; it is the package.json flag.
  if (type) rows.push(['Type', project.private ? `${type} (private package)` : type])
  if (project.version) rows.push(['Version', inline(safeText(project.version))])
  if (result.languages.length > 0) {
    rows.push(['Languages', languageSummary(result, OVERVIEW_LANGUAGES).join(', ')])
  }
  const managers = packageManagers(result)
  if (managers.length > 0) {
    rows.push(['Package manager', managers.map((m) => text(nameWithVersion(m.name, m.version))).join(' · ')])
  }
  if (result.runtimes.length > 0) {
    rows.push([
      result.runtimes.length === 1 ? TERMS.runtime : TERMS.runtimes,
      result.runtimes.map((r) => text(nameWithVersion(r.name, r.version))).join(' · '),
    ])
  }
  if (result.frameworks.length > 0)
    rows.push(['Frameworks', capped(result.frameworks.map((f) => text(nameWithVersion(f.name, f.version))))])
  const workspace = workspaceSummary(result)
  if (workspace) rows.push(['Workspace', workspace])
  if (options.extended) {
    const tools = (list: readonly Tool[]) => capped(list.map((tool) => text(nameWithVersion(tool.name, tool.version))))
    const { databases, orms } = result.databases
    if (databases.length > 0) rows.push(['Databases', capped(databases.map((db) => text(db.name)))])
    if (orms.length > 0) rows.push(['ORMs', tools(orms)])
    for (const group of toolingGroups(result)) rows.push([group.label, tools(group.tools)])
    if (result.ci.providers.length > 0) rows.push(['CI', capped(result.ci.providers.map((p) => text(p.name)))])
    if (result.services.services.length > 0)
      rows.push(['Services', plural(result.services.services.length, 'Compose service')])
  }
  const git = gitSummary(result)
  if (git) rows.push([result.git ? 'Git' : 'Repository', git])
  if (project.license) rows.push(['License', inline(safeText(project.license))])
  if (result.meta.files > 0) {
    rows.push([
      'Files',
      `${formatNumber(result.meta.files)} indexed${result.meta.truncated ? ' (file limit reached)' : ''}`,
    ])
  }
  return rows
}

/** Project name escaped for a heading (manifest name, else the directory name), or null when both are empty. */
export function projectTitle(result: ScanResult): string | null {
  const name = result.project.name.trim() || result.project.directory.trim()
  return name === '' ? null : headingText(truncate(name, NAME_LIMIT))
}

export function languagesTable(result: ScanResult): string | null {
  const languages = sortLanguages(result.languages)
  if (languages.length === 0) return null
  return table(
    ['Language', 'Files', 'Share'],
    languages.map((language) => [text(language.name), formatNumber(language.files), formatShare(language.share)]),
    ['left', 'right', 'right'],
  )
}

export function frameworksTable(result: ScanResult, verbose: boolean): string | null {
  const { frameworks } = result
  if (frameworks.length === 0) return null
  const packages = frameworks.some((framework) => showPackages(framework.packages))
  const confidence = frameworks.some((framework) => framework.confidence !== 'high')
  const header = ['Framework', 'Category', 'Version']
  if (packages) header.push('Packages')
  if (confidence) header.push('Confidence')
  if (verbose) header.push('Evidence')
  const rows = frameworks.map((framework) => {
    const row = [text(framework.name), frameworkCategory(framework), inline(safeText(framework.version ?? ''))]
    if (packages) row.push(pkgRefs(framework.packages))
    if (confidence) row.push(framework.confidence)
    if (verbose) row.push(framework.evidence.map((item) => text(safeText(item))).join('; '))
    return row
  })
  return table(header, rows)
}

export function packagesTable(result: ScanResult, options: { ecosystem?: boolean } = {}): string | null {
  const packages = [...(result.workspace?.packages ?? [])].sort((a, b) => compareText(a.path, b.path))
  if (packages.length === 0) return null
  const header = ['Package', 'Path', 'Frameworks', 'Version']
  if (options.ecosystem) header.splice(2, 0, 'Ecosystem')
  const rows = packages.slice(0, ROW_LIMIT).map((pkg) => {
    const row = [
      code(pkg.name),
      code(pkg.path),
      frameworksIn(pkg.path, result.frameworks).map(text).join(', '),
      inline(safeText(pkg.version ?? '')),
    ]
    if (options.ecosystem) row.splice(2, 0, pkg.ecosystem === 'go' ? 'Go' : 'Node.js')
    return row
  })
  return [table(header, rows), moreLine(packages.length - ROW_LIMIT, 'packages')].filter(Boolean).join('\n\n')
}

export function entrypointsList(project: ProjectSection): string | null {
  if (project.entrypoints.length === 0) return null
  const items = project.entrypoints.map((entry) =>
    entry.kind === 'go-main'
      ? `${code(entry.path)} — Go \`main\` package`
      : `${entry.name ? `${code(entry.name)} → ` : ''}${code(entry.path)} — package.json \`bin\` command`,
  )
  return bullets(items)
}

export function structureList(project: ProjectSection): string | null {
  if (project.structure.length === 0) return null
  return bullets(project.structure.map((dir) => `${code(`${dir.path}/`)} — ${plural(dir.files, 'file')}`))
}

/** "**Vitest** 3.2.4 (tests) — in `apps/api`, `apps/web`; config `vitest.config.ts`" with evidence when verbose. */
export function toolItem(tool: Tool, options: { verbose: boolean; kind: boolean }): string {
  let head = `**${text(tool.name)}**`
  if (tool.version) head += ` ${inline(safeText(tool.version))}`
  if (options.kind) head += ` (${toolKindLabel(tool)})`
  const details: string[] = []
  if (showPackages(tool.packages)) details.push(`in ${pkgRefs(tool.packages)}`)
  if (tool.configFiles.length > 0) details.push(`config ${codeList(tool.configFiles)}`)
  if (tool.confidence !== 'high') details.push(`${tool.confidence} confidence`)
  const line = details.length > 0 ? `${head} — ${details.join('; ')}` : head
  if (!options.verbose || tool.evidence.length === 0) return line
  return `${line}\n${bullets(tool.evidence.map((item) => text(safeText(item))))}`
}

export function toolList(tools: readonly Tool[], options: { verbose: boolean; kind: boolean }): string | null {
  if (tools.length === 0) return null
  return bullets(tools.map((tool) => toolItem(tool, options)))
}

/**
 * One block per tooling group (Testing, Linting, Formatting, Types, Git
 * hooks, Build), the same grouping the terminal uses.
 */
export function toolingBlocks(result: ScanResult, level: number, verbose: boolean): string[] {
  const out: string[] = []
  const { testFiles } = result.testing
  const files = testFiles > 0 ? `${plural(testFiles, 'file')} look${testFiles === 1 ? 's' : ''} like tests.` : null
  const groups = toolingGroups(result)
  if (files && !groups.some((group) => group.label === 'Testing')) out.push(`${'#'.repeat(level)} Testing\n\n${files}`)
  for (const group of groups) {
    // Kinds only add information where a group mixes them (bundlers and task runners under Build).
    const kind = group.label === 'Build' || group.label === 'Testing'
    const body = [toolList(group.tools, { verbose, kind }), group.label === 'Testing' ? files : null]
    out.push([`${'#'.repeat(level)} ${group.label}`, ...body].filter(Boolean).join('\n\n'))
  }
  return out
}

// ---------------------------------------------------------------------------
// Services and databases
// ---------------------------------------------------------------------------

export function servicesTable(result: ScanResult): string | null {
  const { services, composeFiles } = result.services
  if (services.length === 0) return null
  const showSource = composeFiles.length > 1
  const showNotes = services.some((service) => service.profiles.length > 0 || service.healthcheck)
  const header = ['Service', 'Image / build', 'Ports', 'Depends on', 'Kind']
  if (showNotes) header.push('Notes')
  if (showSource) header.push('Defined in')
  const rows = services.slice(0, ROW_LIMIT).map((service) => {
    const origin: string[] = []
    if (service.image) origin.push(cmd(service.image))
    if (service.build !== undefined) {
      const context = buildContext(service)
      if (context !== null) origin.push(`build ${code(context)}`)
      else if (isRemoteLocation(service.build)) origin.push(`remote build ${cmd(displayRemote(service.build))}`)
      else origin.push('build from outside the repository')
    }
    const kind = service.technology ? `${service.kind} · ${text(service.technology.name)}` : service.kind
    const row = [
      code(service.name),
      origin.join(', '),
      servicePortLabels(service).map(text).join(', '),
      codeList(service.dependsOn),
      kind,
    ]
    if (showNotes) {
      const notes: string[] = []
      if (service.healthcheck) notes.push('healthcheck')
      if (service.profiles.length > 0) notes.push(`profiles: ${codeList(service.profiles)}`)
      row.push(notes.join('; '))
    }
    if (showSource) row.push(code(service.source))
    return row
  })
  return [table(header, rows), moreLine(services.length - ROW_LIMIT, 'services')].filter(Boolean).join('\n\n')
}

/** "Start the backing services with `docker compose up -d db cache`.", from the shared command engine. */
export function startServices(result: ScanResult): string | null {
  const start = servicesCommand(result)
  if (!start) return null
  const which = start.services.length > 0 ? 'the backing services' : 'the services'
  return `Start ${which} with ${cmd(start.command)}.`
}

export function dockerfilesList(result: ScanResult): string | null {
  const { dockerfiles } = result.services
  if (dockerfiles.length === 0) return null
  const items = dockerfiles.slice(0, ROW_LIMIT).map((dockerfile) => {
    const parts: string[] = []
    if (dockerfile.baseImages.length > 0) {
      const stages = dockerfile.stages > 1 ? `${dockerfile.stages} stages: ` : 'base image '
      parts.push(`${stages}${dockerfile.baseImages.map(cmd).join(' → ')}`)
    }
    if (dockerfile.exposes.length > 0)
      parts.push(`exposes ${dockerfile.exposes.map((port) => inline(safeText(port))).join(', ')}`)
    if (dockerfile.args.length > 0) parts.push(`build args ${codeList(dockerfile.args)}`)
    return parts.length > 0 ? `${code(dockerfile.path)} — ${parts.join('; ')}` : code(dockerfile.path)
  })
  return [bullets(items), moreLine(dockerfiles.length - ROW_LIMIT, 'Dockerfiles')].filter(Boolean).join('\n\n')
}

export function databasesTable(databases: readonly Database[], verbose: boolean): string | null {
  if (databases.length === 0) return null
  const header = ['Database', 'Kind', 'Detected via', 'Confidence']
  if (verbose) header.push('Evidence')
  return table(
    header,
    databases.map((database) => {
      const row = [text(database.name), database.kind, databaseSources(database).join(', '), database.confidence]
      if (verbose) row.push(database.evidence.map((item) => text(safeText(item))).join('; '))
      return row
    }),
  )
}

/** "Prisma 6.16.2 (`apps/api`), Drizzle" */
export function ormSummary(tools: readonly Tool[]): string | null {
  if (tools.length === 0) return null
  return tools
    .map((tool) => {
      const name = tool.version ? `${text(tool.name)} ${inline(safeText(tool.version))}` : text(tool.name)
      return showPackages(tool.packages) ? `${name} (${pkgRefs(tool.packages)})` : name
    })
    .join(', ')
}

/**
 * Relationships that follow from the data alone: what each package contains,
 * which variables point at a port a local service publishes or a Dockerfile
 * exposes, which services are built from which directory, and depends_on.
 * Nothing here is guessed from names.
 */
export function connections(result: ScanResult): string[] {
  const packagePaths = (result.workspace?.packages ?? []).map((pkg) => pkg.path).sort(compareText)
  const items: string[] = []

  if (packagePaths.length >= 2) {
    for (const path of packagePaths) {
      const parts: string[] = []
      const frameworks = frameworksIn(path, result.frameworks)
      if (frameworks.length > 0) parts.push(frameworks.map(text).join(', '))
      const routes = result.routes.routes.filter((route) => route.package === path)
      const api = routes.filter((route) => route.kind === 'api').length
      const pages = routes.length - api
      if (api > 0) parts.push(plural(api, 'API route'))
      if (pages > 0) parts.push(plural(pages, 'page'))
      const orms = result.databases.orms.filter((orm) => orm.packages.includes(path)).map((orm) => text(orm.name))
      if (orms.length > 0) parts.push(`data access with ${joinWords(orms)}`)
      if (parts.length > 0) items.push(`${code(path)}: ${parts.join(' · ')}`)
    }
  }

  // Files outside every workspace package are named as files: calling them "the root package"
  // would be wrong for, say, a Go module that is not part of the JavaScript workspace.
  const subject = (files: readonly string[]) => {
    if (packagePaths.length === 0 || files.length === 0) return { label: 'The code', many: false }
    const owners = unique(files.map((file) => ownerPackage(file, packagePaths)).filter((owner) => owner !== '.'))
    const loose = unique(files.filter((file) => ownerPackage(file, packagePaths) === '.'))
    const labels = [...owners.map(code), ...loose.slice(0, 2).map(code)]
    if (loose.length > 2) labels.push(plural(loose.length - 2, 'more file'))
    return { label: joinWords(labels), many: labels.length > 1 }
  }

  for (const variable of sortByName(result.environment.variables)) {
    if (!variable.used) continue
    // Remote endpoints can share a port number with a local service without being related to it.
    const localPorts = new Map<number, string>()
    for (const endpoint of variable.endpoints) {
      if (endpoint.local && endpoint.port !== null && !localPorts.has(endpoint.port)) {
        localPorts.set(endpoint.port, endpoint.scheme)
      }
    }
    for (const [port, scheme] of [...localPorts].sort(([a], [b]) => a - b)) {
      const via = `${code(variable.name)} (${text(scheme)}, port ${port})`
      const { label, many } = subject(variable.usedIn)
      const reads = many ? 'read' : 'reads'
      const services = result.services.services.filter((service) => publishedHostPorts(service).includes(port))
      if (services.length > 0) {
        const names = joinWords(services.map((service) => code(service.name)))
        const noun = services.length > 1 ? 'services publish' : 'service publishes'
        items.push(`${label} ${reads} ${via}, the port the ${names} ${noun}.`)
        continue
      }
      const dockerfiles = result.services.dockerfiles.filter((dockerfile) =>
        dockerfile.exposes.some((exposed) => Number.parseInt(exposed, 10) === port),
      )
      if (dockerfiles.length > 0) {
        items.push(`${label} ${reads} ${via}, the port ${joinWords(dockerfiles.map((d) => code(d.path)))} exposes.`)
      }
    }
  }

  for (const service of result.services.services) {
    const context = buildContext(service)
    if (context === null) continue
    const where = context === '.' ? 'the repository root' : code(context)
    items.push(`The ${code(service.name)} service is built from ${where}.`)
  }
  for (const service of result.services.services) {
    if (service.dependsOn.length === 0) continue
    items.push(`${code(service.name)} starts after ${joinWords(service.dependsOn.map(code))} (\`depends_on\`).`)
  }
  return items
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

export interface EnvTableOptions {
  /** Add the files where each variable is referenced. */
  verbose: boolean
  /** Add the example files that document each variable. */
  documentedIn?: boolean
}

/** ✓ present, ✗ missing, – no file of that kind to look in. */
function mark(present: boolean, applicable: boolean): string {
  return present ? YES : applicable ? NO : EMPTY_CELL
}

export function envTable(result: ScanResult, options: EnvTableOptions): string | null {
  const { files } = result.environment
  const variables = sortByName(result.environment.variables)
  if (variables.length === 0) return null
  const local = hasValueFiles(files)
  const example = hasExampleFiles(files)
  const header = ['Variable', 'Local', 'Example', 'Code', 'Notes']
  if (options.documentedIn) header.push('Documented in')
  if (options.verbose) header.push('Used in')
  const rows = variables.slice(0, ROW_LIMIT).map((variable) => {
    const notes = variableNotes(variable, local).map(text)
    const endpoints = variableEndpoints(variable).map(text)
    if (endpoints.length > 0) notes.push(`points at ${endpoints.join('; ')}`)
    const row = [
      code(variable.name),
      mark(variable.defined, local),
      mark(variable.documented, example),
      mark(variable.used, true),
      notes.join('; '),
    ]
    if (options.documentedIn) row.push(codeList(variable.documentedIn))
    if (options.verbose) row.push(codeList(variable.usedIn))
    return row
  })
  return [table(header, rows), moreLine(variables.length - ROW_LIMIT, 'variables')].filter(Boolean).join('\n\n')
}

export const ENV_LEGEND =
  '✓ yes, ✗ no, – no such file. _Local_: set in an env file with values (`.env`, `.env.local`, …). ' +
  '_Example_: documented in an example file (`.env.example`, …). _Code_: referenced in source or configuration. ' +
  'Values are never included.'

const ENV_FILE_KIND: Record<EnvFile['kind'], string> = {
  local: 'local',
  mode: 'mode file',
  service: 'Compose env_file',
  example: 'example',
  other: 'env file',
}

export function envFilesList(result: ScanResult): string | null {
  const { files } = result.environment
  if (files.length === 0) return null
  const items = files.map((file) => {
    const parts = [ENV_FILE_KIND[file.kind] ?? 'env file', plural(file.variables, 'variable')]
    if (file.kind === 'local' && file.tracked === true) parts.push('**tracked by Git**')
    else if (file.tracked === true) parts.push('tracked by Git')
    if (file.kind === 'local' && file.ignored === false && file.tracked !== true) parts.push('not ignored by Git')
    return `${code(file.path)} — ${parts.join(', ')}`
  })
  return bullets(items)
}

/**
 * Names grouped for a compact summary: documented, used but undocumented, set
 * locally only. Variables only tests read are left out, and so are variables
 * the OS, CI or a runner provides (CI, NODE_ENV, npm_lifecycle_event), which
 * nobody documents.
 */
export function variableGroups(variables: readonly EnvVariable[]) {
  const sorted = sortByName(variables).filter((v) => !v.testOnly)
  return {
    documented: sorted.filter((v) => v.documented),
    undocumented: sorted.filter(isUndocumented),
    localOnly: sorted.filter((v) => v.defined && !v.documented && !v.used && !isPlatformVariable(v.name)),
  }
}

// ---------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------

export function scriptsTable(scripts: readonly Script[], options: { source: boolean }): string | null {
  if (scripts.length === 0) return null
  const header = options.source ? ['Command', 'Runs', 'Source'] : ['Command', 'Runs']
  const rows = scripts.slice(0, ROW_LIMIT).map((script) => {
    const row = [cmd(script.run), script.command.trim() === '' ? '' : cmd(script.command)]
    if (options.source) row.push(code(script.source))
    return row
  })
  return [table(header, rows), moreLine(scripts.length - ROW_LIMIT, 'scripts')].filter(Boolean).join('\n\n')
}

export function packageScriptsTable(result: ScanResult): string | null {
  const { packages } = groupScripts(result.scripts.scripts)
  const scripts = packages.flatMap((group) => group.scripts.map((script) => ({ path: group.path, script })))
  if (scripts.length === 0) return null
  const rows = scripts
    .slice(0, ROW_LIMIT)
    .map(({ path, script }) => [code(path), cmd(script.run), script.command.trim() === '' ? '' : cmd(script.command)])
  return [table(['Package', 'Command', 'Runs'], rows), moreLine(scripts.length - ROW_LIMIT, 'scripts')]
    .filter(Boolean)
    .join('\n\n')
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export interface RouteTables {
  api: string | null
  pages: string | null
  /** Routes left out because of the limit. */
  hidden: number
}

function routesTable(routes: readonly Route[], method: boolean): string | null {
  if (routes.length === 0) return null
  const notes = routes.some((route) => routeNote(route) !== '')
  const header = method ? ['Method', 'Path', 'Source'] : ['Path', 'Source']
  if (notes) header.push('Notes')
  return table(
    header,
    routes.map((route) => {
      const row = [cmd(route.path), code(routeLocation(route))]
      if (method) row.unshift(route.method)
      if (notes) row.push(inline(safeText(routeNote(route))))
      return row
    }),
  )
}

/** API routes, then pages, together capped at `limit` rows. */
export function routeTables(routes: readonly Route[], limit = ROW_LIMIT): RouteTables {
  const sorted = sortRoutes(routes)
  const api = sorted.filter((route) => route.kind === 'api')
  const pages = sorted.filter((route) => route.kind === 'page')
  const shownApi = api.slice(0, limit)
  const shownPages = pages.slice(0, Math.max(0, limit - shownApi.length))
  return {
    api: routesTable(shownApi, true),
    pages: routesTable(shownPages, false),
    hidden: routes.length - shownApi.length - shownPages.length,
  }
}

// ---------------------------------------------------------------------------
// CI
// ---------------------------------------------------------------------------

/**
 * One block per workflow, headed by its file name: a workflow is usually
 * named "CI", which under a "CI" section would say nothing.
 */
export function workflowBlocks(result: ScanResult, level: number): string[] {
  const out: string[] = []
  const workflows = [...result.ci.workflows].sort((a, b) => compareText(a.file, b.file))
  for (const workflow of workflows.slice(0, ROW_LIMIT)) {
    const provider = ciProviderName(result, workflow.provider)
    const facts: string[] = []
    if (workflow.name) facts.push(`**${text(workflow.name)}**`)
    facts.push(`${code(workflow.file)} (${text(provider)})`)
    if (workflow.triggers.length > 0) facts.push(`on ${workflow.triggers.map((t) => text(t)).join(', ')}`)
    const jobs =
      workflow.jobs.length > 0
        ? table(
            ['Job', 'Tasks', 'Runs on'],
            workflow.jobs.map((job) => {
              const name = jobName(job)
              return [
                name ? `${text(name)} (${code(job.id)})` : code(job.id),
                job.tasks.map((task) => inline(task)).join(', '),
                job.runsOn.map(cmd).join(', '),
              ]
            }),
          )
        : null
    const title = `${'#'.repeat(level)} ${code(workflowLabel(workflow.file))}`
    out.push([title, facts.join(' · '), jobs].filter(Boolean).join('\n\n'))
  }
  const hidden = moreLine(workflows.length - ROW_LIMIT, 'workflows')
  if (hidden) out.push(hidden)
  const withoutWorkflows = result.ci.providers.filter((p) => !result.ci.workflows.some((w) => w.provider === p.id))
  if (withoutWorkflows.length > 0) {
    out.push(bullets(withoutWorkflows.map((provider) => `${text(provider.name)} — ${codeList(provider.files)}`)))
  }
  return out
}

// ---------------------------------------------------------------------------
// Diagnostics and notes
// ---------------------------------------------------------------------------

/** "**CODE** — message" with the hint on its own line in italics. */
export function diagnosticItem(diagnostic: Diagnostic, verbose: boolean): string {
  let item = `**${text(diagnostic.code)}** — ${prose(diagnostic.message)}`
  if (diagnostic.hint) item += `\\\n_${prose(diagnostic.hint)}_`
  if (verbose && diagnostic.files && diagnostic.files.length > 0) item += `\\\nFiles: ${codeList(diagnostic.files)}`
  return item
}

/** One "### Errors" / "### Warnings" / "### Info" block per severity that has diagnostics. */
export function diagnosticGroups(diagnostics: readonly Diagnostic[], level: number, verbose: boolean): string[] {
  const sorted = sortBySeverity(diagnostics)
  const out: string[] = []
  for (const severity of ['error', 'warning', 'info'] as const) {
    const group = sorted.filter((diagnostic) => diagnostic.severity === severity)
    if (group.length === 0) continue
    const items = group.slice(0, ROW_LIMIT).map((diagnostic) => diagnosticItem(diagnostic, verbose))
    const hidden = moreLine(group.length - ROW_LIMIT, SEVERITY_TITLE[severity].toLowerCase())
    out.push([`${'#'.repeat(level)} ${SEVERITY_TITLE[severity]}`, bullets(items), hidden].filter(Boolean).join('\n\n'))
  }
  return out
}

/** Markdown for a scan warning; the file becomes a code span. */
export function warningMessage(warning: ScanWarning): string {
  const message = warningText(warning)
  if (!warning.file) return text(message)
  // Keep the file even when the message does not mention it.
  return message.includes(warning.file) ? textWith(message, warning.file) : `${text(message)} (${code(warning.file)})`
}
