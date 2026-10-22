import { describe, expect, it } from 'vitest'
import { parseYaml } from '../../src/core/parse.ts'
import {
  exactVersion,
  findLockfiles,
  lockedPackages,
  parseBunLock,
  parseComposerLock,
  parsePackageLock,
  parsePnpmKey,
  parsePnpmLock,
  parseYarnLock,
} from '../../src/facts/lockfiles.ts'
import { contextFor, makeProject } from '../helpers.ts'

const npm = (name: string, version: string) => ({ ecosystem: 'npm', name, version })

describe('exactVersion', () => {
  it.each([
    ['4.17.21', '4.17.21'],
    ['v1.2.3', '1.2.3'],
    ['1.0.0-beta.1', '1.0.0-beta.1'],
    ['^4.17.0', null],
    ['dev-main', null],
    ['git+https://github.com/a/b.git', null],
    ['file:../x', null],
    [42, null],
  ])('%j → %j', (raw, expected) => {
    expect(exactVersion(raw)).toBe(expected)
  })
})

describe('parsePackageLock', () => {
  it('reads lockfile versions 2 and 3, nested and scoped installs, without links', () => {
    const doc = {
      lockfileVersion: 3,
      packages: {
        '': { name: 'app', version: '1.0.0' },
        'node_modules/lodash': { version: '4.17.20' },
        'node_modules/@scope/pkg': { version: '2.0.0' },
        'node_modules/a/node_modules/lodash': { version: '3.10.1' },
        'node_modules/local': { resolved: 'packages/local', link: true },
        'packages/local': { name: 'local', version: '0.0.1' },
        'node_modules/git-dep': { version: 'git+ssh://git@github.com/a/b.git#abc' },
      },
    }
    expect(parsePackageLock(doc)).toEqual([
      npm('lodash', '4.17.20'),
      npm('@scope/pkg', '2.0.0'),
      npm('lodash', '3.10.1'),
      npm('local', '0.0.1'),
    ])
  })

  it('reads the nested tree of lockfile version 1', () => {
    const doc = {
      lockfileVersion: 1,
      dependencies: { a: { version: '1.0.0', dependencies: { b: { version: '2.0.0' } } } },
    }
    expect(parsePackageLock(doc)).toEqual([npm('a', '1.0.0'), npm('b', '2.0.0')])
  })
})

describe('pnpm-lock.yaml', () => {
  it.each([
    ['/lodash/4.17.21', { name: 'lodash', version: '4.17.21' }],
    ['/@scope/pkg/1.2.3_react@18.2.0', { name: '@scope/pkg', version: '1.2.3' }],
    ['/lodash@4.17.21', { name: 'lodash', version: '4.17.21' }],
    ['/@scope/pkg@1.2.3(react@18.2.0)', { name: '@scope/pkg', version: '1.2.3' }],
    ['lodash@4.17.21', { name: 'lodash', version: '4.17.21' }],
    ['@scope/pkg@1.2.3', { name: '@scope/pkg', version: '1.2.3' }],
    ['link:../x', null],
  ])('key %j', (key, expected) => {
    expect(parsePnpmKey(key)).toEqual(expected)
  })

  it('reads the packages map', () => {
    const doc = parseYaml(
      "lockfileVersion: '9.0'\npackages:\n  lodash@4.17.20:\n    resolution: {}\n  '@a/b@1.0.0':\n    resolution: {}\n",
    )
    expect(parsePnpmLock(doc)).toEqual([npm('lodash', '4.17.20'), npm('@a/b', '1.0.0')])
  })
})

describe('parseYarnLock', () => {
  it('reads the classic format, with several descriptors per entry', () => {
    const text = [
      '# yarn lockfile v1',
      '',
      'lodash@^4.17.0, lodash@^4.17.20:',
      '  version "4.17.20"',
      '  resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.20.tgz"',
      '',
      '"@scope/pkg@^1.0.0":',
      '  version "1.2.3"',
      '',
    ].join('\n')
    expect(parseYarnLock(text)).toEqual([npm('lodash', '4.17.20'), npm('@scope/pkg', '1.2.3')])
  })

  it('reads the Berry format and skips the workspace itself', () => {
    const text = [
      '__metadata:',
      '  version: 8',
      '',
      '"app@workspace:.":',
      '  version: 0.0.0-use.local',
      '',
      '"lodash@npm:^4.17.0":',
      '  version: 4.17.21',
      '  resolution: "lodash@npm:4.17.21"',
      '',
    ].join('\n')
    expect(parseYarnLock(text)).toEqual([npm('lodash', '4.17.21')])
  })
})

describe('parseBunLock', () => {
  it('reads the text lockfile, trailing commas included', () => {
    const text =
      '{\n  "lockfileVersion": 1,\n  "packages": {\n    "lodash": ["lodash@4.17.20", "", {}, "sha512-x"],\n    "@a/b": ["@a/b@1.0.0", "", {}, "sha512-y",],\n  },\n}\n'
    expect(parseBunLock(text)).toEqual([npm('lodash', '4.17.20'), npm('@a/b', '1.0.0')])
  })
})

describe('parseComposerLock', () => {
  it('reads packages and packages-dev, without branch versions', () => {
    const doc = {
      packages: [
        { name: 'laravel/framework', version: 'v10.0.0' },
        { name: 'acme/fork', version: 'dev-main' },
      ],
      'packages-dev': [{ name: 'phpunit/phpunit', version: '10.5.1' }],
    }
    expect(parseComposerLock(doc)).toEqual([
      { ecosystem: 'Packagist', name: 'laravel/framework', version: '10.0.0' },
      { ecosystem: 'Packagist', name: 'phpunit/phpunit', version: '10.5.1' },
    ])
  })
})

describe('lockedPackages', () => {
  it('finds the project lockfiles and go.mod requirements, deduplicated', async () => {
    expect(
      findLockfiles(['yarn.lock', 'apps/web/package-lock.json', 'a/b/c/yarn.lock', 'examples/x/yarn.lock']),
    ).toEqual(['apps/web/package-lock.json', 'yarn.lock'])
    const ctx = await contextFor(
      await makeProject({
        'package-lock.json': JSON.stringify({ packages: { 'node_modules/lodash': { version: '4.17.20' } } }),
        'apps/web/package-lock.json': JSON.stringify({ packages: { 'node_modules/lodash': { version: '4.17.20' } } }),
        'composer.lock': JSON.stringify({ packages: [{ name: 'a/b', version: '1.0.0' }] }),
        'go.mod': 'module acme/x\n\ngo 1.22\n\nrequire golang.org/x/net v0.7.0\n',
        'broken/yarn.lock': 'lodash@^4:\n  version "not a version"\n',
      }),
    )
    const found = await ctx.use(lockedPackages)
    expect(found.packages).toEqual([
      { ecosystem: 'Go', name: 'golang.org/x/net', version: '0.7.0', lockfiles: ['go.mod'] },
      { ecosystem: 'Packagist', name: 'a/b', version: '1.0.0', lockfiles: ['composer.lock'] },
      {
        ecosystem: 'npm',
        name: 'lodash',
        version: '4.17.20',
        lockfiles: ['apps/web/package-lock.json', 'package-lock.json'],
      },
    ])
  })

  it('skips a lockfile it cannot parse', async () => {
    const ctx = await contextFor(await makeProject({ 'package-lock.json': '{ nope', 'composer.lock': '[]' }))
    expect((await ctx.use(lockedPackages)).packages).toEqual([])
  })
})
