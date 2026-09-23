import { describe, expect, it } from 'vitest'
import {
  compareRoutes,
  finalizeRoutes,
  isNonAppSource,
  isTestFileName,
  joinRoutePath,
  MAX_ROUTES,
  makeRoute,
  normalizePath,
  parseRoutePath,
  toHttpMethod,
} from '../../../src/detectors/routes/shared.ts'
import type { Route } from '../../../src/types.ts'

function route(overrides: Partial<Route>): Route {
  return {
    method: 'GET',
    path: '/',
    kind: 'api',
    framework: 'express',
    file: 'src/app.js',
    confidence: 'high',
    package: '.',
    ...overrides,
  }
}

describe('normalizePath', () => {
  it.each([
    ['', '/'],
    ['/', '/'],
    ['users', '/users'],
    ['/users/', '/users'],
    ['//api//users///', '/api/users'],
    ['/users/:id', '/users/:id'],
    ['/users/{id}', '/users/:id'],
    ['/users/{id:[0-9]+}', '/users/:id'],
    ['/files/{path...}', '/files/*path'],
    ['/exact/{$}', '/exact'],
    ['/users/[id]', '/users/:id'],
    ['/blog/[...slug]', '/blog/*slug'],
    ['/docs/[[...slug]]', '/docs/*slug'],
    ['/shop/[[category]]', '/shop/:category'],
    ['/posts/[id]-[slug]', '/posts/:id-:slug'],
    ['/users/:id(\\d+)', '/users/:id'],
    ['/users/:id{[0-9]+}', '/users/:id'],
    ['/users/:id?', '/users/:id'],
    ['/flights/:from-:to', '/flights/:from-:to'],
    ['/static/*filepath', '/static/*filepath'],
    ['/*', '/*'],
    ['/users{/:id}', '/users/:id'],
  ])('%s → %s', (input, expected) => {
    expect(normalizePath(input)).toBe(expected)
  })

  it('reports optional syntax as notes', () => {
    expect(parseRoutePath('/docs/[[...slug]]').notes).toEqual(['optional catch-all'])
    expect(parseRoutePath('/shop/[[category]]').notes).toEqual(['optional parameter'])
    expect(parseRoutePath('/users/:id?').notes).toEqual(['optional parameter'])
    expect(parseRoutePath('/users{/:id}').notes).toEqual(['optional segment'])
    expect(parseRoutePath('/users/:id').notes).toEqual([])
  })

  it('does not choke on unbalanced brackets', () => {
    expect(normalizePath('/a/{b')).toBe('/a/{b')
    expect(normalizePath('/a/[b')).toBe('/a/[b')
    expect(normalizePath('/a/:id(x')).toBe('/a/:id(x')
  })
})

describe('joinRoutePath', () => {
  it('joins prefixes and paths so normalization can collapse slashes', () => {
    expect(normalizePath(joinRoutePath('/api/items', '/'))).toBe('/api/items')
    expect(normalizePath(joinRoutePath('', '/x'))).toBe('/x')
    expect(normalizePath(joinRoutePath('api', 'users', ':id'))).toBe('/api/users/:id')
  })
})

describe('toHttpMethod', () => {
  it('maps method spellings', () => {
    expect(toHttpMethod('get')).toBe('GET')
    expect(toHttpMethod('Delete')).toBe('DELETE')
    expect(toHttpMethod('all')).toBe('ANY')
    expect(toHttpMethod('Any')).toBe('ANY')
    expect(toHttpMethod('PROPFIND')).toBeNull()
    expect(toHttpMethod('use')).toBeNull()
  })
})

describe('makeRoute', () => {
  const base = {
    method: 'GET' as const,
    kind: 'api' as const,
    framework: 'express',
    file: 'a.js',
    confidence: 'high' as const,
    package: '.',
  }

  it('normalizes the path and merges notes', () => {
    expect(makeRoute({ ...base, path: '/docs/[[...slug]]', note: 'mounted by a router; prefix may apply' })).toEqual({
      ...base,
      path: '/docs/*slug',
      note: 'optional catch-all; mounted by a router; prefix may apply',
    })
  })

  it('keeps a stable key order and omits empty optional fields', () => {
    const built = makeRoute({ ...base, path: '/x', line: 3 })
    expect(Object.keys(built ?? {})).toEqual([
      'method',
      'path',
      'kind',
      'framework',
      'file',
      'line',
      'confidence',
      'package',
    ])
  })

  it('strips terminal control characters from committed text', () => {
    const built = makeRoute({ ...base, path: '/evil\u001b[31m/\u202eroute' })
    expect(built?.path).toBe('/evil[31m/route')
  })

  it('strips C1 controls, zero-width and line separator characters', () => {
    const built = makeRoute({ ...base, path: '/a\u0085b/\u200bc\u200f/d\u2028e\ufeff' })
    expect(built?.path).toBe('/ab/c/de')
  })

  it('strips Unicode tag characters, bidi isolates and whitespace other than spaces', () => {
    const built = makeRoute({
      ...base,
      path: '/a\udb40\udc41b/\u2066c\u2069/d\u00a0e\tf g',
      note: 'first\nsecond\u202e',
    })
    expect(built?.path).toBe('/ab/c/def g')
    expect(built?.note).toBe('first second')
  })

  it('redacts credentials that appear in a path', () => {
    const token = `ghp_${'a'.repeat(36)}`
    const built = makeRoute({ ...base, path: `/hooks/${token}` })
    expect(built?.path).not.toContain(token)
    expect(built?.path).toBe('/hooks/***')
  })

  it('rejects absurdly long paths', () => {
    expect(makeRoute({ ...base, path: `/${'a'.repeat(600)}` })).toBeNull()
  })
})

describe('finalizeRoutes', () => {
  it('sorts by package, kind, path, method order and file', () => {
    const routes = [
      route({ package: 'b', path: '/a', file: 'b/app.js' }),
      route({ kind: 'page', path: '/a' }),
      route({ path: '/b', method: 'ANY' }),
      route({ path: '/b', method: 'DELETE' }),
      route({ path: '/b', method: 'GET', file: 'z.js' }),
      route({ path: '/b', method: 'GET', file: 'a.js' }),
      route({ path: '/a', method: 'POST' }),
    ]
    const { routes: sorted } = finalizeRoutes(routes, false)
    expect(sorted.map((r) => `${r.package} ${r.kind} ${r.method} ${r.path} ${r.file}`)).toEqual([
      '. api POST /a src/app.js',
      '. api GET /b a.js',
      '. api GET /b z.js',
      '. api DELETE /b src/app.js',
      '. api ANY /b src/app.js',
      '. page GET /a src/app.js',
      'b api GET /a b/app.js',
    ])
  })

  it('dedupes variants of one registration and keeps the most confident one', () => {
    const { routes } = finalizeRoutes(
      [
        route({ line: 3, confidence: 'medium' }),
        route({ line: 3, confidence: 'high' }),
        route({ line: 3, confidence: 'low' }),
        route({ framework: 'hono', line: 3 }),
      ],
      false,
    )
    expect(routes.map((r) => `${r.framework} ${r.confidence}`)).toEqual(['express high', 'hono high'])
  })

  it('merges resolved registrations of a route but keeps unresolved ones from other lines', () => {
    const { routes } = finalizeRoutes(
      [
        route({ line: 9, confidence: 'high' }),
        route({ line: 4, confidence: 'high' }),
        // Unresolved: probably different functions mounted under different prefixes.
        route({ line: 20, confidence: 'medium' }),
        route({ line: 30, confidence: 'medium' }),
      ],
      false,
    )
    expect(routes.map((r) => `${r.line} ${r.confidence}`)).toEqual(['4 high', '20 medium', '30 medium'])
  })

  it('caps the list and sets truncated', () => {
    const many = Array.from({ length: MAX_ROUTES + 5 }, (_, i) => route({ path: `/r${String(i).padStart(5, '0')}` }))
    const result = finalizeRoutes(many, false)
    expect(result.routes).toHaveLength(MAX_ROUTES)
    expect(result.truncated).toBe(true)
    expect(result.routes[0]?.path).toBe('/r00000')
  })

  it('keeps an upstream truncated flag', () => {
    expect(finalizeRoutes([], true).truncated).toBe(true)
  })

  it('is independent of input order', () => {
    const routes = [route({ path: '/b' }), route({ path: '/a', method: 'POST' }), route({ path: '/a' })]
    expect(finalizeRoutes(routes, false)).toEqual(finalizeRoutes([...routes].reverse(), false))
    expect(compareRoutes(route({}), route({}))).toBe(0)
  })
})

describe('test file detection', () => {
  it('recognizes test and story files by name', () => {
    expect(isTestFileName('src/app.test.ts')).toBe(true)
    expect(isTestFileName('src/app.spec.js')).toBe(true)
    expect(isTestFileName('test/app.e2e-spec.ts')).toBe(true)
    expect(isTestFileName('cmd/api/main_test.go')).toBe(true)
    expect(isTestFileName('src/__tests__/app.ts')).toBe(true)
    expect(isTestFileName('server/api/tests/[id].get.ts')).toBe(false)
    // A file-system route named like a test is still a route.
    expect(isTestFileName('pages/speed-test.tsx')).toBe(false)
  })

  it('skips test and example directories relative to the package', () => {
    expect(isNonAppSource('test/helpers.js', '.')).toBe(true)
    expect(isNonAppSource('apps/api/tests/setup.ts', 'apps/api')).toBe(true)
    expect(isNonAppSource('examples/basic/server.js', '.')).toBe(true)
    expect(isNonAppSource('examples/api/src/server.js', 'examples/api')).toBe(false)
    expect(isNonAppSource('src/routes/users.ts', '.')).toBe(false)
  })

  it('uses the shared path roles (fixtures, demos, templates, playgrounds, benchmarks)', () => {
    for (const file of [
      'src/__fixtures__/server.ts',
      'demo/server.js',
      'templates/express/app.js',
      'playground/app.ts',
      'benchmarks/express.js',
      'cypress/support/server.ts',
      'src/Server.story.tsx',
    ]) {
      expect(isNonAppSource(file, '.'), file).toBe(true)
    }
    expect(isNonAppSource('src/load-test.js', '.')).toBe(true)
    expect(isNonAppSource('docs/server.js', '.')).toBe(false)
  })
})
