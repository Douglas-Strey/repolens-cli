import { describe, expect, it } from 'vitest'
import {
  comparePackageDependencies,
  countUnique,
  dependenciesDetector,
  dependencyKind,
  redactRange,
  toEntries,
} from '../../src/detectors/dependencies.ts'
import type { DependenciesSection, PackageDependencies } from '../../src/types.ts'
import { contextFor, fixtureContext, makeProject, timeBudget } from '../helpers.ts'

async function detectFiles(files: Record<string, string>): Promise<DependenciesSection> {
  const ctx = await contextFor(await makeProject(files))
  return ctx.use(dependenciesDetector)
}

describe('dependencyKind', () => {
  it('maps manifest fields and Go indirect requirements', () => {
    expect(dependencyKind({ type: 'dependencies' })).toBe('prod')
    expect(dependencyKind({ type: 'devDependencies' })).toBe('dev')
    expect(dependencyKind({ type: 'peerDependencies' })).toBe('peer')
    expect(dependencyKind({ type: 'optionalDependencies' })).toBe('optional')
    expect(dependencyKind({ type: 'go', indirect: false })).toBe('prod')
    expect(dependencyKind({ type: 'go', indirect: true })).toBe('indirect')
  })
})

describe('redactRange', () => {
  it('leaves ordinary ranges alone', () => {
    expect(redactRange('^4.1.2')).toBe('^4.1.2')
    expect(redactRange('workspace:*')).toBe('workspace:*')
    expect(redactRange('npm:@scope/pkg@^1.0.0')).toBe('npm:@scope/pkg@^1.0.0')
    expect(redactRange('github:user/repo#v1.2.3')).toBe('github:user/repo#v1.2.3')
  })

  it('removes credentials embedded in URLs but keeps the commit-ish', () => {
    expect(redactRange('git+https://user:ghs_token123@github.com/acme/private.git#v2')).toBe(
      'git+https://***@github.com/acme/private.git#v2',
    )
    expect(redactRange('https://registry.example.com/pkg.tgz?token=abc123&x=1')).toBe(
      'https://registry.example.com/pkg.tgz',
    )
  })

  it('keeps the readable part of a long signed URL', () => {
    const signature = 'X-Amz-Signature='.padEnd(2000, 'f')
    expect(redactRange(`https://bucket.s3.amazonaws.com/pkg-1.0.0.tgz?X-Amz-Credential=AKIA&${signature}`)).toBe(
      'https://bucket.s3.amazonaws.com/pkg-1.0.0.tgz',
    )
  })

  it('clips garbage ranges and stays fast on hostile input', () => {
    const started = performance.now()
    expect(redactRange('a.'.repeat(250_000))).toBe('…')
    expect(redactRange('://'.repeat(250_000))).toBe('…')
    expect(performance.now() - started).toBeLessThan(timeBudget(1000))
  })
})

describe('toEntries', () => {
  it('sorts by kind, then name', () => {
    const entries = toEntries([
      { name: 'zod', range: '^4', type: 'dependencies', package: '.', file: 'package.json', ecosystem: 'node' },
      { name: 'vue', range: '^3', type: 'peerDependencies', package: '.', file: 'package.json', ecosystem: 'node' },
      { name: 'axios', range: '^1', type: 'dependencies', package: '.', file: 'package.json', ecosystem: 'node' },
      { name: 'vite', range: '^7', type: 'devDependencies', package: '.', file: 'package.json', ecosystem: 'node' },
      {
        name: 'fsevents',
        range: '^2',
        type: 'optionalDependencies',
        package: '.',
        file: 'package.json',
        ecosystem: 'node',
      },
    ])
    expect(entries.map((e) => `${e.kind}:${e.name}`)).toEqual([
      'prod:axios',
      'prod:zod',
      'dev:vite',
      'peer:vue',
      'optional:fsevents',
    ])
  })
})

describe('comparePackageDependencies and countUnique', () => {
  const pkg = (path: string, ecosystem: 'node' | 'go', names: string[] = []): PackageDependencies => ({
    path,
    name: path,
    ecosystem,
    dependencies: names.map((name) => ({ name, version: '1', kind: name.startsWith('~') ? 'indirect' : 'prod' })),
  })

  it('puts the root first, then sorts by path with node before go', () => {
    const sorted = [pkg('b', 'node'), pkg('a', 'go'), pkg('.', 'go'), pkg('a', 'node'), pkg('.', 'node')].sort(
      comparePackageDependencies,
    )
    expect(sorted.map((p) => `${p.path}:${p.ecosystem}`)).toEqual(['.:node', '.:go', 'a:node', 'a:go', 'b:node'])
  })

  it('counts unique names without indirect requirements', () => {
    expect(countUnique([pkg('.', 'node', ['a', 'b']), pkg('x', 'node', ['b', 'c', '~d'])])).toBe(3)
  })
})

describe('dependenciesDetector on fixtures', () => {
  it('monorepo: one entry per package, root first, catalogs resolved, Go module last', async () => {
    const ctx = await fixtureContext('monorepo')
    const section = await ctx.use(dependenciesDetector)
    expect(section.packages.map((p) => [p.path, p.name, p.ecosystem])).toEqual([
      ['.', 'acme', 'node'],
      ['apps/api', '@acme/api', 'node'],
      ['apps/web', '@acme/web', 'node'],
      ['packages/shared', '@acme/shared', 'node'],
      ['packages/ui', '@acme/ui', 'node'],
      ['services/billing', 'github.com/acme/billing', 'go'],
    ])
    expect(section.packages[0]?.dependencies).toEqual([
      { name: '@biomejs/biome', version: '^2.2.4', kind: 'dev' },
      { name: 'turbo', version: '^2.5.8', kind: 'dev' },
      { name: 'typescript', version: '^5.9.2', kind: 'dev' },
    ])
    expect(section.packages[1]?.dependencies.map((d) => `${d.kind}:${d.name}`)).toEqual([
      'prod:@acme/shared',
      'prod:@prisma/client',
      'prod:fastify',
      'dev:prisma',
      'dev:tsx',
      'dev:typescript',
      'dev:vitest',
    ])
    expect(section.packages[4]?.dependencies).toEqual([
      { name: 'vue', version: '^3.5.22', kind: 'dev' },
      { name: 'vue', version: '^3.5.22', kind: 'peer' },
    ])
    expect(section.packages[5]?.dependencies).toEqual([
      { name: 'github.com/google/uuid', version: 'v1.6.0', kind: 'prod' },
    ])
    expect(section.total).toBe(13)
  })

  it('go-api: indirect requirements are listed but not counted', async () => {
    const ctx = await fixtureContext('go-api')
    const section = await ctx.use(dependenciesDetector)
    expect(section.packages).toHaveLength(1)
    const deps = section.packages[0]?.dependencies ?? []
    expect(deps.slice(0, 3)).toEqual([
      { name: 'github.com/gin-gonic/gin', version: 'v1.11.0', kind: 'prod' },
      { name: 'github.com/jackc/pgx/v5', version: 'v5.7.6', kind: 'prod' },
      { name: 'github.com/redis/go-redis/v9', version: 'v9.14.0', kind: 'prod' },
    ])
    expect(deps.slice(3).every((d) => d.kind === 'indirect')).toBe(true)
    expect(deps).toHaveLength(10)
    expect(section.total).toBe(3)
  })

  it('plain-repo and broken-manifest: empty without crashing', async () => {
    for (const fixture of ['plain-repo', 'broken-manifest']) {
      const ctx = await fixtureContext(fixture)
      expect(await ctx.use(dependenciesDetector)).toEqual({ packages: [], total: 0 })
    }
  })
})

describe('dependenciesDetector on inline projects', () => {
  it('skips packages without dependencies and falls back to the path for unnamed packages', async () => {
    const section = await detectFiles({
      'package.json': '{"name":"root"}',
      'web/package.json': '{"dependencies":{"react":"^19.0.0"}}',
      'empty/package.json': '{"name":"empty"}',
    })
    expect(section.packages).toEqual([
      {
        path: 'web',
        name: 'web',
        ecosystem: 'node',
        dependencies: [{ name: 'react', version: '^19.0.0', kind: 'prod' }],
      },
    ])
    expect(section.total).toBe(1)
  })

  it('lists node and Go dependencies of the same directory separately', async () => {
    const section = await detectFiles({
      'package.json': '{"name":"hybrid","devDependencies":{"prettier":"^3"}}',
      'go.mod': 'module example.com/hybrid\n\nrequire github.com/spf13/cobra v1.10.1\n',
    })
    expect(section.packages.map((p) => [p.path, p.name, p.ecosystem])).toEqual([
      ['.', 'hybrid', 'node'],
      ['.', 'example.com/hybrid', 'go'],
    ])
    expect(section.total).toBe(2)
  })

  it('lists Deno import map packages, merged into a package.json in the same directory', async () => {
    const denoOnly = await detectFiles({
      'deno.json': JSON.stringify({
        name: '@acme/api',
        imports: { '@hono/hono': 'jsr:@hono/hono@^4', pg: 'npm:pg@^8' },
      }),
    })
    expect(denoOnly.packages).toEqual([
      {
        path: '.',
        name: '@acme/api',
        ecosystem: 'node',
        dependencies: [
          { name: '@hono/hono', version: '^4', kind: 'prod' },
          { name: 'pg', version: '^8', kind: 'prod' },
        ],
      },
    ])
    const both = await detectFiles({
      'package.json': JSON.stringify({ name: 'hybrid', devDependencies: { vitest: '^3.0.0' } }),
      'deno.json': JSON.stringify({ imports: { zod: 'npm:zod@^3' } }),
    })
    expect(both.packages.map((p) => [p.path, p.name, p.dependencies.map((d) => d.name)])).toEqual([
      ['.', 'hybrid', ['zod', 'vitest']],
    ])
  })

  it('never outputs credentials embedded in dependency ranges', async () => {
    const section = await detectFiles({
      'package.json': JSON.stringify({
        dependencies: {
          private: `git+https://deploy:glpat-${'A'.repeat(24)}@gitlab.example.com/acme/private.git`,
          tarball: 'https://cdn.example.com/pkg.tgz?access_token=REPOLENS_FIXTURE_SECRET',
        },
      }),
    })
    const json = JSON.stringify(section)
    expect(json).not.toContain('glpat-')
    expect(json).not.toContain('deploy:')
    expect(json).not.toContain('REPOLENS_FIXTURE_SECRET')
    expect(section.packages[0]?.dependencies.map((d) => d.version)).toEqual([
      'git+https://***@gitlab.example.com/acme/private.git',
      'https://cdn.example.com/pkg.tgz',
    ])
  })
})
