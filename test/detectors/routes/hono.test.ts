import { describe, expect, it } from 'vitest'
import { find, fixtureRoutes, routesOf } from './helpers.ts'

const HONO = JSON.stringify({ type: 'module', dependencies: { hono: '^4.10.2' } })

describe('Hono routes', () => {
  it('extracts the bun-app fixture', async () => {
    const { routes } = await fixtureRoutes('bun-app')
    expect(routes).toEqual([
      {
        method: 'GET',
        path: '/',
        kind: 'api',
        framework: 'hono',
        file: 'src/index.ts',
        line: 9,
        confidence: 'high',
        package: '.',
      },
      {
        method: 'POST',
        path: '/webhooks/:id',
        kind: 'api',
        framework: 'hono',
        file: 'src/index.ts',
        line: 11,
        confidence: 'high',
        package: '.',
      },
    ])
  })

  it('supports basePath, chaining, on() and same-file sub-apps', async () => {
    const { routes } = await routesOf({
      'package.json': HONO,
      'src/index.ts': [
        "import { Hono } from 'hono'",
        "const app = new Hono<{ Bindings: Env }>().basePath('/api')",
        'const users = new Hono()',
        "users.get('/', h).post('/', h)",
        "app.on(['PUT', 'PATCH'], '/items/:id{[0-9]+}', h)",
        "app.route('/users', users)",
        "new Hono().get('/inline', h)",
        "app.all('/any', h)",
      ].join('\n'),
    })
    expect(routes.map((r) => `${r.method} ${r.path} ${r.confidence}`)).toEqual([
      'ANY /api/any high',
      'PUT /api/items/:id high',
      'PATCH /api/items/:id high',
      'GET /api/users high',
      'POST /api/users high',
      'GET /inline high',
    ])
  })

  it('mounts sub-apps built by chaining in the same file', async () => {
    const { routes } = await routesOf({
      'package.json': HONO,
      'src/index.ts': [
        "import { Hono } from 'hono'",
        'const app = new Hono()',
        "const books = new Hono().get('/', (c) => c.json([])).get('/:id', (c) => c.json({}))",
        "const api = new Hono().basePath('/v1').get('/ping', h)",
        "const late = new Hono().get('/before', h).basePath('/base')",
        "app.route('/books', books)",
        "app.route('/api', api)",
        "export default new Hono().get('/standalone', h)",
      ].join('\n'),
    })
    expect(routes.map((r) => `${r.method} ${r.path} ${r.confidence}`)).toEqual([
      'GET /api/v1/ping high',
      'GET /before high',
      'GET /books high',
      'GET /books/:id high',
      'GET /standalone high',
    ])
  })

  it('resolves sub-apps imported from other files', async () => {
    const { routes } = await routesOf({
      'package.json': HONO,
      'src/index.ts':
        "import { Hono } from 'hono'\nimport books from './books'\nconst app = new Hono()\napp.route('/books', books)\n",
      'src/books.ts':
        "import { Hono } from 'hono'\nconst books = new Hono()\nbooks.get('/:id', h)\nexport default books\n",
    })
    expect(find(routes, 'GET', '/books/:id')).toMatchObject({ confidence: 'high', file: 'src/books.ts' })
  })

  it('marks routes on apps not created in the file as medium', async () => {
    const { routes } = await routesOf({
      'package.json': HONO,
      'src/routes.ts':
        "import type { Hono } from 'hono'\nexport function register(app: Hono) {\n  app.get('/registered', h)\n}\n",
    })
    expect(find(routes, 'GET', '/registered')).toMatchObject({
      confidence: 'medium',
      note: 'not created with new Hono() in this file; a prefix may apply',
    })
  })
})
