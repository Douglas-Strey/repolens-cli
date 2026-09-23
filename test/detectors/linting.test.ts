import { describe, expect, it } from 'vitest'
import { LINT_TOOLS, LINTING_KIND_ORDER, lintingDetector } from '../../src/detectors/linting.ts'
import type { Tool } from '../../src/types.ts'
import { contextFor, fixtureContext, makeProject, SECRET_SENTINEL } from '../helpers.ts'

async function fixtureLinting(name: string): Promise<Tool[]> {
  const ctx = await fixtureContext(name)
  return (await ctx.use(lintingDetector)).tools
}

async function projectLinting(files: Record<string, string>): Promise<Tool[]> {
  const ctx = await contextFor(await makeProject(files))
  return (await ctx.use(lintingDetector)).tools
}

const pkg = (fields: Record<string, unknown>) => JSON.stringify({ name: 'demo', ...fields })

describe('linting detector on fixtures', () => {
  it('nuxt-app: ESLint flat config and TypeScript', async () => {
    expect(await fixtureLinting('nuxt-app')).toEqual([
      {
        id: 'eslint',
        name: 'ESLint',
        kind: 'linter',
        version: '9.36.0',
        configFiles: ['eslint.config.mjs'],
        packages: ['.'],
        confidence: 'high',
        evidence: ['devDependency eslint@^9.36.0 in package.json', 'config file eslint.config.mjs (flat config)'],
      },
      {
        id: 'typescript',
        name: 'TypeScript',
        kind: 'typechecker',
        version: '5.9.2',
        configFiles: ['tsconfig.json'],
        packages: ['.'],
        confidence: 'high',
        evidence: ['devDependency typescript@^5.9.2 in package.json', 'config file tsconfig.json'],
      },
    ])
  })

  it('next-app and nest-api: ESLint flat config', async () => {
    for (const fixture of ['next-app', 'nest-api']) {
      const tools = await fixtureLinting(fixture)
      expect(tools.map((t) => t.id)).toEqual(['eslint', 'typescript'])
      expect(tools[0]?.evidence).toContain('config file eslint.config.mjs (flat config)')
    }
  })

  it('mixed-lockfiles and legacy-config: legacy .eslintrc is called out', async () => {
    const mixed = await fixtureLinting('mixed-lockfiles')
    expect(mixed).toEqual([
      {
        id: 'eslint',
        name: 'ESLint',
        kind: 'linter',
        version: '9.36.0',
        configFiles: ['.eslintrc.json'],
        packages: ['.'],
        confidence: 'high',
        evidence: ['devDependency eslint@^9.36.0 in package.json', 'config file .eslintrc.json (legacy .eslintrc)'],
      },
    ])
    const legacy = await fixtureLinting('legacy-config')
    expect(legacy.find((t) => t.id === 'eslint')?.evidence).toContain('config file .eslintrc.cjs (legacy .eslintrc)')
    expect(legacy.find((t) => t.id === 'typescript')?.packages).toEqual(['packages/core', 'packages/utils'])
  })

  it('fastify-api: Biome and TypeScript with every tsconfig', async () => {
    const tools = await fixtureLinting('fastify-api')
    expect(tools.map((t) => [t.id, t.version, t.configFiles])).toEqual([
      ['biome', '2.2.4', ['biome.json']],
      ['typescript', '5.9.2', ['tsconfig.build.json', 'tsconfig.json']],
    ])
  })

  it('monorepo: root Biome and TypeScript across packages with the catalog version', async () => {
    const tools = await fixtureLinting('monorepo')
    expect(tools.map((t) => [t.id, t.version, t.packages, t.configFiles])).toEqual([
      ['biome', '2.2.4', ['.'], ['biome.json']],
      ['typescript', '5.9.2', ['.', 'apps/api', 'packages/shared'], ['apps/api/tsconfig.json']],
    ])
  })

  it('go-api: golangci-lint from its config file', async () => {
    expect(await fixtureLinting('go-api')).toEqual([
      {
        id: 'golangci-lint',
        name: 'golangci-lint',
        kind: 'linter',
        configFiles: ['.golangci.yml'],
        packages: ['.'],
        confidence: 'high',
        evidence: ['config file .golangci.yml'],
      },
    ])
  })

  it('plain-repo: Ruff from requirements and EditorConfig', async () => {
    expect(await fixtureLinting('plain-repo')).toEqual([
      {
        id: 'ruff',
        name: 'Ruff',
        kind: 'linter',
        version: '0.13.1',
        configFiles: [],
        packages: ['.'],
        confidence: 'high',
        evidence: ['dependency ruff==0.13.1 in requirements.txt'],
      },
      {
        id: 'editorconfig',
        name: 'EditorConfig',
        kind: 'other',
        configFiles: ['.editorconfig'],
        packages: ['.'],
        confidence: 'high',
        evidence: ['config file .editorconfig'],
      },
    ])
  })

  it('broken-config: tsconfig.json is found even though it does not parse', async () => {
    const tools = await fixtureLinting('broken-config')
    expect(tools.map((t) => [t.id, t.configFiles])).toEqual([['typescript', ['tsconfig.json']]])
    expect(await fixtureLinting('broken-manifest')).toEqual([])
  })
})

describe('linting detector on inline projects', () => {
  it('orders by kind, then name, and reads package.json fields', async () => {
    const tools = await projectLinting({
      'package.json': pkg({
        prettier: '@acme/prettier-config',
        eslintConfig: { extends: 'eslint:recommended' },
        'lint-staged': { '*.ts': 'eslint --fix' },
        devDependencies: {
          '@commitlint/cli': '^19.8.1',
          husky: '^9.1.7',
          'vue-tsc': '^3.1.0',
          stylelint: '^16.24.0',
        },
      }),
      '.husky/pre-commit': 'npx lint-staged\n',
      '.husky/commit-msg': 'npx commitlint --edit "$1"\n',
      '.husky/_/husky.sh': '# internal\n',
      '.husky/.gitignore': '_\n',
      'commitlint.config.js': 'export default {}',
      '.editorconfig': 'root = true\n',
      '.pre-commit-config.yaml': 'repos: []\n',
      'lefthook.yml': 'pre-commit:\n',
    })
    expect(tools.map((t) => [t.id, t.kind])).toEqual([
      ['eslint', 'linter'],
      ['stylelint', 'linter'],
      ['prettier', 'formatter'],
      ['vue-tsc', 'typechecker'],
      ['husky', 'git-hooks'],
      ['lefthook', 'git-hooks'],
      ['lint-staged', 'git-hooks'],
      ['pre-commit', 'git-hooks'],
      ['commitlint', 'other'],
      ['editorconfig', 'other'],
    ])
    const byId = new Map(tools.map((t) => [t.id, t]))
    expect(byId.get('eslint')?.evidence).toEqual(['"eslintConfig" field in package.json (legacy .eslintrc)'])
    expect(byId.get('prettier')?.configFiles).toEqual(['package.json'])
    expect(byId.get('husky')?.configFiles).toEqual(['.husky/commit-msg', '.husky/pre-commit'])
    expect(byId.get('commitlint')).toMatchObject({ version: '19.8.1', configFiles: ['commitlint.config.js'] })
  })

  it('a config file alone is enough; with the dependency it adds the version', async () => {
    const configOnly = await projectLinting({ '.prettierrc.json': '{}', 'dprint.json': '{}' })
    expect(configOnly.map((t) => [t.id, t.version, t.confidence])).toEqual([
      ['dprint', undefined, 'high'],
      ['prettier', undefined, 'high'],
    ])
  })

  it('Python tools from pyproject.toml tables', async () => {
    const tools = await projectLinting({
      'pyproject.toml':
        '[project]\nname = "demo"\n\n[tool.ruff.lint]\nselect = ["E"]\n\n[tool.black]\n\n[tool.mypy]\nstrict = true\n',
      '.flake8': '[flake8]\n',
    })
    expect(tools.map((t) => [t.id, t.configFiles])).toEqual([
      ['flake8', ['.flake8']],
      ['ruff', ['pyproject.toml']],
      ['black', ['pyproject.toml']],
      ['mypy', ['pyproject.toml']],
    ])
    expect(tools.find((t) => t.id === 'ruff')?.evidence).toEqual(['[tool.ruff] in pyproject.toml'])
  })

  it('config files in workspace packages are attributed to them', async () => {
    const tools = await projectLinting({
      'package.json': pkg({ private: true, workspaces: ['apps/*'] }),
      'apps/web/package.json': JSON.stringify({ name: 'web', devDependencies: { oxlint: '^1.19.0' } }),
      'apps/web/.oxlintrc.json': '{}',
      'apps/web/src/.eslintrc.json': '{}',
    })
    expect(tools).toEqual([
      {
        id: 'oxlint',
        name: 'Oxlint',
        kind: 'linter',
        version: '1.19.0',
        configFiles: ['apps/web/.oxlintrc.json'],
        packages: ['apps/web'],
        confidence: 'high',
        evidence: ['devDependency oxlint@^1.19.0 in apps/web/package.json', 'config file apps/web/.oxlintrc.json'],
      },
    ])
  })

  it('prettier -c is --check, not a config file argument', async () => {
    const tools = await projectLinting({
      'package.json': pkg({
        scripts: { 'format:check': 'prettier -c README.md', format: 'prettier --config config/prettier.json -w .' },
        devDependencies: { prettier: '^3.6.2' },
      }),
      'README.md': '# demo',
      'config/prettier.json': '{}',
    })
    expect(tools.map((t) => [t.id, t.configFiles])).toEqual([['prettier', ['config/prettier.json']]])
  })

  it('peer-only tools are low confidence', async () => {
    const tools = await projectLinting({ 'package.json': pkg({ peerDependencies: { eslint: '>=9' } }) })
    expect(tools.map((t) => [t.id, t.confidence])).toEqual([['eslint', 'low']])
  })

  it('does not echo secrets from dependency specifiers', async () => {
    const tools = await projectLinting({
      'package.json': pkg({
        devDependencies: { eslint: `git+https://ci:${SECRET_SENTINEL}@git.example.com/eslint.git` },
      }),
    })
    expect(tools.map((t) => [t.id, t.version])).toEqual([['eslint', undefined]])
    expect(JSON.stringify(tools)).not.toContain(SECRET_SENTINEL)
  })
})

describe('table', () => {
  it('has unique ids and every kind is ordered', () => {
    const ids = LINT_TOOLS.map((tool) => tool.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const tool of LINT_TOOLS) expect(LINTING_KIND_ORDER).toContain(tool.kind)
  })
})
