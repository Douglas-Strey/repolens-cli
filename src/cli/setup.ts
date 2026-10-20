/**
 * `repolens setup`: show the setup plan, ask, then carry it out. The only
 * command that runs anything, and only what the plan printed.
 */
import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { RepoLensError } from '../core/errors.ts'
import { readTextWithin } from '../core/fs.ts'
import { versionFitsRange } from '../doctor/rules/runtime.ts'
import { doctorCommand } from '../output/commands.ts'
import type { Style } from '../output/style.ts'
import type { SetupHost } from '../setup/host.ts'
import { type SetupPlan, type SetupStep, setupPlan } from '../setup/plan.ts'
import type { ScanResult } from '../types.ts'
import { cleanUntrusted } from '../utils/text.ts'

export const EXIT_SETUP_FAILED = 1

/** Largest example env file setup copies. */
const MAX_ENV_BYTES = 1024 * 1024
const NO_FOLLOW = process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0)
const CREATE_NEW = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW

export interface SetupRun {
  result: ScanResult
  /** The scanned directory (commands run here) and its real path. */
  root: string
  realRoot: string
  host: SetupHost
  style: Style
  write: (text: string) => void
  writeError: (text: string) => void
  /** Asks a yes/no question in the terminal; undefined when there is no terminal to ask in. */
  confirm?: (question: string) => Promise<boolean>
  yes: boolean
  dryRun: boolean
  ignoreScripts: boolean
  /** Path to repeat in suggested commands, when the user typed one. */
  commandPath?: string
  /** Scan again once setup is done, for the doctor summary. */
  rescan: () => Promise<ScanResult>
}

function clean(text: string): string {
  return cleanUntrusted(text, { oneLine: true })
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

function renderPlan(plan: SetupPlan, run: SetupRun): string {
  const s = run.style
  const lines = [`${s.bold('Setup plan')} for ${s.bold(clean(run.result.project.name))}`, '']
  const width = Math.max(0, ...plan.steps.map((step) => step.command.length))
  plan.steps.forEach((step, index) => {
    lines.push(`  ${index + 1}. ${s.cyan(step.command.padEnd(width))}  ${s.dim(step.reason)}`)
    for (const note of step.notes) {
      const indented = note.startsWith('  ')
      lines.push(`     ${indented ? '  ' : `${s.dim(s.symbols.dot)} `}${s.dim(note.trimStart())}`)
    }
  })
  if (plan.steps.length === 0) lines.push(`  ${s.dim('Nothing for setup to do.')}`)
  if (plan.skipped.length > 0) {
    lines.push('', s.bold('Skipped'))
    for (const step of plan.skipped) {
      lines.push(`  ${s.dim(s.symbols.dot)} ${step.command ? `${s.cyan(step.command)}  ` : ''}${s.dim(step.reason)}`)
    }
  }
  return `${lines.join('\n')}\n`
}

interface Preflight {
  /** Absolute path of each program the plan runs. */
  paths: Map<string, string>
  /** What stops setup before it starts. */
  problems: string[]
  /** What the developer should know but doesn't stop setup. */
  warnings: string[]
}

/** Find the programs the plan runs and check the active Node.js version. */
async function preflight(plan: SetupPlan, run: SetupRun): Promise<Preflight> {
  const paths = new Map<string, string>()
  const problems: string[] = []
  const warnings: string[] = []
  for (const step of plan.steps) {
    if (step.action.type !== 'exec' || paths.has(step.action.program)) continue
    const found = await run.host.which(step.action.program)
    if (found) paths.set(step.action.program, found)
    else
      problems.push(`${step.action.program} is not installed (not found on PATH), and step "${step.command}" needs it`)
  }
  if (plan.node) {
    const node = await run.host.which('node')
    const version = node ? await run.host.read(node, ['--version'], run.root) : null
    const { required, pinned } = plan.node
    if (version && required && versionFitsRange(version, required.range) === false) {
      problems.push(
        `Node.js ${clean(version)} is active, but ${required.file} requires ${clean(required.range)} (engines.node). ` +
          'Switch versions (nvm, fnm, mise, Volta…) and run setup again',
      )
    } else if (version && pinned && versionFitsRange(version, pinned.version) === false) {
      warnings.push(
        `Node.js ${clean(version)} is active, but ${pinned.file} pins ${clean(pinned.version)}. ` +
          'Your version manager can switch to it (nvm use, fnm use, mise install…)',
      )
    }
  }
  return { paths, problems, warnings }
}

type StepOutcome = { ok: true; note?: string } | { ok: false; message: string }

/** Copy the example env file to the local one: inside the project only, never overwriting, never through a link. */
async function copyEnvFile(from: string, to: string, run: SetupRun): Promise<StepOutcome> {
  const read = await readTextWithin(run.realRoot, from, MAX_ENV_BYTES)
  if (!read.ok) return { ok: false, message: `Couldn't read ${from} (${read.reason})` }
  let handle: fs.FileHandle | undefined
  try {
    // Owner-only: the file is about to hold this developer's secrets.
    handle = await fs.open(path.join(run.realRoot, to), CREATE_NEW, 0o600)
    await handle.writeFile(read.text, 'utf8')
    return { ok: true }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST' || code === 'ELOOP') return { ok: true, note: `${to} already exists; left it untouched` }
    return { ok: false, message: `Couldn't create ${to} (${code ?? (error as Error).message})` }
  } finally {
    await handle?.close().catch(() => {})
  }
}

async function runStep(step: SetupStep, paths: Map<string, string>, run: SetupRun): Promise<StepOutcome> {
  const { action } = step
  if (action.type === 'copy') return copyEnvFile(action.from, action.to, run)
  const file = paths.get(action.program) as string
  let code: number
  try {
    code = await run.host.run(file, action.args, run.root)
  } catch (error) {
    return { ok: false, message: `Couldn't start ${action.program}: ${clean((error as Error).message)}` }
  }
  return code === 0 ? { ok: true } : { ok: false, message: `${step.command} failed with exit code ${code}` }
}

function doctorSummary(result: ScanResult, run: SetupRun): string {
  const s = run.style
  const { errors, warnings } = result.doctor.summary
  const command = doctorCommand(run.commandPath)
  if (errors + warnings === 0) return `${s.green(s.symbols.pass)} ${command} finds no problems.\n`
  const counts = [errors > 0 ? plural(errors, 'error') : '', warnings > 0 ? plural(warnings, 'warning') : '']
    .filter(Boolean)
    .join(' and ')
  const symbol = errors > 0 ? s.red(s.symbols.fail) : s.yellow(s.symbols.warn)
  return `${symbol} ${command} still reports ${counts}. Run ${s.cyan(command)} for details.\n`
}

export async function runSetup(run: SetupRun): Promise<number> {
  const s = run.style
  const plan = setupPlan(run.result, { ignoreScripts: run.ignoreScripts })
  run.write(renderPlan(plan, run))
  if (plan.steps.length === 0) return 0

  const { paths, problems, warnings } = await preflight(plan, run)
  for (const warning of warnings) run.write(`\n${s.yellow(s.symbols.warn)} ${warning}\n`)
  if (problems.length > 0) {
    for (const problem of problems) run.writeError(`${s.red(s.symbols.fail)} ${problem}\n`)
    run.writeError(`${s.dim('Nothing was run.')}\n`)
    return EXIT_SETUP_FAILED
  }
  if (run.dryRun) {
    run.write(`\n${s.dim('Dry run: nothing was run.')}\n`)
    return 0
  }
  if (!run.yes) {
    if (!run.confirm) {
      throw new RepoLensError(
        'INVALID_ARGUMENT',
        'setup asks before running anything. Run it in a terminal, or pass --yes to accept the plan above',
      )
    }
    const count = plan.steps.length
    if (!(await run.confirm(`\nRun ${count === 1 ? 'this step' : `these ${count} steps`}? [y/N] `))) {
      run.writeError(`${s.dim('Cancelled. Nothing was run.')}\n`)
      return EXIT_SETUP_FAILED
    }
  }

  for (const [index, step] of plan.steps.entries()) {
    run.write(`\n${s.bold(`${s.symbols.arrow} [${index + 1}/${plan.steps.length}]`)} ${s.cyan(step.command)}\n`)
    const outcome = await runStep(step, paths, run)
    if (outcome.ok && outcome.note) {
      run.write(`${s.dim(outcome.note)}\n`)
    } else if (!outcome.ok) {
      run.writeError(`${s.red(s.symbols.fail)} ${outcome.message}\n`)
      run.writeError(`${s.dim('Fix it and run repolens setup again: steps already done are skipped.')}\n`)
      return EXIT_SETUP_FAILED
    }
  }

  run.write(`\n${s.green(s.symbols.pass)} Setup finished.\n`)
  run.write(doctorSummary(await run.rescan(), run))
  if (plan.next) run.write(`${s.dim('Next:')} ${s.cyan(plan.next.command)}  ${s.dim(plan.next.reason)}\n`)
  return 0
}
