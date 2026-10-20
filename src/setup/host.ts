/**
 * Where `repolens setup` touches the machine: finding programs and running
 * them. Kept behind an interface so the CLI can be tested without spawning.
 *
 * Programs are looked up on PATH by RepoLens itself and run by absolute path
 * without a shell. PATH entries that are relative or inside the repository
 * are skipped: a repository can ship `node_modules/.bin/pnpm` or, on Windows
 * (where the current directory is searched first), a `pnpm.cmd` at its root.
 */
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

export interface SetupHost {
  /** Absolute path of `program` on PATH, or null when it isn't installed. */
  which(program: string): Promise<string | null>
  /** Run a program with the terminal attached; resolves with its exit code. */
  run(file: string, args: readonly string[], cwd: string): Promise<number>
  /** Run a program and return the first line it prints, or null when it fails. */
  read(file: string, args: readonly string[], cwd: string): Promise<string | null>
}

export interface SearchOptions {
  env: Record<string, string | undefined>
  platform: NodeJS.Platform
  /** Directories whose contents are never run (the repository being set up). */
  exclude: readonly string[]
}

function pathModule(platform: NodeJS.Platform): typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix
}

/** An environment variable by name, case-insensitively on Windows (`Path`, `PATHEXT`). */
function envValue(
  env: Record<string, string | undefined>,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== 'win32') return env[name]
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name)
  return key === undefined ? undefined : env[key]
}

function isInside(target: string, dir: string, p: typeof path.posix): boolean {
  const relative = p.relative(dir, target)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${p.sep}`) && !p.isAbsolute(relative))
}

/** Candidate file paths for `program`, in PATH order, leaving out unsafe directories. */
export function pathCandidates(program: string, options: SearchOptions): string[] {
  const p = pathModule(options.platform)
  const windows = options.platform === 'win32'
  const dirs = (envValue(options.env, 'PATH', options.platform) ?? '').split(windows ? ';' : ':')
  const extensions = windows
    ? (envValue(options.env, 'PATHEXT', options.platform) ?? '.COM;.EXE;.BAT;.CMD')
        .split(';')
        .filter((ext) => ext !== '')
    : ['']
  const out: string[] = []
  for (const raw of dirs) {
    const dir = windows ? raw.replace(/^"(.*)"$/, '$1') : raw
    if (dir === '' || !p.isAbsolute(dir)) continue
    if (options.exclude.some((root) => isInside(p.resolve(dir), p.resolve(root), p))) continue
    for (const ext of extensions) out.push(p.join(dir, program + ext.toLowerCase()))
  }
  return out
}

async function isExecutableFile(file: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    if (!(await fs.stat(file)).isFile()) return false
    if (platform !== 'win32') await fs.access(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Find `program` on PATH, skipping relative entries and directories inside the excluded ones. */
export async function searchPath(program: string, options: SearchOptions): Promise<string | null> {
  for (const candidate of pathCandidates(program, options)) {
    if (!(await isExecutableFile(candidate, options.platform))) continue
    // A PATH directory outside the repository can still hold a link into it.
    const real = await fs.realpath(candidate).catch(() => candidate)
    const p = pathModule(options.platform)
    if (options.exclude.some((root) => isInside(p.resolve(real), p.resolve(root), p))) continue
    return candidate
  }
  return null
}

/** Arguments cmd.exe passes on unchanged: no quotes, spaces, `%`, `^`, `&`, `|`, `<`, `>` or `!`. */
const CMD_SAFE_ARG = /^[A-Za-z0-9._/:=@+-]+$/
const CMD_UNSAFE_PATH = /["%^&|<>!]/

export interface SpawnSpec {
  file: string
  args: string[]
  /** Pass `args` to the process exactly as written (needed for cmd.exe). */
  verbatim: boolean
}

/**
 * How to start `file`. Windows can only start `.cmd` and `.bat` files (npm,
 * pnpm and Yarn install them) through cmd.exe, which has its own quoting, so
 * those run only with arguments cmd.exe can't reinterpret. Returns null when
 * that isn't the case.
 */
export function spawnSpec(
  file: string,
  args: readonly string[],
  platform: NodeJS.Platform,
  comspec = 'cmd.exe',
): SpawnSpec | null {
  if (platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(file)) return { file, args: [...args], verbatim: false }
  if (CMD_UNSAFE_PATH.test(file) || !args.every((arg) => CMD_SAFE_ARG.test(arg))) return null
  // `/s /c "…"`: cmd.exe strips the outer quotes and runs the rest as one command line.
  return { file: comspec, args: ['/d', '/s', '/c', `""${file}" ${args.join(' ')}"`], verbatim: true }
}

/** The real machine: PATH lookups and child processes. */
export function systemHost(options: SearchOptions): SetupHost {
  const comspec = envValue(options.env, 'COMSPEC', options.platform) ?? 'cmd.exe'
  const start = (file: string, args: readonly string[]) => {
    const spec = spawnSpec(file, args, options.platform, comspec)
    if (!spec) throw new Error(`Refusing to run ${file} with arguments cmd.exe could reinterpret`)
    return spec
  }
  return {
    which: (program) => searchPath(program, options),
    run: (file, args, cwd) =>
      new Promise((resolve, reject) => {
        const spec = start(file, args)
        const child = spawn(spec.file, spec.args, {
          cwd,
          env: options.env,
          stdio: 'inherit',
          windowsVerbatimArguments: spec.verbatim,
        })
        child.on('error', reject)
        child.on('close', (code) => resolve(code ?? 1))
      }),
    read: (file, args, cwd) =>
      new Promise((resolve) => {
        let spec: SpawnSpec
        try {
          spec = start(file, args)
        } catch {
          resolve(null)
          return
        }
        let output = ''
        const child = spawn(spec.file, spec.args, {
          cwd,
          env: options.env,
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 10_000,
          windowsVerbatimArguments: spec.verbatim,
        })
        child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
          if (output.length < 1000) output += chunk
        })
        child.on('error', () => resolve(null))
        child.on('close', (code) => resolve(code === 0 ? (output.split(/\r?\n/)[0]?.trim() ?? null) : null))
      }),
  }
}
