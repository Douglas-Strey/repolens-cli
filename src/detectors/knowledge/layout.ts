/**
 * Where configuration files may live: the root, every package directory
 * (package.json or go.mod) and fixed subdirectories of those. Config files
 * elsewhere in the tree are deliberately not considered, which keeps the
 * detectors fast and avoids picking up fixtures and examples.
 */
import { manifests } from '../../facts/manifests.ts'
import type { Analyzer } from '../../types.ts'
import { compareText } from '../../utils/compare.ts'
import { globToRegExp } from '../../utils/glob.ts'
import { baseName, dirOf, joinPath } from '../../utils/paths.ts'
import { comparePackageDirs } from './signals.ts'

/** The parts of a package.json the tool detectors need. */
export interface ManifestFacts {
  /** Package directory ("." = root). */
  dir: string
  /** Path of the package.json file. */
  file: string
  /** Package name, when the manifest has one. */
  name?: string
  scripts: Readonly<Record<string, string>>
  /** Top-level keys with a non-null value, e.g. "jest", "prettier", "eslintConfig". */
  fields: readonly string[]
}

export interface ProjectLayout {
  /** Root first, then package.json and go.mod directories in path order. */
  packageDirs: readonly string[]
  /** Every indexed file, grouped by its directory ("." = root). */
  filesByDir: ReadonlyMap<string, readonly string[]>
  manifests: readonly ManifestFacts[]
}

export interface LocatedFile {
  path: string
  /** Package directory the file belongs to. */
  package: string
  /** Path relative to that package directory. */
  rel: string
}

export function createLayout(
  files: readonly string[],
  packageDirs: readonly string[],
  manifestFacts: readonly ManifestFacts[] = [],
): ProjectLayout {
  const filesByDir = new Map<string, string[]>()
  for (const file of files) {
    const dir = dirOf(file)
    const bucket = filesByDir.get(dir)
    if (bucket) bucket.push(file)
    else filesByDir.set(dir, [file])
  }
  return {
    packageDirs: [...new Set(['.', ...packageDirs])].sort(comparePackageDirs),
    filesByDir,
    manifests: manifestFacts,
  }
}

/**
 * Deepest Go module directory containing `file`, or null. Unlike `ownerOf`,
 * package.json directories do not count: a Go file under a Node package still
 * belongs to the Go module around it.
 */
export function goModuleOf(file: string, moduleDirs: ReadonlySet<string>): string | null {
  let dir = dirOf(file)
  for (;;) {
    if (moduleDirs.has(dir)) return dir
    if (dir === '.') return null
    dir = dirOf(dir)
  }
}

function depthOfDir(dir: string): number {
  return dir === '.' ? 0 : dir.split('/').length
}

/**
 * Files matching any of `patterns` in the root and in every package
 * directory. A pattern is relative to the package directory; its directory
 * part must be literal (".vitepress/config.ts"), its file name may use globs
 * ("vite.config.{js,ts}"). A file reachable from several package directories
 * belongs to the deepest one, like `ownerOf`. Sorted by path.
 */
export function locateFiles(
  layout: ProjectLayout,
  patterns: readonly string[],
  options: { rootOnly?: boolean } = {},
): LocatedFile[] {
  const dirs = options.rootOnly ? ['.'] : layout.packageDirs
  const found = new Map<string, LocatedFile>()
  for (const pattern of patterns) {
    const slash = pattern.lastIndexOf('/')
    const sub = slash === -1 ? '' : pattern.slice(0, slash)
    const nameRe = globToRegExp(pattern.slice(slash + 1))
    for (const dir of dirs) {
      for (const file of layout.filesByDir.get(joinPath(dir, sub)) ?? []) {
        const name = baseName(file)
        if (!nameRe.test(name)) continue
        const existing = found.get(file)
        if (existing && depthOfDir(existing.package) >= depthOfDir(dir)) continue
        found.set(file, { path: file, package: dir, rel: sub ? `${sub}/${name}` : name })
      }
    }
  }
  return [...found.values()].sort((a, b) => compareText(a.path, b.path))
}

/** Root, package.json directories and Go module directories, plus the facts the tool detectors need. */
export const projectLayout: Analyzer<ProjectLayout> = {
  id: 'knowledge:project-layout',
  async run(ctx) {
    const project = await ctx.use(manifests)
    const dirs = [...project.packages.map((pkg) => pkg.dir), ...project.goModules.map((mod) => mod.dir)]
    const facts = project.packages.map(
      (pkg): ManifestFacts => ({
        dir: pkg.dir,
        file: pkg.file,
        ...(pkg.name === undefined ? {} : { name: pkg.name }),
        scripts: pkg.scripts,
        fields: Object.keys(pkg.raw).filter((key) => pkg.raw[key] !== null && pkg.raw[key] !== undefined),
      }),
    )
    return createLayout(ctx.files.files, dirs, facts)
  },
}
