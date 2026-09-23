import { isRecord } from '../../core/parse.ts'
import { gitLayout } from '../../facts/git.ts'
import type { DoctorRule, FileIndex, ProjectContext } from '../../types.ts'
import { formatList } from './shared.ts'

/** Yarn is the package manager: yarn.lock exists or no other lockfile does. */
function isYarnProject(files: FileIndex): boolean {
  if (files.has('yarn.lock', { includeIgnored: true })) return true
  return !['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb'].some((file) =>
    files.has(file, { includeIgnored: true }),
  )
}

/** When the scan root is a subdirectory of a repository, .gitignore files above it are not visible. */
async function scansSubdirectory(ctx: ProjectContext): Promise<boolean> {
  const layout = await ctx.use(gitLayout)
  return layout !== null && layout.prefix !== ''
}

/** The scan root is the top of a Git working tree. */
async function isRepositoryRoot(ctx: ProjectContext): Promise<boolean> {
  const layout = await ctx.use(gitLayout)
  return layout !== null && layout.prefix === ''
}

/** Entries worth suggesting for a new .gitignore, based on what exists in the project. */
export function suggestedIgnoreEntries(files: FileIndex): string[] {
  const entries: string[] = []
  if (files.has('package.json')) entries.push('node_modules/')
  for (const dir of ['dist', 'build', 'out']) {
    if (files.hasDirectory(dir)) entries.push(`${dir}/`)
  }
  if (files.files.some((file) => /^\.env(?:\.(?!example$|sample$|template$|dist$)[\w.-]+)?$/.test(file))) {
    entries.push('.env*', '!.env.example')
  }
  return entries
}

export const gitignoreMissing: DoctorRule = {
  code: 'GITIGNORE_MISSING',
  category: 'git',
  title: 'The repository has a .gitignore',
  // A subdirectory of a repository relies on the .gitignore files above it, which aren't read.
  applies: async (scan, ctx) => scan.git !== null && (await isRepositoryRoot(ctx)),
  async check(_scan, ctx) {
    if (ctx.files.has('.gitignore') || !(await isRepositoryRoot(ctx))) return []
    const entries = suggestedIgnoreEntries(ctx.files)
    return [
      {
        code: 'GITIGNORE_MISSING',
        severity: 'warning',
        category: 'git',
        message: 'The repository has no .gitignore file',
        hint:
          entries.length > 0
            ? `Create a .gitignore that ignores ${formatList(entries)}`
            : 'Create a .gitignore for dependencies, build output and local env files',
        subject: '.gitignore',
      },
    ]
  },
}

/** Files Yarn writes for Plug'n'Play installs, which create no node_modules. */
const PNP_FILES = ['.pnp.cjs', '.pnp.js', '.pnp.loader.mjs']

/** A Plug'n'Play loader exists (committed with zero-installs, or ignored but present). */
export function hasPnpLoader(files: FileIndex): boolean {
  return PNP_FILES.some((file) => files.has(file, { includeIgnored: true }))
}

/**
 * Yarn Berry installs with Plug'n'Play unless .yarnrc.yml sets another
 * `nodeLinker` ("node-modules" or "pnpm"). `yarnrc` is the parsed file.
 */
export function yarnrcUsesPnp(yarnrc: unknown): boolean {
  const linker = isRecord(yarnrc) ? yarnrc.nodeLinker : undefined
  return linker === undefined || linker === null || (typeof linker === 'string' && linker.trim() === 'pnp')
}

/**
 * Does .gitignore keep node_modules out? `node_modules/` ignores the directory
 * itself; rules that match only its contents (`node_modules/*`, or
 * `node_modules/**` with a leading double-star directory) ignore everything
 * inside it, which keeps the install out of Git just as well.
 */
export function ignoresNodeModules(files: FileIndex): boolean {
  return files.isIgnored('node_modules', { directory: true }) || files.isIgnored('node_modules/x')
}

export const gitignoreNodeModules: DoctorRule = {
  code: 'GITIGNORE_NODE_MODULES',
  category: 'git',
  title: 'node_modules is ignored by Git',
  // Without package.json or .gitignore there is nothing to check (GITIGNORE_MISSING covers the latter).
  applies: (_scan, ctx) => ctx.files.has('package.json') && ctx.files.has('.gitignore') && !hasPnpLoader(ctx.files),
  async check(_scan, ctx) {
    if (!ctx.files.has('package.json') || !ctx.files.has('.gitignore')) return []
    if (ignoresNodeModules(ctx.files) || (await scansSubdirectory(ctx))) return []
    // Yarn Plug'n'Play creates no node_modules directory to ignore.
    if (hasPnpLoader(ctx.files)) return []
    if (ctx.files.has('.yarnrc.yml', { includeIgnored: true }) && isYarnProject(ctx.files)) {
      if (yarnrcUsesPnp(await ctx.readYaml('.yarnrc.yml'))) return []
    }
    return [
      {
        code: 'GITIGNORE_NODE_MODULES',
        severity: 'warning',
        category: 'git',
        message: '.gitignore does not ignore node_modules',
        hint: 'Add node_modules/ to .gitignore',
        files: ['.gitignore'],
        subject: 'node_modules',
      },
    ]
  },
}

export const gitRules: DoctorRule[] = [gitignoreMissing, gitignoreNodeModules]
