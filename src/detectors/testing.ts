import { manifests } from '../facts/manifests.ts'
import { ownerOf, SOURCE_EXTENSIONS } from '../facts/source-files.ts'
import type { Detector, ProjectContext, ToolKind } from '../types.ts'
import { isTestFileName, isUnder } from '../utils/path-roles.ts'
import { baseName, extOf } from '../utils/paths.ts'
import type { Invocation } from './knowledge/commands.ts'
import { goModuleOf, locateFiles } from './knowledge/layout.ts'
import { pythonFacts } from './knowledge/python.ts'
import { configEvidence, type Signal } from './knowledge/signals.ts'
import {
  detectTools,
  JS_EXTENSIONS,
  type ScriptMatcher,
  sortTools,
  type ToolSpec,
  toolFacts,
} from './knowledge/tools.ts'

const JS = JS_EXTENSIONS

export const TESTING_KIND_ORDER: readonly ToolKind[] = ['test', 'e2e']

/** node/tsx options whose value is the next argument (so it is not the script). */
const NODE_VALUE_FLAGS = new Set([
  '--import',
  '--require',
  '-r',
  '--loader',
  '--experimental-loader',
  '--env-file',
  '--conditions',
  '-C',
  '--input-type',
  '--title',
  '--watch-path',
  '--test-reporter',
  '--test-reporter-destination',
  '--test-name-pattern',
  '--test-skip-pattern',
  '--test-concurrency',
  '--test-timeout',
  '--test-shard',
  '--tsconfig',
])

/** `node --test` / `tsx --test`; a `--test` after the script path belongs to the script (`node run.js --test`). */
export function runsNodeTest(invocation: Invocation): boolean {
  if (invocation.bin !== 'node' && invocation.bin !== 'tsx') return false
  const { args } = invocation
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === '--test') return true
    if (NODE_VALUE_FLAGS.has(arg)) i++
    else if (!arg.startsWith('-')) return false
  }
  return false
}

export function runsBunTest(invocation: Invocation): boolean {
  return invocation.bin === 'bun' && invocation.args[0] === 'test'
}

const NODE_TEST: ScriptMatcher = { label: 'node --test', test: runsNodeTest }
const BUN_TEST: ScriptMatcher = { label: 'bun test', test: runsBunTest }

/** Known test frameworks. "go-test" and pytest's conftest/ini files are found by the detector itself. */
export const TEST_TOOLS: readonly ToolSpec[] = [
  {
    id: 'vitest',
    name: 'Vitest',
    kind: 'test',
    dependencies: ['vitest'],
    bins: ['vitest'],
    configs: [`vitest.config.${JS}`, `vitest.workspace.${JS}`, 'vitest.workspace.json'],
  },
  {
    id: 'jest',
    name: 'Jest',
    kind: 'test',
    dependencies: ['jest'],
    bins: ['jest'],
    configs: [`jest.config.${JS}`, 'jest.config.json'],
    packageJsonFields: [{ key: 'jest' }],
  },
  {
    id: 'mocha',
    name: 'Mocha',
    kind: 'test',
    dependencies: ['mocha'],
    bins: ['mocha'],
    shortConfigFlag: false,
    configs: ['.mocharc', '.mocharc.{js,cjs,mjs,json,jsonc,yml,yaml}'],
    packageJsonFields: [{ key: 'mocha' }],
  },
  {
    id: 'ava',
    name: 'AVA',
    kind: 'test',
    dependencies: ['ava'],
    bins: ['ava'],
    configs: [`ava.config.${JS}`],
    packageJsonFields: [{ key: 'ava' }],
  },
  {
    id: 'jasmine',
    name: 'Jasmine',
    kind: 'test',
    dependencies: ['jasmine'],
    weakDependencies: ['jasmine-core'],
    configs: ['spec/support/jasmine.{json,js,mjs,cjs}'],
  },
  { id: 'karma', name: 'Karma', kind: 'test', dependencies: ['karma'], configs: [`karma.conf.${JS}`] },
  { id: 'node-test', name: 'node:test', kind: 'test', scripts: [NODE_TEST] },
  { id: 'bun-test', name: 'Bun test', kind: 'test', scripts: [BUN_TEST] },
  {
    id: 'testing-library',
    name: 'Testing Library',
    kind: 'test',
    dependencyPrefixes: ['@testing-library/'],
    reportVersion: false,
  },
  { id: 'go-test', name: 'go test', kind: 'test' },
  { id: 'testify', name: 'testify', kind: 'test', dependencies: ['github.com/stretchr/testify'] },
  {
    id: 'ginkgo',
    name: 'Ginkgo',
    kind: 'test',
    dependencies: ['github.com/onsi/ginkgo/v2', 'github.com/onsi/ginkgo'],
  },
  {
    id: 'pytest',
    name: 'pytest',
    kind: 'test',
    pythonPackages: ['pytest'],
    pyprojectTables: ['tool.pytest'],
    configs: ['pytest.ini'],
  },
  {
    id: 'playwright',
    name: 'Playwright',
    kind: 'e2e',
    dependencies: ['@playwright/test'],
    // The `playwright` package alone is also used for browser automation outside tests.
    weakDependencies: ['playwright'],
    bins: ['playwright'],
    configs: [`playwright.config.${JS}`],
  },
  {
    id: 'cypress',
    name: 'Cypress',
    kind: 'e2e',
    dependencies: ['cypress'],
    configs: [`cypress.config.${JS}`, 'cypress.json'],
  },
]

// ---------------------------------------------------------------------------
// Test files
// ---------------------------------------------------------------------------

/** Jest's default convention: every source file below a __tests__ directory is a test. */
const JEST_TESTS_DIR = '__tests__'

/** Sample data for tests (never compiled or collected as the project's own tests). */
export function isFixturePath(path: string): boolean {
  return isUnder(path, ['fixture'])
}

/**
 * Does the path look like one of the project's test files (*.test.ts,
 * *.spec.js, __tests__/…, *_test.go, test_*.py, *_spec.rb)? Files inside
 * fixture directories are sample data and do not count.
 */
export function isTestFile(path: string): boolean {
  if (isFixturePath(path)) return false
  if (isTestFileName(path)) return true
  return path.split('/').slice(0, -1).includes(JEST_TESTS_DIR) && SOURCE_EXTENSIONS.has(extOf(path))
}

export function countTestFiles(files: readonly string[]): number {
  let count = 0
  for (const file of files) if (isTestFile(file)) count++
  return count
}

// ---------------------------------------------------------------------------
// Signals the tables cannot express
// ---------------------------------------------------------------------------

/**
 * One signal per Go module that contains *_test.go files. Test files outside
 * every Go module cannot be run with `go test` in module mode, so they are
 * only a low-confidence hint, attributed with `ownerOfFile`.
 */
export function goTestSignals(
  testFiles: readonly string[],
  goModuleDirs: readonly string[],
  ownerOfFile: (file: string) => string,
): Signal[] {
  const moduleDirs = new Set(goModuleDirs)
  const perPackage = new Map<string, { count: number; inModule: boolean }>()
  for (const file of testFiles) {
    if (isFixturePath(file)) continue
    const module = goModuleOf(file, moduleDirs)
    const owner = module ?? ownerOfFile(file)
    const inModule = module !== null
    const entry = perPackage.get(owner) ?? { count: 0, inModule: false }
    entry.count++
    entry.inModule ||= inModule
    perPackage.set(owner, entry)
  }
  return [...perPackage].map(([pkg, { count, inModule }]) => ({
    package: pkg,
    confidence: inModule ? 'high' : 'low',
    evidence: `${count} *_test.go file${count === 1 ? '' : 's'}${pkg === '.' ? '' : ` in ${pkg}`}`,
  }))
}

const PYTEST_INI_SECTIONS: Readonly<Record<string, RegExp>> = {
  'setup.cfg': /^\[tool:pytest\]/m,
  'tox.ini': /^\[pytest\]/m,
}

async function pytestSignals(ctx: ProjectContext): Promise<Signal[]> {
  const project = await ctx.use(manifests)
  const { layout } = await ctx.use(toolFacts)
  const signals: Signal[] = []
  for (const file of ctx.files.byName('conftest.py')) {
    if (isFixturePath(file)) continue
    signals.push({
      package: ownerOf(project, file),
      confidence: 'high',
      evidence: configEvidence(file),
      configFile: file,
    })
  }
  for (const located of locateFiles(layout, Object.keys(PYTEST_INI_SECTIONS))) {
    const section = PYTEST_INI_SECTIONS[baseName(located.path)]
    const text = section ? await ctx.readText(located.path) : null
    if (text === null || !section?.test(text)) continue
    signals.push({
      package: located.package,
      confidence: 'high',
      evidence: configEvidence(located.path, 'pytest section'),
      configFile: located.path,
    })
  }
  return signals
}

export const testingDetector: Detector<'testing'> = {
  id: 'testing',
  title: 'Testing',
  async run(ctx) {
    const [facts, python, project] = await Promise.all([ctx.use(toolFacts), ctx.use(pythonFacts), ctx.use(manifests)])
    const goTestFiles = ctx.files.byExtension('.go').filter((file) => file.endsWith('_test.go'))
    const extra: Record<string, Signal[]> = {
      'go-test': goTestSignals(
        goTestFiles,
        project.goModules.map((mod) => mod.dir),
        (file) => ownerOf(project, file),
      ),
      pytest: await pytestSignals(ctx),
    }
    const tools = detectTools(TEST_TOOLS, { ...facts, python }, extra)
    return { tools: sortTools(tools, TESTING_KIND_ORDER), testFiles: countTestFiles(ctx.files.files) }
  },
}
