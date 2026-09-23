import { describe, expect, it } from 'vitest'
import { nextAppFile, nextAppPath, nextHandlerMethods, nextPagesRoute } from '../../../src/detectors/routes/next.ts'
import { find, fixtureRoutes, routesOf, summary } from './helpers.ts'

const NEXT = JSON.stringify({ dependencies: { next: '^16.0.1', react: '^19.2.0' } })

describe('nextAppPath', () => {
  it.each([
    ['', '/'],
    ['dashboard', '/dashboard'],
    ['(marketing)/pricing', '/pricing'],
    ['blog/[slug]', '/blog/[slug]'],
    ['@modal/login', '/login'],
    ['%5Fescaped', '/_escaped'],
  ])('%s → %s', (dir, path) => {
    expect(nextAppPath(dir)).toBe(path)
  })

  it('excludes private folders and intercepting routes', () => {
    expect(nextAppPath('_components/button')).toBeNull()
    expect(nextAppPath('feed/(.)photo/[id]')).toBeNull()
    expect(nextAppPath('(..)photo')).toBeNull()
    expect(nextAppPath('(...)photo')).toBeNull()
    expect(nextAppPath('(..)(..)photo')).toBeNull()
  })
})

describe('nextAppFile / nextPagesRoute', () => {
  it('recognizes page and route files only', () => {
    expect(nextAppFile('page.tsx')).toEqual({ kind: 'page', path: '/' })
    expect(nextAppFile('docs/page.mdx')).toEqual({ kind: 'page', path: '/docs' })
    expect(nextAppFile('api/users/route.ts')).toEqual({ kind: 'handler', path: '/api/users' })
    expect(nextAppFile('layout.tsx')).toBeNull()
    expect(nextAppFile('loading.tsx')).toBeNull()
    expect(nextAppFile('route.test.ts')).toBeNull()
  })

  it('maps the Pages Router', () => {
    expect(nextPagesRoute('index.tsx')).toEqual({ kind: 'page', path: '/' })
    expect(nextPagesRoute('blog/[slug].tsx')).toEqual({ kind: 'page', path: '/blog/[slug]' })
    expect(nextPagesRoute('docs/[[...slug]].tsx')).toEqual({ kind: 'page', path: '/docs/[[...slug]]' })
    expect(nextPagesRoute('api/legacy.ts')).toEqual({ kind: 'api', path: '/api/legacy' })
    expect(nextPagesRoute('api/index.ts')).toEqual({ kind: 'api', path: '/api' })
    for (const special of ['_app.tsx', '_document.tsx', '_error.tsx', '_middleware.ts']) {
      expect(nextPagesRoute(special)).toBeNull()
    }
    expect(nextPagesRoute('styles.css')).toBeNull()
  })
})

describe('nextHandlerMethods', () => {
  it('finds every export form with its line', () => {
    const text = [
      'export async function GET() {}', // 1
      'export const POST = async () => {}', // 2
      'const handler = () => {}', // 3
      'export { handler as PUT, handler as PATCH }', // 4
      'export const { DELETE } = handlers', // 5
      'export function helper() {}', // 6
      '// export function OPTIONS() {}', // 7
      "export const dynamic = 'force-dynamic'", // 8
    ].join('\n')
    expect(nextHandlerMethods(text)).toEqual([
      { method: 'GET', line: 1 },
      { method: 'POST', line: 2 },
      { method: 'DELETE', line: 5 },
      { method: 'PUT', line: 4 },
      { method: 'PATCH', line: 4 },
    ])
  })

  it('supports the Auth.js destructuring pattern', () => {
    expect(nextHandlerMethods('export const { GET, POST } = handlers').map((m) => m.method)).toEqual(['GET', 'POST'])
  })
})

describe('Next.js routes', () => {
  it('extracts the next-app fixture', async () => {
    const { routes } = await fixtureRoutes('next-app')
    expect(routes.map((r) => `${r.kind} ${r.method} ${r.path} ${r.file}${r.line ? `:${r.line}` : ''}`)).toEqual([
      'api ANY /api/legacy pages/api/legacy.ts',
      'api GET /api/users app/api/users/route.ts:4',
      'api POST /api/users app/api/users/route.ts:9',
      'api GET /api/users/:id app/api/users/[id]/route.ts:6',
      'api DELETE /api/users/:id app/api/users/[id]/route.ts:15',
      'page GET / app/page.tsx',
      'page GET /blog/:slug app/blog/[slug]/page.tsx',
      'page GET /dashboard app/dashboard/page.tsx',
      'page GET /pricing app/(marketing)/pricing/page.tsx',
    ])
    expect(routes.every((r) => r.framework === 'next' && r.confidence === 'high')).toBe(true)
  })

  it('handles src/app, catch-alls, parallel and intercepting routes', async () => {
    const { routes } = await routesOf({
      'package.json': NEXT,
      'src/app/page.tsx': '',
      'src/app/docs/[[...slug]]/page.tsx': '',
      'src/app/shop/[...path]/page.tsx': '',
      'src/app/@modal/(.)photo/[id]/page.tsx': '',
      'src/app/photo/[id]/page.tsx': '',
      'src/app/_lib/page.tsx': '',
      'src/app/api/empty/route.ts': 'export * from "./impl"',
    })
    expect(summary(routes)).toEqual(['ANY /api/empty', 'GET /', 'GET /docs/*slug', 'GET /photo/:id', 'GET /shop/*path'])
    expect(find(routes, 'GET', '/docs/*slug')?.note).toBe('optional catch-all')
    expect(find(routes, 'ANY', '/api/empty')).toMatchObject({
      confidence: 'low',
      note: 'no exported HTTP method handlers found',
    })
  })

  it('does not repeat a URL for parallel-route slots', async () => {
    const { routes } = await routesOf({
      'package.json': NEXT,
      'app/page.tsx': '',
      'app/@analytics/page.tsx': '',
      'app/dashboard/page.tsx': '',
      'app/dashboard/@team/page.tsx': '',
      'app/@modal/login/page.tsx': '',
    })
    expect(routes.map((r) => `${r.path} ${r.file}`)).toEqual([
      '/ app/page.tsx',
      '/dashboard app/dashboard/page.tsx',
      '/login app/@modal/login/page.tsx',
    ])
  })

  it('ignores src/app when app/ exists at the package root', async () => {
    const { routes } = await routesOf({
      'package.json': NEXT,
      'app/page.tsx': '',
      'src/app/old/page.tsx': '',
    })
    expect(summary(routes)).toEqual(['GET /'])
  })

  it('prefixes every route with a literal basePath from next.config', async () => {
    const { routes } = await routesOf({
      'package.json': NEXT,
      'next.config.mjs':
        "/** @type {import('next').NextConfig} */\nconst nextConfig = { basePath: '/store' }\nexport default nextConfig\n",
      'app/page.tsx': '',
      'app/api/items/route.ts': 'export async function GET() {}',
      'pages/legacy.tsx': '',
    })
    expect(routes.map((r) => `${r.kind} ${r.method} ${r.path} ${r.confidence}`)).toEqual([
      'api GET /store/api/items high',
      'page GET /store high',
      'page GET /store/legacy high',
    ])
  })

  it('keeps paths but lowers confidence when basePath is not a literal', async () => {
    const { routes } = await routesOf({
      'package.json': NEXT,
      'next.config.js': 'module.exports = { basePath: process.env.BASE_PATH }\n',
      'app/page.tsx': '',
    })
    expect(routes).toEqual([
      expect.objectContaining({
        path: '/',
        confidence: 'medium',
        note: 'next.config sets basePath dynamically; a prefix may apply',
      }),
    ])
  })

  it('only treats files with the configured pageExtensions as pages', async () => {
    const { routes } = await routesOf({
      'package.json': NEXT,
      'next.config.ts': "const config = { pageExtensions: ['page.tsx', 'api.ts'] }\nexport default config\n",
      'src/pages/index.page.tsx': '',
      'src/pages/_app.page.tsx': '',
      'src/pages/users/[id].page.tsx': '',
      'src/pages/users/UserCard.tsx': '',
      'src/pages/api/hello.api.ts': '',
      'src/pages/api/helpers.ts': '',
    })
    expect(routes.map((r) => `${r.kind} ${r.method} ${r.path} ${r.file}`)).toEqual([
      'api ANY /api/hello src/pages/api/hello.api.ts',
      'page GET / src/pages/index.page.tsx',
      'page GET /users/:id src/pages/users/[id].page.tsx',
    ])
  })

  it('applies pageExtensions to App Router special files', () => {
    expect(nextAppFile('page.page.tsx', ['page.tsx'])).toEqual({ kind: 'page', path: '/' })
    expect(nextAppFile('page.tsx', ['page.tsx'])).toBeNull()
    expect(nextAppFile('docs/page.mdx', ['mdx', 'tsx'])).toEqual({ kind: 'page', path: '/docs' })
    expect(nextPagesRoute('index.page.tsx', ['tsx', 'page.tsx'])).toEqual({ kind: 'page', path: '/' })
  })

  it('works per package in a monorepo', async () => {
    const { routes } = await routesOf({
      'package.json': JSON.stringify({ private: true, workspaces: ['apps/*'] }),
      'apps/site/package.json': NEXT,
      'apps/site/app/about/page.tsx': '',
      'apps/other/package.json': JSON.stringify({ name: 'other' }),
      'apps/other/app/page.tsx': '',
    })
    expect(routes.map((r) => `${r.package} ${r.path}`)).toEqual(['apps/site /about'])
  })
})
