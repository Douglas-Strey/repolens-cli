import { getString, isRecord } from '../../core/parse.ts'
import { gitLayout } from '../../facts/git.ts'
import { manifests, type PackageManifest } from '../../facts/manifests.ts'
import type { Diagnostic, DoctorRule, FileIndex, ProjectContext, Sections } from '../../types.ts'
import { installCommand, shellQuote } from '../../utils/commands.ts'
import { compareText } from '../../utils/compare.ts'
import { formatList, hasRootPackageJson } from './shared.ts'

export type JsPackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

/** Root lockfile names and the package manager that writes them. */
export const JS_LOCKFILES: Readonly<Record<string, JsPackageManager>> = {
  'bun.lock': 'bun',
  'bun.lockb': 'bun',
  'npm-shrinkwrap.json': 'npm',
  'package-lock.json': 'npm',
  'pnpm-lock.yaml': 'pnpm',
  'yarn.lock': 'yarn',
}

/** Lockfile each package manager creates today. */
export const LOCKFILE_FOR: Readonly<Record<JsPackageManager, string>> = {
  npm: 'package-lock.json',
  pnpm: 'pnpm-lock.yaml',
  yarn: 'yarn.lock',
  bun: 'bun.lock',
}

const DISPLAY_NAME: Readonly<Record<JsPackageManager, string>> = { npm: 'npm', pnpm: 'pnpm', yarn: 'Yarn', bun: 'Bun' }

/** Lockfiles of other ecosystems that also mean "dependencies are locked" (Deno reads package.json too). */
const OTHER_LOCKFILES = ['deno.lock']

export function isJsPackageManager(id: string): id is JsPackageManager {
  return id === 'npm' || id === 'pnpm' || id === 'yarn' || id === 'bun'
}

/** Root lockfiles that are part of the repository (not ignored), grouped by package manager in a stable order. */
export function rootLockfiles(files: FileIndex): Map<JsPackageManager, string[]> {
  const found = new Map<JsPackageManager, string[]>()
  for (const [file, manager] of Object.entries(JS_LOCKFILES)) {
    if (!files.has(file)) continue
    const list = found.get(manager)
    if (list) list.push(file)
    else found.set(manager, [file])
  }
  return new Map([...found].sort(([a], [b]) => compareText(a, b)))
}

export interface DeclaredPackageManager {
  id: string
  field: 'packageManager' | 'devEngines'
}

/** Package manager declared by the `packageManager` field or `devEngines.packageManager`. */
export function declaredPackageManager(raw: Record<string, unknown>): DeclaredPackageManager | null {
  const packageManager = getString(raw, 'packageManager')
  const match = packageManager ? /^([a-z][a-z0-9-]*)(?:@|$)/i.exec(packageManager.trim()) : null
  if (match?.[1]) return { id: match[1].toLowerCase(), field: 'packageManager' }
  const devEngines = raw.devEngines
  if (isRecord(devEngines)) {
    const entry = devEngines.packageManager
    for (const item of Array.isArray(entry) ? entry : [entry]) {
      const name = getString(item, 'name')?.trim()
      if (name) return { id: name.toLowerCase(), field: 'devEngines' }
    }
  }
  return null
}

/** Volta can pin npm, pnpm or Yarn next to Node; that is a declaration too. */
function voltaPinsPackageManager(raw: Record<string, unknown>): boolean {
  const volta = raw.volta
  return isRecord(volta) && ['npm', 'pnpm', 'yarn'].some((key) => typeof volta[key] === 'string')
}

function flatten(locks: Map<JsPackageManager, string[]>): string[] {
  return [...locks.values()].flat()
}

export function findMultipleLockfiles(
  locks: Map<JsPackageManager, string[]>,
  declared: DeclaredPackageManager | null,
): Diagnostic[] {
  if (locks.size < 2) return []
  const managers = [...locks.keys()]
  const all = flatten(locks)
  let hint: string
  if (declared && isJsPackageManager(declared.id)) {
    const keep = locks.get(declared.id) ?? []
    const remove = all.filter((file) => !keep.includes(file))
    hint =
      keep.length > 0
        ? `Delete ${formatList(remove)} and keep ${formatList(keep)}, since package.json declares ${declared.id}`
        : `Delete ${formatList(remove)} and run \`${installCommand(declared.id)}\`, since package.json declares ${declared.id}`
  } else {
    hint = `Keep the lockfile of the package manager the team uses, delete the ${managers.length > 2 ? 'others' : 'other one'}, and declare it with a "packageManager" field`
  }
  return [
    {
      code: 'MULTIPLE_LOCKFILES',
      severity: 'warning',
      category: 'package-manager',
      message: `Found lockfiles for ${formatList(managers.map((m) => DISPLAY_NAME[m]))}: ${formatList(all)}`,
      hint,
      files: all,
      subject: 'lockfiles',
    },
  ]
}

export function findPackageManagerMismatch(
  locks: Map<JsPackageManager, string[]>,
  declared: DeclaredPackageManager | null,
  lockfileExists: (file: string) => boolean,
): Diagnostic[] {
  if (!declared || !isJsPackageManager(declared.id) || locks.has(declared.id)) return []
  const id = declared.id
  // The declared manager's lockfile may exist but be ignored by Git; that is not a mismatch.
  const ownLockfiles = Object.entries(JS_LOCKFILES).filter(([, manager]) => manager === id)
  if (ownLockfiles.some(([file]) => lockfileExists(file))) return []
  const others = flatten(locks)
  if (others.length === 0) return []
  const otherManagers = [...locks.keys()].map((m) => DISPLAY_NAME[m])
  // pnpm import reads npm and Yarn lockfiles, not Bun's.
  const importable = id === 'pnpm' && !locks.has('bun')
  const create = importable
    ? `Run \`pnpm import\` to convert ${formatList(others)} into pnpm-lock.yaml`
    : `Run \`${installCommand(id)}\``
  return [
    {
      code: 'PACKAGE_MANAGER_MISMATCH',
      severity: 'warning',
      category: 'package-manager',
      message: `package.json declares ${id} in "${declared.field}", but ${formatList(others)} ${others.length === 1 ? 'is the only lockfile' : 'are the only lockfiles'}`,
      hint: `${create} and delete ${formatList(others)}, or change "${declared.field}" if the project uses ${formatList(otherManagers)}`,
      files: ['package.json', ...others],
      subject: id,
    },
  ]
}

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/

/**
 * Version of `manager` the repository itself reveals: an exact
 * `engines.<manager>` or, for Yarn, the release file named by `yarnPath` in
 * .yarnrc.yml (".yarn/releases/yarn-4.5.0.cjs").
 */
export function knownManagerVersion(
  raw: Record<string, unknown>,
  manager: JsPackageManager,
  yarnPath?: string,
): string | undefined {
  const engine = isRecord(raw.engines) ? getString(raw.engines, manager)?.trim() : undefined
  if (engine && EXACT_VERSION.test(engine)) return engine
  if (manager !== 'yarn' || !yarnPath) return undefined
  const release = /(?:^|\/)yarn-([^/]+?)\.c?js$/.exec(yarnPath.trim())?.[1]
  return release && EXACT_VERSION.test(release) ? release : undefined
}

/**
 * Command that records the package manager in package.json. Node.js 25+ no
 * longer bundles Corepack, so the hint does not depend on it: `npm pkg set`
 * works everywhere npm does, and `$(pnpm --version)` fills in the version the
 * developer already uses when the repository does not reveal one.
 */
export function declareCommand(manager: JsPackageManager, version?: string): string {
  if (version) return `npm pkg set ${shellQuote(`packageManager=${manager}@${version}`)}`
  return `npm pkg set packageManager=${manager}@$(${manager} --version)`
}

/** `version` is the package manager version the repository reveals, when it does (see knownManagerVersion). */
export function findUndeclaredPackageManager(
  raw: Record<string, unknown>,
  locks: Map<JsPackageManager, string[]>,
  declaredElsewhere: boolean,
  version?: string,
): Diagnostic[] {
  if (locks.size === 0 || declaredElsewhere || declaredPackageManager(raw) || voltaPinsPackageManager(raw)) return []
  const all = flatten(locks)
  const managers = [...locks.keys()]
  const only = managers.length === 1 ? managers[0] : undefined
  let hint = 'Add a "packageManager" field to package.json naming the package manager and version the team uses'
  if (only) {
    hint = `Run \`${declareCommand(only, version)}\` to record it in package.json${only === 'bun' ? '' : ' (Corepack, if you use it, then runs that version)'}`
  }
  return [
    {
      code: 'PACKAGE_MANAGER_UNDECLARED',
      severity: 'info',
      category: 'package-manager',
      message: `package.json does not declare which package manager to use (found ${formatList(all)})`,
      hint,
      files: ['package.json', ...all],
      subject: 'package.json',
    },
  ]
}

function declaresDependencies(manifest: PackageManifest): boolean {
  return Object.keys(manifest.dependencies).length > 0 || Object.keys(manifest.devDependencies).length > 0
}

/** `package-lock=false` (npm) or `lockfile=false` (pnpm) in .npmrc: lockfiles are off on purpose. */
export function npmrcDisablesLockfile(npmrc: string): boolean {
  // Line by line with [ \t]: a multiline /^\s*…$/m regex backtracks quadratically on blank lines.
  return npmrc.split(/\r?\n/).some((line) => /^[ \t]*(?:package-lock|lockfile)[ \t]*=[ \t]*false[ \t]*$/.test(line))
}

export interface LockfileState {
  /** Any lockfile exists at the root, including ones ignored by Git. */
  anyLockfile: boolean
  /** A lockfile name is matched by .gitignore or lockfiles are disabled in .npmrc: not committing one is deliberate. */
  deliberatelyUnlocked: boolean
}

export function findLockfileMissing(
  packages: readonly PackageManifest[],
  state: LockfileState,
  manager: JsPackageManager,
): Diagnostic[] {
  const root = packages.find((p) => p.role === 'root')
  if (!root || state.anyLockfile || state.deliberatelyUnlocked) return []
  if (!packages.some((p) => (p.role === 'root' || p.role === 'workspace') && declaresDependencies(p))) return []
  const lockfile = LOCKFILE_FOR[manager]
  return [
    {
      code: 'LOCKFILE_MISSING',
      severity: 'info',
      category: 'package-manager',
      message: 'package.json declares dependencies but there is no lockfile',
      hint: `Run \`${installCommand(manager)}\` and commit ${lockfile} so installs are reproducible`,
      files: ['package.json'],
      subject: 'package.json',
    },
  ]
}

function sectionsDeclareJsManager(scan: Sections): boolean {
  return scan.packageManagers.detected.some((pm) => pm.declared && isJsPackageManager(pm.id))
}

/** A parsable root package.json and at least one root lockfile: the inputs of the lockfile checks. */
function hasPackageJsonAndLockfile(_scan: Sections, ctx: ProjectContext): boolean {
  return hasRootPackageJson(ctx) && rootLockfiles(ctx.files).size > 0
}

export const multipleLockfiles: DoctorRule = {
  code: 'MULTIPLE_LOCKFILES',
  category: 'package-manager',
  title: 'Only one package manager lockfile is committed',
  applies: (_scan, ctx) => ctx.files.has('package.json') && rootLockfiles(ctx.files).size > 0,
  async check(_scan, ctx) {
    const project = await ctx.use(manifests)
    return findMultipleLockfiles(
      rootLockfiles(ctx.files),
      project.root ? declaredPackageManager(project.root.raw) : null,
    )
  },
}

export const packageManagerMismatch: DoctorRule = {
  code: 'PACKAGE_MANAGER_MISMATCH',
  category: 'package-manager',
  title: 'The lockfile matches the declared package manager',
  applies: hasPackageJsonAndLockfile,
  async check(_scan, ctx) {
    const project = await ctx.use(manifests)
    if (!project.root) return []
    return findPackageManagerMismatch(rootLockfiles(ctx.files), declaredPackageManager(project.root.raw), (file) =>
      ctx.files.has(file, { includeIgnored: true }),
    )
  },
}

export const packageManagerUndeclared: DoctorRule = {
  code: 'PACKAGE_MANAGER_UNDECLARED',
  category: 'package-manager',
  title: 'The package manager is declared',
  applies: hasPackageJsonAndLockfile,
  async check(scan, ctx) {
    const project = await ctx.use(manifests)
    if (!project.root) return []
    const locks = rootLockfiles(ctx.files)
    const only = locks.size === 1 ? [...locks.keys()][0] : undefined
    let version: string | undefined
    if (only) {
      const yarnrc = only === 'yarn' && ctx.files.has('.yarnrc.yml') ? await ctx.readYaml('.yarnrc.yml') : null
      version = knownManagerVersion(project.root.raw, only, getString(yarnrc, 'yarnPath'))
    }
    return findUndeclaredPackageManager(project.root.raw, locks, sectionsDeclareJsManager(scan), version)
  },
}

export const lockfileMissing: DoctorRule = {
  code: 'LOCKFILE_MISSING',
  category: 'package-manager',
  title: 'Dependencies are locked',
  applies: (_scan, ctx) => hasRootPackageJson(ctx),
  async check(scan, ctx) {
    const project = await ctx.use(manifests)
    if (!project.root) return []
    // In a subdirectory of a repository (e.g. one package of a monorepo) the lockfile usually lives above the root.
    const layout = await ctx.use(gitLayout)
    if (layout && layout.prefix !== '') return []
    const names = [...Object.keys(JS_LOCKFILES), ...OTHER_LOCKFILES]
    const anyLockfile = names.some((name) => ctx.files.has(name, { includeIgnored: true }))
    let deliberatelyUnlocked = names.some((name) => ctx.files.isIgnored(name))
    if (!anyLockfile && !deliberatelyUnlocked && ctx.files.has('.npmrc', { includeIgnored: true })) {
      // Only a boolean is derived from .npmrc; it may hold auth tokens, so it is neither cached nor kept.
      const npmrc = await ctx.readText('.npmrc', { cache: false })
      deliberatelyUnlocked = npmrc !== null && npmrcDisablesLockfile(npmrc)
    }
    const candidates = [declaredPackageManager(project.root.raw)?.id, scan.packageManagers.primary?.id]
    const manager = candidates.find((id): id is JsPackageManager => id !== undefined && isJsPackageManager(id)) ?? 'npm'
    return findLockfileMissing(project.packages, { anyLockfile, deliberatelyUnlocked }, manager)
  },
}

export const packageManagerRules: DoctorRule[] = [
  multipleLockfiles,
  packageManagerMismatch,
  packageManagerUndeclared,
  lockfileMissing,
]
