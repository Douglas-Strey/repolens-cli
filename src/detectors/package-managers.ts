import { getString, isRecord } from '../core/parse.ts'
import { type AncestorFiles, gitIndex, gitLayout } from '../facts/git.ts'
import { manifests } from '../facts/manifests.ts'
import type { Detector, FileIndex, PackageManagerInfo, ProjectContext } from '../types.ts'
import { compareText } from '../utils/compare.ts'
import { baseName, depthOf, dirOf, joinPath } from '../utils/paths.ts'
import { cleanUntrusted } from '../utils/text.ts'
import { majorOf } from '../utils/versions.ts'
import { githubStyleWorkflows } from './ci.ts'

export type JsPackageManagerId = 'npm' | 'pnpm' | 'yarn' | 'bun'

/** Output order of `detected` (Go modules always come last). */
export const JS_PACKAGE_MANAGERS: readonly JsPackageManagerId[] = ['npm', 'pnpm', 'yarn', 'bun']

const DISPLAY_NAMES: Record<JsPackageManagerId, string> = { npm: 'npm', pnpm: 'pnpm', yarn: 'Yarn', bun: 'Bun' }

/** Root-level lockfiles, in the order they are reported. */
export const LOCKFILES: ReadonlyArray<{ id: JsPackageManagerId; file: string }> = [
  { id: 'npm', file: 'package-lock.json' },
  { id: 'npm', file: 'npm-shrinkwrap.json' },
  { id: 'pnpm', file: 'pnpm-lock.yaml' },
  { id: 'yarn', file: 'yarn.lock' },
  { id: 'bun', file: 'bun.lock' },
  { id: 'bun', file: 'bun.lockb' },
]

/**
 * Root config files that belong to one package manager. Only pnpm-workspace.yaml
 * identifies the package manager by itself: .yarnrc.yml can outlive a
 * migration away from Yarn, and bunfig.toml also configures Bun's runtime and
 * test runner in projects installed with another tool.
 */
const CONFIG_FILES: ReadonlyArray<{ id: JsPackageManagerId; file: string; evidence: string; detects: boolean }> = [
  { id: 'pnpm', file: 'pnpm-workspace.yaml', evidence: 'workspace file pnpm-workspace.yaml', detects: true },
  { id: 'yarn', file: '.yarnrc.yml', evidence: 'config file .yarnrc.yml', detects: false },
  { id: 'bun', file: 'bunfig.toml', evidence: 'config file bunfig.toml', detects: false },
]

/** Which package manager wins when several have lockfiles (the conflict itself is a doctor finding). */
const PREFERENCE: readonly JsPackageManagerId[] = ['pnpm', 'yarn', 'bun', 'npm']

const MAX_GO_EVIDENCE = 5

export interface DeclaredPackageManager {
  id: JsPackageManagerId
  version?: string
}

export function isJsPackageManager(id: string): id is JsPackageManagerId {
  return (JS_PACKAGE_MANAGERS as readonly string[]).includes(id)
}

/**
 * Keep a declared version only when it looks like a version or semver range.
 * Corepack also accepts URLs, which could carry credentials, so anything else
 * is dropped rather than echoed.
 */
export function cleanDeclaredVersion(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const value = raw.trim().replace(/\s+/g, ' ')
  if (value === '' || value.length > 64) return undefined
  if (!/^[0-9A-Za-z.^~<>=*| -]+$/.test(value) || !/\d/.test(value)) return undefined
  return value
}

/** Parse the package.json `packageManager` field: "pnpm@10.17.1+sha512.abc" → { id: "pnpm", version: "10.17.1" }. */
export function parsePackageManagerField(value: string): DeclaredPackageManager | null {
  const trimmed = value.trim()
  const at = trimmed.indexOf('@')
  const name = (at === -1 ? trimmed : trimmed.slice(0, at)).toLowerCase()
  if (!isJsPackageManager(name)) return null
  // Corepack appends the integrity hash after "+".
  const version = at === -1 ? undefined : cleanDeclaredVersion(trimmed.slice(at + 1).split('+')[0])
  return version ? { id: name, version } : { id: name }
}

/** Parse `devEngines.packageManager`, which is one `{ name, version }` object or an array of them. */
export function parseDevEnginesPackageManager(devEngines: unknown): DeclaredPackageManager[] {
  if (!isRecord(devEngines)) return []
  const field = devEngines.packageManager
  const entries = Array.isArray(field) ? field : [field]
  const out: DeclaredPackageManager[] = []
  for (const entry of entries) {
    const name = getString(entry, 'name')?.trim().toLowerCase()
    if (!name || !isJsPackageManager(name)) continue
    const version = cleanDeclaredVersion(getString(entry, 'version'))
    out.push(version ? { id: name, version } : { id: name })
  }
  return out
}

export interface YarnFlavor {
  flavor: 'Berry' | 'Classic'
  reason: string
}

/**
 * Tell Yarn Berry (2+) from Yarn Classic (1.x). `lockText` is the content of
 * yarn.lock, `null` when it could not be read, or `undefined` when not read.
 * A declared version wins over the lockfile format: Corepack runs that version,
 * which migrates an old lockfile on the next install.
 */
export function yarnFlavor(input: {
  hasYarnrcYml: boolean
  lockText?: string | null
  declaredVersion?: string
}): YarnFlavor | null {
  if (input.hasYarnrcYml) return { flavor: 'Berry', reason: '.yarnrc.yml exists' }
  const major = majorOf(input.declaredVersion)
  if (major !== null) {
    return { flavor: major >= 2 ? 'Berry' : 'Classic', reason: `declared yarn@${input.declaredVersion}` }
  }
  const lock = input.lockText
  if (typeof lock !== 'string') return null
  if (/^__metadata:/m.test(lock)) return { flavor: 'Berry', reason: 'yarn.lock has a __metadata section' }
  if (/^# yarn lockfile v1/m.test(lock)) return { flavor: 'Classic', reason: 'yarn.lock uses the v1 format' }
  return { flavor: 'Classic', reason: 'yarn.lock has no __metadata section' }
}

/** Only read yarn.lock (often megabytes) when nothing cheaper tells the Yarn flavor. */
export function needsYarnLock(hasYarnrcYml: boolean, declaredVersion: string | undefined): boolean {
  return !hasYarnrcYml && majorOf(declaredVersion) === null
}

/**
 * Pick the package manager used to run scripts: the declared one, else the
 * only one with a lockfile (preferring pnpm > yarn > bun > npm when several
 * lockfiles disagree), else one identified by its config file.
 */
export function choosePrimary(input: {
  declared: readonly JsPackageManagerId[]
  withLockfile: readonly JsPackageManagerId[]
  withConfig: readonly JsPackageManagerId[]
}): JsPackageManagerId | null {
  if (input.declared[0]) return input.declared[0]
  for (const candidates of [input.withLockfile, input.withConfig]) {
    const found = PREFERENCE.find((id) => candidates.includes(id))
    if (found) return found
  }
  return null
}

// ---------------------------------------------------------------------------
// Hints when nothing at the scan root decides
// ---------------------------------------------------------------------------

export type DependencyProtocol = 'workspace' | 'catalog'

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const

/**
 * `workspace:` and `catalog:` versions in a package.json, as written (before
 * catalogs are resolved). npm understands neither: `workspace:` needs pnpm,
 * Yarn 2+ or Bun, `catalog:` needs pnpm, Bun or Yarn 4.
 */
export function dependencyProtocols(raw: Record<string, unknown>): DependencyProtocol[] {
  const found = new Set<DependencyProtocol>()
  for (const field of DEPENDENCY_FIELDS) {
    const deps = raw[field]
    if (!isRecord(deps)) continue
    for (const spec of Object.values(deps)) {
      if (typeof spec !== 'string') continue
      const value = spec.trimStart()
      if (value.startsWith('workspace:')) found.add('workspace')
      else if (value.startsWith('catalog:')) found.add('catalog')
    }
  }
  return (['workspace', 'catalog'] as const).filter((protocol) => found.has(protocol))
}

/** Lockfiles and pnpm-workspace.yaml in a directory above the scan root, and the package manager they mean. */
const ANCESTOR_MANAGER_FILES: ReadonlyArray<{ id: JsPackageManagerId; file: string }> = [
  { id: 'pnpm', file: 'pnpm-lock.yaml' },
  { id: 'pnpm', file: 'pnpm-workspace.yaml' },
  { id: 'yarn', file: 'yarn.lock' },
  { id: 'bun', file: 'bun.lock' },
  { id: 'bun', file: 'bun.lockb' },
  { id: 'npm', file: 'package-lock.json' },
  { id: 'npm', file: 'npm-shrinkwrap.json' },
]

export interface AncestorManager {
  id: JsPackageManagerId
  file: string
  /** Directory relative to the repository root ("" = the repository root). */
  dir: string
}

/**
 * The package manager of the nearest directory above the scan root that has
 * a lockfile (or pnpm-workspace.yaml), from the files Git tracks there. When
 * one directory has several, pnpm > yarn > bun > npm, as for the root.
 */
export function managerFromAncestors(
  ancestors: readonly Pick<AncestorFiles, 'dir' | 'files'>[],
): AncestorManager | null {
  for (const ancestor of ancestors) {
    const match = ANCESTOR_MANAGER_FILES.find(({ file }) => ancestor.files.includes(file))
    if (match) return { id: match.id, file: match.file, dir: ancestor.dir }
  }
  return null
}

/** Words after the package manager that install dependencies. */
const INSTALL_SUBCOMMANDS: Readonly<Record<JsPackageManagerId, ReadonlySet<string>>> = {
  npm: new Set(['ci', 'install', 'i', 'clean-install']),
  pnpm: new Set(['install', 'i']),
  yarn: new Set(['install']),
  bun: new Set(['install', 'i']),
}
/**
 * Hints that are not install commands but name the package manager as clearly
 * (setup-node `cache: pnpm`). `[ \t]` rather than `\s`: with the m flag, `^\s*`
 * restarts at every line of a long blank run.
 */
const SETUP_HINTS: ReadonlyArray<{ id: JsPackageManagerId; pattern: RegExp }> = [
  { id: 'pnpm', pattern: /\bpnpm\/action-setup\b/ },
  { id: 'npm', pattern: /^[ \t]*cache:[ \t]*["']?npm["']?[ \t]*$/m },
  { id: 'pnpm', pattern: /^[ \t]*cache:[ \t]*["']?pnpm["']?[ \t]*$/m },
  { id: 'yarn', pattern: /^[ \t]*cache:[ \t]*["']?yarn["']?[ \t]*$/m },
]
const MAX_INSTALL_LINE = 1000

/**
 * Package managers that a CI workflow or Dockerfile installs dependencies
 * with: `npm ci`, `pnpm install`, a bare `yarn`, `RUN bun install`, … A
 * global install of another tool (`npm install -g pnpm`) does not count.
 */
export function installCommandManagers(text: string): JsPackageManagerId[] {
  const found = new Set<JsPackageManagerId>()
  for (const line of text.split('\n')) {
    for (const command of line.slice(0, MAX_INSTALL_LINE).split(/&&|\|\||[;|]/)) {
      const words = command.trim().split(/\s+/)
      const at = words.findIndex((word) => isJsPackageManager(word.replace(/^["'`]+/, '')))
      if (at === -1) continue
      const id = (words[at] as string).replace(/^["'`]+/, '') as JsPackageManagerId
      const rest = words.slice(at + 1).map((word) => word.replace(/["'`]+$/, ''))
      if (rest.includes('-g') || rest.includes('--global')) continue
      const sub = rest[0]
      const bareYarn = id === 'yarn' && (sub === undefined || sub === '' || sub.startsWith('--'))
      if (bareYarn || (sub !== undefined && INSTALL_SUBCOMMANDS[id].has(sub))) found.add(id)
    }
  }
  for (const { id, pattern } of SETUP_HINTS) if (pattern.test(text)) found.add(id)
  return JS_PACKAGE_MANAGERS.filter((id) => found.has(id))
}

/** Dockerfile and Containerfile names, including variants such as Dockerfile.dev and api.dockerfile. */
const DOCKERFILE_NAME = /^(?:Dockerfile|Containerfile)(?:\..+)?$|\.(?:dockerfile|containerfile)$/i
/** Root-level CI files other than GitHub-style workflows. */
const OTHER_CI_FILES = [
  '.gitlab-ci.yml',
  '.circleci/config.yml',
  'azure-pipelines.yml',
  'bitbucket-pipelines.yml',
  '.travis.yml',
]
const MAX_INSTALL_FILES = 30

/** CI workflows and shallow Dockerfiles, which show how the project really installs. */
export function installFiles(files: FileIndex): string[] {
  const workflows = githubStyleWorkflows(files).map((workflow) => workflow.file)
  const others = OTHER_CI_FILES.filter((file) => files.has(file))
  const dockerfiles = files.files.filter((file) => depthOf(file) <= 2 && DOCKERFILE_NAME.test(baseName(file)))
  return [...workflows, ...others, ...dockerfiles].slice(0, MAX_INSTALL_FILES)
}

/** For each package manager, the first file that installs with it. */
async function installersIn(ctx: ProjectContext): Promise<Map<JsPackageManagerId, string>> {
  const files = installFiles(ctx.files)
  const texts = await Promise.all(files.map((file) => ctx.readText(file)))
  const out = new Map<JsPackageManagerId, string>()
  files.forEach((file, index) => {
    const text = texts[index]
    if (!text) return
    for (const id of installCommandManagers(text)) if (!out.has(id)) out.set(id, file)
  })
  return out
}

/**
 * Pick among several lockfiles: the only one CI or a Dockerfile installs
 * with, else pnpm > yarn > bun > npm, which is then only a guess.
 */
export function chooseAmongLockfiles(
  withLockfile: readonly JsPackageManagerId[],
  installers: ReadonlyMap<JsPackageManagerId, string>,
): { id: JsPackageManagerId; evidence: string; guessed: boolean } | null {
  const used = withLockfile.filter((id) => installers.has(id))
  if (used.length === 1) {
    const id = used[0] as JsPackageManagerId
    return {
      id,
      evidence: `picked among several lockfiles: ${installers.get(id)} installs with ${DISPLAY_NAMES[id]}`,
      guessed: false,
    }
  }
  const id = PREFERENCE.find((candidate) => withLockfile.includes(candidate))
  if (!id) return null
  return {
    id,
    evidence: `guessed among several lockfiles (pnpm > Yarn > Bun > npm); declare "packageManager" in package.json to make it explicit`,
    guessed: true,
  }
}

/**
 * Package manager for a package.json without a local lockfile or declaration.
 * `prefix` is the scan root's path inside the Git repository ("" at the
 * repository root, null outside Git).
 */
export function inferWithoutLockfile(input: {
  protocols: readonly DependencyProtocol[]
  ancestor: AncestorManager | null
  prefix: string | null
}): { id: JsPackageManagerId; evidence: string[]; guessed: boolean; installFrom?: string } {
  const below = input.prefix !== null && input.prefix !== ''
  const fromRoot = below ? 'install from the repository root' : ''
  const { ancestor, protocols } = input
  // npm cannot install workspace: or catalog: versions, whatever lockfile sits above.
  if (ancestor && !(ancestor.id === 'npm' && protocols.length > 0)) {
    if (ancestor.dir === '') {
      return {
        id: ancestor.id,
        evidence: [`${ancestor.file} at the repository root; install from the repository root`],
        guessed: false,
        installFrom: '',
      }
    }
    // A directory name from the Git index: printable text only.
    const dir = cleanUntrusted(ancestor.dir, { oneLine: true })
    return {
      id: ancestor.id,
      evidence: [`${ancestor.file} in ${dir}/ of the repository; install from ${dir}/`],
      guessed: false,
      installFrom: dir,
    }
  }
  if (protocols.length > 0) {
    const written = protocols.map((protocol) => `${protocol}:`).join(' and ')
    const which = protocols.includes('catalog') ? 'pnpm, Bun or Yarn 4' : 'pnpm, Yarn or Bun'
    return {
      id: 'pnpm',
      evidence: [
        `guessed: package.json uses ${written} versions, which npm cannot install (${which} can)${fromRoot ? `; ${fromRoot}` : ''}`,
      ],
      guessed: true,
      ...(below ? { installFrom: '' } : {}),
    }
  }
  if (below) {
    return {
      id: 'npm',
      evidence: [
        'guessed: package.json without a lockfile inside a larger repository; install from the repository root',
      ],
      guessed: true,
      installFrom: '',
    }
  }
  return { id: 'npm', evidence: ['package.json without a lockfile'], guessed: false }
}

function declaredEvidence(field: string, pm: DeclaredPackageManager): string {
  return `${field} in package.json (${pm.version ? `${pm.id}@${pm.version}` : pm.id})`
}

export const packageManagersDetector: Detector<'packageManagers'> = {
  id: 'packageManagers',
  title: 'Package managers',
  async run(ctx) {
    const project = await ctx.use(manifests)
    const infos = new Map<JsPackageManagerId, PackageManagerInfo>()
    const entry = (id: JsPackageManagerId): PackageManagerInfo => {
      let info = infos.get(id)
      if (!info) {
        info = { id, name: DISPLAY_NAMES[id], lockfiles: [], declared: false, evidence: [] }
        infos.set(id, info)
      }
      return info
    }

    // 1. Declarations in the root package.json.
    const declared: JsPackageManagerId[] = []
    const addDeclared = (pm: DeclaredPackageManager, field: string) => {
      const info = entry(pm.id)
      info.declared = true
      if (pm.version && info.version === undefined) info.version = pm.version
      info.evidence.push(declaredEvidence(field, pm))
      if (!declared.includes(pm.id)) declared.push(pm.id)
    }
    const root = project.root
    if (root?.packageManager) {
      const parsed = parsePackageManagerField(root.packageManager)
      if (parsed) addDeclared(parsed, 'packageManager field')
      else ctx.debug('package managers: unrecognized packageManager field in package.json')
    }
    if (root) {
      for (const pm of parseDevEnginesPackageManager(root.raw.devEngines)) {
        addDeclared(pm, 'devEngines.packageManager')
      }
    }

    // 2. Lockfiles and package-manager-specific config files.
    const withLockfile: JsPackageManagerId[] = []
    for (const { id, file } of LOCKFILES) {
      if (!ctx.files.has(file)) continue
      const info = entry(id)
      info.lockfiles.push(file)
      info.evidence.push(`lockfile ${file}`)
      if (!withLockfile.includes(id)) withLockfile.push(id)
    }
    const withConfig: JsPackageManagerId[] = []
    for (const { id, file, evidence, detects } of CONFIG_FILES) {
      if (!ctx.files.has(file)) continue
      if (detects) {
        withConfig.push(id)
        entry(id).evidence.push(evidence)
      } else {
        infos.get(id)?.evidence.push(evidence)
      }
    }

    const yarn = infos.get('yarn')
    if (yarn) {
      const hasYarnrcYml = ctx.files.has('.yarnrc.yml')
      const lockText =
        needsYarnLock(hasYarnrcYml, yarn.version) && ctx.files.has('yarn.lock')
          ? await ctx.readText('yarn.lock')
          : undefined
      const flavor = yarnFlavor({ hasYarnrcYml, lockText, declaredVersion: yarn.version })
      if (flavor) yarn.evidence.push(`Yarn ${flavor.flavor} (${flavor.reason})`)
    }

    // 3. Primary JS package manager.
    let primaryId: JsPackageManagerId | 'go' | null = choosePrimary({ declared, withLockfile, withConfig })
    if (declared.length === 0 && withLockfile.length > 1) {
      const choice = chooseAmongLockfiles(withLockfile, await installersIn(ctx))
      if (choice) {
        primaryId = choice.id
        const info = entry(choice.id)
        info.evidence.push(choice.evidence)
        if (choice.guessed) info.guessed = true
      }
    }
    if (!primaryId && ctx.files.has('package.json')) {
      const layout = await ctx.use(gitLayout)
      const index = layout && layout.prefix !== '' ? await ctx.use(gitIndex) : null
      const inferred = inferWithoutLockfile({
        protocols: root ? dependencyProtocols(root.raw) : [],
        ancestor: managerFromAncestors(index?.ancestors ?? []),
        prefix: layout ? layout.prefix : null,
      })
      const info = entry(inferred.id)
      info.evidence.push(...inferred.evidence)
      if (inferred.guessed) info.guessed = true
      if (inferred.installFrom !== undefined) info.installFrom = inferred.installFrom
      primaryId = inferred.id
    }

    // 4. Go modules.
    const goModFiles = new Set<string>()
    if (ctx.files.has('go.mod')) goModFiles.add('go.mod')
    for (const mod of project.goModules) goModFiles.add(mod.file)
    let go: PackageManagerInfo | null = null
    if (goModFiles.size > 0) {
      const files = [...goModFiles].filter((file) => file !== 'go.mod').sort(compareText)
      if (goModFiles.has('go.mod')) files.unshift('go.mod')
      const evidence = files.slice(0, MAX_GO_EVIDENCE).map((file) => `module file ${file}`)
      if (files.length > MAX_GO_EVIDENCE) evidence.push(`${files.length - MAX_GO_EVIDENCE} more go.mod files`)
      go = {
        id: 'go',
        name: 'Go modules',
        lockfiles: files.map((file) => joinPath(dirOf(file), 'go.sum')).filter((file) => ctx.files.has(file)),
        declared: true,
        evidence,
      }
      if (!primaryId) primaryId = 'go'
    }

    const detected: PackageManagerInfo[] = []
    for (const id of JS_PACKAGE_MANAGERS) {
      const info = infos.get(id)
      if (info) detected.push({ ...info, evidence: [...new Set(info.evidence)] })
    }
    if (go) detected.push(go)
    const primary = detected.find((info) => info.id === primaryId) ?? null
    return {
      primary: primary ? { ...primary, lockfiles: [...primary.lockfiles], evidence: [...primary.evidence] } : null,
      detected,
    }
  },
}
