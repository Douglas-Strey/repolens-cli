import { describe, expect, it } from 'vitest'
import { expandBraces, globToRegExp, matchGlob, matchPatterns } from '../../src/utils/glob.ts'
import { timeBudget } from '../helpers.ts'

describe('matchGlob', () => {
  it.each([
    ['*.ts', 'index.ts', true],
    ['*.ts', 'src/index.ts', false],
    ['*', '.env', true],
    ['*', 'a/b', false],
    ['src/*', 'src/a', true],
    ['src/*', 'src/a/b', false],
    ['**/*.ts', 'index.ts', true],
    ['**/*.ts', 'a/b/c/index.ts', true],
    ['**/*.ts', 'a/b/c/index.js', false],
    ['src/**/*.ts', 'src/index.ts', true],
    ['src/**/*.ts', 'src/a/b/index.ts', true],
    ['src/**/*.ts', 'lib/index.ts', false],
    ['apps/**', 'apps/web', true],
    ['apps/**', 'apps/web/src/x.ts', true],
    ['apps/**', 'apps', false],
    ['**', 'anything/at/all', true],
    ['a/**/b', 'a/b', true],
    ['a/**/b', 'a/x/y/b', true],
    ['a/**/b', 'a/x/y/c', false],
    ['a/**/b/**/c', 'a/b/c', true],
    ['a/**/b/**/c', 'a/x/b/y/b/z/c', true],
    ['a/**/**/b', 'a/b', true],
    ['?.js', 'a.js', true],
    ['?.js', 'ab.js', false],
    ['?.js', '/.js', false],
    ['file.?s', 'file.ts', true],
    ['{a,b}.ts', 'b.ts', true],
    ['{a,b}.ts', 'c.ts', false],
    ['*.{js,mjs,cjs}', 'x.mjs', true],
    ['{src,lib}/**/*.{ts,tsx}', 'lib/a/b.tsx', true],
    ['{a,{b,c}}x', 'cx', true],
    ['x{,.min}.js', 'x.js', true],
    ['x{,.min}.js', 'x.min.js', true],
    ['{a/b,c}/d', 'a/b/d', true],
    ['.devcontainer/**/{Dockerfile,Dockerfile.*,*.Dockerfile}', '.devcontainer/a/app.Dockerfile', true],
    ['a{b', 'a{b', true],
    ['a}b', 'a}b', true],
    ['{a}', 'a', true],
    ['./src/*.ts', 'src/a.ts', true],
    ['src/', 'src', true],
    ['packages/*/', 'packages/ui', true],
    ['app/[id]/page.tsx', 'app/[id]/page.tsx', true],
    ['app/[id]/page.tsx', 'app/i/page.tsx', false],
    ['a.b', 'axb', false],
    ['a+b', 'a+b', true],
    ['(x)|$', '(x)|$', true],
    ['*a*b', 'xaxb', true],
    ['*a*b', 'xbxa', false],
    ['*ab*b', 'ab', false],
    ['*a*a', 'aa', true],
    ['a**b', 'axxb', true],
    ['a**b', 'a/b', false],
    ['**/cmd/*/*.go', 'cmd/api/main.go', true],
    ['**/cmd/*/*.go', 'services/x/cmd/api/main.go', true],
    ['', '', true],
  ])('%j matches %j: %s', (pattern, path, expected) => {
    expect(matchGlob(pattern, path)).toBe(expected)
  })

  it('caches compiled patterns', () => {
    expect(globToRegExp('**/*.cache-test')).toBe(globToRegExp('**/*.cache-test'))
  })

  it('refuses patterns that are too long or expand too far', () => {
    expect(matchGlob(`${'a'.repeat(1100)}*`, 'a'.repeat(1100))).toBe(false)
    expect(matchGlob('{a,b}'.repeat(9), 'a'.repeat(9))).toBe(false)
    expect(matchGlob('{a,b}'.repeat(8), 'a'.repeat(8))).toBe(true)
    // 64 alternatives of ~200 characters: over the expanded-length budget.
    const long = `${'{a,b}'.repeat(6)}${'x'.repeat(200)}`
    expect(expandBraces(long)).toBeNull()
    expect(matchGlob(long, `${'a'.repeat(6)}${'x'.repeat(200)}`)).toBe(false)
    expect(expandBraces(`${'{a,b}'.repeat(5)}${'x'.repeat(200)}`)).toHaveLength(32)
  })

  it('stays fast and small on many large brace patterns', () => {
    const patterns = Array.from({ length: 200 }, (_, i) => `${'{a,b}'.repeat(10)}${'x'.repeat(900)}${i}`)
    const started = performance.now()
    expect(matchPatterns(patterns, 'packages/foo')).toBe(false)
    expect(performance.now() - started).toBeLessThan(timeBudget(1000))
  })
})

describe('glob safety on hostile patterns', () => {
  it.each([
    ['*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*b', 'a'.repeat(250)],
    [`${Array.from({ length: 20 }, () => '**/a').join('/')}/b`, Array.from({ length: 60 }, () => 'a').join('/')],
    [
      `${Array.from({ length: 40 }, () => '**/*a*a*a').join('/')}/b`,
      Array.from({ length: 100 }, () => 'aaaaaaaa').join('/'),
    ],
    ['{*a*a*a*a*b,*a*a*a*a*c}', 'a'.repeat(200)],
  ])('matches %j in linear time', (pattern, path) => {
    const started = performance.now()
    expect(matchGlob(pattern, path)).toBe(false)
    expect(performance.now() - started).toBeLessThan(timeBudget(200))
  })
})

/** Straightforward (exponential) reference implementation of the same semantics. */
function reference(pattern: string, path: string): boolean {
  const cleaned = pattern.replace(/^(?:\.\/)+/, '').replace(/\/+$/, '')
  const alternatives = expandBraces(cleaned)
  if (!alternatives) return false
  const pathSegments = path.split('/')
  const matchSegment = (glob: string, text: string): boolean => {
    if (glob === '') return text === ''
    const [head] = glob
    if (head === '*') {
      const rest = glob.replace(/^\*+/, '')
      for (let i = 0; i <= text.length; i++) if (matchSegment(rest, text.slice(i))) return true
      return false
    }
    if (text === '') return false
    return (head === '?' || head === text[0]) && matchSegment(glob.slice(1), text.slice(1))
  }
  const matchSegments = (globs: string[], texts: string[]): boolean => {
    if (globs.length === 0) return texts.length === 0
    const [head, ...rest] = globs as [string, ...string[]]
    if (head === '**') {
      if (rest.length === 0) return texts.length > 0
      for (let i = 0; i <= texts.length; i++) if (matchSegments(rest, texts.slice(i))) return true
      return false
    }
    return texts.length > 0 && matchSegment(head, texts[0] as string) && matchSegments(rest, texts.slice(1))
  }
  return alternatives.some((alternative) => matchSegments(alternative.split('/'), pathSegments))
}

describe('globToRegExp agrees with a reference matcher', () => {
  it('on random patterns and paths', () => {
    let seed = 42
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % n
    }
    const segmentAtoms = ['a', 'b', 'ab', '*', '?', '.', 'a*', '*b']
    const randomSegment = () => Array.from({ length: 1 + random(3) }, () => segmentAtoms[random(8)]).join('')
    const randomPattern = () =>
      Array.from({ length: 1 + random(4) }, () => (random(4) === 0 ? '**' : randomSegment())).join('/')
    const randomPath = () =>
      Array.from({ length: 1 + random(4) }, () =>
        Array.from({ length: 1 + random(4) }, () => ['a', 'b', '.'][random(3)]).join(''),
      ).join('/')
    for (let i = 0; i < 3000; i++) {
      const pattern = randomPattern()
      const path = randomPath()
      expect(matchGlob(pattern, path), `${pattern} vs ${path}`).toBe(reference(pattern, path))
    }
  })
})

describe('expandBraces', () => {
  it('expands nested and sequential alternatives in order', () => {
    expect(expandBraces('a{b,c}d{e,f}')).toEqual(['abde', 'abdf', 'acde', 'acdf'])
    expect(expandBraces('{a,{b,c}}')).toEqual(['a', 'b', 'c'])
    expect(expandBraces('no-braces')).toEqual(['no-braces'])
    expect(expandBraces('x{')).toEqual(['x{'])
  })

  it('returns null past the limit', () => {
    expect(expandBraces('{a,b}{a,b}{a,b}', 7)).toBeNull()
    expect(expandBraces('{a,b}{a,b}{a,b}', 8)).toHaveLength(8)
  })
})

describe('matchPatterns', () => {
  it('lets later patterns win, with ! negating', () => {
    const patterns = ['packages/*', '!packages/internal', 'apps/**']
    expect(matchPatterns(patterns, 'packages/ui')).toBe(true)
    expect(matchPatterns(patterns, 'packages/internal')).toBe(false)
    expect(matchPatterns(patterns, 'apps/web/nested')).toBe(true)
    expect(matchPatterns(patterns, 'tools/x')).toBe(false)
    expect(matchPatterns(['!packages/a', 'packages/*'], 'packages/a')).toBe(true)
    expect(matchPatterns(['./packages/*', '!./packages/b/'], 'packages/b')).toBe(false)
    expect(matchPatterns([], 'x')).toBe(false)
  })
})
