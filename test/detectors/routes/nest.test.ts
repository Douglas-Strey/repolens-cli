import { describe, expect, it } from 'vitest'
import { extractNestFacts } from '../../../src/detectors/routes/nest.ts'
import { find, fixtureRoutes, routesOf, summary } from './helpers.ts'

const NEST = JSON.stringify({ dependencies: { '@nestjs/common': '^11.1.6', '@nestjs/core': '^11.1.6' } })

describe('extractNestFacts', () => {
  it('joins controller and method paths in order', () => {
    const facts = extractNestFacts(
      [
        "import { Controller, Get, Post, All, Sse } from '@nestjs/common'",
        "@Get('orphan')", // before any controller: ignored
        'function x() {}',
        "@Controller({ path: 'cats', version: '1' })",
        'export class CatsController {',
        '  @Get() list() {}',
        "  @Post(['a', 'b']) create() {}",
        '  @Get(PATH) dynamic() {}',
        "  // @Get('commented')",
        '}',
        '@Controller()',
        'export class RootController {',
        "  @All('*') any() {}",
        "  @Sse('events') events() {}",
        '}',
      ].join('\n'),
    )
    expect(facts.routes).toEqual([
      { method: 'GET', path: '/cats', line: 6 },
      { method: 'POST', path: '/cats/a', line: 7 },
      { method: 'POST', path: '/cats/b', line: 7 },
      { method: 'ANY', path: '/*', line: 13 },
      { method: 'GET', path: '/events', line: 14, note: 'server-sent events' },
    ])
  })

  it('keeps notes for optional parameters', () => {
    const facts = extractNestFacts(
      "import { Controller, Get } from '@nestjs/common'\n@Controller('users')\nclass U { @Get(':id?') one() {} }",
    )
    expect(facts.routes).toEqual([{ method: 'GET', path: '/users/:id', line: 3, note: 'optional parameter' }])
  })

  it('reads the global prefix and its exclusions', () => {
    const facts = extractNestFacts(
      "app.setGlobalPrefix('api', { exclude: ['health', { path: 'metrics', method: RequestMethod.GET }] })",
    )
    expect(facts.globalPrefix).toEqual({ prefix: 'api', exclude: ['/health', '/metrics'] })
  })

  it('needs @nestjs/common decorators', () => {
    expect(extractNestFacts("@Controller('x')\nclass A { @Get() a() {} }").routes).toEqual([])
  })
})

describe('NestJS routes', () => {
  it('extracts the nest-api fixture', async () => {
    const { routes } = await fixtureRoutes('nest-api')
    expect(routes.map((r) => `${r.method} ${r.path} ${r.file}:${r.line}`)).toEqual([
      'GET /health src/health/health.controller.ts:5',
      'GET /users src/users/users.controller.ts:9',
      'POST /users src/users/users.controller.ts:19',
      'GET /users/:id src/users/users.controller.ts:14',
      'PATCH /users/:id src/users/users.controller.ts:24',
      'DELETE /users/:id src/users/users.controller.ts:29',
    ])
    expect(routes.every((r) => r.framework === 'nestjs' && r.confidence === 'high')).toBe(true)
    // test/app.e2e-spec.ts calls request(app).get('/health') and must not add anything.
    expect(routes.some((r) => r.file.startsWith('test/'))).toBe(false)
  })

  it('applies the package-wide global prefix except for excluded routes', async () => {
    const { routes } = await routesOf({
      'package.json': NEST,
      'src/main.ts':
        "const app = await NestFactory.create(AppModule)\napp.setGlobalPrefix('api/v1', { exclude: ['health'] })\n",
      'src/users.controller.ts':
        "import { Controller, Get, Delete } from '@nestjs/common'\n@Controller('users')\nexport class U {\n  @Get(':id') one() {}\n  @Delete(':id') remove() {}\n}\n",
      'src/health.controller.ts':
        "import { Controller, Get } from '@nestjs/common'\n@Controller()\nexport class H {\n  @Get('health') check() {}\n}\n",
    })
    expect(summary(routes)).toEqual(['GET /api/v1/users/:id', 'DELETE /api/v1/users/:id', 'GET /health'])
  })

  it('downgrades confidence when RouterModule may add prefixes', async () => {
    const { routes } = await routesOf({
      'package.json': NEST,
      'src/app.module.ts': "RouterModule.register([{ path: 'admin', module: AdminModule }])\n",
      'src/admin.controller.ts':
        "import { Controller, Get } from '@nestjs/common'\n@Controller('stats')\nexport class A {\n  @Get() stats() {}\n}\n",
    })
    expect(find(routes, 'GET', '/stats')).toMatchObject({
      confidence: 'medium',
      note: 'RouterModule or versioning may add a prefix',
    })
  })
})
