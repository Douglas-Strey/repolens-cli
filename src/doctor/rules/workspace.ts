import { isRecord } from '../../core/parse.ts'
import { ALWAYS_IGNORED_DIRS } from '../../core/walker.ts'
import { dependencies } from '../../facts/dependencies.ts'
import { manifests, type ProjectManifests, type WorkspaceDeclaration } from '../../facts/manifests.ts'
import type { Diagnostic, DoctorRule, FileIndex, ProjectContext, Sections } from '../../types.ts'
import { matchGlob } from '../../utils/glob.ts'
import { dirOf } from '../../utils/paths.ts'
import { majorOf } from '../../utils/versions.ts'
import { declaredPackageManager, isJsPackageManager, rootLockfiles } from './package-manager.ts'
import { hasRootPackageJson, parseFailed, safeText, uniqueSorted } from './shared.ts'

const JS_DECLARATION_SOURCES: ReadonlySet<string> = new Set(['pnpm-workspace.yaml', 'package.json', 'lerna.json'])

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a)
  const right = new Set(b)
  return left.size === right.size && [...left].every((item) => right.has(item))
}

/** `manager` is the package manager the project declares or locks with, if known. */
export function findDuplicateWorkspaceConfig(
  workspaces: readonly WorkspaceDeclaration[],
  manager: string | undefined,
): Diagnostic[] {
  const pnpm = workspaces.find((w) => w.source === 'pnpm-workspace.yaml')
  const pkg = workspaces.find((w) => w.source === 'package.json')
  if (!pnpm || !pkg) return []
  const otherManager = manager && manager !== 'pnpm' && isJsPackageManager(manager) ? manager : undefined
  const diagnostic = (message: string, hint: string): Diagnostic[] => [
    {
      code: 'WORKSPACE_DUPLICATE_CONFIG',
      severity: 'warning',
      category: 'workspace',
      message,
      hint,
      files: ['package.json', 'pnpm-workspace.yaml'],
      subject: 'workspaces',
    },
  ]
  if (pnpm.patterns.length === 0) {
    // pnpm-workspace.yaml may only hold settings or catalogs; that matters only when pnpm installs.
    if (otherManager) return []
    return diagnostic(
      'package.json declares workspaces, but pnpm-workspace.yaml lists no packages and pnpm only reads pnpm-workspace.yaml',
      'Move the "workspaces" patterns into a "packages" list in pnpm-workspace.yaml',
    )
  }
  const differ = !sameSet(pnpm.patterns, pkg.patterns)
  return diagnostic(
    `Workspaces are declared in both pnpm-workspace.yaml and package.json${differ ? ' with different patterns' : ''}, but pnpm only reads pnpm-workspace.yaml`,
    otherManager
      ? `${otherManager} reads "workspaces" from package.json, so remove the packages list from pnpm-workspace.yaml`
      : 'Remove "workspaces" from package.json and keep the patterns in pnpm-workspace.yaml',
  )
}

/** Leading path segments of a glob that contain no wildcard, e.g. "tools" for "tools/*". */
function staticPrefix(pattern: string): string {
  const segments: string[] = []
  for (const segment of pattern.replace(/^\.\//, '').split('/')) {
    if (/[*?{[]/.test(segment)) break
    segments.push(segment)
  }
  return segments.join('/')
}

/**
 * Effective workspace patterns that match no package directory.
 * `packageDirs` are directories holding a package.json; `isIgnoredDir`
 * reports directories RepoLens never walked (their packages are unknown).
 */
export function findEmptyWorkspacePatterns(
  project: Pick<ProjectManifests, 'effectivePatterns' | 'workspaces'>,
  packageDirs: readonly string[],
  isIgnoredDir: (dir: string) => boolean = () => false,
): Diagnostic[] {
  const patterns = project.effectivePatterns
  if (patterns.length === 0) return []
  const declaration =
    project.workspaces.find((w) => w.patterns === patterns) ??
    project.workspaces.find((w) => JS_DECLARATION_SOURCES.has(w.source) && sameSet(w.patterns, patterns))
  const file = declaration?.file ?? 'package.json'
  const out: Diagnostic[] = []
  for (const raw of uniqueSorted(patterns)) {
    const pattern = raw.trim()
    if (pattern === '' || pattern.startsWith('!')) continue
    if (packageDirs.some((dir) => matchGlob(pattern, dir))) continue
    const prefix = staticPrefix(pattern)
    if (prefix !== '' && isIgnoredDir(prefix)) continue
    const shown = safeText(pattern, 80)
    out.push({
      code: 'WORKSPACE_PATTERN_EMPTY',
      severity: 'warning',
      category: 'workspace',
      message: `Workspace pattern "${shown}" in ${file} matches no package`,
      hint: `Remove "${shown}" from ${file}, or add a package.json in a matching directory`,
      files: [file],
      subject: shown,
    })
  }
  return out
}

export interface TurboConfig {
  file: string
  hasPipeline: boolean
}

/** turbo.json / turbo.jsonc at the root and in package directories. */
export function turboConfigPaths(files: FileIndex, packageDirs: readonly string[]): string[] {
  const dirs = new Set(['.', ...packageDirs])
  return uniqueSorted([...files.byName('turbo.json'), ...files.byName('turbo.jsonc')].filter((f) => dirs.has(dirOf(f))))
}

export async function loadTurboConfigs(ctx: ProjectContext): Promise<TurboConfig[]> {
  const project = await ctx.use(manifests)
  const paths = turboConfigPaths(
    ctx.files,
    project.packages.map((p) => p.dir),
  )
  const configs = await Promise.all(
    paths.map(async (file) => {
      const doc = await ctx.readJsonc(file)
      return { file, hasPipeline: isRecord(doc) && Object.hasOwn(doc, 'pipeline') }
    }),
  )
  return configs
}

/** `turboMajor` is the declared turbo major version, or null when unknown. */
export function findTurboPipeline(configs: readonly TurboConfig[], turboMajor: number | null): Diagnostic[] {
  if (turboMajor !== null && turboMajor < 2) return []
  return configs
    .filter((config) => config.hasPipeline)
    .map(
      (config): Diagnostic => ({
        code: 'TURBO_PIPELINE_KEY',
        severity: turboMajor === null ? 'info' : 'warning',
        category: 'workspace',
        message:
          turboMajor === null
            ? `${config.file} uses "pipeline", which Turborepo 2 and newer reject in favor of "tasks"`
            : `${config.file} uses "pipeline", which Turborepo ${turboMajor} renamed to "tasks"`,
        hint: 'Rename "pipeline" to "tasks" (`npx @turbo/codemod migrate` upgrades the whole configuration)',
        files: [config.file],
        subject: config.file,
      }),
    )
}

/** Package manager the project uses: declared in package.json, or the only one with a root lockfile. */
async function projectManager(ctx: ProjectContext): Promise<string | undefined> {
  const project = await ctx.use(manifests)
  const declared = project.root ? declaredPackageManager(project.root.raw)?.id : undefined
  if (declared) return declared
  const locks = [...rootLockfiles(ctx.files).keys()]
  return locks.length === 1 ? locks[0] : undefined
}

/**
 * The workspace section is null for single-package projects, and also when
 * its detector failed; the manifests fact is authoritative either way.
 */
function mayBeWorkspace(scan: Sections): boolean {
  return scan.workspace !== null || scan.project.manifests.length === 0 || scan.project.type === 'monorepo'
}

/** Files that declare JavaScript workspaces; a check reading one that failed to parse has no input. */
const DECLARATION_FILES = ['pnpm-workspace.yaml', 'package.json', 'lerna.json']

export const workspaceDuplicateConfig: DoctorRule = {
  code: 'WORKSPACE_DUPLICATE_CONFIG',
  category: 'workspace',
  title: 'Workspaces are declared in one place',
  // Both declarations must exist and parse for them to disagree.
  applies: (_scan, ctx) =>
    ctx.files.has('pnpm-workspace.yaml') && hasRootPackageJson(ctx) && !parseFailed(ctx, 'pnpm-workspace.yaml'),
  async check(_scan, ctx) {
    const project = await ctx.use(manifests)
    return findDuplicateWorkspaceConfig(project.workspaces, await projectManager(ctx))
  },
}

export const workspacePatternEmpty: DoctorRule = {
  code: 'WORKSPACE_PATTERN_EMPTY',
  category: 'workspace',
  title: 'Every workspace pattern matches a package',
  applies: (scan, ctx) =>
    DECLARATION_FILES.some((file) => ctx.files.has(file)) &&
    !parseFailed(ctx, ...DECLARATION_FILES) &&
    mayBeWorkspace(scan),
  async check(_scan, ctx) {
    if (ctx.files.truncated) return []
    const project = await ctx.use(manifests)
    const packageDirs = uniqueSorted([
      ...project.packages.map((p) => p.dir),
      ...ctx.files.byName('package.json', { includeIgnored: true }).map(dirOf),
    ])
    // vendor/, node_modules/, … are never walked, so packages below them are unknown.
    const unwalked = (dir: string) =>
      dir.split('/').some((segment) => ALWAYS_IGNORED_DIRS.has(segment)) ||
      ctx.files.isIgnored(dir, { directory: true })
    return findEmptyWorkspacePatterns(project, packageDirs, unwalked)
  },
}

export const turboPipelineKey: DoctorRule = {
  code: 'TURBO_PIPELINE_KEY',
  category: 'workspace',
  title: 'turbo.json uses the current schema',
  // The workspace detector parses the root turbo.json, so a syntax error is known here.
  applies: (scan, ctx) =>
    (ctx.files.has('turbo.json') ||
      ctx.files.has('turbo.jsonc') ||
      scan.configFiles.some((file) => /(?:^|\/)turbo\.jsonc?$/.test(file.path))) &&
    !parseFailed(ctx, 'turbo.json', 'turbo.jsonc'),
  async check(_scan, ctx) {
    const configs = await loadTurboConfigs(ctx)
    if (!configs.some((config) => config.hasPipeline)) return []
    const deps = await ctx.use(dependencies)
    return findTurboPipeline(configs, majorOf(deps.version('turbo')))
  },
}

export const workspaceRules: DoctorRule[] = [workspaceDuplicateConfig, workspacePatternEmpty, turboPipelineKey]
