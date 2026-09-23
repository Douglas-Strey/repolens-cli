import { describe, expect, it } from 'vitest'
import { isHandlerLike, parseJsFile, parseJsImports, typedNames } from '../../../src/detectors/routes/js.ts'
import { analyzeSource, argumentSpans } from '../../../src/detectors/routes/source.ts'

describe('typedNames', () => {
  it('finds names annotated with a type, qualified or optional', () => {
    const code = [
      'function a(app: Express, router?: express.Router) {}',
      'const r: IRouter = x',
      'type T = { srv: Application }',
      'const other: RouterOptions = {}',
      'const deep = Router.create',
    ].join('\n')
    expect([...typedNames(code, ['Router', 'IRouter', 'Express', 'Application'])].sort()).toEqual([
      'app',
      'r',
      'router',
      'srv',
    ])
  })

  it('skips annotations inside literals', () => {
    const src = analyzeSource("const doc = 'app: Hono'\nfunction f(api: Hono) {}", 'js')
    expect([...typedNames(src.code, ['Hono'], (offset) => src.inLiteral(offset))]).toEqual(['api'])
  })
})

describe('isHandlerLike', () => {
  it('accepts functions, identifiers, member expressions, calls and arrays only', () => {
    const text = "f(h, a.b, (req) => 1, wrap(h), [m, h], async function () {}, 'x', `y`, { a }, 5, null, -1, true)"
    const src = analyzeSource(text, 'js')
    const verdicts = (argumentSpans(src, 1) ?? []).map((span) => [
      src.code.slice(span.start, span.end),
      isHandlerLike(src, span),
    ])
    expect(Object.fromEntries(verdicts)).toEqual({
      h: true,
      'a.b': true,
      '(req) => 1': true,
      'wrap(h)': true,
      '[m, h]': true,
      'async function () {}': true,
      "'x'": false,
      '`y`': false,
      '{ a }': false,
      '5': false,
      null: false,
      '-1': false,
      true: false,
    })
  })
})

describe('parseJsFile', () => {
  it('ignores imports, requires and assignments that only appear in literals', () => {
    const js = parseJsFile(
      'a.ts',
      '.',
      [
        'const snippet = "import express from \'express\'; const app = express()"',
        "const real = require('./real')",
      ].join('\n'),
    )
    expect([...js.imports.specifiers]).toEqual(['./real'])
    expect(js.assignments.map((a) => a.name)).toEqual(['snippet', 'real'])
  })

  it('keeps the plain-string API of parseJsImports', () => {
    expect(parseJsImports("import { Hono } from 'hono'").locals.get('Hono')).toEqual({
      specifier: 'hono',
      imported: 'Hono',
    })
  })
})
