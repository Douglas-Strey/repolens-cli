import { describe, expect, it } from 'vitest'
import {
  countTestFiles,
  goTestSignals,
  isTestFile,
  runsBunTest,
  runsNodeTest,
  TEST_TOOLS,
  TESTING_KIND_ORDER,
  testingDetector,
} from '../../src/detectors/testing.ts'
import type { TestingSection } from '../../src/types.ts'
import { contextFor, fixtureContext, makeProject, SECRET_SENTINEL } from '../helpers.ts'

async function fixtureTesting(name: string): Promise<TestingSection> {
  const ctx = await fixtureContext(name)
  return ctx.use(testingDetector)
}

async function projectTesting(files: Record<string, string>): Promise<TestingSection> {
  const ctx = await contextFor(await makeProject(files))
  return ctx.use(testingDetector)
}

const pkg = (fields: Record<string, unknown>) => JSON.stringify({ name: 'demo', ...fields })

describe('testing detector on fixtures', () => {
  it('nuxt-app: Vitest with its config file', async () => {
    expect(await fixtureTesting('nuxt-app')).toEqual({
      testFiles: 1,
      tools: [
        {
          id: 'vitest',
          name: 'Vitest',
          kind: 'test',
          version: '4.0.3',
          configFiles: ['vitest.config.ts'],
          packages: ['.'],
          confidence: 'high',
          evidence: ['devDependency vitest@^4.0.3 in package.json', 'config file vitest.config.ts'],
        },
      ],
    })
  })

  it('next-app: Jest and Testing Library (without a single version)', async () => {
    const testing = await fixtureTesting('next-app')
    expect(testing.testFiles).toBe(1)
    expect(testing.tools.map((t) => [t.id, t.version, t.confidence])).toEqual([
      ['jest', '30.2.0', 'high'],
      ['testing-library', undefined, 'high'],
    ])
    expect(testing.tools[0]?.configFiles).toEqual(['jest.config.ts'])
    expect(testing.tools[1]?.evidence).toEqual(['devDependency @testing-library/react@^16.3.0 in package.json'])
  })

  it('nest-api: Jest configured in package.json and through --config', async () => {
    const testing = await fixtureTesting('nest-api')
    expect(testing.testFiles).toBe(1)
    expect(testing.tools).toEqual([
      {
        id: 'jest',
        name: 'Jest',
        kind: 'test',
        version: '30.2.0',
        configFiles: ['package.json', 'test/jest-e2e.json'],
        packages: ['.'],
        confidence: 'high',
        evidence: [
          'devDependency jest@^30.2.0 in package.json',
          '"jest" field in package.json',
          'config file test/jest-e2e.json (used by the "test:e2e" script)',
        ],
      },
    ])
  })

  it('express-api: node:test from the test script', async () => {
    expect(await fixtureTesting('express-api')).toEqual({
      testFiles: 1,
      tools: [
        {
          id: 'node-test',
          name: 'node:test',
          kind: 'test',
          configFiles: [],
          packages: ['.'],
          confidence: 'high',
          evidence: ['"test" script runs node --test in package.json'],
        },
      ],
    })
  })

  it('bun-app: Bun test', async () => {
    const testing = await fixtureTesting('bun-app')
    expect(testing.testFiles).toBe(1)
    expect(testing.tools.map((t) => [t.id, t.name, t.evidence])).toEqual([
      ['bun-test', 'Bun test', ['"test" script runs bun test in package.json']],
    ])
  })

  it('go-api: go test from *_test.go files', async () => {
    expect(await fixtureTesting('go-api')).toEqual({
      testFiles: 1,
      tools: [
        {
          id: 'go-test',
          name: 'go test',
          kind: 'test',
          configFiles: [],
          packages: ['.'],
          confidence: 'high',
          evidence: ['1 *_test.go file'],
        },
      ],
    })
  })

  it('plain-repo: pytest from requirements.txt', async () => {
    expect(await fixtureTesting('plain-repo')).toEqual({
      testFiles: 1,
      tools: [
        {
          id: 'pytest',
          name: 'pytest',
          kind: 'test',
          version: '8.4.2',
          configFiles: [],
          packages: ['.'],
          confidence: 'high',
          evidence: ['dependency pytest==8.4.2 in requirements.txt'],
        },
      ],
    })
  })

  it('fastify-api and monorepo: Vitest attributed to the declaring package', async () => {
    const fastify = await fixtureTesting('fastify-api')
    expect(fastify.tools.map((t) => [t.id, t.packages])).toEqual([['vitest', ['.']]])
    expect(fastify.testFiles).toBe(1)
    const monorepo = await fixtureTesting('monorepo')
    expect(monorepo.tools.map((t) => [t.id, t.version, t.packages])).toEqual([['vitest', '4.0.3', ['apps/api']]])
    expect(monorepo.testFiles).toBe(0)
  })

  it('does not crash on broken input', async () => {
    expect(await fixtureTesting('broken-config')).toEqual({ tools: [], testFiles: 0 })
    expect(await fixtureTesting('broken-manifest')).toEqual({ tools: [], testFiles: 0 })
  })
})

describe('test files', () => {
  it('recognizes common naming conventions', () => {
    for (const file of [
      'src/a.test.ts',
      'src/a.spec.tsx',
      'a.test.mjs',
      'b.spec.cjs',
      'test/app.e2e-spec.ts',
      'src/__tests__/util.ts',
      '__tests__/page.jsx',
      'pkg/handler_test.go',
      'tests/test_util.py',
      'tests/util_test.py',
      'spec/model_spec.rb',
    ]) {
      expect(isTestFile(file), file).toBe(true)
    }
  })

  it('does not count look-alikes', () => {
    for (const file of [
      'src/test.ts',
      'src/testing.ts',
      'src/latest.ts',
      'src/__tests__/snapshot.snap',
      'src/contest.go',
      'docs/test_plan.md',
      'tests/conftest.py',
      'src/a.test.json',
    ]) {
      expect(isTestFile(file), file).toBe(false)
    }
  })

  it('counts each file once', () => {
    expect(countTestFiles(['src/__tests__/a.test.ts', 'b.spec.ts', 'c.ts'])).toBe(2)
    expect(countTestFiles([])).toBe(0)
  })
  it('skips files in fixture directories (the shared path roles), whatever their name', () => {
    for (const file of [
      'test/fixtures/app/src/a.test.ts',
      'src/__fixtures__/b.spec.js',
      'pkg/testdata/x_test.go',
      'src/mocks/handlers.test.ts',
      'test/Fixtures/c.test.ts',
    ]) {
      expect(isTestFile(file), file).toBe(false)
    }
    // Tests next to example code are still tests.
    expect(isTestFile('examples/demo/app.test.ts')).toBe(true)
  })
})

describe('script matchers', () => {
  it('node --test and bun test', () => {
    expect(runsNodeTest({ bin: 'node', args: ['--test'] })).toBe(true)
    expect(runsNodeTest({ bin: 'node', args: ['--import', 'tsx', '--test', 'test/'] })).toBe(true)
    expect(runsNodeTest({ bin: 'tsx', args: ['--test'] })).toBe(true)
    expect(runsNodeTest({ bin: 'node', args: ['--test-reporter=spec', 'x.js'] })).toBe(false)
    expect(runsNodeTest({ bin: 'node', args: ['server.js'] })).toBe(false)
    expect(runsNodeTest({ bin: 'node', args: ['--experimental-strip-types', '--test', 'src/'] })).toBe(true)
    expect(runsNodeTest({ bin: 'node', args: ['-r', 'ts-node/register', '--test'] })).toBe(true)
    // A --test after the script path is the script's own argument.
    expect(runsNodeTest({ bin: 'node', args: ['scripts/release.js', '--test'] })).toBe(false)
    expect(runsNodeTest({ bin: 'tsx', args: ['watch', 'src/cli.ts', '--test'] })).toBe(false)
    expect(runsBunTest({ bin: 'bun', args: ['test'] })).toBe(true)
    expect(runsBunTest({ bin: 'bun', args: ['run', 'test'] })).toBe(false)
  })
})

describe('testing detector on inline projects', () => {
  it('Playwright: @playwright/test is high, the playwright library alone is medium', async () => {
    const weak = await projectTesting({ 'package.json': pkg({ devDependencies: { playwright: '^1.55.0' } }) })
    expect(weak.tools.map((t) => [t.id, t.kind, t.confidence])).toEqual([['playwright', 'e2e', 'medium']])
    const strong = await projectTesting({
      'package.json': pkg({ devDependencies: { '@playwright/test': '^1.55.0' } }),
      'playwright.config.ts': 'export default {}',
    })
    expect(strong.tools.map((t) => [t.id, t.version, t.confidence, t.configFiles])).toEqual([
      ['playwright', '1.55.0', 'high', ['playwright.config.ts']],
    ])
  })

  it('orders unit test runners before e2e tools', async () => {
    const testing = await projectTesting({
      'package.json': pkg({
        devDependencies: { cypress: '^15.0.0', vitest: '^4.0.0', '@testing-library/vue': '^8.0.0' },
      }),
    })
    expect(testing.tools.map((t) => t.id)).toEqual(['testing-library', 'vitest', 'cypress'])
  })

  it('pytest from pyproject.toml, conftest.py and setup.cfg', async () => {
    const testing = await projectTesting({
      'pyproject.toml': '[dependency-groups]\ndev = ["pytest>=8.3"]\n\n[tool.pytest.ini_options]\naddopts = "-q"\n',
      'tests/conftest.py': 'import pytest\n',
      'setup.cfg': '[metadata]\nname = demo\n\n[tool:pytest]\ntestpaths = tests\n',
      'tests/test_app.py': 'def test_ok():\n    assert True\n',
    })
    expect(testing.testFiles).toBe(1)
    expect(testing.tools).toEqual([
      {
        id: 'pytest',
        name: 'pytest',
        kind: 'test',
        version: '>=8.3',
        configFiles: ['pyproject.toml', 'setup.cfg', 'tests/conftest.py'],
        packages: ['.'],
        confidence: 'high',
        evidence: [
          'dependency pytest>=8.3 in pyproject.toml',
          '[tool.pytest] in pyproject.toml',
          'config file tests/conftest.py',
          'config file setup.cfg (pytest section)',
        ],
      },
    ])
  })

  it('setup.cfg or tox.ini without a pytest section do not count', async () => {
    const testing = await projectTesting({ 'setup.cfg': '[metadata]\nname = demo\n', 'tox.ini': '[tox]\n' })
    expect(testing.tools).toEqual([])
  })

  it('Go test tools and per-module go test attribution', async () => {
    const testing = await projectTesting({
      'go.mod': 'module example.com/root\n\ngo 1.25\n\nrequire github.com/stretchr/testify v1.11.1\n',
      'root_test.go': 'package root\n',
      'tools/lint/go.mod': 'module example.com/lint\n\ngo 1.25\n',
      'tools/lint/a_test.go': 'package lint\n',
      'tools/lint/b_test.go': 'package lint\n',
    })
    expect(testing.testFiles).toBe(3)
    expect(testing.tools.map((t) => [t.id, t.version, t.packages, t.evidence])).toEqual([
      ['go-test', undefined, ['.', 'tools/lint'], ['1 *_test.go file', '2 *_test.go files in tools/lint']],
      ['testify', '1.11.1', ['.'], ['dependency github.com/stretchr/testify@v1.11.1 in go.mod']],
    ])
  })

  it('go test files outside every Go module are a low-confidence hint; fixtures are ignored', () => {
    expect(
      goTestSignals(['a_test.go', 'svc/b_test.go', 'testdata/c_test.go'], ['svc'], (f) =>
        f.startsWith('svc/') ? 'svc' : '.',
      ),
    ).toEqual([
      { package: '.', confidence: 'low', evidence: '1 *_test.go file' },
      { package: 'svc', confidence: 'high', evidence: '1 *_test.go file in svc' },
    ])
  })

  it('attributes go test files to their Go module, not to a nested Node package', async () => {
    const testing = await projectTesting({
      'go.mod': 'module example.com/app\n\ngo 1.25\n',
      'package.json': pkg({ private: true, workspaces: ['web'] }),
      'web/package.json': JSON.stringify({ name: 'web' }),
      'web/embed/assets_test.go': 'package embed\n',
    })
    expect(testing.tools.map((t) => [t.id, t.packages, t.confidence])).toEqual([['go-test', ['.'], 'high']])
  })

  it('ignores test files and conftest.py inside fixture directories', async () => {
    const testing = await projectTesting({
      'package.json': pkg({ devDependencies: { vitest: '^4.0.0' } }),
      'src/a.test.ts': '',
      'test/fixtures/app/src/b.test.ts': '',
      'test/fixtures/go/handler_test.go': 'package go\n',
      'test/fixtures/py/conftest.py': '',
      'pkg/testdata/x_test.go': 'package x\n',
      '__fixtures__/c.spec.js': '',
    })
    expect(testing.testFiles).toBe(1)
    expect(testing.tools.map((t) => t.id)).toEqual(['vitest'])
  })

  it('never echoes secret values from requirement files or scripts', async () => {
    const testing = await projectTesting({
      'package.json': pkg({ scripts: { test: `API_TOKEN=${SECRET_SENTINEL} node --test` } }),
      'requirements-dev.txt': `--extra-index-url https://user:${SECRET_SENTINEL}@pypi.example.com/simple\npytest\n`,
    })
    expect(testing.tools.map((t) => t.id)).toEqual(['node-test', 'pytest'])
    expect(JSON.stringify(testing)).not.toContain(SECRET_SENTINEL)
  })
})

describe('table', () => {
  it('has unique ids and every kind is ordered', () => {
    const ids = TEST_TOOLS.map((tool) => tool.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const tool of TEST_TOOLS) expect(TESTING_KIND_ORDER).toContain(tool.kind)
  })
})
