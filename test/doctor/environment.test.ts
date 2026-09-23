// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Compose ${VAR} interpolation is the syntax under test
import { describe, expect, it } from 'vitest'
import {
  envExampleMissing,
  envLocalOnly,
  envMissingLocal,
  envUndocumented,
  envUnused,
  findExampleMissing,
  findLocalOnly,
  findMissingLocal,
  findUndocumented,
  findUnused,
  isPlatformVariable,
  isToolReadVariable,
  pickEnvFile,
} from '../../src/doctor/rules/environment.ts'
import type { ServicesSection } from '../../src/types.ts'
import { makeProject, scanDir } from '../helpers.ts'
import {
  envFile,
  environment,
  envVar,
  expectWellFormed,
  makeSections,
  projectContext,
  runCheck,
  runRule,
  service,
  subjectsOf,
} from './support.ts'

const EXAMPLE = envFile('.env.example', 'example')
const LOCAL = envFile('.env', 'local')
const NO_SERVICES: ServicesSection = { composeFiles: [], services: [], dockerfiles: [] }

describe('isPlatformVariable', () => {
  it('ignores OS, CI-platform and runner variables', () => {
    for (const name of ['NODE_ENV', 'CI', 'HOME', 'DEBUG', 'npm_package_version', 'GITHUB_SHA', 'VERCEL_URL']) {
      expect(isPlatformVariable(name), name).toBe(true)
    }
    for (const name of ['NEXT_RUNTIME', 'VITEST_POOL_ID', 'JEST_WORKER_ID', 'CF_PAGES_URL', 'MODE']) {
      expect(isPlatformVariable(name), name).toBe(true)
    }
  })

  it('keeps application variables, including PORT', () => {
    for (const name of ['PORT', 'DATABASE_URL', 'API_KEY', 'NODE_VERSION_OVERRIDE', 'GITHUB', 'NPM_TOKEN']) {
      expect(isPlatformVariable(name), name).toBe(false)
    }
  })

  it('knows the GitHub Actions default variables, not every GITHUB_ name', () => {
    for (const name of [
      'GITHUB_ACTIONS',
      'GITHUB_ACTION_PATH',
      'GITHUB_ACTOR_ID',
      'GITHUB_REF_NAME',
      'GITHUB_REPOSITORY_OWNER',
      'GITHUB_RUN_ATTEMPT',
      'GITHUB_EVENT_NAME',
      'GITHUB_WORKFLOW_REF',
      'GITHUB_STEP_SUMMARY',
      'GITHUB_HEAD_REF',
      'GITHUB_TOKEN',
    ]) {
      expect(isPlatformVariable(name), name).toBe(true)
    }
    for (const name of [
      'GITHUB_CLIENT_ID',
      'GITHUB_CLIENT_SECRET',
      'GITHUB_REFRESH_TOKEN',
      'GITHUB_APP_ID',
      'GITHUB_RUN',
    ]) {
      expect(isPlatformVariable(name), name).toBe(false)
    }
  })

  it('knows variables that tools read implicitly', () => {
    expect(isToolReadVariable('NUXT_PUBLIC_API_BASE')).toBe(true)
    expect(isToolReadVariable('AUTH_GITHUB_ID')).toBe(true)
    expect(isToolReadVariable('PORT')).toBe(true)
    expect(isToolReadVariable('LEGACY_FLAG')).toBe(false)
  })
})

describe('pickEnvFile', () => {
  it('prefers the example in the deepest directory containing the usage', () => {
    const examples = ['.env.example', 'apps/api/.env.example', 'apps/web/.env.example']
    expect(pickEnvFile(examples, 'apps/api/src/db.ts')).toBe('apps/api/.env.example')
    expect(pickEnvFile(examples, 'packages/ui/index.ts')).toBe('.env.example')
  })

  it('falls back to a root file, then the first file, and prefers .env.example', () => {
    expect(pickEnvFile(['apps/web/.env.example'], 'apps/api/x.ts')).toBe('apps/web/.env.example')
    expect(pickEnvFile(['.env.sample', '.env.example'])).toBe('.env.example')
    expect(pickEnvFile([])).toBeUndefined()
  })
})

describe('ENV_UNDOCUMENTED', () => {
  it('reports a variable used in code but missing from the example file', () => {
    const env = environment([EXAMPLE], [envVar('API_KEY', { used: true, usedIn: ['src/client.ts', 'src/other.ts'] })])
    const found = findUndocumented(env)
    expect(found).toEqual([
      {
        code: 'ENV_UNDOCUMENTED',
        severity: 'warning',
        category: 'environment',
        message: 'API_KEY is used in code but missing from .env.example',
        hint: 'Add API_KEY= to .env.example',
        files: ['src/client.ts', '.env.example'],
        subject: 'API_KEY',
      },
    ])
    expectWellFormed(found)
  })

  it('points at the example file closest to the usage in a monorepo', () => {
    const env = environment(
      [EXAMPLE, envFile('apps/api/.env.example', 'example')],
      [envVar('STRIPE_KEY', { used: true, usedIn: ['apps/api/src/billing.ts'] })],
    )
    expect(findUndocumented(env)[0]?.message).toBe('STRIPE_KEY is used in code but missing from apps/api/.env.example')
  })

  it('ignores documented and platform variables but not PORT', () => {
    const env = environment(
      [EXAMPLE],
      [
        envVar('DOCUMENTED', { used: true, documented: true, usedIn: ['a.ts'], documentedIn: ['.env.example'] }),
        envVar('NODE_ENV', { used: true, usedIn: ['a.ts'] }),
        envVar('GITHUB_TOKEN', { used: true, usedIn: ['a.ts'] }),
        envVar('PORT', { used: true, usedIn: ['server.ts'] }),
      ],
    )
    expect(subjectsOf(findUndocumented(env))).toEqual(['PORT'])
  })

  it('does not report when there is no example file (ENV_EXAMPLE_MISSING covers it)', () => {
    expect(findUndocumented(environment([LOCAL], [envVar('API_KEY', { used: true })]))).toEqual([])
  })

  it('is skipped by the runner when no variable is used', async () => {
    const sections = makeSections({ environment: environment([EXAMPLE], [envVar('X', { documented: true })]) })
    const result = await runRule(envUndocumented, sections)
    expect(result.checks[0]?.status).toBe('skipped')
  })
})

describe('ENV_UNDOCUMENTED refinements', () => {
  it('is informational for a variable every reference gives a default', () => {
    const env = environment([EXAMPLE], [envVar('PORT', { used: true, usedIn: ['src/server.ts'], fallback: true })])
    expect(findUndocumented(env)).toEqual([
      {
        code: 'ENV_UNDOCUMENTED',
        severity: 'info',
        category: 'environment',
        message: 'PORT is used in code (with a default) but missing from .env.example',
        hint: 'Add PORT= to .env.example',
        files: ['src/server.ts', '.env.example'],
        subject: 'PORT',
      },
    ])
  })

  it('skips test-only variables and names a next.config env block provides', () => {
    const env = environment(
      [EXAMPLE],
      [
        envVar('E2E_USER', {
          used: true,
          usedIn: ['e2e/a.ts', 'e2e/b.ts', 'e2e/c.ts', 'e2e/d.ts', 'e2e/e.ts'],
          testOnly: true,
        }),
        envVar('BUILD_ID', { used: true, usedIn: ['app/page.tsx'] }),
        envVar('API_KEY', { used: true, usedIn: ['app/api.ts'] }),
      ],
    )
    expect(subjectsOf(findUndocumented(env, { configProvided: new Set(['BUILD_ID']) }))).toEqual(['API_KEY'])
  })

  it('in a workspace, only points at examples of the same package or above it', () => {
    const packages = ['apps/api', 'apps/web', 'packages/db']
    const env = environment(
      [envFile('apps/web/.env.example', 'example'), envFile('packages/db/config/.env.example', 'example')],
      [
        envVar('STRIPE_KEY', { used: true, usedIn: ['apps/api/src/billing.ts'] }),
        envVar('DATABASE_URL', { used: true, usedIn: ['packages/db/src/client.ts'] }),
        envVar('SITE_URL', { used: true, usedIn: ['apps/web/app/page.tsx'] }),
      ],
    )
    const found = findUndocumented(env, { packages })
    expect(found.map((d) => [d.subject, d.message, d.hint, d.files])).toEqual([
      [
        'STRIPE_KEY',
        'STRIPE_KEY is used in apps/api but no example env file there documents it',
        'Create apps/api/.env.example with STRIPE_KEY=',
        ['apps/api/src/billing.ts'],
      ],
      [
        'DATABASE_URL',
        'DATABASE_URL is used in code but missing from packages/db/config/.env.example',
        'Add DATABASE_URL= to packages/db/config/.env.example',
        ['packages/db/src/client.ts', 'packages/db/config/.env.example'],
      ],
      [
        'SITE_URL',
        'SITE_URL is used in code but missing from apps/web/.env.example',
        'Add SITE_URL= to apps/web/.env.example',
        ['apps/web/app/page.tsx', 'apps/web/.env.example'],
      ],
    ])
    expectWellFormed(found)
  })

  it('is skipped when the only example file could not be read', async () => {
    const sections = makeSections({
      environment: environment([EXAMPLE], [envVar('API_KEY', { used: true, usedIn: ['a.ts'] })]),
    })
    const ctx = await projectContext()
    ctx.warn({
      kind: 'size',
      file: '.env.example',
      message: 'Skipped .env.example because it is larger than the read limit',
    })
    expect((await runRule(envUndocumented, sections, ctx)).checks[0]?.status).toBe('skipped')
  })
})

describe('ENV_LOCAL_ONLY', () => {
  it('reports variables set locally but not documented', () => {
    const env = environment(
      [EXAMPLE, LOCAL],
      [
        envVar('SECRET_TOKEN', { defined: true, definedIn: ['.env'] }),
        envVar('APP_TITLE', { defined: true, definedIn: ['.env'] }),
      ],
    )
    const found = findLocalOnly(env)
    expect(subjectsOf(found)).toEqual(['SECRET_TOKEN', 'APP_TITLE'])
    expect(found[0]).toMatchObject({
      severity: 'warning',
      message: 'SECRET_TOKEN is set in .env but missing from .env.example',
      files: ['.env', '.env.example'],
    })
    expectWellFormed(found)
  })

  it('leaves variables that are also used in code to ENV_UNDOCUMENTED', () => {
    const env = environment(
      [EXAMPLE, LOCAL],
      [envVar('VITE_SENTRY_DSN', { defined: true, used: true, definedIn: ['.env'] })],
    )
    expect(findLocalOnly(env)).toEqual([])
    expect(subjectsOf(findUndocumented(env))).toEqual(['VITE_SENTRY_DSN'])
  })

  it('does not report documented variables, platform variables, or projects without an example', () => {
    const documented = envVar('A', {
      defined: true,
      documented: true,
      definedIn: ['.env'],
      documentedIn: ['.env.example'],
    })
    const platform = envVar('NODE_ENV', { defined: true, definedIn: ['.env'] })
    expect(findLocalOnly(environment([EXAMPLE, LOCAL], [documented, platform]))).toEqual([])
    expect(findLocalOnly(environment([LOCAL], [envVar('B', { defined: true, definedIn: ['.env'] })]))).toEqual([])
  })

  it('leaves .envrc alone: it holds direnv settings, not the app configuration', async () => {
    const envrc = envFile('.envrc', 'local', { variables: 1 })
    const env = environment([EXAMPLE, envrc], [envVar('AWS_PROFILE', { defined: true, definedIn: ['.envrc'] })])
    expect(findLocalOnly(env)).toEqual([])
    expect((await runRule(envLocalOnly, makeSections({ environment: env }))).checks[0]?.status).toBe('skipped')
  })

  it('never points at mode or service files', () => {
    const env = environment(
      [EXAMPLE, envFile('.env.db', 'service'), envFile('.env.production', 'mode')],
      [
        envVar('POSTGRES_PASSWORD', { defined: true, definedIn: ['.env.db'] }),
        envVar('VITE_API_URL', { defined: true, definedIn: ['.env.production'] }),
      ],
    )
    expect(findLocalOnly(env)).toEqual([])
  })

  it('runs through the rule object', async () => {
    const sections = makeSections({
      environment: environment([EXAMPLE, LOCAL], [envVar('ONLY_LOCAL', { defined: true, definedIn: ['.env'] })]),
    })
    const result = await runRule(envLocalOnly, sections)
    expect(result.checks[0]?.status).toBe('failed')
    expect(result.diagnostics[0]?.subject).toBe('ONLY_LOCAL')
  })
})

describe('ENV_EXAMPLE_MISSING', () => {
  it('reports once when code uses variables and no example exists, listing up to five names', () => {
    const names = ['A_ONE', 'B_TWO', 'C_THREE', 'D_FOUR', 'E_FIVE', 'F_SIX', 'G_SEVEN']
    const env = environment(
      [],
      names.map((name) => envVar(name, { used: true, usedIn: [`src/${name.toLowerCase()}.ts`] })),
    )
    const found = findExampleMissing(env, 'application')
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      code: 'ENV_EXAMPLE_MISSING',
      severity: 'warning',
      message: 'No .env.example documents the 7 environment variables used in code',
      hint: 'Create .env.example with the variable names and empty values: A_ONE=, B_TWO=, C_THREE=, D_FOUR=, E_FIVE= (and 2 more)',
      subject: '.env.example',
    })
    expect(found[0]?.files).toHaveLength(5)
    expectWellFormed(found)
  })

  it('reports a local env file without an example next to it', () => {
    const env = environment(
      [envFile('apps/web/.env.local', 'local')],
      [envVar('TOKEN', { defined: true, definedIn: ['apps/web/.env.local'] })],
    )
    expect(findExampleMissing(env, 'application')[0]).toMatchObject({
      message: 'apps/web/.env.local exists but there is no apps/web/.env.example documenting which variables to set',
      files: ['apps/web/.env.local'],
      subject: 'apps/web/.env.example',
    })
  })

  it('is informational for libraries and CLIs that only read optional settings', () => {
    const env = environment([], [envVar('MY_CLI_THEME', { used: true, usedIn: ['src/cli.ts'] })])
    expect(findExampleMissing(env, 'cli')[0]?.severity).toBe('info')
    expect(findExampleMissing(env, 'library')[0]?.severity).toBe('info')
  })

  it('does not report when an example exists, or only platform variables are used', () => {
    expect(findExampleMissing(environment([EXAMPLE], [envVar('A', { used: true })]), 'application')).toEqual([])
    expect(findExampleMissing(environment([], [envVar('NODE_ENV', { used: true })]), 'application')).toEqual([])
    expect(findExampleMissing(environment([], []), 'application')).toEqual([])
  })

  it('ignores variables with a default in code, platform, test-only and config-provided variables', () => {
    const env = environment(
      [],
      [
        envVar('PORT', { used: true, usedIn: ['src/server.ts'], fallback: true }),
        envVar('GITHUB_SHA', { used: true, usedIn: ['scripts/release.ts'] }),
        envVar('E2E_URL', { used: true, usedIn: ['e2e/a.ts'], testOnly: true }),
        envVar('BUILD_ID', { used: true, usedIn: ['app/page.tsx'] }),
      ],
    )
    expect(findExampleMissing(env, 'application', new Set(['BUILD_ID']))).toEqual([])
    const withNeeded = environment([], [...env.variables, envVar('API_KEY', { used: true, usedIn: ['src/a.ts'] })])
    expect(findExampleMissing(withNeeded, 'application', new Set(['BUILD_ID']))[0]?.hint).toBe(
      'Create .env.example with the variable names and empty values: API_KEY=',
    )
  })

  it('does not count mode, service or .envrc files as a local env file needing a template', () => {
    const env = environment(
      [envFile('.env.production', 'mode'), envFile('.env.db', 'service'), envFile('.envrc', 'local')],
      [envVar('POSTGRES_PASSWORD', { defined: true, definedIn: ['.env.db'] })],
    )
    expect(findExampleMissing(env, 'application')).toEqual([])
  })

  it('is skipped when the project has no env files and uses no variables', async () => {
    const result = await runRule(envExampleMissing, makeSections())
    expect(result.checks[0]?.status).toBe('skipped')
  })
})

describe('ENV_UNUSED', () => {
  const documented = (name: string) => envVar(name, { documented: true, documentedIn: ['.env.example'] })

  it('reports documented variables that nothing references', () => {
    const found = findUnused(environment([EXAMPLE], [documented('LEGACY_FLAG')]), {
      hasSourceFiles: true,
      services: NO_SERVICES,
    })
    expect(found).toEqual([
      {
        code: 'ENV_UNUSED',
        severity: 'info',
        category: 'environment',
        message: 'LEGACY_FLAG is documented in .env.example but never referenced in code',
        hint: 'Remove LEGACY_FLAG from .env.example if nothing reads it any more',
        files: ['.env.example'],
        subject: 'LEGACY_FLAG',
      },
    ])
  })

  it('stays quiet when usage scanning was truncated or there is no source code', () => {
    const env = environment([EXAMPLE], [documented('X')])
    expect(findUnused({ ...env, usageTruncated: true }, { hasSourceFiles: true, services: NO_SERVICES })).toEqual([])
    expect(findUnused(env, { hasSourceFiles: false, services: NO_SERVICES })).toEqual([])
  })

  it('skips variables consumed by Compose services, Docker build args and tools', () => {
    const services: ServicesSection = {
      composeFiles: ['docker-compose.yml'],
      services: [service('db', { environment: ['POSTGRES_PASSWORD'] })],
      dockerfiles: [{ path: 'Dockerfile', baseImages: ['node:22'], stages: 1, exposes: [], args: ['NPM_TOKEN'] }],
    }
    const env = environment(
      [EXAMPLE],
      ['POSTGRES_PASSWORD', 'NPM_TOKEN', 'NUXT_PUBLIC_API_BASE', 'PORT', 'NODE_ENV'].map(documented),
    )
    expect(findUnused(env, { hasSourceFiles: true, services })).toEqual([])
  })

  it('skips variables next to a compose file whose services load an env_file', () => {
    const services: ServicesSection = {
      composeFiles: ['compose.yaml'],
      services: [service('app', { source: 'compose.yaml', envFiles: ['.env'] })],
      dockerfiles: [],
    }
    expect(findUnused(environment([EXAMPLE], [documented('ANYTHING')]), { hasSourceFiles: true, services })).toEqual([])
  })

  it('skips names that source code mentions or that tools read on their own', () => {
    const env = environment([EXAMPLE], ['LIB_READ_FLAG', 'GIN_MODE', 'STALE_FLAG'].map(documented))
    const found = findUnused(env, {
      hasSourceFiles: true,
      services: NO_SERVICES,
      mentioned: new Set(['LIB_READ_FLAG']),
    })
    expect(subjectsOf(found)).toEqual(['STALE_FLAG'])
  })

  it('uses the mentions the environment detector collected', async () => {
    const ctx = await projectContext({
      '.env.example': 'LIB_READ_FLAG=\nSTALE_FLAG=\n',
      'src/index.ts': "export const flags = ['LIB_READ_FLAG'] // STALE_FLAG is gone\n",
    })
    const sections = makeSections({
      environment: environment([EXAMPLE], ['LIB_READ_FLAG', 'STALE_FLAG'].map(documented)),
    })
    expect(subjectsOf(await runCheck(envUnused, sections, ctx))).toEqual(['STALE_FLAG'])
  })

  it('checks for source files through the rule', async () => {
    const sections = makeSections({ environment: environment([EXAMPLE], [documented('UNUSED_THING')]) })
    const empty = await projectContext({ '.env.example': 'UNUSED_THING=\n' })
    expect(await runCheck(envUnused, sections, empty)).toEqual([])
    const withCode = await projectContext({ '.env.example': 'UNUSED_THING=\n', 'src/index.ts': 'export {}\n' })
    expect(subjectsOf(await runCheck(envUnused, sections, withCode))).toEqual(['UNUSED_THING'])
    // Without code to look at, the check is skipped rather than passed.
    expect((await runRule(envUnused, sections, empty)).checks[0]?.status).toBe('skipped')
    expect((await runRule(envUnused, sections, withCode)).checks[0]?.status).toBe('failed')
  })
})

describe('ENV_MISSING_LOCAL', () => {
  const needed = (name: string, overrides = {}) =>
    envVar(name, { documented: true, used: true, documentedIn: ['.env.example'], usedIn: ['src/a.ts'], ...overrides })

  it('reports documented, used variables missing from the root .env', () => {
    const found = findMissingLocal(environment([EXAMPLE, LOCAL], [needed('DATABASE_URL')]))
    expect(found).toEqual([
      {
        code: 'ENV_MISSING_LOCAL',
        severity: 'info',
        category: 'environment',
        message: 'DATABASE_URL is not set in .env',
        hint: 'Add DATABASE_URL= with your local value to .env (see .env.example)',
        files: ['.env', '.env.example'],
        subject: 'DATABASE_URL',
      },
    ])
  })

  it('names .env.local when that is the only root local file', () => {
    const found = findMissingLocal(environment([EXAMPLE, envFile('.env.local', 'local')], [needed('API_URL')]))
    expect(found[0]?.message).toBe('API_URL is not set in .env.local')
  })

  it('ignores defined, unused, nested-only and platform variables', () => {
    const env = environment(
      [EXAMPLE, LOCAL],
      [
        needed('DEFINED', { defined: true, definedIn: ['.env'] }),
        needed('UNUSED', { used: false }),
        needed('NESTED', { documentedIn: ['apps/api/.env.example'] }),
        needed('NODE_ENV'),
      ],
    )
    expect(findMissingLocal(env)).toEqual([])
  })

  it('only suggests local files, and counts mode files as setting a variable', () => {
    const env = environment(
      [EXAMPLE, envFile('.env.db', 'service'), envFile('.env.development', 'mode'), LOCAL],
      [
        needed('DATABASE_URL', { defined: true, definedIn: ['.env.db'] }),
        needed('VITE_API_URL', { defined: true, definedIn: ['.env.development'] }),
        needed('PORT', { fallback: true }),
      ],
    )
    expect(findMissingLocal(env).map((d) => d.message)).toEqual(['DATABASE_URL is not set in .env'])
    const serviceOnly = environment([EXAMPLE, envFile('.env.db', 'service')], [needed('DATABASE_URL')])
    expect(findMissingLocal(serviceOnly)).toEqual([])
  })

  it('does not apply without a root local env file', async () => {
    const sections = makeSections({
      environment: environment([EXAMPLE, envFile('apps/api/.env', 'local')], [needed('X')]),
    })
    expect((await runRule(envMissingLocal, sections)).checks[0]?.status).toBe('skipped')
  })
})

describe('environment rules on scanned projects', () => {
  it('ignores sample Compose files and example env files, and a PORT with a default', async () => {
    const dir = await makeProject({
      'package.json': JSON.stringify({ name: 'app', private: true }),
      'src/server.ts': 'export const port = process.env.PORT ?? 3000\n',
      'examples/demo/compose.yaml': 'services:\n  demo:\n    image: redis\n    command: ${DEMO_TOKEN}\n',
      'examples/demo/.env.example': 'DEMO_TOKEN=\n',
      'examples/demo/.env': 'DEMO_TOKEN=1\n',
      'templates/app/compose.yaml': 'services:\n  t:\n    image: ${TEMPLATE_IMAGE}\n',
      'test/fixtures/app/compose.yaml': 'services:\n  f:\n    image: ${FIXTURE_IMAGE}\n',
    })
    const result = await scanDir(dir)
    const codes = result.doctor.diagnostics.map((d) => d.code)
    expect(codes.filter((code) => code.startsWith('ENV_'))).toEqual([])
    expect(result.doctor.checks.find((c) => c.code === 'ENV_EXAMPLE_MISSING')?.status).toBe('passed')
  })
})
