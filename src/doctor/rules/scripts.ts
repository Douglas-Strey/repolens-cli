import { dependencies } from '../../facts/dependencies.ts'
import { manifests } from '../../facts/manifests.ts'
import type { Diagnostic, DoctorRule, ProjectContext, Script, Sections, Tool } from '../../types.ts'
import { isTestFileName, isUnder } from '../../utils/path-roles.ts'
import { formatList, hasRootPackageJson, isRootPath, unique } from './shared.ts'

/** The body `npm init` writes for "test". */
export function isNpmTestPlaceholder(command: string): boolean {
  return /^echo\s+(["']?)Error: no test specified\1\s*&&\s*exit\s+1\s*;?$/i.test(command.trim())
}

/** Test runners RepoLens recognizes from dependencies, with the command a "test" script would run. */
const TEST_RUNNERS: ReadonlyArray<{ dependency: string; id: string; name: string; command: string }> = [
  { dependency: 'vitest', id: 'vitest', name: 'Vitest', command: 'vitest run' },
  { dependency: 'jest', id: 'jest', name: 'Jest', command: 'jest' },
  { dependency: 'mocha', id: 'mocha', name: 'Mocha', command: 'mocha' },
  { dependency: 'ava', id: 'ava', name: 'AVA', command: 'ava' },
  { dependency: 'jasmine', id: 'jasmine', name: 'Jasmine', command: 'jasmine' },
  { dependency: 'tap', id: 'tap', name: 'tap', command: 'tap' },
  { dependency: 'uvu', id: 'uvu', name: 'uvu', command: 'uvu' },
  { dependency: '@playwright/test', id: 'playwright', name: 'Playwright', command: 'playwright test' },
  { dependency: 'cypress', id: 'cypress', name: 'Cypress', command: 'cypress run' },
]

const LINT_COMMANDS: Readonly<Record<string, string>> = {
  eslint: 'eslint .',
  biome: 'biome check .',
  oxlint: 'oxlint',
  'golangci-lint': 'golangci-lint run',
  stylelint: 'stylelint "**/*.css"',
  xo: 'xo',
  standard: 'standard',
}

// `(?!-)`: "standard-version" and "xo-…" are not linters.
const LINT_COMMAND = /\b(?:eslint|biome\s+(?:check|lint|ci)|oxlint|golangci-lint|stylelint|xo|standard|lint)\b(?!-)/

const TASK_FILES = [
  'Makefile',
  'makefile',
  'GNUmakefile',
  'justfile',
  'Justfile',
  '.justfile',
  'Taskfile.yml',
  'Taskfile.yaml',
]

const JS_FILE = /\.[cm]?[jt]sx?$/

/** `*.test.ts`, `*.spec.jsx`, `__tests__/x.js`, … (by name only; callers decide about fixture directories). */
export function isJsTestFile(path: string): boolean {
  if (!JS_FILE.test(path)) return false
  return isTestFileName(path) || path.split('/').slice(0, -1).includes('__tests__')
}

/** Test files of the project itself, not of fixtures, examples or templates. */
function isProjectJsTestFile(path: string): boolean {
  return isJsTestFile(path) && !isUnder(path, ['fixture', 'example', 'template'])
}

/** Scripts from root-level task files (Makefile, justfile, Taskfile), which also count as project commands. */
function rootTaskScripts(scan: Sections): Script[] {
  return scan.scripts.scripts.filter((script) => isRootPath(script.source) && script.source !== 'package.json')
}

export interface RootTestSetup {
  /** Test tools of the root package, as display names. */
  tools: string[]
  /** Command a "test" script could run, when a runner is known. */
  command?: string
}

/** Testing tools of the root package: from the testing section, else from root dependencies. */
async function rootTestSetup(scan: Sections, ctx: ProjectContext): Promise<RootTestSetup> {
  const fromSection = scan.testing.tools.filter(
    (tool) => (tool.kind === 'test' || tool.kind === 'e2e') && tool.packages.includes('.'),
  )
  const deps = await ctx.use(dependencies)
  const fromDeps = TEST_RUNNERS.filter((runner) => deps.has(runner.dependency, '.'))
  const tools = fromSection.length > 0 ? fromSection.map((tool) => tool.name) : fromDeps.map((runner) => runner.name)
  const ids = [...fromSection.map((tool) => tool.id), ...fromDeps.map((runner) => runner.id)]
  const command = ids.map((id) => TEST_RUNNERS.find((runner) => runner.id === id)?.command).find(Boolean)
  return command ? { tools: unique(tools), command } : { tools: unique(tools) }
}

export function findTestPlaceholder(rootScripts: Readonly<Record<string, string>>, command?: string): Diagnostic[] {
  const test = rootScripts.test
  if (test === undefined || !isNpmTestPlaceholder(test)) return []
  return [
    {
      code: 'SCRIPT_TEST_PLACEHOLDER',
      severity: 'info',
      category: 'scripts',
      message: 'The "test" script in package.json is the npm placeholder that always fails',
      hint: command
        ? `Replace it with your test command (e.g. "test": "${command}") or remove it`
        : 'Replace it with a real test command or remove it',
      files: ['package.json'],
      subject: 'test',
    },
  ]
}

export interface MissingTestInput {
  rootScripts: Readonly<Record<string, string>>
  setup: RootTestSetup
  hasTestFiles: boolean
  /** A root Makefile/justfile/Taskfile already has a test target. */
  taskRunnerTest: boolean
}

export function findMissingTestScript(input: MissingTestInput): Diagnostic[] {
  const names = Object.keys(input.rootScripts)
  if (names.some((name) => name === 'test' || name.startsWith('test:')) || input.taskRunnerTest) return []
  const { tools, command } = input.setup
  if (tools.length === 0 && !input.hasTestFiles) return []
  return [
    {
      code: 'SCRIPT_MISSING_TEST',
      severity: 'info',
      category: 'scripts',
      message:
        tools.length > 0
          ? `${formatList(tools)} ${tools.length === 1 ? 'is' : 'are'} set up, but package.json has no "test" script`
          : 'The project has test files, but package.json has no "test" script',
      hint: command
        ? `Add "test": "${command}" to the scripts in package.json`
        : 'Add a "test" script to package.json that runs the tests',
      files: ['package.json'],
      subject: 'test',
    },
  ]
}

/** Does any script look like it lints (by name or by the command it runs)? */
export function hasLintScript(scripts: Readonly<Record<string, string>>): boolean {
  return Object.entries(scripts).some(([name, command]) => /^lint(?::|$)/.test(name) || LINT_COMMAND.test(command))
}

export interface MissingLintInput {
  /** Linters configured for the root package. */
  linters: readonly Tool[]
  hasPackageJson: boolean
  rootScripts: Readonly<Record<string, string>>
  /** Lint-category scripts from the scripts section at the root (package.json or task files). */
  hasRootLintScript: boolean
  hasTaskFile: boolean
}

export function findMissingLintScript(input: MissingLintInput): Diagnostic[] {
  if (input.linters.length === 0 || input.hasRootLintScript || hasLintScript(input.rootScripts)) return []
  // Without package.json or a task file there is no conventional place for a lint command.
  if (!input.hasPackageJson && !input.hasTaskFile) return []
  const names = unique(input.linters.map((tool) => tool.name))
  const command = input.linters.map((tool) => LINT_COMMANDS[tool.id.toLowerCase()]).find(Boolean)
  const target = input.hasPackageJson ? 'package.json has no lint script' : 'no root task runs it'
  const diagnostic: Diagnostic = {
    code: 'SCRIPT_MISSING_LINT',
    severity: 'info',
    category: 'scripts',
    message: `${formatList(names)} ${names.length === 1 ? 'is' : 'are'} configured, but ${target}`,
    hint: input.hasPackageJson
      ? `Add "lint": "${command ?? 'eslint .'}" to the scripts in package.json`
      : `Add a lint target to your Makefile or justfile that runs ${command ?? 'the linter'}`,
    subject: 'lint',
  }
  if (input.hasPackageJson) diagnostic.files = ['package.json']
  return [diagnostic]
}

/** Test runners or test files the root package could run with a "test" script. */
function hasTestSetup(scan: Sections, ctx: ProjectContext): boolean {
  if (scan.testing.tools.some((tool) => (tool.kind === 'test' || tool.kind === 'e2e') && tool.packages.includes('.'))) {
    return true
  }
  const root = scan.dependencies.packages.find((pkg) => pkg.path === '.' && pkg.ecosystem === 'node')
  if (root?.dependencies.some((dep) => TEST_RUNNERS.some((runner) => runner.dependency === dep.name))) return true
  return ctx.files.files.some(isProjectJsTestFile)
}

export const scriptTestPlaceholder: DoctorRule = {
  code: 'SCRIPT_TEST_PLACEHOLDER',
  category: 'scripts',
  title: 'The test script runs real tests',
  // Only a "test" script can be a placeholder.
  applies: (scan, ctx) =>
    hasRootPackageJson(ctx) &&
    scan.scripts.scripts.some((script) => script.source === 'package.json' && script.name === 'test'),
  async check(scan, ctx) {
    const project = await ctx.use(manifests)
    if (!project.root) return []
    return findTestPlaceholder(project.root.scripts, (await rootTestSetup(scan, ctx)).command)
  },
}

export const scriptMissingTest: DoctorRule = {
  code: 'SCRIPT_MISSING_TEST',
  category: 'scripts',
  title: 'package.json has a test script',
  // Without test runners or test files there is nothing a test script could run.
  applies: (scan, ctx) => hasRootPackageJson(ctx) && hasTestSetup(scan, ctx),
  async check(scan, ctx) {
    const project = await ctx.use(manifests)
    if (!project.root) return []
    return findMissingTestScript({
      rootScripts: project.root.scripts,
      setup: await rootTestSetup(scan, ctx),
      hasTestFiles: ctx.files.files.some(isProjectJsTestFile),
      taskRunnerTest: rootTaskScripts(scan).some((script) => script.name === 'test' || script.category === 'test'),
    })
  },
}

export const scriptMissingLint: DoctorRule = {
  code: 'SCRIPT_MISSING_LINT',
  category: 'scripts',
  title: 'A lint script runs the configured linter',
  applies: (scan, ctx) =>
    scan.linting.tools.some((tool) => tool.kind === 'linter') &&
    (ctx.files.has('package.json') || TASK_FILES.some((file) => ctx.files.has(file))),
  async check(scan, ctx) {
    const project = await ctx.use(manifests)
    const linters = scan.linting.tools.filter(
      (tool) => tool.kind === 'linter' && (tool.packages.includes('.') || tool.configFiles.some(isRootPath)),
    )
    const rootScripts = scan.scripts.scripts.filter((script) => isRootPath(script.source))
    return findMissingLintScript({
      linters,
      hasPackageJson: project.root !== null,
      rootScripts: project.root?.scripts ?? {},
      hasRootLintScript: rootScripts.some((script) => script.category === 'lint' || /^lint(?::|$)/.test(script.name)),
      hasTaskFile: TASK_FILES.some((file) => ctx.files.has(file)),
    })
  },
}

export const scriptRules: DoctorRule[] = [scriptTestPlaceholder, scriptMissingTest, scriptMissingLint]
