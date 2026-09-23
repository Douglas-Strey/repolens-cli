import { describe, expect, it } from 'vitest'
import { find, fixtureRoutes, routesOf, summary } from './helpers.ts'

const EXPRESS = JSON.stringify({ dependencies: { express: '^5.1.0' } })

describe('Express routes', () => {
  it('extracts the express-api fixture with the mounted prefix resolved', async () => {
    const { routes } = await fixtureRoutes('express-api')
    expect(routes.map((r) => `${r.method} ${r.path} ${r.file}:${r.line} ${r.confidence}`)).toEqual([
      'GET / src/index.js:12 high',
      'GET /api/items src/routes/items.js:6 high',
      'POST /api/items src/routes/items.js:11 high',
      'PUT /api/items/:id src/routes/items.js:16 high',
      'DELETE /api/items/:id src/routes/items.js:22 high',
      'GET /health src/routes/health.js:7 high',
      'POST /health src/routes/health.js:7 high',
    ])
    expect(routes.every((r) => r.framework === 'express' && r.kind === 'api' && r.package === '.')).toBe(true)
  })

  it('skips dynamic paths, comments, settings getters and non-route receivers', async () => {
    const { routes } = await routesOf({
      'package.json': EXPRESS,
      'src/app.js': [
        "import express from 'express'",
        'const app = express()',
        'const cache = new Map()',
        "app.get('/ok', (req, res) => res.end())",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test
        'app.get(`/users/${id}`, handler)',
        "app.get('/a' + suffix, handler)",
        'app.get(PATH, handler)',
        "// app.get('/commented', handler)",
        "/* app.post('/block', handler) */",
        "app.get('title')",
        "cache.get('key')",
        'const s = "app.get(\'/in-string\')"',
        'app.post(`/static-template`, handler)',
        "app.get('relative', handler)",
      ].join('\n'),
    })
    expect(summary(routes)).toEqual(['GET /ok', 'POST /static-template'])
  })

  it('ignores files that do not use Express', async () => {
    const { routes } = await routesOf({
      'package.json': EXPRESS,
      'src/client.js': "const res = headers.get('/x', 1)\napi.get('/users', { params })\n",
    })
    expect(routes).toEqual([])
  })

  it('ignores packages that do not depend on Express', async () => {
    const { routes } = await routesOf({
      'package.json': JSON.stringify({ dependencies: { koa: '^2.0.0' } }),
      'src/app.js': "const express = require('express')\nconst app = express()\napp.get('/x', h)\n",
    })
    expect(routes).toEqual([])
  })

  it('resolves routers mounted in the same file and path arrays', async () => {
    const { routes } = await routesOf({
      'package.json': EXPRESS,
      'server.ts': [
        "import express, { Router } from 'express'",
        'const app = express()',
        'const api = Router()',
        'const admin = express.Router()',
        "api.get(['/a', '/b'], h)",
        "admin.delete('/users/:id', h)",
        "api.use('/admin', admin)",
        "app.use('/api', auth, api)",
      ].join('\n'),
    })
    expect(routes.map((r) => `${r.method} ${r.path} ${r.confidence}`)).toEqual([
      'GET /api/a high',
      'DELETE /api/admin/users/:id high',
      'GET /api/b high',
    ])
  })

  it('follows mounts across files (require, import, index files, TS sources for .js specifiers)', async () => {
    const { routes } = await routesOf({
      'package.json': EXPRESS,
      'src/main.ts': [
        "import express from 'express'",
        "import v1 from './routes/index.js'",
        'const app = express()',
        "app.use('/v1', v1)",
        "app.use('/legacy', require('./legacy'))",
      ].join('\n'),
      'src/routes/index.ts': [
        "import { Router } from 'express'",
        "import users from './users'",
        'const router = Router()',
        "router.use('/users', users)",
        'export default router',
      ].join('\n'),
      'src/routes/users.ts': [
        "import { Router } from 'express'",
        'const router = Router()',
        "router.get('/:id', h)",
        'export default router',
      ].join('\n'),
      'src/legacy.js':
        "const router = require('express').Router()\nrouter.post('/login', h)\nmodule.exports = router\n",
    })
    expect(routes.map((r) => `${r.method} ${r.path} ${r.confidence}`)).toEqual([
      'POST /legacy/login high',
      'GET /v1/users/:id high',
    ])
  })

  it('follows router factories (dependency injection)', async () => {
    const { routes } = await routesOf({
      'package.json': EXPRESS,
      'src/app.js': [
        "const express = require('express')",
        "const makeUsers = require('./users')",
        'const app = express()',
        "app.use('/users', makeUsers(db))",
        "app.use('/orders', require('./orders')(db, cache))",
        "app.use(cors(), require('./health')())",
      ].join('\n'),
      'src/users.js':
        "const { Router } = require('express')\nmodule.exports = (db) => {\n  const r = Router()\n  r.get('/:id', h)\n  return r\n}\n",
      'src/orders.js':
        "const express = require('express')\nmodule.exports = (db) => {\n  const router = express.Router()\n  router.post('/', h)\n  return router\n}\n",
      'src/health.js':
        "const express = require('express')\nmodule.exports = () => express.Router().get('/health', h)\n",
    })
    expect(routes.map((r) => `${r.method} ${r.path} ${r.confidence}`)).toEqual([
      'GET /health high',
      'POST /orders high',
      'GET /users/:id high',
    ])
  })

  it('marks routers with an unknown mount point as medium', async () => {
    const { routes } = await routesOf({
      'package.json': EXPRESS,
      'src/app.js': [
        "const express = require('express')",
        "const items = require('./items')",
        'const app = express()',
        'app.use(config.basePath, items)',
      ].join('\n'),
      'src/items.js': "const router = require('express').Router()\nrouter.get('/list', h)\nmodule.exports = router\n",
      'src/orphan.js': "const { Router } = require('express')\nconst r = Router()\nr.get('/orphan', h)\n",
      'src/register.js': "require('express')\nmodule.exports = (app) => {\n  app.get('/registered', h)\n}\n",
    })
    for (const path of ['/list', '/orphan', '/registered']) {
      expect(find(routes, 'GET', path)).toMatchObject({
        confidence: 'medium',
        note: 'mounted by a router; prefix may apply',
      })
    }
  })

  it('gives unidentified receivers low confidence', async () => {
    const { routes } = await routesOf({
      'package.json': EXPRESS,
      'src/proxy.js': "const express = require('express')\nupstream.get('/users', options)\n",
    })
    expect(find(routes, 'GET', '/users')).toMatchObject({
      confidence: 'low',
      note: 'receiver could not be identified as a router',
    })
  })

  it('handles multi-line route chains and all()', async () => {
    const { routes } = await routesOf({
      'package.json': EXPRESS,
      'app.js': [
        "const express = require('express')",
        'const app = express()',
        'app',
        "  .route('/book')",
        '  .get(h)',
        '  .put(h)',
        "app.all('/any', h)",
        "app.get('/a', h).post('/b', h)",
      ].join('\n'),
    })
    expect(routes.map((r) => `${r.method} ${r.path}:${r.line}`)).toEqual([
      'GET /a:8',
      'ANY /any:7',
      'POST /b:8',
      'GET /book:4',
      'PUT /book:4',
    ])
  })

  it('follows a multi-line configuration chain back to the app', async () => {
    // Turborepo examples/with-docker apps/api/src/server.ts
    const { routes } = await routesOf({
      'package.json': EXPRESS,
      'src/server.ts': [
        'import { json, urlencoded } from "body-parser";',
        'import express, { type Express } from "express";',
        'import morgan from "morgan";',
        'import cors from "cors";',
        '',
        'export const createServer = (): Express => {',
        '  const app = express();',
        '  app',
        '    .disable("x-powered-by")',
        '    .use(morgan("dev"))',
        '    .use(urlencoded({ extended: true }))',
        '    .use(json())',
        '    .use(cors())',
        '    .get("/message/:name", (req, res) => {',
        '      return res.json({ message: req.params.name });',
        '    })',
        '    .get("/status", (_, res) => {',
        '      return res.json({ ok: true });',
        '    });',
        '',
        '  return app;',
        '};',
      ].join('\n'),
    })
    expect(routes.map((r) => `${r.method} ${r.path}:${r.line} ${r.confidence}`)).toEqual([
      'GET /message/:name:14 high',
      'GET /status:17 high',
    ])
  })

  it('does not follow chains through methods that may return another object', async () => {
    const { routes } = await routesOf({
      'package.json': EXPRESS,
      'src/app.js': "const express = require('express')\nconst app = express()\napp.listen(3000).get('/x', h)\n",
    })
    expect(find(routes, 'GET', '/x')?.confidence).toBe('low')
  })

  it('applies mounts to a router built by a chain and assigned to a name', async () => {
    const { routes } = await routesOf({
      'package.json': EXPRESS,
      'src/app.js': [
        "const express = require('express')",
        'const app = express()',
        "const users = express.Router().get('/', h).post('/:id', h)",
        "app.use('/users', users)",
      ].join('\n'),
    })
    expect(routes.map((r) => `${r.method} ${r.path} ${r.confidence}`)).toEqual([
      'GET /users high',
      'POST /users/:id high',
    ])
  })

  it('skips test files and files larger than the read limit', async () => {
    const big = `const express = require('express')\nconst app = express()\napp.get('/big', h)\n${'// padding\n'.repeat(400)}`
    const { routes } = await routesOf(
      {
        'package.json': EXPRESS,
        'src/app.test.js': "const express = require('express')\nconst app = express()\napp.get('/test-only', h)\n",
        'test/helpers.js': "const express = require('express')\nconst app = express()\napp.get('/helper', h)\n",
        'src/big.js': big,
        'src/small.js': "const express = require('express')\nconst app = express()\napp.get('/small', h)\n",
      },
      { maxFileSize: 2000 },
    )
    expect(summary(routes)).toEqual(['GET /small'])
  })
})
