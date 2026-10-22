/**
 * Git ignore rules that live outside the scanned directory: the user's
 * global excludes file (core.excludesFile), the repository's info/exclude,
 * and the .gitignore files between the repository root and the scanned
 * directory. The walker applies them below the ones it finds itself.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { type ReadResult, readRegularFile } from '../core/fs.ts'
import { GITIGNORE_MAX_BYTES, type OuterIgnore } from '../core/walker.ts'
import { findRepository, gitConfigValues, parseGitConfig, readGitFile } from './git.ts'

type Env = Readonly<Record<string, string | undefined>>

const GIT_CONFIG_MAX_BYTES = 1024 * 1024

function homeDir(env: Env, platform: NodeJS.Platform): string | undefined {
  const home = env.HOME || (platform === 'win32' ? env.USERPROFILE : undefined)
  return home && path.isAbsolute(home) ? home : undefined
}

/** $XDG_CONFIG_HOME, else ~/.config. A relative XDG_CONFIG_HOME is invalid per the spec and ignored. */
function configHome(env: Env, home: string | undefined): string | undefined {
  const xdg = env.XDG_CONFIG_HOME
  if (xdg && path.isAbsolute(xdg)) return xdg
  return home ? path.join(home, '.config') : undefined
}

/**
 * Git's global config files, lowest precedence first: $GIT_CONFIG_GLOBAL
 * alone when it is set, else $XDG_CONFIG_HOME/git/config then ~/.gitconfig.
 */
export function globalGitConfigFiles(env: Env, platform: NodeJS.Platform): string[] {
  if (env.GIT_CONFIG_GLOBAL) return path.isAbsolute(env.GIT_CONFIG_GLOBAL) ? [env.GIT_CONFIG_GLOBAL] : []
  const home = homeDir(env, platform)
  const xdg = configHome(env, home)
  return [...(xdg ? [path.join(xdg, 'git', 'config')] : []), ...(home ? [path.join(home, '.gitconfig')] : [])]
}

/** A file in the user's own configuration. Links are followed: dotfile managers link these files. */
async function readUserFile(file: string, maxBytes: number): Promise<string | null> {
  let real: string
  try {
    real = await fs.realpath(file)
  } catch {
    return null
  }
  const result = await readRegularFile(real, maxBytes)
  return result.ok ? result.text : null
}

/**
 * Where Git's global excludes file is: core.excludesFile from the global Git
 * config (the last value wins, `~/` is expanded), else
 * $XDG_CONFIG_HOME/git/ignore (~/.config/git/ignore). Undefined when it
 * can't be located or the configured path is relative.
 *
 * Only the user's global config is consulted. A repository's own
 * .git/config could name any file on the machine, and the system config's
 * location depends on how Git was installed. `[include]` sections are not
 * followed.
 */
export async function gitExcludesFile(env: Env, platform: NodeJS.Platform): Promise<string | undefined> {
  let value: string | undefined
  for (const file of globalGitConfigFiles(env, platform)) {
    const text = await readUserFile(file, GIT_CONFIG_MAX_BYTES)
    if (text === null) continue
    value = gitConfigValues(parseGitConfig(text), 'core', null, 'excludesfile').at(-1) ?? value
  }
  const home = homeDir(env, platform)
  if (value === undefined) {
    const config = configHome(env, home)
    return config ? path.join(config, 'git', 'ignore') : undefined
  }
  if (value.startsWith('~/') || (platform === 'win32' && value.startsWith('~\\'))) {
    return home ? path.join(home, value.slice(2)) : undefined
  }
  return path.isAbsolute(value) ? path.resolve(value) : undefined
}

/**
 * A .gitignore that is a regular file. Checked with lstat because Windows has
 * no O_NOFOLLOW: readRegularFile alone would follow a link out of the repository.
 */
async function readGitignore(file: string): Promise<ReadResult | null> {
  try {
    if (!(await fs.lstat(file)).isFile()) return null
  } catch {
    return null
  }
  return readRegularFile(file, GITIGNORE_MAX_BYTES)
}

/**
 * The ignore files outside `root` (a real path) that Git applies inside it,
 * lowest precedence first: the global excludes file `excludesFile`, the
 * repository's info/exclude, then the .gitignore of each directory from the
 * repository root down to the root's parent. Empty outside a Git repository.
 *
 * Only the repository's own directories are read, the same way as the
 * metadata RepoLens reads above the root: a .gitignore must be a regular
 * file (Git doesn't follow a symlinked one either), and info/exclude must
 * not lead out of the Git directory.
 */
export async function outerIgnoreFiles(root: string, excludesFile?: string): Promise<OuterIgnore[]> {
  const repository = await findRepository(root)
  if (!repository) return []
  const { prefix } = repository
  const segments = prefix === '' ? [] : prefix.split('/')
  const up = '../'.repeat(segments.length)
  const out: OuterIgnore[] = []

  if (excludesFile !== undefined) {
    const text = await readUserFile(excludesFile, GITIGNORE_MAX_BYTES)
    if (text !== null) out.push({ prefix, text, file: 'core.excludesFile', personal: true })
  }
  // Shared by all worktrees, so it lives in the common Git directory.
  const exclude = await readGitFile(repository, 'info/exclude', 'common', GITIGNORE_MAX_BYTES)
  if (exclude !== null) out.push({ prefix, text: exclude, file: `${up}.git/info/exclude`, personal: true })

  for (let i = 0; i < segments.length; i++) {
    // The directories between the repository root and the root are ancestors of a real path, so real too.
    const dir = path.join(repository.workTree, ...segments.slice(0, i))
    const result = await readGitignore(path.join(dir, '.gitignore'))
    if (result?.ok) {
      out.push({
        prefix: segments.slice(i).join('/'),
        text: result.text,
        file: `${'../'.repeat(segments.length - i)}.gitignore`,
      })
    }
  }
  return out
}
