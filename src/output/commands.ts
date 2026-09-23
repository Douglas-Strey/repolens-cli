/**
 * The one place that decides which commands RepoLens suggests: the quick
 * start, the command for each everyday task, how to start the Compose
 * services and how to create the local env file. The terminal, the Markdown
 * report and the agent files all render from here, so they never disagree.
 *
 * RepoLens only prints these commands; it never runs them. Every argument
 * that comes from the repository (a file name, a service name, a directory)
 * goes through `shellQuote`, so a Compose file at
 * `deploy/$(touch pwned)/compose.yaml` can't turn a suggestion into a
 * different command. Script `run` strings are used as they are: the scripts
 * detector builds them with `shellQuote` already.
 */
import type { EnvFile, ProjectType, ScanResult, Script, ScriptCategory, Service } from '../types.ts'
import { installCommand, shellQuote } from '../utils/commands.ts'
import { compareText } from '../utils/compare.ts'
import { baseName } from '../utils/paths.ts'
import { groupScripts } from './shared/facts.ts'

/** A command-line word: RepoLens's own words are written as they are, `{ arg }` values are quoted. */
export type Word = string | { arg: string }

export function commandLine(...words: readonly Word[]): string {
  return words.map((word) => (typeof word === 'string' ? word : shellQuote(word.arg))).join(' ')
}

export interface SuggestedCommand {
  /** Exact command line to type. */
  command: string
  /** Why RepoLens suggests it, e.g. "install dependencies". */
  reason: string
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/** Script names that start a project for development, most specific first. */
const DEV_SCRIPT_NAMES = ['dev', 'start:dev', 'develop', 'serve', 'start']
/** Task runner targets that run the project. */
const RUN_TARGET_NAMES = ['dev', 'start:dev', 'develop', 'serve', 'run', 'start']
/** Root scripts that start the Compose services. */
const COMPOSE_SCRIPT_NAMES = ['db:up', 'services:up', 'docker:up', 'infra:up', 'compose:up', 'up']
/** A script body that starts Compose services. */
const COMPOSE_UP = /\bdocker(?:\s+|-)compose\b.*\bup\b/
/** Files `docker compose` reads without `-f`; override files are merged into the base file automatically. */
const DEFAULT_COMPOSE_FILE = /^(?:docker-)?compose\.ya?ml$/
const COMPOSE_OVERRIDE_FILE = /^(?:docker-)?compose\.override\.ya?ml$/
/** Task runner targets that install what the project needs. */
const SETUP_TARGETS = ['install', 'setup', 'bootstrap', 'deps']
/** Package managers whose install reads package.json. */
const JS_MANAGERS: ReadonlySet<string> = new Set(['npm', 'pnpm', 'yarn', 'bun'])

export type CommandTask = 'install' | 'dev' | 'build' | 'test' | 'lint' | 'typecheck' | 'format'

const TASK_LABEL: Record<CommandTask, string> = {
  install: 'Install',
  dev: 'Dev',
  build: 'Build',
  test: 'Test',
  lint: 'Lint',
  typecheck: 'Typecheck',
  format: 'Format',
}

const TASK_REASON: Record<CommandTask, string> = {
  install: 'install dependencies',
  dev: 'start the development server',
  build: 'build the project',
  test: 'run the tests',
  lint: 'lint the code',
  typecheck: 'check types',
  format: 'format the code',
}

const TASK_SCRIPTS: Record<
  Exclude<CommandTask, 'install' | 'dev'>,
  { names: string[]; categories: ScriptCategory[] }
> = {
  build: { names: ['build'], categories: ['build'] },
  test: { names: ['test', 'tests'], categories: ['test'] },
  lint: { names: ['lint'], categories: ['lint'] },
  typecheck: { names: ['typecheck', 'type-check', 'check-types', 'tsc', 'types'], categories: ['typecheck'] },
  format: { names: ['format', 'fmt'], categories: ['format'] },
}

/** Standard commands of a Go module, used when no script covers the task. */
const GO_COMMANDS: Partial<Record<CommandTask, string>> = { build: 'go build ./...', test: 'go test ./...' }

/** Task names npm runs `pre<name>` / `post<name>` hooks around. */
const HOOKED_NAMES = new Set([
  'install',
  'build',
  'test',
  'lint',
  'dev',
  'start',
  'publish',
  'pack',
  'version',
  'prepare',
])

// ---------------------------------------------------------------------------
// Picking scripts
// ---------------------------------------------------------------------------

/** Lifecycle hooks ("prebuild") and watch/fix variants are poor defaults for "the" command of a task. */
function isVariant(name: string, scripts: readonly Script[]): boolean {
  const hook = /^(?:pre|post)(.+)$/.exec(name)?.[1]
  if (hook && (HOOKED_NAMES.has(hook) || scripts.some((s) => s.name === hook))) return true
  return /(?:^|[:_-])(?:fix|watch)$/.test(name)
}

/** "test:watch", "watch-lint": never finishes, so it can't be a check to run before finishing a change. */
function isWatchScript(name: string): boolean {
  return /(?:^|[:_-])watch(?:$|[:_-])/.test(name)
}

/** The body `npm init` writes for "test", which always fails. */
export function isNpmTestPlaceholder(command: string): boolean {
  return /^echo\s+(["']?)Error: no test specified\1\s*&&\s*exit\s+1\s*;?$/i.test(command.trim())
}

/** A script body that deletes files wholesale (`rm -rf`, `git clean`): never offered as an example to run. */
export function isDestructiveCommand(command: string): boolean {
  return /\brm\s+-(?:[a-z]*r[a-z]*f|[a-z]*f[a-z]*r)[a-z]*\b|\brimraf\b|\bgit\s+clean\b|\bgit\s+reset\s+--hard\b/i.test(
    command,
  )
}

function pickScript(
  scripts: readonly Script[],
  names: readonly string[],
  categories: readonly ScriptCategory[],
  allowWatch = true,
): Script | undefined {
  for (const name of names) {
    const script = scripts.find((s) => s.name === name)
    if (script) return script
  }
  for (const category of categories) {
    const matches = scripts.filter((s) => s.category === category && (allowWatch || !isWatchScript(s.name)))
    const script = matches.find((s) => !isVariant(s.name, scripts)) ?? matches[0]
    if (script) return script
  }
  return undefined
}

/** Scripts that can do their job: the npm placeholder "test" script always fails. */
function usableScripts(result: ScanResult): Script[] {
  return result.scripts.scripts.filter((script) => !isNpmTestPlaceholder(script.command))
}

/** True when the root package.json could not be parsed, so its package manager can't install anything yet. */
function brokenRootManifest(result: ScanResult): boolean {
  return result.meta.warnings.some((warning) => warning.kind === 'parse' && warning.file === 'package.json')
}

// ---------------------------------------------------------------------------
// Everyday tasks
// ---------------------------------------------------------------------------

export interface KeyCommand {
  task: CommandTask
  /** "Install", "Dev", … */
  label: string
  /** Exact command to type. */
  command: string
  /** Where it comes from: a file ("package.json", "Makefile", "go.mod") or the package manager's name. */
  source: string
  /** True when `source` is a file path. */
  fromFile: boolean
  /** Why RepoLens suggests it, e.g. "start the development server". */
  reason: string
}

function installTask(result: ScanResult, targets: readonly Script[]): KeyCommand | null {
  const primary = result.packageManagers.primary
  // An invalid package.json fails every install; the doctor explains how to fix it.
  const broken = primary !== null && JS_MANAGERS.has(primary.id) && brokenRootManifest(result)
  if (primary && !broken) {
    const where =
      primary.installFrom === undefined
        ? undefined
        : primary.installFrom === ''
          ? 'install dependencies from the repository root'
          : `install dependencies from ${primary.installFrom}/ of the repository`
    return task('install', installCommand(primary.id), primary.name, false, where)
  }
  const setup = pickScript(targets, SETUP_TARGETS, [])
  return setup ? task('install', setup.run, setup.source, true) : null
}

function task(name: CommandTask, command: string, source: string, fromFile: boolean, reason?: string): KeyCommand {
  return { task: name, label: TASK_LABEL[name], command, source, fromFile, reason: reason ?? TASK_REASON[name] }
}

function devReason(type: ProjectType, script?: Script): string {
  if (type === 'cli') return 'run the CLI from source'
  if (script && (script.name === 'start' || script.category === 'start')) return 'start the app'
  if (type === 'library') return 'start development mode'
  return 'start the development server'
}

/**
 * A development script of a workspace member when the root has none: app
 * packages (under apps/, or with an application framework) before libraries.
 */
function workspaceDevScript(result: ScanResult, scripts: readonly Script[]): Script | undefined {
  const members = new Set((result.workspace?.packages ?? []).map((pkg) => pkg.path))
  const appFramework = new Set(
    result.frameworks
      .filter((framework) => framework.category !== 'library')
      .flatMap((framework) => framework.packages),
  )
  const rank = (script: Script) => {
    const path = script.package ?? ''
    const kind = /^apps?\//.test(path) ? 0 : appFramework.has(path) ? 1 : 2
    return kind * DEV_SCRIPT_NAMES.length + DEV_SCRIPT_NAMES.indexOf(script.name)
  }
  const candidates = scripts.filter(
    (script) =>
      script.package !== undefined &&
      members.has(script.package) &&
      script.source.endsWith('package.json') &&
      DEV_SCRIPT_NAMES.includes(script.name),
  )
  return candidates.sort((a, b) => rank(a) - rank(b) || compareText(a.package ?? '', b.package ?? ''))[0]
}

function devTask(result: ScanResult, scripts: readonly Script[]): KeyCommand | null {
  const groups = groupScripts(scripts)
  const type = result.project.type
  const root = pickScript(groups.root, DEV_SCRIPT_NAMES, ['dev', 'start'])
  if (root) return task('dev', root.run, root.source, true, devReason(type, root))
  const target = pickScript(groups.targets, RUN_TARGET_NAMES, ['dev', 'start'])
  if (target) return task('dev', target.run, target.source, true, 'run the project')
  const member = workspaceDevScript(result, scripts)
  if (member) {
    const reason = `${devReason(type === 'monorepo' ? 'application' : type, member)} (${member.package})`
    return task('dev', member.run, member.source, true, reason)
  }
  const goMains = result.project.entrypoints.filter((entry) => entry.kind === 'go-main')
  const main = goMains.length === 1 ? goMains[0] : undefined
  if (main) {
    const command = commandLine('go', 'run', { arg: main.path === '.' ? '.' : `./${main.path}` })
    return task('dev', command, main.path === '.' ? 'go.mod' : main.path, true, 'run the program')
  }
  return null
}

/**
 * The command to use for each everyday task, preferring root package.json
 * scripts, then Makefile-style targets, then the ecosystem's standard command
 * (only when the root is a Go module with Go code). Tasks without a command
 * are omitted, and so are scripts that can't do the job: the npm placeholder
 * "test" script always fails, and a watch script never finishes.
 */
export function keyCommands(result: ScanResult): KeyCommand[] {
  const usable = usableScripts(result)
  const groups = groupScripts(usable)
  // A go.mod without Go files (or one RepoLens couldn't parse) is not a module `go test ./...` can run.
  const goRoot =
    result.project.manifests.includes('go.mod') && result.languages.some((language) => language.name === 'Go')
  const out: KeyCommand[] = []
  const install = installTask(result, groups.targets)
  if (install) out.push(install)
  const dev = devTask(result, usable)
  if (dev) out.push(dev)
  for (const name of ['test', 'lint', 'typecheck', 'format', 'build'] as const) {
    const { names, categories } = TASK_SCRIPTS[name]
    const script =
      pickScript(groups.root, names, categories, false) ?? pickScript(groups.targets, names, categories, false)
    const fallback = goRoot ? GO_COMMANDS[name] : undefined
    if (script) out.push(task(name, script.run, script.source, true))
    else if (fallback) out.push(task(name, fallback, 'go.mod', true))
  }
  return out
}

/** Commands to run before finishing a change, in the order a developer would run them. */
export function verifyCommands(result: ScanResult): KeyCommand[] {
  const order: readonly CommandTask[] = ['lint', 'typecheck', 'test']
  return keyCommands(result)
    .filter((command) => order.includes(command.task))
    .sort((a, b) => order.indexOf(a.task) - order.indexOf(b.task))
}

/**
 * A workspace member's script to show as an example of running one package's
 * script: an everyday task, never a setup or catch-all script and never one
 * that deletes files (`rm -rf`, `git clean`), which an agent might run to try it.
 */
export function workspaceScriptExample(result: ScanResult): Script | undefined {
  const members = new Set((result.workspace?.packages ?? []).map((pkg) => pkg.path))
  const preferred: readonly ScriptCategory[] = ['dev', 'build', 'test', 'lint', 'typecheck', 'format', 'start']
  const candidates = result.scripts.scripts.filter(
    (script) =>
      script.package !== undefined &&
      members.has(script.package) &&
      preferred.includes(script.category) &&
      !isDestructiveCommand(script.command) &&
      !isNpmTestPlaceholder(script.command),
  )
  return candidates.sort((a, b) => preferred.indexOf(a.category) - preferred.indexOf(b.category))[0]
}

// ---------------------------------------------------------------------------
// Compose services
// ---------------------------------------------------------------------------

export interface ServicesCommand extends SuggestedCommand {
  /** Services named on the command line; empty when the command starts them all or a project script decides. */
  services: string[]
  /** True when some service is a database, cache, queue or other backing service a local run needs. */
  backing: boolean
}

function isBuilt(service: Service): boolean {
  return service.kind === 'app' || service.build !== undefined
}

/**
 * How to start the Compose services for local development: a root script
 * that does it, or `docker compose up -d`. When Compose also builds the
 * application itself, only the backing services are named, because the app
 * container would take the port the development server needs.
 */
export function servicesCommand(result: ScanResult): ServicesCommand | null {
  const { composeFiles, services } = result.services
  if (composeFiles.length === 0 || services.length === 0) return null
  const backingKind = (service: Service) => service.kind !== 'app' && service.kind !== 'other'
  const root = groupScripts(usableScripts(result)).root
  const script =
    pickScript(root, COMPOSE_SCRIPT_NAMES, []) ??
    root.find((s) => s.category !== 'dev' && s.category !== 'start' && COMPOSE_UP.test(s.command))
  if (script) {
    return { command: script.run, reason: 'start local services', services: [], backing: services.some(backingKind) }
  }

  const rootFiles = composeFiles.filter((file) => !file.includes('/'))
  const defaults = rootFiles.some((file) => DEFAULT_COMPOSE_FILE.test(file))
  const files = defaults
    ? rootFiles.filter((file) => DEFAULT_COMPOSE_FILE.test(file) || COMPOSE_OVERRIDE_FILE.test(file))
    : [rootFiles[0] ?? composeFiles[0] ?? '']
  const own = services.filter((service) => files.includes(service.source))
  const started = (own.length > 0 ? own : services).filter((service) => service.profiles.length === 0)
  const backing = started.filter((service) => !isBuilt(service))
  const names = started.some(isBuilt) && backing.length > 0 ? [...new Set(backing.map((service) => service.name))] : []

  const words: Word[] = ['docker', 'compose']
  if (!defaults) words.push('-f', { arg: files[0] ?? '' })
  words.push('up', '-d', ...names.map((name) => ({ arg: name })))
  return {
    command: commandLine(...words),
    reason: names.length > 0 ? 'start the backing services' : 'start local services',
    services: names,
    backing: started.some(backingKind),
  }
}

// ---------------------------------------------------------------------------
// Env file
// ---------------------------------------------------------------------------

export interface EnvSetup {
  /** Root example file, e.g. ".env.example". */
  example: string
  /** The local file it is copied to, e.g. ".env" or ".env.local". */
  target: string
  /** True when the local file already exists. */
  exists: boolean
  /** The `cp` command, when the local file still has to be created. */
  command?: SuggestedCommand
}

/** Files that hold one developer's values: .env, .env.local, .env.<mode>.local. */
const LOCAL_DOTENV = /^\.env(?:\.[^/]+)?\.local$|^\.env$/
const EXAMPLE_WORD = /^(?:example|sample|template|dist|defaults|schema)$/i
const EXAMPLE_HINT = /example|sample|template|dist|defaults|schema/i

/**
 * The file an example is meant to be copied to: ".env.example" → ".env",
 * ".env.local.example" → ".env.local", ".env.development.sample" →
 * ".env.development", "example.env" → ".env".
 */
export function exampleTarget(example: string): string {
  const parts = baseName(example).split('.')
  const exact = parts.findIndex((part, index) => index > 0 && EXAMPLE_WORD.test(part))
  const kept =
    exact !== -1
      ? parts.filter((_, index) => index !== exact)
      : parts.slice(
          0,
          Math.max(
            0,
            parts.findIndex((part) => EXAMPLE_HINT.test(part)),
          ),
        )
  const name = kept.join('.')
  if (name === '' || name === 'env' || name === '.' || name === example) return '.env'
  return name.startsWith('.env') || name.endsWith('.env') ? name : '.env'
}

function targetRank(target: string): number {
  return target === '.env' ? 0 : target === '.env.local' ? 1 : 2
}

/**
 * How the local env file relates to the root example: which file to copy
 * where, or which local file already exists. A Next.js project keeps its
 * values in `.env.local`; that counts as the local env file too.
 */
export function envSetup(result: ScanResult): EnvSetup | null {
  const rootFiles = result.environment.files.filter((file) => !file.path.includes('/'))
  const examples = rootFiles
    .filter((file) => file.kind === 'example')
    .map((file) => ({ example: file.path, target: exampleTarget(file.path) }))
    .sort((a, b) => targetRank(a.target) - targetRank(b.target) || compareText(a.example, b.example))
  const first = examples[0]
  if (!first) return null
  const local = rootFiles
    .filter((file: EnvFile) => file.kind === 'local' && LOCAL_DOTENV.test(file.path))
    .sort((a, b) => targetRank(a.path) - targetRank(b.path) || compareText(a.path, b.path))[0]
  if (local) {
    const example = examples.find((candidate) => candidate.target === local.path) ?? first
    return { example: example.example, target: local.path, exists: true }
  }
  const present = new Set(rootFiles.map((file) => file.path))
  const choice = examples.find((candidate) => !present.has(candidate.target))
  if (!choice) return { ...first, exists: true }
  const command = commandLine('cp', { arg: choice.example }, { arg: choice.target })
  return { ...choice, exists: false, command: { command, reason: 'create your local environment file' } }
}

// ---------------------------------------------------------------------------
// Quick start
// ---------------------------------------------------------------------------

export type QuickStartStepKind = 'env' | 'services' | 'install' | 'run'

export interface QuickStartStep extends SuggestedCommand {
  step: QuickStartStepKind
}

/**
 * Suggested first commands for someone who just cloned the repository:
 * create the env file, start the backing services, install, run.
 */
export function quickStart(result: ScanResult): QuickStartStep[] {
  const steps: QuickStartStep[] = []
  const env = envSetup(result)?.command
  if (env) steps.push({ step: 'env', ...env })
  const services = servicesCommand(result)
  if (services?.backing) steps.push({ step: 'services', command: services.command, reason: services.reason })
  const commands = keyCommands(result)
  for (const step of ['install', 'dev'] as const) {
    const command = commands.find((candidate) => candidate.task === step)
    if (command) steps.push({ step: step === 'dev' ? 'run' : step, command: command.command, reason: command.reason })
  }
  return steps
}

/** `repolens doctor`, with the scanned path when it was given on the command line. */
export function doctorCommand(path?: string): string {
  return path && path !== '.' ? commandLine('repolens', 'doctor', { arg: path }) : 'repolens doctor'
}

/** Characters a POSIX shell reads literally outside quotes. */
const PLAIN_CHAR = /[\w@%+=:,./-]/

/**
 * Whether a command line is safe to offer for copy-and-paste: words made of
 * plain characters and single-quoted strings (`'it'\''s'`), separated by
 * single spaces, with `&&` as the only operator. Suggestions embed
 * repository-controlled names; this is the last check before one is printed
 * as something to run.
 */
export function isCopyableCommand(command: string): boolean {
  if (command === '' || command !== command.trim()) return false
  let i = 0
  while (i < command.length) {
    const char = command[i] as string
    if (char === "'") {
      const close = command.indexOf("'", i + 1)
      if (close === -1) return false
      i = close + 1
    } else if (char === '\\' && command[i + 1] === "'") {
      i += 2
    } else if (char === ' ') {
      if (command[i + 1] === ' ') return false
      i++
    } else if (char === '&' && command.slice(i - 1, i + 3) === ' && ') {
      i += 2
    } else if (PLAIN_CHAR.test(char)) {
      i++
    } else return false
  }
  return true
}
