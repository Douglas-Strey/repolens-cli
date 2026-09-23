import { useOr } from '../core/context.ts'
import { getString, isRecord } from '../core/parse.ts'
import { manifests, type ProjectManifests } from '../facts/manifests.ts'
import type { Detector, PackageManagerId, ProjectContext, WorkspacePackage, WorkspaceTool } from '../types.ts'
import { compareText } from '../utils/compare.ts'
import { mapLimit } from '../utils/limit.ts'
import { dirOf, joinPath } from '../utils/paths.ts'
import { packageManagersDetector } from './package-managers.ts'

const READ_CONCURRENCY = 16

/** Tools configured by a single root file, in output order. */
const FILE_TOOLS: ReadonlyArray<{ id: string; name: string; files: readonly string[] }> = [
  { id: 'turbo', name: 'Turborepo', files: ['turbo.json', 'turbo.jsonc'] },
  { id: 'nx', name: 'Nx', files: ['nx.json'] },
  { id: 'lerna', name: 'Lerna', files: ['lerna.json'] },
  { id: 'go-work', name: 'Go workspace', files: ['go.work'] },
]

/**
 * The tool behind package.json `workspaces`, which npm, Yarn and Bun all read.
 * pnpm ignores the field, so a pnpm project falls back to the npm meaning.
 */
export function packageJsonWorkspaceTool(primary: PackageManagerId | null | undefined): WorkspaceTool {
  switch (primary) {
    case 'yarn':
      return { id: 'yarn', name: 'Yarn workspaces', configFile: 'package.json' }
    case 'bun':
      return { id: 'bun', name: 'Bun workspaces', configFile: 'package.json' }
    default:
      return { id: 'npm', name: 'npm workspaces', configFile: 'package.json' }
  }
}

/**
 * Whether a parsed pnpm-workspace.yaml sets up a workspace. pnpm 10 also keeps
 * settings (onlyBuiltDependencies, overrides, catalogs) there in single-package
 * repositories, so only a `packages` list counts. A file that could not be
 * parsed (`null`) is given the benefit of the doubt.
 */
export function declaresPnpmPackages(doc: unknown): boolean {
  return doc === null || (isRecord(doc) && Object.hasOwn(doc, 'packages'))
}

/** go.work `use` directories, normalized ("./api" → "api", "./" → "."). */
export function goWorkUses(project: ProjectManifests): string[] {
  const declaration = project.workspaces.find((w) => w.source === 'go.work')
  return (declaration?.patterns ?? []).map((use) => joinPath(use))
}

/** Workspace members: package.json files matched by the workspace patterns and go.mod files listed in go.work. */
export function manifestPackages(project: ProjectManifests): WorkspacePackage[] {
  const packages: WorkspacePackage[] = []
  for (const manifest of project.packages) {
    if (manifest.role !== 'workspace') continue
    const pkg: WorkspacePackage = { name: manifest.name ?? manifest.dir, path: manifest.dir, ecosystem: 'node' }
    if (manifest.version) pkg.version = manifest.version
    if (manifest.private !== undefined) pkg.private = manifest.private
    packages.push(pkg)
  }
  const uses = new Set(goWorkUses(project))
  for (const mod of project.goModules) {
    // The root module is a member too when go.work says `use .`.
    if (uses.has(mod.dir)) {
      packages.push({ name: mod.module, path: mod.dir, ecosystem: 'go' })
    }
  }
  return packages
}

/** A parsed Nx project.json, or null when it does not look like one. */
export function nxProjectFrom(raw: unknown, file: string): WorkspacePackage | null {
  if (!isRecord(raw)) return null
  const looksLikeNx = ['name', 'targets', 'projectType', 'sourceRoot', '$schema'].some((key) => key in raw)
  if (!looksLikeNx) return null
  const path = dirOf(file)
  return { name: getString(raw, 'name') ?? path, path, ecosystem: 'node' }
}

export function comparePackages(a: WorkspacePackage, b: WorkspacePackage): number {
  if (a.path !== b.path) return compareText(a.path, b.path)
  if (a.ecosystem !== b.ecosystem) return a.ecosystem === 'node' ? -1 : 1
  return compareText(a.name, b.name)
}

async function nxProjects(ctx: ProjectContext): Promise<WorkspacePackage[]> {
  const files = ctx.files.byName('project.json').filter((file) => file !== 'project.json')
  const found = await mapLimit(files, READ_CONCURRENCY, async (file) => nxProjectFrom(await ctx.readJson(file), file))
  return found.filter((pkg): pkg is WorkspacePackage => pkg !== null)
}

export const workspaceDetector: Detector<'workspace'> = {
  id: 'workspace',
  title: 'Workspace',
  async run(ctx) {
    const project = await ctx.use(manifests)

    const tools: WorkspaceTool[] = []
    if (ctx.files.has('pnpm-workspace.yaml') && declaresPnpmPackages(await ctx.readYaml('pnpm-workspace.yaml'))) {
      tools.push({ id: 'pnpm', name: 'pnpm workspaces', configFile: 'pnpm-workspace.yaml' })
    }
    if (project.root && project.root.workspaces.length > 0) {
      const { primary } = await useOr(ctx, packageManagersDetector, { primary: null, detected: [] })
      tools.push(packageJsonWorkspaceTool(primary?.id))
    }
    for (const tool of FILE_TOOLS) {
      const configFile = tool.files.find((file) => ctx.files.has(file))
      if (configFile) tools.push({ id: tool.id, name: tool.name, configFile })
    }
    // Parse turbo.json now: a syntax error is then a known parse warning before doctor
    // checks run, so TURBO_PIPELINE_KEY is skipped instead of passing on a file it can't read.
    const turbo = tools.find((tool) => tool.id === 'turbo')
    if (turbo) await ctx.readJsonc(turbo.configFile)
    if (tools.length === 0) return null

    const uses = goWorkUses(project)
    const patterns = [...new Set([...project.effectivePatterns, ...uses])]

    const packages = manifestPackages(project)
    if (tools.some((tool) => tool.id === 'nx')) {
      const listed = new Set(packages.map((pkg) => pkg.path))
      for (const pkg of await nxProjects(ctx)) {
        if (!listed.has(pkg.path)) packages.push(pkg)
      }
    }
    packages.sort(comparePackages)

    return { tools, patterns, packages }
  },
}
