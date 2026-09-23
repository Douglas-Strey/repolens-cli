import { describe, expect, it } from 'vitest'
import {
  CONFIG_FILES,
  classifyConfigFile,
  collectConfigFiles,
  configFilesDetector,
} from '../../src/detectors/config-files.ts'
import { createLayout } from '../../src/detectors/knowledge/layout.ts'
import type { ConfigFile } from '../../src/types.ts'
import { contextFor, fixtureContext, makeProject } from '../helpers.ts'

async function fixtureConfigFiles(name: string): Promise<ConfigFile[]> {
  const ctx = await fixtureContext(name)
  return ctx.use(configFilesDetector)
}

async function projectConfigFiles(files: Record<string, string>): Promise<ConfigFile[]> {
  const ctx = await contextFor(await makeProject(files))
  return ctx.use(configFilesDetector)
}

const paths = (files: ConfigFile[]) => files.map((f) => f.path)

describe('config files on fixtures', () => {
  it('nuxt-app: every known config file, sorted by path', async () => {
    expect(await fixtureConfigFiles('nuxt-app')).toEqual([
      { path: '.env.example', category: 'environment', description: 'Environment variable template' },
      { path: '.gitignore', category: 'git', description: 'Git ignore rules' },
      { path: '.nvmrc', category: 'runtime', description: 'Node.js version (nvm)' },
      { path: 'eslint.config.mjs', category: 'lint', description: 'ESLint flat config' },
      { path: 'nuxt.config.ts', category: 'framework', description: 'Nuxt configuration' },
      { path: 'package.json', category: 'package', description: 'npm package manifest' },
      { path: 'pnpm-lock.yaml', category: 'package', description: 'pnpm lockfile' },
      { path: 'tsconfig.json', category: 'typescript', description: 'TypeScript configuration' },
      { path: 'vitest.config.ts', category: 'test', description: 'Vitest configuration' },
    ])
  })

  it('monorepo: package directories, nested Go module and .github, but not source files', async () => {
    expect(paths(await fixtureConfigFiles('monorepo'))).toEqual([
      '.env.example',
      '.github/workflows/ci.yml',
      '.gitignore',
      '.nvmrc',
      'apps/api/package.json',
      'apps/api/prisma/schema.prisma',
      'apps/api/tsconfig.json',
      'apps/web/nuxt.config.ts',
      'apps/web/package.json',
      'biome.json',
      'docker-compose.yml',
      'package.json',
      'packages/shared/package.json',
      'packages/ui/package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'services/billing/go.mod',
      'services/billing/go.sum',
      'turbo.json',
    ])
  })

  it('categorizes Go, Docker, database and CI files', async () => {
    const byPath = (files: ConfigFile[]) => Object.fromEntries(files.map((f) => [f.path, f.category]))
    expect(byPath(await fixtureConfigFiles('go-api'))).toEqual({
      '.env.example': 'environment',
      '.github/workflows/go.yml': 'ci',
      '.gitignore': 'git',
      '.golangci.yml': 'lint',
      Dockerfile: 'docker',
      Makefile: 'build',
      'go.mod': 'package',
      'go.sum': 'package',
    })
    expect(byPath(await fixtureConfigFiles('fastify-api'))).toMatchObject({
      '.dockerignore': 'docker',
      '.yarnrc.yml': 'runtime',
      'biome.json': 'lint',
      'drizzle.config.ts': 'database',
      'tsconfig.build.json': 'typescript',
      'yarn.lock': 'package',
    })
    expect(byPath(await fixtureConfigFiles('docker-project'))).toMatchObject({
      'compose.yaml': 'docker',
      'docker-compose.override.yml': 'docker',
    })
    expect(byPath(await fixtureConfigFiles('plain-repo'))).toEqual({
      '.editorconfig': 'editor',
      '.github/workflows/test.yml': 'ci',
      '.gitignore': 'git',
      Makefile: 'build',
      'requirements.txt': 'package',
    })
  })

  it('never lists local env files, even when they are not gitignored', async () => {
    // broken-env's .gitignore does not ignore .env, so .env is indexed.
    const files = paths(await fixtureConfigFiles('broken-env'))
    expect(files).toContain('.env.example')
    expect(files).not.toContain('.env')
    const inline = paths(
      await projectConfigFiles({
        '.env': 'A=1',
        '.env.local': 'A=1',
        '.env.production': 'A=1',
        '.env.development.local': 'A=1',
        '.env.sample': 'A=',
        '.env.production.example': 'A=',
        '.envrc': 'dotenv',
      }),
    )
    expect(inline).toEqual(['.env.production.example', '.env.sample'])
  })

  it('survives broken fixtures', async () => {
    expect(paths(await fixtureConfigFiles('broken-config'))).toEqual([
      '.github/workflows/ci.yml',
      'docker-compose.yml',
      'go.mod',
      'package.json',
      'pnpm-workspace.yaml',
      'tsconfig.json',
      'turbo.json',
    ])
    expect(paths(await fixtureConfigFiles('broken-manifest'))).toEqual(['package.json'])
  })
})

describe('config files on inline projects', () => {
  it('covers editor, deploy, git, CI and other categories', async () => {
    const files = await projectConfigFiles({
      'package.json': '{}',
      '.devcontainer/devcontainer.json': '{}',
      '.devcontainer/Dockerfile': 'FROM node:22',
      '.devcontainer/README.md': '# dev container',
      '.vscode/extensions.json': '{}',
      '.vscode/notes.md': '',
      '.github/dependabot.yml': 'version: 2',
      '.github/CODEOWNERS': '* @acme',
      '.github/actions/setup/action.yml': 'name: setup',
      '.github/ISSUE_TEMPLATE/bug.md': '',
      '.changeset/config.json': '{}',
      '.changeset/brave-cats.md': '',
      '.gitlab-ci.yml': 'stages: []',
      'vercel.json': '{}',
      'fly.toml': '',
      Procfile: 'web: node server.js',
      'renovate.json': '{}',
      '.goreleaser.yaml': 'version: 2',
      'mise.toml': '',
      'tailwind.config.ts': '',
      'Dockerfile.dev': 'FROM node:22',
      'Dockerfile-worker': 'FROM node:22',
      'compose.override.yaml': 'services: {}',
    })
    expect(files.map((f) => [f.path, f.category])).toEqual([
      ['.changeset/config.json', 'other'],
      ['.devcontainer/Dockerfile', 'editor'],
      ['.devcontainer/devcontainer.json', 'editor'],
      ['.github/CODEOWNERS', 'git'],
      ['.github/actions/setup/action.yml', 'ci'],
      ['.github/dependabot.yml', 'git'],
      ['.gitlab-ci.yml', 'ci'],
      ['.goreleaser.yaml', 'other'],
      ['.vscode/extensions.json', 'editor'],
      ['Dockerfile-worker', 'docker'],
      ['Dockerfile.dev', 'docker'],
      ['Procfile', 'deploy'],
      ['compose.override.yaml', 'docker'],
      ['fly.toml', 'deploy'],
      ['mise.toml', 'runtime'],
      ['package.json', 'package'],
      ['renovate.json', 'git'],
      ['tailwind.config.ts', 'framework'],
      ['vercel.json', 'deploy'],
    ])
  })

  it('does not look deep outside package directories', async () => {
    const files = paths(
      await projectConfigFiles({
        'package.json': JSON.stringify({ workspaces: ['packages/*'] }),
        'packages/a/package.json': '{}',
        'packages/a/vite.config.ts': '',
        'packages/a/src/vite.config.ts': '',
        'examples/demo/package.json': '{}',
        'examples/demo/next.config.js': '',
        'scripts/tsconfig.json': '{}',
      }),
    )
    expect(files).toEqual(['package.json', 'packages/a/package.json', 'packages/a/vite.config.ts'])
  })

  it('root-only entries are not reported in package directories', async () => {
    const files = paths(
      await projectConfigFiles({
        'package.json': JSON.stringify({ workspaces: ['apps/*'] }),
        'apps/web/package.json': '{}',
        'apps/web/.gitlab-ci.yml': '',
        'apps/web/.vscode/settings.json': '{}',
        'apps/web/.gitignore': 'dist',
        '.vscode/settings.json': '{}',
      }),
    )
    expect(files).toEqual(['.vscode/settings.json', 'apps/web/.gitignore', 'apps/web/package.json', 'package.json'])
  })

  it('packages whose directory is also a root subdirectory entry (docs/, prisma/) keep their files', async () => {
    // docs/CODEOWNERS and prisma/schema.prisma are root-level entries, so the
    // root also reaches docs/ and prisma/; the package reading must win.
    const files = await projectConfigFiles({
      'package.json': JSON.stringify({ workspaces: ['docs', 'prisma'] }),
      'docs/package.json': '{}',
      'docs/tsconfig.json': '{}',
      'docs/CODEOWNERS': '* @acme',
      'docs/.vitepress/config.ts': 'export default {}',
      'prisma/package.json': '{}',
      'prisma/schema.prisma': '',
    })
    expect(files.map((f) => [f.path, f.category])).toEqual([
      ['docs/.vitepress/config.ts', 'framework'],
      ['docs/CODEOWNERS', 'git'],
      ['docs/package.json', 'package'],
      ['docs/tsconfig.json', 'typescript'],
      ['package.json', 'package'],
      ['prisma/package.json', 'package'],
      ['prisma/schema.prisma', 'database'],
    ])
  })

  it('finds VitePress config in docs/ of a single-package repository', async () => {
    const files = await projectConfigFiles({ 'package.json': '{}', 'docs/.vitepress/config.mts': '' })
    expect(files.map((f) => [f.path, f.description])).toEqual([
      ['docs/.vitepress/config.mts', 'VitePress configuration'],
      ['package.json', 'npm package manifest'],
    ])
  })

  it('does not list gitignored files', async () => {
    const files = paths(
      await projectConfigFiles({
        '.gitignore': '.vscode/\nfly.toml\n',
        '.vscode/settings.json': '{}',
        'fly.toml': '',
      }),
    )
    expect(files).toEqual(['.gitignore'])
  })
})

describe('classification', () => {
  it('first matching entry wins and rootOnly is honored', () => {
    expect(classifyConfigFile({ package: '.', rel: 'tsconfig.app.json' })?.category).toBe('typescript')
    expect(classifyConfigFile({ package: '.', rel: 'requirements-dev.txt' })?.category).toBe('package')
    expect(classifyConfigFile({ package: '.', rel: 'Jenkinsfile' })?.category).toBe('ci')
    expect(classifyConfigFile({ package: 'apps/x', rel: 'Jenkinsfile' })).toBeUndefined()
    expect(classifyConfigFile({ package: '.', rel: 'src/index.ts' })).toBeUndefined()
  })

  it('no table entry matches a local env file', () => {
    for (const rel of [
      '.env',
      '.env.local',
      '.env.production',
      '.env.test.local',
      '.envrc',
      'env',
      '.env.development',
    ]) {
      expect(classifyConfigFile({ package: '.', rel }), rel).toBeUndefined()
    }
  })

  it('is a pure function of the layout and deterministic', () => {
    const layout = createLayout(['b/package.json', 'package.json', 'a/package.json', 'a/tsconfig.json'], ['b', 'a'])
    const first = collectConfigFiles(layout)
    expect(paths(first)).toEqual(['a/package.json', 'a/tsconfig.json', 'b/package.json', 'package.json'])
    expect(collectConfigFiles(layout)).toEqual(first)
  })

  it('every entry has a description', () => {
    for (const spec of CONFIG_FILES) expect(spec.description.length, spec.pattern).toBeGreaterThan(0)
  })
})
