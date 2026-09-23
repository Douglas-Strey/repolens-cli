import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  definesOnlyPublic,
  envExampleRealSecret,
  envFileNotIgnored,
  envPublicSecret,
  findPublicSecrets,
  findRealSecretsInExamples,
  findTrackedEnvFiles,
  findUnignoredEnvFiles,
  looksLikePublicSecret,
  trackedEnvFile,
  withoutPublicPrefix,
} from '../../src/doctor/rules/security.ts'
import type { GitSection } from '../../src/types.ts'
import { contextFor, gitInit, makeProject, SECRET_SENTINEL } from '../helpers.ts'
import {
  envFile,
  environment,
  envVar,
  expectWellFormed,
  makeSections,
  projectContext,
  runCheck,
  runRule,
  subjectsOf,
} from './support.ts'

// Credential-shaped strings are assembled at runtime so no real-looking token is committed.
const GITHUB_TOKEN = `ghp_${'z'.repeat(36)}`

const GIT: GitSection = {
  branch: 'main',
  head: null,
  remotes: [],
  submodules: [],
  lfs: false,
  trackedFiles: 3,
  linkedWorktree: false,
}

describe('ENV_PUBLIC_SECRET', () => {
  it('recognizes secret-looking names', () => {
    for (const name of [
      'NEXT_PUBLIC_STRIPE_SECRET_KEY',
      'VITE_DB_PASSWORD',
      'VITE_DB_PASSWD',
      'NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY',
      'PUBLIC_SIGNING_PRIVATE_KEY',
      'VITE_OAUTH_CLIENT_SECRET',
      'NEXT_PUBLIC_SECRET',
    ]) {
      expect(looksLikePublicSecret(name), name).toBe(true)
    }
    // Tokens and keys that are public by design are not secrets by name.
    for (const name of [
      'NEXT_PUBLIC_API_URL',
      'NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN',
      'NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN',
      'VITE_SUPABASE_ANON_KEY',
      'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
      'VITE_CESIUM_ION_TOKEN',
      'VITE_GITHUB_TOKEN',
      'VITE_TOKENIZER_URL',
      'NEXT_PUBLIC_SECRETARY_EMAIL',
    ]) {
      expect(looksLikePublicSecret(name), name).toBe(false)
    }
  })

  it('strips the framework prefix for the suggested server-side name', () => {
    expect(withoutPublicPrefix('NEXT_PUBLIC_JWT_SECRET')).toBe('JWT_SECRET')
    expect(withoutPublicPrefix('NUXT_PUBLIC_X')).toBe('X')
    expect(withoutPublicPrefix('VITE_A')).toBe('A')
    expect(withoutPublicPrefix('VUE_APP_SECRET')).toBe('SECRET')
    expect(withoutPublicPrefix('CUSTOM_SECRET')).toBeNull()
  })

  it('reports public variables that look like secrets and only those', () => {
    const env = environment(
      [],
      [
        envVar('NEXT_PUBLIC_JWT_SECRET', { public: true, usedIn: ['app/page.tsx'], definedIn: ['.env'] }),
        envVar('JWT_SECRET', { public: false, usedIn: ['server.ts'] }),
        envVar('NEXT_PUBLIC_SITE_URL', { public: true }),
      ],
    )
    const found = findPublicSecrets(env)
    expect(found).toEqual([
      {
        code: 'ENV_PUBLIC_SECRET',
        severity: 'warning',
        category: 'security',
        message: 'NEXT_PUBLIC_JWT_SECRET is exposed to the browser bundle but looks like a secret',
        hint: 'Rename it to JWT_SECRET and read it only in server code; rotate the value if it has ever been deployed',
        files: ['app/page.tsx', '.env'],
        subject: 'NEXT_PUBLIC_JWT_SECRET',
      },
    ])
  })

  it('is skipped when no variable is public', async () => {
    const sections = makeSections({ environment: environment([], [envVar('X_SECRET')]) })
    expect((await runRule(envPublicSecret, sections)).checks[0]?.status).toBe('skipped')
  })
})

describe('ENV_EXAMPLE_REAL_SECRET', () => {
  it('reports each variable with a credential-shaped value in a documentation file', () => {
    const env = environment(
      [envFile('.env.example', 'example')],
      [
        envVar('STRIPE_KEY', { documented: true, suspiciousValueIn: ['.env.example'] }),
        envVar('GH_TOKEN', { documented: true, suspiciousValueIn: ['docs/.env.sample', '.env.example'] }),
        envVar('SAFE', { documented: true }),
      ],
    )
    const found = findRealSecretsInExamples(env)
    expect(subjectsOf(found)).toEqual(['STRIPE_KEY', 'GH_TOKEN'])
    expect(found[0]).toMatchObject({
      severity: 'error',
      category: 'security',
      message: '.env.example contains what looks like a real credential in STRIPE_KEY',
      hint: 'Rotate the credential now, then replace the value with an empty placeholder (STRIPE_KEY=)',
      files: ['.env.example'],
    })
    expect(found[1]?.message).toBe(
      '.env.example and docs/.env.sample contain what looks like a real credential in GH_TOKEN',
    )
    expectWellFormed(found)
  })

  it('applies only when an example file exists', async () => {
    const without = makeSections({ environment: environment([envFile('.env', 'local')], []) })
    expect((await runRule(envExampleRealSecret, without)).checks[0]?.status).toBe('skipped')
    const clean = makeSections({ environment: environment([envFile('.env.example', 'example')], [envVar('A')]) })
    expect((await runRule(envExampleRealSecret, clean)).checks[0]?.status).toBe('passed')
  })
})

describe('definesOnlyPublic', () => {
  it('is true when every variable a file defines is exposed to the browser anyway', () => {
    const variables = [
      envVar('VITE_API_URL', { definedIn: ['.env.production'] }),
      envVar('DB_PASSWORD', { definedIn: ['.env.test'] }),
    ]
    expect(definesOnlyPublic('.env.production', variables)).toBe(true)
    expect(definesOnlyPublic('.env.test', variables)).toBe(false)
  })
})

describe('TRACKED_ENV_FILE', () => {
  it('reports a tracked .env as an error with an untrack hint', () => {
    const found = findTrackedEnvFiles(environment([envFile('.env', 'local', { tracked: true })], []))
    expect(found).toEqual([
      {
        code: 'TRACKED_ENV_FILE',
        severity: 'error',
        category: 'security',
        message: '.env is tracked by Git',
        hint: 'Run `git rm --cached .env`, add .env to .gitignore and rotate any secrets it contained',
        files: ['.env'],
        subject: '.env',
      },
    ])
  })

  it('reports committed mode and service files as a warning, an error only with a credential-shaped value', () => {
    const env = environment(
      [
        envFile('.env.production', 'mode', { tracked: true }),
        envFile('.env.test', 'mode', { tracked: true }),
        envFile('.env.staging', 'mode', { tracked: true }),
        envFile('.env.db', 'service', { tracked: true }),
      ],
      [
        envVar('NEXT_PUBLIC_SITE_URL', { defined: true, definedIn: ['.env.production'] }),
        envVar('AUTH_SECRET', { defined: true, definedIn: ['.env.test'], sensitive: true }),
        envVar('API_TOKEN', { defined: true, definedIn: ['.env.staging'], sensitive: true }),
        envVar('POSTGRES_PASSWORD', { defined: true, definedIn: ['.env.db'], sensitive: true }),
      ],
    )
    const found = findTrackedEnvFiles(env, (path) => path === '.env.staging')
    // .env.production only sets a browser-public variable: nothing to report.
    expect(found.map((d) => [d.subject, d.severity])).toEqual([
      ['.env.test', 'warning'],
      ['.env.staging', 'error'],
      ['.env.db', 'warning'],
    ])
    expect(found[0]?.hint).toContain('.env.test.local')
    expect(found[1]?.message).toBe('.env.staging is tracked by Git and contains what looks like a real credential')
    expect(found[2]?.hint).toBe(
      'Keep only non-secret defaults in .env.db, or run `git rm --cached .env.db` and add it to .gitignore',
    )
    expectWellFormed(found)
  })

  it('does not treat a committed Next.js .env.test with a placeholder secret as an error', async () => {
    const dir = await makeProject({ '.env.test': 'AUTH_SECRET=test-secret-not-real\n', '.gitignore': '.env\n' })
    gitInit(dir)
    const env = environment(
      [envFile('.env.test', 'mode', { tracked: true })],
      [envVar('AUTH_SECRET', { defined: true, definedIn: ['.env.test'], sensitive: true })],
    )
    const sections = makeSections({ git: GIT, environment: env })
    const found = await runCheck(trackedEnvFile, sections, await contextFor(dir))
    expect(found.map((d) => d.severity)).toEqual(['warning'])
  })

  it('reads committed mode files for credential-shaped values without echoing them', async () => {
    const ctx = await projectContext({ '.env.production': `GH=${GITHUB_TOKEN}\nNOTE=${SECRET_SENTINEL}\n` })
    const env = environment([envFile('.env.production', 'mode', { tracked: true })], [])
    const found = await runCheck(trackedEnvFile, makeSections({ git: GIT, environment: env }), ctx)
    expect(found.map((d) => d.severity)).toEqual(['error'])
    expectWellFormed(found, [GITHUB_TOKEN])
  })

  it('reports a committed env file of unknown purpose only when it holds a credential', async () => {
    const ctx = await projectContext({
      '.env.backup': `GH=${GITHUB_TOKEN}\n`,
      '.env.old': `NOTE=${SECRET_SENTINEL}\n`,
      '.env.vault': `DOTENV_VAULT=${GITHUB_TOKEN}\n`,
    })
    const env = environment(
      [
        envFile('.env.backup', 'other', { tracked: true, variables: 1 }),
        envFile('.env.old', 'other', { tracked: true, variables: 1 }),
        envFile('.env.vault', 'other', { tracked: true, variables: 0 }),
      ],
      [],
    )
    const found = await runCheck(trackedEnvFile, makeSections({ git: GIT, environment: env }), ctx)
    expect(found.map((d) => [d.subject, d.severity])).toEqual([['.env.backup', 'error']])
    expect(found[0]?.message).toBe('.env.backup is tracked by Git and contains what looks like a real credential')
    expectWellFormed(found, [GITHUB_TOKEN, SECRET_SENTINEL])
  })

  it('handles .envrc: directives only are fine, exported variables are a warning', () => {
    const directivesOnly = envFile('.envrc', 'local', { tracked: true, variables: 0 })
    expect(findTrackedEnvFiles(environment([directivesOnly], []))).toEqual([])
    const exports = envFile('.envrc', 'local', { tracked: true, variables: 2 })
    expect(findTrackedEnvFiles(environment([exports], []))[0]?.severity).toBe('warning')
    expect(findTrackedEnvFiles(environment([exports], []), () => true)[0]?.severity).toBe('error')
  })

  it('ignores untracked, unknown and example files', () => {
    const env = environment(
      [
        envFile('.env', 'local', { tracked: false }),
        envFile('.env.local', 'local', { tracked: null }),
        envFile('.env.example', 'example', { tracked: true }),
      ],
      [],
    )
    expect(findTrackedEnvFiles(env)).toEqual([])
  })

  it('only applies to Git repositories', async () => {
    const env = environment([envFile('.env', 'local', { tracked: true })], [])
    expect((await runRule(trackedEnvFile, makeSections({ environment: env }))).checks[0]?.status).toBe('skipped')
    const result = await runRule(trackedEnvFile, makeSections({ environment: env, git: GIT }))
    expect(result.checks[0]?.status).toBe('failed')
  })
})

describe('ENV_FILE_NOT_IGNORED', () => {
  it('warns about a local env file that Git would pick up', () => {
    const found = findUnignoredEnvFiles(
      environment([envFile('apps/web/.env', 'local', { ignored: false, tracked: false })], []),
    )
    expect(found).toEqual([
      {
        code: 'ENV_FILE_NOT_IGNORED',
        severity: 'warning',
        category: 'security',
        message: 'apps/web/.env is not ignored by Git and could be committed by accident',
        hint: 'Add .env to .gitignore (or .env* together with !.env.example)',
        files: ['apps/web/.env'],
        subject: 'apps/web/.env',
      },
    ])
  })

  it('leaves mode files alone unless they hold a credential-shaped value', () => {
    const env = environment([envFile('.env.development', 'mode', { ignored: false, tracked: null })], [])
    expect(findUnignoredEnvFiles(env)).toEqual([])
    expect(findUnignoredEnvFiles(env, () => true).map((d) => d.severity)).toEqual(['warning'])
  })

  it('ignores ignored, tracked (reported elsewhere) and unknown files', () => {
    const env = environment(
      [
        envFile('.env', 'local', { ignored: true }),
        envFile('.env.local', 'local', { ignored: false, tracked: true }),
        envFile('.env.test', 'mode', { ignored: null }),
        envFile('.envrc', 'local', { ignored: false }),
        envFile('.env.example', 'example', { ignored: false }),
      ],
      [],
    )
    expect(findUnignoredEnvFiles(env)).toEqual([])
  })

  it('reports an unignored env file of unknown purpose only when it holds a credential', async () => {
    const repo = await makeProject({ 'secrets.env': `GH=${GITHUB_TOKEN}\n`, '.env.old': 'A=1\n' })
    gitInit(repo, ['.env.old'])
    const env = environment(
      [
        envFile('secrets.env', 'other', { ignored: false, tracked: false, variables: 1 }),
        envFile('.env.old', 'other', { ignored: false, tracked: false, variables: 1 }),
      ],
      [],
    )
    const found = await runCheck(
      envFileNotIgnored,
      makeSections({ git: GIT, environment: env }),
      await contextFor(repo),
    )
    expect(found.map((d) => [d.subject, d.severity])).toEqual([['secrets.env', 'warning']])
    expectWellFormed(found, [GITHUB_TOKEN])
  })

  it('is skipped, not passed, when scanning a subdirectory of a repository', async () => {
    const repo = await makeProject({ '.gitignore': '.env\n', 'app/package.json': '{}\n' })
    gitInit(repo)
    const sections = makeSections({
      git: GIT,
      environment: environment([envFile('.env', 'local', { ignored: false, tracked: false })], []),
    })
    const result = await runRule(envFileNotIgnored, sections, await contextFor(path.join(repo, 'app')))
    expect(result.checks[0]?.status).toBe('skipped')
  })

  it('does not trust "not ignored" when scanning a subdirectory of a repository', async () => {
    const repo = await makeProject({ '.gitignore': '.env\n', 'app/package.json': '{}\n' })
    gitInit(repo)
    const sections = makeSections({
      git: GIT,
      environment: environment([envFile('.env', 'local', { ignored: false, tracked: false })], []),
    })
    expect(await runCheck(envFileNotIgnored, sections, await contextFor(path.join(repo, 'app')))).toEqual([])
    expect(await runCheck(envFileNotIgnored, sections, await contextFor(repo))).toHaveLength(1)
  })
})
