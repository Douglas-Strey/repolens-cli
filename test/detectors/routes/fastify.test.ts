import { describe, expect, it } from 'vitest'
import { find, fixtureRoutes, routesOf, summary } from './helpers.ts'

const FASTIFY = JSON.stringify({ type: 'module', dependencies: { fastify: '^5.6.1' } })

describe('Fastify routes', () => {
  it('extracts the fastify-api fixture with the /users plugin prefix resolved', async () => {
    const { routes } = await fixtureRoutes('fastify-api')
    expect(routes.map((r) => `${r.method} ${r.path} ${r.file}:${r.line} ${r.confidence}`)).toEqual([
      'GET /health src/server.ts:11 high',
      'POST /orders src/routes/orders.ts:9 high',
      'GET /orders/:id src/routes/orders.ts:19 high',
      'HEAD /orders/:id src/routes/orders.ts:19 high',
      'GET /users src/routes/users.ts:7 high',
      'POST /users src/routes/users.ts:11 high',
      'GET /users/:id src/routes/users.ts:16 high',
      'DELETE /users/:id src/routes/users.ts:22 high',
    ])
    expect(routes.every((r) => r.framework === 'fastify')).toBe(true)
  })

  it('extracts the Fastify app of the monorepo fixture', async () => {
    const { routes } = await fixtureRoutes('monorepo')
    expect(routes.filter((r) => r.framework === 'fastify').map((r) => `${r.package} ${r.method} ${r.path}`)).toEqual([
      'apps/api POST /api/auth/login',
      'apps/api POST /api/orders',
      'apps/api GET /api/users',
    ])
  })

  it('applies prefixes of inline and same-file plugins, including nested ones', async () => {
    const { routes } = await routesOf({
      'package.json': FASTIFY,
      'src/app.ts': [
        "import Fastify, { type FastifyInstance } from 'fastify'",
        'const app = Fastify()',
        'async function adminRoutes(instance: FastifyInstance) {',
        "  instance.get('/stats', h)",
        '}',
        'app.register(async (v1) => {',
        "  v1.get('/items', h)",
        "  v1.register(adminRoutes, { prefix: '/admin' })",
        '  v1.register(',
        '    async (deep) => {',
        "      deep.route({ method: ['GET', 'POST'], path: '/deep', handler: h })",
        '    },',
        "    { prefix: '/nested' },",
        '  )',
        "}, { prefix: '/v1' })",
      ].join('\n'),
    })
    expect(routes.map((r) => `${r.method} ${r.path} ${r.confidence}`)).toEqual([
      'GET /v1/admin/stats high',
      'GET /v1/items high',
      'GET /v1/nested/deep high',
      'POST /v1/nested/deep high',
    ])
  })

  it('keeps plugin routes as written, medium, when the prefix is unknown', async () => {
    const { routes } = await routesOf({
      'package.json': FASTIFY,
      'src/app.ts': [
        "import Fastify from 'fastify'",
        "import AutoLoad from '@fastify/autoload'",
        "import users from './users.js'",
        'const app = Fastify()',
        'app.register(users, { prefix: process.env.PREFIX })',
        'app.register(AutoLoad, { dir: "routes" })',
      ].join('\n'),
      'src/users.ts':
        "import type { FastifyPluginAsync } from 'fastify'\nconst plugin: FastifyPluginAsync = async (fastify) => {\n  fastify.get('/me', h)\n}\nexport default plugin\n",
      'src/routes/health.js': "module.exports = async function (fastify) {\n  fastify.get('/health', h)\n}\n",
    })
    for (const path of ['/me', '/health']) {
      expect(find(routes, 'GET', path)).toMatchObject({
        confidence: 'medium',
        note: 'registered as a plugin; a prefix may apply',
      })
    }
  })

  it('follows withTypeProvider() and other configuration chains to the instance', async () => {
    const { routes } = await routesOf({
      'package.json': FASTIFY,
      'src/app.ts': [
        "import Fastify from 'fastify'",
        'const app = Fastify()',
        "app.withTypeProvider<ZodTypeProvider>().get('/typed', { schema }, h)",
        "app.addHook('onRequest', hook).setErrorHandler(onError).post('/hooked', h)",
      ].join('\n'),
    })
    expect(routes.map((r) => `${r.method} ${r.path} ${r.confidence}`)).toEqual(['POST /hooked high', 'GET /typed high'])
  })

  it('ignores unknown methods, dynamic urls and non-route calls', async () => {
    const { routes } = await routesOf({
      'package.json': FASTIFY,
      'src/app.js': [
        "import fastify from 'fastify'",
        'const app = fastify()',
        "app.route({ method: 'PROPFIND', url: '/dav', handler: h })",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test
        'app.route({ method: "GET", url: `/users/${id}`, handler: h })',
        "app.route({ method: 'GET', url })",
        "app.inject({ method: 'GET', url: '/inject' })",
        "app.get('/ok', h)",
      ].join('\n'),
    })
    expect(summary(routes)).toEqual(['GET /ok'])
  })
})
