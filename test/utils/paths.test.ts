import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  baseName,
  depthOf,
  dirOf,
  extOf,
  isInDir,
  isWithin,
  joinPath,
  normalizeRelative,
  toPosix,
} from '../../src/utils/paths.ts'

describe('normalizeRelative', () => {
  it.each([
    ['a/b', 'a/b'],
    ['./a/b', 'a/b'],
    ['a/./b/', 'a/b'],
    ['a//b', 'a/b'],
    ['a/b/../c', 'a/c'],
    ['a\\b', 'a/b'],
    ['.', '.'],
    ['./', '.'],
    ['a/..', '.'],
    ['..foo', '..foo'],
    ['a/..b', 'a/..b'],
    ['  a/b  ', 'a/b'],
  ])('%j → %j', (input, expected) => {
    expect(normalizeRelative(input)).toBe(expected)
  })

  it.each([
    '',
    '  ',
    '..',
    '../x',
    'a/../../x',
    '..\\x',
    '/etc/passwd',
    '\\etc\\passwd',
    'C:\\Windows',
    'c:/x',
    'C:x',
    '\\\\server\\share',
  ])('%j is refused', (input) => {
    expect(normalizeRelative(input)).toBeNull()
  })
})

describe('isWithin', () => {
  const root = path.resolve('/tmp/project')
  it.each([
    [root, true],
    [path.join(root, 'a'), true],
    [path.join(root, 'a', 'b'), true],
    [path.join(root, '..foo'), true],
    [path.join(root, '...'), true],
    [path.resolve(root, '..'), false],
    [path.resolve(root, '..', 'other'), false],
    [path.resolve(`${root}-sibling`), false],
    [path.resolve('/'), false],
  ])('%s → %s', (child, expected) => {
    expect(isWithin(root, child)).toBe(expected)
  })
})

describe('path helpers', () => {
  it('toPosix converts separators', () => {
    expect(toPosix('a\\b\\c')).toBe('a/b/c')
  })

  it('joinPath collapses the root marker', () => {
    expect(joinPath('.', 'package.json')).toBe('package.json')
    expect(joinPath('apps/web', 'package.json')).toBe('apps/web/package.json')
    expect(joinPath('.', '')).toBe('.')
    expect(joinPath()).toBe('.')
    expect(joinPath('a', '..')).toBe('.')
  })

  it('dirOf / baseName / extOf / depthOf', () => {
    expect(dirOf('package.json')).toBe('.')
    expect(dirOf('apps/web/package.json')).toBe('apps/web')
    expect(baseName('apps/web/package.json')).toBe('package.json')
    expect(extOf('src/App.TSX')).toBe('.tsx')
    expect(extOf('Makefile')).toBe('')
    expect(extOf('.env')).toBe('')
    expect(depthOf('a.txt')).toBe(0)
    expect(depthOf('a/b/c.txt')).toBe(2)
  })

  it('isInDir respects segment boundaries', () => {
    expect(isInDir('apps/web/x.ts', 'apps/web')).toBe(true)
    expect(isInDir('apps/web', 'apps/web')).toBe(true)
    expect(isInDir('apps/web2/x.ts', 'apps/web')).toBe(false)
    expect(isInDir('anything', '.')).toBe(true)
    expect(isInDir('anything', '')).toBe(true)
  })
})
