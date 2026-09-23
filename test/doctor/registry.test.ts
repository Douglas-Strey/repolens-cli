import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runDoctor } from '../../src/doctor/index.ts'
import { doctorRules } from '../../src/doctor/rules/index.ts'
import type { DiagnosticCategory, Sections } from '../../src/types.ts'
import { sampleScanResult } from '../factories.ts'
import { makeProject, scanDir } from '../helpers.ts'
import { expectWellFormed, makeSections, projectContext } from './support.ts'

const DOCS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../docs/diagnostics.md')

const CATEGORIES: ReadonlySet<DiagnosticCategory> = new Set([
  'runtime',
  'package-manager',
  'environment',
  'security',
  'docker',
  'workspace',
  'scripts',
  'git',
  'tooling',
  'configuration',
])

function sectionsOf(result: ReturnType<typeof sampleScanResult>): Sections {
  const { schemaVersion: _schema, tool: _tool, doctor: _doctor, meta: _meta, ...sections } = result
  return sections
}

describe('doctor rule registry', () => {
  it('has unique, well-formed codes, categories and positive titles', () => {
    const codes = doctorRules.map((rule) => rule.code)
    expect(new Set(codes).size).toBe(codes.length)
    for (const rule of doctorRules) {
      expect(rule.code).toMatch(/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/)
      expect(CATEGORIES.has(rule.category), rule.code).toBe(true)
      expect(rule.title.length, rule.code).toBeGreaterThan(5)
      expect(rule.title, rule.code).not.toMatch(/\b(?:no|not|missing)\b.*\b(?:found|detected)\b/i)
    }
  })

  it('contains every code from the specification', () => {
    expect(doctorRules.map((rule) => rule.code).sort()).toEqual(
      [
        'COMPOSE_ENV_FILE_MISSING',
        'COMPOSE_VERSION_OBSOLETE',
        'CONFIG_PARSE_ERROR',
        'DOCKER_PORT_CONFLICT',
        'ENV_EXAMPLE_MISSING',
        'ENV_EXAMPLE_REAL_SECRET',
        'ENV_FILE_NOT_IGNORED',
        'ENV_LOCAL_ONLY',
        'ENV_MISSING_LOCAL',
        'ENV_PORT_MISMATCH',
        'ENV_PUBLIC_SECRET',
        'ENV_UNDOCUMENTED',
        'ENV_UNUSED',
        'ESLINT_LEGACY_CONFIG',
        'GITIGNORE_MISSING',
        'GITIGNORE_NODE_MODULES',
        'GO_SUM_MISSING',
        'GO_VERSION_CONFLICT',
        'LOCKFILE_MISSING',
        'MULTIPLE_LOCKFILES',
        'NEXT_MIDDLEWARE_DEPRECATED',
        'NODE_VERSION_CONFLICT',
        'NODE_VERSION_OUT_OF_RANGE',
        'PACKAGE_JSON_INVALID',
        'PACKAGE_MANAGER_MISMATCH',
        'PACKAGE_MANAGER_UNDECLARED',
        'RUNTIME_EOL',
        'SCRIPT_MISSING_LINT',
        'SCRIPT_MISSING_TEST',
        'SCRIPT_TEST_PLACEHOLDER',
        'TRACKED_ENV_FILE',
        'TURBO_PIPELINE_KEY',
        'WORKSPACE_DUPLICATE_CONFIG',
        'WORKSPACE_PATTERN_EMPTY',
      ].sort(),
    )
  })

  it('documents every code in docs/diagnostics.md, and nothing else', async () => {
    const docs = await fs.readFile(DOCS, 'utf8')
    const documented = [...docs.matchAll(/^### `([A-Z0-9_]+)`$/gm)].map((match) => match[1])
    expect([...documented].sort()).toEqual(doctorRules.map((rule) => rule.code).sort())
    for (const rule of doctorRules) {
      expect(docs, rule.code).toContain(`| [\`${rule.code}\`](#${rule.code.toLowerCase()}) |`)
      expect(docs, rule.code).toContain(`| ${rule.title} |`)
      const section = docs.slice(docs.indexOf(`### \`${rule.code}\``)).split('\n### ')[0] ?? ''
      expect(section, rule.code).toContain(`**Category:** ${rule.category}`)
      expect(section, rule.code).toContain('**Example:**')
    }
  })
})

describe('doctor rule list', () => {
  it('is frozen, so consumers extend a copy instead of changing the built-in list', () => {
    expect(Object.isFrozen(doctorRules)).toBe(true)
  })
})

/** Rules that read package.json, lockfiles, workspaces, Git ignore rules, scripts and tooling files. */
const FILE_INPUT_RULES = [
  'PACKAGE_JSON_INVALID',
  'CONFIG_PARSE_ERROR',
  'MULTIPLE_LOCKFILES',
  'PACKAGE_MANAGER_MISMATCH',
  'PACKAGE_MANAGER_UNDECLARED',
  'LOCKFILE_MISSING',
  'NODE_VERSION_CONFLICT',
  'NODE_VERSION_OUT_OF_RANGE',
  'RUNTIME_EOL',
  'GO_VERSION_CONFLICT',
  'WORKSPACE_DUPLICATE_CONFIG',
  'WORKSPACE_PATTERN_EMPTY',
  'TURBO_PIPELINE_KEY',
  'GITIGNORE_MISSING',
  'GITIGNORE_NODE_MODULES',
  'SCRIPT_TEST_PLACEHOLDER',
  'SCRIPT_MISSING_TEST',
  'SCRIPT_MISSING_LINT',
  'ESLINT_LEGACY_CONFIG',
  'GO_SUM_MISSING',
  'NEXT_MIDDLEWARE_DEPRECATED',
]

describe('checks without inputs are skipped, not passed', () => {
  const statusOf = (result: Awaited<ReturnType<typeof scanDir>>, codes: readonly string[]) =>
    result.doctor.checks.filter((check) => codes.includes(check.code)).map((check) => [check.code, check.status])

  it('skips every file-reading check in an empty directory', async () => {
    const result = await scanDir(await makeProject({}))
    expect(statusOf(result, FILE_INPUT_RULES)).toEqual(FILE_INPUT_RULES.map((code) => [code, 'skipped']))
  })

  it('skips package-manager, script and Node.js checks without package.json', async () => {
    const result = await scanDir(
      await makeProject({ 'go.mod': 'module example.com/x\n\ngo 1.25\n', 'go.sum': '', 'main.go': 'package main\n' }),
    )
    const nodeChecks = FILE_INPUT_RULES.filter((code) => !code.startsWith('GO_') && code !== 'CONFIG_PARSE_ERROR')
    expect(statusOf(result, nodeChecks)).toEqual(nodeChecks.map((code) => [code, 'skipped']))
    expect(statusOf(result, ['GO_SUM_MISSING'])).toEqual([['GO_SUM_MISSING', 'passed']])
  })
})

describe('doctor rules on degenerate input', () => {
  it('report nothing for an empty project with empty sections', async () => {
    const ctx = await projectContext()
    for (const rule of doctorRules) {
      expect(await rule.check(makeSections(), ctx), rule.code).toEqual([])
    }
    const result = await runDoctor(makeSections(), ctx)
    expect(result.diagnostics).toEqual([])
    expect(ctx.warnings).toEqual([])
  })

  it('run against a rich hand-built result without throwing, and emit only their own code', async () => {
    const sections = sectionsOf(sampleScanResult())
    const ctx = await projectContext({ 'package.json': '{"name":"acme"}' })
    for (const rule of doctorRules) {
      const found = await rule.check(sections, ctx)
      for (const diagnostic of found) {
        expect(diagnostic.code).toBe(rule.code)
        expect(diagnostic.category).toBe(rule.category)
      }
      expectWellFormed(found)
    }
    const result = await runDoctor(sections, ctx)
    expect(ctx.warnings.filter((w) => w.message.startsWith('Doctor check'))).toEqual([])
    expect(result.checks).toHaveLength(doctorRules.length)
    expect(result.diagnostics.map((d) => d.code)).toEqual(
      expect.arrayContaining(['TRACKED_ENV_FILE', 'ENV_UNDOCUMENTED', 'NODE_VERSION_CONFLICT', 'RUNTIME_EOL']),
    )
  })
})
