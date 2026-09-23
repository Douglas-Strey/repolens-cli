/**
 * End-to-end doctor runs on fixture copies. Assertions are limited to codes
 * whose inputs RepoLens reads directly (lockfiles, manifests, Compose files,
 * turbo.json, parse warnings), so they don't depend on detector details.
 */
import { describe, expect, it } from 'vitest'
import type { ScanResult } from '../../src/types.ts'
import { SECRET_SENTINEL, scanFixture } from '../helpers.ts'

function codes(result: ScanResult): string[] {
  return result.doctor.diagnostics.map((d) => d.code)
}

function find(result: ScanResult, code: string) {
  return result.doctor.diagnostics.filter((d) => d.code === code)
}

function expectNoSecrets(result: ScanResult): void {
  expect(JSON.stringify(result.doctor)).not.toContain(SECRET_SENTINEL)
}

describe('doctor on fixtures', () => {
  it('mixed-lockfiles: competing lockfiles and a legacy ESLint config', async () => {
    const result = await scanFixture('mixed-lockfiles')
    expect(find(result, 'MULTIPLE_LOCKFILES')).toEqual([
      expect.objectContaining({
        severity: 'warning',
        message: 'Found lockfiles for npm and pnpm: package-lock.json and pnpm-lock.yaml',
        hint: 'Delete package-lock.json and keep pnpm-lock.yaml, since package.json declares pnpm',
      }),
    ])
    expect(find(result, 'ESLINT_LEGACY_CONFIG')).toEqual([
      expect.objectContaining({ severity: 'warning', subject: '.eslintrc.json' }),
    ])
    // pnpm is declared and its lockfile exists, so this is not a mismatch.
    expect(codes(result)).not.toContain('PACKAGE_MANAGER_MISMATCH')
    expect(codes(result)).not.toContain('PACKAGE_MANAGER_UNDECLARED')
    expectNoSecrets(result)
  })

  it('legacy-config: duplicate workspaces, empty pattern, turbo pipeline, obsolete Compose version', async () => {
    const result = await scanFixture('legacy-config')
    expect(codes(result)).toEqual(
      expect.arrayContaining([
        'WORKSPACE_DUPLICATE_CONFIG',
        'WORKSPACE_PATTERN_EMPTY',
        'TURBO_PIPELINE_KEY',
        'COMPOSE_VERSION_OBSOLETE',
        'ESLINT_LEGACY_CONFIG',
      ]),
    )
    expect(find(result, 'WORKSPACE_PATTERN_EMPTY').map((d) => d.subject)).toEqual(['tools/*'])
    expect(find(result, 'TURBO_PIPELINE_KEY')[0]?.severity).toBe('warning')
    expect(find(result, 'COMPOSE_VERSION_OBSOLETE').map((d) => d.subject)).toEqual(['docker-compose.yml'])
    expectNoSecrets(result)
  })

  it('docker-project: obsolete version key and a missing env_file', async () => {
    const result = await scanFixture('docker-project')
    expect(find(result, 'COMPOSE_VERSION_OBSOLETE').map((d) => d.subject)).toEqual(['compose.yaml'])
    expect(find(result, 'COMPOSE_ENV_FILE_MISSING')).toEqual([
      expect.objectContaining({
        severity: 'warning',
        message: 'Service app in compose.yaml loads env_file .env, which does not exist',
        hint: 'Run `cp .env.example .env` and fill in the values, or mark the entry optional with required: false',
        subject: '.env',
      }),
    ])
    expectNoSecrets(result)
  })

  it('broken-env: npm placeholder test script, and no secret value in any diagnostic', async () => {
    const result = await scanFixture('broken-env')
    expect(find(result, 'SCRIPT_TEST_PLACEHOLDER').map((d) => d.severity)).toEqual(['info'])
    expectNoSecrets(result)
  })

  it('broken-manifest: invalid package.json is one error, not also a parse warning', async () => {
    const result = await scanFixture('broken-manifest')
    expect(find(result, 'PACKAGE_JSON_INVALID').map((d) => d.severity)).toEqual(['error'])
    expect(find(result, 'CONFIG_PARSE_ERROR').map((d) => d.subject)).not.toContain('package.json')
  })

  it('broken-config: every unparsable file doctor reads is reported, and nothing crashes', async () => {
    const result = await scanFixture('broken-config')
    const subjects = find(result, 'CONFIG_PARSE_ERROR').map((d) => d.subject)
    expect(subjects).toEqual(
      expect.arrayContaining(['docker-compose.yml', 'go.mod', 'pnpm-workspace.yaml', 'turbo.json']),
    )
    expect(result.meta.warnings.filter((w) => w.message.startsWith('Doctor check'))).toEqual([])
    expectNoSecrets(result)
  })

  it('clean fixtures raise no errors or warnings from file-based checks', async () => {
    for (const name of ['nuxt-app', 'fastify-api', 'nest-api', 'go-api']) {
      const result = await scanFixture(name)
      const fileBased = [
        'MULTIPLE_LOCKFILES',
        'PACKAGE_MANAGER_MISMATCH',
        'WORKSPACE_DUPLICATE_CONFIG',
        'WORKSPACE_PATTERN_EMPTY',
        'TURBO_PIPELINE_KEY',
        'COMPOSE_ENV_FILE_MISSING',
        'ESLINT_LEGACY_CONFIG',
        'GO_SUM_MISSING',
        'PACKAGE_JSON_INVALID',
        'CONFIG_PARSE_ERROR',
      ]
      expect(
        codes(result).filter((code) => fileBased.includes(code)),
        name,
      ).toEqual([])
    }
  })
})
