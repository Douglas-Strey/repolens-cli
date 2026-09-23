import type { Analyzer } from '../types.ts'
import { compareText } from '../utils/compare.ts'
import { cleanVersion } from '../utils/versions.ts'
import { manifests } from './manifests.ts'

export type DependencyType = 'dependencies' | 'devDependencies' | 'peerDependencies' | 'optionalDependencies' | 'go'

export interface DependencyRef {
  /** npm package name or Go module path. */
  name: string
  /**
   * Range as declared ("^4.1.2", "v1.11.0"); pnpm `catalog:` references are
   * resolved. Deno imports ("jsr:@hono/hono@^4") give the range of the specifier.
   */
  range: string
  type: DependencyType
  /** Package directory declaring it ("." = root). */
  package: string
  /** Manifest file declaring it. */
  file: string
  ecosystem: 'node' | 'go'
  /** Go only: marked `// indirect`. */
  indirect?: boolean
}

export interface DependencyIndex {
  readonly all: readonly DependencyRef[]
  /** Is the dependency declared anywhere (optionally: in a given package directory)? */
  has(name: string, packageDir?: string): boolean
  /** Every declaration of `name`, root first. */
  get(name: string): DependencyRef[]
  /** Declarations whose name starts with `prefix` (e.g. "@nestjs/"). */
  withPrefix(prefix: string): DependencyRef[]
  /** Declarations in one package directory. */
  inPackage(packageDir: string): DependencyRef[]
  /** Cleaned display version of the first declaration of `name` (see cleanVersion). */
  version(name: string): string | undefined
  /** Sorted, unique package directories that declare `name`. */
  packagesWith(name: string): string[]
}

const NODE_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const

export function createDependencyIndex(all: DependencyRef[]): DependencyIndex {
  const byName = new Map<string, DependencyRef[]>()
  const byPackage = new Map<string, DependencyRef[]>()
  for (const ref of all) {
    const named = byName.get(ref.name)
    if (named) named.push(ref)
    else byName.set(ref.name, [ref])
    const inPkg = byPackage.get(ref.package)
    if (inPkg) inPkg.push(ref)
    else byPackage.set(ref.package, [ref])
  }
  return {
    all,
    has(name, packageDir) {
      const refs = byName.get(name)
      if (!refs) return false
      return packageDir === undefined || refs.some((ref) => ref.package === packageDir)
    },
    get(name) {
      return [...(byName.get(name) ?? [])]
    },
    withPrefix(prefix) {
      return all.filter((ref) => ref.name.startsWith(prefix))
    },
    inPackage(packageDir) {
      return [...(byPackage.get(packageDir) ?? [])]
    },
    version(name) {
      for (const ref of byName.get(name) ?? []) {
        const version = cleanVersion(ref.range)
        if (version) return version
      }
      return undefined
    },
    packagesWith(name) {
      return [...new Set((byName.get(name) ?? []).map((ref) => ref.package))].sort(compareText)
    },
  }
}

/** Every dependency declared by the project's package.json files and go.mod files. */
export const dependencies: Analyzer<DependencyIndex> = {
  id: 'dependencies',
  async run(ctx) {
    const project = await ctx.use(manifests)
    const all: DependencyRef[] = []
    for (const manifest of project.packages) {
      for (const field of NODE_FIELDS) {
        for (const [name, range] of Object.entries(manifest[field])) {
          all.push({ name, range, type: field, package: manifest.dir, file: manifest.file, ecosystem: 'node' })
        }
      }
    }
    // Deno import maps list the project's packages; they are npm-style dependencies whatever the registry.
    for (const config of project.deno ?? []) {
      for (const dep of config.imports) {
        all.push({
          name: dep.name,
          range: dep.range,
          type: 'dependencies',
          package: config.dir,
          file: config.file,
          ecosystem: 'node',
        })
      }
    }
    for (const mod of project.goModules) {
      for (const req of mod.requires) {
        all.push({
          name: req.path,
          range: req.version,
          type: 'go',
          package: mod.dir,
          file: mod.file,
          ecosystem: 'go',
          indirect: req.indirect,
        })
      }
    }
    return createDependencyIndex(all)
  },
}
