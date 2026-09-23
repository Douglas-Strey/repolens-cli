import { describe, expect, it } from 'vitest'
import { timeBudget } from '../../helpers.ts'
import { find, routesOf, summary } from './helpers.ts'

const JS_FRAMEWORKS = JSON.stringify({
  dependencies: { express: '^5.1.0', fastify: '^5.6.1', hono: '^4.10.2', '@nestjs/common': '^11.1.6', next: '^16.0.1' },
})

function goMod(...requires: string[]): string {
  return `module example.com/app\n\ngo 1.25\n\nrequire (\n${requires.map((r) => `\t${r} v1.0.0`).join('\n')}\n)\n`
}

describe('route-like text that is not code', () => {
  it('ignores calls inside string, template and regex literals', async () => {
    const { routes } = await routesOf({
      'package.json': JS_FRAMEWORKS,
      'src/express.ts': [
        "import express from 'express'",
        'const app = express()',
        'const doc = "app.get(\'/in-double-quotes\', h)"',
        'const doc2 = \'app.post("/in-single-quotes", h)\'',
        "const tpl = `app.put('/in-template', h)`",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test
        "const tpl2 = `${x} app.delete('/after-interpolation', h)`",
        "const re = /app.get('\\/in-regex', h)/",
        "app.get('/real', h)",
      ].join('\n'),
      'src/hono.ts': [
        "import { Hono } from 'hono'",
        'const api = new Hono()',
        "const snippet = `api.get('/hono-template', (c) => c.text('x'))`",
        "api.get('/hono-real', (c) => c.text('ok'))",
      ].join('\n'),
      'src/cats.controller.ts': [
        "import { Controller, Get } from '@nestjs/common'",
        "const usage = \"@Controller('fake') class X { @Get('x') a() {} }\"",
        "@Controller('cats')",
        "export class Cats { @Get('real') a() {} }",
      ].join('\n'),
      'app/api/items/route.ts': "const example = 'export function DELETE() {}'\nexport async function GET() {}\n",
    })
    expect(routes.map((r) => `${r.framework} ${r.method} ${r.path}`)).toEqual([
      'next GET /api/items',
      'nestjs GET /cats/real',
      'hono GET /hono-real',
      'express GET /real',
    ])
  })

  it('ignores Go calls inside interpreted and raw strings', async () => {
    const { routes } = await routesOf({
      'go.mod': goMod('github.com/gin-gonic/gin'),
      'main.go': [
        'package main',
        'import (',
        '\t"net/http"',
        '\t"github.com/gin-gonic/gin"',
        ')',
        'const usage = `r.GET("/in-raw-string", h)`',
        'func main() {',
        '\tr := gin.New()',
        '\tdoc := "http.HandleFunc(\\"/in-string\\", h)"',
        '\tr.GET("/real", h)',
        '}',
      ].join('\n'),
    })
    expect(summary(routes)).toEqual(['GET /real'])
  })
})

describe('calls that are not route registrations', () => {
  it('skips HTTP client calls whose only argument after the path is data', async () => {
    const { routes } = await routesOf({
      'package.json': JS_FRAMEWORKS,
      'src/express.ts': [
        "import express from 'express'",
        "import axios from 'axios'",
        'const app = express()',
        'const api = axios.create()',
        "api.get('/client-call', { params: { page: 1 } })",
        "app.get('/count', 5)",
        "app.get('/null', null)",
        "app.get('/real', listUsers)",
        "app.get('/member', controller.list)",
        "app.get('/wrapped', asyncHandler(async (req, res) => res.json([])))",
        "app.get('/middleware-array', [auth, list])",
      ].join('\n'),
      'src/fastify.ts': [
        "import Fastify from 'fastify'",
        'const app = Fastify()',
        "app.get('/fastify-client', { params })",
        "app.get('/fastify-options-handler', { schema, handler: list })",
        "app.get('/fastify-options-then-handler', { schema }, list)",
      ].join('\n'),
      'src/hono.ts': [
        "import { Hono } from 'hono'",
        'const app = new Hono()',
        "client.get('/hono-client', { query })",
        "app.on('GET', '/hono-on-data', { x: 1 })",
        "app.on('GET', '/hono-on', (c) => c.text('ok'))",
      ].join('\n'),
    })
    expect(summary(routes)).toEqual([
      'GET /fastify-options-handler',
      'GET /fastify-options-then-handler',
      'GET /hono-on',
      'GET /member',
      'GET /middleware-array',
      'GET /real',
      'GET /wrapped',
    ])
  })

  it('skips Go method calls whose last argument cannot be a handler', async () => {
    const { routes } = await routesOf({
      'go.mod': goMod('github.com/go-chi/chi/v5'),
      'main.go': [
        'package main',
        'import "github.com/go-chi/chi/v5"',
        'func main() {',
        '\tr := chi.NewRouter()',
        '\tcache.Get("/cache-key", &out)',
        '\tconfig.Get("/setting", "default")',
        '\tr.Get("/real", h.List)',
        '}',
      ].join('\n'),
    })
    expect(summary(routes)).toEqual(['GET /real'])
  })
})

describe('prefix resolution', () => {
  it('applies a same-file mount only to the binding it names', async () => {
    const { routes } = await routesOf({
      'package.json': JS_FRAMEWORKS,
      'src/app.js': [
        "const express = require('express')",
        'const app = express()',
        'function buildInner() {',
        '  const router = express.Router()',
        "  router.get('/inner', h)",
        '  return router',
        '}',
        'const router = express.Router()',
        "router.get('/outer', h)",
        "app.use('/v2', router)",
      ].join('\n'),
    })
    expect(find(routes, 'GET', '/v2/outer')?.confidence).toBe('high')
    expect(find(routes, 'GET', '/v2/inner')).toBeUndefined()
    expect(find(routes, 'GET', '/inner')).toMatchObject({
      confidence: 'medium',
      note: 'mounted by a router; prefix may apply',
    })
  })
})

describe('robustness', () => {
  it('keeps the routes of a file with deeply nested arrays', async () => {
    const depth = 50_000
    const { routes } = await routesOf({
      'package.json': JS_FRAMEWORKS,
      'src/app.js': [
        "const express = require('express')",
        'const app = express()',
        "app.get('/ok', h)",
        `app.get('/nested', ${'['.repeat(depth)}${']'.repeat(depth)})`,
        `app.get(${'['.repeat(depth)}${']'.repeat(depth)}, h)`,
      ].join('\n'),
    })
    expect(summary(routes)).toEqual(['GET /nested', 'GET /ok'])
  })

  it('stays fast when a line is full of regex-like slashes', async () => {
    // Every "/" after "=" may start a regex literal; an unbounded look-ahead made this quadratic.
    const started = performance.now()
    const { routes } = await routesOf(
      {
        'package.json': JS_FRAMEWORKS,
        'src/app.ts': `import express from 'express'\nconst app = express()\napp.get('/ok', h)\n${'= /['.repeat(100_000)}\n`,
      },
      { maxFileSize: 1024 * 1024 },
    )
    expect(summary(routes)).toEqual(['GET /ok'])
    expect(performance.now() - started).toBeLessThan(timeBudget(5_000))
  })

  it('stays fast when two Express routers mount each other thousands of times', async () => {
    // Every reference used to be resolved separately, each walking every mount of the other router (280 s).
    const count = 15_000
    const started = performance.now()
    const { routes } = await routesOf(
      {
        'package.json': JSON.stringify({ dependencies: { express: '4' } }),
        'src/server.ts': [
          'import express from "express"',
          'const app = express()',
          'const r = express.Router()',
          ...Array.from({ length: count }, () => 'app.use("/a", r)'),
          ...Array.from({ length: count }, () => 'r.use("/b", app)'),
          'r.get("/x", h)',
        ].join('\n'),
      },
      { maxFileSize: 1024 * 1024 },
    )
    expect(routes.length).toBeGreaterThan(0)
    expect(routes.every((r) => r.path.endsWith('/x') && r.confidence === 'medium')).toBe(true)
    expect(performance.now() - started).toBeLessThan(timeBudget(5_000))
  })

  it.each([
    ['express', 'const app = express()\nconst r = express.Router()', 'use', 'import express from "express"'],
    ['hono', 'const app = new Hono()\nconst r = new Hono()', 'route', 'import { Hono } from "hono"'],
  ])('stays fast when %s routers mount each other under distinct prefixes', async (framework, setup, mount, head) => {
    const count = 2000
    const started = performance.now()
    const { routes } = await routesOf(
      {
        'package.json': JSON.stringify({ dependencies: { [framework]: '4' } }),
        'src/server.ts': [
          head,
          setup,
          ...Array.from({ length: count }, (_, i) => `app.${mount}("/a${i}", r)`),
          ...Array.from({ length: count }, (_, i) => `r.${mount}("/b${i}", app)`),
          'r.get("/x", h)',
        ].join('\n'),
      },
      { maxFileSize: 1024 * 1024 },
    )
    expect(routes.length).toBeGreaterThan(0)
    expect(routes.length).toBeLessThanOrEqual(16)
    expect(performance.now() - started).toBeLessThan(timeBudget(5_000))
  })

  it('stays fast when Fastify plugins register each other thousands of times', async () => {
    const count = 2000
    const started = performance.now()
    const { routes } = await routesOf(
      {
        'package.json': JSON.stringify({ dependencies: { fastify: '5' } }),
        'src/server.ts': [
          'import Fastify from "fastify"',
          'const app = Fastify()',
          'async function a(f) {',
          '  f.get("/x", h)',
          ...Array.from({ length: count }, (_, i) => `  f.register(b, { prefix: "/b${i}" })`),
          '}',
          'async function b(g) {',
          ...Array.from({ length: count }, (_, i) => `  g.register(a, { prefix: "/a${i}" })`),
          '}',
          ...Array.from({ length: count }, (_, i) => `app.register(a, { prefix: "/r${i}" })`),
        ].join('\n'),
      },
      { maxFileSize: 1024 * 1024 },
    )
    expect(routes.length).toBeGreaterThan(0)
    expect(routes.every((r) => r.path.endsWith('/x'))).toBe(true)
    expect(performance.now() - started).toBeLessThan(timeBudget(5_000))
  })

  it('stops resolving densely cross-mounted routers and reports the rest as unresolved', async () => {
    const count = 60
    const lines = ["const express = require('express')", 'const app = express()']
    for (let i = 0; i < count; i++) lines.push(`const r${i} = express.Router()`)
    for (let i = 0; i < count; i++) {
      for (let j = 0; j < count; j++) if (i !== j) lines.push(`r${i}.use('/p${j}', r${j})`)
    }
    for (let i = 0; i < count; i++) lines.push(`r${i}.get('/x${i}', h)`)
    lines.push("app.use('/root', r0)")
    const started = performance.now()
    const { routes, truncated } = await routesOf({
      'package.json': JSON.stringify({ dependencies: { express: '^5.1.0' } }),
      'app.js': lines.join('\n'),
    })
    expect(truncated).toBe(true)
    // Every route is still listed, unresolved ones as medium.
    for (let i = 0; i < count; i++) expect(routes.some((r) => r.path.endsWith(`/x${i}`))).toBe(true)
    expect(routes.every((r) => r.confidence !== 'low')).toBe(true)
    expect(performance.now() - started).toBeLessThan(timeBudget(5_000))
  })

  it('resolves a chain of routers the same way whatever order its routes appear in', async () => {
    const lines = ["const express = require('express')", 'const app = express()']
    for (let i = 0; i < 4; i++) lines.push(`const r${i} = express.Router()`)
    lines.push("app.use('/api', r0)", "r0.use('/a', r1)", "r1.use('/b', r2)", "r2.use('/c', r3)", 'r3.use(r1)')
    const defs = ["r0.get('/x0', h)", "r1.get('/x1', h)", "r2.get('/x2', h)", "r3.get('/x3', h)"]
    const run = async (order: string[]) =>
      (
        await routesOf({
          'package.json': JSON.stringify({ dependencies: { express: '^5.1.0' } }),
          'app.js': [...lines, ...order].join('\n'),
        })
      ).routes.map((r) => `${r.method} ${r.path} ${r.confidence}`)
    const forward = await run(defs)
    expect(forward).toContain('GET /api/a/b/c/x3 high')
    expect(forward).toContain('GET /api/a/b/x2 high')
    expect(await run([...defs].reverse())).toEqual(forward)
  })

  it('stays fast when a Go file mounts its own functions many times', async () => {
    // Near the source size limit; resolving each route used to rescan every mount per mount (quadratic).
    const mounts = 'r.Mount("/x",s())\n'.repeat(28_000)
    const started = performance.now()
    const { routes } = await routesOf(
      {
        'go.mod': goMod('github.com/go-chi/chi/v5'),
        'main.go': [
          'package main',
          'import "github.com/go-chi/chi/v5"',
          'func s() chi.Router {',
          '\ts := chi.NewRouter()',
          '\ts.Get("/y", h)',
          '\treturn s',
          '}',
          'func main() {',
          '\tr := chi.NewRouter()',
          mounts,
          '}',
        ].join('\n'),
      },
      { maxFileSize: 1024 * 1024 },
    )
    expect(summary(routes)).toEqual(['GET /x/y'])
    expect(performance.now() - started).toBeLessThan(timeBudget(3_000))
  })
})
