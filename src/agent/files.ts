/**
 * Renderers for the files `repolens agent init` writes into `.repolens/`.
 * Each takes the (confidence-filtered) scan result and returns Markdown
 * without the generated-file header, which `index.ts` adds.
 */
import { envSetup, keyCommands, quickStart, servicesCommand, verifyCommands } from '../output/commands.ts'
import {
  cmd,
  connections,
  DESCRIPTION_LIMIT,
  databasesTable,
  diagnosticGroups,
  dockerfilesList,
  ENV_LEGEND,
  entrypointsList,
  envFilesList,
  envTable,
  frameworksTable,
  languageSummary,
  moreLine,
  ormSummary,
  overviewRows,
  packageScriptsTable,
  packagesTable,
  pkgRefs,
  projectTitle,
  routeTables,
  scriptsTable,
  servicesTable,
  startServices,
  structureList,
  variableGroups,
} from '../output/markdown/blocks.ts'
import { bullets, code, codeList, inline, numbered, prose, section, table, text } from '../output/markdown/syntax.ts'
import {
  ciProviderName,
  countSeverities,
  frameworksByPackage,
  frameworksIn,
  groupScripts,
  jobName,
  publishedHostPorts,
  routeLocation,
  severityParts,
  sortBySeverity,
  sortRoutes,
  workflowLabel,
  workflowTasks,
} from '../output/shared/facts.ts'
import { projectTypeLabel, TERMS } from '../output/shared/labels.ts'
import { joinWords, nameWithVersion, plural, safeText, sentence, truncate } from '../output/shared/text.ts'
import type { Diagnostic, EnvVariable, ScanResult } from '../types.ts'
import { compareText } from '../utils/compare.ts'
import { conventions, filterPattern, packageManagerRule } from './conventions.ts'

/** Limits that keep agent-context.md short (about 150 lines) whatever the repository size. */
const CONTEXT_LIMITS = {
  frameworkGroups: 8,
  topLevel: 10,
  packages: 20,
  entrypoints: 5,
  services: 12,
  variables: 30,
  routes: 25,
  issues: 15,
} as const

/** agent-context.md gives the description one line; the full text is in overview.md. */
const CONTEXT_DESCRIPTION_LIMIT = 200
/** Workflows listed in development.md. */
const CI_LIMIT = 50

function title(label: string, result: ScanResult): string {
  return `# ${label}: ${projectTitle(result) ?? 'project'}`
}

function description(result: ScanResult): string | null {
  return result.project.description ? text(truncate(safeText(result.project.description), DESCRIPTION_LIMIT)) : null
}

/** "`apps/*` and `packages/*`" style list of up to `limit` names, then "and N more". */
function nameList(names: readonly string[], limit: number, more = ''): string {
  const shown = names.slice(0, limit)
  const hidden = names.length - shown.length
  const list = shown.join(', ')
  return hidden > 0 ? `${list} and ${hidden} more${more}` : list
}

// ---------------------------------------------------------------------------
// overview.md
// ---------------------------------------------------------------------------

export function renderOverview(result: ScanResult): string[] {
  const rows = overviewRows(result, { extended: true })
  return [
    title('Overview', result),
    description(result),
    rows.length > 0 ? table(['Property', 'Value'], rows) : 'RepoLens found no stack information in this directory.',
    section('Packages', 2, packagesTable(result, { ecosystem: true })),
    section('Frameworks', 2, frameworksTable(result, false)),
  ].filter((block): block is string => typeof block === 'string')
}

// ---------------------------------------------------------------------------
// architecture.md
// ---------------------------------------------------------------------------

function workspaceIntro(result: ScanResult): string | null {
  const type = projectTypeLabel(result.project.type)
  const workspace = result.workspace
  const parts: string[] = []
  if (type) parts.push(`${type}.`)
  if (workspace && workspace.tools.length > 0) {
    const tools = workspace.tools.map((tool) => `${text(tool.name)} (${code(tool.configFile)})`)
    parts.push(`Workspace managed with ${joinWords(tools)}.`)
  }
  const patterns = workspace?.patterns ?? []
  if (patterns.length > 0) parts.push(`Workspace patterns: ${codeList(patterns)}.`)
  return parts.length > 0 ? parts.join(' ') : null
}

export function renderArchitecture(result: ScanResult): string[] {
  const links = connections(result)
  const orms = ormSummary(result.databases.orms)
  const body = [
    workspaceIntro(result),
    section('Workspace packages', 2, packagesTable(result, { ecosystem: true })),
    section(TERMS.entryPoints, 2, entrypointsList(result.project)),
    section('Top-level structure', 2, structureList(result.project)),
    section('Services', 2, servicesTable(result)),
    section('Dockerfiles', 2, dockerfilesList(result)),
    section(
      'Databases',
      2,
      databasesTable(result.databases.databases, false),
      orms && `ORMs and query builders: ${orms}.`,
    ),
    section('How the pieces fit together', 2, links.length > 0 ? bullets(links.slice(0, 40)) : null),
  ].filter((block): block is string => typeof block === 'string')
  return [title('Architecture', result), ...(body.length > 0 ? body : ['RepoLens found no structure to describe.'])]
}

// ---------------------------------------------------------------------------
// commands.md
// ---------------------------------------------------------------------------

export function renderCommands(result: ScanResult): string[] {
  const groups = groupScripts(result.scripts.scripts)
  const tasks = keyCommands(result)
  const managerRule = packageManagerRule(result)
  const pattern = filterPattern(result.packageManagers.primary?.id)
  const packageScripts = packageScriptsTable(result)
  const body = [
    managerRule && `${managerRule} Mixing package managers creates conflicting lockfiles.`,
    section(
      'Everyday tasks',
      2,
      tasks.length > 0 &&
        table(
          ['Task', 'Command', 'Source'],
          tasks.map((task) => [task.label, cmd(task.command), task.fromFile ? code(task.source) : text(task.source)]),
        ),
    ),
    section('Root package.json scripts', 2, scriptsTable(groups.root, { source: false })),
    section('Task runner targets', 2, scriptsTable(groups.targets, { source: true })),
    section(
      'Workspace package scripts',
      2,
      packageScripts && pattern && `Run one package's script with ${code(pattern)}.`,
      packageScripts,
    ),
  ].filter((block): block is string => typeof block === 'string')
  return [
    title('Commands', result),
    ...(body.length > 0 ? body : ['RepoLens found no scripts or task runner targets.']),
  ]
}

// ---------------------------------------------------------------------------
// environment.md
// ---------------------------------------------------------------------------

function envSetupBlock(result: ScanResult): string | null {
  const setup = envSetup(result)
  if (!setup) return null
  if (!setup.command) {
    return `A local ${code(setup.target)} exists. Compare it with ${code(setup.example)} when variables are added.`
  }
  return numbered([
    `${cmd(setup.command.command)} — ${text(setup.command.reason)}.`,
    `Fill in the values in ${code(setup.target)}. Never commit it.`,
  ])
}

export function renderEnvironment(result: ScanResult): string[] {
  const { variables, usageTruncated } = result.environment
  const body = [
    section('Setup', 2, envSetupBlock(result)),
    section(
      'Variables',
      2,
      envTable(result, { verbose: false, documentedIn: true }),
      variables.length > 0 && ENV_LEGEND,
      usageTruncated && '_Source scanning stopped early because of file limits; the Code column may be incomplete._',
    ),
    section('Env files', 2, envFilesList(result)),
  ].filter((block): block is string => typeof block === 'string')
  return [
    title('Environment', result),
    'Variable names only: RepoLens never writes environment values into these files.',
    ...(body.length > 0 ? body : ['No environment variables or env files were found.']),
  ]
}

// ---------------------------------------------------------------------------
// services.md
// ---------------------------------------------------------------------------

export function renderServices(result: ScanResult): string[] {
  const compose = servicesTable(result)
  const orms = ormSummary(result.databases.orms)
  const body = [
    section(
      'Docker Compose',
      2,
      compose &&
        [`Defined in ${codeList(result.services.composeFiles)}.`, startServices(result)].filter(Boolean).join(' '),
      compose,
      compose && '_Ports are `host → container`; "internal" ports are only reachable from other containers._',
    ),
    section('Dockerfiles', 2, dockerfilesList(result)),
    section(
      'Databases',
      2,
      databasesTable(result.databases.databases, false),
      orms && `ORMs and query builders: ${orms}.`,
    ),
  ].filter((block): block is string => typeof block === 'string')
  return [
    title('Services', result),
    ...(body.length > 0 ? body : ['No Docker Compose services, Dockerfiles or databases were found.']),
  ]
}

// ---------------------------------------------------------------------------
// routes.md
// ---------------------------------------------------------------------------

export function renderRoutes(result: ScanResult): string[] {
  const { routes, truncated } = result.routes
  if (routes.length === 0) return [title('Routes', result), 'No HTTP routes or pages were detected.']
  const { api, pages, hidden } = routeTables(routes)
  const apiCount = routes.filter((route) => route.kind === 'api').length
  const counts = [
    apiCount > 0 ? plural(apiCount, 'API route') : null,
    routes.length > apiCount ? plural(routes.length - apiCount, 'page') : null,
  ].filter((count): count is string => count !== null)
  return [
    title('Routes', result),
    `${joinWords(counts)}, found by static analysis. Paths use \`:param\` for parameters and \`*\` for catch-alls.`,
    section('API', 2, api),
    section('Pages', 2, pages),
    moreLine(hidden, 'routes'),
    truncated && '_Route scanning stopped early because of limits; the list may be incomplete._',
  ].filter((block): block is string => typeof block === 'string')
}

// ---------------------------------------------------------------------------
// development.md
// ---------------------------------------------------------------------------

function ciChecks(result: ScanResult): string | null {
  const workflows = [...result.ci.workflows].sort((a, b) => compareText(a.file, b.file))
  const items = workflows.map((workflow) => {
    const provider = ciProviderName(result, workflow.provider)
    const triggers = workflow.triggers.length > 0 ? ` on ${workflow.triggers.map((t) => text(t)).join(', ')}` : ''
    const tasks = workflowTasks(workflow)
    const jobs = workflow.jobs.map((job) => {
      const name = jobName(job)
      const label = name ? text(name) : code(job.id)
      return job.tasks.length > 0 ? `${label} (${job.tasks.map((task) => inline(task)).join(', ')})` : label
    })
    const what = tasks.length > 0 ? `: ${tasks.join(', ')}` : ''
    return `${code(workflowLabel(workflow.file))} (${text(provider)})${triggers}${what}${jobs.length > 0 ? ` — jobs: ${jobs.join(', ')}` : ''}`
  })
  if (items.length === 0) return null
  return [bullets(items.slice(0, CI_LIMIT)), moreLine(items.length - CI_LIMIT, 'workflows')]
    .filter(Boolean)
    .join('\n\n')
}

/** "RepoLens doctor found 1 error and 2 warnings (and 1 info note). Keep them in mind …" */
function doctorIntro(diagnostics: readonly Diagnostic[]): string | null {
  const counts = countSeverities(diagnostics)
  const problems = severityParts({ ...counts, infos: 0 })
  const notes = counts.infos > 0 ? plural(counts.infos, 'info note') : ''
  if (problems.length === 0) return notes ? `RepoLens doctor has ${notes} and found no problems.` : null
  const them = counts.errors + counts.warnings === 1 ? 'it' : 'them'
  const extra = notes ? ` (and ${notes})` : ''
  return `RepoLens doctor found ${joinWords(problems)}${extra}. Keep ${them} in mind when changing the files involved.`
}

export function renderDevelopment(result: ScanResult): string[] {
  const steps = quickStart(result)
  const checks = verifyCommands(result)
  const build = keyCommands(result).find((c) => c.task === 'build')
  const diagnostics = result.doctor.diagnostics
  const body = [
    section(
      'Setup',
      2,
      steps.length > 0 && numbered(steps.map((step) => `${cmd(step.command)} — ${text(step.reason)}`)),
    ),
    section(
      'Before finishing a change',
      2,
      checks.length > 0 && 'Run these and make sure they pass:',
      checks.length > 0 && bullets(checks.map((check) => cmd(check.command))),
      build && `If the change affects the build, also run ${cmd(build.command)}.`,
    ),
    section('CI checks', 2, ciChecks(result)),
    section(TERMS.issues, 2, doctorIntro(diagnostics), ...diagnosticGroups(diagnostics, 3, false)),
  ].filter((block): block is string => typeof block === 'string')
  return [
    title('Development workflow', result),
    ...(body.length > 0 ? body : ['RepoLens found no development workflow to describe.']),
  ]
}

// ---------------------------------------------------------------------------
// agent-context.md
// ---------------------------------------------------------------------------

function projectLines(result: ScanResult): string[] {
  const type = projectTypeLabel(result.project.type)
  const workspace = result.workspace
  const head: string[] = []
  if (result.project.description) {
    head.push(sentence(text(truncate(safeText(result.project.description), CONTEXT_DESCRIPTION_LIMIT))))
  }
  if (type) {
    let kind = type
    const packages = workspace?.packages.length ?? 0
    if (packages > 0) kind += ` with ${plural(packages, 'workspace package')}`
    const tools = workspace?.tools.map((tool) => text(tool.name)) ?? []
    if (tools.length > 0) kind += ` (${tools.join(', ')})`
    head.push(sentence(kind))
  }

  const stack: string[] = []
  if (result.languages.length > 0) stack.push(`Languages: ${languageSummary(result, 4).join(', ')}`)
  const runtimes = result.runtimes.map((runtime) => text(nameWithVersion(runtime.name, runtime.version)))
  if (runtimes.length > 0)
    stack.push(`${runtimes.length === 1 ? TERMS.runtime : TERMS.runtimes}: ${runtimes.join(', ')}`)
  const stackLine = stack.length > 0 ? `${stack.join('. ')}.` : ''

  // A bare "Application." is not worth its own line.
  const lines =
    head.length === 1 && !result.project.description
      ? [[head[0], stackLine].filter(Boolean).join(' ')]
      : [head.join(' '), stackLine].filter(Boolean)

  const groups = frameworksByPackage(result.frameworks)
  if (groups.length > 0) {
    const onlyRoot = groups.every((group) => group.path === '.')
    const parts = groups.slice(0, CONTEXT_LIMITS.frameworkGroups).map((group) => {
      const names = group.frameworks.map((framework) => text(nameWithVersion(framework.name, framework.version)))
      return onlyRoot ? names.join(', ') : `${pkgRefs([group.path])}: ${names.join(', ')}`
    })
    const hidden = groups.length - parts.length
    lines.push(`Frameworks: ${parts.join('; ')}${hidden > 0 ? `; +${hidden} more packages` : ''}.`)
  }
  return lines.filter((line) => line !== '')
}

/**
 * Pointer to the full list: the companion file when the context sits next to
 * the other `.repolens/` files, otherwise the command that generates them.
 */
function seeAlso(file: string, companion: boolean): string {
  return companion ? ` (see \`${file}\`)` : ' (run `repolens agent init` for the full list)'
}

function structureLines(result: ScanResult, companion: boolean): string[] {
  const lines: string[] = []
  const { structure, entrypoints } = result.project
  if (structure.length > 0) {
    const dirs = structure
      .slice(0, CONTEXT_LIMITS.topLevel)
      .map((dir) => `${code(`${dir.path}/`)} (${plural(dir.files, 'file')})`)
    const hidden = structure.length - dirs.length
    lines.push(`Top level: ${dirs.join(', ')}${hidden > 0 ? ` and ${hidden} more` : ''}`)
  }
  const packages = [...(result.workspace?.packages ?? [])].sort((a, b) => compareText(a.path, b.path))
  for (const pkg of packages.slice(0, CONTEXT_LIMITS.packages)) {
    const frameworks = frameworksIn(pkg.path, result.frameworks).map(text)
    const name = pkg.name === pkg.path ? '' : ` — ${code(pkg.name)}`
    lines.push(`${code(pkg.path)}${name}${frameworks.length > 0 ? ` (${frameworks.join(', ')})` : ''}`)
  }
  if (packages.length > CONTEXT_LIMITS.packages) {
    lines.push(
      `… and ${packages.length - CONTEXT_LIMITS.packages} more packages${seeAlso('architecture.md', companion)}`,
    )
  }
  if (entrypoints.length > 0) {
    const shown = entrypoints
      .slice(0, CONTEXT_LIMITS.entrypoints)
      .map((entry) =>
        entry.kind === 'bin' && entry.name
          ? `${code(entry.name)} → ${code(entry.path)}`
          : `${code(entry.path)} (Go main)`,
      )
    const hidden = entrypoints.length - shown.length
    lines.push(`${TERMS.entryPoints}: ${shown.join(', ')}${hidden > 0 ? ` and ${hidden} more` : ''}`)
  }
  return lines
}

function variableNames(variables: readonly EnvVariable[], companion: boolean): string {
  return nameList(
    variables.map((variable) => code(variable.name)),
    CONTEXT_LIMITS.variables,
    seeAlso('environment.md', companion),
  )
}

function servicesLines(result: ScanResult, companion: boolean): string[] {
  const lines: string[] = []
  const { services, composeFiles } = result.services
  if (services.length > 0) {
    const names = services.map((service) => {
      const ports = publishedHostPorts(service)
      return ports.length > 0 ? `${code(service.name)} (${ports.join(', ')})` : code(service.name)
    })
    const start = servicesCommand(result)
    lines.push(
      `Services (${codeList(composeFiles)}): ${nameList(names, CONTEXT_LIMITS.services)}${start ? `. Start: ${cmd(start.command)}` : ''}`,
    )
  }
  const files = result.environment.files
  const examples = files.filter((file) => file.kind === 'example').map((file) => file.path)
  const groups = variableGroups(result.environment.variables)
  if (groups.documented.length > 0) {
    const where = examples.length > 0 ? ` (${codeList(examples.slice(0, 3))})` : ''
    lines.push(`Documented variables${where}: ${variableNames(groups.documented, companion)}`)
  }
  if (groups.undocumented.length > 0) {
    lines.push(`Used in code but undocumented: ${variableNames(groups.undocumented, companion)}`)
  }
  if (groups.localOnly.length > 0) {
    lines.push(`Set locally only: ${variableNames(groups.localOnly, companion)}`)
  }
  const setup = envSetup(result)?.command
  if (setup) lines.push(`Create the local env file with ${cmd(setup.command)}.`)
  return lines
}

function routeLines(result: ScanResult, companion: boolean): string[] {
  const api = sortRoutes(result.routes.routes.filter((route) => route.kind === 'api'))
  const pages = result.routes.routes.length - api.length
  if (api.length === 0) return []
  const lines = api.slice(0, CONTEXT_LIMITS.routes).map((route) => {
    const note = route.confidence === 'high' ? '' : ` (${route.confidence} confidence)`
    return `${code(`${route.method} ${safeText(route.path)}`)} — ${code(routeLocation(route))}${note}`
  })
  const hidden = api.length - lines.length
  if (hidden > 0) lines.push(`… and ${hidden} more API routes${seeAlso('routes.md', companion)}`)
  if (pages > 0) lines.push(`Plus ${plural(pages, 'page')}${seeAlso('routes.md', companion)}`)
  return lines
}

function issueLines(result: ScanResult): string[] {
  const issues = sortBySeverity(result.doctor.diagnostics).filter((d) => d.severity !== 'info')
  const lines = issues.slice(0, CONTEXT_LIMITS.issues).map((diagnostic) => {
    const hint = diagnostic.hint ? ` Fix: ${sentence(prose(diagnostic.hint))}` : ''
    return `${code(diagnostic.code)} (${diagnostic.severity}): ${sentence(prose(diagnostic.message))}${hint}`
  })
  const hidden = issues.length - lines.length
  if (hidden > 0) lines.push(`… and ${hidden} more (run \`repolens doctor\`)`)
  return lines
}

export interface ContextOptions {
  /**
   * True when agent-context.md is written next to the other .repolens files, so
   * it can point at them. False when it is printed on its own (`repolens agent`).
   */
  companionFiles?: boolean
}

export function renderContext(result: ScanResult, options: ContextOptions = {}): string[] {
  const companion = options.companionFiles !== false
  const commands = keyCommands(result)
  const project = projectLines(result)
  const rules = conventions(result)
  const structure = structureLines(result, companion)
  const services = servicesLines(result, companion)
  const routes = routeLines(result, companion)
  const issues = issueLines(result)
  const body = [
    section('Project', 2, project.length > 0 && bullets(project)),
    section(
      'Commands',
      2,
      commands.length > 0 && bullets(commands.map((command) => `${command.label}: ${cmd(command.command)}`)),
    ),
    section('Conventions', 2, rules.length > 0 && bullets(rules)),
    section('Structure', 2, structure.length > 0 && bullets(structure)),
    section('Services & environment', 2, services.length > 0 && bullets(services)),
    section('API routes', 2, routes.length > 0 && bullets(routes)),
    section(TERMS.issues, 2, issues.length > 0 && bullets(issues)),
  ].filter((block): block is string => typeof block === 'string')
  return [
    title('Agent context', result),
    // The generated-file header already names RepoLens; this line says how far to trust the rest.
    '_Static analysis only; verify before relying on it._',
    ...(body.length > 0 ? body : ['RepoLens found nothing to report in this directory.']),
  ]
}
