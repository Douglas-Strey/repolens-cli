import { describe, expect, it } from 'vitest'
import {
  analyzeSource,
  argumentSpans,
  calleeBefore,
  jsFunctionAt,
  methodBefore,
  readStringLiteral,
  receiverBefore,
  skipTypeArguments,
} from '../../../src/detectors/routes/source.ts'
import { timeBudget } from '../../helpers.ts'

describe('analyzeSource', () => {
  it('blanks comments but keeps offsets and line breaks', () => {
    const text = "a() // app.get('/x')\n/* app.post('/y')\n */ b()"
    const { code } = analyzeSource(text, 'js')
    expect(code).toHaveLength(text.length)
    expect(code).not.toContain("app.get('/x')")
    expect(code).not.toContain("app.post('/y')")
    expect(code.split('\n')).toHaveLength(3)
    expect(code).toContain('b()')
  })

  it('does not treat // inside strings as comments', () => {
    const { code } = analyzeSource("const u = 'http://x'; app.get('/a', h)", 'js')
    expect(code).toContain("app.get('/a', h)")
  })

  it('skips regex literals containing comment-like sequences', () => {
    const text = "const s = p.replace(/\\/*$/, '')\napp.get('/a', h)\n// */"
    const { code } = analyzeSource(text, 'js')
    expect(code).toContain("app.get('/a', h)")
  })

  it('treats a slash after an expression as division', () => {
    const src = analyzeSource('const x = (a + b) / 2; f(1, 2)', 'js')
    const open = src.code.indexOf('f(') + 1
    expect(argumentSpans(src, open)).toHaveLength(2)
  })

  it('matches brackets across template literal expressions', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test
    const text = 'f(`a ${g(1, 2)} b`, 3)'
    const src = analyzeSource(text, 'js')
    expect(src.closeOf.get(1)).toBe(text.length - 1)
    expect(argumentSpans(src, 1)).toHaveLength(2)
  })

  it('handles Go raw strings and comments', () => {
    const text = 'r.GET(`/raw`, h) // r.GET("/c", h)\n/* r.POST("/d", h) */'
    const { code } = analyzeSource(text, 'go')
    expect(code).toContain('r.GET(`/raw`, h)')
    expect(code).not.toContain('/c')
    expect(code).not.toContain('/d')
  })

  it('reports 1-based line numbers', () => {
    const src = analyzeSource('a\nbb\nccc', 'js')
    expect(src.lineAt(0)).toBe(1)
    expect(src.lineAt(2)).toBe(2)
    expect(src.lineAt(5)).toBe(3)
  })

  it('survives unbalanced and unterminated input', () => {
    for (const text of ['f(((', ')))', "'unterminated", '`${', '/* never closed', 'a / b / c', "<p>Don't</p>"]) {
      expect(() => analyzeSource(text, 'js')).not.toThrow()
      expect(() => analyzeSource(text, 'go')).not.toThrow()
    }
  })

  it('knows which offsets are inside literals', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test
    const text = "a('x.get') + `t ${b.get(1)} u` + /r.get/ + c.get"
    const src = analyzeSource(text, 'js')
    const at = (needle: string, from = 0) => text.indexOf(needle, from)
    expect(src.inLiteral(at('x.get'))).toBe(true)
    expect(src.inLiteral(at('a('))).toBe(false)
    expect(src.inLiteral(at('t $'))).toBe(true)
    expect(src.inLiteral(at('b.get'))).toBe(false) // template expressions are code
    expect(src.inLiteral(at(' u`'))).toBe(true)
    expect(src.inLiteral(at('r.get'))).toBe(true)
    expect(src.inLiteral(at('c.get'))).toBe(false)
    const go = analyzeSource('x := `raw.GET` + "s.GET" + y.GET', 'go')
    expect(go.inLiteral(go.code.indexOf('raw'))).toBe(true)
    expect(go.inLiteral(go.code.indexOf('s.GET'))).toBe(true)
    expect(go.inLiteral(go.code.indexOf('y.GET'))).toBe(false)
  })

  it('does not rescan long lines for regex literals', () => {
    const text = '= /['.repeat(100_000)
    const started = performance.now()
    analyzeSource(text, 'js')
    expect(performance.now() - started).toBeLessThan(timeBudget(2000))
  })

  it('stays fast on large pathological input', () => {
    const text = `${'('.repeat(50_000)}${"'".repeat(50_000)}${'/'.repeat(50_000)}`
    const started = performance.now()
    analyzeSource(text, 'js')
    expect(performance.now() - started).toBeLessThan(timeBudget(2000))
  })
})

describe('literals and arguments', () => {
  it('reads string literals', () => {
    expect(readStringLiteral("'/a\\'b'", 0, 'js')).toEqual({ value: "/a'b", end: 7, dynamic: false })
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test
    expect(readStringLiteral('`/users/${id}`', 0, 'js')).toMatchObject({ dynamic: true })
    expect(readStringLiteral('`/plain`', 0, 'js')).toMatchObject({ value: '/plain', dynamic: false })
    expect(readStringLiteral('`/raw\\n`', 0, 'go')).toMatchObject({ value: '/raw\\n' })
    expect(readStringLiteral("'broken\n'", 0, 'js')).toBeNull()
    expect(readStringLiteral('x', 0, 'js')).toBeNull()
  })

  it('splits top-level arguments', () => {
    const text = "app.get('/a', [m1, m2], (req, res) => res.json({ a: 1, b: 2 }))"
    const src = analyzeSource(text, 'js')
    const spans = argumentSpans(src, text.indexOf('('))
    expect(spans?.map((span) => text.slice(span.start, span.end))).toEqual([
      "'/a'",
      '[m1, m2]',
      '(req, res) => res.json({ a: 1, b: 2 })',
    ])
  })

  it('skips type arguments only before a call', () => {
    const text = 'f<{ Body: { a: string; b: number } }>(x)'
    expect(skipTypeArguments(text, 1)).toBe(text.indexOf('('))
    expect(skipTypeArguments('a < b > c', 2)).toBe(-1)
    expect(skipTypeArguments('abc', 1)).toBe(1)
  })

  it('reads receivers and callees backwards', () => {
    const code = 'this.app.get(x); s.router.HandleFunc(y); new Hono<Env>().get(z)'
    expect(receiverBefore(code, code.indexOf('.get'), false)).toMatchObject({ kind: 'name', name: 'app' })
    expect(receiverBefore(code, code.indexOf('.HandleFunc'), true)).toMatchObject({ kind: 'name', name: 's.router' })
    const chained = code.lastIndexOf('.get')
    const token = receiverBefore(code, chained, false)
    expect(token.kind).toBe('call')
    const src = analyzeSource(code, 'js')
    const open = token.kind === 'call' ? src.openOf.get(token.close) : undefined
    expect(open === undefined ? null : calleeBefore(code, open)).toEqual({
      callee: 'Hono',
      isNew: true,
      start: code.indexOf('new Hono'),
    })
  })

  it('reads method names before a call, skipping type arguments and line breaks', () => {
    const code = 'app\n  .disable("x")\n  .withTypeProvider<Zod<A>>()\nexpress()'
    expect(methodBefore(code, code.indexOf('("x")'))).toEqual({ name: 'disable', dot: code.indexOf('.disable') })
    expect(methodBefore(code, code.indexOf('()'))).toEqual({
      name: 'withTypeProvider',
      dot: code.indexOf('.withTypeProvider'),
    })
    expect(methodBefore(code, code.lastIndexOf('('))).toBeNull()
  })

  it('parses function literals', () => {
    const text = 'async (instance, opts) => { instance.get() }'
    const src = analyzeSource(text, 'js')
    const fn = jsFunctionAt(src, { start: 0, end: text.length })
    expect(fn?.param).toBe('instance')
    expect(text.slice(fn?.body.start, fn?.body.end)).toBe('{ instance.get() }')
  })
})
