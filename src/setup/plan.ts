/**
 * What `repolens setup` would do in a repository: the same first steps the
 * quick start suggests (env file, backing services, install), as actions
 * RepoLens can carry out itself. Pure: it reads the scan result and decides;
 * `src/cli/setup.ts` shows the plan, asks, and runs it.
 *
 * Only commands RepoLens builds become steps. Project scripts (`make setup`,
 * `pnpm db:up`) are arbitrary shell, so they stay suggestions the developer
 * runs by hand. Every step that runs a program says up front what it can
 * execute besides RepoLens's own words: install lifecycle scripts, images
 * pulled or built by Compose.
 */
import { composeUp, envSetup, keyCommands, servicesCommand, type Word } from '../output/commands.ts'
import type { PackageManagerInfo, ScanResult, Script, Service } from '../types.ts'
import { compareText } from '../utils/compare.ts'
import { cleanUntrusted } from '../utils/text.ts'

export type SetupStepKind = 'env' | 'services' | 'install'

export type SetupAction =
  /** Copy an example env file to the local one, never overwriting. Paths relative to the scanned root. */
  | { type: 'copy'; from: string; to: string }
  /** Run `program` with `args` in the scanned root, without a shell. */
  | { type: 'exec'; program: string; args: string[] }

export interface SetupStep {
  kind: SetupStepKind
  /** The equivalent command line, as the developer would type it. */
  command: string
  /** Why, e.g. "install dependencies". */
  reason: string
  action: SetupAction
  /** What the developer should know before confirming: what else it runs, what to do after. */
  notes: string[]
}

export interface SkippedStep {
  kind: SetupStepKind
  /** Why setup leaves it out. */
  reason: string
  /** The command to run by hand, when there is one. */
  command?: string
}

export interface SetupPlan {
  steps: SetupStep[]
  skipped: SkippedStep[]
  /** Node.js versions to check before installing with a JavaScript package manager. */
  node?: NodeRequirement
  /** What to run once setup is done, e.g. "pnpm dev". */
  next?: { command: string; reason: string }
}

export interface NodeRequirement {
  /** package.json engines.node: an active version outside it stops setup. */
  required?: { range: string; file: string }
  /** The version a version manager file pins (.nvmrc, …): a different active version is only pointed out. */
  pinned?: { version: string; file: string }
}

export interface PlanOptions {
  /** Install without lifecycle scripts (`--ignore-scripts`). */
  ignoreScripts: boolean
}

/** Scripts a package manager may run on a plain local install. */
const INSTALL_LIFECYCLE = ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare']

const JS_MANAGERS: ReadonlySet<string> = new Set(['npm', 'pnpm', 'yarn', 'bun'])

/**
 * Arguments that come from the repository (a Compose file, a service name)
 * and are passed to a program: plain names only, never something the program
 * could read as an option. Anything else is left for the developer to run.
 */
const PLAIN_ARG = /^[A-Za-z0-9._/@:+=,][A-Za-z0-9._/@:+=,-]*$/

/** Program arguments for command-line words, or null when a repository-controlled word isn't a plain name. */
export function execArgs(words: readonly Word[]): string[] | null {
  const out: string[] = []
  for (const word of words) {
    if (typeof word === 'string') out.push(word)
    else if (PLAIN_ARG.test(word.arg)) out.push(word.arg)
    else return null
  }
  return out
}

function isYarnBerry(manager: PackageManagerInfo): boolean {
  return manager.evidence.some((line) => line.startsWith('Yarn Berry'))
}

/** `install` arguments for a JavaScript package manager. */
export function installArgs(manager: PackageManagerInfo, ignoreScripts: boolean): string[] {
  if (!ignoreScripts) return ['install']
  // Yarn Berry has no --ignore-scripts; skip-build leaves out every lifecycle script.
  return manager.id === 'yarn' && isYarnBerry(manager)
    ? ['install', '--mode=skip-build']
    : ['install', '--ignore-scripts']
}

/** package.json lifecycle scripts a local install may run, root first. */
export function installLifecycleScripts(result: ScanResult): Script[] {
  return result.scripts.scripts
    .filter((script) => script.source.endsWith('package.json') && INSTALL_LIFECYCLE.includes(script.name))
    .sort(
      (a, b) =>
        Number(a.source !== 'package.json') - Number(b.source !== 'package.json') ||
        compareText(a.source, b.source) ||
        INSTALL_LIFECYCLE.indexOf(a.name) - INSTALL_LIFECYCLE.indexOf(b.name),
    )
}

function lifecycleNotes(result: ScanResult, ignoreScripts: boolean): string[] {
  const scripts = installLifecycleScripts(result)
  const list = scripts.map(
    (script) => `${script.name} (${script.source}): ${cleanUntrusted(script.command, { oneLine: true })}`,
  )
  if (ignoreScripts) {
    return scripts.length > 0
      ? [`Lifecycle scripts are skipped (--ignore-scripts), including the project's own:`, ...list.map((l) => `  ${l}`)]
      : ['Lifecycle scripts are skipped (--ignore-scripts).']
  }
  const own =
    scripts.length > 0
      ? ['Runs these scripts from the repository:', ...list.map((l) => `  ${l}`)]
      : ['The project defines no install lifecycle scripts.']
  return [...own, 'Dependencies can run their own install scripts too. Use --ignore-scripts to skip them all.']
}

function installStep(result: ScanResult, options: PlanOptions): SetupStep | SkippedStep | null {
  const manager = result.packageManagers.primary
  const fallback = keyCommands(result).find((command) => command.task === 'install')
  if (!manager) {
    return fallback
      ? { kind: 'install', reason: `a project script installs dependencies`, command: fallback.command }
      : null
  }
  if (manager.installFrom !== undefined) {
    const where = manager.installFrom === '' ? 'the repository root' : `${manager.installFrom}/ of the repository`
    return {
      kind: 'install',
      reason: `dependencies are installed from ${where}; run repolens setup there`,
      ...(fallback ? { command: fallback.command } : {}),
    }
  }
  if (manager.id === 'go') {
    return {
      kind: 'install',
      command: 'go mod download',
      reason: 'download Go modules',
      action: { type: 'exec', program: 'go', args: ['mod', 'download'] },
      notes: [],
    }
  }
  if (!JS_MANAGERS.has(manager.id)) {
    return fallback
      ? { kind: 'install', reason: `RepoLens doesn't install with ${manager.name}`, command: fallback.command }
      : null
  }
  if (!fallback) {
    // keyCommands leaves install out when package.json can't be parsed.
    return { kind: 'install', reason: "package.json can't be parsed; repolens doctor explains why" }
  }
  const args = installArgs(manager, options.ignoreScripts)
  const notes = lifecycleNotes(result, options.ignoreScripts)
  if (manager.guessed) notes.unshift(`${manager.name} is a best guess: the project doesn't declare a package manager.`)
  return {
    kind: 'install',
    command: [manager.id, ...args].join(' '),
    reason: 'install dependencies',
    action: { type: 'exec', program: manager.id, args },
    notes,
  }
}

function imageNotes(started: readonly Service[]): string[] {
  const images = [...new Set(started.flatMap((service) => (service.image ? [service.image] : [])))].sort()
  const builds = started.filter((service) => service.build !== undefined).map((service) => service.name)
  const notes: string[] = []
  if (images.length > 0)
    notes.push(`Pulls images if needed: ${images.map((i) => cleanUntrusted(i, { oneLine: true })).join(', ')}`)
  if (builds.length > 0) {
    notes.push(
      `Builds images from the repository's Dockerfiles: ${builds.map((b) => cleanUntrusted(b, { oneLine: true })).join(', ')}`,
    )
  }
  return notes
}

function servicesStep(result: ScanResult): SetupStep | SkippedStep | null {
  const suggested = servicesCommand(result)
  if (!suggested?.backing) return null
  if (suggested.script) {
    return { kind: 'services', reason: 'a project script starts the services', command: suggested.command }
  }
  const up = composeUp(result)
  const args = up ? execArgs(up.words) : null
  if (!up || !args) {
    return { kind: 'services', reason: 'unusual Compose file or service names', command: suggested.command }
  }
  const [program = 'docker', ...rest] = args
  return {
    kind: 'services',
    command: suggested.command,
    reason: suggested.reason,
    action: { type: 'exec', program, args: rest },
    notes: imageNotes(up.started),
  }
}

function envStep(result: ScanResult): SetupStep | SkippedStep | null {
  const env = envSetup(result)
  if (!env) return null
  if (env.exists || !env.command) {
    return { kind: 'env', reason: `${env.target} already exists; setup never changes it` }
  }
  return {
    kind: 'env',
    command: env.command.command,
    reason: env.command.reason,
    action: { type: 'copy', from: env.example, to: env.target },
    notes: [`Then fill in your own values: the file starts as a copy of ${env.example}.`],
  }
}

/** Root files where version managers (nvm, fnm, nodenv, asdf, mise) read the Node.js version, in priority order. */
const PIN_FILES = ['.nvmrc', '.node-version', '.tool-versions', 'mise.toml', '.mise.toml']

export function nodeRequirement(result: ScanResult): NodeRequirement | null {
  const sources = result.runtimes.find((runtime) => runtime.id === 'node')?.sources ?? []
  const engines = sources.find((source) => source.file === 'package.json' && source.field === 'engines.node')
  const pin = PIN_FILES.map((file) => sources.find((source) => source.file === file && source.kind === 'exact')).find(
    (source) => source?.version,
  )
  const requirement: NodeRequirement = {}
  if (engines?.version) requirement.required = { range: engines.version, file: 'package.json' }
  if (pin?.version) requirement.pinned = { version: pin.version, file: pin.file }
  return requirement.required || requirement.pinned ? requirement : null
}

function isStep(step: SetupStep | SkippedStep): step is SetupStep {
  return 'action' in step
}

/** The setup plan for a scan result. */
export function setupPlan(result: ScanResult, options: PlanOptions): SetupPlan {
  const plan: SetupPlan = { steps: [], skipped: [] }
  for (const candidate of [envStep(result), servicesStep(result), installStep(result, options)]) {
    if (!candidate) continue
    if (isStep(candidate)) plan.steps.push(candidate)
    else plan.skipped.push(candidate)
  }

  const install = plan.steps.find((step) => step.kind === 'install')
  if (install?.action.type === 'exec' && JS_MANAGERS.has(install.action.program)) {
    const node = nodeRequirement(result)
    if (node) plan.node = node
  }

  const dev = keyCommands(result).find((command) => command.task === 'dev')
  if (dev) plan.next = { command: dev.command, reason: dev.reason }
  return plan
}
