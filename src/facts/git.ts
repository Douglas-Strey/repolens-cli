/**
 * Git metadata, read straight from the .git directory.
 *
 * RepoLens deliberately never runs the `git` binary: repository-level config
 * (core.fsmonitor, core.pager, filters, aliases) can make git execute
 * arbitrary programs, and RepoLens is meant to be safe on untrusted clones.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { readBinaryFile, readRegularFile } from '../core/fs.ts'
import type { Analyzer } from '../types.ts'
import { compareText } from '../utils/compare.ts'
import { isWithin, toPosix } from '../utils/paths.ts'

const METADATA_MAX_BYTES = 1024 * 1024
const INDEX_MAX_BYTES = 64 * 1024 * 1024
const POINTER_MAX_BYTES = 4096
const MAX_PARENT_LEVELS = 32

export interface GitLayout {
  /** Absolute path of the directory holding HEAD and index (per-worktree git dir). */
  gitDir: string
  /** Absolute path of the shared git dir holding config, refs and objects. */
  commonDir: string
  /** True when .git is a file pointing elsewhere (linked worktree or submodule). */
  linkedWorktree: boolean
  /**
   * Path of the scanned root relative to the repository's working tree, posix
   * style ("" when the scan root is the repository root). Used to map paths in
   * the Git index onto project-relative paths.
   */
  prefix: string
}

// ---------------------------------------------------------------------------
// Config parsing (https://git-scm.com/docs/git-config#_syntax)
// ---------------------------------------------------------------------------

export interface GitConfigEntry {
  /** Section name, lowercased: "remote". */
  section: string
  /** Subsection as written (case-sensitive): "origin". Null when absent. */
  subsection: string | null
  /** Variable name, lowercased: "url". */
  key: string
  /** Value with quotes and escapes resolved. Null for a bare key (boolean true). */
  value: string | null
}

const SECTION_HEADER = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\](.*)$/
const VARIABLE = /^([A-Za-z][A-Za-z0-9-]*)\s*(.*)$/

function unescapeSubsection(raw: string): string {
  return raw.replace(/\\(.)/g, '$1')
}

/**
 * Parse a value starting at `lines[index]` (text after "="). Handles quotes,
 * escapes, inline comments and backslash line continuations. Returns the
 * value and the index of the last line consumed.
 */
function parseValue(lines: readonly string[], index: number, start: string): [value: string, lastLine: number] {
  let out = ''
  let pendingSpace = ''
  let inQuote = false
  let line = start
  let current = index
  for (let i = 0; ; i++) {
    if (i >= line.length) {
      break
    }
    const ch = line[i] as string
    if (ch === '\\') {
      if (i === line.length - 1) {
        // Continuation: the value goes on with the next line.
        current++
        if (current >= lines.length) break
        line = lines[current] as string
        i = -1
        continue
      }
      const next = line[i + 1] as string
      const escaped = next === 'n' ? '\n' : next === 't' ? '\t' : next === 'b' ? '\b' : next
      out += pendingSpace + escaped
      pendingSpace = ''
      i++
      continue
    }
    if (ch === '"') {
      inQuote = !inQuote
      continue
    }
    if (!inQuote && (ch === '#' || ch === ';')) break
    if (!inQuote && (ch === ' ' || ch === '\t')) {
      if (out !== '') pendingSpace += ' '
      continue
    }
    out += pendingSpace + ch
    pendingSpace = ''
  }
  return [out, current]
}

/** Parse a Git config file (.git/config, .gitmodules). Unknown or malformed lines are skipped. */
export function parseGitConfig(text: string): GitConfigEntry[] {
  const entries: GitConfigEntry[] = []
  const lines = text.split(/\r?\n/)
  let section: string | null = null
  let subsection: string | null = null

  for (let index = 0; index < lines.length; index++) {
    let line = (lines[index] as string).trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue

    if (line.startsWith('[')) {
      const header = SECTION_HEADER.exec(line)
      if (!header?.[1]) {
        section = null
        continue
      }
      const name = header[1]
      if (header[2] !== undefined) {
        section = name.toLowerCase()
        subsection = unescapeSubsection(header[2])
      } else {
        // Deprecated "[section.subsection]" form; its subsection is case-insensitive.
        const dot = name.indexOf('.')
        section = (dot === -1 ? name : name.slice(0, dot)).toLowerCase()
        subsection = dot === -1 ? null : name.slice(dot + 1).toLowerCase()
      }
      line = (header[3] ?? '').trim()
      if (line === '' || line.startsWith('#') || line.startsWith(';')) continue
    }

    if (section === null) continue
    const variable = VARIABLE.exec(line)
    if (!variable?.[1]) continue
    const rest = variable[2] ?? ''
    let value: string | null = null
    if (rest.startsWith('=')) {
      const [parsed, lastLine] = parseValue(lines, index, rest.slice(1))
      value = parsed
      index = lastLine
    } else if (rest !== '' && !rest.startsWith('#') && !rest.startsWith(';')) {
      continue
    }
    entries.push({ section, subsection, key: variable[1].toLowerCase(), value })
  }
  return entries
}

/** All values of `section.subsection.key` (section and key are case-insensitive), in file order. */
export function gitConfigValues(
  entries: readonly GitConfigEntry[],
  section: string,
  subsection: string | null,
  key: string,
): string[] {
  const s = section.toLowerCase()
  const k = key.toLowerCase()
  const values: string[] = []
  for (const entry of entries) {
    if (entry.section === s && entry.subsection === subsection && entry.key === k && entry.value !== null) {
      values.push(entry.value)
    }
  }
  return values
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

async function realpathOrNull(target: string): Promise<string | null> {
  try {
    return await fs.realpath(target)
  } catch {
    return null
  }
}

/**
 * Real path of `relative` inside `base`, or null when it is missing or a
 * symlink leads outside `base`. Keeps planted symlinks in Git metadata (for
 * example in a downloaded archive) from reading arbitrary files.
 */
async function resolveInside(base: string, relative: string): Promise<string | null> {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) return null
  const real = await realpathOrNull(path.join(base, relative))
  return real !== null && isWithin(base, real) ? real : null
}

async function readMetadata(base: string, relative: string, maxBytes: number): Promise<string | null> {
  const file = await resolveInside(base, relative)
  if (file === null) return null
  const result = await readRegularFile(file, maxBytes)
  return result.ok ? result.text : null
}

async function hasHead(dir: string): Promise<boolean> {
  const head = await readMetadata(dir, 'HEAD', POINTER_MAX_BYTES)
  return head !== null && (/^ref: refs\//.test(head) || /^[0-9a-f]{40,64}\s*$/.test(head))
}

/**
 * A .git file may name any directory on disk. Only trust one that names this
 * checkout in return: linked worktrees record the path of their .git file in
 * `<gitdir>/gitdir`, submodules record their checkout in `core.worktree`.
 * Without this check a malicious repository could point RepoLens at another
 * repository on the machine and leak its remotes and branch names.
 */
async function pointsBackTo(gitDir: string, workTree: string, dotGit: string): Promise<boolean> {
  const back = await readMetadata(gitDir, 'gitdir', POINTER_MAX_BYTES)
  if (back !== null && back.trim() !== '') {
    if ((await realpathOrNull(path.resolve(gitDir, back.trim()))) === dotGit) return true
  }
  const config = await readMetadata(gitDir, 'config', METADATA_MAX_BYTES)
  if (config !== null) {
    for (const worktree of gitConfigValues(parseGitConfig(config), 'core', null, 'worktree')) {
      if ((await realpathOrNull(path.resolve(gitDir, worktree))) === workTree) return true
    }
  }
  return false
}

async function followGitFile(workTree: string, dotGit: string): Promise<Omit<GitLayout, 'prefix'> | null> {
  const pointer = await readRegularFile(dotGit, POINTER_MAX_BYTES)
  if (!pointer.ok) return null
  const firstLine = pointer.text.split(/\r?\n/, 1)[0] ?? ''
  const target = firstLine.startsWith('gitdir:') ? firstLine.slice('gitdir:'.length).trim() : ''
  if (target === '') return null
  const gitDir = await realpathOrNull(path.resolve(workTree, target))
  if (gitDir === null || !(await hasHead(gitDir))) return null
  if (!(await pointsBackTo(gitDir, workTree, dotGit))) return null

  let commonDir = gitDir
  const common = await readMetadata(gitDir, 'commondir', POINTER_MAX_BYTES)
  if (common !== null && common.trim() !== '') {
    const resolved = await realpathOrNull(path.resolve(gitDir, common.trim()))
    // Linked worktrees live at <commondir>/worktrees/<name>; anything else is not a real layout.
    if (resolved === null || resolved === gitDir || !isWithin(resolved, gitDir) || !(await hasHead(resolved))) {
      return null
    }
    commonDir = resolved
  }
  return { gitDir, commonDir, linkedWorktree: true }
}

type DotGit = Omit<GitLayout, 'prefix'> | 'absent' | 'invalid'

async function resolveDotGit(workTree: string): Promise<DotGit> {
  const dotGit = path.join(workTree, '.git')
  let stat: Awaited<ReturnType<typeof fs.lstat>>
  try {
    stat = await fs.lstat(dotGit)
  } catch {
    return 'absent'
  }
  if (stat.isDirectory()) {
    return (await hasHead(dotGit)) ? { gitDir: dotGit, commonDir: dotGit, linkedWorktree: false } : 'invalid'
  }
  // Symlinked .git entries are refused: a clone cannot contain one, an untrusted archive can.
  if (!stat.isFile()) return 'invalid'
  return (await followGitFile(workTree, dotGit)) ?? 'invalid'
}

/**
 * Locate the Git repository containing the scan root (the root itself or a
 * parent directory). The search stops at the first `.git` entry; if that
 * entry is unusable the result is null, like git refusing a broken gitfile.
 */
export const gitLayout: Analyzer<GitLayout | null> = {
  id: 'git-layout',
  async run(ctx) {
    let current = ctx.root
    for (let level = 0; level < MAX_PARENT_LEVELS; level++) {
      const found = await resolveDotGit(current)
      if (found === 'invalid') {
        const where = toPosix(path.relative(ctx.root, current)) || '.'
        if (current === ctx.root) {
          ctx.warn({
            kind: 'error',
            file: '.git',
            message: 'Ignored .git because it does not lead to Git metadata for this directory',
          })
        }
        ctx.debug(`git: ignoring unusable .git in ${where}`)
        return null
      }
      if (found !== 'absent') {
        return { ...found, prefix: toPosix(path.relative(current, ctx.root)) }
      }
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
    return null
  },
}

/**
 * Read a text file from Git metadata, e.g. readGitFile(layout, 'HEAD') or
 * readGitFile(layout, 'config', 'common'). Returns null when missing, or when
 * the file is a symlink leading out of the Git directory.
 */
export async function readGitFile(
  layout: GitLayout,
  relative: string,
  location: 'worktree' | 'common' = 'worktree',
): Promise<string | null> {
  const base = location === 'common' ? layout.commonDir : layout.gitDir
  return readMetadata(base, relative, METADATA_MAX_BYTES)
}

// ---------------------------------------------------------------------------
// Index parsing (https://git-scm.com/docs/index-format)
// ---------------------------------------------------------------------------

function readOffsetVarint(buf: Buffer, start: number): [value: number, length: number] | null {
  let offset = start
  if (offset >= buf.length) return null
  let byte = buf[offset++] as number
  let value = byte & 0x7f
  while (byte & 0x80) {
    if (offset >= buf.length) return null
    value += 1
    byte = buf[offset++] as number
    value = value * 128 + (byte & 0x7f)
  }
  return [value, offset - start]
}

/**
 * Upper bound on the decoded path bytes of an index, relative to its size.
 * Version 4 prefix compression lets every entry repeat the previous path, so
 * a crafted index of a few megabytes could otherwise expand to gigabytes of
 * strings. Every entry carries at least 62 bytes of fixed data, so real
 * indexes decode to about their own size (deeply nested v4 paths to a few
 * times it).
 */
const INDEX_EXPANSION_LIMIT = 8
const INDEX_MAX_PATH_BYTES = 256 * 1024 * 1024

/**
 * Extract the paths stored in a Git index file (versions 2, 3 and 4).
 * Returns null when the data is not a valid index.
 */
export function parseGitIndex(buf: Buffer, hashSize = 20): string[] | null {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'DIRC') return null
  const version = buf.readUInt32BE(4)
  if (version < 2 || version > 4) return null
  const count = buf.readUInt32BE(8)
  const fixedSize = 40 + hashSize + 2
  let budget = Math.min(buf.length * INDEX_EXPANSION_LIMIT, INDEX_MAX_PATH_BYTES)

  const paths: string[] = []
  let offset = 12
  let previous: Buffer = Buffer.alloc(0)

  for (let i = 0; i < count; i++) {
    const entryStart = offset
    if (entryStart + fixedSize > buf.length) return null
    const flags = buf.readUInt16BE(entryStart + 40 + hashSize)
    offset = entryStart + fixedSize
    if (flags & 0x4000) {
      if (version < 3) return null
      offset += 2
    }

    let name: Buffer
    if (version === 4) {
      const varint = readOffsetVarint(buf, offset)
      if (!varint) return null
      const [strip, length] = varint
      offset += length
      const nul = buf.indexOf(0, offset)
      if (nul === -1 || strip > previous.length) return null
      budget -= previous.length - strip + (nul - offset)
      if (budget < 0) return null
      name = Buffer.concat([previous.subarray(0, previous.length - strip), buf.subarray(offset, nul)])
      offset = nul + 1
    } else {
      const nul = buf.indexOf(0, offset)
      if (nul === -1) return null
      name = buf.subarray(offset, nul)
      // Entries are NUL-padded to a multiple of 8 bytes.
      const entryLength = nul + 1 - entryStart
      offset = entryStart + Math.ceil(entryLength / 8) * 8
    }
    previous = name
    paths.push(name.toString('utf8'))
  }
  return paths
}

async function hashSizeFor(layout: GitLayout): Promise<number> {
  const config = await readGitFile(layout, 'config', 'common')
  if (config === null) return 20
  return gitConfigValues(parseGitConfig(config), 'extensions', null, 'objectformat').some(
    (value) => value.toLowerCase() === 'sha256',
  )
    ? 32
    : 20
}

/**
 * File names worth knowing about in the directories above a scan root that
 * is a subdirectory of the repository: they tell which package manager the
 * repository installs with.
 */
export const ANCESTOR_FILE_NAMES: readonly string[] = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'yarn.lock',
  '.yarnrc.yml',
  'bun.lock',
  'bun.lockb',
]

export interface AncestorFiles {
  /** Directory relative to the repository root ("" = the repository root). */
  dir: string
  /** How many directories above the scan root it is (1 = the parent). */
  levels: number
  /** Tracked files directly in that directory, limited to ANCESTOR_FILE_NAMES, sorted. */
  files: string[]
}

export interface GitIndexFacts {
  /** Paths tracked by Git, relative to the scan root. */
  tracked: ReadonlySet<string>
  /**
   * Package-manager files tracked in the directories between the repository
   * root and the scan root, nearest first. Empty when the scan root is the
   * repository root. Read from the index, which is Git metadata: RepoLens
   * still never reads files outside the scan root.
   */
  ancestors: AncestorFiles[]
}

/** Split index paths into scan-root-relative tracked files and package-manager files above the scan root. */
export function indexFacts(paths: readonly string[], prefix: string): GitIndexFacts {
  const base = prefix === '' ? '' : `${prefix}/`
  const tracked = new Set<string>()
  // "apps/web" → ancestors "apps" (1 level up) and "" (2 levels up).
  const segments = prefix === '' ? [] : prefix.split('/')
  const levels = new Map<string, number>()
  for (let i = 0; i < segments.length; i++) levels.set(segments.slice(0, i).join('/'), segments.length - i)
  const found = new Map<string, string[]>()
  for (const entry of paths) {
    // Sparse indexes store whole directories as entries ending in "/".
    if (entry.endsWith('/')) continue
    if (base === '') {
      tracked.add(entry)
      continue
    }
    if (entry.startsWith(base)) {
      tracked.add(entry.slice(base.length))
      continue
    }
    const slash = entry.lastIndexOf('/')
    const dir = slash === -1 ? '' : entry.slice(0, slash)
    const name = entry.slice(slash + 1)
    if (!levels.has(dir) || !ANCESTOR_FILE_NAMES.includes(name)) continue
    const list = found.get(dir)
    if (list) list.push(name)
    else found.set(dir, [name])
  }
  const ancestors = [...found]
    .map(([dir, files]) => ({ dir, levels: levels.get(dir) ?? 0, files: [...new Set(files)].sort(compareText) }))
    .sort((a, b) => a.levels - b.levels)
  return { tracked, ancestors }
}

/** Tracked files and package-manager files above the scan root, from one read of .git/index. */
export const gitIndex: Analyzer<GitIndexFacts | null> = {
  id: 'git-index',
  async run(ctx) {
    const layout = await ctx.use(gitLayout)
    if (!layout) return null
    const indexFile = await resolveInside(layout.gitDir, 'index')
    if (indexFile === null) return null
    const buffer = await readBinaryFile(indexFile, INDEX_MAX_BYTES)
    if (!buffer) return null
    const paths = parseGitIndex(buffer, await hashSizeFor(layout))
    if (!paths) {
      ctx.debug('git: could not parse .git/index')
      return null
    }
    return indexFacts(paths, layout.prefix)
  },
}

/**
 * Paths tracked by Git, relative to the scan root. `null` when the scan root
 * is not inside a Git repository or the index cannot be read.
 */
export const gitTrackedFiles: Analyzer<ReadonlySet<string> | null> = {
  id: 'git-tracked-files',
  async run(ctx) {
    return (await ctx.use(gitIndex))?.tracked ?? null
  },
}
