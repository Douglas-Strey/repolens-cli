import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  chooseAmongLockfiles,
  choosePrimary,
  cleanDeclaredVersion,
  dependencyProtocols,
  inferWithoutLockfile,
  installCommandManagers,
  managerFromAncestors,
  needsYarnLock,
  packageManagersDetector,
  parseDevEnginesPackageManager,
  parsePackageManagerField,
  yarnFlavor,
} from '../../src/detectors/package-managers.ts'
import type { PackageManagerSection } from '../../src/types.ts'
import { contextFor, fixtureContext, gitInit, makeProject, timeBudget } from '../helpers.ts'

async function detectFixture(name: string): Promise<PackageManagerSection> {
  const ctx = await fixtureContext(name)
  return ctx.use(packageManagersDetector)
}

async function detectFiles(files: Record<string, string>): Promise<PackageManagerSection> {
  const ctx = await contextFor(await makeProject(files))
  return ctx.use(packageManagersDetector)
}

const ids = (section: PackageManagerSection) => section.detected.map((pm) => pm.id)

describe('parsePackageManagerField', () => {
  it('parses name and version and strips the Corepack hash', () => {
    expect(parsePackageManagerField('pnpm@10.17.1+sha512.abcdef0123')).toEqual({ id: 'pnpm', version: '10.17.1' })
    expect(parsePackageManagerField('yarn@4.10.3')).toEqual({ id: 'yarn', version: '4.10.3' })
    expect(parsePackageManagerField('  Bun@1.3.0 ')).toEqual({ id: 'bun', version: '1.3.0' })
  })

  it('accepts a bare name', () => {
    expect(parsePackageManagerField('npm')).toEqual({ id: 'npm' })
  })

  it('rejects unknown package managers', () => {
    expect(parsePackageManagerField('cnpm@9.0.0')).toBeNull()
    expect(parsePackageManagerField('@yarnpkg/cli@4.0.0')).toBeNull()
    expect(parsePackageManagerField('')).toBeNull()
  })

  it('drops URL "versions" instead of echoing them (they can carry credentials)', () => {
    const parsed = parsePackageManagerField('yarn@https://user:s3cret@registry.example.com/yarn-4.0.0.tgz#sha224.abc')
    expect(parsed).toEqual({ id: 'yarn' })
    expect(JSON.stringify(parsed)).not.toContain('s3cret')
  })
})

describe('cleanDeclaredVersion', () => {
  it('keeps versions and semver ranges', () => {
    expect(cleanDeclaredVersion('10.17.1')).toBe('10.17.1')
    expect(cleanDeclaredVersion(' ^10.0.0 ')).toBe('^10.0.0')
    expect(cleanDeclaredVersion('>=9 <11')).toBe('>=9 <11')
  })

  it('rejects dist-tags, URLs and oversized values', () => {
    expect(cleanDeclaredVersion(undefined)).toBeUndefined()
    expect(cleanDeclaredVersion('latest')).toBeUndefined()
    expect(cleanDeclaredVersion('https://example.com/x.tgz')).toBeUndefined()
    expect(cleanDeclaredVersion('1'.repeat(100))).toBeUndefined()
  })
})

describe('parseDevEnginesPackageManager', () => {
  it('reads the object form', () => {
    expect(
      parseDevEnginesPackageManager({ packageManager: { name: 'pnpm', version: '^10.0.0', onFail: 'error' } }),
    ).toEqual([{ id: 'pnpm', version: '^10.0.0' }])
  })

  it('reads the array form in order and skips unknown or malformed entries', () => {
    expect(
      parseDevEnginesPackageManager({
        packageManager: [{ name: 'yarn', version: '4.x' }, { name: 'cnpm' }, 'npm', { version: '1' }, { name: 'npm' }],
      }),
    ).toEqual([{ id: 'yarn', version: '4.x' }, { id: 'npm' }])
  })

  it('returns nothing for malformed input', () => {
    expect(parseDevEnginesPackageManager(undefined)).toEqual([])
    expect(parseDevEnginesPackageManager('pnpm')).toEqual([])
    expect(parseDevEnginesPackageManager({ packageManager: 42 })).toEqual([])
  })
})

describe('yarnFlavor', () => {
  it('treats .yarnrc.yml as Berry', () => {
    expect(yarnFlavor({ hasYarnrcYml: true })?.flavor).toBe('Berry')
  })

  it('reads the lockfile format', () => {
    expect(yarnFlavor({ hasYarnrcYml: false, lockText: '__metadata:\n  version: 8\n' })?.flavor).toBe('Berry')
    expect(yarnFlavor({ hasYarnrcYml: false, lockText: '# yarn lockfile v1\n\nfoo@^1:\n' })?.flavor).toBe('Classic')
    expect(yarnFlavor({ hasYarnrcYml: false, lockText: 'foo@^1:\n  version "1.0.0"\n' })?.flavor).toBe('Classic')
  })

  it('falls back to the declared version', () => {
    expect(yarnFlavor({ hasYarnrcYml: false, declaredVersion: '4.10.3' })?.flavor).toBe('Berry')
    expect(yarnFlavor({ hasYarnrcYml: false, lockText: null, declaredVersion: '1.22.22' })?.flavor).toBe('Classic')
  })

  it('returns null when nothing is known', () => {
    expect(yarnFlavor({ hasYarnrcYml: false, lockText: null })).toBeNull()
  })

  it('lets a declared version win over the lockfile format (Corepack runs that version)', () => {
    expect(yarnFlavor({ hasYarnrcYml: false, lockText: '# yarn lockfile v1\n', declaredVersion: '4.10.3' })).toEqual({
      flavor: 'Berry',
      reason: 'declared yarn@4.10.3',
    })
  })
})

describe('needsYarnLock', () => {
  it('reads yarn.lock only when neither .yarnrc.yml nor a declared version decides', () => {
    expect(needsYarnLock(false, undefined)).toBe(true)
    expect(needsYarnLock(true, undefined)).toBe(false)
    expect(needsYarnLock(false, '1.22.22')).toBe(false)
  })
})

describe('choosePrimary', () => {
  it('prefers the declared package manager', () => {
    expect(choosePrimary({ declared: ['yarn'], withLockfile: ['npm', 'pnpm'], withConfig: [] })).toBe('yarn')
  })

  it('uses the only lockfile, then pnpm > yarn > bun > npm', () => {
    expect(choosePrimary({ declared: [], withLockfile: ['npm'], withConfig: [] })).toBe('npm')
    expect(choosePrimary({ declared: [], withLockfile: ['npm', 'bun'], withConfig: [] })).toBe('bun')
    expect(choosePrimary({ declared: [], withLockfile: ['npm', 'yarn', 'pnpm'], withConfig: [] })).toBe('pnpm')
  })

  it('uses config files only when there is no lockfile', () => {
    expect(choosePrimary({ declared: [], withLockfile: ['npm'], withConfig: ['bun'] })).toBe('npm')
    expect(choosePrimary({ declared: [], withLockfile: [], withConfig: ['bun'] })).toBe('bun')
    expect(choosePrimary({ declared: [], withLockfile: [], withConfig: [] })).toBeNull()
  })
})

describe('installCommandManagers', () => {
  it('finds install commands in workflows and Dockerfiles', () => {
    expect(installCommandManagers('      - run: npm ci\n')).toEqual(['npm'])
    expect(installCommandManagers('RUN pnpm install --frozen-lockfile\n')).toEqual(['pnpm'])
    expect(installCommandManagers('      - run: yarn\n')).toEqual(['yarn'])
    expect(installCommandManagers('      - run: yarn --immutable\n')).toEqual(['yarn'])
    expect(installCommandManagers('RUN bun install\n')).toEqual(['bun'])
    expect(installCommandManagers('      - uses: pnpm/action-setup@v4\n')).toEqual(['pnpm'])
    expect(installCommandManagers('          cache: "yarn"\n')).toEqual(['yarn'])
  })

  it('ignores global installs of a package manager and non-install commands', () => {
    expect(installCommandManagers('run: npm install -g pnpm && pnpm install\n')).toEqual(['pnpm'])
    expect(installCommandManagers('run: npm i --global yarn\n')).toEqual([])
    expect(installCommandManagers('run: npm run build && yarn test && pnpm lint\n')).toEqual([])
  })

  it('stays linear on hostile input', () => {
    const started = performance.now()
    installCommandManagers(`${' '.repeat(100_000)}\n`.repeat(20) + 'npm '.repeat(50_000))
    expect(performance.now() - started).toBeLessThan(timeBudget(1000))
  })
})

describe('chooseAmongLockfiles', () => {
  it('uses the package manager CI or a Dockerfile installs with', () => {
    const installers = new Map([['npm', '.github/workflows/ci.yml']] as const)
    expect(chooseAmongLockfiles(['npm', 'pnpm'], installers)).toEqual({
      id: 'npm',
      evidence: 'picked among several lockfiles: .github/workflows/ci.yml installs with npm',
      guessed: false,
    })
  })

  it('says it guessed when CI does not decide', () => {
    for (const installers of [
      new Map(),
      new Map([
        ['npm', 'a'],
        ['pnpm', 'b'],
      ] as const),
    ]) {
      const choice = chooseAmongLockfiles(['npm', 'pnpm'], installers)
      expect(choice?.id).toBe('pnpm')
      expect(choice?.evidence).toMatch(/^guessed among several lockfiles/)
    }
  })
})

describe('inference without a lockfile', () => {
  it('dependencyProtocols reads workspace: and catalog: versions as written', () => {
    expect(
      dependencyProtocols({
        dependencies: { '@acme/ui': 'workspace:*', react: 'catalog:' },
        devDependencies: { typescript: 'catalog:dev', vitest: '^3.0.0' },
      }),
    ).toEqual(['workspace', 'catalog'])
    expect(dependencyProtocols({ dependencies: { react: '^19.0.0' } })).toEqual([])
    expect(dependencyProtocols({ dependencies: 'nope' })).toEqual([])
  })

  it('managerFromAncestors uses the nearest directory with a lockfile', () => {
    expect(
      managerFromAncestors([
        { dir: 'apps', files: ['.yarnrc.yml'] },
        { dir: '', files: ['package-lock.json', 'pnpm-lock.yaml'] },
      ]),
    ).toEqual({ id: 'pnpm', file: 'pnpm-lock.yaml', dir: '' })
    expect(managerFromAncestors([{ dir: '', files: ['.yarnrc.yml'] }])).toBeNull()
  })

  it('inferWithoutLockfile never claims npm with confidence for a workspace package', () => {
    const root = { id: 'pnpm' as const, file: 'pnpm-lock.yaml', dir: '' }
    expect(inferWithoutLockfile({ protocols: ['workspace'], ancestor: root, prefix: 'apps/web' })).toEqual({
      id: 'pnpm',
      evidence: ['pnpm-lock.yaml at the repository root; install from the repository root'],
      guessed: false,
      installFrom: '',
    })
    const catalog = inferWithoutLockfile({ protocols: ['workspace', 'catalog'], ancestor: null, prefix: 'apps/web' })
    expect(catalog.id).toBe('pnpm')
    expect(catalog.evidence[0]).toBe(
      'guessed: package.json uses workspace: and catalog: versions, which npm cannot install (pnpm, Bun or Yarn 4 can); install from the repository root',
    )
    const intermediate = { id: 'yarn' as const, file: 'yarn.lock', dir: 'frontend' }
    expect(inferWithoutLockfile({ protocols: [], ancestor: intermediate, prefix: 'frontend/app' }).evidence).toEqual([
      'yarn.lock in frontend/ of the repository; install from frontend/',
    ])
    // An npm lockfile above cannot install workspace: versions either.
    const npmAbove = { id: 'npm' as const, file: 'package-lock.json', dir: '' }
    expect(inferWithoutLockfile({ protocols: ['workspace'], ancestor: npmAbove, prefix: 'a' }).id).toBe('pnpm')
    expect(inferWithoutLockfile({ protocols: [], ancestor: null, prefix: 'packages/x' })).toEqual({
      id: 'npm',
      evidence: [
        'guessed: package.json without a lockfile inside a larger repository; install from the repository root',
      ],
      guessed: true,
      installFrom: '',
    })
    expect(inferWithoutLockfile({ protocols: [], ancestor: null, prefix: '' })).toEqual({
      id: 'npm',
      evidence: ['package.json without a lockfile'],
      guessed: false,
    })
  })
})

describe('packageManagersDetector on fixtures', () => {
  it('monorepo: declared pnpm with lockfile, plus nested Go module', async () => {
    const section = await detectFixture('monorepo')
    expect(section.primary).toMatchObject({
      id: 'pnpm',
      name: 'pnpm',
      version: '10.17.1',
      lockfiles: ['pnpm-lock.yaml'],
      declared: true,
    })
    expect(section.primary?.evidence).toEqual([
      'packageManager field in package.json (pnpm@10.17.1)',
      'lockfile pnpm-lock.yaml',
      'workspace file pnpm-workspace.yaml',
    ])
    expect(ids(section)).toEqual(['pnpm', 'go'])
    expect(section.detected[1]).toEqual({
      id: 'go',
      name: 'Go modules',
      lockfiles: ['services/billing/go.sum'],
      declared: true,
      evidence: ['module file services/billing/go.mod'],
    })
  })

  it('fastify-api: Yarn Berry', async () => {
    const section = await detectFixture('fastify-api')
    expect(section.primary).toMatchObject({ id: 'yarn', name: 'Yarn', version: '4.10.3', lockfiles: ['yarn.lock'] })
    expect(section.primary?.evidence).toContain('Yarn Berry (.yarnrc.yml exists)')
  })

  it('bun-app: bun.lock with bunfig.toml as extra evidence', async () => {
    const section = await detectFixture('bun-app')
    expect(section.primary).toEqual({
      id: 'bun',
      name: 'Bun',
      lockfiles: ['bun.lock'],
      declared: false,
      evidence: ['lockfile bun.lock', 'config file bunfig.toml'],
    })
    expect(ids(section)).toEqual(['bun'])
  })

  it('mixed-lockfiles: reports both lockfiles, the declared pnpm is primary', async () => {
    const section = await detectFixture('mixed-lockfiles')
    expect(ids(section)).toEqual(['npm', 'pnpm'])
    expect(section.primary).toMatchObject({ id: 'pnpm', version: '9.15.9', declared: true })
    expect(section.detected[0]).toMatchObject({ id: 'npm', declared: false, lockfiles: ['package-lock.json'] })
  })

  it('next-app and express-api: npm from package-lock.json', async () => {
    for (const fixture of ['next-app', 'express-api']) {
      const section = await detectFixture(fixture)
      expect(section.primary).toEqual({
        id: 'npm',
        name: 'npm',
        lockfiles: ['package-lock.json'],
        declared: false,
        evidence: ['lockfile package-lock.json'],
      })
    }
  })

  it('go-api: Go modules are primary when there is no JS project', async () => {
    const section = await detectFixture('go-api')
    expect(section.primary).toEqual({
      id: 'go',
      name: 'Go modules',
      lockfiles: ['go.sum'],
      declared: true,
      evidence: ['module file go.mod'],
    })
  })

  it('plain-repo: no package manager', async () => {
    expect(await detectFixture('plain-repo')).toEqual({ primary: null, detected: [] })
  })

  it('broken-manifest: falls back to npm without crashing', async () => {
    const section = await detectFixture('broken-manifest')
    expect(section.primary).toEqual({
      id: 'npm',
      name: 'npm',
      lockfiles: [],
      declared: false,
      evidence: ['package.json without a lockfile'],
    })
  })
})

describe('packageManagersDetector on inline projects', () => {
  it('prefers pnpm when several undeclared lockfiles exist', async () => {
    const section = await detectFiles({
      'package.json': '{"name":"x"}',
      'package-lock.json': '{}',
      'yarn.lock': '# yarn lockfile v1\n',
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
      'bun.lockb': 'binary',
    })
    expect(ids(section)).toEqual(['npm', 'pnpm', 'yarn', 'bun'])
    expect(section.primary?.id).toBe('pnpm')
    const yarn = section.detected.find((pm) => pm.id === 'yarn')
    expect(yarn?.evidence).toContain('Yarn Classic (yarn.lock uses the v1 format)')
  })

  it('detects Yarn Berry from the lockfile header', async () => {
    const section = await detectFiles({
      'package.json': '{}',
      'yarn.lock': '# This file is generated by running "yarn install"\n\n__metadata:\n  version: 8\n',
    })
    expect(section.primary?.evidence).toEqual(['lockfile yarn.lock', 'Yarn Berry (yarn.lock has a __metadata section)'])
  })

  it('reports npm-shrinkwrap.json and bun.lockb', async () => {
    const section = await detectFiles({
      'package.json': '{}',
      'npm-shrinkwrap.json': '{}',
      'package-lock.json': '{}',
      'bun.lockb': 'x',
    })
    expect(section.detected[0]?.lockfiles).toEqual(['package-lock.json', 'npm-shrinkwrap.json'])
    expect(section.detected[1]).toMatchObject({ id: 'bun', lockfiles: ['bun.lockb'] })
    expect(section.primary?.id).toBe('bun')
  })

  it('does not read (or warn about) a large yarn.lock when the declared version decides', async () => {
    const dir = await makeProject({
      'package.json': '{"packageManager":"yarn@1.22.22"}',
      'yarn.lock': `# yarn lockfile v1\n${'x'.repeat(500)}\n`,
    })
    const ctx = await contextFor(dir, { maxFileSize: 100 })
    const section = await ctx.use(packageManagersDetector)
    expect(section.primary?.evidence).toContain('Yarn Classic (declared yarn@1.22.22)')
    expect(ctx.warnings).toEqual([])
  })

  it('reads devEngines.packageManager', async () => {
    const section = await detectFiles({
      'package.json': JSON.stringify({ devEngines: { packageManager: { name: 'yarn', version: '^4.0.0' } } }),
    })
    expect(section.primary).toMatchObject({ id: 'yarn', version: '^4.0.0', declared: true, lockfiles: [] })
    expect(section.primary?.evidence).toEqual([
      'devEngines.packageManager in package.json (yarn@^4.0.0)',
      'Yarn Berry (declared yarn@^4.0.0)',
    ])
  })

  it('prefers the packageManager field over devEngines', async () => {
    const section = await detectFiles({
      'package.json': JSON.stringify({
        packageManager: 'pnpm@10.0.0',
        devEngines: { packageManager: [{ name: 'npm', version: '10.9.0' }] },
      }),
    })
    expect(section.primary?.id).toBe('pnpm')
    expect(section.detected.map((pm) => [pm.id, pm.declared])).toEqual([
      ['npm', true],
      ['pnpm', true],
    ])
  })

  it('treats pnpm-workspace.yaml as pnpm evidence', async () => {
    const section = await detectFiles({ 'package.json': '{}', 'pnpm-workspace.yaml': 'packages: []\n' })
    expect(section.primary).toMatchObject({ id: 'pnpm', lockfiles: [], declared: false })
  })

  it('does not detect Yarn or Bun from their config files alone', async () => {
    const section = await detectFiles({
      'package.json': '{}',
      'pnpm-lock.yaml': '',
      '.yarnrc.yml': 'nodeLinker: node-modules\n',
      'bunfig.toml': '[test]\n',
    })
    expect(ids(section)).toEqual(['pnpm'])
    const fallback = await detectFiles({ 'package.json': '{}', 'bunfig.toml': '[test]\n' })
    expect(fallback.primary).toMatchObject({ id: 'npm', evidence: ['package.json without a lockfile'] })
    expect(ids(fallback)).toEqual(['npm'])
  })

  it('combines a JS primary with nested Go modules', async () => {
    const section = await detectFiles({
      'package.json': '{"name":"web"}',
      'tools/gen/go.mod': 'module example.com/gen\n\ngo 1.25\n',
    })
    expect(section.primary?.id).toBe('npm')
    expect(ids(section)).toEqual(['npm', 'go'])
    expect(section.detected[1]?.lockfiles).toEqual([])
  })

  it('counts a root go.mod even when it cannot be parsed', async () => {
    const section = await detectFiles({ 'go.mod': 'not a go.mod\n' })
    expect(section.primary).toMatchObject({ id: 'go', lockfiles: [], evidence: ['module file go.mod'] })
  })

  it('lists at most five go.mod files as evidence', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 7; i++) files[`svc${i}/go.mod`] = `module example.com/svc${i}\n`
    const section = await detectFiles(files)
    expect(section.primary?.evidence).toHaveLength(6)
    expect(section.primary?.evidence.at(-1)).toBe('2 more go.mod files')
  })

  it('never echoes credentials from the packageManager field', async () => {
    const section = await detectFiles({
      'package.json': JSON.stringify({ packageManager: 'yarn@https://bob:hunter2@example.com/yarn.tgz' }),
    })
    expect(section.primary).toMatchObject({ id: 'yarn', declared: true })
    expect(section.primary?.version).toBeUndefined()
    expect(JSON.stringify(section)).not.toContain('hunter2')
  })

  it('breaks a lockfile tie with the install command CI uses, and says when it guessed', async () => {
    const files = {
      'package.json': '{"name":"x"}',
      'package-lock.json': '{}',
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
    }
    const withCi = await detectFiles({
      ...files,
      '.github/workflows/ci.yml': 'jobs:\n  test:\n    steps:\n      - run: npm install -g pnpm\n      - run: npm ci\n',
    })
    expect(withCi.primary?.id).toBe('npm')
    expect(withCi.primary?.evidence).toContain(
      'picked among several lockfiles: .github/workflows/ci.yml installs with npm',
    )
    const withDocker = await detectFiles({ ...files, Dockerfile: 'FROM node:22\nRUN pnpm install --frozen-lockfile\n' })
    expect(withDocker.primary?.id).toBe('pnpm')
    const guessed = await detectFiles(files)
    expect(guessed.primary?.id).toBe('pnpm')
    expect(guessed.primary?.evidence.some((line) => line.startsWith('guessed among several lockfiles'))).toBe(true)
  })

  it('scans a workspace package below the repository root: uses the lockfile at the root (from the Git index)', async () => {
    const repo = await makeProject({
      'package.json': JSON.stringify({ name: 'root', private: true }),
      'pnpm-workspace.yaml': 'packages:\n  - apps/*\n',
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
      'apps/nextjs/package.json': JSON.stringify({
        name: '@acme/nextjs',
        dependencies: { '@acme/ui': 'workspace:*', next: 'catalog:' },
      }),
    })
    gitInit(repo)
    const section = await (await contextFor(path.join(repo, 'apps/nextjs'))).use(packageManagersDetector)
    expect(section.primary).toEqual({
      id: 'pnpm',
      name: 'pnpm',
      lockfiles: [],
      declared: false,
      evidence: ['pnpm-lock.yaml at the repository root; install from the repository root'],
      installFrom: '',
    })
  })

  it('does not claim npm for a package with workspace: or catalog: versions and no lockfile anywhere', async () => {
    const section = await detectFiles({
      'package.json': JSON.stringify({ dependencies: { '@acme/ui': 'workspace:*', react: 'catalog:' } }),
    })
    expect(section.primary?.id).toBe('pnpm')
    expect(section.primary?.evidence[0]).toMatch(/^guessed: package\.json uses workspace: and catalog: versions/)
  })

  it('marks npm as a guess below the repository root when nothing else is known', async () => {
    const repo = await makeProject({ 'README.md': '# repo\n', 'tools/x/package.json': '{"name":"x"}' })
    gitInit(repo)
    const section = await (await contextFor(path.join(repo, 'tools/x'))).use(packageManagersDetector)
    expect(section.primary?.id).toBe('npm')
    expect(section.primary?.evidence).toEqual([
      'guessed: package.json without a lockfile inside a larger repository; install from the repository root',
    ])
  })

  it('is deterministic', async () => {
    const dir = await makeProject({ 'package.json': '{}', 'yarn.lock': '', 'package-lock.json': '{}' })
    const first = await (await contextFor(dir)).use(packageManagersDetector)
    const second = await (await contextFor(dir)).use(packageManagersDetector)
    expect(second).toEqual(first)
  })
})
