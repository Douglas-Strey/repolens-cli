import { describe, expect, it } from 'vitest'
import { cleanVersion, majorOf } from '../../src/utils/versions.ts'

describe('cleanVersion', () => {
  it.each([
    ['^4.1.2', '4.1.2'],
    ['~1.2.3', '1.2.3'],
    ['=1.2.3', '1.2.3'],
    ['1.2.3', '1.2.3'],
    ['22', '22'],
    ['1.2', '1.2'],
    ['v1.11.0', '1.11.0'],
    ['  ^5.0.0  ', '5.0.0'],
    ['^1.0.0-beta.2', '1.0.0-beta.2'],
    ['v2.0.0+incompatible', '2.0.0+incompatible'],
    ['v0.0.0-20200823014737-9f7001d12a5f', '0.0.0-20200823014737-9f7001d12a5f'],
    ['>=18 <23', '>=18 <23'],
    ['>=1.0.0', '>=1.0.0'],
    ['^1.0.0 || ^2.0.0', '^1.0.0 || ^2.0.0'],
    ['1.2.3 - 2.0.0', '1.2.3 - 2.0.0'],
    ['1.x', '1.x'],
    ['npm:react@^18.2.0', '18.2.0'],
    ['npm:@scope/pkg@~1.4.0', '1.4.0'],
  ])('%j → %j', (input, expected) => {
    expect(cleanVersion(input)).toBe(expected)
  })

  it.each([
    undefined,
    '',
    '   ',
    '*',
    'x',
    'X',
    'latest',
    'next',
    'beta',
    'workspace:*',
    'workspace:^',
    'catalog:',
    'catalog:react18',
    'file:../pkg',
    'link:../pkg',
    'portal:../pkg',
    'patch:pkg@1.0.0#./p.patch',
    'git+https://github.com/org/repo.git#v1.0.0',
    'git://github.com/org/repo.git',
    'github:org/repo#v1.2.3',
    'org/repo',
    'https://example.com/pkg-1.0.0.tgz',
    'http://user:pw@example.com/pkg-1.0.0.tgz',
    'jsr:@std/path@1',
    '1.0.0 @evil',
    '1.0.0/../x',
    `^1.0.0 ${'1'.repeat(200)}`,
  ])('%j is not a displayable version', (input) => {
    expect(cleanVersion(input)).toBeUndefined()
  })
})

describe('majorOf', () => {
  it.each([
    ['^22.1.0', 22],
    ['>=1.25', 1],
    ['v18', 18],
    ['22', 22],
    ['1.x', 1],
    ['node:22-alpine', 22],
  ])('%j → %d', (input, expected) => {
    expect(majorOf(input)).toBe(expected)
  })

  it.each([undefined, null, '', 'lts/*', 'latest'])('%j → null', (input) => {
    expect(majorOf(input)).toBeNull()
  })
})
