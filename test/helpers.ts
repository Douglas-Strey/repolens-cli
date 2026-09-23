import { execFileSync } from 'node:child_process'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, expect } from 'vitest'
import { type CliIO, main } from '../src/cli/main.ts'
import { Context } from '../src/core/context.ts'
import { createFileIndex } from '../src/core/file-index.ts'
import { createContext, resolveOptions, scan } from '../src/core/scan.ts'
import { walk } from '../src/core/walker.ts'
import type { ScanOptions, ScanResult } from '../src/types.ts'

export const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

/**
 * Wall-clock budget for "this must not blow up" tests, scaled for slow
 * environments: coverage instrumentation (REPOLENS_TIME_SCALE, set by
 * vitest.config.ts) and shared CI runners. The budgets catch pathological
 * (quadratic, exponential) behavior, not small performance regressions.
 */
export function timeBudget(ms: number): number {
  const scale = Number(process.env.REPOLENS_TIME_SCALE) || (process.env.CI ? 4 : 1)
  return ms * scale
}

/** Sentinel present in every fake secret value inside fixtures. Must never appear in output. */
export const SECRET_SENTINEL = 'REPOLENS_FIXTURE_SECRET'

/** Fixed reference date so date-based checks (runtime EOL) are deterministic. */
export const TEST_NOW = new Date('2026-09-01T00:00:00Z')

const tempDirs: string[] = []
afterAll(async () => {
  // Retries absorb transient EBUSY/EPERM on Windows (antivirus, indexer); cleanup failures never fail a test.
  await Promise.all(
    tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})),
  )
})

/**
 * Environment for running git in tests. Git for Windows rejects os.devNull
 * (\\.\nul) as a config path but special-cases "/dev/null" on every platform.
 */
export const GIT_TEST_ENV = {
  GIT_AUTHOR_NAME: 'RepoLens Test',
  GIT_AUTHOR_EMAIL: 'test@repolens.invalid',
  GIT_COMMITTER_NAME: 'RepoLens Test',
  GIT_COMMITTER_EMAIL: 'test@repolens.invalid',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
}

/** Installed git version is at least major.minor (tests only). */
export function gitAtLeast(major: number, minor: number): boolean {
  try {
    const match = /(\d+)\.(\d+)/.exec(execFileSync('git', ['--version'], { encoding: 'utf8' }))
    const [have, sub] = [Number(match?.[1] ?? 0), Number(match?.[2] ?? 0)]
    return have > major || (have === major && sub >= minor)
  } catch {
    return false
  }
}

/** Whether this machine can create symlinks (Windows needs Developer Mode or admin rights). */
export const canSymlink: boolean = (() => {
  let dir: string | undefined
  try {
    dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'repolens-symlink-probe-'))
    fsSync.writeFileSync(path.join(dir, 'target'), '')
    fsSync.symlinkSync(path.join(dir, 'target'), path.join(dir, 'link'))
    return true
  } catch {
    return false
  } finally {
    if (dir) fsSync.rmSync(dir, { recursive: true, force: true })
  }
})()

/**
 * Assert that output contains no form of an absolute path: as is, JSON-escaped
 * (backslashes doubled on Windows) or with forward slashes.
 */
export function expectNoPath(text: string, dir: string): void {
  for (const form of new Set([dir, JSON.stringify(dir).slice(1, -1), dir.replaceAll('\\', '/')])) {
    expect(text).not.toContain(form)
  }
}

/** Create an empty temporary directory that is removed after the test file finishes. */
export async function makeTempDir(prefix = 'repolens-test-'): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)))
  tempDirs.push(dir)
  return dir
}

/**
 * Copy a fixture into a fresh temp directory and return its path. Scanning a
 * copy keeps results independent from this repository's own .git directory.
 */
export async function copyFixture(name: string): Promise<string> {
  // Copy into <tmp>/<name> so the project directory name is stable in output.
  const dir = path.join(await makeTempDir(`repolens-${name}-`), name)
  await fs.cp(path.join(FIXTURES_DIR, name), dir, { recursive: true })
  await restoreGitignores(dir)
  return dir
}

/**
 * Fixtures store their ignore rules as `_gitignore`, so the rules don't hide
 * fixture files (such as a fixture's own `.env`) from this repository's Git.
 * Restore the real name in the copy.
 */
export async function restoreGitignores(dir: string): Promise<void> {
  for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name === '_gitignore') {
      const parent = entry.parentPath
      await fs.rename(path.join(parent, '_gitignore'), path.join(parent, '.gitignore'))
    }
  }
}

/** Write files (path → content) into a directory, creating parent folders. */
export async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(root, ...file.split('/'))
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content)
  }
}

/** Create a temp project from an inline file map. */
export async function makeProject(files: Record<string, string>): Promise<string> {
  const dir = await makeTempDir()
  await writeFiles(dir, files)
  return dir
}

/** Initialize a Git repository and commit the given paths (or everything). Tests only. */
export function gitInit(dir: string, add: string[] = ['-A']): void {
  const run = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, stdio: 'ignore', env: { ...process.env, ...GIT_TEST_ENV } })
  run('init', '-q', '-b', 'main')
  run('add', '-f', ...add)
  run('commit', '-q', '--no-gpg-sign', '-m', 'init')
}

/** Scan a fixture copy with deterministic options. */
export async function scanFixture(name: string, options: ScanOptions = {}): Promise<ScanResult> {
  return scan({ now: TEST_NOW, ...options, cwd: await copyFixture(name) })
}

/** Scan a directory with deterministic options. */
export function scanDir(dir: string, options: ScanOptions = {}): Promise<ScanResult> {
  return scan({ now: TEST_NOW, ...options, cwd: dir })
}

/** Build a Context for a directory (to unit-test a single detector via ctx.use). */
export function contextFor(dir: string, options: ScanOptions = {}): Promise<Context> {
  return createContext({ now: TEST_NOW, ...options, cwd: dir })
}

/** Context for a fixture copy. */
export async function fixtureContext(name: string, options: ScanOptions = {}): Promise<Context> {
  return contextFor(await copyFixture(name), options)
}

export interface CliRun {
  code: number
  stdout: string
  stderr: string
}

/** Run the CLI in-process with captured output, colors off, and a fixed environment. */
export async function runCli(
  argv: string[],
  options: { cwd?: string; env?: Record<string, string>; columns?: number } = {},
): Promise<CliRun> {
  let stdout = ''
  let stderr = ''
  const io: CliIO = {
    stdout: { write: (chunk: string) => (stdout += chunk), isTTY: false, columns: options.columns ?? 100 },
    stderr: { write: (chunk: string) => (stderr += chunk), isTTY: false },
    env: { NO_COLOR: '1', ...options.env },
    cwd: options.cwd ?? process.cwd(),
    platform: 'linux',
    now: TEST_NOW,
  }
  const code = await main(argv, io)
  return { code, stdout, stderr }
}

// Re-exported for tests that need lower-level access.
export { Context, createFileIndex, resolveOptions, walk }
