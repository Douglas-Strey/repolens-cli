import { describe, expect, it } from 'vitest'
import {
  findMissingLintScript,
  findMissingTestScript,
  findTestPlaceholder,
  hasLintScript,
  isJsTestFile,
  isNpmTestPlaceholder,
  scriptMissingLint,
  scriptMissingTest,
  scriptTestPlaceholder,
} from '../../src/doctor/rules/scripts.ts'
import type { Script, Tool } from '../../src/types.ts'
import { makeSections, projectContext, runCheck, runRule } from './support.ts'

const PLACEHOLDER = 'echo "Error: no test specified" && exit 1'

function tool(id: string, name: string, kind: Tool['kind'], overrides: Partial<Tool> = {}): Tool {
  return { id, name, kind, configFiles: [], packages: ['.'], confidence: 'high', evidence: [], ...overrides }
}

function script(name: string, overrides: Partial<Script> = {}): Script {
  return { name, command: name, run: `make ${name}`, source: 'Makefile', category: 'other', ...overrides }
}

describe('isNpmTestPlaceholder', () => {
  it('recognizes the npm init placeholder and its variants', () => {
    expect(isNpmTestPlaceholder(PLACEHOLDER)).toBe(true)
    expect(isNpmTestPlaceholder("echo 'Error: no test specified' && exit 1")).toBe(true)
    expect(isNpmTestPlaceholder('  echo Error: no test specified&&exit 1  ')).toBe(true)
  })

  it('does not match real commands', () => {
    expect(isNpmTestPlaceholder('vitest run')).toBe(false)
    expect(isNpmTestPlaceholder(`${PLACEHOLDER} || vitest`)).toBe(false)
  })
})

describe('SCRIPT_TEST_PLACEHOLDER', () => {
  it('reports the placeholder', () => {
    expect(findTestPlaceholder({ test: PLACEHOLDER })).toEqual([
      {
        code: 'SCRIPT_TEST_PLACEHOLDER',
        severity: 'info',
        category: 'scripts',
        message: 'The "test" script in package.json is the npm placeholder that always fails',
        hint: 'Replace it with a real test command or remove it',
        files: ['package.json'],
        subject: 'test',
      },
    ])
    expect(findTestPlaceholder({ test: 'jest' })).toEqual([])
    expect(findTestPlaceholder({})).toEqual([])
  })

  it('suggests the installed test runner', async () => {
    const ctx = await projectContext({
      'package.json': JSON.stringify({ scripts: { test: PLACEHOLDER }, devDependencies: { vitest: '^3.2.4' } }),
    })
    const found = await runCheck(scriptTestPlaceholder, makeSections(), ctx)
    expect(found[0]?.hint).toBe('Replace it with your test command (e.g. "test": "vitest run") or remove it')
  })

  it('does nothing without a valid root package.json', async () => {
    expect(
      await runCheck(scriptTestPlaceholder, makeSections(), await projectContext({ 'package.json': '{ nope' })),
    ).toEqual([])
  })
})

describe('SCRIPT_MISSING_TEST', () => {
  const base = { rootScripts: {}, setup: { tools: [] }, hasTestFiles: false, taskRunnerTest: false }

  it('reports configured test tools without a test script', () => {
    const found = findMissingTestScript({ ...base, setup: { tools: ['Vitest'], command: 'vitest run' } })
    expect(found).toEqual([
      {
        code: 'SCRIPT_MISSING_TEST',
        severity: 'info',
        category: 'scripts',
        message: 'Vitest is set up, but package.json has no "test" script',
        hint: 'Add "test": "vitest run" to the scripts in package.json',
        files: ['package.json'],
        subject: 'test',
      },
    ])
  })

  it('reports test files without a test script', () => {
    const found = findMissingTestScript({ ...base, hasTestFiles: true })
    expect(found[0]?.message).toBe('The project has test files, but package.json has no "test" script')
  })

  it('accepts test:* scripts and Makefile targets, and stays quiet without tests', () => {
    expect(findMissingTestScript({ ...base, hasTestFiles: true, rootScripts: { 'test:unit': 'vitest' } })).toEqual([])
    expect(findMissingTestScript({ ...base, hasTestFiles: true, taskRunnerTest: true })).toEqual([])
    expect(findMissingTestScript(base)).toEqual([])
  })

  it('recognizes JavaScript test files', () => {
    for (const file of ['src/a.test.ts', 'b.spec.jsx', 'lib/__tests__/x.js', 'pkg/__tests__/deep/y.mts']) {
      expect(isJsTestFile(file), file).toBe(true)
    }
    for (const file of ['main_test.go', 'src/test.ts', 'tests/fixtures/data.json', 'contest.js']) {
      expect(isJsTestFile(file), file).toBe(false)
    }
  })

  it('combines the testing section, dependencies and files through the rule', async () => {
    const ctx = await projectContext({
      'package.json': JSON.stringify({ scripts: { build: 'tsc' } }),
      'src/sum.test.ts': 'export {}',
    })
    expect((await runCheck(scriptMissingTest, makeSections(), ctx)).map((d) => d.code)).toEqual(['SCRIPT_MISSING_TEST'])
    const withMake = makeSections({
      scripts: { runner: 'npm run', scripts: [script('test', { category: 'test' })] },
    })
    expect(await runCheck(scriptMissingTest, withMake, ctx)).toEqual([])
    const withTool = makeSections({ testing: { tools: [tool('jest', 'Jest', 'test')], testFiles: 0 } })
    const noFiles = await projectContext({ 'package.json': '{}' })
    expect((await runCheck(scriptMissingTest, withTool, noFiles))[0]?.message).toBe(
      'Jest is set up, but package.json has no "test" script',
    )
  })

  it('is skipped, not passed, without package.json or without anything to test', async () => {
    const withTool = makeSections({ testing: { tools: [tool('jest', 'Jest', 'test')], testFiles: 0 } })
    const noPackageJson = await projectContext({ 'src/sum.test.ts': 'export {}' })
    expect((await runRule(scriptMissingTest, withTool, noPackageJson)).checks[0]?.status).toBe('skipped')
    const nothingToTest = await projectContext({ 'package.json': '{}', 'src/index.ts': 'export {}' })
    expect((await runRule(scriptMissingTest, makeSections(), nothingToTest)).checks[0]?.status).toBe('skipped')
    const withScript = await projectContext({ 'package.json': JSON.stringify({ scripts: { test: 'jest' } }) })
    expect((await runRule(scriptMissingTest, withTool, withScript)).checks[0]?.status).toBe('passed')
  })

  it('does not count test files inside fixtures, examples or templates', async () => {
    const ctx = await projectContext({
      'package.json': '{}',
      'test/fixtures/app/src/a.test.ts': 'export {}',
      'examples/demo/b.spec.js': 'export {}',
    })
    expect((await runRule(scriptMissingTest, makeSections(), ctx)).checks[0]?.status).toBe('skipped')
  })
})

describe('SCRIPT_TEST_PLACEHOLDER applicability', () => {
  it('is skipped without a root "test" script', async () => {
    const ctx = await projectContext({ 'package.json': JSON.stringify({ scripts: { build: 'tsc' } }) })
    expect((await runRule(scriptTestPlaceholder, makeSections(), ctx)).checks[0]?.status).toBe('skipped')
    const placeholder = await projectContext({ 'package.json': JSON.stringify({ scripts: { test: PLACEHOLDER } }) })
    const sections = makeSections({
      scripts: {
        runner: 'npm run',
        scripts: [{ name: 'test', command: PLACEHOLDER, run: 'npm test', source: 'package.json', category: 'test' }],
      },
    })
    expect((await runRule(scriptTestPlaceholder, sections, placeholder)).checks[0]?.status).toBe('failed')
  })
})

describe('SCRIPT_MISSING_LINT', () => {
  const eslint = tool('eslint', 'ESLint', 'linter', { configFiles: ['eslint.config.js'] })
  const base = {
    linters: [eslint],
    hasPackageJson: true,
    rootScripts: {},
    hasRootLintScript: false,
    hasTaskFile: false,
  }

  it('reports a configured linter without a lint script', () => {
    expect(findMissingLintScript(base)).toEqual([
      {
        code: 'SCRIPT_MISSING_LINT',
        severity: 'info',
        category: 'scripts',
        message: 'ESLint is configured, but package.json has no lint script',
        hint: 'Add "lint": "eslint ." to the scripts in package.json',
        files: ['package.json'],
        subject: 'lint',
      },
    ])
  })

  it('accepts lint scripts by name, by command, or from the scripts section', () => {
    expect(hasLintScript({ 'lint:js': 'eslint src' })).toBe(true)
    expect(hasLintScript({ check: 'biome check .' })).toBe(true)
    expect(hasLintScript({ ci: 'pnpm lint && pnpm test' })).toBe(true)
    expect(hasLintScript({ format: 'biome format --write .', build: 'tsc' })).toBe(false)
    expect(findMissingLintScript({ ...base, rootScripts: { check: 'eslint . && tsc' } })).toEqual([])
    expect(findMissingLintScript({ ...base, hasRootLintScript: true })).toEqual([])
  })

  it('suggests a Makefile target for projects without package.json', () => {
    const golangci = tool('golangci-lint', 'golangci-lint', 'linter')
    const found = findMissingLintScript({ ...base, linters: [golangci], hasPackageJson: false, hasTaskFile: true })
    expect(found[0]).toMatchObject({
      message: 'golangci-lint is configured, but no root task runs it',
      hint: 'Add a lint target to your Makefile or justfile that runs golangci-lint run',
    })
    expect(found[0]?.files).toBeUndefined()
    expect(findMissingLintScript({ ...base, linters: [golangci], hasPackageJson: false })).toEqual([])
  })

  it('only considers linters of the root package', async () => {
    const nested = tool('eslint', 'ESLint', 'linter', {
      packages: ['apps/web'],
      configFiles: ['apps/web/.eslintrc.json'],
    })
    const formatter = tool('prettier', 'Prettier', 'formatter')
    const ctx = await projectContext({ 'package.json': '{}' })
    expect(await runCheck(scriptMissingLint, makeSections({ linting: { tools: [nested, formatter] } }), ctx)).toEqual(
      [],
    )
    expect(await runCheck(scriptMissingLint, makeSections({ linting: { tools: [eslint] } }), ctx)).toHaveLength(1)
    expect((await runRule(scriptMissingLint, makeSections())).checks[0]?.status).toBe('skipped')
  })
})
