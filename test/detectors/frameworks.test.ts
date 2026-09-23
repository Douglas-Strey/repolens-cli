import { describe, expect, it } from 'vitest'
import {
  CATEGORY_ORDER,
  FRAMEWORKS,
  frameworkDependencyConfidence,
  frameworksDetector,
  modulesWithoutRouter,
  servesNetHttp,
  sortFrameworks,
  startsNetHttpServer,
  versionSummary,
} from '../../src/detectors/frameworks.ts'
import { createDependencyIndex, type DependencyRef } from '../../src/facts/dependencies.ts'
import type { Framework } from '../../src/types.ts'
import { contextFor, fixtureContext, makeProject, SECRET_SENTINEL, timeBudget } from '../helpers.ts'

async function fixtureFrameworks(name: string): Promise<Framework[]> {
  const ctx = await fixtureContext(name)
  return ctx.use(frameworksDetector)
}

async function projectFrameworks(files: Record<string, string>): Promise<Framework[]> {
  const ctx = await contextFor(await makeProject(files))
  return ctx.use(frameworksDetector)
}

const pkg = (fields: Record<string, unknown>) => JSON.stringify({ name: 'demo', ...fields })

describe('frameworks detector on fixtures', () => {
  it('nuxt-app: Nuxt and Vue with high confidence', async () => {
    const found = await fixtureFrameworks('nuxt-app')
    expect(found.map((f) => f.id)).toEqual(['nuxt', 'vue'])
    expect(found[0]).toEqual({
      id: 'nuxt',
      name: 'Nuxt',
      version: '4.1.2',
      category: 'fullstack',
      ecosystem: 'node',
      packages: ['.'],
      confidence: 'high',
      evidence: ['dependency nuxt@^4.1.2 in package.json', 'config file nuxt.config.ts'],
    })
    expect(found[1]).toMatchObject({ id: 'vue', version: '3.5.22', category: 'frontend', confidence: 'high' })
  })

  it('next-app: Next.js and React', async () => {
    const found = await fixtureFrameworks('next-app')
    expect(found.map((f) => [f.id, f.version, f.confidence])).toEqual([
      ['next', '16.0.1', 'high'],
      ['react', '19.2.0', 'high'],
    ])
    expect(found[0]?.evidence).toContain('config file next.config.ts')
  })

  it('backend fixtures', async () => {
    expect((await fixtureFrameworks('fastify-api')).map((f) => [f.id, f.version, f.category])).toEqual([
      ['fastify', '5.6.1', 'backend'],
    ])
    expect((await fixtureFrameworks('express-api')).map((f) => [f.id, f.version])).toEqual([['express', '5.1.0']])
    expect((await fixtureFrameworks('bun-app')).map((f) => [f.id, f.version])).toEqual([['hono', '4.10.2']])
    const nest = await fixtureFrameworks('nest-api')
    expect(nest).toEqual([
      {
        id: 'nestjs',
        name: 'NestJS',
        version: '11.1.6',
        category: 'backend',
        ecosystem: 'node',
        packages: ['.'],
        confidence: 'high',
        evidence: ['dependency @nestjs/core@^11.1.6 in package.json', 'config file nest-cli.json'],
      },
    ])
  })

  it('go-api: Gin, and no plain net/http because the module uses a router', async () => {
    expect(await fixtureFrameworks('go-api')).toEqual([
      {
        id: 'gin',
        name: 'Gin',
        version: '1.11.0',
        category: 'backend',
        ecosystem: 'go',
        packages: ['.'],
        confidence: 'high',
        evidence: ['dependency github.com/gin-gonic/gin@v1.11.0 in go.mod'],
      },
    ])
  })

  it('monorepo: per-package attribution, catalog versions and net/http in the Go service', async () => {
    expect(await fixtureFrameworks('monorepo')).toEqual([
      {
        id: 'nuxt',
        name: 'Nuxt',
        version: '4.1.2',
        category: 'fullstack',
        ecosystem: 'node',
        packages: ['apps/web'],
        confidence: 'high',
        evidence: ['dependency nuxt@^4.1.2 in apps/web/package.json', 'config file apps/web/nuxt.config.ts'],
      },
      {
        id: 'vue',
        name: 'Vue',
        version: '3.5.22',
        category: 'frontend',
        ecosystem: 'node',
        packages: ['apps/web', 'packages/ui'],
        confidence: 'high',
        evidence: [
          'dependency vue@^3.5.22 in apps/web/package.json',
          'devDependency vue@^3.5.22 in packages/ui/package.json',
          'peerDependency vue@^3.5.22 in packages/ui/package.json',
        ],
      },
      {
        id: 'fastify',
        name: 'Fastify',
        version: '5.6.1',
        category: 'backend',
        ecosystem: 'node',
        packages: ['apps/api'],
        confidence: 'high',
        evidence: ['dependency fastify@^5.6.1 in apps/api/package.json'],
      },
      {
        id: 'go-net-http',
        name: 'net/http',
        category: 'backend',
        ecosystem: 'go',
        packages: ['services/billing'],
        confidence: 'medium',
        evidence: ['net/http handlers in services/billing/main.go'],
      },
    ])
  })

  it('does not crash on broken configuration and reports nothing it cannot see', async () => {
    expect(await fixtureFrameworks('broken-config')).toEqual([])
    expect(await fixtureFrameworks('broken-manifest')).toEqual([])
    expect(await fixtureFrameworks('plain-repo')).toEqual([])
  })

  it('is deterministic', async () => {
    const a = await fixtureFrameworks('monorepo')
    const b = await fixtureFrameworks('monorepo')
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})

describe('confidence levels', () => {
  it('devDependency only → medium', async () => {
    const found = await projectFrameworks({ 'package.json': pkg({ devDependencies: { react: '^19.2.0' } }) })
    expect(found).toEqual([
      {
        id: 'react',
        name: 'React',
        version: '19.2.0',
        category: 'frontend',
        ecosystem: 'node',
        packages: ['.'],
        confidence: 'medium',
        evidence: ['devDependency react@^19.2.0 in package.json'],
      },
    ])
  })

  it('peerDependency only → low; optionalDependency → medium', async () => {
    const peer = await projectFrameworks({ 'package.json': pkg({ peerDependencies: { vue: '^3.0.0' } }) })
    expect(peer.map((f) => [f.id, f.confidence])).toEqual([['vue', 'low']])
    const optional = await projectFrameworks({ 'package.json': pkg({ optionalDependencies: { express: '^5.0.0' } }) })
    expect(optional.map((f) => [f.id, f.confidence])).toEqual([['express', 'medium']])
  })

  it('config file without dependency → medium; with any dependency → high', async () => {
    const configOnly = await projectFrameworks({ 'package.json': pkg({}), 'nuxt.config.ts': 'export default {}' })
    expect(configOnly).toEqual([
      {
        id: 'nuxt',
        name: 'Nuxt',
        category: 'fullstack',
        ecosystem: 'node',
        packages: ['.'],
        confidence: 'medium',
        evidence: ['config file nuxt.config.ts'],
      },
    ])
    const devAndConfig = await projectFrameworks({
      'package.json': pkg({ devDependencies: { astro: '^5.0.0' } }),
      'astro.config.mjs': 'export default {}',
    })
    expect(devAndConfig.map((f) => [f.id, f.confidence, f.category])).toEqual([['astro', 'high', 'static-site']])
  })

  it('svelte.config.js alone is only a low-confidence SvelteKit hint', async () => {
    const found = await projectFrameworks({
      'package.json': pkg({ dependencies: { svelte: '^5.0.0' } }),
      'svelte.config.js': 'export default {}',
    })
    expect(found.map((f) => [f.id, f.confidence])).toEqual([
      ['sveltekit', 'low'],
      ['svelte', 'high'],
    ])
  })

  it('Go: direct requirement → high, indirect only → low', async () => {
    const found = await projectFrameworks({
      'go.mod': [
        'module example.com/svc',
        '',
        'go 1.25',
        '',
        'require github.com/labstack/echo/v4 v4.13.4',
        'require google.golang.org/grpc v1.75.0 // indirect',
      ].join('\n'),
    })
    expect(found.map((f) => [f.id, f.version, f.confidence, f.ecosystem])).toEqual([
      ['echo', '4.13.4', 'high', 'go'],
      ['grpc', '1.75.0', 'low', 'go'],
    ])
  })

  it('VitePress config in docs/, its default source directory', async () => {
    const found = await projectFrameworks({
      'package.json': pkg({ devDependencies: { vitepress: '^1.6.4' } }),
      'docs/.vitepress/config.mts': 'export default {}',
    })
    expect(found).toEqual([
      {
        id: 'vitepress',
        name: 'VitePress',
        version: '1.6.4',
        category: 'static-site',
        ecosystem: 'node',
        packages: ['.'],
        confidence: 'high',
        evidence: ['config file docs/.vitepress/config.mts', 'devDependency vitepress@^1.6.4 in package.json'],
      },
    ])
  })

  it('ignores npm packages that share a Go module name and vice versa', async () => {
    const found = await projectFrameworks({
      'package.json': pkg({ dependencies: { 'github.com/gin-gonic/gin': '1.0.0' } }),
    })
    expect(found).toEqual([])
  })

  it('merges one framework across workspace packages', async () => {
    const found = await projectFrameworks({
      'package.json': pkg({ private: true, workspaces: ['packages/*'] }),
      'packages/b/package.json': JSON.stringify({ name: 'b', devDependencies: { react: '^18.3.1' } }),
      'packages/a/package.json': JSON.stringify({ name: 'a', peerDependencies: { react: '>=18' } }),
      'packages/c/package.json': JSON.stringify({ name: 'c', dependencies: { react: '^19.2.0' } }),
    })
    expect(found).toEqual([
      {
        id: 'react',
        name: 'React',
        version: '19.2.0',
        category: 'frontend',
        ecosystem: 'node',
        packages: ['packages/a', 'packages/b', 'packages/c'],
        confidence: 'high',
        evidence: [
          'dependency react@^19.2.0 in packages/c/package.json',
          'devDependency react@^18.3.1 in packages/b/package.json',
          'peerDependency react@>=18 in packages/a/package.json',
        ],
      },
    ])
  })

  it('summarizes the version when packages use different majors', async () => {
    const found = await projectFrameworks({
      'package.json': pkg({ private: true, workspaces: ['apps/*'] }),
      'apps/a/package.json': JSON.stringify({ name: 'a', dependencies: { react: '^19.1.0' } }),
      'apps/b/package.json': JSON.stringify({ name: 'b', dependencies: { react: '^18.3.1' } }),
      'apps/c/package.json': JSON.stringify({ name: 'c', dependencies: { react: '^19.0.0' } }),
    })
    expect(found[0]).toMatchObject({ id: 'react', version: '18.3.1\u201319.1.0', confidence: 'high' })
    expect(found[0]?.evidence).toEqual([
      'dependency react@^19.1.0 in apps/a/package.json',
      'dependency react@^18.3.1 in apps/b/package.json',
      'dependency react@^19.0.0 in apps/c/package.json',
    ])
  })

  it('versionSummary only looks at the strongest signals and plain versions', () => {
    const signal = (version: string, confidence: 'high' | 'medium' | 'low' = 'high') => ({
      package: version,
      confidence,
      evidence: version,
      version,
    })
    expect(versionSummary([signal('19.1.0'), signal('19.2.0')])).toBeUndefined()
    expect(versionSummary([signal('19.1.0'), signal('18.3.1', 'medium')])).toBeUndefined()
    expect(versionSummary([signal('10.0.0'), signal('9.5.0'), signal('10.1.0')])).toBe('9.5.0\u201310.1.0')
    expect(versionSummary([signal('19.1.0'), signal('>=18 <20')])).toBeUndefined()
    expect(versionSummary([signal('19.1.0')])).toBeUndefined()
  })

  it('detects Hono imported from JSR in a Deno project', async () => {
    const found = await projectFrameworks({
      'deno.json': JSON.stringify({
        imports: { '@hono/hono': 'jsr:@hono/hono@^4.6.0' },
        tasks: { dev: 'deno run -A main.ts' },
      }),
    })
    expect(found).toEqual([
      {
        id: 'hono',
        name: 'Hono',
        version: '4.6.0',
        category: 'backend',
        ecosystem: 'node',
        packages: ['.'],
        confidence: 'high',
        evidence: ['dependency @hono/hono@^4.6.0 in deno.json'],
      },
    ])
  })

  it('frameworkDependencyConfidence covers every declaration type', () => {
    const base = { name: 'x', range: '1', package: '.', file: 'package.json', ecosystem: 'node' } as const
    expect(frameworkDependencyConfidence({ ...base, type: 'dependencies' })).toBe('high')
    expect(frameworkDependencyConfidence({ ...base, type: 'devDependencies' })).toBe('medium')
    expect(frameworkDependencyConfidence({ ...base, type: 'optionalDependencies' })).toBe('medium')
    expect(frameworkDependencyConfidence({ ...base, type: 'peerDependencies' })).toBe('low')
    expect(frameworkDependencyConfidence({ ...base, type: 'go', ecosystem: 'go' })).toBe('high')
    expect(frameworkDependencyConfidence({ ...base, type: 'go', ecosystem: 'go', indirect: true })).toBe('low')
  })
})

describe('Go net/http', () => {
  const server = `package main

import (
\t"log"
\tnethttp "net/http"
)

func main() {
\tnethttp.HandleFunc("/", func(w nethttp.ResponseWriter, r *nethttp.Request) {})
\tlog.Fatal(nethttp.ListenAndServe(":8080", nil))
}
`

  it('startsNetHttpServer needs the import and a ListenAndServe call', () => {
    const imports = 'package main\n\nimport "net/http"\n\n'
    expect(startsNetHttpServer(`${imports}func main() { http.ListenAndServe(":8080", nil) }\n`)).toBe(true)
    expect(startsNetHttpServer(`${imports}func main() { srv.ListenAndServeTLS("a", "b") }\n`)).toBe(true)
    expect(startsNetHttpServer(`${imports}func R(m *http.ServeMux) { m.HandleFunc("/", nil) }\n`)).toBe(false)
    expect(startsNetHttpServer('package main\n\nfunc main() { ListenAndServe() }\n')).toBe(false)
  })

  it('servesNetHttp needs both the import and a handler or server call', () => {
    expect(servesNetHttp(server)).toBe(true)
    expect(servesNetHttp('package x\n\nimport "net/http"\n\nfunc f() { mux.Handle("/x", h) }\n')).toBe(true)
    expect(servesNetHttp('package x\n\nimport "net/http"\n\nfunc f() { http.Get("https://example.com") }\n')).toBe(
      false,
    )
    expect(servesNetHttp('package x\n\nimport "fmt"\n\nfunc f() { HandleFunc("/") }\n')).toBe(false)
    expect(servesNetHttp('')).toBe(false)
  })

  it('servesNetHttp handles CRLF files and aliased or grouped imports', () => {
    expect(servesNetHttp(server.replaceAll('\n', '\r\n'))).toBe(true)
    expect(servesNetHttp('import (\n  "fmt"\n  _ "net/http" // side effects\n)\nhttp.ListenAndServe(":80", nil)')).toBe(
      true,
    )
    expect(servesNetHttp('// see "net/http"\nhttp.ListenAndServe(":80", nil)')).toBe(false)
  })

  it('servesNetHttp stays linear on hostile input (no catastrophic backtracking)', () => {
    const size = 512 * 1024
    const start = performance.now()
    for (const input of [
      '\n'.repeat(size),
      ' \n'.repeat(size / 2),
      '\t\r\n'.repeat(size / 3),
      `import${' '.repeat(size)}x`,
    ]) {
      expect(servesNetHttp(input)).toBe(false)
    }
    // The old import pattern needed minutes for 512 KB of blank lines.
    expect(performance.now() - start).toBeLessThan(timeBudget(1000))
  })

  it('reports plain net/http as medium confidence and ignores _test.go files', async () => {
    const found = await projectFrameworks({
      'go.mod': 'module example.com/svc\n\ngo 1.25\n',
      'internal/server/server.go': server,
    })
    expect(found).toEqual([
      {
        id: 'go-net-http',
        name: 'net/http',
        category: 'backend',
        ecosystem: 'go',
        packages: ['.'],
        confidence: 'medium',
        evidence: ['net/http handlers in internal/server/server.go'],
      },
    ])
    const onlyTests = await projectFrameworks({
      'go.mod': 'module example.com/svc\n\ngo 1.25\n',
      'server_test.go': server,
    })
    expect(onlyTests).toEqual([])
  })

  it('skips modules that require a router, but not ones that only have it indirectly', async () => {
    const withChi = await projectFrameworks({
      'go.mod': 'module example.com/svc\n\ngo 1.25\n\nrequire github.com/go-chi/chi/v5 v5.2.3\n',
      'main.go': server,
    })
    expect(withChi.map((f) => f.id)).toEqual(['chi'])

    const deps = createDependencyIndex([
      { name: 'github.com/gin-gonic/gin', range: 'v1', type: 'go', package: 'a', file: 'a/go.mod', ecosystem: 'go' },
      {
        name: 'github.com/gin-gonic/gin',
        range: 'v1',
        type: 'go',
        package: 'b',
        file: 'b/go.mod',
        ecosystem: 'go',
        indirect: true,
      },
    ] satisfies DependencyRef[])
    expect(modulesWithoutRouter(['a', 'b', 'c'], deps)).toEqual(['b', 'c'])
  })

  it('attributes Go files to their Go module even under a Node package directory', async () => {
    const found = await projectFrameworks({
      'go.mod': 'module example.com/svc\n\ngo 1.25\n',
      'package.json': pkg({ private: true, workspaces: ['web'] }),
      'web/package.json': JSON.stringify({ name: 'web' }),
      'web/server/main.go': server,
    })
    expect(found.map((f) => [f.id, f.packages, f.evidence])).toEqual([
      ['go-net-http', ['.'], ['net/http handlers in web/server/main.go']],
    ])
  })

  it('a nested module with a router does not count for the module around it', async () => {
    const found = await projectFrameworks({
      'go.mod': 'module example.com/root\n\ngo 1.25\n',
      'services/api/go.mod': 'module example.com/api\n\ngo 1.25\n\nrequire github.com/gin-gonic/gin v1.11.0\n',
      'services/api/main.go': server,
    })
    expect(found.map((f) => [f.id, f.packages])).toEqual([['gin', ['services/api']]])
  })

  it('picks the first matching file in path order', async () => {
    const found = await projectFrameworks({
      'go.mod': 'module example.com/svc\n\ngo 1.25\n',
      ...Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`pkg/f${String(i).padStart(2, '0')}.go`, server])),
    })
    expect(found[0]?.evidence).toEqual(['net/http handlers in pkg/f00.go'])
  })
})

describe('ordering and table', () => {
  it('sorts by category, then table order', () => {
    const make = (id: string, category: Framework['category']): Framework => ({
      id,
      name: id,
      category,
      ecosystem: 'node',
      packages: ['.'],
      confidence: 'high',
      evidence: [],
    })
    const sorted = sortFrameworks([
      make('electron', 'desktop'),
      make('go-net-http', 'backend'),
      make('express', 'backend'),
      make('react', 'frontend'),
      make('expo', 'mobile'),
      make('astro', 'static-site'),
      make('next', 'fullstack'),
      make('vue', 'frontend'),
      make('fastify', 'backend'),
    ])
    expect(sorted.map((f) => f.id)).toEqual([
      'next',
      'react',
      'vue',
      'express',
      'fastify',
      'go-net-http',
      'astro',
      'expo',
      'electron',
    ])
  })

  it('has unique ids and known categories', () => {
    const ids = FRAMEWORKS.map((spec) => spec.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const spec of FRAMEWORKS) expect(CATEGORY_ORDER).toContain(spec.category)
  })
})

describe('security', () => {
  it('never echoes credentials from dependency specifiers', async () => {
    const found = await projectFrameworks({
      'package.json': pkg({
        dependencies: {
          react: `git+https://deploy:${SECRET_SENTINEL}@github.com/acme/react.git`,
          vue: `https://registry.example.com/vue-3.5.0.tgz?token=${SECRET_SENTINEL}`,
        },
      }),
    })
    expect(found.map((f) => f.id)).toEqual(['react', 'vue'])
    expect(found.every((f) => f.version === undefined)).toBe(true)
    expect(found.map((f) => f.evidence)).toEqual([
      ['dependency react in package.json'],
      ['dependency vue in package.json'],
    ])
    expect(JSON.stringify(found)).not.toContain(SECRET_SENTINEL)
  })
})
