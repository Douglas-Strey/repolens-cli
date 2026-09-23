import type { FileIndex } from '../types.ts'
import { globToRegExp } from '../utils/glob.ts'
import { baseName, extOf, normalizeRelative } from '../utils/paths.ts'
import type { WalkResult } from './walker.ts'

/** Index keys are clean relative paths; accept "./a", "a/" and "a\\b" too. Only pays for normalization when needed. */
function clean(path: string): string {
  if (!path.startsWith('./') && !path.endsWith('/') && !path.includes('\\')) return path
  return normalizeRelative(path) ?? path
}

/** ".TS" and "ts" both mean ".ts". */
function normalizeExtension(ext: string): string {
  const lower = ext.toLowerCase()
  return lower.startsWith('.') ? lower : `.${lower}`
}

export function createFileIndex(walk: WalkResult): FileIndex {
  const fileSet = new Set(walk.files)
  const ignoredSet = new Set(walk.ignoredFiles)
  let byNameMap: Map<string, string[]> | undefined
  let byNameIgnoredMap: Map<string, string[]> | undefined
  let byExtMap: Map<string, string[]> | undefined

  const buildNameMap = (list: readonly string[]) => {
    const map = new Map<string, string[]>()
    for (const file of list) {
      const name = baseName(file)
      const bucket = map.get(name)
      if (bucket) bucket.push(file)
      else map.set(name, [file])
    }
    return map
  }

  return {
    files: walk.files,
    ignoredFiles: walk.ignoredFiles,
    directories: walk.directories,
    truncated: walk.truncated,

    has(path, options) {
      const key = clean(path)
      return fileSet.has(key) || (options?.includeIgnored === true && ignoredSet.has(key))
    },

    hasDirectory(path) {
      const key = clean(path)
      return key === '.' || key === '' || walk.directories.has(key)
    },

    byName(name, options) {
      byNameMap ??= buildNameMap(walk.files)
      const found = byNameMap.get(name) ?? []
      if (!options?.includeIgnored) return [...found]
      byNameIgnoredMap ??= buildNameMap(walk.ignoredFiles)
      return [...found, ...(byNameIgnoredMap.get(name) ?? [])].sort()
    },

    byExtension(...extensions) {
      if (!byExtMap) {
        byExtMap = new Map()
        for (const file of walk.files) {
          const ext = extOf(file)
          if (!ext) continue
          const bucket = byExtMap.get(ext)
          if (bucket) bucket.push(file)
          else byExtMap.set(ext, [file])
        }
      }
      const buckets = byExtMap
      const wanted = [...new Set(extensions.map(normalizeExtension))]
      // concat, not push(...bucket): spreading ~130k+ paths as call arguments overflows the stack.
      const out = wanted.reduce<string[]>((all, ext) => all.concat(buckets.get(ext) ?? []), [])
      return wanted.length > 1 ? out.sort() : out
    },

    glob(pattern, options) {
      const re = globToRegExp(pattern)
      const list = options?.includeIgnored ? [...walk.files, ...walk.ignoredFiles].sort() : walk.files
      return list.filter((file) => re.test(file))
    },

    isIgnored(path, options) {
      return walk.isIgnored(path, options?.directory === true)
    },
  }
}
