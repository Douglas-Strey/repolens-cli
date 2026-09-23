import { useOr } from '../core/context.ts'
import { getString, isRecord } from '../core/parse.ts'
import { manifests, type PackageManifest } from '../facts/manifests.ts'
import type { Detector, PackageManagerId, ProjectContext, Script, ScriptCategory } from '../types.ts'
import { runScriptCommand, scriptRunner, shellQuote } from '../utils/commands.ts'
import { compareText } from '../utils/compare.ts'
import { isUnder } from '../utils/path-roles.ts'
import { dirOf } from '../utils/paths.ts'
import { redactCommand } from '../utils/redact.ts'
import { packageManagersDetector } from './package-managers.ts'

/** A task parsed from a Makefile, justfile, Taskfile or deno.json. */
export interface ParsedTask {
  name: string
  /** Raw first command (not yet redacted); "" when unknown. */
  command: string
}

/**
 * Longest command kept in the output. Scripts are displayed, not executed, and
 * redactCommand's regexes are superlinear on long unbroken input, so a
 * hostile package.json must not be able to hand them megabytes.
 */
export const MAX_COMMAND_LENGTH = 1000

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const NAME_CATEGORIES: Readonly<Record<string, ScriptCategory>> = {
  dev: 'dev',
  develop: 'dev',
  watch: 'dev',
  start: 'start',
  serve: 'start',
  preview: 'start',
  run: 'start',
  build: 'build',
  compile: 'build',
  bundle: 'build',
  test: 'test',
  tests: 'test',
  coverage: 'test',
  e2e: 'test',
  spec: 'test',
  lint: 'lint',
  eslint: 'lint',
  format: 'format',
  fmt: 'format',
  prettier: 'format',
  typecheck: 'typecheck',
  'type-check': 'typecheck',
  tsc: 'typecheck',
  'check-types': 'typecheck',
  types: 'typecheck',
  db: 'database',
  migrate: 'database',
  migration: 'database',
  migrations: 'database',
  seed: 'database',
  prisma: 'database',
  drizzle: 'database',
  deploy: 'deploy',
  release: 'release',
  publish: 'release',
  version: 'release',
  changeset: 'release',
  postinstall: 'setup',
  prepare: 'setup',
  preinstall: 'setup',
  install: 'setup',
  setup: 'setup',
  bootstrap: 'setup',
}

/** `tsc … --noEmit` within one command of a chain. Split instead of `tsc[^;&|]*--noemit`, which backtracks quadratically. */
function isTscNoEmit(cmd: string): boolean {
  return cmd.split(/[;&|]/).some((part) => {
    const tsc = part.search(/\btsc\b/)
    return tsc !== -1 && /--noemit\b/.test(part.slice(tsc))
  })
}

const matches =
  (pattern: RegExp) =>
  (cmd: string): boolean =>
    pattern.test(cmd)

/** Used only when the name says nothing. Order matters: `tsc --noEmit` is a typecheck, plain `tsc` a build. */
const COMMAND_RULES: ReadonlyArray<readonly [(cmd: string) => boolean, ScriptCategory]> = [
  [
    matches(
      /\b(?:vitest|jest|mocha|ava|playwright\s+test|cypress\s+run|node\s+--test|go\s+test|pytest|bun\s+test|deno\s+test|cargo\s+test)\b/,
    ),
    'test',
  ],
  [matches(/\b(?:eslint|oxlint|stylelint|golangci-lint|biome\s+(?:check|lint|ci)|ruff\s+check|next\s+lint)\b/), 'lint'],
  [matches(/\b(?:prettier|biome\s+format|dprint\s+fmt|gofmt|go\s+fmt|ruff\s+format|cargo\s+fmt)\b/), 'format'],
  [(cmd) => /\b(?:vue-tsc|svelte-check|nuxt\s+typecheck)\b/.test(cmd) || isTscNoEmit(cmd), 'typecheck'],
  [matches(/\b(?:prisma|drizzle-kit|knex\s+(?:migrate|seed)|sequelize|typeorm)\b/), 'database'],
  [
    matches(
      /\b(?:tsc|tsup|tsdown|webpack|rollup|esbuild|vite\s+build|next\s+build|nuxt\s+(?:build|generate)|astro\s+build|go\s+build|docker\s+build|cargo\s+build)\b/,
    ),
    'build',
  ],
  [
    matches(/--watch\b|\b(?:nodemon|tsx\s+watch|next\s+dev|nuxt\s+dev|astro\s+dev)\b|^vite(?:\s+(?:dev|serve))?\s*$/),
    'dev',
  ],
  [
    matches(
      /\b(?:vercel|netlify\s+deploy|wrangler\s+deploy|fly(?:ctl)?\s+deploy|serverless\s+deploy|sls\s+deploy|kubectl\s+apply|helm\s+(?:upgrade|install))\b/,
    ),
    'deploy',
  ],
  [matches(/\b(?:changeset|semantic-release|release-it|(?:npm|pnpm|yarn)\s+publish)\b/), 'release'],
]

function categoryOfSegments(segments: readonly string[]): ScriptCategory | undefined {
  if (segments.length < 2) return undefined
  const first = segments[0] as string
  const last = segments[segments.length - 1] as string
  // "start:dev", "api:dev": a trailing dev marker describes the whole script.
  if (last === 'dev' || last === 'develop') return 'dev'
  return NAME_CATEGORIES[first] ?? NAME_CATEGORIES[last]
}

function categoryOfName(rawName: string): ScriptCategory | undefined {
  const name = rawName.trim().toLowerCase()
  const exact = NAME_CATEGORIES[name]
  if (exact) return exact
  // npm lifecycle hooks: "prebuild" runs with "build".
  const hook = /^(?:pre|post)(.+)$/.exec(name)?.[1]
  if (hook && NAME_CATEGORIES[hook]) return NAME_CATEGORIES[hook]
  return categoryOfSegments(name.split(':')) ?? categoryOfSegments(name.split(/[-_]/))
}

/** Categorize a script. The name wins; the command is only consulted when the name is not recognized. */
export function classifyScript(name: string, command = ''): ScriptCategory {
  const byName = categoryOfName(name)
  if (byName) return byName
  const cmd = command.slice(0, MAX_COMMAND_LENGTH).trim().toLowerCase()
  for (const [test, category] of COMMAND_RULES) {
    if (test(cmd)) return category
  }
  return 'other'
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Shorten an over-long command before it is redacted. The token that the cut
 * splits is dropped (it could be the start of a credential that redaction
 * would no longer recognize), and so is a quoted value left unclosed.
 */
export function clipCommand(command: string, max = MAX_COMMAND_LENGTH): string {
  if (command.length <= max) return command
  let cut = command.slice(0, max)
  const lastSpace = cut.search(/\s\S*$/)
  cut = lastSpace === -1 ? '' : cut.slice(0, lastSpace)
  for (const quote of ['"', "'"]) {
    if (cut.split(quote).length % 2 === 0) cut = cut.slice(0, cut.lastIndexOf(quote))
  }
  cut = cut.trimEnd()
  return cut === '' ? '…' : `${cut} …`
}

function words(list: string): ReadonlySet<string> {
  return new Set(list.trim().split(/\s+/))
}

/**
 * Commands that `pnpm <name>` / `yarn <name>` run instead of a script with the
 * same name: pnpm's own commands, the ones it hands to npm (`docs`, `version`,
 * `info`, …) and the aliases of `test`; Yarn Classic and Berry commands
 * combined. `pnpm deploy` or `pnpm setup` would do something else entirely, so
 * scripts with these names get an explicit `run`.
 */
const BUILTIN_COMMANDS: ReadonlyMap<PackageManagerId, ReadonlySet<string>> = new Map([
  [
    'pnpm',
    words(`
    add approve-builds audit bin c cat-file cat-index config create dedupe deploy dlx doctor env exec fetch
    find-hash help i ignored-builds import init install install-test it la licenses link list ll ln ls m multi
    outdated pack patch patch-commit patch-remove prune publish rb rebuild recursive remove rm root run
    self-update server setup store t tst un uninstall unlink up update upgrade why
    access adduser bugs deprecate dist-tag docs edit info login logout owner ping prefix profile pkg repo s se
    search set-script show star stars team token unpublish unstar v version view whoami xmas`),
  ],
  [
    'yarn',
    words(`
    access add audit autoclean bin cache check config constraints create dedupe dlx exec explain
    generate-lock-entry global help import info init install licenses link list login logout node npm outdated
    owner pack patch patch-commit plugin policies publish rebuild remove run search set stage tag team unlink
    unplug up upgrade upgrade-interactive version versions why workspace workspaces`),
  ],
])

/** `run ` when the package manager would treat the script name as one of its own commands. */
function runKeyword(manager: PackageManagerId | null | undefined, script: string): string {
  return manager && BUILTIN_COMMANDS.get(manager)?.has(script) ? 'run ' : ''
}

/** Command that runs a script of the root package, e.g. "pnpm dev", "npm test", "pnpm run deploy". */
export function packageRunCommand(manager: PackageManagerId | null | undefined, script: string): string {
  if (runKeyword(manager, script)) return `${manager} run ${shellQuote(script)}`
  return runScriptCommand(manager, shellQuote(script))
}

const PACKAGE_NAME = /^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/i

/** Command that runs `script` in a workspace member. Falls back to the directory when the package has no usable name. */
export function workspaceRunCommand(
  manager: PackageManagerId | null | undefined,
  pkg: { name?: string; dir: string },
  script: string,
): string {
  const name = pkg.name && PACKAGE_NAME.test(pkg.name) ? pkg.name : undefined
  const s = `${runKeyword(manager, script)}${shellQuote(script)}`
  switch (manager) {
    case 'pnpm':
      return `pnpm --filter ${shellQuote(name ?? `./${pkg.dir}`)} ${s}`
    case 'yarn':
      // `yarn workspace` only takes a package name.
      return name ? `yarn workspace ${shellQuote(name)} ${s}` : nestedRunCommand(manager, pkg.dir, script)
    case 'bun':
      return `bun run --filter ${shellQuote(name ?? `./${pkg.dir}`)} ${s}`
    default:
      return `npm run ${s} -w ${shellQuote(pkg.dir)}`
  }
}

/**
 * Command for a package that is not a workspace member. Workspace filters
 * (`--filter`, `-w`) only select workspace members, so change directory instead.
 */
export function nestedRunCommand(manager: PackageManagerId | null | undefined, dir: string, script: string): string {
  return `cd ${shellQuote(dir)} && ${packageRunCommand(manager, script)}`
}

// ---------------------------------------------------------------------------
// Makefile
// ---------------------------------------------------------------------------

const MAKE_DIRECTIVES = new Set([
  'export',
  'unexport',
  'override',
  'private',
  'include',
  '-include',
  'sinclude',
  'vpath',
])
const MAKE_TARGET = /^[A-Za-z0-9_][A-Za-z0-9_.\-/+]*$/

/** A recipe command without Make's `@` (silent), `-` (ignore errors) and `+` prefixes. */
function stripRecipePrefix(command: string): string {
  return command.trim().replace(/^[@+-]+\s*/, '')
}

/** First recipe line of a Make rule. */
function firstRecipeLine(lines: readonly string[], start: number): string {
  for (let i = start; i < lines.length; i++) {
    const line = lines[i] as string
    if (line.startsWith('\t')) {
      const command = stripRecipePrefix(line)
      if (command !== '' && !command.startsWith('#')) return command
      continue
    }
    if (line.trim() === '' || line.startsWith('#')) continue
    return ''
  }
  return ''
}

/**
 * Targets a developer can run with `make <target>`, in file order. Skips
 * special targets (.PHONY, suffix rules), pattern rules, variable assignments,
 * target-specific variables and anything built from `$(…)` expansions.
 */
export function parseMakefile(text: string): ParsedTask[] {
  const lines = text.split(/\r?\n/)
  const tasks: ParsedTask[] = []
  const seen = new Map<string, ParsedTask>()
  let inDefine = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    if (inDefine) {
      if (/^\s*endef\b/.test(line)) inDefine = false
      continue
    }
    if (/^(?:(?:export|override)\s+)?define\b/.test(line)) {
      inDefine = true
      continue
    }
    if (line === '' || /^\s/.test(line) || line.startsWith('#')) continue

    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const head = line.slice(0, colon)
    let rest = line.slice(colon + 1)
    if (rest.startsWith('=') || rest.startsWith(':=')) continue // ":=" and "::=" assignments
    if (rest.startsWith(':')) rest = rest.slice(1) // double-colon rule
    if (/[=$(){}%]/.test(head)) continue // assignments ("URL = http://…"), expansions, pattern rules
    if (/^\s*[A-Za-z_][\w.-]*\s*(?:[:?+!]?=)/.test(rest)) continue // target-specific variable

    const words = head.trim().split(/\s+/)
    if (MAKE_DIRECTIVES.has(words[0] as string)) continue
    const semicolon = rest.indexOf(';')
    const inline = semicolon === -1 ? '' : stripRecipePrefix(rest.slice(semicolon + 1))
    const command = inline || firstRecipeLine(lines, i + 1)

    for (const name of words) {
      if (!MAKE_TARGET.test(name)) continue
      const existing = seen.get(name)
      if (existing) {
        if (existing.command === '' && command !== '') existing.command = command
        continue
      }
      const task = { name, command }
      seen.set(name, task)
      tasks.push(task)
    }
  }
  return tasks
}

// ---------------------------------------------------------------------------
// justfile
// ---------------------------------------------------------------------------

/** Index of the `:` that ends a recipe header, or -1 (for `:=` assignments or no colon). Quoted defaults may contain colons. */
function recipeColon(rest: string): number {
  let quote: string | null = null
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i] as string
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch
    else if (ch === ':') return rest[i + 1] === '=' ? -1 : i
    else if (ch === '#') return -1
  }
  return -1
}

function firstJustBodyLine(lines: readonly string[], start: number): string {
  for (let i = start; i < lines.length; i++) {
    const line = lines[i] as string
    if (line.trim() === '') continue
    if (!/^\s/.test(line)) return ''
    const command = line.trim().replace(/^[@-]+\s*/, '')
    if (command !== '' && !command.startsWith('#')) return command
  }
  return ''
}

/** Public recipes of a justfile, in file order. Private recipes (`_name` or `[private]`) are skipped. */
export function parseJustfile(text: string): ParsedTask[] {
  const lines = text.split(/\r?\n/)
  const tasks: ParsedTask[] = []
  const seen = new Set<string>()
  let privateNext = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    if (line === '' || /^\s/.test(line) || line.startsWith('#')) continue
    if (line.startsWith('[')) {
      if (/\bprivate\b/.test(line)) privateNext = true
      continue
    }
    const isPrivate = privateNext
    privateNext = false
    if (/^(?:set|alias|export|import\??|mod\??|unexport)\s/.test(line)) continue

    const match = /^@?([A-Za-z_][A-Za-z0-9_-]*)(?=[\s:])/.exec(line)
    if (!match?.[1]) continue
    const name = match[1]
    if (recipeColon(line.slice(match[0].length)) === -1) continue
    if (isPrivate || name.startsWith('_') || seen.has(name)) continue
    seen.add(name)
    tasks.push({ name, command: firstJustBodyLine(lines, i + 1) })
  }
  return tasks
}

// ---------------------------------------------------------------------------
// Taskfile and deno.json
// ---------------------------------------------------------------------------

function firstTaskCommand(cmds: unknown): string | undefined {
  const list = Array.isArray(cmds) ? cmds : [cmds]
  for (const item of list) {
    if (typeof item === 'string' && item.trim() !== '') return item.trim()
    const cmd = getString(item, 'cmd')
    if (cmd && cmd.trim() !== '') return cmd.trim()
    const task = getString(item, 'task')
    if (task) return `task ${task}`
  }
  return undefined
}

/** Tasks of a parsed Taskfile (go-task), in declaration order. Internal and wildcard tasks are skipped. */
export function parseTaskfile(doc: unknown): ParsedTask[] {
  if (!isRecord(doc) || !isRecord(doc.tasks)) return []
  const tasks: ParsedTask[] = []
  for (const [name, def] of Object.entries(doc.tasks)) {
    if (name.includes('*')) continue
    if (typeof def === 'string' || Array.isArray(def)) {
      tasks.push({ name, command: firstTaskCommand(def) ?? '' })
      continue
    }
    if (isRecord(def) && def.internal === true) continue
    const command =
      firstTaskCommand(isRecord(def) ? def.cmds : undefined) ?? getString(def, 'cmd') ?? getString(def, 'desc')
    tasks.push({ name, command: command?.trim() ?? '' })
  }
  return tasks
}

/** Tasks of a parsed deno.json: `"name": "cmd"` or `"name": { "command": "cmd" }`. */
export function parseDenoTasks(doc: unknown): ParsedTask[] {
  if (!isRecord(doc) || !isRecord(doc.tasks)) return []
  const tasks: ParsedTask[] = []
  for (const [name, def] of Object.entries(doc.tasks)) {
    const command = typeof def === 'string' ? def : getString(def, 'command')
    tasks.push({ name, command: command?.trim() ?? '' })
  }
  return tasks
}

// ---------------------------------------------------------------------------
// Nx project.json targets
// ---------------------------------------------------------------------------

/** Bounds for hostile workspaces; real ones have tens of projects with a handful of targets each. */
const MAX_NX_PROJECTS = 500
const MAX_NX_TARGETS = 100

export interface NxProject {
  /** Project name used on the nx command line. */
  name: string
  targets: ParsedTask[]
}

/** First command of an Nx target: the run-commands command, or the executor that runs it. */
function nxTargetCommand(def: unknown): string {
  if (typeof def === 'string') return def
  if (!isRecord(def)) return ''
  const options = isRecord(def.options) ? def.options : {}
  const commands = Array.isArray(options.commands) ? options.commands : []
  const first = commands[0]
  return (
    getString(def, 'command') ??
    getString(options, 'command') ??
    (typeof first === 'string' ? first : getString(first, 'command')) ??
    getString(def, 'executor') ??
    ''
  ).trim()
}

/**
 * Targets of a parsed Nx project.json. The project name defaults to the
 * directory name, as in Nx. Null when the file has no targets (Nx may still
 * infer some from plugins, which RepoLens cannot see without running Nx).
 */
export function parseNxProject(doc: unknown, dir: string): NxProject | null {
  if (!isRecord(doc) || !isRecord(doc.targets)) return null
  const name = getString(doc, 'name')?.trim() || (dir === '.' ? undefined : dir.slice(dir.lastIndexOf('/') + 1))
  if (!name) return null
  const targets = Object.entries(doc.targets)
    .slice(0, MAX_NX_TARGETS)
    .map(([target, def]) => ({ name: target, command: nxTargetCommand(def) }))
  return targets.length > 0 ? { name, targets } : null
}

/** Nx commands that `nx <name> <project>` would run instead of a target with the same name. */
const NX_COMMANDS = words(`
  add affected connect daemon exec format format:check format:write g generate graph import init list login logout
  migrate new record release repair report reset run run-many show sync sync:check view-logs watch`)

/** How to run nx from the workspace's own dependencies. */
function nxPrefix(manager: PackageManagerId | null | undefined): string {
  switch (manager) {
    case 'pnpm':
      return 'pnpm nx'
    case 'yarn':
      return 'yarn nx'
    case 'bun':
      return 'bunx nx'
    default:
      return 'npx nx'
  }
}

/** `npx nx serve web`, or `npx nx run web:graph` when the target shares a name with an Nx command. */
export function nxRunCommand(manager: PackageManagerId | null | undefined, project: string, target: string): string {
  if (/^[\w-]+$/.test(target) && !NX_COMMANDS.has(target)) {
    return `${nxPrefix(manager)} ${shellQuote(target)} ${shellQuote(project)}`
  }
  return `${nxPrefix(manager)} run ${shellQuote(`${project}:${target}`)}`
}

async function nxScripts(ctx: ProjectContext, manager: PackageManagerId): Promise<Script[]> {
  if (!ctx.files.has('nx.json')) return []
  const files = ctx.files
    .byName('project.json')
    .filter((file) => !isUnder(file, ['fixture', 'example', 'template']))
    .sort(compareText)
    .slice(0, MAX_NX_PROJECTS)
  const docs = await Promise.all(files.map((file) => ctx.readJson(file)))
  return files.flatMap((file, index) => {
    const dir = dirOf(file)
    const project = parseNxProject(docs[index], dir)
    if (!project) return []
    return project.targets.map((target) =>
      script(target.name, target.command, nxRunCommand(manager, project.name, target.name), file, dir),
    )
  })
}

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

const MAKEFILES = ['GNUmakefile', 'makefile', 'Makefile'] // GNU make's lookup order
const JUSTFILES = ['justfile', 'Justfile', '.justfile']
const TASKFILES = ['Taskfile.yml', 'taskfile.yml', 'Taskfile.yaml', 'taskfile.yaml']
const DENO_FILES = ['deno.json', 'deno.jsonc']

function script(name: string, command: string, run: string, source: string, pkg?: string): Script {
  const redacted = redactCommand(clipCommand(command))
  const out: Script = { name, command: redacted, run, source, category: classifyScript(name, redacted) }
  if (pkg !== undefined) out.package = pkg
  return out
}

function packageScripts(manifest: PackageManifest, manager: PackageManagerId): Script[] {
  return Object.entries(manifest.scripts).map(([name, body]) => {
    const run =
      manifest.role === 'root'
        ? packageRunCommand(manager, name)
        : manifest.role === 'workspace'
          ? workspaceRunCommand(manager, manifest, name)
          : nestedRunCommand(manager, manifest.dir, name)
    return script(name, body, run, manifest.file, manifest.dir)
  })
}

async function fileTasks(
  ctx: ProjectContext,
  candidates: readonly string[],
  parse: (ctx: ProjectContext, file: string) => Promise<ParsedTask[]>,
  runPrefix: string,
): Promise<Script[]> {
  const file = candidates.find((candidate) => ctx.files.has(candidate))
  if (!file) return []
  const tasks = await parse(ctx, file)
  return tasks.map((task) => script(task.name, task.command, `${runPrefix} ${shellQuote(task.name)}`, file))
}

const readTextAnd =
  (parse: (text: string) => ParsedTask[]) =>
  async (ctx: ProjectContext, file: string): Promise<ParsedTask[]> => {
    const text = await ctx.readText(file)
    return text === null ? [] : parse(text)
  }

export const scriptsDetector: Detector<'scripts'> = {
  id: 'scripts',
  title: 'Scripts',
  async run(ctx) {
    const [project, packageManagers] = await Promise.all([
      ctx.use(manifests),
      useOr(ctx, packageManagersDetector, { primary: null, detected: [] }),
    ])
    const primary = packageManagers.primary?.id
    const manager: PackageManagerId = primary && primary !== 'go' ? primary : 'npm'
    const runner = ctx.files.has('package.json') ? scriptRunner(manager) : null

    // manifests.packages is already root first, then sorted by directory.
    const scripts: Script[] = project.packages.flatMap((manifest) => packageScripts(manifest, manager))
    scripts.push(...(await nxScripts(ctx, manager)))

    const groups = await Promise.all([
      fileTasks(ctx, DENO_FILES, async (c, file) => parseDenoTasks(await c.readJsonc(file)), 'deno task'),
      fileTasks(ctx, MAKEFILES, readTextAnd(parseMakefile), 'make'),
      fileTasks(ctx, JUSTFILES, readTextAnd(parseJustfile), 'just'),
      fileTasks(ctx, TASKFILES, async (c, file) => parseTaskfile(await c.readYaml(file)), 'task'),
    ])
    for (const group of groups) scripts.push(...group)

    return { runner, scripts }
  },
}
