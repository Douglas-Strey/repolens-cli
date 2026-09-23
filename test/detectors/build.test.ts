import { describe, expect, it } from 'vitest'
import {
  BUILD_KIND_ORDER,
  BUILD_TOOLS,
  buildDetector,
  isConfigPackageName,
  runsTscBuild,
} from '../../src/detectors/build.ts'
import { parseInvocations } from '../../src/detectors/knowledge/commands.ts'
import type { Tool } from '../../src/types.ts'
import { contextFor, fixtureContext, makeProject, SECRET_SENTINEL } from '../helpers.ts'

async function fixtureBuild(name: string): Promise<Tool[]> {
  const ctx = await fixtureContext(name)
  return (await ctx.use(buildDetector)).tools
}

async function projectBuild(files: Record<string, string>): Promise<Tool[]> {
  const ctx = await contextFor(await makeProject(files))
  return (await ctx.use(buildDetector)).tools
}

const pkg = (fields: Record<string, unknown>) => JSON.stringify({ name: 'demo', ...fields })

function tscBuild(command: string, scriptName = 'build'): boolean {
  const script = parseInvocations(command)
  return script.some((invocation) => runsTscBuild(invocation, scriptName, script))
}

describe('build detector on fixtures', () => {
  it('fastify-api: a build script running tsc', async () => {
    expect(await fixtureBuild('fastify-api')).toEqual([
      {
        id: 'tsc',
        name: 'tsc',
        kind: 'compiler',
        version: '5.9.2',
        configFiles: [],
        packages: ['.'],
        confidence: 'high',
        evidence: ['"build" script runs tsc in package.json'],
      },
    ])
  })

  it('monorepo: Turborepo and tsc builds; no Vite just because Nuxt bundles with it', async () => {
    expect(await fixtureBuild('monorepo')).toEqual([
      {
        id: 'turbo',
        name: 'Turborepo',
        kind: 'task-runner',
        version: '2.5.8',
        configFiles: ['turbo.json'],
        packages: ['.'],
        confidence: 'high',
        evidence: ['devDependency turbo@^2.5.8 in package.json', 'config file turbo.json'],
      },
      {
        id: 'tsc',
        name: 'tsc',
        kind: 'compiler',
        version: '5.9.2',
        configFiles: [],
        packages: ['apps/api', 'packages/shared'],
        confidence: 'high',
        evidence: [
          '"build" script runs tsc in apps/api/package.json',
          '"build" script runs tsc in packages/shared/package.json',
        ],
      },
    ])
  })

  it('nuxt-app and next-app report no bundler they do not declare', async () => {
    expect(await fixtureBuild('nuxt-app')).toEqual([])
    expect(await fixtureBuild('next-app')).toEqual([])
  })

  it('broken-env: Vite from dependency and config file', async () => {
    expect(await fixtureBuild('broken-env')).toEqual([
      {
        id: 'vite',
        name: 'Vite',
        kind: 'bundler',
        version: '7.1.7',
        configFiles: ['vite.config.ts'],
        packages: ['.'],
        confidence: 'high',
        evidence: ['devDependency vite@^7.1.7 in package.json', 'config file vite.config.ts'],
      },
    ])
  })

  it('go-api and plain-repo: Make', async () => {
    for (const fixture of ['go-api', 'plain-repo']) {
      expect(await fixtureBuild(fixture)).toEqual([
        {
          id: 'make',
          name: 'Make',
          kind: 'task-runner',
          configFiles: ['Makefile'],
          packages: ['.'],
          confidence: 'high',
          evidence: ['config file Makefile'],
        },
      ])
    }
  })

  it('broken-config: a malformed turbo.json still counts, nothing crashes', async () => {
    const tools = await fixtureBuild('broken-config')
    expect(tools.map((t) => [t.id, t.confidence])).toEqual([
      ['turbo', 'high'],
      ['tsc', 'high'],
    ])
    expect(tools[0]?.version).toBeUndefined()
    expect(await fixtureBuild('broken-manifest')).toEqual([])
  })
})

describe('runsTscBuild', () => {
  it('accepts tsc used as a build step', () => {
    expect(tscBuild('tsc')).toBe(true)
    expect(tscBuild('tsc -p tsconfig.build.json')).toBe(true)
    expect(tscBuild('rimraf dist && tsc -p tsconfig.build.json')).toBe(true)
    expect(tscBuild('npx tsc', 'compile')).toBe(true)
    expect(tscBuild('tsc --outDir dist', 'emit-types')).toBe(true)
    expect(tscBuild('tsc --declaration --emitDeclarationOnly', 'types')).toBe(true)
    expect(tscBuild('tsc -b', 'dev')).toBe(true)
  })

  it('rejects type checks and other programs', () => {
    expect(tscBuild('tsc --noEmit')).toBe(false)
    expect(tscBuild('tsc', 'typecheck')).toBe(false)
    expect(tscBuild('tsc -p .', 'type-check')).toBe(false)
    expect(tscBuild('tsc --outDir dist', 'lint')).toBe(false)
    expect(tscBuild('tsc -w', 'dev')).toBe(false)
    expect(tscBuild('vue-tsc -b && vite build')).toBe(false)
    expect(tscBuild('tsc --version')).toBe(false)
    expect(tscBuild('echo tsc')).toBe(false)
  })

  it('treats tsc next to a bundler as a type check unless it writes output', () => {
    // The Vite templates: tsconfig sets noEmit and Vite produces dist/.
    expect(tscBuild('tsc -b && vite build')).toBe(false)
    expect(tscBuild('tsc && vite build')).toBe(false)
    expect(tscBuild('tsc -p tsconfig.app.json && next build')).toBe(false)
    expect(tscBuild('tsc && bun build ./src/index.ts --outdir dist')).toBe(false)
    expect(tscBuild('vite build && tsc --emitDeclarationOnly')).toBe(true)
    expect(tscBuild('tsup && tsc --declaration --declarationDir dist/types')).toBe(true)
    // Without a script context the invocation alone decides.
    expect(runsTscBuild({ bin: 'tsc', args: ['-b'] }, 'build')).toBe(true)
  })
})

describe('build detector on inline projects', () => {
  it('reports tsc builds with the TypeScript version, but not type checks', async () => {
    const tools = await projectBuild({
      'package.json': pkg({ scripts: { typecheck: 'tsc --noEmit' }, devDependencies: { typescript: '~5.8.3' } }),
    })
    expect(tools).toEqual([])
    const built = await projectBuild({
      'package.json': pkg({ scripts: { prepack: 'tsc -p .' }, devDependencies: { typescript: '~5.8.3' } }),
    })
    expect(built.map((t) => [t.id, t.version, t.evidence])).toEqual([
      ['tsc', '5.8.3', ['"prepack" script runs tsc in package.json']],
    ])
  })

  it('a Vite app built with "tsc -b && vite build" reports Vite, not tsc', async () => {
    const tools = await projectBuild({
      'package.json': pkg({
        scripts: { build: 'tsc -b && vite build' },
        devDependencies: { vite: '^7.1.7', typescript: '~5.9.3' },
      }),
      'vite.config.ts': 'export default {}',
    })
    expect(tools.map((t) => t.id)).toEqual(['vite'])
  })

  it('weak config names need the dependency for more than low confidence', async () => {
    const alone = await projectBuild({ 'package.json': pkg({}), 'build.config.ts': 'export default {}' })
    expect(alone.map((t) => [t.id, t.confidence])).toEqual([['unbuild', 'low']])
    const withDep = await projectBuild({
      'package.json': pkg({ devDependencies: { unbuild: '^3.6.1' } }),
      'build.config.ts': 'export default {}',
    })
    expect(withDep.map((t) => [t.id, t.confidence, t.configFiles])).toEqual([['unbuild', 'high', ['build.config.ts']]])
  })

  it('detects config-only tools, package.json fields and script --config arguments', async () => {
    const tools = await projectBuild({
      'package.json': pkg({
        scripts: { build: 'webpack --config config/webpack.prod.js', release: 'goreleaser release' },
        babel: { presets: ['@babel/preset-env'] },
        devDependencies: { webpack: '^5.101.0', 'webpack-cli': '^6.0.1' },
      }),
      'config/webpack.prod.js': 'module.exports = {}',
      '.goreleaser.yaml': 'version: 2\n',
      justfile: 'build:\n  go build ./...\n',
      'Taskfile.yml': 'version: "3"\n',
      'nx.json': '{}',
    })
    expect(tools.map((t) => t.id)).toEqual(['just', 'nx', 'task', 'webpack', 'babel', 'goreleaser'])
    const webpack = tools.find((t) => t.id === 'webpack')
    expect(webpack?.configFiles).toEqual(['config/webpack.prod.js'])
    expect(webpack?.evidence).toContain('config file config/webpack.prod.js (used by the "build" script)')
    expect(tools.find((t) => t.id === 'babel')?.evidence).toEqual(['"babel" field in package.json'])
  })

  it('ignores config files outside the root and package directories', async () => {
    const tools = await projectBuild({
      'package.json': pkg({}),
      'examples/demo/vite.config.ts': 'export default {}',
      'docs/Makefile': 'all:\n',
    })
    expect(tools).toEqual([])
  })

  it('lowers compilers declared only by a shared lint or TypeScript config package to low confidence', async () => {
    const tools = await projectBuild({
      'package.json': pkg({ private: true, workspaces: ['apps/*', 'tooling/*'] }),
      'apps/web/package.json': JSON.stringify({ name: '@acme/web', devDependencies: { vite: '^7.0.0' } }),
      'tooling/eslint/package.json': JSON.stringify({
        name: '@acme/eslint-config',
        dependencies: { '@babel/core': '^7.26.0', 'eslint-plugin-react': '^7.37.0' },
      }),
    })
    const babel = tools.find((tool) => tool.id === 'babel')
    expect(babel).toMatchObject({
      confidence: 'low',
      evidence: ['dependency @babel/core@^7.26.0 in tooling/eslint/package.json (a shared config package)'],
    })
    expect(tools.find((tool) => tool.id === 'vite')?.confidence).toBe('high')
  })

  it('keeps full confidence when a config package is not the only place', async () => {
    const tools = await projectBuild({
      'package.json': pkg({ private: true, workspaces: ['packages/*'], devDependencies: { '@babel/core': '^7.26.0' } }),
      'packages/eslint-config/package.json': JSON.stringify({
        name: 'eslint-config-acme',
        dependencies: { '@babel/core': '^7.26.0' },
      }),
    })
    expect(tools.find((tool) => tool.id === 'babel')?.confidence).toBe('high')
  })

  it('isConfigPackageName recognizes shared config package names', () => {
    for (const name of [
      '@acme/eslint-config',
      'eslint-config-acme',
      '@repo/typescript-config',
      '@acme/tsconfig',
      '@acme/prettier-config',
      'acme-prettier-config',
      'eslint-plugin-acme',
    ]) {
      expect(isConfigPackageName(name), name).toBe(true)
    }
    for (const name of ['@acme/web', 'config', '@acme/config', 'babel-plugin-x', 'typescript', 'eslint']) {
      expect(isConfigPackageName(name), name).toBe(false)
    }
  })

  it('does not echo secrets from scripts or dependency specifiers', async () => {
    const tools = await projectBuild({
      'package.json': pkg({
        scripts: { build: `NPM_TOKEN=${SECRET_SENTINEL} tsc -p .` },
        devDependencies: { vite: `https://x:${SECRET_SENTINEL}@example.com/vite.tgz` },
      }),
    })
    expect(tools.map((t) => t.id)).toEqual(['vite', 'tsc'])
    expect(JSON.stringify(tools)).not.toContain(SECRET_SENTINEL)
  })
})

describe('table', () => {
  it('has unique ids and every kind is ordered', () => {
    const ids = BUILD_TOOLS.map((tool) => tool.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const tool of BUILD_TOOLS) expect(BUILD_KIND_ORDER).toContain(tool.kind)
  })
})
