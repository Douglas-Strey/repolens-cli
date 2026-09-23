import path from 'node:path'

/** Convert any OS path to posix separators. */
export function toPosix(p: string): string {
  return p.replaceAll('\\', '/')
}

/** Join posix path segments, collapsing "." (the root) away. */
export function joinPath(...parts: string[]): string {
  const joined = path.posix.join(...parts.filter((part) => part !== '' && part !== '.'))
  return joined === '' ? '.' : joined
}

/** Posix dirname that returns "." for top-level files. */
export function dirOf(file: string): string {
  const dir = path.posix.dirname(file)
  return dir === '' ? '.' : dir
}

export function baseName(file: string): string {
  return path.posix.basename(file)
}

/** Lowercase extension including the dot, e.g. ".ts". Returns "" for files without one. */
export function extOf(file: string): string {
  return path.posix.extname(file).toLowerCase()
}

/** Number of directory segments in a relative path ("a/b/c.txt" -> 2). */
export function depthOf(file: string): number {
  let depth = 0
  for (const ch of file) if (ch === '/') depth++
  return depth
}

/**
 * Normalize a user- or config-supplied relative path. Returns null if it is
 * absolute or escapes the root ("../x"), so callers can refuse it.
 */
export function normalizeRelative(p: string): string | null {
  const posix = toPosix(p).trim()
  if (posix === '') return null
  if (posix.startsWith('/') || /^[a-zA-Z]:/.test(posix)) return null
  const normalized = path.posix.normalize(posix).replace(/\/+$/, '')
  if (normalized === '..' || normalized.startsWith('../')) return null
  return normalized === '' ? '.' : normalized
}

/** True when `child` is `parent` or inside it. Both must be absolute, resolved paths. */
export function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  // A child named "..foo" is inside; only ".." itself or "../…" leaves the parent.
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

/** Is `file` inside directory `dir` (posix, relative; "." = root)? */
export function isInDir(file: string, dir: string): boolean {
  if (dir === '.' || dir === '') return true
  return file === dir || file.startsWith(`${dir}/`)
}
