import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { normalizePath, routesDetector } from '../../../src/detectors/routes/index.ts'
import { MAX_ROUTES } from '../../../src/detectors/routes/shared.ts'
import {
  canSymlink,
  contextFor,
  makeProject,
  makeTempDir,
  SECRET_SENTINEL,
  timeBudget,
  writeFiles,
} from '../../helpers.ts'
import { fixtureRoutes, routesOf, summary } from './helpers.ts'

const FIXTURES = ['nuxt-app', 'next-app', 'fastify-api', 'express-api', 'nest-api', 'go-api', 'monorepo', 'bun-app']

describe('routes detector', () => {
  it('is registered under the routes section id and re-exports normalizePath', () => {
    expect(routesDetector.id).toBe('routes')
    expect(normalizePath('/a/{id}/')).toBe('/a/:id')
  })

  it('produces identical output on repeated scans', async () => {
    for (const name of ['monorepo', 'express-api', 'go-api']) {
      const first = await fixtureRoutes(name)
      const second = await fixtureRoutes(name)
      expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    }
  })

  it('never outputs absolute paths or fixture secrets', async () => {
    for (const name of FIXTURES) {
      const json = JSON.stringify(await fixtureRoutes(name))
      expect(json).not.toContain(SECRET_SENTINEL)
      expect(json).not.toMatch(/"file":"\//)
    }
  })

  it('reports routes of several frameworks per package in a monorepo', async () => {
    const { routes } = await fixtureRoutes('monorepo')
    expect(routes.map((r) => `${r.package} ${r.framework} ${r.kind} ${r.method} ${r.path}`)).toEqual([
      'apps/api fastify api POST /api/auth/login',
      'apps/api fastify api POST /api/orders',
      'apps/api fastify api GET /api/users',
      'apps/web nuxt api GET /api/stats',
      'apps/web nuxt page GET /',
      'services/billing go-net-http api ANY /invoices',
    ])
  })

  it('caps the number of routes and sets truncated', async () => {
    const lines = Array.from({ length: MAX_ROUTES + 500 }, (_, i) => `app.get('/r${String(i).padStart(5, '0')}', h)`)
    const { routes, truncated } = await routesOf({
      'package.json': JSON.stringify({ dependencies: { express: '^5.1.0' } }),
      'app.js': `const express = require('express')\nconst app = express()\n${lines.join('\n')}\n`,
    })
    expect(truncated).toBe(true)
    expect(routes).toHaveLength(MAX_ROUTES)
    expect(routes[0]?.path).toBe('/r00000')
  })

  it('does not crash on malformed manifests or source', async () => {
    const { routes } = await routesOf({
      'package.json': '{ "dependencies": { "express": ',
      'app.js': "const express = require('express')\napp.get('/x', h)",
    })
    expect(routes).toEqual([])

    const garbage = await routesOf({
      'package.json': JSON.stringify({
        dependencies: { express: '^5', fastify: '^5', hono: '^4', '@nestjs/common': '^11' },
      }),
      'a.ts':
        "import express from 'express'\nimport 'fastify'\nimport 'hono'\nimport '@nestjs/common'\n((( app.get('/a', `${ \n'",
      'b.js': "require('express')\n}}}]]]))) app.get('/b', h) /* unterminated",
      'c.js': `require('express')\n${'app.use(app.use('.repeat(2000)}`,
      'd.ts': "import { Controller, Get } from '@nestjs/common'\n@Controller(\n@Get(",
    })
    expect(Array.isArray(garbage.routes)).toBe(true)
  })

  it('stays fast on adversarial source files', async () => {
    const size = 300_000
    const fill = (unit: string, prefix: string) => prefix + unit.repeat(Math.ceil(size / unit.length))
    const started = performance.now()
    const { routes } = await routesOf({
      'package.json': JSON.stringify({
        dependencies: { express: '^5', fastify: '^5', hono: '^4', '@nestjs/common': '^11' },
      }),
      'go.mod': 'module x\n\ngo 1.25\n\nrequire github.com/gin-gonic/gin v1.11.0\n',
      'src/dollars.ts': fill('a$', "import express from 'express'\n"),
      'src/ident.ts': fill('a', "import 'fastify'\n"),
      'src/generics.ts': fill('a.get<', "import 'hono'\n"),
      'src/imports.ts': fill('import ', ''),
      'src/templates.ts': fill('`${', "import '@nestjs/common'\n"),
      'main.go': fill('a.b.c.d.', 'package main\nimport "net/http"\n'),
      'imports.go': fill('import (', 'package main\n'),
      'funcs.go': fill('\nfunc (', 'package main\nimport "net/http"\n'),
    })
    expect(routes).toEqual([])
    expect(performance.now() - started).toBeLessThan(timeBudget(10_000))
  })

  it('stays fast when routers are mounted on each other in cycles', async () => {
    const count = 12
    const lines = ["const express = require('express')", 'const app = express()']
    for (let i = 0; i < count; i++) lines.push(`const r${i} = express.Router()`, `r${i}.get('/x${i}', h)`)
    for (let i = 0; i < count; i++) {
      for (let j = 0; j < count; j++) if (i !== j) lines.push(`r${i}.use('/p${j}', r${j})`)
    }
    lines.push("app.use('/root', r0)")
    const started = performance.now()
    const { routes } = await routesOf({
      'package.json': JSON.stringify({ dependencies: { express: '^5.1.0' } }),
      'app.js': lines.join('\n'),
    })
    expect(routes.length).toBeGreaterThan(0)
    expect(routes.some((r) => r.path === '/root/x0' && r.confidence === 'high')).toBe(true)
    expect(performance.now() - started).toBeLessThan(timeBudget(5_000))
  })

  it('skips binary files', async () => {
    const dir = await makeProject({ 'package.json': JSON.stringify({ dependencies: { express: '^5.1.0' } }) })
    await fs.writeFile(
      path.join(dir, 'app.js'),
      Buffer.concat([Buffer.from("const express = require('express')\napp.get('/bin', h)\n"), Buffer.from([0, 1, 2])]),
    )
    const ctx = await contextFor(dir)
    expect((await ctx.use(routesDetector)).routes).toEqual([])
  })

  it.skipIf(!canSymlink)('does not follow symlinks out of the project', async () => {
    const outside = await makeTempDir('repolens-outside-')
    await writeFiles(outside, {
      'routes.js': "const express = require('express')\nconst app = express()\napp.get('/outside', h)\n",
    })
    const dir = await makeProject({ 'package.json': JSON.stringify({ dependencies: { express: '^5.1.0' } }) })
    await fs.symlink(path.join(outside, 'routes.js'), path.join(dir, 'linked.js'))
    const ctx = await contextFor(dir)
    expect((await ctx.use(routesDetector)).routes).toEqual([])
  })

  it('only reads the source files of packages that use a framework', async () => {
    const { routes } = await routesOf({
      'package.json': JSON.stringify({ private: true, workspaces: ['packages/*'] }),
      'packages/api/package.json': JSON.stringify({ dependencies: { express: '^5.1.0' } }),
      'packages/api/src/app.js': "const express = require('express')\nconst app = express()\napp.get('/api', h)\n",
      'packages/tools/package.json': JSON.stringify({ name: 'tools' }),
      'packages/tools/src/app.js': "const express = require('express')\nconst app = express()\napp.get('/tools', h)\n",
    })
    expect(routes.map((r) => `${r.package} ${r.method} ${r.path}`)).toEqual(['packages/api GET /api'])
  })

  it('returns an empty section for projects without routes', async () => {
    expect(await routesOf({ 'README.md': '# nothing here' })).toEqual({ routes: [], truncated: false })
    expect(summary((await routesOf({ 'package.json': '{}' })).routes)).toEqual([])
  })
})
