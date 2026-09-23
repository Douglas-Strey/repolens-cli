import {
  type GitConfigEntry,
  type GitLayout,
  gitLayout,
  gitTrackedFiles,
  parseGitConfig,
  readGitFile,
} from '../facts/git.ts'
import type { Detector, GitRemote, GitSection } from '../types.ts'
import { compareText } from '../utils/compare.ts'
import { normalizeRelative } from '../utils/paths.ts'
import { redactCommand, sanitizeUrl } from '../utils/redact.ts'

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const MAX_SYMREF_DEPTH = 5

export type HeadState = { kind: 'ref'; ref: string } | { kind: 'detached'; sha: string }

/** Parse .git/HEAD: a symbolic ref ("ref: refs/heads/main") or a detached commit id. */
export function parseHead(text: string): HeadState | null {
  const value = text.trim()
  const symbolic = /^ref:\s*(\S+)$/.exec(value)
  if (symbolic?.[1]) return { kind: 'ref', ref: symbolic[1] }
  return SHA.test(value) ? { kind: 'detached', sha: value } : null
}

/** Branch name for a ref under refs/heads/, else null. */
export function branchOf(ref: string): string | null {
  if (!ref.startsWith('refs/heads/')) return null
  const name = ref.slice('refs/heads/'.length)
  // reftable repositories keep a placeholder in HEAD; the real ref lives in binary tables.
  return name === '' || name === '.invalid' ? null : name
}

/** Ref names safe to use as a path below the Git directory. */
export function isSafeRefName(ref: string): boolean {
  if (!/^refs\/[^\0-\x20~^:?*[\\\x7f]+$/.test(ref)) return false
  return !ref.includes('..') && !ref.includes('//') && !ref.endsWith('/') && !ref.endsWith('.lock')
}

/** Map of ref name → commit id from a packed-refs file. Peeled lines ("^…") and comments are skipped. */
export function parsePackedRefs(text: string): Map<string, string> {
  const refs = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-f]{40}|[0-9a-f]{64}) (\S+)$/.exec(line.trim())
    if (match?.[1] && match[2] && !refs.has(match[2])) refs.set(match[2], match[1])
  }
  return refs
}

/** Hostname of a remote URL ("https://…", "ssh://…", or scp-like "git@host:path"), lowercased. */
export function remoteHostname(url: string): string | null {
  const trimmed = url.trim()
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]*)/.exec(trimmed)
  if (withScheme) {
    const authority = withScheme[1] ?? ''
    const host = authority.slice(authority.lastIndexOf('@') + 1)
    const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.replace(/:\d*$/, '')
    return hostname === '' ? null : hostname.toLowerCase()
  }
  // scp-like syntax: [user@]host:path, where host has no slash and is not a Windows drive letter.
  const scp = /^(?:[^@/\\]+@)?([^:/\\]{2,}):(?!\/\/)/.exec(trimmed)
  return scp?.[1] ? scp[1].toLowerCase() : null
}

/** Recognized hosting provider for a remote URL. */
export function remoteHostKind(url: string): string | undefined {
  const hostname = remoteHostname(url)?.replace(/^www\./, '')
  if (!hostname) return undefined
  if (hostname === 'github.com' || hostname === 'ssh.github.com') return 'github'
  if (hostname === 'gitlab.com' || hostname === 'altssh.gitlab.com') return 'gitlab'
  if (hostname === 'bitbucket.org' || hostname === 'altssh.bitbucket.org') return 'bitbucket'
  if (hostname === 'dev.azure.com' || hostname === 'ssh.dev.azure.com' || hostname.endsWith('.visualstudio.com')) {
    return 'azure'
  }
  if (hostname === 'codeberg.org') return 'codeberg'
  return undefined
}

function isLocalAbsolute(url: string): boolean {
  return url.startsWith('/') || url.startsWith('\\\\') || /^[a-zA-Z]:[\\/]/.test(url)
}

/**
 * Remote URL safe for output: credentials, query strings and fragments are
 * removed, and absolute local paths (which reveal the user's file system) are
 * reduced to their last segment.
 */
export function displayRemoteUrl(url: string): string {
  const trimmed = url.trim()
  const fileUrl = /^file:\/\//i.test(trimmed)
  if (fileUrl || isLocalAbsolute(trimmed)) {
    const segments = trimmed
      .replace(/[?#].*$/, '')
      .split(/[\\/]+/)
      .filter(Boolean)
    const last = segments[segments.length - 1] ?? ''
    return `${fileUrl ? 'file://' : ''}…/${last}`
  }
  let sanitized = sanitizeUrl(trimmed)
  // scp-like URLs keep their user name ("git@host:path"); drop anything that is not a plain user name
  // (at most 32 characters, like a Unix login, so a 40-character token used as the user is dropped).
  const scpUser = /^([^@/]+)@[^@/:]+:/.exec(sanitized)
  if (scpUser?.[1] && !/^[A-Za-z0-9._-]{1,32}$/.test(scpUser[1])) {
    sanitized = sanitized.slice(sanitized.indexOf('@') + 1)
  }
  // Without a scheme, anything like "user:token@host/path" before the first "/" is userinfo.
  const userinfo = /^([^/@]+)@/.exec(sanitized)
  if (
    !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(sanitized) &&
    userinfo?.[1] &&
    !/^[A-Za-z0-9._-]{1,32}$/.test(userinfo[1])
  ) {
    sanitized = sanitized.slice(userinfo[0].length)
  }
  return redactCommand(sanitized)
}

function compareRemotes(a: GitRemote, b: GitRemote): number {
  if (a.name === b.name) return 0
  if (a.name === 'origin') return -1
  if (b.name === 'origin') return 1
  return compareText(a.name, b.name)
}

/** Remotes declared in a parsed Git config, "origin" first, then by name. */
export function remotesFromConfig(entries: readonly GitConfigEntry[]): GitRemote[] {
  const firstUrl = new Map<string, string>()
  for (const entry of entries) {
    if (entry.section !== 'remote' || entry.key !== 'url' || entry.subsection === null) continue
    if (entry.value === null || entry.value.trim() === '' || firstUrl.has(entry.subsection)) continue
    firstUrl.set(entry.subsection, entry.value)
  }
  const remotes: GitRemote[] = []
  for (const [name, url] of firstUrl) {
    const remote: GitRemote = { name, url: displayRemoteUrl(url) }
    const host = remoteHostKind(url)
    if (host) remote.host = host
    remotes.push(remote)
  }
  return remotes.sort(compareRemotes)
}

/** Submodule paths declared in .gitmodules, sorted. Paths escaping the repository are dropped. */
export function submodulePaths(gitmodules: string): string[] {
  const paths = new Set<string>()
  for (const entry of parseGitConfig(gitmodules)) {
    if (entry.section !== 'submodule' || entry.key !== 'path' || entry.value === null) continue
    const normalized = normalizeRelative(entry.value)
    if (normalized !== null && normalized !== '.') paths.add(normalized)
  }
  return [...paths].sort(compareText)
}

/** True when a .gitattributes file routes any path through the Git LFS filter. */
export function usesLfs(gitattributes: string): boolean {
  return gitattributes
    .split(/\r?\n/)
    .some((line) => !line.trimStart().startsWith('#') && /(?:^|\s)filter=lfs(?:\s|$)/.test(line))
}

/** Location of a ref: most refs are shared, a few are private to each worktree. */
function refLocation(ref: string): 'worktree' | 'common' {
  return /^refs\/(?:worktree|bisect|rewritten)\//.test(ref) ? 'worktree' : 'common'
}

async function resolveRef(layout: GitLayout, ref: string, packed: () => Promise<Map<string, string>>) {
  let current = ref
  for (let depth = 0; depth < MAX_SYMREF_DEPTH; depth++) {
    if (!isSafeRefName(current)) return null
    const loose = await readGitFile(layout, current, refLocation(current))
    if (loose !== null) {
      const state = parseHead(loose)
      if (state?.kind === 'detached') return state.sha
      if (state?.kind === 'ref') {
        current = state.ref
        continue
      }
      return null
    }
    return (await packed()).get(current) ?? null
  }
  return null
}

async function readHead(layout: GitLayout): Promise<{ branch: string | null; head: string | null }> {
  const text = await readGitFile(layout, 'HEAD')
  const state = text === null ? null : parseHead(text)
  if (!state) return { branch: null, head: null }
  if (state.kind === 'detached') return { branch: null, head: state.sha.slice(0, 7) }

  let packedRefs: Map<string, string> | undefined
  const packed = async () => {
    packedRefs ??= parsePackedRefs((await readGitFile(layout, 'packed-refs', 'common')) ?? '')
    return packedRefs
  }
  const branch = branchOf(state.ref)
  const sha =
    branch === null && state.ref.startsWith('refs/heads/') ? null : await resolveRef(layout, state.ref, packed)
  return { branch, head: sha ? sha.slice(0, 7) : null }
}

export const gitDetector: Detector<'git'> = {
  id: 'git',
  title: 'Git',
  async run(ctx) {
    const layout = await ctx.use(gitLayout)
    if (!layout) return null

    const [{ branch, head }, config, tracked, gitmodules, attributes] = await Promise.all([
      readHead(layout),
      readGitFile(layout, 'config', 'common'),
      ctx.use(gitTrackedFiles),
      ctx.files.has('.gitmodules') ? ctx.readText('.gitmodules') : Promise.resolve(null),
      Promise.all(ctx.files.byName('.gitattributes').map((file) => ctx.readText(file))),
    ])

    const section: GitSection = {
      branch,
      head,
      remotes: config === null ? [] : remotesFromConfig(parseGitConfig(config)),
      submodules: gitmodules === null ? [] : submodulePaths(gitmodules),
      lfs: attributes.some((text) => text !== null && usesLfs(text)),
      trackedFiles: tracked ? tracked.size : null,
      linkedWorktree: layout.linkedWorktree,
    }
    return section
  },
}
