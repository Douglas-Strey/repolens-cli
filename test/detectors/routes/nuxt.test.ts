import { describe, expect, it } from 'vitest'
import { nuxtPageRoute, nuxtRoutes, nuxtServerRoute } from '../../../src/detectors/routes/nuxt.ts'
import { fixtureRoutes, routesOf, summary } from './helpers.ts'

describe('nuxtServerRoute', () => {
  it.each([
    ['users.get.ts', '/api', 'GET', '/api/users'],
    ['users.post.ts', '/api', 'POST', '/api/users'],
    ['health.ts', '/api', 'ANY', '/api/health'],
    ['index.ts', '/api', 'ANY', '/api'],
    ['users/index.get.ts', '/api', 'GET', '/api/users'],
    ['users/[id].delete.mts', '/api', 'DELETE', '/api/users/[id]'],
    ['files/[...path].get.js', '/api', 'GET', '/api/files/[...path]'],
    ['sitemap.xml.ts', '', 'ANY', '/sitemap.xml'],
    ['index.get.ts', '', 'GET', '/'],
    ['(admin)/stats.get.ts', '/api', 'GET', '/api/stats'],
    ['USERS.GET.ts', '/api', 'GET', '/api/USERS'],
  ] as const)('%s under "%s" → %s %s', (file, base, method, path) => {
    expect(nuxtServerRoute(file, base)).toMatchObject({ method, path })
  })

  it('notes environment-specific handlers', () => {
    expect(nuxtServerRoute('debug.get.dev.ts', '/api')).toEqual({
      method: 'GET',
      path: '/api/debug',
      note: 'development only',
    })
  })

  it('ignores non-handler files, dotfiles and "-" prefixed files', () => {
    expect(nuxtServerRoute('users.get.vue', '/api')).toBeNull()
    expect(nuxtServerRoute('types.d.ts', '/api')).toBeNull()
    expect(nuxtServerRoute('.hidden.ts', '/api')).toBeNull()
    expect(nuxtServerRoute('-draft.get.ts', '/api')).toBeNull()
    expect(nuxtServerRoute('README.md', '/api')).toBeNull()
  })
})

describe('nuxtPageRoute', () => {
  it.each([
    ['index.vue', '/'],
    ['about.vue', '/about'],
    ['products/index.vue', '/products'],
    ['products/[id].vue', '/products/[id]'],
    ['(marketing)/pricing.vue', '/pricing'],
    ['posts/[id]-[slug].vue', '/posts/[id]-[slug]'],
    ['docs/[...slug].tsx', '/docs/[...slug]'],
  ])('%s → %s', (file, path) => {
    expect(nuxtPageRoute(file)).toEqual({ method: 'GET', path })
  })

  it('ignores non-page files', () => {
    expect(nuxtPageRoute('helpers.ts')).toBeNull()
    expect(nuxtPageRoute('.draft.vue')).toBeNull()
  })
})

describe('Nuxt routes', () => {
  it('extracts the nuxt-app fixture', async () => {
    const { routes, truncated } = await fixtureRoutes('nuxt-app')
    expect(truncated).toBe(false)
    expect(routes.map((r) => `${r.kind} ${r.method} ${r.path} ${r.file}`)).toEqual([
      'api POST /api/cart server/api/cart.post.ts',
      'api ANY /api/health server/api/health.ts',
      'api GET /api/products server/api/products.get.ts',
      'api GET /api/products/:id server/api/products/[id].get.ts',
      'api ANY /sitemap.xml server/routes/sitemap.xml.ts',
      'page GET / app/pages/index.vue',
      'page GET /about app/pages/about.vue',
      'page GET /products app/pages/products/index.vue',
      'page GET /products/:id app/pages/products/[id].vue',
    ])
    expect(routes.every((r) => r.framework === 'nuxt' && r.confidence === 'high' && r.package === '.')).toBe(true)
    expect(routes.every((r) => r.line === undefined)).toBe(true)
    expect(routes.some((r) => r.file.includes('middleware'))).toBe(false)
  })

  it('resolves paths relative to the Nuxt package in a monorepo', async () => {
    const { routes } = await fixtureRoutes('monorepo')
    const web = routes.filter((r) => r.package === 'apps/web')
    expect(web.map((r) => `${r.method} ${r.path} ${r.file}`)).toEqual([
      'GET /api/stats apps/web/server/api/stats.get.ts',
      'GET / apps/web/app/pages/index.vue',
    ])
  })

  it('falls back to Nuxt 3 pages/ and skips server helpers, tests and optional params', async () => {
    const { routes } = await routesOf({
      'package.json': JSON.stringify({ dependencies: { nuxt: '^3.13.0' } }),
      'pages/index.vue': '<template />',
      'pages/shop/[[category]].vue': '<template />',
      'server/api/items/[id].get.ts': 'export default defineEventHandler(() => ({}))',
      'server/api/items.test.ts': '',
      'server/middleware/auth.ts': '',
      'server/plugins/db.ts': '',
      'server/utils/db.ts': '',
      'components/Foo.vue': '<template />',
    })
    expect(summary(routes)).toEqual(['GET /api/items/:id', 'GET /', 'GET /shop/:category'])
    expect(routes.find((r) => r.path === '/shop/:category')?.note).toBe('optional parameter')
  })

  it('marks optional parameters and lists a nested route parent once', async () => {
    const { routes } = await routesOf({
      'package.json': JSON.stringify({ dependencies: { nuxt: '^3.13.0' } }),
      'pages/[[slug]].vue': '<template />',
      'pages/[[lang]]/about.vue': '<template />',
      'pages/settings.vue': '<template><NuxtPage /></template>',
      'pages/settings/index.vue': '<template />',
      'pages/settings/profile.vue': '<template />',
      'pages/users/[id].vue': '<template><NuxtPage /></template>',
      'pages/users/[id]/posts.vue': '<template />',
    })
    expect(routes.map((r) => `${r.path} ${r.file}${r.note ? ` (${r.note})` : ''}`)).toEqual([
      '/:lang/about pages/[[lang]]/about.vue (optional parameter)',
      '/:slug pages/[[slug]].vue (optional parameter)',
      '/settings pages/settings/index.vue',
      '/settings/profile pages/settings/profile.vue',
      '/users/:id pages/users/[id].vue (nested route parent)',
      '/users/:id/posts pages/users/[id]/posts.vue',
    ])
  })

  it('reads pages and server routes below the srcDir of nuxt.config', async () => {
    const { routes } = await routesOf({
      'package.json': JSON.stringify({ dependencies: { nuxt: '^3.13.0' } }),
      'nuxt.config.ts': "export default defineNuxtConfig({\n  srcDir: 'src/',\n})\n",
      'src/pages/index.vue': '<template />',
      'src/server/api/items.get.ts': '',
      'pages/ignored.vue': '<template />',
    })
    expect(routes.map((r) => `${r.kind} ${r.method} ${r.path} ${r.file}`)).toEqual([
      'api GET /api/items src/server/api/items.get.ts',
      'page GET / src/pages/index.vue',
    ])
  })

  it('keeps Nuxt 4 server routes at the root with a custom srcDir', async () => {
    const { routes } = await routesOf({
      'package.json': JSON.stringify({ dependencies: { nuxt: '^4.0.0' } }),
      'nuxt.config.ts': "export default defineNuxtConfig({ srcDir: 'client' })\n",
      'client/pages/index.vue': '<template />',
      'server/api/items.get.ts': '',
    })
    expect(summary(routes)).toEqual(['GET /api/items', 'GET /'])
  })

  it('notes a srcDir it cannot read and keeps the default layout', async () => {
    const { routes } = await routesOf({
      'package.json': JSON.stringify({ dependencies: { nuxt: '^3.13.0' } }),
      'nuxt.config.ts': 'export default defineNuxtConfig({ srcDir: process.env.SRC })\n',
      'pages/index.vue': '<template />',
    })
    expect(routes).toEqual([
      expect.objectContaining({
        path: '/',
        confidence: 'high',
        note: 'nuxt.config sets srcDir dynamically; routes assume the default layout',
      }),
    ])
  })

  it('does nothing without a nuxt dependency', async () => {
    const { routes } = await routesOf({
      'package.json': JSON.stringify({ dependencies: { vue: '^3.5.0' } }),
      'server/api/users.get.ts': '',
      'pages/index.vue': '',
    })
    expect(routes).toEqual([])
  })

  it('does not attribute a nested package to the Nuxt package', () => {
    const routes = nuxtRoutes({
      files: ['server/api/a.get.ts', 'packages/other/server/api/b.get.ts'],
      packageDir: '.',
      hasDirectory: () => false,
      ownerOf: (file) => (file.startsWith('packages/other/') ? 'packages/other' : '.'),
    })
    expect(summary(routes)).toEqual(['GET /api/a'])
  })
})
