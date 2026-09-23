import { filterByConfidence } from '../../core/confidence.ts'
import type { Confidence, Dockerfile, EnvVariable, Route, ScanResult, Script, Tool } from '../../types.ts'
import { doctorCommand, envSetup, isCopyableCommand, quickStart } from '../commands.ts'
import {
  buildContext,
  configNote,
  describeGit,
  describeProjectType,
  dockerfileSummary,
  frameworksIn,
  groupScripts,
  hasExampleFiles,
  hasValueFiles,
  isPlatformVariable,
  isUndocumented,
  noteWarnings,
  pickKeyFiles,
  routeLocation,
  serviceDockerfile,
  servicePorts,
  sortBySeverity,
  sortByUrgency,
  toolingGroups,
  topLanguages,
  uncoveredWarnings,
  unusedDockerfiles,
  warningText,
  workflowLabel,
  workflowTasks,
} from '../shared/facts.ts'
import { databaseSources, frameworkCategory, packageLabel, TERMS } from '../shared/labels.ts'
import { detailLine, formatNumber, formatShare, nameWithVersion, plural, safeText } from '../shared/text.ts'
import type { RenderOptions } from '../style.ts'
import {
  commaList,
  confidenceTag,
  diagnosticLines,
  dotList,
  ellipsis,
  evidenceLines,
  flow,
  heading,
  type KeyValueRow,
  keyValue,
  LABEL_WIDTH,
  longest,
  makeContext,
  moreLine,
  moreMarker,
  padCell,
  passSpan,
  type RenderContext,
  renderBlocks,
  summaryItems,
  withTag,
} from './common.ts'
import { append, charCount, hanging, joinFit, type Line, lineWidth, spaces, span, table } from './text.ts'

interface Section {
  title: string
  /** Dim text after the title, built for the columns left on the title line. */
  subtitle?: (max: number) => Line
  lines: Line[]
}

const LIMITS = {
  workspacePackages: 12,
  services: 15,
  dockerfiles: 5,
  variables: 12,
  rootScripts: 10,
  targets: 8,
  routes: 15,
  issues: 10,
  notes: 5,
  keyFiles: 8,
  languages: 4,
} as const

const VERBOSE_HINT = 'use --verbose'

/** What the renderer hid because of `--verbose`, counted before filtering. */
interface Hidden {
  lowConfidenceRoutes: number
}

function limitFor(count: number, ctx: RenderContext): number {
  return ctx.verbose ? Number.POSITIVE_INFINITY : count
}

function sectionLines(section: Section, ctx: RenderContext): Line[] {
  const title: Line = [span(section.title, ctx.s.bold)]
  if (section.subtitle) {
    const subtitle = section.subtitle(ctx.width - charCount(section.title) - 2)
    if (subtitle.length > 0) title.push(spaces(2), ...subtitle)
  }
  return [title, ...section.lines]
}

function hintLine(text: string, ctx: RenderContext): Line {
  return [spaces(2), span(text, ctx.s.dim)]
}

// ---------------------------------------------------------------------------
// Overview sections
// ---------------------------------------------------------------------------

function titleBlock(result: ScanResult, ctx: RenderContext): Line[] {
  const { s } = ctx
  const lines: Line[] = [heading('RepoLens', result.project.name, ctx)]
  const description = safeText(result.project.description ?? '').trim()
  if (description) lines.push([span(description, s.dim)])
  if (result.meta.truncated) {
    const message =
      `Scan stopped at the file limit (${formatNumber(result.meta.files)} files); ` +
      'results may be incomplete. Raise it with --max-files.'
    append(lines, hanging([span(`${s.symbols.warn} `, s.dim)], message, s.dim, ctx.width))
  }
  return lines
}

function projectSection(result: ScanResult, ctx: RenderContext): Section | null {
  const { s } = ctx
  const rows: KeyValueRow[] = []

  const separator = ` ${s.symbols.dot} `
  const type = describeProjectType(result.project, result.workspace, { separator })
  if (type) {
    const short = describeProjectType(result.project, result.workspace, { separator, tools: false }) ?? type
    rows.push({ label: 'Type', value: (max) => [span(charCount(type) <= max || !short ? type : short)] })
  }

  const languages = topLanguages(result.languages, ctx.verbose ? result.languages.length : LIMITS.languages)
  if (languages.length > 0) {
    const items = languages.map((language) => `${language.name} ${formatShare(language.share)}`)
    rows.push({ label: 'Languages', value: (max) => dotList(items, max, ctx) })
  }

  const managers = result.packageManagers.primary ? [result.packageManagers.primary] : result.packageManagers.detected
  if (managers.length > 0) {
    const items = managers.map((manager) => nameWithVersion(manager.name, manager.version))
    rows.push({
      label: 'Package manager',
      value: (max) => dotList(items, max, ctx),
      extra: ctx.verbose ? evidenceLines([...new Set(managers.flatMap((m) => m.evidence))], ctx) : [],
    })
  }

  if (result.runtimes.length > 0) {
    const items = result.runtimes.map((runtime) => nameWithVersion(runtime.name, runtime.version))
    const sources = result.runtimes.flatMap((runtime) =>
      runtime.sources.map((source) => {
        const field = source.field ? ` (${source.field})` : ''
        return `${runtime.name} ${source.version ?? source.raw} in ${source.file}${field}`
      }),
    )
    rows.push({
      label: result.runtimes.length === 1 ? TERMS.runtime : TERMS.runtimes,
      value: (max) => dotList(items, max, ctx),
      extra: ctx.verbose ? evidenceLines(sources, ctx) : [],
    })
  }

  const entrypoints = result.project.entrypoints.map(
    (entry): Line =>
      entry.kind === 'bin' ? [span(entry.name ?? entry.path), span(' (bin)', s.dim)] : [span(entry.path)],
  )
  if (entrypoints.length > 0) rows.push({ label: TERMS.entryPoints, value: (max) => dotList(entrypoints, max, ctx) })

  const git = describeGit(result.git, result.project.repository)
  if (git.length > 0) {
    rows.push({ label: result.git ? 'Git' : 'Repository', value: (max) => dotList(git, max, ctx) })
  }

  if (ctx.verbose && result.project.structure.length > 0) {
    const items = result.project.structure.map(
      (dir): Line => [span(`${dir.path}/`), span(` ${formatNumber(dir.files)}`, s.dim)],
    )
    rows.push({ label: 'Structure', value: (max) => dotList(items, max, ctx) })
  }

  return rows.length > 0 ? { title: 'Project', lines: keyValue(rows, ctx) } : null
}

function frameworksSection(result: ScanResult, ctx: RenderContext): Section | null {
  const { frameworks } = result
  if (frameworks.length === 0) return null
  // In a single-package repository every framework lives in "."; the category says more.
  const byPackage = frameworks.some((framework) => framework.packages.some((path) => path !== '.'))
  const rows = frameworks.map(
    (framework): KeyValueRow => ({
      label: nameWithVersion(framework.name, framework.version),
      value: (max) => {
        const tag = verboseTag(framework.confidence, ctx)
        const room = max - (tag.length > 0 ? lineWidth(tag) + 2 : 0)
        const main = byPackage
          ? commaList(framework.packages.map(packageLabel), room, ctx)
          : [span(frameworkCategory(framework), ctx.s.dim)]
        return withTag(main, tag)
      },
      extra: ctx.verbose ? evidenceLines(framework.evidence, ctx) : [],
    }),
  )
  return { title: 'Frameworks', lines: keyValue(rows, ctx) }
}

function workspaceSection(result: ScanResult, ctx: RenderContext): Section | null {
  const workspace = result.workspace
  if (!workspace || workspace.packages.length === 0) return null
  const shown = workspace.packages.slice(0, limitFor(LIMITS.workspacePackages, ctx))
  const rows = shown.map((pkg) => {
    const frameworks = frameworksIn(pkg.path, result.frameworks)
    const stack: Line =
      frameworks.length > 0
        ? [span(frameworks.join(', '))]
        : pkg.ecosystem === 'go'
          ? [span('Go module', ctx.s.dim)]
          : []
    return [pkg.path, pkg.name === pkg.path ? '' : pkg.name, stack]
  })
  const { lines } = table(rows, { width: ctx.width, unicode: ctx.unicode, min: [LABEL_WIDTH], max: [32, 32] })
  const hidden = workspace.packages.length - shown.length
  if (hidden > 0) lines.push(moreLine(hidden, VERBOSE_HINT, ctx))
  return { title: 'Workspace', lines }
}

function quickStartSection(result: ScanResult, ctx: RenderContext): Section | null {
  // The engine quotes every repository-derived argument; this is the last check before printing.
  const steps = quickStart(result)
    .map((step) => ({ ...step, command: safeText(step.command) }))
    .filter((step) => isCopyableCommand(step.command))
  if (steps.length === 0) return null
  const { s } = ctx
  // Commands are meant to be copied, so the reasons go before a command would be cut.
  const room = ctx.width - 2 - `${steps.length}.`.length - 1
  const withReasons = steps.every((step) => charCount(step.command) <= Math.min(44, room - 14))
  const rows = steps.map((step, index) => {
    const row = [span(`${index + 1}.`, s.dim), span(step.command, s.cyan)]
    return withReasons ? [...row, span(step.reason, s.dim)] : row
  })
  const { lines } = table(rows, { width: ctx.width, unicode: ctx.unicode, gap: [1, 2], minLast: 0 })
  return { title: TERMS.quickStart, lines }
}

function servicesSection(result: ScanResult, ctx: RenderContext): Section | null {
  const { services, composeFiles, dockerfiles } = result.services
  if (services.length === 0) return null
  const { s } = ctx

  const shown = services.slice(0, limitFor(LIMITS.services, ctx))
  const rows = shown.map((service) => {
    // A service built from a Dockerfile RepoLens read shows what that Dockerfile builds on.
    const dockerfile = serviceDockerfile(service, dockerfiles)
    const built = dockerfile ? dockerfileSummary(dockerfile) : ''
    const image: Line = service.image
      ? [span(safeText(service.image))]
      : service.build !== undefined
        ? [
            span(`build ${buildContext(service) ?? safeText(service.build)}`, s.dim),
            ...(built ? [span(` ${s.symbols.arrow} `, s.dim), span(built)] : []),
          ]
        : []
    const ports: Line = []
    for (const port of servicePorts(service)) {
      if (ports.length > 0) ports.push(spaces(1))
      ports.push(span(port.text, port.published ? undefined : s.dim))
    }
    const technology: Line = service.technology
      ? [span(service.technology.name)]
      : service.kind !== 'other'
        ? [span(service.kind, s.dim)]
        : []
    if (service.profiles.length > 0) {
      technology.push(span(`${technology.length > 0 ? '  ' : ''}profile ${service.profiles.join(', ')}`, s.dim))
    }
    return [service.name, image, ports, technology]
  })
  const { lines } = table(rows, {
    width: ctx.width,
    unicode: ctx.unicode,
    min: ['Dockerfile'.length],
    max: [20, 40, 24],
  })
  const hidden = services.length - shown.length
  if (hidden > 0) lines.push(moreLine(hidden, VERBOSE_HINT, ctx))
  return { title: 'Services', subtitle: (max) => commaList(composeFiles, max, ctx, s.dim), lines }
}

/** Dockerfiles no Compose service builds from: "Dockerfile  node:22-alpine  3 stages  expose 3000". */
function dockerfilesSection(result: ScanResult, ctx: RenderContext): Section | null {
  const { s } = ctx
  const dockerfiles: Dockerfile[] = unusedDockerfiles(result.services.services, result.services.dockerfiles)
  if (dockerfiles.length === 0) return null
  const shown = dockerfiles.slice(0, limitFor(LIMITS.dockerfiles, ctx))
  const rows = shown.map((dockerfile) => {
    const base = dockerfile.baseImages[dockerfile.baseImages.length - 1]
    return [
      [span(dockerfile.path)],
      base ? [span(safeText(base))] : [],
      dockerfile.stages > 1 ? [span(`${dockerfile.stages} stages`, s.dim)] : [],
      dockerfile.exposes.length > 0
        ? [span(`expose ${dockerfile.exposes.map((port) => safeText(port)).join(' ')}`, s.dim)]
        : [],
    ]
  })
  const { lines } = table(rows, { width: ctx.width, unicode: ctx.unicode, max: [40, 44], minLast: 0 })
  if (dockerfiles.length > shown.length) lines.push(moreLine(dockerfiles.length - shown.length, VERBOSE_HINT, ctx))
  return { title: 'Dockerfiles', lines }
}

function databasesSection(result: ScanResult, ctx: RenderContext): Section | null {
  const { databases, orms } = result.databases
  if (databases.length === 0 && orms.length === 0) return null
  const rows: KeyValueRow[] = databases.map((database) => {
    const sources = databaseSources(database)
    return {
      label: database.name,
      value: () =>
        withTag(
          sources.length > 0 ? [span(`via ${sources.join(', ')}`, ctx.s.dim)] : [],
          verboseTag(database.confidence, ctx),
        ),
      extra: ctx.verbose ? evidenceLines(database.evidence, ctx) : [],
    }
  })
  if (orms.length > 0) {
    rows.push({
      label: orms.length === 1 ? 'ORM' : 'ORMs',
      value: (max) => toolList(orms, max, ctx, true),
      extra: ctx.verbose ? toolEvidence(orms, ctx) : [],
    })
  }
  return { title: 'Databases', lines: keyValue(rows, ctx) }
}

function verboseTag(confidence: Confidence, ctx: RenderContext): Line {
  return ctx.verbose ? confidenceTag(confidence, ctx) : []
}

function environmentSection(result: ScanResult, ctx: RenderContext): Section | null {
  const { files, variables, usageTruncated } = result.environment
  if (files.length === 0 && variables.length === 0) return null
  const { s } = ctx
  const hasLocal = hasValueFiles(files)
  const hasExample = hasExampleFiles(files)
  const none = ctx.unicode ? '–' : '-'
  // Variables only tests read are noise in an overview of what the app needs.
  const listed = ctx.verbose ? variables : variables.filter((variable) => !variable.testOnly)
  const sorted = sortByUrgency(listed, hasLocal)
  const shown = sorted.slice(0, limitFor(LIMITS.variables, ctx))

  const mark = (present: boolean, missing: Line): Line => (present ? [span(s.symbols.pass, s.green)] : missing)
  const cross = (paint = s.dim): Line => [span(s.symbols.fail, paint)]
  const rows: Line[][] = shown.map((variable) => {
    // Only a variable the project itself sets or reads needs documenting; CI, NODE_ENV and friends don't.
    const needsExample = isUndocumented(variable) || (variable.defined && !isPlatformVariable(variable.name))
    return [
      [span(safeText(variable.name))],
      mark(variable.defined, hasLocal ? cross() : [span(none, s.dim)]),
      mark(variable.documented, hasExample ? cross(needsExample ? s.yellow : s.dim) : [span(none, s.dim)]),
      mark(variable.used, cross()),
      variableTags(variable, ctx),
    ]
  })
  const header: Line[] = [[], [span(TERMS.local, s.dim)], [span(TERMS.example, s.dim)], [span(TERMS.code, s.dim)], []]
  const lines: Line[] = []
  if (rows.length > 0) {
    append(
      lines,
      table([header, ...rows], {
        width: ctx.width,
        unicode: ctx.unicode,
        min: [LABEL_WIDTH, 5, 7, 4],
        max: [36],
        align: [undefined, 'center', 'center', 'center'],
        minLast: 0,
      }).lines,
    )
  }
  const hidden = sorted.length - shown.length
  if (hidden > 0) lines.push(moreLine(hidden, VERBOSE_HINT, ctx))
  const testOnly = variables.length - listed.length
  if (testOnly > 0) {
    const noun = testOnly === 1 ? 'test-only variable' : 'test-only variables'
    lines.push(hintLine(`${ellipsis(ctx)} ${formatNumber(testOnly)} ${noun} (${VERBOSE_HINT})`, ctx))
  }
  if (variables.length > 0 && (!hasLocal || !hasExample)) {
    const missing = [!hasLocal && (envSetup(result)?.target ?? '.env'), !hasExample && '.env.example']
    lines.push(hintLine(`${none} file not present (${missing.filter(Boolean).join(', ')})`, ctx))
  }
  if (usageTruncated) lines.push(hintLine('Source scan stopped early; some variable usages may be missing.', ctx))

  const envFiles = files.map((file) => file.path)
  return {
    title: 'Environment',
    subtitle: (max) => {
      const count = plural(variables.length, 'variable')
      const room = max - charCount(count) - 3
      if (envFiles.length === 0 || room < 8) return [span(count, s.dim)]
      return [span(`${count} `, s.dim), span(s.symbols.dot, s.dim), spaces(1), ...commaList(envFiles, room, ctx, s.dim)]
    },
    lines,
  }
}

function variableTags(variable: EnvVariable, ctx: RenderContext): Line {
  const tags: string[] = []
  // A variable exposed to the browser is public by definition, whatever its name suggests.
  if (variable.public) tags.push('public')
  else if (ctx.verbose && variable.sensitive) tags.push('secret')
  if (variable.fallback) tags.push('default')
  if (variable.testOnly) tags.push('test only')
  if (ctx.verbose) {
    for (const endpoint of variable.endpoints) {
      const port = endpoint.port === null ? '' : ` :${endpoint.port}`
      tags.push(`${endpoint.scheme}${port}${endpoint.local ? ' (local)' : ''}`)
    }
    if (variable.suspiciousValueIn.length > 0) {
      tags.push(`real-looking value in ${variable.suspiciousValueIn.join(', ')}`)
    }
  }
  return tags.length > 0 ? [span([...new Set(tags)].join(', '), ctx.s.dim)] : []
}

function scriptRows(scripts: readonly Script[], ctx: RenderContext): KeyValueRow[] {
  return scripts.map((script) => ({
    label: safeText(script.run),
    value: () => (script.command ? [span(safeText(script.command), ctx.s.dim)] : []),
  }))
}

function scriptsSection(result: ScanResult, ctx: RenderContext): Section | null {
  const groups = groupScripts(result.scripts.scripts)
  const root = groups.root.slice(0, limitFor(LIMITS.rootScripts, ctx))
  const targets = groups.targets.slice(0, limitFor(LIMITS.targets, ctx))
  const packageScripts = groups.packages.reduce((total, group) => total + group.scripts.length, 0)
  if (root.length === 0 && targets.length === 0 && packageScripts === 0) return null

  const lines = keyValue(scriptRows([...root, ...targets], ctx), ctx, { wrap: ctx.verbose })
  const hidden = groups.root.length - root.length + (groups.targets.length - targets.length)
  if (hidden > 0) lines.push(moreLine(hidden, VERBOSE_HINT, ctx))

  if (ctx.verbose) {
    // One label column for every package, wide enough for `pnpm --filter <name> <script>`.
    const runs = groups.packages.flatMap((group) => group.scripts.map((script) => safeText(script.run)))
    const maxLabel = longest(runs, 48)
    for (const group of groups.packages) {
      lines.push([spaces(2), span(group.path)])
      append(
        lines,
        keyValue(scriptRows(group.scripts, ctx), ctx, { indent: 4, maxLabel, minLabel: maxLabel, wrap: true }),
      )
    }
  } else if (packageScripts > 0) {
    const where = groups.packages.length === 1 ? 'a workspace package' : 'workspace packages'
    lines.push(hintLine(`${ellipsis(ctx)} ${plural(packageScripts, 'script')} in ${where} (${VERBOSE_HINT})`, ctx))
  }
  return { title: TERMS.scripts, lines }
}

function uncertainRoute(route: Route): boolean {
  return route.confidence !== 'high' && Boolean(route.note)
}

function routeCell(route: Route, ctx: RenderContext): Line {
  return [span(route.path), ...(uncertainRoute(route) ? [span(' ?', ctx.s.dim)] : [])]
}

/** Compact route table: long paths and locations are cut to keep one line per route. */
function routeTableLines(routes: readonly Route[], ctx: RenderContext): Line[] {
  const { s } = ctx
  const rows = routes.map((route) => [
    route.kind === 'page' ? [span('page', s.dim)] : [span(route.method)],
    routeCell(route, ctx),
    [span(routeLocation(route), s.dim)],
  ])
  return table(rows, { width: ctx.width, unicode: ctx.unicode, min: [7], gap: [1, 2], max: [7, 44] }).lines
}

/**
 * Verbose route list: paths are never cut. Locations line up after the paths
 * when they fit and move to their own line when they don't; notes are wrapped
 * under the path.
 */
function verboseRouteLines(routes: readonly Route[], ctx: RenderContext): Line[] {
  const { s } = ctx
  const pathColumn = 2 + 7 + 1
  const natural = routes.reduce((most, route) => Math.max(most, lineWidth(routeCell(route, ctx))), 0)
  const column = Math.min(natural, Math.floor((ctx.width - pathColumn) * 0.6))
  const lines: Line[] = []
  for (const route of routes) {
    const method = route.kind === 'page' ? padCell('page', 7, ctx, s.dim) : padCell(route.method, 7, ctx)
    const prefix: Line = [spaces(2), ...method, spaces(1)]
    const head: Line = [...prefix, ...routeCell(route, ctx)]
    const location = routeLocation(route)
    const width = Math.max(lineWidth(head), pathColumn + column) + 2
    if (lineWidth(head) > ctx.width) {
      // Wider than the terminal: wrapped, never cut.
      append(lines, hanging(prefix, `${route.path}${uncertainRoute(route) ? ' ?' : ''}`, undefined, ctx.width))
      append(lines, hanging([spaces(pathColumn)], location, s.dim, ctx.width))
    } else if (width + charCount(location) <= ctx.width) {
      lines.push([...head, spaces(width - lineWidth(head)), span(location, s.dim)])
    } else {
      lines.push(head)
      append(lines, hanging([spaces(pathColumn)], location, s.dim, ctx.width))
    }
    if (route.note) append(lines, hanging([spaces(pathColumn)], route.note, s.dim, ctx.width))
  }
  return lines
}

function routesSection(result: ScanResult, ctx: RenderContext, hidden: Hidden): Section | null {
  const { routes, truncated } = result.routes
  if (routes.length === 0 && hidden.lowConfidenceRoutes === 0) return null
  const { s } = ctx
  const api = routes.filter((route) => route.kind === 'api')
  const pages = routes.filter((route) => route.kind === 'page')
  // Pages are summarized unless asked for, but they are the only routes a frontend-only app has.
  const listPages = ctx.verbose || api.length === 0
  const candidates = listPages ? [...api, ...pages] : api
  const shown = candidates.slice(0, limitFor(LIMITS.routes, ctx))
  const lines = ctx.verbose ? verboseRouteLines(shown, ctx) : routeTableLines(shown, ctx)

  const more = candidates.length - shown.length
  const unlisted = listPages ? 0 : pages.length
  if (more > 0 && unlisted > 0) {
    lines.push(
      hintLine(
        `${ellipsis(ctx)} ${formatNumber(more)} more API routes and ${plural(unlisted, 'page')} (${VERBOSE_HINT})`,
        ctx,
      ),
    )
  } else if (more > 0) {
    lines.push(moreLine(more, VERBOSE_HINT, ctx))
  } else if (unlisted > 0) {
    lines.push(hintLine(`${ellipsis(ctx)} ${plural(unlisted, 'page')} not listed (${VERBOSE_HINT})`, ctx))
  }
  if (hidden.lowConfidenceRoutes > 0) {
    const noun = hidden.lowConfidenceRoutes === 1 ? 'route' : 'routes'
    lines.push(hintLine(`+${formatNumber(hidden.lowConfidenceRoutes)} low-confidence ${noun} (${VERBOSE_HINT})`, ctx))
  }
  if (!ctx.verbose && shown.some(uncertainRoute)) lines.push(hintLine('? prefix may apply', ctx))
  if (truncated) lines.push(hintLine('Route scan stopped early; some routes may be missing.', ctx))

  const counts: string[] = []
  if (api.length > 0) counts.push(`${formatNumber(api.length)} API`)
  if (pages.length > 0) counts.push(plural(pages.length, 'page'))
  return { title: 'Routes', subtitle: () => [span(counts.join(` ${s.symbols.dot} `), s.dim)], lines }
}

function ciSection(result: ScanResult, ctx: RenderContext): Section | null {
  const { providers, workflows } = result.ci
  if (providers.length === 0 && workflows.length === 0) return null
  const { s } = ctx
  const rows: KeyValueRow[] = workflows.map((workflow) => {
    const tasks = workflowTasks(workflow)
    const extra: Line[] = []
    if (ctx.verbose) {
      const parts: string[] = []
      if (workflow.triggers.length > 0) parts.push(`on ${workflow.triggers.join(', ')}`)
      parts.push(plural(workflow.jobs.length, 'job'))
      const runners = [...new Set(workflow.jobs.flatMap((job) => job.runsOn))]
      if (runners.length > 0) parts.push(runners.join(', '))
      extra.push([span(parts.join(` ${s.symbols.dot} `), s.dim)])
    }
    return {
      label: workflowLabel(workflow.file),
      // What a workflow runs, not whether it passed: no status symbols here.
      value: (max) => (tasks.length > 0 ? dotList(tasks, max, ctx) : [span('no recognized tasks', s.dim)]),
      extra,
    }
  })
  // Providers whose configuration could not be broken into workflows are still worth naming.
  const covered = new Set(workflows.map((workflow) => workflow.file))
  for (const provider of providers) {
    for (const file of provider.files) {
      if (!covered.has(file)) rows.push({ label: workflowLabel(file), value: () => [span('not analyzed', s.dim)] })
    }
  }
  return {
    title: 'CI',
    subtitle: (max) =>
      commaList(
        providers.map((provider) => provider.name),
        max,
        ctx,
        s.dim,
      ),
    lines: keyValue(rows, ctx),
  }
}

function toolList(tools: readonly Tool[], max: number, ctx: RenderContext, versions = ctx.verbose): Line {
  const items = tools.map((tool): Line => {
    const name = versions ? nameWithVersion(tool.name, tool.version) : tool.name
    return ctx.verbose && tool.confidence !== 'high'
      ? [span(name), span(` (${tool.confidence})`, ctx.s.dim)]
      : [span(name)]
  })
  return joinFit(items, [span(', ')], max, moreMarker(ctx), ctx.unicode)
}

function toolEvidence(tools: readonly Tool[], ctx: RenderContext): Line[] {
  return tools.flatMap((tool) => evidenceLines(tool.evidence, ctx, `${tool.name}: `))
}

function toolingSection(result: ScanResult, ctx: RenderContext): Section | null {
  const { s } = ctx
  const { testFiles } = result.testing
  const rows: KeyValueRow[] = []
  const groups = toolingGroups(result)
  if (testFiles > 0 && !groups.some((group) => group.label === 'Testing')) {
    rows.push({ label: 'Testing', value: () => [span(plural(testFiles, 'test file'), s.dim)] })
  }
  for (const group of groups) {
    const files = group.label === 'Testing' && testFiles > 0 ? `  (${plural(testFiles, 'test file')})` : ''
    rows.push({
      label: group.label,
      value: (max) => {
        // The tool names matter more than the count; drop the count before squeezing them out.
        if (files === '' || max - charCount(files) < 12) return toolList(group.tools, max, ctx)
        return [...toolList(group.tools, max - charCount(files), ctx), span(files, s.dim)]
      },
      extra: ctx.verbose ? toolEvidence(group.tools, ctx) : [],
    })
  }
  return rows.length > 0 ? { title: TERMS.tooling, lines: keyValue(rows, ctx) } : null
}

function keyFilesSection(result: ScanResult, ctx: RenderContext): Section | null {
  const files = result.configFiles
  if (files.length === 0) return null
  const generic = result.frameworks.length === 0 && result.packageManagers.primary === null
  if (!ctx.verbose && !generic) return null
  const shown = ctx.verbose ? files : pickKeyFiles(files, LIMITS.keyFiles)
  const rows: KeyValueRow[] = shown.map((file) => ({
    label: file.path,
    value: () => [span(file.description, ctx.s.dim)],
  }))
  const lines = keyValue(rows, ctx, { maxLabel: 40 })
  const hidden = files.length - shown.length
  if (hidden > 0) lines.push(moreLine(hidden, VERBOSE_HINT, ctx))
  return { title: ctx.verbose ? TERMS.configFiles : 'Key files', lines }
}

// ---------------------------------------------------------------------------
// Problems
// ---------------------------------------------------------------------------

function issuesSection(result: ScanResult, ctx: RenderContext): Section | null {
  const visible = sortBySeverity(result.doctor.diagnostics).filter(
    (diagnostic) => ctx.verbose || diagnostic.severity !== 'info',
  )
  if (visible.length === 0) return null
  const shown = visible.slice(0, limitFor(LIMITS.issues, ctx))
  const codeWidth = longest(
    shown.map((diagnostic) => diagnostic.code),
    32,
  )
  const lines: Line[] = []
  for (const diagnostic of shown) append(lines, diagnosticLines(diagnostic, codeWidth, 2, ctx))
  const hidden = visible.length - shown.length
  if (hidden > 0) lines.push(moreLine(hidden, `run ${doctorCommand(ctx.commandPath)}`, ctx))
  return { title: TERMS.issues, lines }
}

function notesSection(result: ScanResult, ctx: RenderContext): Section | null {
  // Outside verbose mode, a warning already listed under the issues is not repeated.
  const all = noteWarnings(result.meta)
  const warnings = ctx.verbose ? all : uncoveredWarnings(all, result.doctor.diagnostics)
  if (warnings.length === 0) return null
  const { s } = ctx
  const shown = warnings.slice(0, limitFor(LIMITS.notes, ctx))
  const lines: Line[] = []
  for (const warning of shown) {
    append(
      lines,
      hanging([spaces(2), span(s.symbols.bullet, s.dim), spaces(1)], warningText(warning), undefined, ctx.width),
    )
    const detail = ctx.verbose && warning.detail ? detailLine(warning.detail) : ''
    if (detail) append(lines, hanging([spaces(4)], detail, s.dim, ctx.width))
  }
  const hidden = warnings.length - shown.length
  if (hidden > 0) lines.push(moreLine(hidden, VERBOSE_HINT, ctx))
  if (!ctx.verbose && warnings.some((warning) => warning.detail)) {
    lines.push(hintLine('Run with --verbose to see technical details.', ctx))
  }
  return { title: 'Notes', lines }
}

function summarySection(result: ScanResult, ctx: RenderContext): Section {
  const { s } = ctx
  const { summary, diagnostics } = result.doctor
  const lines: Line[] = []
  const items = summaryItems(summary, ctx, {
    passedLabel: (count) => `${plural(count, 'check')} passed`,
    skipped: false,
  })
  if (items.length === 0) lines.push([spaces(2), passSpan(s), span(' No problems found')])
  else append(lines, flow(items, [spaces(3)], [spaces(2)], 2, ctx.width))
  if (diagnostics.length > 0) {
    const message = `Run ${doctorCommand(ctx.commandPath)} for details and fixes.`
    append(lines, hanging([spaces(2)], message, s.dim, ctx.width))
  }
  const configured = configNote(result, ctx.verbose)
  if (configured) append(lines, hanging([spaces(2)], configured, s.dim, ctx.width))
  return { title: 'Summary', lines }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

type SectionBuilder = (result: ScanResult, ctx: RenderContext, hidden: Hidden) => Section | null

const OVERVIEW_SECTIONS: readonly SectionBuilder[] = [
  projectSection,
  frameworksSection,
  workspaceSection,
  quickStartSection,
  servicesSection,
  dockerfilesSection,
  databasesSection,
  environmentSection,
  scriptsSection,
  routesSection,
  ciSection,
  toolingSection,
  keyFilesSection,
]

/**
 * Low-confidence findings are hidden unless `verbose` is set. The result may
 * already be filtered (filtering twice changes nothing); given the full
 * result, the overview can also say how many routes it left out.
 */
export function renderScanOverview(full: ScanResult, options: RenderOptions): string {
  const ctx = makeContext(options)
  const { s } = ctx
  const result = ctx.verbose ? full : filterByConfidence(full)
  const hidden: Hidden = { lowConfidenceRoutes: full.routes.routes.length - result.routes.routes.length }

  if (ctx.quiet) {
    const issues = issuesSection(result, ctx)
    if (!issues) return renderBlocks([[[passSpan(s), span(' No problems found')]]], ctx)
    return renderBlocks([sectionLines(issues, ctx), sectionLines(summarySection(result, ctx), ctx)], ctx)
  }

  const blocks: Line[][] = [titleBlock(result, ctx)]
  const overview = OVERVIEW_SECTIONS.map((build) => build(result, ctx, hidden)).filter((section) => section !== null)
  if (overview.length === 0) blocks.push([[span('RepoLens found no recognizable project files here.', s.dim)]])
  for (const section of overview) blocks.push(sectionLines(section, ctx))
  for (const section of [issuesSection(result, ctx), notesSection(result, ctx), summarySection(result, ctx)]) {
    if (section) blocks.push(sectionLines(section, ctx))
  }
  return renderBlocks(blocks, ctx)
}
