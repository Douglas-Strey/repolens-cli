import { describe, expect, it } from 'vitest'
import { filterByConfidence } from '../../src/core/confidence.ts'
import { connections, routeTables, servicesTable, warningMessage } from '../../src/output/markdown/blocks.ts'
import {
  bullets,
  cell,
  code,
  details,
  document,
  headingText,
  inline,
  numbered,
  prose,
  section,
  table,
  text,
  textWith,
} from '../../src/output/markdown/syntax.ts'
import { REPOLENS_URL, renderMarkdown } from '../../src/output/markdown.ts'
import {
  isRemoteLocation,
  jobName,
  noteWarnings,
  portLabel,
  displayRemote as remoteLabel,
  repoPath,
  sortRoutes,
  variableNotes,
  withoutExpressions,
} from '../../src/output/shared/facts.ts'
import { maskAbsolutePaths, sentence, truncate, detailLine as warningDetail } from '../../src/output/shared/text.ts'
import type { EnvVariable, Route, ScanResult, Script, Service } from '../../src/types.ts'
import { makeResult, sampleScanResult } from '../factories.ts'
import { copyFixture, SECRET_SENTINEL, scanDir } from '../helpers.ts'
import { cellCount, hostile, markdownProblems, tableProblems, withoutCodeSpans } from './markdown-assertions.ts'
import { largeScanResult } from './synthetic.ts'

function script(overrides: Partial<Script> & Pick<Script, 'name'>): Script {
  return {
    command: `run ${overrides.name}`,
    run: `pnpm ${overrides.name}`,
    source: 'package.json',
    package: '.',
    category: 'other',
    ...overrides,
  }
}

function variable(overrides: Partial<EnvVariable> & Pick<EnvVariable, 'name'>): EnvVariable {
  return {
    defined: false,
    documented: false,
    used: false,
    definedIn: [],
    documentedIn: [],
    usedIn: [],
    fallback: false,
    testOnly: false,
    public: false,
    sensitive: false,
    endpoints: [],
    suspiciousValueIn: [],
    ...overrides,
  }
}

function withScripts(scripts: Script[], overrides: Partial<ScanResult> = {}): ScanResult {
  return makeResult({ scripts: { runner: 'pnpm', scripts }, ...overrides })
}

function headings(markdown: string, level: number): string[] {
  const prefix = `${'#'.repeat(level)} `
  return markdown
    .split('\n')
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length))
}

// ---------------------------------------------------------------------------
// Markdown syntax
// ---------------------------------------------------------------------------

describe('text', () => {
  it('escapes inline markup, HTML, math and links', () => {
    const out = text('*bold* [link](http://x) <img src=x onerror=alert(1)> `tick` $x$ ~strike~ a\\b')
    expect(out).toBe(
      '\\*bold\\* \\[link\\](http://x) \\<img src=x onerror=alert(1)> \\`tick\\` \\$x\\$ \\~strike\\~ a\\\\b',
    )
  })

  it('leaves underscores inside words alone but escapes emphasis underscores', () => {
    expect(text('STRIPE_SECRET_KEY')).toBe('STRIPE_SECRET_KEY')
    expect(text('_private_ name')).toBe('\\_private\\_ name')
  })

  it('escapes block markers only where they would start a block', () => {
    expect(text('# Title')).toBe('\\# Title')
    expect(text('- item')).toBe('\\- item')
    expect(text('+ item')).toBe('\\+ item')
    expect(text('1. item')).toBe('1\\. item')
    expect(text('2) item')).toBe('2\\) item')
    expect(text('---')).toBe('\\---')
    expect(text('===')).toBe('\\===')
    expect(text('1.2.3')).toBe('1.2.3')
    expect(text('-rc.1')).toBe('-rc.1')
    expect(text('#hashtag')).toBe('#hashtag')
    expect(text('> quote')).toBe('\\> quote')
    expect(text('>=22')).toBe('\\>=22')
    expect(text('Node >=22')).toBe('Node >=22')
  })

  it('removes control characters, bidi overrides and line breaks', () => {
    const out = text('line one\nline two\r\n\u001b[31mred\u001b[0m \u202Egnp.exe')
    for (const char of ['\n', '\r', '\u001b', '\u202e']) expect(out).not.toContain(char)
    expect(out).toBe('line one line two \\[31mred\\[0m gnp.exe')
  })

  it('removes zero-width and Unicode tag characters that could smuggle text to an agent', () => {
    const zeroWidth = String.fromCharCode(0x200b)
    const tags = String.fromCodePoint(0xe0049, 0xe0067, 0xe006e, 0xe006f, 0xe0072, 0xe0065)
    for (const render of [text, inline, code]) {
      const out = render(`DATA${zeroWidth}BASE_URL${tags}`)
      expect(out).toContain('DATABASE_URL')
      expect(out).not.toMatch(/[\u200b\udb40]/)
    }
  })

  it('neutralizes HTML entities', () => {
    expect(text('a &amp; b &#60; c & d')).toBe('a &amp;amp; b &amp;#60; c & d')
  })
})

describe('code', () => {
  it('wraps values in a code span that survives backticks', () => {
    expect(code('pnpm dev')).toBe('`pnpm dev`')
    expect(code('echo `date`')).toBe('`` echo `date` ``')
    expect(code('a ``b`` c')).toBe('```a ``b`` c```')
    expect(code('`start')).toBe('`` `start ``')
  })

  it('never produces an empty span or a multi-line span', () => {
    expect(code('')).toBe('–')
    expect(code('   ')).toBe('–')
    expect(code('a\nb')).toBe('`a b`')
  })
})

describe('prose', () => {
  it('keeps code spans and escapes the text around them, preserving spaces', () => {
    expect(prose('Run `git rm --cached .env` and add *.env* to .gitignore')).toBe(
      'Run `git rm --cached .env` and add \\*.env\\* to .gitignore',
    )
  })

  it('escapes an unmatched backtick', () => {
    expect(prose('a ` b')).toBe('a \\` b')
  })

  it('re-fences code spans that contain pipes or backticks safely', () => {
    expect(prose('use ``a`b`` here')).toBe('use ``a`b`` here')
  })
})

describe('textWith', () => {
  it('turns every occurrence of a literal into a code span and escapes the rest', () => {
    expect(textWith("Couldn't parse a_[b].yml (a_[b].yml)", 'a_[b].yml')).toBe(
      "Couldn't parse `a_[b].yml` (`a_[b].yml`)",
    )
  })

  it('falls back to plain escaping when the literal is absent', () => {
    expect(textWith('Something *odd*', 'x.yml')).toBe('Something \\*odd\\*')
  })
})

describe('cell', () => {
  it('escapes pipes, including inside code spans', () => {
    expect(cell('a|b')).toBe('a\\|b')
    expect(cell(code('eslint . | tee log'))).toBe('`eslint . \\| tee log`')
  })

  it('keeps one cell whatever backslashes precede a pipe', () => {
    for (const value of ['a|b', 'a\\|b', 'a\\\\|b', 'a\\\\\\|b', '|', '\\|', '||', '`|`', 'x\\']) {
      expect(cellCount(`| ${cell(value)} |`), value).toBe(1)
    }
  })

  it('uses a dash for empty cells', () => {
    expect(cell('')).toBe('–')
  })
})

describe('table', () => {
  it('pads short rows, cuts long rows and aligns numbers', () => {
    const out = table(['A', 'B'], [['1'], ['2', '3', '4'], ['x|y', 'z']], ['left', 'right'])
    expect(out).toBe(['| A | B |', '| --- | ---: |', '| 1 | – |', '| 2 | 3 |', '| x\\|y | z |'].join('\n'))
    expect(tableProblems(`${out}\n`)).toEqual([])
  })
})

describe('block helpers', () => {
  it('indents continuation lines of list items', () => {
    expect(bullets(['a\nb', 'c'])).toBe('- a\n  b\n- c')
    expect(numbered(['a\nb'])).toBe('1. a\n   b')
  })

  it('renders details with the blank lines GitHub needs and an escaped summary', () => {
    expect(details('A <b> & c', '- x')).toBe('<details>\n<summary>A &lt;b&gt; &amp; c</summary>\n\n- x\n\n</details>')
  })

  it('omits empty sections and joins documents with one trailing newline', () => {
    expect(section('Empty', 2, null, '', false, undefined)).toBeNull()
    expect(section('Full', 2, 'body', null)).toBe('## Full\n\nbody')
    expect(document('# T', null, 'x')).toBe('# T\n\nx\n')
  })
})

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

describe('paths and URLs', () => {
  it('keeps build contexts inside the repository', () => {
    expect(repoPath('./apps/api/')).toBe('apps/api')
    expect(repoPath('.')).toBe('.')
    expect(repoPath('apps/../services/x')).toBe('services/x')
    expect(repoPath('../outside')).toBeNull()
    expect(repoPath('/srv/app')).toBeNull()
    expect(repoPath('~/app')).toBeNull()
    expect(repoPath('C:\\app')).toBeNull()
  })

  it('treats remote build contexts as outside the repository', () => {
    for (const value of ['https://github.com/acme/app.git#main', 'git@github.com:acme/app.git', 'ssh://git@host/x']) {
      expect(isRemoteLocation(value), value).toBe(true)
      expect(repoPath(value), value).toBeNull()
    }
    expect(isRemoteLocation('./apps/api')).toBe(false)
    expect(isRemoteLocation('docker/app@v2')).toBe(false)
  })

  it('masks absolute paths in technical details', () => {
    const stack =
      'TypeError: boom\n    at run (/Users/alice/dev/repolens/src/x.ts:12:5) C:\\Users\\bob\\x.ts file:///home/c/y.ts'
    const masked = maskAbsolutePaths(stack)
    expect(masked).not.toMatch(/alice|bob|home\/c/)
    expect(masked).toContain('(<path>:12:5)')
    expect(maskAbsolutePaths('at line 4, column 8')).toBe('at line 4, column 8')
  })

  it('strips credentials from remotes and never shows local paths', () => {
    expect(remoteLabel('https://user:t0ken@github.com/acme/x.git')).toBe('github.com/acme/x')
    expect(remoteLabel('git@github.com:acme/x.git')).toBe('github.com/acme/x')
    expect(remoteLabel('ssh://git@example.com:2222/acme/x.git')).toBe('example.com:2222/acme/x')
    expect(remoteLabel('/Users/alice/repos/x.git')).toBe('local path')
    expect(remoteLabel('../x.git')).toBe('local path')
    expect(remoteLabel('file:///srv/x.git')).toBe('local path')
  })

  it('formats port mappings', () => {
    expect(portLabel({ host: 5432, container: 5432, protocol: 'tcp', raw: '' })).toBe('5432 → 5432')
    expect(portLabel({ host: 8080, container: 80, protocol: 'tcp', hostIp: '127.0.0.1', raw: '' })).toBe(
      '127.0.0.1:8080 → 80',
    )
    expect(portLabel({ host: 53, container: 53, protocol: 'udp', hostIp: '::1', raw: '' })).toBe('[::1]:53 → 53/udp')
    expect(portLabel({ host: null, container: 6379, protocol: 'tcp', raw: '' })).toBe('6379 (internal)')
  })
})

describe('variableNotes', () => {
  it('lists problems first, then properties', () => {
    const notes = variableNotes(
      variable({ name: 'X', used: true, sensitive: true, public: true, suspiciousValueIn: ['.env.example'] }),
      true,
    )
    expect(notes).toEqual([
      'undocumented',
      'not set locally',
      'example value looks like a real credential (.env.example)',
      // Exposed to the browser means public, whatever the name suggests: never "public" and "secret" at once.
      'exposed to the client',
    ])
    expect(variableNotes(variable({ name: 'Y', documented: true }), false)).toEqual(['not referenced in code'])
  })
})

describe('sentence', () => {
  it('adds a period only when needed', () => {
    expect(sentence('Done')).toBe('Done.')
    expect(sentence('Done.')).toBe('Done.')
    expect(sentence('Why?')).toBe('Why?')
    expect(sentence('')).toBe('')
    expect(sentence('Cut short…')).toBe('Cut short…')
  })
})

describe('routes', () => {
  it('sorts by package, path, method and location regardless of input order', () => {
    const routes = sampleScanResult().routes.routes
    expect(sortRoutes([...routes].reverse())).toEqual(sortRoutes(routes))
  })

  it('caps API routes and pages together and reports the rest', () => {
    const routes = largeScanResult().routes.routes
    const tables = routeTables(routes, 200)
    const rows = [tables.api, tables.pages].reduce((sum, table) => sum + (table ? table.split('\n').length - 2 : 0), 0)
    expect(tables.hidden).toBe(routes.length - 200)
    expect(rows).toBe(200)
  })
})

describe('connections', () => {
  it('derives links from ports, build contexts and depends_on only', () => {
    expect(connections(sampleScanResult())).toEqual([
      '`apps/api`: Fastify · 3 API routes · data access with Prisma',
      '`apps/web`: Nuxt, Vue · 1 API route · 2 pages',
      '`packages/ui`: Vue',
      '`services/billing`: net/http · 1 API route',
      '`apps/web` reads `API_URL` (http, port 4000), the port `apps/api/Dockerfile` exposes.',
      '`apps/api` reads `DATABASE_URL` (postgres, port 5432), the port the `postgres` service publishes.',
      '`apps/api` reads `REDIS_URL` (redis, port 6379), the port the `redis` service publishes.',
    ])
  })

  it('ignores remote endpoints, unused variables and build contexts outside the repository', () => {
    const base = sampleScanResult()
    const postgres = base.services.services[0]
    if (!postgres) throw new Error('sample has services')
    const result = makeResult({
      environment: {
        files: [],
        usageTruncated: false,
        variables: [
          variable({
            name: 'REMOTE_DB',
            used: true,
            usedIn: ['src/db.ts'],
            fallback: false,
            testOnly: false,
            endpoints: [{ file: '.env', scheme: 'postgres', port: 5432, local: false }],
          }),
          variable({
            name: 'UNUSED_DB',
            endpoints: [{ file: '.env', scheme: 'postgres', port: 5432, local: true }],
          }),
          variable({
            name: 'LOCAL_DB',
            used: true,
            usedIn: ['src/db.ts'],
            fallback: false,
            testOnly: false,
            endpoints: [{ file: '.env', scheme: 'postgres', port: 5432, local: true }],
          }),
        ],
      },
      services: {
        composeFiles: ['compose.yaml'],
        dockerfiles: [],
        services: [
          postgres,
          { ...postgres, name: 'api', build: '/abs/path', ports: [], dependsOn: ['postgres'] },
          { ...postgres, name: 'web', build: './', ports: [] },
        ],
      },
    })
    expect(connections(result)).toEqual([
      'The code reads `LOCAL_DB` (postgres, port 5432), the port the `postgres` service publishes.',
      'The `web` service is built from the repository root.',
      '`api` starts after `postgres` (`depends_on`).',
    ])
  })
})

describe('scan notes', () => {
  it('puts the file in a code span and masks paths in details', () => {
    expect(warningMessage({ kind: 'parse', file: 'a/b_c.yml', message: "Couldn't parse a/b_c.yml" })).toBe(
      "RepoLens couldn't parse `a/b_c.yml`",
    )
    expect(warningDetail('Error: x\n    at /home/runner/work/x.ts:1:1')).toBe('Error: x')
    expect(warningDetail('failed at /Users/alice/x.ts')).toBe('failed at <path>')
  })
})

// ---------------------------------------------------------------------------
// renderMarkdown
// ---------------------------------------------------------------------------

describe('renderMarkdown', () => {
  it('matches the snapshot for the sample monorepo', async () => {
    await expect(renderMarkdown(sampleScanResult())).toMatchFileSnapshot('__snapshots__/report.md')
  })

  it('matches the snapshot in verbose mode', async () => {
    await expect(renderMarkdown(sampleScanResult(), { verbose: true })).toMatchFileSnapshot(
      '__snapshots__/report-verbose.md',
    )
  })

  it('renders the sections in a fixed order', () => {
    expect(headings(renderMarkdown(sampleScanResult()), 2)).toEqual([
      'Overview',
      'Quick start',
      'Architecture',
      'Languages',
      'Frameworks',
      'Dependencies',
      'Services',
      'Databases',
      'Environment variables',
      'Scripts',
      'Routes',
      'CI',
      'Tooling',
      'Git',
      'Potential issues',
      'Configuration files',
      'Scan notes',
    ])
  })

  it('starts with the title, description and the one provenance note', () => {
    const out = renderMarkdown(sampleScanResult())
    expect(out.split('\n').slice(0, 5)).toEqual([
      '# acme-api',
      '',
      'Acme storefront and API',
      '',
      `> Generated by [RepoLens](${REPOLENS_URL}) v1.2.3 — static analysis only, no code was executed. Review before sharing.`,
    ])
    // A footer repeating "generated by RepoLens" said the same thing twice.
    expect(out.match(/generated by/gi)).toHaveLength(1)
    expect(out).not.toContain('\n---\n')
  })

  it.each([
    ['sample', () => renderMarkdown(sampleScanResult())],
    ['sample (verbose)', () => renderMarkdown(sampleScanResult(), { verbose: true })],
    ['large result', () => renderMarkdown(largeScanResult())],
    ['large result (verbose)', () => renderMarkdown(largeScanResult(), { verbose: true })],
    ['empty result', () => renderMarkdown(makeResult())],
  ])('produces well-formed Markdown: %s', (_name, render) => {
    expect(markdownProblems(render())).toEqual([])
  })

  it('renders a short valid report for an empty result', () => {
    const out = renderMarkdown(makeResult())
    expect(out.split('\n').length).toBeLessThan(12)
    expect(out).toContain('# project')
    expect(out).toContain('_RepoLens found nothing to report in this directory._')
    expect(out).toContain('> Generated by [RepoLens]')
    expect(headings(out, 2)).toEqual([])
  })

  it('is deterministic and independent of route and variable order', () => {
    const a = sampleScanResult()
    const b = sampleScanResult()
    b.routes.routes.reverse()
    b.environment.variables.reverse()
    expect(renderMarkdown(a)).toBe(renderMarkdown(a))
    expect(renderMarkdown(b)).toBe(renderMarkdown(a))
  })

  it('escapes pipes in script commands without breaking the table', () => {
    const out = renderMarkdown(
      withScripts([script({ name: 'lint', command: 'eslint . | tee lint.log || true', run: 'pnpm lint' })]),
    )
    expect(out).toContain('| `pnpm lint` | `eslint . \\| tee lint.log \\|\\| true` | `package.json` |')
    expect(tableProblems(out)).toEqual([])
  })

  it('shows "No problems found" with the number of passed checks', () => {
    const result = sampleScanResult()
    result.doctor = { ...result.doctor, diagnostics: [] }
    expect(renderMarkdown(result)).toContain('## Potential issues\n\nNo problems found. 18 checks passed.')
  })

  it('shows evidence, file lists and parser details only in verbose mode', () => {
    const quiet = renderMarkdown(sampleScanResult())
    const verbose = renderMarkdown(sampleScanResult(), { verbose: true })
    for (const out of [quiet, verbose])
      expect(out).toContain("RepoLens couldn't parse `apps/legacy/docker-compose.yml`")
    expect(quiet).not.toContain('Nested mappings')
    expect(verbose).toContain('_Nested mappings are not allowed in compact mappings at line 4, column 8_')
    expect(quiet).not.toContain('| Evidence |')
    expect(verbose).toContain('dependency nuxt@^4.1.2 in apps/web/package.json')
    expect(verbose).toContain('Files: `.nvmrc`, `apps/api/Dockerfile`')
  })

  it('caps long tables and says how many rows were left out', () => {
    const out = renderMarkdown(largeScanResult())
    expect(out).toContain('_… and 300 more routes._')
    expect(out).toContain('_Route scanning stopped early because of limits; the list may be incomplete._')
    expect(out).toContain('The scan stopped after indexing 100,000 files; results may be incomplete.')
  })

  describe('safety', () => {
    it('never prints endpoint details beyond scheme and port', () => {
      const out = renderMarkdown(sampleScanResult())
      expect(out).toContain('points at postgres, port 5432')
      expect(out).not.toMatch(/localhost|127\.0\.0\.1:5432/)
    })

    it('redacts secrets in echoed commands, versions and remotes', () => {
      const token = ['ghp', 'A'.repeat(36)].join('_')
      const result = withScripts(
        [
          script({
            name: 'deploy',
            command: `API_TOKEN=hunter2 deploy --password s3cret ${token}`,
            run: 'pnpm deploy',
          }),
          script({ name: 'db', command: 'psql postgres://admin:pw@db.example.com/app', run: 'pnpm db' }),
        ],
        {
          git: {
            branch: 'main',
            head: null,
            remotes: [{ name: 'origin', url: 'https://bob:hunter3@git.example.com/acme/app.git' }],
            submodules: [],
            lfs: false,
            trackedFiles: null,
            linkedWorktree: false,
          },
          dependencies: {
            total: 1,
            packages: [
              {
                path: '.',
                name: 'app',
                ecosystem: 'node',
                dependencies: [{ name: 'private', version: 'git+https://user:pat@host/x.git', kind: 'prod' }],
              },
            ],
          },
        },
      )
      const out = renderMarkdown(result, { verbose: true })
      for (const secret of ['hunter2', 's3cret', token, 'admin:pw', 'hunter3', 'user:pat']) {
        expect(out).not.toContain(secret)
      }
      expect(out).toContain('API_TOKEN=***')
      expect(out).toContain('git.example.com/acme/app')
    })

    it('neutralizes Markdown, HTML and terminal escapes from committed text', () => {
      const result = makeResult({
        project: {
          ...makeResult().project,
          name: '# evil <script>alert(1)</script>',
          description: '![x](http://evil) \u001b[2J [click](javascript:alert(1)) | --- |',
          license: '<b>MIT</b>',
        },
      })
      const out = renderMarkdown(result)
      expect(out.split('\n')[0]).toBe('# \\# evil \\<script>alert(1)\\</script>')
      expect(out).not.toContain('\u001b')
      expect(out).not.toMatch(/(?<!\\)<script>/)
      expect(out).toContain('\\[click\\](javascript:alert(1))')
      expect(out).toContain('!\\[x\\](http://evil)')
      expect(out).toContain('| License | \\<b>MIT\\</b> |')
      expect(markdownProblems(out)).toEqual([])
    })

    it('does not leak absolute paths from detector stack traces', () => {
      const result = makeResult({
        meta: {
          files: 1,
          config: { sources: [], settings: {} },
          truncated: false,
          warnings: [
            {
              kind: 'error',
              message: 'The Routes detector failed',
              detail: 'TypeError: x\n at f (/Users/alice/x.ts:1:1)',
            },
          ],
        },
      })
      const out = renderMarkdown(result, { verbose: true })
      expect(out).toContain('The Routes detector failed')
      expect(out).not.toContain('alice')
    })
  })

  describe('on scanned fixtures', () => {
    it.each(['monorepo', 'docker-project', 'broken-env', 'broken-config', 'go-api', 'plain-repo'])(
      '%s: well-formed, no secret values and no absolute paths',
      async (fixture) => {
        const dir = await copyFixture(fixture)
        const raw = await scanDir(dir)
        for (const out of [renderMarkdown(filterByConfidence(raw)), renderMarkdown(raw, { verbose: true })]) {
          expect(out).not.toContain(SECRET_SENTINEL)
          expect(out).not.toContain(dir)
          expect(markdownProblems(out)).toEqual([])
        }
      },
    )
  })
})

describe('Route type coverage', () => {
  it('renders page-only results without an API table', () => {
    const page: Route = {
      method: 'GET',
      path: '/',
      kind: 'page',
      framework: 'nuxt',
      file: 'pages/index.vue',
      confidence: 'high',
    }
    const out = renderMarkdown(makeResult({ routes: { routes: [page], truncated: false } }))
    expect(headings(out, 3)).toEqual(['Pages'])
    expect(out).toContain('| `/` | `pages/index.vue` |')
  })
})

// ---------------------------------------------------------------------------
// Regressions found in review
// ---------------------------------------------------------------------------

function service(overrides: Partial<Service> & Pick<Service, 'name'>): Service {
  return {
    source: 'compose.yaml',
    kind: 'app',
    ports: [],
    expose: [],
    dependsOn: [],
    volumes: [],
    environment: [],
    envFiles: [],
    profiles: [],
    healthcheck: false,
    ...overrides,
  }
}

describe('review regressions', () => {
  it('stays well-formed when every committed string carries Markdown, HTML and escapes', () => {
    const result = { ...hostile(sampleScanResult()), tool: sampleScanResult().tool }
    for (const out of [renderMarkdown(result), renderMarkdown(result, { verbose: true })]) {
      expect(markdownProblems(out)).toEqual([])
      const outside = withoutCodeSpans(out)
      expect(outside).not.toMatch(/(?<!\\)<b>/)
      expect(outside).not.toMatch(/(?<!\\)\[l\]\(/)
      // A heading may not end in an unescaped closing "#" sequence, which GitHub would drop.
      expect(out).not.toMatch(/^#{1,6} .*\s#+$/m)
      // The line break in the value must not start a heading of its own.
      expect(out).not.toMatch(/^#{1,6} H\b/m)
    }
  })

  it('does not present a remote build context as a directory of the repository', () => {
    const result = makeResult({
      services: {
        composeFiles: ['compose.yaml'],
        dockerfiles: [],
        services: [
          service({ name: 'remote', build: 'https://github.com/acme/app.git#main' }),
          service({ name: 'local', build: './apps/api' }),
          service({ name: 'outside', build: '../sibling' }),
        ],
      },
    })
    const table = servicesTable(result) ?? ''
    expect(table).toContain('| `remote` | remote build `github.com/acme/app` |')
    expect(table).toContain('| `local` | build `apps/api` |')
    expect(table).toContain('| `outside` | build from outside the repository |')
    expect(connections(result)).toEqual(['The `local` service is built from `apps/api`.'])
  })

  it('names files outside the workspace packages instead of calling them the root package', () => {
    const base = sampleScanResult()
    const postgres = base.services.services.find((s) => s.name === 'postgres')
    if (!postgres || !base.workspace) throw new Error('sample has postgres and a workspace')
    const result = makeResult({
      workspace: base.workspace,
      services: { composeFiles: ['compose.yaml'], dockerfiles: [], services: [postgres] },
      environment: {
        files: [],
        usageTruncated: false,
        variables: [
          variable({
            name: 'DB',
            used: true,
            usedIn: ['apps/api/src/db.ts', 'tools/a.go', 'tools/b.go', 'tools/c.go'],
            fallback: false,
            testOnly: false,
            endpoints: [{ file: '.env', scheme: 'postgres', port: 5432, local: true }],
          }),
        ],
      },
    })
    expect(connections(result)).toContain(
      '`apps/api`, `tools/a.go`, `tools/b.go` and 1 more file read `DB` (postgres, port 5432), the port the `postgres` service publishes.',
    )
  })

  it('keeps the file of a scan warning whose message does not mention it', () => {
    expect(warningMessage({ kind: 'parse', file: 'turbo.json', message: 'Invalid pipeline key' })).toBe(
      'Invalid pipeline key (`turbo.json`)',
    )
  })

  it('does not report the file limit twice', () => {
    const meta = {
      files: 100_000,
      config: { sources: [], settings: {} },
      truncated: true,
      warnings: [
        { kind: 'limit' as const, message: 'Stopped indexing after 100000 files; results may be incomplete' },
        { kind: 'parse' as const, file: 'a.json', message: "Couldn't parse a.json" },
      ],
    }
    expect(noteWarnings(meta).map((w) => w.message)).toEqual(["Couldn't parse a.json"])
    const out = renderMarkdown(makeResult({ meta }))
    expect(out.match(/stopped indexing|scan stopped/gi)).toHaveLength(1)
    expect(noteWarnings({ ...meta, truncated: false })).toHaveLength(2)
  })

  it('caps very long descriptions and names', () => {
    expect(truncate('short', 10)).toBe('short')
    expect(truncate('alpha beta gamma delta', 15)).toBe('alpha beta…')
    expect(truncate('x'.repeat(30), 10)).toBe(`${'x'.repeat(10)}…`)
    const result = makeResult({
      project: { ...makeResult().project, name: 'n'.repeat(500), description: 'word '.repeat(10_000) },
    })
    const lines = renderMarkdown(result).split('\n')
    expect(lines[0]?.length).toBeLessThan(130)
    expect(lines[2]?.length).toBeLessThan(410)
    expect(lines[2]?.endsWith('…')).toBe(true)
  })

  it('keeps a trailing "#" in a heading visible', () => {
    expect(headingText('C #')).toBe('C \\#')
    expect(headingText('C#')).toBe('C#')
    expect(headingText('#')).toBe('\\#')
    const out = renderMarkdown(makeResult({ project: { ...makeResult().project, name: 'Notes ##' } }))
    expect(out.split('\n')[0]).toBe('# Notes \\##')
  })

  it('heads each workflow with its file name and drops run-time expressions from job names (UX-21)', () => {
    // GitHub Actions expressions, built so they don't read as JavaScript template placeholders.
    const expr = (body: string) => `$${'{{'} ${body} }}`
    const result = sampleScanResult()
    const workflow = result.ci.workflows[0]
    if (!workflow) throw new Error('sample has a workflow')
    workflow.jobs.push({
      id: 'matrix',
      name: `Test (${expr('matrix.os')}, ${expr('matrix.node')})`,
      tasks: ['test'],
      runsOn: [],
    })
    const out = renderMarkdown(result)
    expect(headings(out, 3)).toContain('`ci.yml`')
    expect(headings(out, 3)).not.toContain('CI')
    expect(out).toContain('| Test (`matrix`) | test |')
    expect(out).not.toContain(expr('matrix.os'))
    expect(out).not.toContain('{{')
    expect(withoutExpressions(`Build ${expr('matrix.target')}`)).toBe('Build')
    expect(withoutExpressions(expr('inputs.name'))).toBe('')
    const unclosed = `Deploy $${'{{'} unclosed`
    expect(withoutExpressions(unclosed)).toBe(unclosed)
    expect(jobName({ id: 'x', name: expr('matrix.name'), tasks: [], runsOn: [] })).toBeNull()
  })

  it('says the private flag belongs to the package, not the repository (UX-22)', () => {
    expect(renderMarkdown(sampleScanResult())).toContain('| Type | Monorepo (private package) |')
  })

  it('marks missing values with ✗ and missing files with – in the environment table (UX-13)', () => {
    const result = makeResult({
      environment: {
        files: [{ path: '.env.example', kind: 'example', variables: 1, ignored: false, tracked: true }],
        variables: [
          variable({ name: 'DOCUMENTED', documented: true, used: true }),
          variable({ name: 'MISSING', used: true }),
        ],
        usageTruncated: false,
      },
    })
    const out = renderMarkdown(result)
    // No env file with values exists, so "Local" does not apply; the example exists, so ✗ means "not in it".
    expect(out).toContain('| `DOCUMENTED` | – | ✓ | ✓ |')
    expect(out).toContain('| `MISSING` | – | ✗ | ✓ | undocumented |')
  })

  it('describes optional, test-only and platform variables instead of calling them problems', () => {
    const result = makeResult({
      environment: {
        files: [
          { path: '.env', kind: 'local', variables: 1, ignored: true, tracked: false },
          { path: '.env.example', kind: 'example', variables: 1, ignored: false, tracked: true },
        ],
        variables: [
          variable({ name: 'PORT', documented: true, used: true, fallback: true }),
          variable({ name: 'TEST_DB', used: true, testOnly: true }),
          variable({ name: 'NODE_ENV', used: true }),
        ],
        usageTruncated: false,
      },
    })
    const out = renderMarkdown(result)
    expect(out).toContain('| `PORT` | ✗ | ✓ | ✓ | optional (has a default) |')
    expect(out).toContain('| `TEST_DB` | ✗ | ✗ | ✓ | only used in tests |')
    expect(out).toContain('| `NODE_ENV` | ✗ | ✗ | ✓ | set by the platform |')
  })

  it('uses one vocabulary across the terminal, the report and the agent files (UX-20)', () => {
    const report = renderMarkdown(sampleScanResult())
    expect(headings(report, 3)).toContain('Entry points')
    expect(headings(report, 2)).toEqual(expect.arrayContaining(['Scripts', 'Tooling', 'Potential issues']))
    expect(report).not.toMatch(/Entrypoints|Potential problems|Development commands|Used in code \|/)
  })

  it('does not list a parse failure the issues already report, except in verbose mode (UX-18)', () => {
    const result = makeResult({
      doctor: {
        checks: [],
        diagnostics: [
          {
            code: 'PACKAGE_JSON_INVALID',
            severity: 'error',
            category: 'configuration',
            message: 'package.json is not valid JSON',
            files: ['package.json'],
          },
        ],
        summary: { passed: 0, failed: 1, skipped: 0, disabled: 0, errors: 1, warnings: 0, infos: 0 },
      },
      meta: {
        files: 1,
        config: { sources: [], settings: {} },
        truncated: false,
        warnings: [{ kind: 'parse', file: 'package.json', message: "Couldn't parse package.json", detail: 'Bad' }],
      },
    })
    expect(headings(renderMarkdown(result), 2)).not.toContain('Scan notes')
    expect(renderMarkdown(result, { verbose: true })).toContain("RepoLens couldn't parse `package.json`")
  })
})
