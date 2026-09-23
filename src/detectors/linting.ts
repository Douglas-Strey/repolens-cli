import type { Detector, ToolKind } from '../types.ts'
import { pythonFacts } from './knowledge/python.ts'
import {
  type ConfigPattern,
  detectTools,
  JS_EXTENSIONS,
  sortTools,
  type ToolSpec,
  toolFacts,
} from './knowledge/tools.ts'

const JS = JS_EXTENSIONS

export const LINTING_KIND_ORDER: readonly ToolKind[] = ['linter', 'formatter', 'typechecker', 'git-hooks', 'other']

const ESLINT_FLAT = 'flat config'
const ESLINT_LEGACY = 'legacy .eslintrc'

export const ESLINT_CONFIGS: readonly ConfigPattern[] = [
  { pattern: `eslint.config.${JS}`, note: ESLINT_FLAT },
  { pattern: '.eslintrc', note: ESLINT_LEGACY },
  { pattern: '.eslintrc.{js,cjs,json,yml,yaml}', note: ESLINT_LEGACY },
]

/** Git hook names Husky runs from .husky/ (its own .husky/_ directory is internal). */
const HUSKY_HOOKS =
  '.husky/{pre-*,post-*,commit-msg,prepare-commit-msg,applypatch-msg,push-to-checkout,reference-transaction,sendemail-validate}'

/** Known linters, formatters, type checkers and git hook managers. */
export const LINT_TOOLS: readonly ToolSpec[] = [
  // Linters
  {
    id: 'eslint',
    name: 'ESLint',
    kind: 'linter',
    dependencies: ['eslint'],
    bins: ['eslint'],
    configs: ESLINT_CONFIGS,
    packageJsonFields: [{ key: 'eslintConfig', note: ESLINT_LEGACY }],
  },
  {
    id: 'biome',
    name: 'Biome',
    kind: 'linter',
    dependencies: ['@biomejs/biome'],
    configs: ['biome.json', 'biome.jsonc'],
  },
  {
    id: 'oxlint',
    name: 'Oxlint',
    kind: 'linter',
    dependencies: ['oxlint'],
    bins: ['oxlint'],
    configs: ['.oxlintrc.json'],
  },
  {
    id: 'stylelint',
    name: 'Stylelint',
    kind: 'linter',
    dependencies: ['stylelint'],
    bins: ['stylelint'],
    configs: ['.stylelintrc', '.stylelintrc.{json,yml,yaml,js,cjs,mjs}', `stylelint.config.${JS}`],
    packageJsonFields: [{ key: 'stylelint' }],
  },
  {
    id: 'markdownlint',
    name: 'markdownlint',
    kind: 'linter',
    dependencies: ['markdownlint-cli', 'markdownlint-cli2'],
    weakDependencies: ['markdownlint'],
    bins: ['markdownlint', 'markdownlint-cli2'],
    configs: ['.markdownlint.{json,jsonc,yaml,yml}', '.markdownlintrc', '.markdownlint-cli2.{jsonc,yaml,cjs,mjs}'],
  },
  {
    id: 'golangci-lint',
    name: 'golangci-lint',
    kind: 'linter',
    dependencies: ['github.com/golangci/golangci-lint/v2', 'github.com/golangci/golangci-lint'],
    configs: ['.golangci.{yml,yaml,toml,json}'],
  },
  {
    id: 'staticcheck',
    name: 'Staticcheck',
    kind: 'linter',
    dependencies: ['honnef.co/go/tools'],
    configs: ['staticcheck.conf'],
  },
  {
    id: 'ruff',
    name: 'Ruff',
    kind: 'linter',
    pythonPackages: ['ruff'],
    pyprojectTables: ['tool.ruff'],
    configs: ['ruff.toml', '.ruff.toml'],
  },
  { id: 'flake8', name: 'Flake8', kind: 'linter', pythonPackages: ['flake8'], configs: ['.flake8'] },
  // Formatters
  {
    id: 'prettier',
    name: 'Prettier',
    kind: 'formatter',
    dependencies: ['prettier'],
    bins: ['prettier'],
    shortConfigFlag: false,
    configs: ['.prettierrc', '.prettierrc.{json,json5,yaml,yml,toml,js,cjs,mjs,ts,cts,mts}', `prettier.config.${JS}`],
    packageJsonFields: [{ key: 'prettier' }],
  },
  {
    id: 'dprint',
    name: 'dprint',
    kind: 'formatter',
    dependencies: ['dprint'],
    bins: ['dprint'],
    configs: ['dprint.json', '.dprint.json', 'dprint.jsonc', '.dprint.jsonc'],
  },
  { id: 'black', name: 'Black', kind: 'formatter', pythonPackages: ['black'], pyprojectTables: ['tool.black'] },
  // Type checkers
  {
    id: 'typescript',
    name: 'TypeScript',
    kind: 'typechecker',
    dependencies: ['typescript'],
    configs: ['tsconfig.json', 'tsconfig.*.json'],
  },
  { id: 'vue-tsc', name: 'vue-tsc', kind: 'typechecker', dependencies: ['vue-tsc'] },
  {
    id: 'mypy',
    name: 'mypy',
    kind: 'typechecker',
    pythonPackages: ['mypy'],
    pyprojectTables: ['tool.mypy'],
    configs: ['mypy.ini', '.mypy.ini'],
  },
  // Git hooks
  {
    id: 'husky',
    name: 'Husky',
    kind: 'git-hooks',
    dependencies: ['husky'],
    configs: [HUSKY_HOOKS],
    packageJsonFields: [{ key: 'husky' }],
  },
  {
    id: 'lefthook',
    name: 'Lefthook',
    kind: 'git-hooks',
    dependencies: ['lefthook', '@evilmartians/lefthook'],
    configs: ['lefthook.{yml,yaml,json,toml}', '.lefthook.{yml,yaml,json,toml}'],
  },
  {
    id: 'lint-staged',
    name: 'lint-staged',
    kind: 'git-hooks',
    dependencies: ['lint-staged'],
    bins: ['lint-staged'],
    configs: ['.lintstagedrc', '.lintstagedrc.{json,yaml,yml,js,cjs,mjs}', `lint-staged.config.${JS}`],
    packageJsonFields: [{ key: 'lint-staged' }],
  },
  {
    id: 'simple-git-hooks',
    name: 'simple-git-hooks',
    kind: 'git-hooks',
    dependencies: ['simple-git-hooks'],
    configs: ['.simple-git-hooks.{json,js,cjs,mjs}', 'simple-git-hooks.{json,js,cjs,mjs}'],
    packageJsonFields: [{ key: 'simple-git-hooks' }],
  },
  {
    id: 'pre-commit',
    name: 'pre-commit',
    kind: 'git-hooks',
    pythonPackages: ['pre-commit'],
    configs: ['.pre-commit-config.{yaml,yml}'],
  },
  // Other
  {
    id: 'commitlint',
    name: 'commitlint',
    kind: 'other',
    dependencies: ['@commitlint/cli'],
    weakDependencies: ['@commitlint/config-conventional'],
    configs: [`commitlint.config.${JS}`, '.commitlintrc', `.commitlintrc.{json,yaml,yml,${JS.slice(1, -1)}}`],
    packageJsonFields: [{ key: 'commitlint' }],
  },
  { id: 'editorconfig', name: 'EditorConfig', kind: 'other', configs: ['.editorconfig'] },
]

export const lintingDetector: Detector<'linting'> = {
  id: 'linting',
  title: 'Linting and formatting',
  async run(ctx) {
    const [facts, python] = await Promise.all([ctx.use(toolFacts), ctx.use(pythonFacts)])
    return { tools: sortTools(detectTools(LINT_TOOLS, { ...facts, python }), LINTING_KIND_ORDER) }
  },
}
