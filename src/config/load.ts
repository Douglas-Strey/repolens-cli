import fs from 'node:fs/promises'
import path from 'node:path'
import { RepoLensError } from '../core/errors.ts'
import { type ReadFailure, readRegularFile, readTextWithin } from '../core/fs.ts'
import { isRecord, parseJson, parseJsonc } from '../core/parse.ts'
import type { ConfigSource, LoadedConfig } from '../types.ts'
import { isWithin } from '../utils/paths.ts'
import { validateConfig } from './validate.ts'

/** The project configuration file, looked up in the scanned directory only. */
export const PROJECT_CONFIG_FILE = 'repolens.config.json'
/** Largest configuration file RepoLens reads. */
export const MAX_CONFIG_BYTES = 256 * 1024
/** package.json is read whole to find its "repolens" key; the manifest detector uses the same limit. */
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024

const REASONS: Record<Exclude<ReadFailure, 'missing'>, string> = {
  'outside-root': 'is a symbolic link to a file outside the scanned directory',
  'not-a-file': 'is not a regular file',
  'too-large': `is larger than ${MAX_CONFIG_BYTES / 1024} KB`,
  binary: 'is not a text file',
  unreadable: "couldn't be read",
}

function unusable(source: ConfigSource, label: string, message: string, detail?: string): LoadedConfig {
  return {
    source,
    label,
    config: {},
    warnings: [
      { kind: 'config', ...(source.file ? { file: source.file } : {}), message, ...(detail ? { detail } : {}) },
    ],
  }
}

async function packageJsonConfig(root: string): Promise<{ found: false } | { found: true; value: unknown }> {
  const read = await readTextWithin(root, 'package.json', MAX_PACKAGE_JSON_BYTES)
  if (!read.ok) return { found: false }
  try {
    // A broken package.json is reported by the manifest detector.
    const manifest = parseJson(read.text)
    return isRecord(manifest) && Object.hasOwn(manifest, 'repolens')
      ? { found: true, value: manifest.repolens }
      : { found: false }
  } catch {
    return { found: false }
  }
}

/**
 * The scanned directory's own configuration: `repolens.config.json`, or else
 * the "repolens" key of its package.json. Null when it has neither. Never
 * throws: the repository may not be trusted, so a file RepoLens can't use is
 * ignored with a warning. The file must resolve inside `root`.
 */
export async function loadProjectConfig(dir: string): Promise<LoadedConfig | null> {
  let root: string
  try {
    root = await fs.realpath(dir)
  } catch {
    return null
  }
  const source: ConfigSource = { kind: 'project', file: PROJECT_CONFIG_FILE }
  const label = PROJECT_CONFIG_FILE
  const read = await readTextWithin(root, PROJECT_CONFIG_FILE, MAX_CONFIG_BYTES)
  if (read.ok) {
    let raw: unknown
    try {
      raw = parseJsonc(read.text)
    } catch (error) {
      return unusable(source, label, `Couldn't parse ${label}; its settings were ignored`, (error as Error).message)
    }
    const loaded = validateConfig(raw, source, label)
    if ((await packageJsonConfig(root)).found) {
      loaded.warnings.push({
        kind: 'config',
        file: 'package.json',
        message: `The "repolens" key in package.json was ignored: ${label} takes precedence`,
      })
    }
    return loaded
  }
  if (read.reason !== 'missing') {
    return unusable(source, label, `${label} ${REASONS[read.reason]}; it was ignored`)
  }
  const fromPackage = await packageJsonConfig(root)
  if (!fromPackage.found) return null
  return validateConfig(
    fromPackage.value,
    { kind: 'project', file: 'package.json' },
    'the "repolens" key of package.json',
  )
}

/**
 * Read a configuration file the user chose (--config, the user config file).
 * Symbolic links are followed: dotfile managers link these files. Throws
 * RepoLensError INVALID_CONFIG when the file is missing, unreadable or not
 * JSON; invalid settings only produce warnings. `label` names the file in
 * those warnings, which end up in JSON output, so it must not be an absolute
 * path; `shown` names it in errors (default: `label`).
 */
export async function loadConfigFile(
  file: string,
  source: ConfigSource,
  label: string,
  shown: string = label,
): Promise<LoadedConfig> {
  let real: string
  try {
    real = await fs.realpath(file)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new RepoLensError('INVALID_CONFIG', `Config file not found: ${shown}`)
    }
    throw new RepoLensError('INVALID_CONFIG', `Couldn't read config file ${shown}`, code)
  }
  const read = await readRegularFile(real, MAX_CONFIG_BYTES)
  if (!read.ok) {
    const reason = read.reason === 'missing' ? "couldn't be read" : REASONS[read.reason]
    throw new RepoLensError('INVALID_CONFIG', `Config file ${shown} ${reason}`, read.detail)
  }
  let raw: unknown
  try {
    raw = parseJsonc(read.text)
  } catch (error) {
    throw new RepoLensError('INVALID_CONFIG', `Couldn't parse config file ${shown}: ${(error as Error).message}`)
  }
  return validateConfig(raw, source, label)
}

type Env = Readonly<Record<string, string | undefined>>

/**
 * Where the user config file lives: $REPOLENS_CONFIG, else
 * $XDG_CONFIG_HOME/repolens/config.json, else %APPDATA%\repolens\config.json
 * on Windows, else ~/.config/repolens/config.json. Undefined when none of
 * those variables is set.
 */
export function userConfigPath(env: Env, platform: NodeJS.Platform, cwd: string): string | undefined {
  if (env.REPOLENS_CONFIG) return path.resolve(cwd, env.REPOLENS_CONFIG)
  const xdg = env.XDG_CONFIG_HOME
  if (xdg && path.isAbsolute(xdg)) return path.join(xdg, 'repolens', 'config.json')
  if (platform === 'win32' && env.APPDATA) return path.join(env.APPDATA, 'repolens', 'config.json')
  const home = env.HOME || (platform === 'win32' ? env.USERPROFILE : undefined)
  return home ? path.join(home, '.config', 'repolens', 'config.json') : undefined
}

/** A path for messages, with the home directory shown as "~". */
export function tildePath(file: string, env: Env): string {
  const home = env.HOME || env.USERPROFILE
  if (!home || !path.isAbsolute(home) || !isWithin(home, file)) return file
  const rest = path.relative(home, file)
  return rest === '' ? '~' : `~${path.sep}${rest}`
}

/**
 * The user config file, or null when there is none at the default location.
 * A file named by $REPOLENS_CONFIG must exist.
 */
export async function loadUserConfig(env: Env, platform: NodeJS.Platform, cwd: string): Promise<LoadedConfig | null> {
  const file = userConfigPath(env, platform, cwd)
  if (!file) return null
  const shown = tildePath(file, env)
  if (!env.REPOLENS_CONFIG) {
    try {
      await fs.lstat(file)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return null
    }
  }
  return loadConfigFile(file, { kind: 'user' }, 'your user config', shown)
}
