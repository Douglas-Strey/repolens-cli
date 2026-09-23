import { constants, type Stats, statSync } from 'node:fs'
import fs, { type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { GENERATED_MARKER, renderAgentContext, renderAgentFiles } from '../agent/index.ts'
import { loadConfigFile, loadProjectConfig, loadUserConfig, tildePath, userConfigPath } from '../config/load.ts'
import { resolveConfig } from '../config/resolve.ts'
import { filterByConfidence } from '../core/confidence.ts'
import { RepoLensError } from '../core/errors.ts'
import { scan } from '../core/scan.ts'
import { doctorRules } from '../doctor/rules/index.ts'
import { renderDoctorJson, renderJson } from '../output/json.ts'
import { renderMarkdown } from '../output/markdown.ts'
import { createStyle, type RenderOptions, type Style, supportsColor, supportsUnicode } from '../output/style.ts'
import { renderDoctor, renderScan } from '../output/terminal.ts'
import type { LoadedConfig, RepoLensConfig, ScanResult, ScanWarning, Severity } from '../types.ts'
import { cleanUntrusted } from '../utils/text.ts'
import { VERSION } from '../version.ts'
import { type CliArgs, type FailOn, parseCliArgs } from './args.ts'
import { renderConfigInfo } from './config.ts'
import { commandHelp, mainHelp } from './help.ts'

export const EXIT_OK = 0
export const EXIT_DOCTOR_FAILED = 1
export const EXIT_USAGE = 2
export const EXIT_INTERNAL = 3

export interface OutputStream {
  write(chunk: string): unknown
  isTTY?: boolean
  columns?: number
}

export interface CliIO {
  stdout: OutputStream
  stderr: OutputStream
  env: Record<string, string | undefined>
  cwd: string
  platform: NodeJS.Platform
  /** Reference time for date-based checks; tests pin it for deterministic output. */
  now?: Date
}

const ISSUES_URL = 'https://github.com/Douglas-Strey/repolens-cli/issues'

const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, error: 2 }

/** Terminal width bounds, and the fixed width of --output files so they don't depend on the terminal. */
const MIN_WIDTH = 40
const MAX_WIDTH = 140
const DEFAULT_WIDTH = 100
const FILE_WIDTH = 100

/** Should `doctor` fail given the findings and the --fail-on threshold? */
export function doctorShouldFail(result: ScanResult, failOn: FailOn): boolean {
  if (failOn === 'never') return false
  const threshold = SEVERITY_RANK[failOn]
  return result.doctor.diagnostics.some((d) => SEVERITY_RANK[d.severity] >= threshold)
}

/**
 * Width for terminal output: the terminal's own width when writing to one,
 * otherwise COLUMNS (pipes, CI logs, `watch`), otherwise the stream's value or 100.
 */
export function outputWidth(stream: OutputStream, env: Record<string, string | undefined>): number {
  const fromEnv = /^\d+$/.test(env.COLUMNS ?? '') ? Number(env.COLUMNS) : 0
  const columns = stream.isTTY && stream.columns ? stream.columns : fromEnv || stream.columns || DEFAULT_WIDTH
  return Math.max(MIN_WIDTH, Math.min(columns, MAX_WIDTH))
}

type OutputPreferences = RepoLensConfig['output']

function makeStyle(
  args: Pick<CliArgs, 'color'> | undefined,
  stream: OutputStream,
  io: CliIO,
  preferences?: OutputPreferences,
): Style {
  return createStyle({
    color: supportsColor({ flag: args?.color, isTTY: stream.isTTY, env: io.env, preference: preferences?.color }),
    unicode: preferences?.ascii !== true && supportsUnicode(io.env, io.platform),
  })
}

function envFlag(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== '0' && value !== 'false'
}

/**
 * Untrusted text (repository paths, parser messages, stacks) as printable
 * lines: no escape sequences, carriage returns or invisible characters that
 * could rewrite the terminal. Leading spaces survive so stack traces stay readable.
 */
export function safeLines(text: string): string[] {
  return text.split('\n').map((line) => (/^ */.exec(line)?.[0] ?? '') + cleanUntrusted(line, { oneLine: true }))
}

function safeText(text: string): string {
  return safeLines(text).join('\n')
}

/** Debug output is for maintainers: it only appears with REPOLENS_DEBUG=1. */
function debugWriter(io: CliIO, style: Style): ((message: string) => void) | undefined {
  if (!envFlag(io.env.REPOLENS_DEBUG)) return undefined
  return (message) => {
    for (const line of safeLines(message)) {
      if (line.trim() !== '') io.stderr.write(`${style.dim(`[debug] ${line}`)}\n`)
    }
  }
}

const NO_FOLLOW = process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
const WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | NO_FOLLOW
const READ_FLAGS = constants.O_RDONLY | NO_FOLLOW

/** What is at `target` without following symlinks: null when nothing is. */
async function lstatOrNull(target: string): Promise<Stats | null> {
  try {
    return await fs.lstat(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function describeEntry(stat: Stats): string {
  if (stat.isSymbolicLink()) return 'a symbolic link'
  if (stat.isDirectory()) return 'a directory'
  if (stat.isFile()) return 'a file'
  return 'not a regular file'
}

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code
}

/** Short reason for a failed file system call, or undefined when the raw message is the best we have. */
export function failureReason(error: unknown, directory: string): string | undefined {
  switch (errnoCode(error)) {
    case 'ENOENT':
      return `directory ${directory} does not exist`
    case 'EACCES':
    case 'EPERM':
      return 'permission denied'
    case 'EISDIR':
      return 'it is a directory'
    case 'ENOTDIR':
      return 'part of the path is not a directory'
    case 'EROFS':
      return 'read-only file system'
    case 'ENOSPC':
      return 'no space left on device'
    default:
      return undefined
  }
}

function outputFailed(message: string, error: unknown, directory: string): RepoLensError {
  const reason = failureReason(error, directory)
  return new RepoLensError('OUTPUT_FAILED', reason ? `${message} (${reason})` : message, (error as Error)?.message)
}

/**
 * Write a file without following a symlink at `target` and without opening
 * FIFOs or devices. Output often goes into the scanned repository, and an
 * untrusted repository can commit `repolens.md -> ~/.bashrc`.
 */
export async function writeFileSafely(target: string, content: string, shown: string): Promise<void> {
  const existing = await lstatOrNull(target)
  if (existing && !existing.isFile()) {
    throw new RepoLensError('OUTPUT_FAILED', `Refusing to write ${shown}: it is ${describeEntry(existing)}`)
  }
  const handle = await fs.open(target, WRITE_FLAGS, 0o644)
  try {
    if (!(await handle.stat()).isFile()) {
      throw new RepoLensError('OUTPUT_FAILED', `Refusing to write ${shown}: it is not a regular file`)
    }
    await handle.truncate(0)
    await handle.writeFile(content, 'utf8')
  } finally {
    await handle.close()
  }
}

/** First bytes of a regular file (never follows a symlink or opens a FIFO); null when unavailable. */
async function readHead(target: string, bytes: number): Promise<string | null> {
  let handle: FileHandle | undefined
  try {
    handle = await fs.open(target, READ_FLAGS)
    if (!(await handle.stat()).isFile()) return null
    const buffer = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}

function isWithin(target: string, dir: string): boolean {
  const relative = path.relative(dir, target)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

/** A path for messages when the user didn't type one: relative to cwd, unless that climbs out of it. */
export function displayPath(target: string, cwd: string): string {
  const relative = path.relative(cwd, target)
  if (relative === '') return '.'
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ? target : relative
}

/**
 * Refuse output paths that enter the scanned directory and then leave it
 * through a symbolic link: an untrusted repository can commit `docs -> ~/.ssh`,
 * and `repolens report -o docs/report.md` must not write there. Links that stay
 * inside the scanned directory are fine, and paths that never enter it keep
 * the usual semantics. `dir` is the directory the file(s) will be written to.
 */
async function assertStaysInside(dir: string, scanned: Scanned, shown: string, io: CliIO): Promise<void> {
  const { root } = path.parse(dir)
  let current = root
  let entered = false
  const leadsOutside = () =>
    new RepoLensError(
      'OUTPUT_FAILED',
      `Refusing to write ${shown}: ${displayPath(current, io.cwd)} is a symbolic link that leads outside the scanned directory`,
    )
  for (const part of path.relative(root, dir).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    let real: string
    try {
      real = await fs.realpath(current)
    } catch {
      // A dangling link could still be created through; anything else missing or unreadable fails the write itself.
      if (entered && (await lstatOrNull(current).catch(() => null))?.isSymbolicLink()) throw leadsOutside()
      return
    }
    const inside = isWithin(real, scanned.realRoot)
    if (entered && !inside) throw leadsOutside()
    if (inside) entered = true
  }
}

async function writeOutputFile(file: OutputFile, content: string, scanned: Scanned, io: CliIO): Promise<void> {
  await assertStaysInside(path.dirname(file.target), scanned, file.shown, io)
  try {
    await writeFileSafely(file.target, content, file.shown)
  } catch (error) {
    if (error instanceof RepoLensError) throw error
    throw outputFailed(`Couldn't write ${file.shown}`, error, path.dirname(file.shown))
  }
}

interface OutputFile {
  /** Absolute path to write. */
  target: string
  /** The path as the user typed it, for messages. */
  shown: string
}

/** Where --output goes. For `agent`, an existing directory (or a trailing slash) receives agent-context.md. */
async function resolveOutputFile(output: string, args: CliArgs, io: CliIO): Promise<OutputFile> {
  const target = path.resolve(io.cwd, output)
  if (args.command !== 'agent') return { target, shown: output }
  const isDir =
    output.endsWith('/') ||
    output.endsWith(path.sep) ||
    (await fs.stat(target).then(
      (stat) => stat.isDirectory(),
      () => false,
    ))
  return isDir
    ? { target: path.join(target, 'agent-context.md'), shown: path.join(output, 'agent-context.md') }
    : { target, shown: output }
}

async function runAgentInit(
  result: ScanResult,
  scanned: Scanned,
  args: CliArgs,
  io: CliIO,
  style: Style,
): Promise<void> {
  const dir = args.output ? path.resolve(io.cwd, args.output) : path.join(scanned.root, '.repolens')
  const shownDir = args.output ?? displayPath(dir, io.cwd)
  const files = renderAgentFiles(result)

  try {
    // The default directory lives in the scanned (possibly untrusted) repository: never follow a planted symlink.
    const existingDir = await lstatOrNull(dir)
    if (existingDir && !existingDir.isDirectory() && !(args.output && existingDir.isSymbolicLink())) {
      throw new RepoLensError('OUTPUT_FAILED', `Refusing to write to ${shownDir}: it is ${describeEntry(existingDir)}`)
    }
    await assertStaysInside(dir, scanned, shownDir, io)

    // Refuse to clobber files RepoLens did not generate, unless --force. Links and special files are always refused.
    const blocked: string[] = []
    for (const file of files) {
      const target = path.join(dir, file.name)
      const existing = await lstatOrNull(target)
      if (!existing) continue
      if (!existing.isFile()) {
        throw new RepoLensError(
          'OUTPUT_FAILED',
          `Refusing to write ${path.join(shownDir, file.name)}: it is ${describeEntry(existing)}`,
        )
      }
      const head = await readHead(target, GENERATED_MARKER.length)
      if (head !== GENERATED_MARKER && !args.force) blocked.push(file.name)
    }
    if (blocked.length > 0) {
      throw new RepoLensError(
        'OUTPUT_FAILED',
        `Refusing to overwrite files not generated by RepoLens: ${blocked.join(', ')}. Use --force to overwrite.`,
      )
    }

    await fs.mkdir(dir, { recursive: true })
    for (const file of files) {
      await writeFileSafely(path.join(dir, file.name), file.content, path.join(shownDir, file.name))
    }
  } catch (error) {
    if (error instanceof RepoLensError) throw error
    throw outputFailed(`Couldn't write to ${shownDir}`, error, shownDir)
  }

  if (args.quiet) return
  // The tip is pasted into AGENTS.md or CLAUDE.md at the project root, so it is relative to the project, in posix form.
  const fromRoot = path.relative(scanned.root, dir)
  const inProject = isWithin(dir, scanned.root)
  const context = inProject
    ? [...fromRoot.split(path.sep).filter(Boolean), 'agent-context.md'].join('/')
    : path.join(shownDir, 'agent-context.md')
  const s = style
  io.stdout.write(`${s.green(s.symbols.pass)} Wrote ${files.length} files to ${s.bold(shownDir)}\n`)
  for (const file of files) io.stdout.write(`  ${s.dim(s.symbols.dot)} ${file.name}\n`)
  io.stdout.write(
    `\n${s.yellow(s.symbols.warn)} Review these files before committing them. They never contain secret values,\n` +
      `  but they do describe your project's structure.\n` +
      `${s.dim(`Tip: point your agent at ${context} from AGENTS.md or CLAUDE.md.`)}\n`,
  )
}

interface Scanned {
  /** The directory to scan, resolved against cwd (not following symlinks). */
  root: string
  /** Its real path. */
  realRoot: string
}

/** Check the directory to scan, naming it in errors the way the user typed it. */
async function resolveScanRoot(args: CliArgs, io: CliIO): Promise<Scanned> {
  const typed = args.cwd ?? '.'
  const root = path.resolve(io.cwd, typed)
  let stat: Stats
  try {
    stat = await fs.stat(root)
  } catch (error) {
    const code = errnoCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new RepoLensError('INVALID_ROOT', `Directory not found: ${typed}`)
    }
    const reason = failureReason(error, typed)
    throw new RepoLensError('INVALID_ROOT', `Cannot read ${typed}${reason ? ` (${reason})` : ''}`, code)
  }
  if (!stat.isDirectory()) throw new RepoLensError('INVALID_ROOT', `Not a directory: ${typed}`)
  return { root, realRoot: await fs.realpath(root) }
}

/** The configuration files for this run, lowest precedence first. */
export interface CliConfig {
  layers: LoadedConfig[]
  /** Where the user config file is looked for ("~/.config/repolens/config.json"), if anywhere. */
  userPath?: string
  user: LoadedConfig | null
  /** The project's own file, or the --config file. */
  second: LoadedConfig | null
}

function posixPath(value: string): string {
  return value.split(path.sep).join('/')
}

/**
 * Load the user config and either the --config file or the project's own
 * file. --no-config loads nothing. A broken user or --config file stops the
 * run (the user can fix it); a broken project file only warns.
 */
async function loadCliConfig(args: CliArgs, io: CliIO, scanned: Scanned): Promise<CliConfig> {
  if (args.noConfig) return { layers: [], user: null, second: null }
  const userFile = userConfigPath(io.env, io.platform, io.cwd)
  const user = await loadUserConfig(io.env, io.platform, io.cwd)
  let second: LoadedConfig | null
  if (args.config !== undefined) {
    const file = path.resolve(io.cwd, args.config)
    const relative = path.relative(scanned.root, file)
    const inside = relative !== '' && isWithin(file, scanned.root)
    // Warnings end up in JSON output, which never carries an absolute path.
    const label = inside ? posixPath(relative) : path.isAbsolute(args.config) ? path.basename(file) : args.config
    second = await loadConfigFile(
      file,
      { kind: 'file', ...(inside ? { file: posixPath(relative) } : {}) },
      label,
      args.config,
    )
  } else {
    second = await loadProjectConfig(scanned.realRoot)
  }
  return {
    layers: [user, second].filter((layer): layer is LoadedConfig => layer !== null),
    ...(userFile ? { userPath: tildePath(userFile, io.env) } : {}),
    user,
    second,
  }
}

/** Configuration problems go to stderr, whatever the output format: stdout may be JSON for a script. */
function printConfigWarnings(warnings: readonly ScanWarning[], io: CliIO, style: Style): void {
  for (const warning of warnings) {
    if (warning.kind !== 'config') continue
    io.stderr.write(`${style.yellow(style.symbols.warn)} ${safeText(warning.message)}\n`)
    if (warning.detail) io.stderr.write(`  ${style.dim(safeText(warning.detail))}\n`)
  }
}

function isDirectorySync(cwd: string): (target: string) => boolean {
  return (target) => {
    try {
      return statSync(path.resolve(cwd, target)).isDirectory()
    } catch {
      return false
    }
  }
}

/**
 * Run the CLI. Returns the process exit code instead of exiting, so it can be
 * tested in-process.
 */
export async function main(argv: readonly string[], io: CliIO): Promise<number> {
  let args: CliArgs | undefined
  try {
    args = parseCliArgs(argv, { isDirectory: isDirectorySync(io.cwd) })
    let out = makeStyle(args, io.stdout, io)

    if (args.version) {
      io.stdout.write(`${VERSION}\n`)
      return EXIT_OK
    }
    if (args.command === 'help' || args.help) {
      io.stdout.write(args.helpTopic ? commandHelp(args.helpTopic, out) : mainHelp(out, VERSION))
      return EXIT_OK
    }

    const verbose = args.verbose
    const scanned = await resolveScanRoot(args, io)
    const config = await loadCliConfig(args, io, scanned)
    const preferences = config.user?.config.output
    out = makeStyle(args, io.stdout, io, preferences)
    const err = makeStyle(args, io.stderr, io, preferences)

    if (args.command === 'config') {
      const resolved = resolveConfig(config.layers, doctorRules)
      printConfigWarnings(resolved.warnings, io, err)
      io.stdout.write(
        renderConfigInfo(config, resolved.config, {
          json: args.json,
          noConfig: args.noConfig,
          style: out,
          ...(args.config !== undefined ? { typedConfig: args.config } : {}),
        }),
      )
      return EXIT_OK
    }

    const debug = debugWriter(io, err)
    const output = args.output && args.subcommand !== 'init' ? await resolveOutputFile(args.output, args, io) : null

    const raw = await scan({
      cwd: scanned.root,
      config: config.layers,
      ...(args.maxFiles !== undefined ? { maxFiles: args.maxFiles } : {}),
      ...(io.now ? { now: io.now } : {}),
      ...(debug ? { debug } : {}),
    })
    printConfigWarnings(raw.meta.warnings, io, err)
    const result = filterByConfidence(raw, verbose ? 'low' : 'medium')

    // Suggested follow-up commands (`repolens doctor <path>`) must target the same directory. Absolute
    // paths are left out: output never carries one, so it stays the same wherever the repository lives.
    const typedPath = args.cwd !== undefined && !path.isAbsolute(args.cwd) ? args.cwd : undefined
    const commandPath = typedPath !== undefined && scanned.root !== path.resolve(io.cwd) ? typedPath : undefined
    const renderOptions: RenderOptions = {
      // Files are read later, elsewhere: no colors, a fixed width, Unicode unless explicitly turned off.
      style: output
        ? createStyle({ color: false, unicode: io.env.REPOLENS_ASCII !== '1' && !preferences?.ascii })
        : out,
      verbose,
      quiet: args.quiet,
      width: output ? FILE_WIDTH : outputWidth(io.stdout, io.env),
      ...(commandPath !== undefined ? { commandPath } : {}),
    }

    let content: string
    let exitCode = EXIT_OK
    switch (args.command) {
      case 'doctor':
        content = args.json ? renderDoctorJson(result) : renderDoctor(result, renderOptions)
        if (doctorShouldFail(result, args.failOn ?? result.meta.config.settings.doctor?.failOn ?? 'error')) {
          exitCode = EXIT_DOCTOR_FAILED
        }
        break
      case 'report':
        content = renderMarkdown(result, { verbose })
        break
      case 'agent':
        if (args.subcommand === 'init') {
          await runAgentInit(result, scanned, args, io, out)
          return EXIT_OK
        }
        content = renderAgentContext(result, { companionFiles: false })
        break
      default:
        content = args.json
          ? renderJson(result)
          : args.markdown
            ? renderMarkdown(result, { verbose })
            : // The terminal view filters by confidence itself, and needs the raw result to say how many
              // low-confidence routes it hid.
              renderScan(raw, renderOptions)
    }

    if (output) {
      await writeOutputFile(output, content, scanned, io)
      if (!args.quiet) io.stdout.write(`${out.green(out.symbols.pass)} Wrote ${output.shown}\n`)
    } else {
      io.stdout.write(content)
    }
    return exitCode
  } catch (error) {
    const s = makeStyle(args, io.stderr, io)
    if (error instanceof RepoLensError) {
      io.stderr.write(`${s.red(s.symbols.fail)} ${safeText(error.message)}\n`)
      if (error.detail && args?.verbose) io.stderr.write(`${s.dim(safeText(error.detail))}\n`)
      if (error.code === 'INVALID_ARGUMENT') io.stderr.write(`${s.dim('Run repolens --help for usage.')}\n`)
      return EXIT_USAGE
    }
    // Messages and stacks can quote repository content (file names, parser input).
    const message = safeText(String((error as Error)?.message ?? error))
    io.stderr.write(`${s.red(s.symbols.fail)} RepoLens hit an unexpected error: ${message}\n`)
    if (args?.verbose) {
      io.stderr.write(`${s.dim(safeText(String((error as Error)?.stack ?? error)))}\n`)
    } else {
      io.stderr.write(`${s.dim('Run with --verbose to see technical details.')}\n`)
    }
    io.stderr.write(`${s.dim(`Please report it at ${ISSUES_URL}`)}\n`)
    return EXIT_INTERNAL
  }
}
