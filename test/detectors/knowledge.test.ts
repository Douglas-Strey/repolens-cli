import { describe, expect, it } from 'vitest'
import { parseInvocations, splitCommand } from '../../src/detectors/knowledge/commands.ts'
import { createLayout, goModuleOf, locateFiles } from '../../src/detectors/knowledge/layout.ts'
import {
  hasTable,
  normalizePythonName,
  parsePythonToml,
  parseRequirement,
  parseRequirementsTxt,
  tableHeader,
} from '../../src/detectors/knowledge/python.ts'
import {
  comparePackageDirs,
  dependencyEvidence,
  displayRange,
  displayScriptName,
  displayVersion,
  MAX_EVIDENCE,
  mergeSignals,
  type Signal,
} from '../../src/detectors/knowledge/signals.ts'
import {
  configArgument,
  detectTool,
  sortTools,
  type ToolFacts,
  type ToolSpec,
} from '../../src/detectors/knowledge/tools.ts'
import { createDependencyIndex, type DependencyRef } from '../../src/facts/dependencies.ts'
import type { Tool } from '../../src/types.ts'
import { timeBudget } from '../helpers.ts'

function ref(overrides: Partial<DependencyRef> & Pick<DependencyRef, 'name'>): DependencyRef {
  return {
    range: '^1.0.0',
    type: 'dependencies',
    package: '.',
    file: 'package.json',
    ecosystem: 'node',
    ...overrides,
  }
}

describe('splitCommand / parseInvocations', () => {
  it('splits on shell operators and keeps quoted arguments together', () => {
    expect(splitCommand('rimraf dist && tsc -p "tsconfig build.json"; echo done | cat')).toEqual([
      ['rimraf', 'dist'],
      ['tsc', '-p', 'tsconfig build.json'],
      ['echo', 'done'],
      ['cat'],
    ])
  })

  it('does not split on operators inside quotes', () => {
    expect(splitCommand(`eslint "src/**/*.ts" --rule 'a && b'`)).toEqual([
      ['eslint', 'src/**/*.ts', '--rule', 'a && b'],
    ])
  })

  it('skips env assignments and runner wrappers', () => {
    const bins = (command: string) => parseInvocations(command).map((i) => i.bin)
    expect(bins('NODE_ENV=test FOO=1 node --test')).toEqual(['node'])
    expect(bins('npx --yes tsc -b')).toEqual(['tsc'])
    expect(bins('cross-env NODE_ENV=production webpack --mode production')).toEqual(['webpack'])
    expect(bins('pnpm exec vitest run')).toEqual(['vitest'])
    expect(bins('npm exec -- jest')).toEqual(['jest'])
    expect(bins('yarn dlx tsc')).toEqual(['tsc'])
    expect(bins('bunx tsc')).toEqual(['tsc'])
    expect(bins('c8 --reporter=lcov node --test')).toEqual(['node'])
    expect(bins('dotenv -e .env.test -- jest')).toEqual(['jest'])
    expect(bins('./node_modules/.bin/tsc -p .')).toEqual(['tsc'])
  })

  it('treats `pnpm run x` as a script run, not a binary', () => {
    expect(parseInvocations('pnpm run build')).toEqual([{ bin: 'pnpm', args: ['run', 'build'] }])
    expect(parseInvocations('bun test')).toEqual([{ bin: 'bun', args: ['test'] }])
  })

  it('handles empty and degenerate commands', () => {
    expect(parseInvocations('')).toEqual([])
    expect(parseInvocations('&& ; |')).toEqual([])
    expect(parseInvocations('FOO=bar')).toEqual([])
    expect(parseInvocations('dotenv -e .env')).toEqual([])
    expect(parseInvocations('"unterminated quote')).toEqual([{ bin: 'unterminated quote', args: [] }])
  })
})

describe('mergeSignals', () => {
  it('returns null without signals', () => {
    expect(mergeSignals([])).toBeNull()
  })

  it('takes the strongest confidence and its version, and lists strong evidence first', () => {
    const signals: Signal[] = [
      { package: 'packages/ui', confidence: 'low', evidence: 'peer', version: '3.0.0' },
      { package: 'apps/web', confidence: 'high', evidence: 'prod', version: '3.5.22' },
      { package: '.', confidence: 'medium', evidence: 'config', configFile: 'b.config.ts' },
      { package: 'apps/web', confidence: 'high', evidence: 'prod' },
      { package: '.', confidence: 'medium', evidence: 'config 2', configFile: 'a.config.ts' },
    ]
    expect(mergeSignals(signals)).toEqual({
      packages: ['.', 'apps/web', 'packages/ui'],
      confidence: 'high',
      version: '3.5.22',
      evidence: ['prod', 'config', 'config 2', 'peer'],
      configFiles: ['a.config.ts', 'b.config.ts'],
    })
  })

  it('caps long evidence lists', () => {
    const signals: Signal[] = Array.from({ length: 10 }, (_, i) => ({
      package: `packages/p${i}`,
      confidence: 'high',
      evidence: `evidence ${i}`,
    }))
    const merged = mergeSignals(signals)
    expect(merged?.evidence).toHaveLength(MAX_EVIDENCE)
    expect(merged?.evidence.at(-1)).toBe(`and ${10 - MAX_EVIDENCE + 1} more`)
    expect(merged?.packages).toHaveLength(10)
  })

  it('sorts package directories with the root first', () => {
    expect(['b', '.', '-x', 'a/b', 'a'].sort(comparePackageDirs)).toEqual(['.', '-x', 'a', 'a/b', 'b'])
  })
})

describe('display helpers', () => {
  it('keeps plain ranges and drops URLs, paths and credentials', () => {
    expect(displayRange('^4.1.2')).toBe('^4.1.2')
    expect(displayRange('>=18 <23')).toBe('>=18 <23')
    expect(displayRange('catalog:')).toBe('catalog:')
    expect(displayRange('workspace:*')).toBe('workspace:*')
    expect(displayRange('git+https://user:hunter2@github.com/acme/react.git')).toBeUndefined()
    expect(displayRange('https://registry.example.com/react-1.0.0.tgz?token=abc')).toBeUndefined()
    expect(displayRange('file:../react')).toBeUndefined()
    expect(displayRange('npm:react@18')).toBeUndefined()
    const token = `ghp_${'a'.repeat(36)}`
    expect(displayRange(token)).toBeUndefined()
  })

  it('cleans versions and rejects non-versions', () => {
    expect(displayVersion('^4.1.2')).toBe('4.1.2')
    expect(displayVersion('v1.11.0')).toBe('1.11.0')
    expect(displayVersion('==8.4.2')).toBe('8.4.2')
    expect(displayVersion('workspace:*')).toBeUndefined()
    expect(displayVersion('./vendor/react-1.0.0.tgz')).toBeUndefined()
    expect(displayVersion(undefined)).toBeUndefined()
  })

  it('formats dependency evidence by declaration type', () => {
    expect(dependencyEvidence(ref({ name: 'nuxt', range: '^4.1.2', file: 'apps/web/package.json' }))).toBe(
      'dependency nuxt@^4.1.2 in apps/web/package.json',
    )
    expect(dependencyEvidence(ref({ name: 'vitest', type: 'devDependencies' }))).toBe(
      'devDependency vitest@^1.0.0 in package.json',
    )
    expect(dependencyEvidence(ref({ name: 'vue', type: 'peerDependencies' }))).toBe(
      'peerDependency vue@^1.0.0 in package.json',
    )
    expect(
      dependencyEvidence(
        ref({ name: 'github.com/x/y', range: 'v1.2.0', type: 'go', indirect: true, file: 'go.mod', ecosystem: 'go' }),
      ),
    ).toBe('indirect dependency github.com/x/y@v1.2.0 in go.mod')
    expect(dependencyEvidence(ref({ name: 'react', range: 'git+https://u:p@example.com/r.git' }))).toBe(
      'dependency react in package.json',
    )
  })

  it('sanitizes script names', () => {
    expect(displayScriptName('build:prod')).toBe('build:prod')
    expect(displayScriptName('a b"c')).toBe('a?b?c')
    expect(displayScriptName('x'.repeat(60))).toHaveLength(40)
  })

  it('redacts credential formats in script names', () => {
    const token = `ghp_${'a1B2'.repeat(9)}`
    expect(displayScriptName(`deploy:${token}`)).not.toContain(token)
    expect(displayScriptName(`deploy:${token}`)).toContain('***')
  })
})

describe('locateFiles', () => {
  const layout = createLayout(
    [
      'vite.config.ts',
      'apps/web/vite.config.mts',
      'apps/web/src/vite.config.ts',
      'apps/web/.vitepress/config.ts',
      'docs/vite.config.ts',
      'packages/ui/package.json',
    ],
    ['apps/web', 'packages/ui'],
  )

  it('finds files in the root and package directories only', () => {
    expect(locateFiles(layout, ['vite.config.{js,ts,mts}'])).toEqual([
      { path: 'apps/web/vite.config.mts', package: 'apps/web', rel: 'vite.config.mts' },
      { path: 'vite.config.ts', package: '.', rel: 'vite.config.ts' },
    ])
  })

  it('supports literal subdirectories', () => {
    expect(locateFiles(layout, ['.vitepress/config.ts'])).toEqual([
      { path: 'apps/web/.vitepress/config.ts', package: 'apps/web', rel: '.vitepress/config.ts' },
    ])
  })

  it('assigns a file reachable from several packages to the deepest one', () => {
    const nested = createLayout(['apps/web/package.json'], ['apps', 'apps/web'])
    expect(locateFiles(nested, ['web/package.json', 'package.json'])).toEqual([
      { path: 'apps/web/package.json', package: 'apps/web', rel: 'package.json' },
    ])
  })

  it('goModuleOf finds the deepest Go module and ignores other directories', () => {
    const modules = new Set(['.', 'services/billing'])
    expect(goModuleOf('main.go', modules)).toBe('.')
    expect(goModuleOf('services/billing/internal/x.go', modules)).toBe('services/billing')
    expect(goModuleOf('services/other/x.go', modules)).toBe('.')
    expect(goModuleOf('tools/x.go', new Set(['services/billing']))).toBeNull()
    expect(goModuleOf('x.go', new Set())).toBeNull()
  })

  it('can be limited to the root', () => {
    expect(locateFiles(layout, ['vite.config.{ts,mts}'], { rootOnly: true }).map((f) => f.path)).toEqual([
      'vite.config.ts',
    ])
  })
})

describe('python requirements', () => {
  it('normalizes names', () => {
    expect(normalizePythonName('Pytest_Cov.Plugin')).toBe('pytest-cov-plugin')
  })

  it('parses requirement strings', () => {
    expect(parseRequirement('pytest==8.4.2')).toEqual({ name: 'pytest', spec: '==8.4.2' })
    expect(parseRequirement('pytest[testing] >= 8, <9 ; python_version > "3.9"')).toEqual({
      name: 'pytest',
      spec: '>=8,<9',
    })
    expect(parseRequirement('ruff')).toEqual({ name: 'ruff' })
    expect(parseRequirement('mypkg @ https://user:secret@example.com/mypkg.whl')).toEqual({ name: 'mypkg' })
    expect(parseRequirement('   ')).toBeNull()
  })

  it('skips options, comments and URLs in requirements.txt', () => {
    const text = [
      '# dev tools',
      '--index-url https://user:secret@pypi.example.com/simple',
      '-r base.txt',
      'pytest==8.4.2  # test runner',
      '',
      'Black>=24',
      '-e git+https://github.com/acme/lib.git#egg=lib',
    ].join('\n')
    expect(parseRequirementsTxt(text)).toEqual([
      { name: 'pytest', spec: '==8.4.2' },
      { name: 'black', spec: '>=24' },
    ])
  })

  it('reads dependencies and tables from pyproject.toml', () => {
    const text = `
[project]
name = "app"
dependencies = ["fastapi>=0.115", 'httpx']

[project.optional-dependencies]
test = [
  "pytest[testing]>=8",  # comment ]
  "pytest-cov",
]

[dependency-groups]
lint = ["ruff==0.13.1"]

[tool.poetry.group.dev.dependencies]
python = "^3.12"
mypy = { version = ">=1.10", optional = true }
black = "^24.1"

[tool.pytest.ini_options]
addopts = "-q"

[tool.ruff.lint]
select = ["E", "F"]
`
    const parsed = parsePythonToml(text)
    expect(parsed.requirements).toEqual([
      { name: 'fastapi', spec: '>=0.115' },
      { name: 'httpx' },
      { name: 'pytest', spec: '>=8' },
      { name: 'pytest-cov' },
      { name: 'ruff', spec: '==0.13.1' },
      { name: 'mypy', spec: '>=1.10' },
      { name: 'black', spec: '^24.1' },
    ])
    expect(hasTable(parsed.tables, 'tool.pytest')).toBe(true)
    expect(hasTable(parsed.tables, 'tool.ruff')).toBe(true)
    expect(hasTable(parsed.tables, 'tool.black')).toBe(false)
  })

  it('reads Pipfile sections and survives garbage', () => {
    expect(parsePythonToml('[packages]\nflask = "*"\n\n[dev-packages]\npytest = ">=8"\n').requirements).toEqual([
      { name: 'flask' },
      { name: 'pytest', spec: '>=8' },
    ])
    expect(() => parsePythonToml('[[[\n= = =\n"unterminated')).not.toThrow()
  })

  it('reads table headers, including spaced, quoted and array-of-tables forms', () => {
    expect(tableHeader('[tool.ruff]')).toBe('tool.ruff')
    expect(tableHeader('[ tool . pytest . ini_options ]  # comment')).toBe('tool.pytest.ini_options')
    expect(tableHeader('[[tool.mypy.overrides]]')).toBe('tool.mypy.overrides')
    expect(tableHeader('[tool."black"]')).toBe('tool.black')
    expect(tableHeader('[]')).toBeNull()
    expect(tableHeader('["pytest", "ruff"]')).toBeNull()
    expect(tableHeader('[tool.ruff] x')).toBeNull()
    expect(tableHeader('name = "x"')).toBeNull()
  })

  it('does not treat an element of a multi-line array as a table header', () => {
    const text = '[tool.ruff]\nextend = [\n  ["a", "b"]\n]\n\n[project]\ndependencies = ["pytest"]\n'
    const parsed = parsePythonToml(text)
    expect(parsed.tables).toEqual(['tool.ruff', 'project'])
    expect(parsed.requirements).toEqual([{ name: 'pytest' }])
  })

  it('stays linear on hostile input (no catastrophic backtracking)', () => {
    const size = 256 * 1024
    const inputs = [
      `[${' '.repeat(size)}x`,
      `[a${' '.repeat(size)}b`,
      `[[${'a'.repeat(size)}`,
      `a${' '.repeat(size)}= x`,
      `[tool.poetry.dependencies]\nfoo = { version${' '.repeat(size)}`,
    ]
    const start = performance.now()
    for (const input of inputs) parsePythonToml(input)
    parseRequirementsTxt(`a${' '.repeat(size)}#\n`.repeat(4))
    parseRequirement(`a==${'1 ,'.repeat(size / 3)}!`)
    // The old header pattern needed about 35 s for a 4 KB line; linear parsing takes a few ms.
    expect(performance.now() - start).toBeLessThan(timeBudget(1000))
  })
})

describe('tool engine', () => {
  const spec: ToolSpec = {
    id: 'demo',
    name: 'Demo',
    kind: 'linter',
    dependencies: ['demo'],
    weakDependencies: ['demo-core'],
    bins: ['demo'],
    configs: [
      { pattern: 'demo.config.{js,ts}', note: 'flat' },
      { pattern: 'build.config.ts', weak: true },
    ],
    packageJsonFields: [{ key: 'demo' }],
  }

  function facts(refs: DependencyRef[], files: string[], scripts: Record<string, string> = {}, fields: string[] = []) {
    return {
      dependencies: createDependencyIndex(refs),
      layout: createLayout(files, [], [{ dir: '.', file: 'package.json', scripts, fields }]),
    } satisfies ToolFacts
  }

  it('returns null without any signal', () => {
    expect(detectTool(spec, facts([], ['package.json']))).toBeNull()
  })

  it('combines dependencies, config files, fields and script config arguments', () => {
    const tool = detectTool(
      spec,
      facts(
        [ref({ name: 'demo', range: '^2.1.0', type: 'devDependencies' })],
        ['package.json', 'demo.config.ts', 'config/demo.ci.js'],
        { lint: 'demo --config config/demo.ci.js', other: 'demo -c ../outside.js' },
        ['demo'],
      ),
    )
    expect(tool).toEqual({
      id: 'demo',
      name: 'Demo',
      kind: 'linter',
      version: '2.1.0',
      configFiles: ['config/demo.ci.js', 'demo.config.ts', 'package.json'],
      packages: ['.'],
      confidence: 'high',
      evidence: [
        'devDependency demo@^2.1.0 in package.json',
        'config file demo.config.ts (flat)',
        '"demo" field in package.json',
        'config file config/demo.ci.js (used by the "lint" script)',
      ],
    })
  })

  it('caps weak dependencies at medium and weak config files at low', () => {
    expect(detectTool(spec, facts([ref({ name: 'demo-core' })], ['package.json']))?.confidence).toBe('medium')
    expect(detectTool(spec, facts([], ['build.config.ts']))?.confidence).toBe('low')
    expect(detectTool(spec, facts([ref({ name: 'demo-core' })], ['build.config.ts']))?.confidence).toBe('high')
  })

  it('treats peer-only and indirect Go dependencies as low confidence', () => {
    expect(detectTool(spec, facts([ref({ name: 'demo', type: 'peerDependencies' })], []))?.confidence).toBe('low')
    const goSpec: ToolSpec = { id: 'g', name: 'G', kind: 'test', dependencies: ['example.com/g'] }
    const goRef = ref({ name: 'example.com/g', type: 'go', ecosystem: 'go', indirect: true, file: 'go.mod' })
    expect(detectTool(goSpec, facts([goRef], []))?.confidence).toBe('low')
  })

  it('reads config arguments', () => {
    expect(configArgument(['--config', 'a.json'])).toBe('a.json')
    expect(configArgument(['--config=b.json'])).toBe('b.json')
    expect(configArgument(['-c', 'c.json'])).toBe('c.json')
    expect(configArgument(['-c', '--fix'])).toBeUndefined()
    expect(configArgument(['--fix'])).toBeUndefined()
    expect(configArgument(['-c', 'README.md'], false)).toBeUndefined()
    expect(configArgument(['--config', 'a.json'], false)).toBe('a.json')
  })

  it('sorts tools by kind order, then name', () => {
    const make = (id: string, name: string, kind: Tool['kind']): Tool => ({
      id,
      name,
      kind,
      configFiles: [],
      packages: ['.'],
      confidence: 'high',
      evidence: [],
    })
    const sorted = sortTools(
      [
        make('z', 'zeta', 'formatter'),
        make('b', 'Beta', 'linter'),
        make('a', 'alpha', 'linter'),
        make('o', 'O', 'orm'),
      ],
      ['linter', 'formatter'],
    )
    expect(sorted.map((t) => t.id)).toEqual(['a', 'b', 'z', 'o'])
  })
})
