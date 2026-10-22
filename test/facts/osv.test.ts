import { afterEach, describe, expect, it, vi } from 'vitest'
import { findVulnerableDependencies } from '../../src/doctor/rules/vulnerabilities.ts'
import type { LockedPackage } from '../../src/facts/lockfiles.ts'
import { fixedVersion, OsvError, packageKey, queryOsv, versionFixingAll } from '../../src/facts/osv.ts'
import { makeProject, runCli, scanDir } from '../helpers.ts'

const lodash: LockedPackage = { ecosystem: 'npm', name: 'lodash', version: '4.17.20' }
const net: LockedPackage = { ecosystem: 'Go', name: 'golang.org/x/net', version: '0.7.0' }

const VULNS: Record<string, unknown> = {
  'GHSA-aaaa': {
    id: 'GHSA-aaaa',
    aliases: ['CVE-2021-0001'],
    database_specific: { severity: 'HIGH' },
    affected: [
      {
        package: { ecosystem: 'npm', name: 'lodash' },
        ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '4.17.21' }] }],
      },
    ],
  },
  'GHSA-bbbb': {
    id: 'GHSA-bbbb',
    aliases: ['CVE-2026-0002', 'GHSA-other'],
    database_specific: { severity: 'CRITICAL' },
    affected: [
      {
        package: { ecosystem: 'npm', name: 'lodash' },
        ranges: [
          { type: 'SEMVER', events: [{ introduced: '3.0.0' }, { fixed: '3.10.2' }] },
          { type: 'SEMVER', events: [{ introduced: '4.0.0' }, { fixed: '4.18.0' }] },
        ],
      },
    ],
  },
  'GO-2026-1': {
    id: 'GO-2026-1',
    aliases: ['CVE-2026-0003'],
    affected: [
      {
        package: { ecosystem: 'Go', name: 'golang.org/x/net' },
        ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { last_affected: '0.9.0' }] }],
      },
    ],
  },
}

/** A fake OSV.dev: lodash has two advisories (the second on a second page), x/net one. */
function fakeOsv() {
  const calls: Array<{ url: string; body?: unknown; headers: Record<string, string> }> = []
  const fake = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url: String(url), body, headers: (init?.headers ?? {}) as Record<string, string> })
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 })
    if (String(url).endsWith('/querybatch')) {
      const results = body.queries.map((query: { package: { name: string }; page_token?: string }) => {
        if (query.package.name === 'lodash') {
          return query.page_token
            ? { vulns: [{ id: 'GHSA-bbbb' }] }
            : { vulns: [{ id: 'GHSA-aaaa' }], next_page_token: 'p2' }
        }
        if (query.package.name === 'golang.org/x/net') return { vulns: [{ id: 'GO-2026-1' }] }
        return {}
      })
      return json({ results })
    }
    const id = decodeURIComponent(String(url).split('/vulns/')[1] ?? '')
    return VULNS[id] ? json(VULNS[id]) : new Response('not found', { status: 404 })
  })
  return { fake: fake as unknown as typeof fetch, calls }
}

afterEach(() => vi.unstubAllGlobals())

describe('queryOsv', () => {
  it('batches the packages, follows page tokens and fetches each advisory once', async () => {
    const { fake, calls } = fakeOsv()
    const clean: LockedPackage = { ecosystem: 'npm', name: 'left-pad', version: '1.3.0' }
    const result = await queryOsv([lodash, net, clean], { fetch: fake })
    expect(result.skipped).toBe(0)
    expect(result.advisories.get(packageKey(lodash))).toEqual([
      { id: 'GHSA-aaaa', cves: ['CVE-2021-0001'], severity: 'high', fixed: '4.17.21' },
      { id: 'GHSA-bbbb', cves: ['CVE-2026-0002'], severity: 'critical', fixed: '4.18.0' },
    ])
    expect(result.advisories.get(packageKey(net))).toEqual([{ id: 'GO-2026-1', cves: ['CVE-2026-0003'] }])
    expect(result.advisories.has(packageKey(clean))).toBe(false)
    // Only ecosystem, name and version leave the machine.
    const first = calls[0]?.body as { queries: unknown[] }
    expect(first.queries[0]).toEqual({ package: { ecosystem: 'npm', name: 'lodash' }, version: '4.17.20' })
    expect(calls[1]?.body).toEqual({
      queries: [{ package: { ecosystem: 'npm', name: 'lodash' }, version: '4.17.20', page_token: 'p2' }],
    })
    expect(calls.filter((call) => call.url.includes('/vulns/')).map((call) => call.url.split('/vulns/')[1])).toEqual([
      'GHSA-aaaa',
      'GHSA-bbbb',
      'GO-2026-1',
    ])
    expect(calls[0]?.headers['user-agent']).toMatch(/^repolens\//)
  })

  it('stops at the advisory limit and says how many were skipped', async () => {
    const { fake } = fakeOsv()
    const result = await queryOsv([lodash, net], { fetch: fake, maxAdvisories: 1 })
    expect(result.skipped).toBe(2)
    expect([...result.advisories.values()].flat().map((advisory) => advisory.id)).toEqual(['GHSA-aaaa'])
  })

  it.each([
    ['an HTTP error', async () => new Response('down', { status: 503 }), 'OSV.dev answered HTTP 503'],
    ['a network failure', async () => Promise.reject(new TypeError('fetch failed')), 'OSV.dev could not connect'],
    ['invalid JSON', async () => new Response('<html>', { status: 200 }), 'OSV.dev sent an invalid response'],
    ['a wrong shape', async () => new Response('{"results": []}', { status: 200 }), 'OSV.dev sent an invalid response'],
  ])('throws OsvError on %s', async (_label, impl, message) => {
    const promise = queryOsv([lodash], { fetch: vi.fn(impl) as unknown as typeof fetch })
    await expect(promise).rejects.toBeInstanceOf(OsvError)
    await expect(promise).rejects.toThrow(message)
  })
})

describe('fixedVersion and versionFixingAll', () => {
  it('uses the range that contains the version', () => {
    expect(fixedVersion(VULNS['GHSA-bbbb'], lodash)).toBe('4.18.0')
    expect(fixedVersion(VULNS['GHSA-bbbb'], { ...lodash, version: '3.9.0' })).toBe('3.10.2')
    expect(fixedVersion(VULNS['GHSA-bbbb'], { ...lodash, version: '4.18.0' })).toBeUndefined()
    expect(fixedVersion(VULNS['GO-2026-1'], net)).toBeUndefined()
    expect(fixedVersion(VULNS['GHSA-aaaa'], { ...lodash, name: 'lodash-es' })).toBeUndefined()
  })

  it('needs a fix for every advisory', () => {
    expect(
      versionFixingAll([
        { id: 'a', cves: [], fixed: '4.17.21' },
        { id: 'b', cves: [], fixed: '4.18.0' },
      ]),
    ).toBe('4.18.0')
    expect(
      versionFixingAll([
        { id: 'a', cves: [], fixed: '4.17.21' },
        { id: 'b', cves: [] },
      ]),
    ).toBeNull()
  })
})

describe('DEPENDENCY_VULNERABLE', () => {
  const locked = {
    packages: [
      { ...net, lockfiles: ['go.mod'] },
      { ...lodash, lockfiles: ['package-lock.json'] },
    ],
    lockfiles: ['go.mod', 'package-lock.json'],
  }

  it('reports each vulnerable package version, critical as an error, unrated as a warning', () => {
    const advisories = new Map([
      [
        packageKey(lodash),
        [
          { id: 'GHSA-aaaa', cves: ['CVE-2021-0001'], severity: 'high' as const, fixed: '4.17.21' },
          { id: 'GHSA-bbbb', cves: ['CVE-2026-0002'], severity: 'critical' as const, fixed: '4.18.0' },
        ],
      ],
      [packageKey(net), [{ id: 'GO-2026-1', cves: ['CVE-2026-0003'] }]],
    ])
    expect(findVulnerableDependencies(locked, advisories)).toEqual([
      {
        code: 'DEPENDENCY_VULNERABLE',
        severity: 'warning',
        category: 'security',
        message: 'golang.org/x/net 0.7.0 (Go module, go.mod) has 1 known vulnerability: GO-2026-1 (CVE-2026-0003)',
        hint: 'No release of golang.org/x/net fixes all of them yet: https://osv.dev/vulnerability/GO-2026-1',
        files: ['go.mod'],
        subject: 'Go:golang.org/x/net@0.7.0',
      },
      {
        code: 'DEPENDENCY_VULNERABLE',
        severity: 'error',
        category: 'security',
        message:
          'lodash 4.17.20 (npm, package-lock.json) has 2 known vulnerabilities, rated up to critical: GHSA-aaaa (CVE-2021-0001) and GHSA-bbbb (CVE-2026-0002)',
        hint: 'Upgrade lodash to 4.18.0 or later',
        files: ['package-lock.json'],
        subject: 'npm:lodash@4.17.20',
      },
    ])
  })

  it('rates a package info when every advisory is low, and lists at most four ids', () => {
    const low = Array.from({ length: 6 }, (_, i) => ({
      id: `GHSA-${i}`,
      cves: [],
      severity: 'low' as const,
      fixed: '5.0.0',
    }))
    const [found] = findVulnerableDependencies(locked, new Map([[packageKey(lodash), low]]))
    expect(found?.severity).toBe('info')
    expect(found?.message).toContain('GHSA-0, GHSA-1, GHSA-2, GHSA-3 and 2 more')
  })

  it('is skipped without --online, and makes no request', async () => {
    const fake = vi.fn()
    vi.stubGlobal('fetch', fake)
    const dir = await makeProject({
      'package-lock.json': JSON.stringify({ packages: { 'node_modules/lodash': { version: '4.17.20' } } }),
    })
    const result = await scanDir(dir)
    expect(fake).not.toHaveBeenCalled()
    expect(result.doctor.checks.find((check) => check.code === 'DEPENDENCY_VULNERABLE')?.status).toBe('skipped')
  })

  it('looks the lockfiles up with --online', async () => {
    vi.stubGlobal('fetch', fakeOsv().fake)
    const dir = await makeProject({
      'package-lock.json': JSON.stringify({ packages: { 'node_modules/lodash': { version: '4.17.20' } } }),
    })
    const run = await runCli(['doctor', '--online', '--json', dir])
    const doc = JSON.parse(run.stdout)
    expect(
      doc.diagnostics
        .filter((d: { code: string }) => d.code === 'DEPENDENCY_VULNERABLE')
        .map((d: { subject: string }) => d.subject),
    ).toEqual(['npm:lodash@4.17.20'])
    expect(run.code).toBe(1)
  })

  it('warns and skips the check when OSV.dev cannot be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('fetch failed'))),
    )
    const dir = await makeProject({
      'composer.lock': JSON.stringify({ packages: [{ name: 'a/b', version: '1.0.0' }] }),
    })
    const result = await scanDir(dir, { online: true })
    expect(result.meta.warnings).toContainEqual({
      kind: 'error',
      message: "Couldn't check dependencies for known vulnerabilities: OSV.dev could not connect",
    })
    expect(result.doctor.checks.find((check) => check.code === 'DEPENDENCY_VULNERABLE')?.status).toBe('skipped')
  })

  it('is only accepted by doctor', async () => {
    const run = await runCli(['--online', await makeProject({ 'a.txt': '' })])
    expect(run.code).toBe(2)
    expect(run.stderr).toContain('--online only applies to doctor')
  })
})
