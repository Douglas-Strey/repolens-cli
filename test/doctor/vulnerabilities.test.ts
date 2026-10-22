import { gt, valid } from 'semver'
import { describe, expect, it } from 'vitest'
import {
  SECURITY_DATA_DATE,
  SECURITY_RELEASES,
  type VulnerabilityRuntime,
} from '../../src/doctor/rules/security-releases.ts'
import {
  findVulnerableRuntimes,
  missedFixes,
  releaseLine,
  runtimePins,
} from '../../src/doctor/rules/vulnerabilities.ts'
import type { Runtime, VersionSource } from '../../src/types.ts'
import { makeProject, scanDir } from '../helpers.ts'

const source = (file: string, raw: string, extra: Partial<VersionSource> = {}): VersionSource => ({
  file,
  raw,
  version: raw,
  kind: 'exact',
  ...extra,
})

describe('the security release table', () => {
  const runtimes = Object.keys(SECURITY_RELEASES) as VulnerabilityRuntime[]

  it('is well formed: dates in order, valid versions, one fix per line, https links', () => {
    expect(SECURITY_DATA_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    for (const runtime of runtimes) {
      let previous = ''
      for (const release of SECURITY_RELEASES[runtime]) {
        expect(release.date, runtime).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        expect(release.date >= previous, `${runtime} ${release.date}`).toBe(true)
        expect(release.date <= SECURITY_DATA_DATE, `${runtime} ${release.date}`).toBe(true)
        previous = release.date
        expect(release.url).toMatch(/^https:\/\//)
        const lines = release.fixes.map((fix) => releaseLine(runtime, fix.version))
        expect(new Set(lines).size, `${runtime} ${release.date}`).toBe(lines.length)
        for (const fix of release.fixes) expect(valid(fix.version), fix.version).toBe(fix.version)
        for (const cve of release.cves ?? []) expect(cve).toMatch(/^CVE-\d{4}-\d{4,}$/)
      }
    }
  })

  it('only moves each line forward over time', () => {
    for (const runtime of runtimes) {
      const latest = new Map<string, string>()
      for (const release of SECURITY_RELEASES[runtime]) {
        for (const fix of release.fixes) {
          const line = releaseLine(runtime, fix.version)
          const before = latest.get(line)
          if (before) expect(gt(fix.version, before), `${runtime} ${fix.version} after ${before}`).toBe(true)
          latest.set(line, fix.version)
        }
      }
    }
  })
})

describe('runtimePins', () => {
  it('keeps exact, complete pins of Node.js, Go and PHP', () => {
    const runtimes: Runtime[] = [
      {
        id: 'php',
        name: 'PHP',
        version: '8.3.10',
        sources: [
          source('Dockerfile', 'php:8.3.10-fpm', { field: 'FROM', version: '8.3.10' }),
          source('docker/Dockerfile', 'php:8.3-fpm', { field: 'FROM', version: '8.3' }),
          source('composer.json', '^8.3', { field: 'require.php', kind: 'range' }),
          source('composer.json', '8.3.4', { field: 'config.platform.php' }),
        ],
      },
      {
        id: 'go',
        name: 'Go',
        version: '1.26',
        sources: [
          source('go.mod', 'go 1.26.2', { field: 'go directive', version: '1.26.2' }),
          source('go.mod', 'toolchain go1.26.2', { field: 'toolchain', version: '1.26.2' }),
          source('Dockerfile', 'golang:1.26.2', { field: 'FROM', version: '1.26.2' }),
        ],
      },
      { id: 'node', name: 'Node.js', version: '22', sources: [source('.nvmrc', 'v22.20.0', { version: 'v22.20.0' })] },
      {
        id: 'bun',
        name: 'Bun',
        version: '1.2.0',
        sources: [source('package.json', 'bun@1.2.0', { version: '1.2.0' })],
      },
    ]
    expect(runtimePins(runtimes)).toEqual([
      { runtime: 'php', version: '8.3.10', file: 'Dockerfile' },
      { runtime: 'go', version: '1.26.2', file: 'Dockerfile' },
      { runtime: 'node', version: '22.20.0', file: '.nvmrc' },
    ])
  })
})

describe('missedFixes', () => {
  it('counts the security releases of the same line that came after the pin', () => {
    const missed = missedFixes('php', '8.3.10')
    expect(missed.map((fix) => fix.version)).toEqual([
      '8.3.12',
      '8.3.14',
      '8.3.19',
      '8.3.23',
      '8.3.29',
      '8.3.31',
      '8.3.32',
      '8.3.33',
      '8.3.35',
      '8.3.36',
    ])
    expect(missedFixes('php', '8.3.36')).toEqual([])
    expect(missedFixes('php', '8.6.0')).toEqual([])
    expect(missedFixes('node', '22.23.4')).toEqual([])
    expect(missedFixes('node', '22.20.0').map((fix) => fix.version)).toEqual([
      '22.22.0',
      '22.22.2',
      '22.23.0',
      '22.23.2',
      '22.23.4',
    ])
  })
})

describe('findVulnerableRuntimes', () => {
  it('reports a missed critical fix as an error, with the CVEs and the announcement', () => {
    const found = findVulnerableRuntimes([
      { runtime: 'php', version: '8.3.10', file: 'Dockerfile' },
      { runtime: 'php', version: '8.3.10', file: '.github/workflows/ci.yml' },
    ])
    expect(found).toEqual([
      {
        code: 'RUNTIME_VULNERABLE',
        severity: 'error',
        category: 'security',
        message:
          'PHP 8.3.10 (pinned in .github/workflows/ci.yml and Dockerfile) misses 10 security releases, rated up to critical; the latest is 8.3.36 (2026-10-21)',
        hint: 'Upgrade to PHP 8.3.36 or later, which fixes CVE-2026-109618 and CVE-2026-109619: https://www.php.net/archive/2026.php',
        files: ['.github/workflows/ci.yml', 'Dockerfile'],
        subject: 'php@8.3.10',
      },
    ])
  })

  it('reports other missed fixes as warnings, rated when the project rates them', () => {
    const found = findVulnerableRuntimes([
      { runtime: 'go', version: '1.26.2', file: 'worker/Dockerfile' },
      { runtime: 'node', version: '22.20.0', file: '.nvmrc' },
      { runtime: 'node', version: '22.23.4', file: 'ci.yml' },
    ])
    expect(found.map((d) => [d.severity, d.message])).toEqual([
      [
        'warning',
        'Node.js 22.20.0 (pinned in .nvmrc) misses 5 security releases, rated up to high; the latest is 22.23.4 (2026-10-21)',
      ],
      [
        'warning',
        'Go 1.26.2 (pinned in worker/Dockerfile) misses 6 security releases; the latest is 1.26.10 (2026-10-19)',
      ],
    ])
  })

  it('reads the table it is given', () => {
    const table = {
      node: [],
      go: [],
      php: [{ date: '2030-01-01', fixes: [{ version: '9.0.1', severity: 'low' as const }], url: 'https://php.test' }],
    }
    const [found] = findVulnerableRuntimes([{ runtime: 'php', version: '9.0.0', file: '.php-version' }], table)
    expect(found?.message).toBe(
      'PHP 9.0.0 (pinned in .php-version) misses 1 security release, rated up to low; the latest is 9.0.1 (2030-01-01)',
    )
  })
})

describe('RUNTIME_VULNERABLE in a scan', () => {
  it('reports pinned images and CI versions, not floating tags or ranges', async () => {
    const result = await scanDir(
      await makeProject({
        'composer.json': '{"require": {"php": "^8.3"}}',
        Dockerfile: 'FROM php:8.3.10-fpm\n',
        'docker/Dockerfile': 'FROM php:8.4-cli\n',
        '.github/workflows/ci.yml':
          'on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: shivammathur/setup-php@v2\n        with:\n          php-version: "8.3.10"\n',
      }),
    )
    const found = result.doctor.diagnostics.filter((d) => d.code === 'RUNTIME_VULNERABLE')
    expect(found.map((d) => [d.subject, d.files])).toEqual([['php@8.3.10', ['.github/workflows/ci.yml', 'Dockerfile']]])
    expect(result.runtimes.find((runtime) => runtime.id === 'php')?.version).toBe('^8.3')
  })

  it('cannot be turned off by the project config', async () => {
    const result = await scanDir(
      await makeProject({
        'repolens.config.json': '{"doctor": {"rules": {"RUNTIME_VULNERABLE": "off"}}}',
        '.php-version': '8.3.10\n',
      }),
    )
    expect(result.doctor.diagnostics.map((d) => d.code)).toContain('RUNTIME_VULNERABLE')
  })
})
