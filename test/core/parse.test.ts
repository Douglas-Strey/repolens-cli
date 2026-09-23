import { describe, expect, it } from 'vitest'
import {
  describeJsonError,
  getString,
  getStringMap,
  isRecord,
  ParseError,
  parseJson,
  parseJsonc,
  parseYaml,
  stripJsonComments,
  toStringArray,
} from '../../src/core/parse.ts'
import { SECRET_SENTINEL, timeBudget } from '../helpers.ts'

function parseErrorOf(fn: () => unknown): ParseError {
  try {
    fn()
  } catch (error) {
    if (error instanceof ParseError) return error
    throw new Error(`expected a ParseError, got ${String(error)}`)
  }
  throw new Error('expected a ParseError, but parsing succeeded')
}

describe('parseJsonc', () => {
  it('strips line and block comments and trailing commas', () => {
    const text = `{
      // line comment
      "compilerOptions": {
        /* block
           comment */
        "strict": true, // trailing
        "paths": { "@/*": ["./src/*",], },
      },
    }`
    expect(parseJsonc(text)).toEqual({ compilerOptions: { strict: true, paths: { '@/*': ['./src/*'] } } })
  })

  it('leaves comment markers and commas inside strings alone', () => {
    const text =
      '{"url": "https://example.com/a", "glob": "src/**/*.ts", "c": "/* not */", "t": "a,}", "e": "q\\"//x",}'
    expect(parseJsonc(text)).toEqual({
      url: 'https://example.com/a',
      glob: 'src/**/*.ts',
      c: '/* not */',
      t: 'a,}',
      e: 'q"//x',
    })
  })

  it('handles escaped backslashes before a closing quote', () => {
    expect(parseJsonc('{"path": "C:\\\\dir\\\\", // c\n "x": 1}')).toEqual({ path: 'C:\\dir\\', x: 1 })
  })

  it('handles an unterminated block comment and a BOM', () => {
    expect(() => parseJsonc('{"a": 1} /* never closed')).not.toThrow()
    expect(parseJsonc('\uFEFF{"a": 1}')).toEqual({ a: 1 })
  })

  it('keeps line numbers of the original text in the stripped output', () => {
    const original = '/* a\nb\nc */{\n"x": 1\n}'
    expect(stripJsonComments(original).split('\n')).toHaveLength(original.split('\n').length)
    const error = parseErrorOf(() => parseJsonc('/* a\n b */\n{\n  "a": 1\n  "b": 2\n}'))
    expect(error.message).toMatch(/line 5/)
  })

  it('throws ParseError for invalid or empty input', () => {
    expect(parseErrorOf(() => parseJsonc('{"a": }'))).toBeInstanceOf(ParseError)
    expect(parseErrorOf(() => parseJsonc('// only a comment'))).toBeInstanceOf(ParseError)
  })
})

describe('parseJson', () => {
  it('parses JSON with a BOM', () => {
    expect(parseJson('\uFEFF{"name": "x"}')).toEqual({ name: 'x' })
  })

  it('does not accept comments', () => {
    expect(() => parseJson('{"a": 1 // c\n}')).toThrow(ParseError)
  })

  it('keeps __proto__ as an own key without polluting prototypes', () => {
    const parsed = parseJson<Record<string, unknown>>('{"__proto__": {"polluted": true}}')
    expect(Object.keys(parsed)).toEqual(['__proto__'])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it.each([
    `{"password": ${SECRET_SENTINEL}}`,
    `{"password": "${SECRET_SENTINEL}" "x": 1}`,
    `{"a": "${SECRET_SENTINEL}",}`,
    `${SECRET_SENTINEL}`,
    `{"a": "${SECRET_SENTINEL}\u0001"}`,
    `{"a": "x"}${SECRET_SENTINEL}`,
    `{"key": "${SECRET_SENTINEL}`,
  ])('never quotes the source in error messages (%#)', (text) => {
    const error = parseErrorOf(() => parseJson(text))
    expect(error.message).not.toContain(SECRET_SENTINEL)
    expect(error.message).not.toContain('REPOLENS')
    expect(error.message.length).toBeGreaterThan(0)
  })
})

describe('describeJsonError', () => {
  it('keeps the error kind and location', () => {
    expect(
      describeJsonError("Expected ',' or '}' after property value in JSON at position 12 (line 2 column 3)", ''),
    ).toBe("Expected ',' or '}' after property value at line 2, column 3")
    expect(describeJsonError('Unterminated string in JSON at position 5', 'ab\ncdefg')).toBe(
      'Unterminated string at line 2',
    )
    expect(describeJsonError('Unexpected end of JSON input', '')).toBe('Unexpected end of JSON input')
  })

  it('locates quoted snippets without repeating them', () => {
    const text = '{\n  "a": 1,\n  "b": oops\n}'
    expect(describeJsonError(`Unexpected token 'o', ..."  "b": oops"... is not valid JSON`, text)).toBe(
      'Unexpected token near line 3',
    )
    expect(describeJsonError(`Unexpected token 'x', "zzz" is not valid JSON`, 'abc')).toBe('Unexpected token')
  })

  it('falls back to a generic message for unknown formats', () => {
    expect(describeJsonError(`something about ${SECRET_SENTINEL}`, '')).toBe('Invalid JSON')
  })
})

describe('parseYaml', () => {
  it('parses the first document of a multi-document stream', () => {
    expect(parseYaml('a: 1\n---\nb: 2\n')).toEqual({ a: 1 })
    expect(parseYaml('---\na: 1\n')).toEqual({ a: 1 })
  })

  it('returns null for empty documents', () => {
    expect(parseYaml('')).toBeNull()
    expect(parseYaml('# only a comment\n')).toBeNull()
  })

  it('supports merge keys', () => {
    const doc = parseYaml(
      'x-base: &base\n  image: node:22\n  restart: always\nservices:\n  api:\n    <<: *base\n    restart: "no"\n',
    )
    expect(doc).toEqual({
      'x-base': { image: 'node:22', restart: 'always' },
      services: { api: { image: 'node:22', restart: 'no' } },
    })
  })

  it('allows one anchor to be merged many times (Compose services, CI jobs)', () => {
    let text = 'x-common: &common\n  restart: always\n  env_file: .env\nservices:\n'
    for (let i = 0; i < 500; i++) text += `  s${i}:\n    <<: *common\n    image: app\n`
    const doc = parseYaml<{ services: Record<string, { restart: string }> }>(text)
    expect(Object.keys(doc.services)).toHaveLength(500)
    expect(doc.services.s499?.restart).toBe('always')
  })

  it('keeps "on" and "yes" as string keys (GitHub Actions)', () => {
    const doc = parseYaml<Record<string, unknown>>('on:\n  push:\n    branches: [main]\nyes: no\n')
    expect(Object.keys(doc)).toEqual(['on', 'yes'])
    expect(doc.yes).toBe('no')
  })

  it('tolerates duplicate keys (last wins)', () => {
    expect(parseYaml('a: 1\na: 2\n')).toEqual({ a: 2 })
  })

  it('resolves unknown tags to plain values instead of failing', () => {
    expect(parseYaml('Value: !Ref MyBucket\nList: !Split [",", "a,b"]\n')).toEqual({
      Value: 'MyBucket',
      List: [',', 'a,b'],
    })
  })

  it('does not let __proto__ keys change prototypes', () => {
    const doc = parseYaml<Record<string, unknown>>('__proto__:\n  polluted: true\nx: 1\n')
    expect(Object.keys(doc)).toEqual(['__proto__', 'x'])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(doc.polluted).toBeUndefined()
  })

  it('defuses a billion-laughs alias bomb quickly', () => {
    const lines = ['a: &a ["lol","lol","lol","lol","lol","lol","lol","lol","lol"]']
    const names = 'bcdefghij'
    for (let i = 0; i < names.length; i++) {
      const prev = i === 0 ? 'a' : names[i - 1]
      lines.push(`${names[i]}: &${names[i]} [${Array.from({ length: 9 }, () => `*${prev}`).join(',')}]`)
    }
    const started = performance.now()
    expect(() => parseYaml(lines.join('\n'))).toThrow(ParseError)
    expect(performance.now() - started).toBeLessThan(timeBudget(1000))
  })

  // yaml resolves each alias by walking the whole document: 50,000 aliases took minutes before.
  it('resolves many aliases in linear time', () => {
    const text = `a: &a [1, 2]\nb: [${Array.from({ length: 50_000 }, () => '*a').join(',')}]\n`
    const started = performance.now()
    const doc = parseYaml<{ b: number[][] }>(text)
    expect(performance.now() - started).toBeLessThan(timeBudget(2000))
    expect(doc.b).toHaveLength(50_000)
    expect(doc.b[49_999]).toEqual([1, 2])
  })

  it('rejects a long merge chain that expands quadratically, quickly', () => {
    const lines = ['k0: &k0 {a: 1}']
    for (let i = 1; i < 3000; i++) lines.push(`k${i}: &k${i} {<<: *k${i - 1}, b${i}: 1}`)
    const started = performance.now()
    expect(() => parseYaml(lines.join('\n'))).toThrow(/too many nodes/)
    expect(performance.now() - started).toBeLessThan(timeBudget(2000))
  })

  it('resolves aliases like yaml: latest anchor before the alias, merges, nested aliases', () => {
    expect(parseYaml('a: &x 1\nb: *x\nc: &x 2\nd: *x\n')).toEqual({ a: 1, b: 1, c: 2, d: 2 })
    expect(parseYaml('base: &b {a: 1, b: 2}\nx:\n  <<: *b\n  b: 3\ny:\n  b: 4\n  <<: *b\n')).toEqual({
      base: { a: 1, b: 2 },
      x: { a: 1, b: 3 },
      y: { b: 4, a: 1 },
    })
    expect(parseYaml('a: &a {k: 1, j: 1}\nb: &b {k: 2, m: 2}\nc:\n  <<: [*a, *b]\n')).toMatchObject({
      c: { k: 1, j: 1, m: 2 },
    })
    expect(parseYaml('a: &a [1]\nb: &b {x: *a}\nc: [*b, *b]\nk: &k name\n*k : v\n')).toEqual({
      a: [1],
      b: { x: [1] },
      c: [{ x: [1] }, { x: [1] }],
      k: 'name',
      name: 'v',
    })
  })

  it('rejects an alias to a missing anchor without quoting it', () => {
    const error = parseErrorOf(() => parseYaml(`a: *${SECRET_SENTINEL}\n`))
    expect(error.message).not.toContain(SECRET_SENTINEL)
  })

  it('rejects recursive aliases instead of returning circular objects', () => {
    expect(() => parseYaml('a: &a [1, *a]\n')).toThrow(/Recursive/)
    expect(() => parseYaml('a: &a\n  child: *a\n')).toThrow(/Recursive/)
  })

  it('rejects absurdly deep nesting with a ParseError', () => {
    expect(() => parseYaml(`${'['.repeat(5000)}${']'.repeat(5000)}`)).toThrow(ParseError)
  })

  it('throws ParseError for malformed YAML, with a position', () => {
    const error = parseErrorOf(() => parseYaml('services:\n  db:\n\timage: postgres\n'))
    expect(error.message).toMatch(/line \d+, column \d+/)
    expect(() => parseYaml('a: "unterminated\n')).toThrow(ParseError)
    expect(() => parseYaml('key: [1, 2\n')).toThrow(ParseError)
  })

  it.each([
    `a: *${SECRET_SENTINEL}\n`,
    `a: b\n]${SECRET_SENTINEL}\n`,
    `password: "${SECRET_SENTINEL}\n`,
    `a: ${SECRET_SENTINEL}: b\n`,
    `\t${SECRET_SENTINEL}: 1\n`,
    `a:\n  - b\n  c: ${SECRET_SENTINEL}\n`,
    `a: !${SECRET_SENTINEL}! value\n`,
    `%YAML 1.${SECRET_SENTINEL}\n---\na: 1\n`,
    `a: "\\${SECRET_SENTINEL}"\n`,
  ])('never quotes the source in error messages (%#)', (text) => {
    const error = parseErrorOf(() => parseYaml(text))
    expect(error.message).not.toContain(SECRET_SENTINEL)
  })
})

describe('narrowing helpers', () => {
  it('isRecord accepts only plain objects', () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord([])).toBe(false)
    expect(isRecord(null)).toBe(false)
    expect(isRecord('x')).toBe(false)
  })

  it('getString ignores non-strings', () => {
    expect(getString({ a: 'x', b: 1 }, 'a')).toBe('x')
    expect(getString({ b: 1 }, 'b')).toBeUndefined()
    expect(getString(null, 'a')).toBeUndefined()
  })

  it('getStringMap drops non-string values and never changes prototypes', () => {
    expect(getStringMap({ deps: { a: '1', b: 2, c: null } }, 'deps')).toEqual({ a: '1' })
    expect(getStringMap({ deps: ['a'] }, 'deps')).toEqual({})
    const map = getStringMap(parseJson('{"deps": {"__proto__": "x", "ok": "1"}}'), 'deps')
    expect(Object.getPrototypeOf(map)).toBe(Object.prototype)
    expect(map.ok).toBe('1')
  })

  it('toStringArray coerces strings and filters arrays', () => {
    expect(toStringArray('a')).toEqual(['a'])
    expect(toStringArray(['a', 1, 'b', null])).toEqual(['a', 'b'])
    expect(toStringArray({ a: 1 })).toEqual([])
    expect(toStringArray(undefined)).toEqual([])
  })
})
