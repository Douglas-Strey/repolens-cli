// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings test literal ${...} interpolation syntax.
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { EnvFileEntry } from '../../src/core/dotenv.ts'
import {
  composeReferences,
  destructuredEntries,
  destructuredKeys,
  envFileDirectories,
  environmentAnalysis,
  environmentDetector,
  extractComposeUsages,
  extractEnvReferences,
  extractEnvUsages,
  extractHtmlEnvUsages,
  isPublicName,
  isTestUsagePath,
  mergeVariables,
  nextConfigProvidedNames,
  nuxtRuntimeConfigNames,
  type ParsedEnvFile,
  PUBLIC_PREFIXES,
  selectEnvFiles,
  type Usage,
} from '../../src/detectors/environment.ts'
import { isProjectComposeFile } from '../../src/facts/compose.ts'
import type { ProjectManifests } from '../../src/facts/manifests.ts'
import type { EnvFile, EnvironmentSection, EnvVariable } from '../../src/types.ts'
import { canSymlink, contextFor, copyFixture, gitInit, makeProject, SECRET_SENTINEL, timeBudget } from '../helpers.ts'

// PEM markers are assembled at runtime so no credential-shaped text is committed.
const BEGIN_KEY = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ')
const END_KEY = ['-----END', 'PRIVATE KEY-----'].join(' ')

// Credential-shaped strings are assembled at runtime so no real-looking token is committed.
const STRIPE_LIVE = `sk_${'live_'}${'a'.repeat(24)}`
const GITHUB_TOKEN = `ghp_${'x'.repeat(36)}`

interface Detected {
  env: EnvironmentSection
  /** Everything the scan could surface: the section, warnings and debug output. */
  surface: string
}

async function detect(dir: string): Promise<Detected> {
  const logs: string[] = []
  const ctx = await contextFor(dir, { debug: (message) => logs.push(message) })
  const env = await ctx.use(environmentDetector)
  return { env, surface: JSON.stringify({ env, warnings: ctx.warnings, logs }) }
}

function variable(env: EnvironmentSection, name: string): EnvVariable {
  const found = env.variables.find((v) => v.name === name)
  if (!found) throw new Error(`variable ${name} not detected`)
  return found
}

function flags(env: EnvironmentSection, name: string) {
  const v = variable(env, name)
  return { defined: v.defined, documented: v.documented, used: v.used }
}

/**
 * Fragments of every value in a directory's env and Compose files, read
 * independently of the parser under test: whole values plus URL credentials,
 * hosts and host:port pairs. None of them may appear in RepoLens output.
 */
async function secretFragments(dir: string): Promise<string[]> {
  const fragments = new Set<string>([SECRET_SENTINEL])
  const entries = await fs.readdir(dir, { recursive: true })
  for (const relative of entries) {
    const name = path.basename(relative)
    if (!/^\.env|\.env$|compose.*\.ya?ml$/.test(name)) continue
    const text = await fs.readFile(path.join(dir, relative), 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*(?:-\s*)?(?:export\s+)?[\w.-]+\s*[=:]\s*(.+)$/.exec(line)
      const value = match?.[1]?.trim().replace(/^(["'`])(.*)\1$/, '$2')
      if (!value || value.length < 4 || /^\d+$/.test(value) || line.trimStart().startsWith('#')) continue
      // Compose structure (image names, ports, keys) is not secret; only values of env-like entries matter.
      if (/compose/.test(name) && !/^\s*(?:-\s*)?[A-Z][A-Z0-9_]*\s*[=:]/.test(line)) continue
      fragments.add(value)
      try {
        const url = new URL(value)
        if (url.password) fragments.add(`${url.username}:${url.password}`)
        if (url.hostname.length >= 5) fragments.add(url.hostname)
        if (url.port) fragments.add(`${url.hostname}:${url.port}`)
      } catch {
        // Not a URL.
      }
    }
  }
  return [...fragments]
}

async function expectNoLeaks(dir: string, surface: string): Promise<void> {
  const fragments = await secretFragments(dir)
  expect(fragments.length).toBeGreaterThan(1)
  for (const fragment of fragments) expect(surface, `leaked "${fragment}"`).not.toContain(fragment)
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

describe('environment detector on fixtures', () => {
  it('broken-env: finds undocumented, unused and defined-only variables without leaking values', async () => {
    const dir = await copyFixture('broken-env')
    const { env, surface } = await detect(dir)
    await expectNoLeaks(dir, surface)

    expect(env.files).toEqual([
      { path: '.env', kind: 'local', variables: 6, ignored: false, tracked: null },
      { path: '.env.example', kind: 'example', variables: 3, ignored: false, tracked: null },
    ])
    for (const name of ['VITE_SENTRY_DSN', 'VITE_FEATURE_FLAGS', 'ANALYTICS_KEY', 'LEGACY_TOKEN']) {
      expect(variable(env, name).used, name).toBe(true)
      expect(variable(env, name).documented, name).toBe(false)
    }
    expect(variable(env, 'VITE_FEATURE_FLAGS').usedIn).toEqual(['src/api.ts'])
    expect(variable(env, 'ANALYTICS_KEY').usedIn).toEqual(['src/legacy.js'])
    expect(flags(env, 'LEGACY_FLAG')).toEqual({ defined: false, documented: true, used: false })
    expect(flags(env, 'EXPORTED_VAR')).toEqual({ defined: true, documented: false, used: false })
    expect(flags(env, 'APP_TITLE')).toEqual({ defined: true, documented: false, used: false })
    expect(flags(env, 'SECRET_TOKEN')).toEqual({ defined: true, documented: false, used: false })
    expect(flags(env, 'API_URL')).toEqual({ defined: true, documented: true, used: true })
    expect(variable(env, 'API_URL').usedIn).toEqual(['src/legacy.js', 'vite.config.ts'])

    const names = env.variables.map((v) => v.name)
    expect(names).not.toContain('OLD_KEY')
    expect(names).not.toContain('MODE')
    expect(names).not.toContain('DEV')
    expect(names).toEqual([...names].sort())

    expect(variable(env, 'VITE_SENTRY_DSN')).toMatchObject({
      public: true,
      sensitive: false,
      definedIn: ['.env'],
      endpoints: [{ file: '.env', scheme: 'https', port: null, local: false }],
    })
    expect(variable(env, 'SECRET_TOKEN').sensitive).toBe(true)
    expect(variable(env, 'LEGACY_TOKEN').sensitive).toBe(true)
    expect(env.usageTruncated).toBe(false)
  })

  it('next-app: AUTH_SECRET is used but undocumented; Prisma env() counts as usage', async () => {
    const dir = await copyFixture('next-app')
    const { env, surface } = await detect(dir)
    await expectNoLeaks(dir, surface)

    expect(env.files).toEqual([
      { path: '.env.example', kind: 'example', variables: 2, ignored: false, tracked: null },
      { path: '.env.local', kind: 'local', variables: 2, ignored: true, tracked: null },
    ])
    expect(flags(env, 'AUTH_SECRET')).toEqual({ defined: false, documented: false, used: true })
    expect(variable(env, 'AUTH_SECRET').usedIn).toEqual(['lib/auth.ts'])
    expect(variable(env, 'DATABASE_URL')).toMatchObject({
      defined: true,
      documented: true,
      used: true,
      usedIn: ['lib/db.ts', 'prisma/schema.prisma'],
      endpoints: [{ file: '.env.local', scheme: 'postgres', port: 5432, local: true }],
    })
    expect(variable(env, 'NEXT_PUBLIC_SITE_URL').public).toBe(true)
  })

  it('monorepo: gitignored root .env is found; STRIPE_SECRET_KEY is used but in neither file', async () => {
    const dir = await copyFixture('monorepo')
    const { env, surface } = await detect(dir)
    await expectNoLeaks(dir, surface)

    expect(env.files).toEqual([
      { path: '.env', kind: 'local', variables: 3, ignored: true, tracked: null },
      { path: '.env.example', kind: 'example', variables: 3, ignored: false, tracked: null },
    ])
    expect(flags(env, 'STRIPE_SECRET_KEY')).toEqual({ defined: false, documented: false, used: true })
    expect(variable(env, 'STRIPE_SECRET_KEY').usedIn).toEqual(['apps/api/src/index.ts'])
    expect(variable(env, 'DATABASE_URL').usedIn).toEqual(['apps/api/prisma/schema.prisma', 'apps/api/src/index.ts'])
    expect(variable(env, 'REDIS_URL').endpoints).toEqual([
      { file: '.env', scheme: 'redis', port: 6379, local: true },
      { file: '.env.example', scheme: 'redis', port: 6379, local: true },
    ])
    // Compose `environment:` keys define values for containers; they are not usages.
    const names = env.variables.map((v) => v.name)
    expect(names).not.toContain('POSTGRES_PASSWORD')
    expect(names).not.toContain('MINIO_ROOT_USER')
  })

  it('docker-project: reports the documented port for the doctor, ignores compose environment names', async () => {
    const dir = await copyFixture('docker-project')
    const { env, surface } = await detect(dir)
    await expectNoLeaks(dir, surface)

    expect(env.files).toEqual([{ path: '.env.example', kind: 'example', variables: 3, ignored: false, tracked: null }])
    expect(variable(env, 'DATABASE_URL')).toMatchObject({
      documented: true,
      used: true,
      usedIn: ['src/server.js', 'worker.js'],
      endpoints: [{ file: '.env.example', scheme: 'postgres', port: 5433, local: true }],
      suspiciousValueIn: [],
    })
    expect(flags(env, 'SESSION_SECRET')).toEqual({ defined: false, documented: true, used: true })
    const names = env.variables.map((v) => v.name)
    expect(names).not.toContain('POSTGRES_PASSWORD')
    expect(names).not.toContain('NODE_ENV')
  })

  it('nuxt-app: runtimeConfig keys mark NUXT_PUBLIC_* variables as used', async () => {
    const { env } = await detect(await copyFixture('nuxt-app'))
    expect(variable(env, 'NUXT_PUBLIC_API_BASE')).toMatchObject({
      documented: true,
      used: true,
      usedIn: ['nuxt.config.ts'],
    })
    // runtimeConfig.stripeSecretKey maps to NUXT_STRIPE_SECRET_KEY, which no env file declares: no new variable.
    expect(env.variables.map((v) => v.name)).not.toContain('NUXT_STRIPE_SECRET_KEY')
  })

  it('bun-app and go-api: Bun.env and os.Getenv usages', async () => {
    const bun = (await detect(await copyFixture('bun-app'))).env
    expect(bun.files).toEqual([])
    expect(bun.variables.map((v) => [v.name, v.used])).toEqual([
      ['PORT', true],
      ['WEBHOOK_SECRET', true],
    ])
    const go = (await detect(await copyFixture('go-api'))).env
    expect(variable(go, 'REDIS_ADDR')).toMatchObject({
      documented: true,
      usedIn: ['cmd/worker/main.go'],
      endpoints: [{ file: '.env.example', scheme: 'tcp', port: 6379, local: true }],
    })
  })
})

// ---------------------------------------------------------------------------
// Temporary projects
// ---------------------------------------------------------------------------

describe('environment detector on temporary projects', () => {
  it('flags credential-shaped values in example files without ever outputting them', async () => {
    const dir = await makeProject({
      '.env.example': `STRIPE_SECRET_KEY=${STRIPE_LIVE}\nGITHUB_TOKEN="${GITHUB_TOKEN}"\nPLACEHOLDER=changeme\n`,
      'src/index.ts': 'export const key = process.env.STRIPE_SECRET_KEY\n',
    })
    const { env, surface } = await detect(dir)
    expect(variable(env, 'STRIPE_SECRET_KEY').suspiciousValueIn).toEqual(['.env.example'])
    expect(variable(env, 'GITHUB_TOKEN').suspiciousValueIn).toEqual(['.env.example'])
    expect(variable(env, 'PLACEHOLDER').suspiciousValueIn).toEqual([])
    expect(surface).not.toContain(STRIPE_LIVE)
    expect(surface).not.toContain(GITHUB_TOKEN)
    expect(surface).not.toContain('changeme')
  })

  it('does not flag real secrets in local files, and still never outputs them', async () => {
    const dir = await makeProject({
      '.env': `STRIPE_SECRET_KEY=${STRIPE_LIVE}\nGITHUB_TOKEN=${GITHUB_TOKEN}\n`,
      '.env.local': `STRIPE_SECRET_KEY="${STRIPE_LIVE}"\n`,
    })
    const { env, surface } = await detect(dir)
    expect(variable(env, 'STRIPE_SECRET_KEY')).toMatchObject({
      defined: true,
      definedIn: ['.env', '.env.local'],
      suspiciousValueIn: [],
    })
    expect(variable(env, 'GITHUB_TOKEN').suspiciousValueIn).toEqual([])
    expect(surface).not.toContain(STRIPE_LIVE)
    expect(surface).not.toContain(GITHUB_TOKEN)
  })

  it('finds a gitignored .env and reports ignored/tracked from .gitignore and the Git index', async () => {
    const committed = await makeProject({
      '.gitignore': 'node_modules\n',
      '.env': `TOKEN=${SECRET_SENTINEL}\n`,
      '.env.example': 'TOKEN=\n',
    })
    gitInit(committed)
    const tracked = (await detect(committed)).env
    expect(tracked.files).toEqual([
      { path: '.env', kind: 'local', variables: 1, ignored: false, tracked: true },
      { path: '.env.example', kind: 'example', variables: 1, ignored: false, tracked: true },
    ])

    const ignored = await makeProject({
      '.gitignore': '.env\n',
      '.env': `TOKEN=${SECRET_SENTINEL}\n`,
      '.env.example': 'TOKEN=\n',
    })
    gitInit(ignored, ['.gitignore', '.env.example'])
    const { env, surface } = await detect(ignored)
    expect(env.files).toEqual([
      { path: '.env', kind: 'local', variables: 1, ignored: true, tracked: false },
      { path: '.env.example', kind: 'example', variables: 1, ignored: false, tracked: true },
    ])
    expect(flags(env, 'TOKEN')).toEqual({ defined: true, documented: true, used: false })
    expect(surface).not.toContain(SECRET_SENTINEL)
  })

  it('skips a 2 MB .env without crashing and keeps listing it', async () => {
    const dir = await makeProject({
      '.env': `HUGE=${SECRET_SENTINEL}${'x'.repeat(2 * 1024 * 1024)}\n`,
      '.env.example': 'HUGE=\n',
    })
    const logs: string[] = []
    const ctx = await contextFor(dir, { debug: (message) => logs.push(message) })
    const env = await ctx.use(environmentDetector)
    expect(env.files).toContainEqual({ path: '.env', kind: 'local', variables: 0, ignored: false, tracked: null })
    expect(ctx.warnings).toContainEqual(expect.objectContaining({ file: '.env' }))
    expect(flags(env, 'HUGE')).toEqual({ defined: false, documented: true, used: false })
    expect(JSON.stringify({ env, warnings: ctx.warnings, logs })).not.toContain(SECRET_SENTINEL)
  })

  it.skipIf(!canSymlink)('never reads an env file symlinked to a file outside the project', async () => {
    const outside = await makeProject({ 'secrets.env': `LEAKED_NAME=${SECRET_SENTINEL}\n` })
    const dir = await makeProject({ '.env.example': 'DOCUMENTED=\n' })
    await fs.symlink(path.join(outside, 'secrets.env'), path.join(dir, '.env'))
    const { env, surface } = await detect(dir)
    expect(env.variables.map((v) => v.name)).toEqual(['DOCUMENTED'])
    expect(surface).not.toContain('LEAKED_NAME')
    expect(surface).not.toContain(SECRET_SENTINEL)
  })

  it('lists .env.vault without parsing it and treats .envrc as defining variables', async () => {
    const dir = await makeProject({
      '.env.vault': `DOTENV_VAULT_DEVELOPMENT="${SECRET_SENTINEL}"\n`,
      '.envrc': `export DIRENV_VAR=${SECRET_SENTINEL}\nuse nix\nPATH_add bin\n`,
    })
    const { env, surface } = await detect(dir)
    expect(env.files).toEqual([
      { path: '.env.vault', kind: 'other', variables: 0, ignored: false, tracked: null },
      { path: '.envrc', kind: 'local', variables: 1, ignored: false, tracked: null },
    ])
    expect(env.variables.map((v) => [v.name, v.defined, v.definedIn])).toEqual([['DIRENV_VAR', true, ['.envrc']]])
    expect(surface).not.toContain(SECRET_SENTINEL)
  })

  it('looks in package and Compose directories up to depth 3, not in arbitrary or test directories', async () => {
    const dir = await makeProject({
      'package.json': JSON.stringify({ name: 'root', private: true, workspaces: ['apps/*', 'deep/a/b/*'] }),
      'apps/web/package.json': JSON.stringify({ name: 'web' }),
      'apps/web/.env': 'WEB_VAR=1\n',
      'apps/web/.env.example': 'WEB_VAR=\n',
      'deep/a/b/c/package.json': JSON.stringify({ name: 'deep' }),
      'deep/a/b/c/.env': 'TOO_DEEP=1\n',
      'infra/compose.yaml': 'services:\n  db:\n    image: postgres:17\n',
      'infra/.env': 'INFRA_VAR=1\n',
      'docs/.env': 'DOCS_VAR=1\n',
      'test/fixtures/app/compose.yaml': 'services: {}\n',
      'test/fixtures/app/.env': 'FIXTURE_VAR=1\n',
      'app.env.ts': 'export const x = 1\n',
      '.env.d.ts': 'export {}\n',
      'prod.env': 'PROD_VAR=1\n',
    })
    const { env } = await detect(dir)
    expect(env.files.map((f) => [f.path, f.kind])).toEqual([
      ['apps/web/.env', 'local'],
      ['apps/web/.env.example', 'example'],
      ['infra/.env', 'local'],
      ['prod.env', 'mode'],
    ])
  })

  it('counts Compose interpolations as usages but not environment keys', async () => {
    const dir = await makeProject({
      'docker-compose.yml': [
        'services:',
        '  db:',
        '    image: postgres:${POSTGRES_VERSION:-17}',
        '    ports:',
        '      - "${DB_PORT:-5432}:5432"',
        '    environment:',
        `      POSTGRES_PASSWORD: ${SECRET_SENTINEL}`,
        '      POSTGRES_USER: $DB_USER',
        '      ESCAPED: $$NOT_A_VAR',
        '    # command: ${COMMENTED_OUT}',
      ].join('\n'),
      '.env.example': 'DB_PORT=5432\n',
    })
    const { env, surface } = await detect(dir)
    expect(env.variables.map((v) => [v.name, v.used, v.usedIn])).toEqual([
      ['DB_PORT', true, ['docker-compose.yml']],
      ['DB_USER', true, ['docker-compose.yml']],
      ['POSTGRES_VERSION', true, ['docker-compose.yml']],
    ])
    expect(surface).not.toContain(SECRET_SENTINEL)
  })

  it('never surfaces fragments of Compose passwords or of PEM bodies in malformed env files', async () => {
    const dir = await makeProject({
      'compose.yaml': [
        'services:',
        '  proxy:',
        '    labels:',
        '      - "traefik.http.middlewares.auth.basicauth.users=admin:$apr1$H6uskkkW$IgXLP6ewTrSuBkTrqE8wj/"',
        '  db:',
        '    environment:',
        '      POSTGRES_PASSWORD: hunter$secret42',
        '      POSTGRES_DB: ${DB_NAME}',
      ].join('\n'),
      '.env': [
        'BROKEN="never closed',
        `SIGNING_KEY="${BEGIN_KEY}`,
        'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7',
        'Qm9v=',
        'xY_z-1=',
        `${END_KEY}"`,
        'AFTER=1',
      ].join('\n'),
    })
    const { env, surface } = await detect(dir)
    expect(env.variables.map((v) => v.name)).toEqual(['AFTER', 'BROKEN', 'DB_NAME'])
    for (const fragment of ['apr1', 'H6uskkkW', 'secret42', 'Qm9v', 'xY_z-1']) {
      expect(surface, fragment).not.toContain(fragment)
    }
  })

  it('caps usedIn at 5 sorted files', async () => {
    const files: Record<string, string> = {}
    for (const n of [9, 3, 7, 1, 5, 2, 8]) files[`src/file${n}.ts`] = 'export const e = process.env.NODE_ENV\n'
    const { env } = await detect(await makeProject(files))
    expect(variable(env, 'NODE_ENV').usedIn).toEqual([
      'src/file1.ts',
      'src/file2.ts',
      'src/file3.ts',
      'src/file5.ts',
      'src/file7.ts',
    ])
  })

  it('returns an empty section for a project without env files or usages', async () => {
    const { env } = await detect(await makeProject({ 'README.md': '# hello\n' }))
    expect(env).toEqual({ files: [], variables: [], usageTruncated: false })
  })

  it('survives binary and malformed env files', async () => {
    const dir = await makeProject({
      '.env': 'GOOD=1\n\u0000\u0001binary',
      '.env.example': '"""\n===\nexport\n\'unterminated\nOK=\n',
    })
    const { env } = await detect(dir)
    expect(env.files.map((f) => [f.path, f.variables])).toEqual([
      ['.env', 0],
      ['.env.example', 1],
    ])
    expect(env.variables.map((v) => v.name)).toEqual(['OK'])
  })
})

// ---------------------------------------------------------------------------
// Usage extraction
// ---------------------------------------------------------------------------

const usages = (text: string, ext = '.ts') => [...extractEnvUsages(text, ext)].sort()

describe('extractEnvUsages', () => {
  it('finds process.env in dot, optional and bracket forms', () => {
    const text = [
      'process.env.DOT',
      'process.env?.OPTIONAL',
      'process?.env?.BOTH',
      'process.env["DOUBLE"]',
      "process.env['SINGLE']",
      'process.env[`TICK`]',
      'process.env?.["OPT_BRACKET"]',
      "process.env['with-dash']",
      'process.env[dynamic]',
      'process.env.hasOwnProperty("X")',
      'myprocess.env.NOPE',
    ].join('\n')
    expect(usages(text)).toEqual(['BOTH', 'DOT', 'DOUBLE', 'OPTIONAL', 'OPT_BRACKET', 'SINGLE', 'TICK', 'with-dash'])
  })

  it('finds import.meta.env and excludes Vite and Astro built-ins', () => {
    const text = [
      'import.meta.env.VITE_API',
      "import.meta.env['VITE_BRACKET']",
      'import.meta.env.MODE',
      'import.meta.env.DEV',
      'import.meta.env.PROD',
      'import.meta.env.SSR',
      'import.meta.env.BASE_URL',
      'import.meta.env.SITE',
      'import.meta.env.ASSETS_PREFIX',
      'process.env.NODE_ENV',
    ].join('\n')
    expect(usages(text)).toEqual(['NODE_ENV', 'VITE_API', 'VITE_BRACKET'])
  })

  it('finds destructured names, skipping aliases targets, defaults and rest', () => {
    const text = [
      "const { A, B: alias, C = 'x', 'QUOTED': q, ...rest } = process.env",
      'let {\n  MULTI_LINE, // comment\n  /* block */ SECOND,\n} = process.env',
      'const { VITE_X, MODE } = import.meta.env',
      'const { TYPED }: Record<string, string | undefined> = process.env',
      'const { NOT_ENV } = process.env.SOMETHING',
      'const { BUN_VAR } = Bun.env',
    ].join('\n')
    expect(usages(text)).toEqual([
      'A',
      'B',
      'BUN_VAR',
      'C',
      'MULTI_LINE',
      'QUOTED',
      'SECOND',
      'SOMETHING',
      'TYPED',
      'VITE_X',
    ])
  })

  it('finds Deno, Bun, SvelteKit, Astro and Vite loadEnv usages', () => {
    expect(usages('Deno.env.get("DENO_VAR"); Deno.env.get(\'SINGLE\')')).toEqual(['DENO_VAR', 'SINGLE'])
    expect(usages('Bun.env.BUN_DOT; Bun.env["BUN_BRACKET"]')).toEqual(['BUN_BRACKET', 'BUN_DOT'])
    const svelte = [
      "import { SECRET_A, type SECRET_B, SECRET_C as c } from '$env/static/private'",
      "import { PUBLIC_D } from '$env/static/public'",
      "import { env } from '$env/dynamic/private'",
      "import { env as pub } from '$env/dynamic/public'",
      'env.DYNAMIC_E; pub.PUBLIC_F; pub["PUBLIC_G"]; other.env.NOPE',
    ].join('\n')
    expect(usages(svelte, '.svelte')).toEqual([
      'DYNAMIC_E',
      'PUBLIC_D',
      'PUBLIC_F',
      'PUBLIC_G',
      'SECRET_A',
      'SECRET_B',
      'SECRET_C',
    ])
    expect(usages("import { API_URL, getSecret } from 'astro:env/server'", '.astro')).toEqual(['API_URL'])
    const vite = [
      "const env = loadEnv(mode, process.cwd(), '')",
      'const { DESTRUCTURED } = loadEnv(mode, root)',
      'export default { define: { x: env.APP_ENV, y: env["APP_KEY"] } }',
    ].join('\n')
    expect(usages(vite)).toEqual(['APP_ENV', 'APP_KEY', 'DESTRUCTURED'])
  })

  it('finds NestJS ConfigService lookups for UPPER_SNAKE keys only', () => {
    const text = [
      "import { ConfigService } from '@nestjs/config'",
      'constructor(private readonly configService: ConfigService, private config: ConfigService) {}',
      "this.configService.get('DATABASE_URL')",
      "this.configService.get<string>('JWT_SECRET', 'fallback')",
      "this.config.getOrThrow<number>('PORT')",
      "this.configService.get('database.host')",
      "cache.get('NOT_CONFIG')",
    ].join('\n')
    expect(usages(text)).toEqual(['DATABASE_URL', 'JWT_SECRET', 'PORT'])
    // Without ConfigService in the file, `.get('X')` is not treated as an env lookup.
    expect(usages("config.get('DATABASE_URL')")).toEqual([])
  })

  it('finds Go os.Getenv, os.LookupEnv and struct tags', () => {
    const text = [
      'port := os.Getenv("PORT")',
      'v, ok := os.LookupEnv(`LOOKUP`)',
      'type Config struct {',
      '  DB string `env:"DATABASE_URL,required" envDefault:"x"`',
      '  Redis string `envconfig:"REDIS_ADDR"`',
      '  Name string `json:"name" yaml:"env"`',
      '}',
    ].join('\n')
    expect(usages(text, '.go')).toEqual(['DATABASE_URL', 'LOOKUP', 'PORT', 'REDIS_ADDR'])
  })

  it('reads env("NAME") only from Prisma schemas and prisma/config', () => {
    const prisma =
      'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n  directUrl = env("DIRECT_URL")\n}'
    expect(usages(prisma, '.prisma')).toEqual(['DATABASE_URL', 'DIRECT_URL'])
    expect(usages("env('NOT_PRISMA')")).toEqual([])
    expect(
      usages("import { defineConfig, env } from 'prisma/config'\nexport default defineConfig({ url: env('DB_URL') })"),
    ).toEqual(['DB_URL'])
  })

  it('ignores unknown extensions and files without env references', () => {
    expect(usages('process.env.X', '.md')).toEqual([])
    expect(usages('const x = 1', '.ts')).toEqual([])
  })

  it('handles large hostile input quickly', () => {
    const text = `${'{ a, '.repeat(50_000)}${'process.env'.repeat(10_000)}${'} = '.repeat(10_000)}`
    const started = performance.now()
    extractEnvUsages(text, '.ts')
    expect(performance.now() - started).toBeLessThan(timeBudget(2000))
  })

  it('follows loadEnv() bindings with a type annotation, and only bound names', () => {
    const text = [
      "const env: Record<string, string> = loadEnv(mode, process.cwd(), '')",
      'export default { a: env.TYPED_BINDING, b: other.NOT_BOUND, c: xenv.NOT_BOUND_EITHER }',
    ].join('\n')
    expect(usages(text)).toEqual(['TYPED_BINDING'])
  })
})

describe('extractEnvUsages and nuxtRuntimeConfigNames on hostile input', () => {
  // Source files up to MAX_SOURCE_FILE_BYTES (512 KiB) are scanned. Each case used to
  // take quadratic time (seconds at 256 KiB, minutes at 512 KiB); linear scans take milliseconds.
  const SIZE = 256 * 1024
  const fill = (prefix: string, unit: string, suffix = '') =>
    prefix + unit.repeat(Math.floor((SIZE - prefix.length - suffix.length) / unit.length)) + suffix
  let counter = 0
  const cases: Array<[string, () => unknown]> = [
    ['unclosed SvelteKit imports', () => extractEnvUsages(fill("'$env/'\n", 'import {'), '.svelte')],
    ['unclosed astro:env imports', () => extractEnvUsages(fill('astro:env\n', 'import {'), '.astro')],
    ['many loadEnv() bindings', () => extractEnvUsages(fill('', 'const e=loadEnv(\n'), '.ts')],
    [
      'many distinct loadEnv() bindings',
      () =>
        extractEnvUsages(
          fill('', 'x').replace(/x{24}/g, () => `const e${counter++}=loadEnv(\n`),
          '.ts',
        ),
    ],
    ['typed bindings without "="', () => extractEnvUsages(fill('loadEnv\n', 'const a:'), '.ts')],
    ['unclosed block comments in a destructuring', () => extractEnvUsages(fill('{', '/* ', '} = process.env'), '.ts')],
    [
      'unclosed block comments in an import',
      () => extractEnvUsages(fill('import {', '/* ', "} from '$env/static/private'"), '.ts'),
    ],
    ['deeply nested runtimeConfig', () => nuxtRuntimeConfigNames(fill('runtimeConfig: {', 'a:{'))],
    ['a huge upper-case runtimeConfig key', () => nuxtRuntimeConfigNames(fill('runtimeConfig: {', 'A', ': 1 }'))],
  ]
  it.each(cases)('%s', (_label, run) => {
    const started = performance.now()
    run()
    expect(performance.now() - started).toBeLessThan(timeBudget(1000))
  })
})

describe('destructuredKeys', () => {
  it('extracts property keys', () => {
    expect(destructuredKeys(" A, B: b, C = 'x', ...rest, [computed]: y, 'D-E': de ")).toEqual(['A', 'B', 'C', 'D-E'])
  })
})

describe('extractComposeUsages', () => {
  it('finds ${VAR}, defaults, required markers and bare $VAR, but not $$ escapes or comments', () => {
    const text = [
      'image: app:${TAG}',
      'ports: ["${HOST_PORT:-3000}:3000"]',
      'command: ${CMD?must be set} $BARE $$ESCAPED $${ALSO_ESCAPED}',
      'nested: ${OUTER:-${INNER}}',
      '# ${COMMENTED}',
      'environment:',
      '  PLAIN_KEY: value',
    ].join('\n')
    expect([...extractComposeUsages(text)].sort()).toEqual(['BARE', 'CMD', 'HOST_PORT', 'INNER', 'OUTER', 'TAG'])
  })

  it('never reports fragments of passwords or hashes that contain an unescaped "$"', () => {
    const text = [
      '    labels:',
      '      - "traefik.http.middlewares.auth.basicauth.users=admin:$apr1$H6uskkkW$IgXLP6ewTrSuBkTrqE8wj/"',
      '    environment:',
      '      DB_PASSWORD: hunter$secret42',
      '      OTHER_PASSWORD: Passw0rd$UPPER',
      '      BCRYPT: $2b$10$abcdefghijklmnopqrstuv',
    ].join('\n')
    expect([...extractComposeUsages(text)]).toEqual([])
  })

  it('keeps deliberate interpolations: braced names of any case and bare UPPER_SNAKE names', () => {
    const text = [
      'image: registry/app:$TAG',
      'url: postgres://$DB_USER:$DB_PASS@db/${db_name}',
      'command: --port=$PORT',
      'entry: $$$LITERAL_THEN_VAR',
    ].join('\n')
    expect([...extractComposeUsages(text)].sort()).toEqual([
      'DB_PASS',
      'DB_USER',
      'LITERAL_THEN_VAR',
      'PORT',
      'TAG',
      'db_name',
    ])
  })

  it('ignores trailing YAML comments but not "#" inside quotes', () => {
    const text = [
      '      - "5432:5432" # override with ${IN_COMMENT}',
      '    command: "echo #${IN_DOUBLE}"',
      "    entrypoint: 'a # ${IN_SINGLE}'",
      '    healthcheck: "say \\" # ${AFTER_ESCAPE}"',
      '    image: app:${TAG}#not-a-comment',
    ].join('\n')
    expect([...extractComposeUsages(text)].sort()).toEqual(['AFTER_ESCAPE', 'IN_DOUBLE', 'IN_SINGLE', 'TAG'])
  })
})

describe('nuxtRuntimeConfigNames', () => {
  it('maps runtimeConfig keys to NUXT_* names', () => {
    const text = `export default defineNuxtConfig({
  modules: ['@nuxt/eslint'],
  runtimeConfig: {
    // comment with { braces }
    apiSecret: process.env.API_SECRET || '',
    'quoted-key': '',
    myAPIKey: fn({ nested: '}' }, [1, 2]),
    redis: { host: '', port: 6379 },
    shorthand,
    ...spread,
    public: {
      apiBase: '',
      siteURL: \`\${x}\`,
    },
  },
  app: { head: { title: 'x' } },
})`
    expect([...nuxtRuntimeConfigNames(text)].sort()).toEqual([
      'NUXT_API_SECRET',
      'NUXT_MY_API_KEY',
      'NUXT_PUBLIC_API_BASE',
      'NUXT_PUBLIC_SITE_URL',
      'NUXT_QUOTED_KEY',
      'NUXT_REDIS_HOST',
      'NUXT_REDIS_PORT',
      'NUXT_SHORTHAND',
    ])
  })

  it('returns nothing without runtimeConfig and survives truncated input', () => {
    expect(nuxtRuntimeConfigNames('export default defineNuxtConfig({})').size).toBe(0)
    expect([...nuxtRuntimeConfigNames('runtimeConfig: { a: { b: "')]).toEqual(['NUXT_A_B'])
    expect([...nuxtRuntimeConfigNames('runtimeConfig: { a: fn(( [[ {{ ')]).toEqual(['NUXT_A'])
  })

  it('reads nested objects up to 8 levels and treats deeper ones as opaque values', () => {
    const nested = (depth: number): string => (depth === 0 ? "''" : `{ k${depth}: ${nested(depth - 1)}, x: 1 }`)
    const names = [...nuxtRuntimeConfigNames(`runtimeConfig: { a: ${nested(10)}, after: 1 }`)].sort()
    // Path a.k10…k5.x has 8 segments; k4's object sits at depth 8 and is not descended into.
    expect(names).toContain('NUXT_A_K10_K9_K8_K7_K6_K5_X')
    expect(names.some((name) => name.includes('K4'))).toBe(false)
    expect(names).toContain('NUXT_AFTER')
  })
})

// ---------------------------------------------------------------------------
// Merging and selection
// ---------------------------------------------------------------------------

function envFile(path: string, kind: EnvFile['kind'], entries: Array<Partial<EnvFileEntry> & { name: string }>) {
  const full: EnvFileEntry[] = entries.map((e, index) => ({
    line: index + 1,
    empty: false,
    endpoint: null,
    credentialPattern: null,
    ...e,
  }))
  const parsed: ParsedEnvFile = {
    file: { path, kind, variables: full.length, ignored: null, tracked: null },
    entries: full,
  }
  return parsed
}

/** Usage of a variable in some files; `required` = some reference has no default. */
function used(files: string[], required = true): Usage {
  return { files: new Set(files), required }
}

describe('mergeVariables', () => {
  it('merges definitions, documentation, usages, endpoints and suspicious values', () => {
    const endpoint = { file: '.env', scheme: 'postgres', port: 5432, local: true }
    const variables = mergeVariables(
      [
        envFile('.env', 'local', [
          { name: 'DATABASE_URL', endpoint },
          { name: 'LOCAL_ONLY', credentialPattern: 'x' },
        ]),
        envFile('.env.example', 'example', [
          { name: 'DATABASE_URL', endpoint: { ...endpoint, file: '.env.example', port: 5433 } },
          { name: 'NEXT_PUBLIC_URL', credentialPattern: 'github-token' },
        ]),
        envFile('.envrc', 'local', [{ name: 'DIRENV' }]),
      ],
      new Map([
        ['DATABASE_URL', used(['b.ts', 'a.ts'])],
        ['USED_ONLY', used(['c.ts'])],
      ]),
    )
    expect(variables.map((v) => v.name)).toEqual([
      'DATABASE_URL',
      'DIRENV',
      'LOCAL_ONLY',
      'NEXT_PUBLIC_URL',
      'USED_ONLY',
    ])
    expect(variables[0]).toEqual({
      name: 'DATABASE_URL',
      defined: true,
      documented: true,
      used: true,
      definedIn: ['.env'],
      documentedIn: ['.env.example'],
      usedIn: ['a.ts', 'b.ts'],
      fallback: false,
      testOnly: false,
      public: false,
      sensitive: false,
      endpoints: [endpoint, { file: '.env.example', scheme: 'postgres', port: 5433, local: true }],
      suspiciousValueIn: [],
    })
    expect(variables[1]).toMatchObject({ name: 'DIRENV', defined: true, documented: false })
    // Credential matches only count in documentation files.
    expect(variables[2]?.suspiciousValueIn).toEqual([])
    expect(variables[3]).toMatchObject({ public: true, suspiciousValueIn: ['.env.example'] })
    expect(variables[4]).toMatchObject({ defined: false, documented: false, used: true, usedIn: ['c.ts'] })
  })

  it('applies implicit usages only to names declared in env files', () => {
    const variables = mergeVariables(
      [envFile('.env.example', 'example', [{ name: 'NUXT_PUBLIC_API' }])],
      new Map(),
      new Map([
        ['NUXT_PUBLIC_API', new Set(['nuxt.config.ts'])],
        ['NUXT_UNDECLARED', new Set(['nuxt.config.ts'])],
      ]),
    )
    expect(variables.map((v) => [v.name, v.used, v.usedIn])).toEqual([['NUXT_PUBLIC_API', true, ['nuxt.config.ts']]])
  })

  it('drops implausible names', () => {
    expect(mergeVariables([], new Map([[GITHUB_TOKEN, used(['a.ts'])]]))).toEqual([])
  })
})

describe('env file selection', () => {
  const project = {
    packages: [{ dir: '.' }, { dir: 'apps/web' }],
    goModules: [{ dir: 'services/billing' }],
  } as unknown as ProjectManifests

  it('collects root, package, module and non-test Compose directories', () => {
    const dirs = envFileDirectories(project, [
      'compose.yaml',
      'infra/docker-compose.yml',
      'test/fixtures/x/compose.yaml',
    ])
    expect([...dirs].sort()).toEqual(['.', 'apps/web', 'infra', 'services/billing'])
  })

  it('selects env files in those directories up to depth 3', () => {
    const dirs = new Set(['.', 'apps/web', 'a/b/c/d'])
    const candidates = ['.env', 'apps/web/.env.local', 'a/b/c/d/.env', 'docs/.env', '.env.ts', 'x.env', '.env']
    expect(selectEnvFiles(candidates, dirs)).toEqual(['.env', 'apps/web/.env.local', 'x.env'])
  })

  it('recognizes Compose files and public prefixes', () => {
    for (const file of ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'infra/docker-compose.override.yml']) {
      expect(isProjectComposeFile(file), file).toBe(true)
    }
    expect(isProjectComposeFile('compose.ts')).toBe(false)
    expect(isProjectComposeFile('my-compose.yml')).toBe(false)
    expect(isProjectComposeFile('examples/demo/compose.yaml')).toBe(false)
    for (const name of [
      'NEXT_PUBLIC_A',
      'VITE_A',
      'NUXT_PUBLIC_A',
      'PUBLIC_A',
      'EXPO_PUBLIC_A',
      'REACT_APP_A',
      'VUE_APP_A',
      'GATSBY_A',
      'STORYBOOK_A',
    ]) {
      expect(isPublicName(name), name).toBe(true)
    }
    expect(PUBLIC_PREFIXES).toContain('VUE_APP_')
    expect(isPublicName('DATABASE_URL')).toBe(false)
    expect(isPublicName('NUXT_SECRET')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Comments, schemas, defaults and file roles
// ---------------------------------------------------------------------------

const refs = (text: string, ext = '.ts') => Object.fromEntries(extractEnvReferences(text, ext))

describe('usages in comments', () => {
  it('ignores // and block comments, JSDoc examples included (create-t3-turbo env.ts)', () => {
    const text = [
      '/**',
      ' * Specify your client-side environment variables schema here.',
      ' * @example process.env.JSDOC_EXAMPLE',
      ' */',
      'export const env = createEnv({',
      '  client: {',
      '    // NEXT_PUBLIC_CLIENTVAR: process.env.NEXT_PUBLIC_CLIENTVAR,',
      '  },',
      '  /* process.env.BLOCK_COMMENT */ runtimeEnv: { NODE_ENV: process.env.NODE_ENV },',
      '})',
    ].join('\n')
    expect(usages(text)).toEqual(['NODE_ENV'])
  })

  it('keeps code after strings, template literals and regexes that contain comment markers', () => {
    const text = [
      'const url = "http://localhost" + process.env.AFTER_URL',
      "const glob = './src/**/*.ts'; const x = process.env.AFTER_GLOB",
      'const t = `${process.env.IN_TEMPLATE} // not a comment ${process.env.ALSO_TEMPLATE}`',
      'const re = /\\/\\//g; const y = process.env.AFTER_REGEX // process.env.TRAILING',
    ].join('\n')
    expect(usages(text)).toEqual(['AFTER_GLOB', 'AFTER_REGEX', 'AFTER_URL', 'ALSO_TEMPLATE', 'IN_TEMPLATE'])
  })

  it('ignores Go comments, while "//" inside a string is not one', () => {
    const text = [
      '// port := os.Getenv("COMMENTED")',
      '/* os.Getenv("BLOCK") */',
      'url := "http://example.com" + os.Getenv("REAL")',
      'raw := `// os.Getenv("IN_RAW_STRING") stays a string`',
    ].join('\n')
    expect(usages(text, '.go')).toEqual(['IN_RAW_STRING', 'REAL'])
  })
})

describe('validation schemas that read the whole environment', () => {
  it('counts Joi schema keys validated against process.env (node-express-boilerplate)', () => {
    const text = [
      "const Joi = require('joi')",
      'const envVarsSchema = Joi.object()',
      '  .keys({',
      "    NODE_ENV: Joi.string().valid('production', 'development', 'test').required(),",
      '    PORT: Joi.number().default(3000),',
      "    MONGODB_URL: Joi.string().required().description('Mongo DB url'),",
      '    SMTP_HOST: Joi.string(),',
      '  })',
      '  .unknown()',
      "const { value: envVars, error } = envVarsSchema.prefs({ errors: { label: 'key' } }).validate(process.env)",
    ].join('\n')
    expect(refs(text, '.js')).toEqual({ NODE_ENV: true, PORT: false, MONGODB_URL: true, SMTP_HOST: true })
  })

  it('counts zod, envalid and t3-env keys', () => {
    expect(
      refs(
        'const env = z.object({ DATABASE_URL: z.string().url(), LOG_LEVEL: z.string().optional() }).parse(process.env)',
      ),
    ).toEqual({
      DATABASE_URL: true,
      LOG_LEVEL: false,
    })
    expect(
      refs('export const env = cleanEnv(process.env, { SMTP_HOST: str(), SMTP_PORT: port({ default: 587 }) })'),
    ).toEqual({
      SMTP_HOST: true,
      SMTP_PORT: false,
    })
    const t3 = [
      'export const env = createEnv({',
      '  server: { AUTH_SECRET: z.string(), AUTH_URL: z.string().url().default("http://localhost:3000") },',
      '  client: { NEXT_PUBLIC_APP_NAME: z.string() },',
      '  runtimeEnv: process.env,',
      '})',
    ].join('\n')
    expect(refs(t3)).toEqual({ AUTH_SECRET: true, AUTH_URL: false, NEXT_PUBLIC_APP_NAME: true })
  })

  it('counts the keys of any t3-env createEnv, whose server keys are read without runtimeEnv (create-t3-turbo)', () => {
    const text = [
      "import { createEnv } from '@t3-oss/env-nextjs'",
      'export const env = createEnv({',
      '  shared: { NODE_ENV: z.enum(["development", "production"]).default("development") },',
      '  server: { POSTGRES_URL: z.string().url() },',
      '  client: {',
      '    // NEXT_PUBLIC_CLIENTVAR: z.string(),',
      '  },',
      '  experimental__runtimeEnv: {',
      '    NODE_ENV: process.env.NODE_ENV,',
      '    // NEXT_PUBLIC_CLIENTVAR: process.env.NEXT_PUBLIC_CLIENTVAR,',
      '  },',
      '})',
    ].join('\n')
    expect(refs(text)).toEqual({ NODE_ENV: true, POSTGRES_URL: true })
  })

  it('does not read object keys of files that only use single variables', () => {
    expect(
      refs('const LIMITS = { MAX_ITEMS: 10 }\nexport const api = process.env.API_URL\nJSON.parse(process.env.CONFIG)'),
    ).toEqual({
      API_URL: true,
      CONFIG: true,
    })
  })
})

describe('defaults in code', () => {
  it('records whether every reference in a file supplies a default', () => {
    const text = [
      'const port = process.env.PORT ?? 3000',
      "const host = process.env.HOST || 'localhost'",
      'const debug = Number(process.env.DEBUG_LEVEL) || 0',
      "const bun = Bun.env.BUN_VAR ?? ''",
      "const { REGION = 'eu', BUCKET } = process.env",
      'const plain = process.env.PLAIN',
      "const mixed = process.env.MIXED ?? 'x'",
      'const again = process.env.MIXED',
    ].join('\n')
    expect(refs(text)).toEqual({
      PORT: false,
      HOST: false,
      DEBUG_LEVEL: false,
      BUN_VAR: false,
      REGION: false,
      BUCKET: true,
      PLAIN: true,
      MIXED: true,
    })
    expect(destructuredEntries("A, B: b = 1, C = 'x'")).toEqual([
      { key: 'A', hasDefault: false },
      { key: 'B', hasDefault: true },
      { key: 'C', hasDefault: true },
    ])
  })

  it('understands Go defaults: cmp.Or, LookupEnv and struct tag defaults', () => {
    const text = [
      'port := cmp.Or(os.Getenv("PORT"), "8080")',
      'if v, ok := os.LookupEnv("OPTIONAL"); ok {}',
      'db := os.Getenv("DATABASE_URL")',
      'type C struct {',
      '  Addr string `env:"ADDR" envDefault:":8080"`',
      '  Key  string `env:"API_KEY,required"`',
      '}',
    ].join('\n')
    expect(refs(text, '.go')).toEqual({ PORT: false, OPTIONAL: false, DATABASE_URL: true, ADDR: false, API_KEY: true })
  })

  it('treats Compose defaults as fallbacks and required markers as reads', () => {
    expect(
      Object.fromEntries(composeReferences('a: ${A:-1}\nb: ${B-2}\nc: ${C:?set it}\nd: ${D}\ne: ${E:+on}\nf: $F')),
    ).toEqual({
      A: false,
      B: false,
      C: true,
      D: true,
      E: false,
      F: true,
    })
  })
})

describe('other usage sources', () => {
  it('reads %NAME% placeholders of bundler-exposed variables in index.html', () => {
    const html = '<title>%VITE_APP_TITLE%</title><p>%REACT_APP_X% %MODE% %s% 100%</p>'
    expect([...extractHtmlEnvUsages(html)].sort()).toEqual(['REACT_APP_X', 'VITE_APP_TITLE'])
  })

  it('knows which names a next.config env block provides', () => {
    const config = [
      'module.exports = {',
      "  env: { CUSTOM_KEY: 'my-value', API_URL: process.env.API_URL, nested: { NOPE: 1 }, 'QUOTED_KEY': x },",
      '}',
    ].join('\n')
    expect([...nextConfigProvidedNames(config)].sort()).toEqual(['CUSTOM_KEY', 'QUOTED_KEY'])
    expect(nextConfigProvidedNames('module.exports = { reactStrictMode: true }').size).toBe(0)
  })

  it('classifies test code for testOnly', () => {
    for (const file of [
      'src/a.test.ts',
      'test/setup.ts',
      'e2e/login.spec.ts',
      'internal/db_test.go',
      'playwright.config.ts',
    ]) {
      expect(isTestUsagePath(file), file).toBe(true)
    }
    for (const file of ['src/index.ts', 'vite.config.ts', 'src/testing.ts']) {
      expect(isTestUsagePath(file), file).toBe(false)
    }
  })
})

describe('environment detector: file roles, kinds and extra facts', () => {
  it('ignores Compose files, env files and code under examples, templates and fixtures', async () => {
    const dir = await makeProject({
      'package.json': JSON.stringify({ name: 'app' }),
      'src/index.ts': 'export const a = process.env.APP_VAR\n',
      'examples/demo/compose.yaml': 'services:\n  demo:\n    image: redis\n    command: ${DEMO_TOKEN}\n',
      'examples/demo/.env.example': 'DEMO_TOKEN=\n',
      'examples/demo/.env': 'DEMO_TOKEN=1\n',
      'examples/demo/index.ts': 'export const d = process.env.DEMO_ONLY\n',
      'templates/app/compose.yaml': 'services:\n  t:\n    image: ${TEMPLATE_IMAGE}\n',
      'test/fixtures/app/compose.yaml': 'services:\n  f:\n    image: ${FIXTURE_IMAGE}\n',
      'test/fixtures/app/src/index.ts': 'export const f = process.env.FIXTURE_VAR\n',
    })
    const { env } = await detect(dir)
    expect(env.files).toEqual([])
    expect(env.variables.map((v) => v.name)).toEqual(['APP_VAR'])
  })

  it('marks test-only and default-only variables', async () => {
    const dir = await makeProject({
      'src/server.ts': 'export const port = process.env.PORT ?? 3000\nexport const db = process.env.DATABASE_URL\n',
      'src/cli.ts': "export const port = process.env.PORT || '8080'\n",
      'test/setup.ts': 'export const url = process.env.TEST_DB_URL\n',
      'src/app.test.ts': 'export const k = process.env.DATABASE_URL\n',
    })
    const { env } = await detect(dir)
    expect(env.variables.map((v) => [v.name, v.fallback, v.testOnly])).toEqual([
      ['DATABASE_URL', false, false],
      ['PORT', true, false],
      ['TEST_DB_URL', false, true],
    ])
  })

  it('classifies Compose env_file files as service files and reads commented-out example entries', async () => {
    const dir = await makeProject({
      'compose.yaml': 'services:\n  db:\n    image: postgres:17\n    env_file: [.env.db, db/extra.env]\n',
      '.env.db': 'POSTGRES_PASSWORD=x\n',
      'db/extra.env': 'POSTGRES_DB=app\n',
      '.env.test': 'AUTH_SECRET=test-secret-not-real\n',
      '.env.backup': 'OLD_ONLY=1\n',
      'env.example': 'DATABASE_URL=\n# OPTIONAL_FEATURE=\n#SENTRY_DSN=\n',
      'src/index.ts': 'export const a = [process.env.DATABASE_URL, process.env.OPTIONAL_FEATURE]\n',
    })
    const { env } = await detect(dir)
    expect(env.files.map((f) => [f.path, f.kind, f.variables])).toEqual([
      ['.env.backup', 'other', 1],
      ['.env.db', 'service', 1],
      ['.env.test', 'mode', 1],
      ['db/extra.env', 'service', 1],
      ['env.example', 'example', 1],
    ])
    expect(env.variables.map((v) => [v.name, v.defined, v.documented, v.used])).toEqual([
      ['AUTH_SECRET', true, false, false],
      ['DATABASE_URL', false, true, true],
      ['OPTIONAL_FEATURE', false, true, true],
      ['POSTGRES_DB', true, false, false],
      ['POSTGRES_PASSWORD', true, false, false],
      ['SENTRY_DSN', false, true, false],
    ])
  })

  it('collects mentions, next.config provided names and index.html usages for the doctor', async () => {
    const dir = await makeProject({
      '.env.example': 'GIN_LIKE_MODE=\nLEGACY_FLAG=\nCOMMENTED_ONLY=\nVITE_APP_TITLE=\n',
      'main.go': 'package main\n\n// COMMENTED_ONLY is read elsewhere\nvar mode = lookup("GIN_LIKE_MODE")\n',
      'index.html': '<title>%VITE_APP_TITLE%</title>\n',
      'next.config.js': "module.exports = { env: { BUILD_ID: 'x' } }\n",
      'app/page.tsx': 'export const id = process.env.BUILD_ID\n',
    })
    const ctx = await contextFor(dir)
    const analysis = await ctx.use(environmentAnalysis)
    expect([...analysis.mentioned]).toEqual(['GIN_LIKE_MODE'])
    expect([...analysis.configProvided]).toEqual(['BUILD_ID'])
    const title = analysis.section.variables.find((v) => v.name === 'VITE_APP_TITLE')
    expect(title).toMatchObject({ used: true, usedIn: ['index.html'] })
    expect(await ctx.use(environmentDetector)).toBe(analysis.section)
  })
})
