import { type DependencyRef, dependencies } from '../facts/dependencies.ts'
import { manifests } from '../facts/manifests.ts'
import type { DependencyEntry, DependencyKind, Detector, PackageDependencies } from '../types.ts'
import { compareText } from '../utils/compare.ts'
import { redactCommand } from '../utils/redact.ts'
import { clipCommand } from './scripts.ts'

const KIND_ORDER: Record<DependencyKind, number> = { prod: 0, dev: 1, peer: 2, optional: 3, indirect: 4 }

/** Real ranges, git URLs and tarball URLs (without their query) are far shorter. */
const MAX_RANGE_LENGTH = 500

export function dependencyKind(ref: Pick<DependencyRef, 'type' | 'indirect'>): DependencyKind {
  switch (ref.type) {
    case 'devDependencies':
      return 'dev'
    case 'peerDependencies':
      return 'peer'
    case 'optionalDependencies':
      return 'optional'
    case 'go':
      return ref.indirect ? 'indirect' : 'prod'
    default:
      return 'prod'
  }
}

/**
 * Ranges can embed credentials (git+https://user:token@host/repo.git,
 * https://host/pkg.tgz?token=…). Redact them and drop URL query strings; the
 * fragment is kept because it holds the commit-ish or semver range. The query
 * goes first so a long signed URL keeps its readable part, and the rest is
 * clipped because redactCommand is superlinear on long unbroken input.
 */
export function redactRange(range: string): string {
  let value = range.trim()
  if (value.includes('://')) value = value.replace(/\?[^\s#]*/g, '')
  return redactCommand(clipCommand(value, MAX_RANGE_LENGTH))
}

export function compareDependencies(a: DependencyEntry, b: DependencyEntry): number {
  const byKind = KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
  if (byKind !== 0) return byKind
  return compareText(a.name, b.name)
}

export function toEntries(refs: readonly DependencyRef[]): DependencyEntry[] {
  return refs
    .map((ref) => ({ name: ref.name, version: redactRange(ref.range), kind: dependencyKind(ref) }))
    .sort(compareDependencies)
}

/** Root first, then by path; a directory holding both package.json and go.mod lists node first. */
export function comparePackageDependencies(a: PackageDependencies, b: PackageDependencies): number {
  if (a.path !== b.path) {
    if (a.path === '.') return -1
    if (b.path === '.') return 1
    return compareText(a.path, b.path)
  }
  if (a.ecosystem !== b.ecosystem) return a.ecosystem === 'node' ? -1 : 1
  return 0
}

/** Unique dependency names across packages, not counting Go `// indirect` requirements. */
export function countUnique(packages: readonly PackageDependencies[]): number {
  const names = new Set<string>()
  for (const pkg of packages) {
    for (const dep of pkg.dependencies) if (dep.kind !== 'indirect') names.add(dep.name)
  }
  return names.size
}

export const dependenciesDetector: Detector<'dependencies'> = {
  id: 'dependencies',
  title: 'Dependencies',
  async run(ctx) {
    const [project, index] = await Promise.all([ctx.use(manifests), ctx.use(dependencies)])
    const packages: PackageDependencies[] = []
    const add = (path: string, name: string, ecosystem: 'node' | 'go') => {
      const refs = index.inPackage(path).filter((ref) => ref.ecosystem === ecosystem)
      if (refs.length > 0) packages.push({ path, name, ecosystem, dependencies: toEntries(refs) })
    }
    for (const manifest of project.packages) add(manifest.dir, manifest.name ?? manifest.dir, 'node')
    // Deno packages without a package.json; with one, their imports are listed under it.
    const packageDirs = new Set(project.packages.map((manifest) => manifest.dir))
    for (const config of project.deno ?? []) {
      if (!packageDirs.has(config.dir)) add(config.dir, config.name ?? config.dir, 'node')
    }
    for (const mod of project.goModules) add(mod.dir, mod.module, 'go')
    packages.sort(comparePackageDependencies)
    return { packages, total: countUnique(packages) }
  },
}
