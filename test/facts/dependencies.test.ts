import { describe, expect, it } from 'vitest'
import { createDependencyIndex, type DependencyRef, dependencies } from '../../src/facts/dependencies.ts'
import { contextFor, fixtureContext, makeProject } from '../helpers.ts'

function ref(name: string, range: string, pkg = '.', extra: Partial<DependencyRef> = {}): DependencyRef {
  return {
    name,
    range,
    type: 'dependencies',
    package: pkg,
    file: pkg === '.' ? 'package.json' : `${pkg}/package.json`,
    ecosystem: 'node',
    ...extra,
  }
}

describe('createDependencyIndex', () => {
  const index = createDependencyIndex([
    ref('react', 'workspace:*'),
    ref('react', '^18.3.1', 'apps/web'),
    ref('@nestjs/core', '^11.0.0', 'apps/api'),
    ref('@nestjs/common', '^11.0.0', 'apps/api', { type: 'devDependencies' }),
    ref('react', '^18.2.0', 'apps/admin'),
    ref('github.com/gin-gonic/gin', 'v1.11.0', 'svc', { type: 'go', ecosystem: 'go', indirect: false }),
  ])

  it('has() checks anywhere or in one package', () => {
    expect(index.has('react')).toBe(true)
    expect(index.has('react', 'apps/web')).toBe(true)
    expect(index.has('react', 'apps/api')).toBe(false)
    expect(index.has('vue')).toBe(false)
    expect(index.has('constructor')).toBe(false)
    expect(index.has('__proto__')).toBe(false)
  })

  it('get() returns declarations in input order, as a copy', () => {
    expect(index.get('react').map((r) => r.package)).toEqual(['.', 'apps/web', 'apps/admin'])
    index.get('react').pop()
    expect(index.get('react')).toHaveLength(3)
    expect(index.get('missing')).toEqual([])
  })

  it('withPrefix() and inPackage()', () => {
    expect(index.withPrefix('@nestjs/').map((r) => r.name)).toEqual(['@nestjs/core', '@nestjs/common'])
    expect(index.inPackage('apps/api').map((r) => r.name)).toEqual(['@nestjs/core', '@nestjs/common'])
    expect(index.inPackage('nope')).toEqual([])
  })

  it('version() returns the first cleanable range', () => {
    expect(index.version('react')).toBe('18.3.1')
    expect(index.version('github.com/gin-gonic/gin')).toBe('1.11.0')
    expect(index.version('missing')).toBeUndefined()
  })

  it('packagesWith() is sorted and unique', () => {
    expect(index.packagesWith('react')).toEqual(['.', 'apps/admin', 'apps/web'])
    expect(index.packagesWith('missing')).toEqual([])
  })
})

describe('dependencies analyzer', () => {
  it('indexes every manifest of the monorepo fixture with catalogs resolved', async () => {
    const deps = await (await fixtureContext('monorepo')).use(dependencies)
    expect(deps.has('nuxt', 'apps/web')).toBe(true)
    expect(deps.packagesWith('typescript')).toEqual(['.', 'apps/api', 'packages/shared'])
    expect(deps.get('typescript')[0]).toMatchObject({ package: '.', range: '^5.9.2', type: 'devDependencies' })
    expect(deps.version('vue')).toBe('3.5.22')
    expect(deps.get('vue').map((r) => [r.package, r.type])).toEqual([
      ['apps/web', 'dependencies'],
      ['packages/ui', 'devDependencies'],
      ['packages/ui', 'peerDependencies'],
    ])
    expect(deps.inPackage('services/billing')).toEqual([
      {
        name: 'github.com/google/uuid',
        range: 'v1.6.0',
        type: 'go',
        package: 'services/billing',
        file: 'services/billing/go.mod',
        ecosystem: 'go',
        indirect: false,
      },
    ])
  })

  it('marks Go indirect requirements', async () => {
    const deps = await (await fixtureContext('go-api')).use(dependencies)
    expect(deps.get('github.com/gin-gonic/gin')[0]?.indirect).toBe(false)
    expect(deps.get('github.com/bytedance/sonic')[0]?.indirect).toBe(true)
  })

  it('covers all four package.json dependency fields', async () => {
    const ctx = await contextFor(
      await makeProject({
        'package.json': JSON.stringify({
          dependencies: { a: '1' },
          devDependencies: { b: '2' },
          peerDependencies: { c: '3' },
          optionalDependencies: { d: '4' },
        }),
      }),
    )
    const deps = await ctx.use(dependencies)
    expect(deps.all.map((r) => [r.name, r.type])).toEqual([
      ['a', 'dependencies'],
      ['b', 'devDependencies'],
      ['c', 'peerDependencies'],
      ['d', 'optionalDependencies'],
    ])
  })

  it('indexes Deno imports as runtime dependencies of the config directory', async () => {
    const ctx = await contextFor(
      await makeProject({ 'deno.json': JSON.stringify({ imports: { '@hono/hono': 'jsr:@hono/hono@^4.6.0' } }) }),
    )
    const deps = await ctx.use(dependencies)
    expect(deps.all).toEqual([
      {
        name: '@hono/hono',
        range: '^4.6.0',
        type: 'dependencies',
        package: '.',
        file: 'deno.json',
        ecosystem: 'node',
      },
    ])
    expect(deps.version('@hono/hono')).toBe('4.6.0')
  })

  it('is empty for a malformed manifest', async () => {
    const deps = await (await fixtureContext('broken-manifest')).use(dependencies)
    expect(deps.all).toEqual([])
  })
})
