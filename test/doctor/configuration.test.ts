import { describe, expect, it } from 'vitest'
import { detect } from '../../src/core/scan.ts'
import { runDoctor } from '../../src/doctor/index.ts'
import {
  configParseError,
  findInvalidPackageJson,
  findParseErrors,
  packageJsonInvalid,
} from '../../src/doctor/rules/configuration.ts'
import { doctorRules } from '../../src/doctor/rules/index.ts'
import { contextFor, makeProject } from '../helpers.ts'
import { expectWellFormed, makeSections, projectContext, runCheck, runRule, SECRET_SENTINEL } from './support.ts'

describe('PACKAGE_JSON_INVALID', () => {
  it('reports an unparsable root package.json', () => {
    expect(findInvalidPackageJson(true)).toEqual([
      {
        code: 'PACKAGE_JSON_INVALID',
        severity: 'error',
        category: 'configuration',
        message: 'package.json is not valid JSON',
        hint: 'Fix the syntax error (often a trailing comma or a missing quote); until then RepoLens and your package manager cannot read scripts or dependencies',
        files: ['package.json'],
        subject: 'package.json',
      },
    ])
    expect(findInvalidPackageJson(false)).toEqual([])
  })

  it('reads the manifests fact and never quotes the file', async () => {
    const ctx = await projectContext({ 'package.json': `{ "name": "x", "token": "${SECRET_SENTINEL}", }}` })
    const found = await runCheck(packageJsonInvalid, makeSections(), ctx)
    expect(found.map((d) => d.code)).toEqual(['PACKAGE_JSON_INVALID'])
    expectWellFormed(found)
  })

  it('passes for a valid package.json', async () => {
    const ctx = await projectContext({ 'package.json': '{}' })
    expect(await runCheck(packageJsonInvalid, makeSections(), ctx)).toEqual([])
    expect((await runRule(packageJsonInvalid, makeSections(), ctx)).checks[0]?.status).toBe('passed')
  })

  it('is skipped without a package.json', async () => {
    expect((await runRule(packageJsonInvalid, makeSections())).checks[0]?.status).toBe('skipped')
  })
})

describe('CONFIG_PARSE_ERROR', () => {
  it('turns parse warnings into diagnostics without the parser detail', () => {
    const found = findParseErrors([
      {
        kind: 'parse',
        file: 'turbo.json',
        message: "Couldn't parse turbo.json",
        detail: `Unexpected token near "${SECRET_SENTINEL}"`,
      },
      { kind: 'parse', file: 'package.json', message: "Couldn't parse package.json" },
      { kind: 'size', file: 'big.json', message: 'Skipped big.json because it is larger than the read limit' },
      { kind: 'parse', file: 'turbo.json', message: "Couldn't parse turbo.json" },
      { kind: 'parse', message: "Couldn't parse an unnamed file" },
    ])
    expect(found).toEqual([
      {
        code: 'CONFIG_PARSE_ERROR',
        severity: 'warning',
        category: 'configuration',
        message: "Couldn't parse an unnamed file",
        hint: 'Fix the syntax error; RepoLens skipped the file (run with --verbose to see the parser message)',
        subject: "Couldn't parse an unnamed file",
      },
      {
        code: 'CONFIG_PARSE_ERROR',
        severity: 'warning',
        category: 'configuration',
        message: "Couldn't parse turbo.json",
        hint: 'Fix the syntax error in turbo.json; RepoLens skipped it (run with --verbose to see the parser message)',
        files: ['turbo.json'],
        subject: 'turbo.json',
      },
    ])
    expectWellFormed(found)
  })

  it('matches parse warnings by kind only, never by message', () => {
    expect(findParseErrors([{ kind: 'error', file: 'x.json', message: "Couldn't parse x.json" }])).toEqual([])
    expect(
      findParseErrors([{ kind: 'parse', file: 'x.yaml', message: 'Unreadable YAML' }]).map((d) => d.subject),
    ).toEqual(['x.yaml'])
  })

  it('runs after every other rule, so it sees the parse warnings they record', async () => {
    expect(configParseError.final).toBe(true)
    expect(doctorRules.filter((rule) => rule.final).map((rule) => rule.code)).toEqual(['CONFIG_PARSE_ERROR'])
    const ctx = await contextFor(
      await makeProject({
        'package.json': '{}',
        'turbo.json': `{ "pipeline": "${SECRET_SENTINEL}" `,
        'docker-compose.yml': `services:\n  app: [\n    ${SECRET_SENTINEL}\n`,
        'pnpm-workspace.yaml': 'packages: [\n',
      }),
    )
    const result = await runDoctor(await detect(ctx), ctx)
    const found = result.diagnostics.filter((d) => d.code === 'CONFIG_PARSE_ERROR')
    expect(found.map((d) => d.subject)).toEqual(['docker-compose.yml', 'pnpm-workspace.yaml', 'turbo.json'])
    expectWellFormed(found)
    // Checks whose input failed to parse are skipped, not passed.
    const status = (code: string) => result.checks.find((check) => check.code === code)?.status
    expect(status('TURBO_PIPELINE_KEY')).toBe('skipped')
    expect(status('WORKSPACE_DUPLICATE_CONFIG')).toBe('skipped')
    expect(status('WORKSPACE_PATTERN_EMPTY')).toBe('skipped')
  })

  it('is skipped when there are no configuration files', async () => {
    const ctx = await projectContext({ 'main.go': 'package main\n', 'README.md': '# x\n' })
    expect((await runRule(configParseError, makeSections(), ctx)).checks[0]?.status).toBe('skipped')
  })

  it('passes when everything parses', async () => {
    const ctx = await projectContext({ 'package.json': '{}', 'turbo.json': '{ "tasks": {} }' })
    expect(await runCheck(configParseError, makeSections(), ctx)).toEqual([])
  })
})
