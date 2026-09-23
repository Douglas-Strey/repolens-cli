import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  declareCommand,
  declaredPackageManager,
  findLockfileMissing,
  findMultipleLockfiles,
  findPackageManagerMismatch,
  findUndeclaredPackageManager,
  type JsPackageManager,
  knownManagerVersion,
  lockfileMissing,
  multipleLockfiles,
  packageManagerMismatch,
  packageManagerUndeclared,
  rootLockfiles,
} from '../../src/doctor/rules/package-manager.ts'
import type { PackageManifest } from '../../src/facts/manifests.ts'
import type { PackageManagerInfo } from '../../src/types.ts'
import { contextFor, gitInit, makeProject } from '../helpers.ts'
import { expectWellFormed, makeSections, projectContext, runCheck, runRule, SECRET_SENTINEL } from './support.ts'

const pkg = (fields: Record<string, unknown> = {}) => JSON.stringify({ name: 'app', ...fields })

/** Lockfiles grouped by package manager, as rootLockfiles() returns them. */
function locks(entries: Partial<Record<JsPackageManager, string[]>>): Map<JsPackageManager, string[]> {
  return new Map(Object.entries(entries) as Array<[JsPackageManager, string[]]>)
}

function manifest(overrides: Partial<PackageManifest> = {}): PackageManifest {
  return {
    dir: '.',
    file: 'package.json',
    role: 'root',
    scripts: {},
    dependencies: {},
    devDependencies: {},
    peerDependencies: {},
    optionalDependencies: {},
    engines: {},
    workspaces: [],
    hasBin: false,
    raw: {},
    ...overrides,
  }
}

describe('rootLockfiles', () => {
  it('groups root lockfiles by package manager, ignoring nested and gitignored ones', async () => {
    const ctx = await projectContext({
      '.gitignore': 'yarn.lock\n',
      'package-lock.json': '{}',
      'pnpm-lock.yaml': '',
      'yarn.lock': '',
      'bun.lock': '',
      'bun.lockb': '',
      'apps/web/package-lock.json': '{}',
    })
    expect([...rootLockfiles(ctx.files)]).toEqual([
      ['bun', ['bun.lock', 'bun.lockb']],
      ['npm', ['package-lock.json']],
      ['pnpm', ['pnpm-lock.yaml']],
    ])
  })
})

describe('declaredPackageManager', () => {
  it('reads the packageManager field, including hashes', () => {
    expect(declaredPackageManager({ packageManager: 'pnpm@9.15.9+sha512.abc' })).toEqual({
      id: 'pnpm',
      field: 'packageManager',
    })
    expect(declaredPackageManager({ packageManager: 'Yarn@4.5.0' })?.id).toBe('yarn')
  })

  it('reads devEngines.packageManager in object and array form', () => {
    expect(declaredPackageManager({ devEngines: { packageManager: { name: 'npm', version: '^11' } } })).toEqual({
      id: 'npm',
      field: 'devEngines',
    })
    expect(declaredPackageManager({ devEngines: { packageManager: [{ version: '1' }, { name: 'bun' }] } })?.id).toBe(
      'bun',
    )
  })

  it('returns null for missing or malformed declarations', () => {
    expect(declaredPackageManager({})).toBeNull()
    expect(declaredPackageManager({ packageManager: 42, devEngines: 'npm' })).toBeNull()
    expect(declaredPackageManager({ packageManager: '@', devEngines: { packageManager: [null, 3] } })).toBeNull()
  })
})

describe('MULTIPLE_LOCKFILES', () => {
  const npmAndPnpm = () => locks({ npm: ['package-lock.json'], pnpm: ['pnpm-lock.yaml'] })

  it('names the lockfile to delete when a package manager is declared', () => {
    const found = findMultipleLockfiles(npmAndPnpm(), { id: 'pnpm', field: 'packageManager' })
    expect(found).toEqual([
      {
        code: 'MULTIPLE_LOCKFILES',
        severity: 'warning',
        category: 'package-manager',
        message: 'Found lockfiles for npm and pnpm: package-lock.json and pnpm-lock.yaml',
        hint: 'Delete package-lock.json and keep pnpm-lock.yaml, since package.json declares pnpm',
        files: ['package-lock.json', 'pnpm-lock.yaml'],
        subject: 'lockfiles',
      },
    ])
  })

  it('gives a generic hint without a declaration and handles a declared manager without a lockfile', () => {
    expect(findMultipleLockfiles(npmAndPnpm(), null)[0]?.hint).toContain(
      'Keep the lockfile of the package manager the team uses',
    )
    expect(findMultipleLockfiles(npmAndPnpm(), { id: 'yarn', field: 'packageManager' })[0]?.hint).toBe(
      'Delete package-lock.json and pnpm-lock.yaml and run `yarn install`, since package.json declares yarn',
    )
  })

  it('does not report two lockfiles of the same package manager', () => {
    expect(findMultipleLockfiles(locks({ bun: ['bun.lock', 'bun.lockb'] }), null)).toEqual([])
  })

  it('reads lockfiles and the declaration from the project', async () => {
    const ctx = await projectContext({
      'package.json': pkg({ packageManager: 'pnpm@9.15.9' }),
      'package-lock.json': '{}',
      'pnpm-lock.yaml': '',
    })
    const found = await runCheck(multipleLockfiles, makeSections(), ctx)
    expect(found.map((d) => d.hint)).toEqual([
      'Delete package-lock.json and keep pnpm-lock.yaml, since package.json declares pnpm',
    ])
  })

  it('is skipped when the root manifests show no package.json', async () => {
    const sections = makeSections({ project: { ...makeSections().project, manifests: ['go.mod'] } })
    expect((await runRule(multipleLockfiles, sections)).checks[0]?.status).toBe('skipped')
  })
})

describe('PACKAGE_MANAGER_MISMATCH', () => {
  const never = () => false

  it('reports a declared manager whose lockfile is missing while another one exists', () => {
    const found = findPackageManagerMismatch(
      locks({ npm: ['package-lock.json'] }),
      { id: 'pnpm', field: 'packageManager' },
      never,
    )
    expect(found).toEqual([
      {
        code: 'PACKAGE_MANAGER_MISMATCH',
        severity: 'warning',
        category: 'package-manager',
        message: 'package.json declares pnpm in "packageManager", but package-lock.json is the only lockfile',
        hint: 'Run `pnpm import` to convert package-lock.json into pnpm-lock.yaml and delete package-lock.json, or change "packageManager" if the project uses npm',
        files: ['package.json', 'package-lock.json'],
        subject: 'pnpm',
      },
    ])
  })

  it('uses the install command for other managers', () => {
    const found = findPackageManagerMismatch(
      locks({ pnpm: ['pnpm-lock.yaml'] }),
      { id: 'npm', field: 'devEngines' },
      never,
    )
    expect(found[0]?.hint).toBe(
      'Run `npm install` and delete pnpm-lock.yaml, or change "devEngines" if the project uses pnpm',
    )
  })

  it('does not report matching, absent or non-JS declarations', () => {
    const copy = () => locks({ pnpm: ['pnpm-lock.yaml'] })
    expect(findPackageManagerMismatch(copy(), { id: 'pnpm', field: 'packageManager' }, never)).toEqual([])
    expect(findPackageManagerMismatch(new Map(), { id: 'pnpm', field: 'packageManager' }, never)).toEqual([])
    expect(findPackageManagerMismatch(copy(), { id: 'deno', field: 'packageManager' }, never)).toEqual([])
    expect(findPackageManagerMismatch(copy(), null, never)).toEqual([])
  })

  it('accepts a declared lockfile that exists but is ignored by Git', async () => {
    const ctx = await projectContext({
      '.gitignore': 'yarn.lock\n',
      'package.json': pkg({ packageManager: 'yarn@4.5.0' }),
      'yarn.lock': '',
      'package-lock.json': '{}',
    })
    expect(await runCheck(packageManagerMismatch, makeSections(), ctx)).toEqual([])
  })
})

describe('PACKAGE_MANAGER_UNDECLARED', () => {
  it('suggests declaring the package manager that owns the lockfile', () => {
    const found = findUndeclaredPackageManager({}, locks({ pnpm: ['pnpm-lock.yaml'] }), false)
    expect(found).toEqual([
      {
        code: 'PACKAGE_MANAGER_UNDECLARED',
        severity: 'info',
        category: 'package-manager',
        message: 'package.json does not declare which package manager to use (found pnpm-lock.yaml)',
        hint: 'Run `npm pkg set packageManager=pnpm@$(pnpm --version)` to record it in package.json (Corepack, if you use it, then runs that version)',
        files: ['package.json', 'pnpm-lock.yaml'],
        subject: 'package.json',
      },
    ])
  })

  it('has a Bun-specific hint and a generic one for several managers', () => {
    expect(findUndeclaredPackageManager({}, locks({ bun: ['bun.lock'] }), false)[0]?.hint).toBe(
      'Run `npm pkg set packageManager=bun@$(bun --version)` to record it in package.json',
    )
    const several = locks({ npm: ['package-lock.json'], yarn: ['yarn.lock'] })
    expect(findUndeclaredPackageManager({}, several, false)[0]?.hint).toContain(
      'naming the package manager and version',
    )
  })

  it('does not report declared projects (packageManager, devEngines, Volta, detector) or missing lockfiles', () => {
    const map = () => locks({ npm: ['package-lock.json'] })
    expect(findUndeclaredPackageManager({ packageManager: 'npm@11.0.0' }, map(), false)).toEqual([])
    expect(findUndeclaredPackageManager({ devEngines: { packageManager: { name: 'npm' } } }, map(), false)).toEqual([])
    expect(findUndeclaredPackageManager({ volta: { node: '22.11.0', npm: '11.0.0' } }, map(), false)).toEqual([])
    expect(findUndeclaredPackageManager({}, map(), true)).toEqual([])
    expect(findUndeclaredPackageManager({}, new Map(), false)).toEqual([])
  })

  it('never relies on Corepack, which Node.js 25+ no longer bundles', () => {
    for (const manager of ['npm', 'pnpm', 'yarn', 'bun'] as const) {
      const hint = findUndeclaredPackageManager({}, locks({ [manager]: ['x.lock'] }), false)[0]?.hint ?? ''
      expect(hint).toContain('npm pkg set packageManager=')
      expect(hint).not.toMatch(/corepack (?:use|enable)/)
    }
  })

  it('uses the version the repository reveals', () => {
    expect(knownManagerVersion({ engines: { pnpm: '9.12.0' } }, 'pnpm')).toBe('9.12.0')
    expect(knownManagerVersion({ engines: { pnpm: '>=9' } }, 'pnpm')).toBeUndefined()
    expect(knownManagerVersion({}, 'yarn', '.yarn/releases/yarn-4.5.0.cjs')).toBe('4.5.0')
    expect(knownManagerVersion({}, 'yarn', '.yarn/releases/yarn-$(id).cjs')).toBeUndefined()
    expect(knownManagerVersion({}, 'npm', '.yarn/releases/yarn-4.5.0.cjs')).toBeUndefined()
    expect(declareCommand('yarn', '4.5.0')).toBe('npm pkg set packageManager=yarn@4.5.0')
    const found = findUndeclaredPackageManager({}, locks({ yarn: ['yarn.lock'] }), false, '4.5.0')
    expect(found[0]?.hint).toBe(
      'Run `npm pkg set packageManager=yarn@4.5.0` to record it in package.json (Corepack, if you use it, then runs that version)',
    )
  })

  it('reads the Yarn version from yarnPath through the rule', async () => {
    const ctx = await projectContext({
      'package.json': pkg(),
      'yarn.lock': '',
      '.yarnrc.yml': 'yarnPath: .yarn/releases/yarn-4.5.0.cjs\n',
    })
    const found = await runCheck(packageManagerUndeclared, makeSections(), ctx)
    expect(found[0]?.hint).toContain('`npm pkg set packageManager=yarn@4.5.0`')
  })

  it('is skipped without a lockfile or without a readable package.json', async () => {
    const noLock = await projectContext({ 'package.json': pkg() })
    expect((await runRule(packageManagerUndeclared, makeSections(), noLock)).checks[0]?.status).toBe('skipped')
    const broken = await projectContext({ 'package.json': '{', 'pnpm-lock.yaml': '' })
    await broken.readJson('package.json')
    expect((await runRule(packageManagerUndeclared, makeSections(), broken)).checks[0]?.status).toBe('skipped')
    expect((await runRule(packageManagerMismatch, makeSections(), broken)).checks[0]?.status).toBe('skipped')
    expect((await runRule(lockfileMissing, makeSections(), broken)).checks[0]?.status).toBe('skipped')
  })

  it('trusts a declaration reported by the package managers section', async () => {
    const declared: PackageManagerInfo = {
      id: 'yarn',
      name: 'Yarn',
      lockfiles: ['yarn.lock'],
      declared: true,
      evidence: ['.yarnrc.yml yarnPath'],
    }
    const sections = makeSections({ packageManagers: { primary: declared, detected: [declared] } })
    const ctx = await projectContext({ 'package.json': pkg(), 'yarn.lock': '' })
    expect(await runCheck(packageManagerUndeclared, sections, ctx)).toEqual([])
    expect(await runCheck(packageManagerUndeclared, makeSections(), ctx)).toHaveLength(1)
  })
})

describe('LOCKFILE_MISSING', () => {
  const unlocked = { anyLockfile: false, deliberatelyUnlocked: false }

  it('reports dependencies without a lockfile', () => {
    const found = findLockfileMissing([manifest({ dependencies: { express: '^5.1.0' } })], unlocked, 'npm')
    expect(found).toEqual([
      {
        code: 'LOCKFILE_MISSING',
        severity: 'info',
        category: 'package-manager',
        message: 'package.json declares dependencies but there is no lockfile',
        hint: 'Run `npm install` and commit package-lock.json so installs are reproducible',
        files: ['package.json'],
        subject: 'package.json',
      },
    ])
  })

  it('counts dependencies of workspace packages', () => {
    const packages = [
      manifest(),
      manifest({ dir: 'apps/web', file: 'apps/web/package.json', role: 'workspace', dependencies: { vue: '^3' } }),
    ]
    expect(findLockfileMissing(packages, unlocked, 'pnpm')[0]?.hint).toContain('pnpm-lock.yaml')
  })

  it('does not report without dependencies, with a lockfile, or when unlocked on purpose', () => {
    expect(findLockfileMissing([manifest()], unlocked, 'npm')).toEqual([])
    const withDeps = [manifest({ devDependencies: { vitest: '^3' } })]
    expect(findLockfileMissing(withDeps, { anyLockfile: true, deliberatelyUnlocked: false }, 'npm')).toEqual([])
    expect(findLockfileMissing(withDeps, { anyLockfile: false, deliberatelyUnlocked: true }, 'npm')).toEqual([])
  })

  it('treats a gitignored lockfile name or package-lock=false as deliberate', async () => {
    const deps = pkg({ dependencies: { ms: '^2.1.3' } })
    const sections = makeSections()
    expect(await runCheck(lockfileMissing, sections, await projectContext({ 'package.json': deps }))).toHaveLength(1)
    const ignored = await projectContext({ 'package.json': deps, '.gitignore': 'package-lock.json\n' })
    expect(await runCheck(lockfileMissing, sections, ignored)).toEqual([])
    const npmrc = await projectContext({
      'package.json': deps,
      '.npmrc': `//registry.npmjs.org/:_authToken=${SECRET_SENTINEL}\npackage-lock=false\n`,
    })
    expect(await runCheck(lockfileMissing, sections, npmrc)).toEqual([])
  })

  it('uses the declared package manager and never echoes .npmrc contents', async () => {
    const ctx = await projectContext({
      'package.json': pkg({ packageManager: 'pnpm@10.0.0', dependencies: { ms: '^2.1.3' } }),
      '.npmrc': `//registry.npmjs.org/:_authToken=${SECRET_SENTINEL}\n`,
    })
    const found = await runCheck(lockfileMissing, makeSections(), ctx)
    expect(found[0]?.hint).toBe('Run `pnpm install` and commit pnpm-lock.yaml so installs are reproducible')
    expectWellFormed(found)
  })

  it('does not report for a package inside a larger repository', async () => {
    const repo = await makeProject({
      'package-lock.json': '{}',
      'apps/web/package.json': pkg({ dependencies: { ms: '1' } }),
    })
    gitInit(repo)
    const ctx = await contextFor(path.join(repo, 'apps/web'))
    expect(await runCheck(lockfileMissing, makeSections(), ctx)).toEqual([])
  })
})
