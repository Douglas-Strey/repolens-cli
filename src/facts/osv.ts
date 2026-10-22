/**
 * Known vulnerabilities of locked packages, from OSV.dev. This is the only
 * code in RepoLens that makes network requests, and it only runs for
 * `repolens doctor --online`. It sends each package's ecosystem, name and
 * version, nothing else: no file contents, no paths, no project name.
 */
import { gt, lt, valid } from 'semver'
import { isRecord } from '../core/parse.ts'
import { VERSION } from '../version.ts'
import { exactVersion, type LockedPackage, type PackageEcosystem } from './lockfiles.ts'

export const OSV_API = 'https://api.osv.dev/v1'
/** OSV.dev's batch endpoint takes up to 1,000 queries per request. */
const BATCH_SIZE = 1000
/** Most advisories whose details are fetched in one run. */
export const MAX_ADVISORIES = 500
const DETAIL_CONCURRENCY = 8
const REQUEST_TIMEOUT_MS = 15_000
/** Most pages followed for one query; a package with more advisories than that is cut short. */
const MAX_PAGES = 10

export type OsvSeverity = 'critical' | 'high' | 'medium' | 'low'

export interface OsvAdvisory {
  /** OSV id, e.g. "GHSA-29mw-wpgm-hmr9" or "GO-2026-1234". */
  id: string
  /** CVE ids among the aliases. */
  cves: string[]
  /** The GitHub Advisory Database rating, when the advisory has one. */
  severity?: OsvSeverity
  /** Lowest version that fixes it for the queried version; absent when no fix is known. */
  fixed?: string
}

export interface OsvOptions {
  /** Defaults to the global fetch. */
  fetch?: typeof fetch
  timeoutMs?: number
  maxAdvisories?: number
  debug?: (message: string) => void
}

export interface OsvResult {
  /** Advisories per package key (see packageKey), only for packages that have some. */
  advisories: Map<string, OsvAdvisory[]>
  /** Advisories that exist but were not fetched (over MAX_ADVISORIES). */
  skipped: number
}

export class OsvError extends Error {}

export function packageKey(pkg: Pick<LockedPackage, 'ecosystem' | 'name' | 'version'>): string {
  return `${pkg.ecosystem}\0${pkg.name}\0${pkg.version}`
}

const SEVERITIES: Readonly<Record<string, OsvSeverity>> = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MODERATE: 'medium',
  MEDIUM: 'medium',
  LOW: 'low',
}

async function request(options: OsvOptions, path: string, body?: unknown): Promise<unknown> {
  const doFetch = options.fetch ?? fetch
  let response: Response
  try {
    response = await doFetch(`${OSV_API}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'user-agent': `repolens/${VERSION} (+https://github.com/Douglas-Strey/repolens-cli)`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    const reason = (error as Error)?.name === 'TimeoutError' ? 'timed out' : 'could not connect'
    throw new OsvError(`OSV.dev ${reason}`)
  }
  if (!response.ok) throw new OsvError(`OSV.dev answered HTTP ${response.status}`)
  try {
    return await response.json()
  } catch {
    throw new OsvError('OSV.dev sent an invalid response')
  }
}

/** Advisory ids per package, following page tokens. */
async function queryIds(packages: readonly LockedPackage[], options: OsvOptions): Promise<Map<string, Set<string>>> {
  const ids = new Map<string, Set<string>>()
  for (let start = 0; start < packages.length; start += BATCH_SIZE) {
    let pending = packages
      .slice(start, start + BATCH_SIZE)
      .map((pkg) => ({ pkg, token: undefined as string | undefined }))
    for (let page = 0; pending.length > 0 && page < MAX_PAGES; page++) {
      const body = {
        queries: pending.map(({ pkg, token }) => ({
          package: { ecosystem: pkg.ecosystem, name: pkg.name },
          version: pkg.version,
          ...(token ? { page_token: token } : {}),
        })),
      }
      const response = await request(options, '/querybatch', body)
      const results = isRecord(response) && Array.isArray(response.results) ? response.results : null
      if (!results || results.length !== pending.length) throw new OsvError('OSV.dev sent an invalid response')
      const next: typeof pending = []
      results.forEach((result, index) => {
        const { pkg } = pending[index] as (typeof pending)[number]
        const vulns = isRecord(result) && Array.isArray(result.vulns) ? result.vulns : []
        for (const vuln of vulns) {
          const id = isRecord(vuln) && typeof vuln.id === 'string' ? vuln.id : null
          if (!id) continue
          const key = packageKey(pkg)
          const set = ids.get(key) ?? new Set<string>()
          set.add(id)
          ids.set(key, set)
        }
        const token = isRecord(result) && typeof result.next_page_token === 'string' ? result.next_page_token : ''
        if (token) next.push({ pkg, token })
      })
      pending = next
    }
  }
  return ids
}

/** Versions in OSV ranges carry a "v" for Go; compare without it. */
function comparable(version: string): string | null {
  return exactVersion(version)
}

/**
 * The fix for `version` in an advisory's ranges for this package: the
 * `fixed` event of the range that contains it. Only SEMVER and ECOSYSTEM
 * ranges are read; versions that aren't semver can't be compared, so they get
 * no fix.
 */
export function fixedVersion(vuln: unknown, pkg: LockedPackage): string | undefined {
  if (!isRecord(vuln) || !Array.isArray(vuln.affected)) return undefined
  const current = comparable(pkg.version)
  if (!current) return undefined
  let best: string | undefined
  for (const affected of vuln.affected) {
    if (!isRecord(affected) || !isRecord(affected.package)) continue
    if (affected.package.name !== pkg.name || affected.package.ecosystem !== pkg.ecosystem) continue
    for (const range of Array.isArray(affected.ranges) ? affected.ranges : []) {
      if (!isRecord(range) || (range.type !== 'SEMVER' && range.type !== 'ECOSYSTEM') || !Array.isArray(range.events)) {
        continue
      }
      let introduced: string | null = null
      for (const event of range.events) {
        if (!isRecord(event)) continue
        if (typeof event.introduced === 'string') {
          introduced = event.introduced === '0' ? '0.0.0' : comparable(event.introduced)
        } else if (typeof event.fixed === 'string' && introduced !== null) {
          const fixed = comparable(event.fixed)
          if (fixed && !lt(current, introduced) && lt(current, fixed) && (!best || lt(fixed, best))) best = fixed
          introduced = null
        }
      }
    }
  }
  return best
}

function advisoryFrom(vuln: unknown, id: string, pkg: LockedPackage): OsvAdvisory {
  const aliases = isRecord(vuln) && Array.isArray(vuln.aliases) ? vuln.aliases : []
  const cves = aliases.filter((alias): alias is string => typeof alias === 'string' && /^CVE-\d{4}-\d+$/.test(alias))
  const rating =
    isRecord(vuln) && isRecord(vuln.database_specific) && typeof vuln.database_specific.severity === 'string'
      ? SEVERITIES[vuln.database_specific.severity.toUpperCase()]
      : undefined
  const fixed = fixedVersion(vuln, pkg)
  return { id, cves: [...new Set(cves)].sort(), ...(rating ? { severity: rating } : {}), ...(fixed ? { fixed } : {}) }
}

/**
 * Look the packages up in OSV.dev. Throws OsvError when OSV.dev can't be
 * reached or answers with something unusable; the caller reports it.
 */
export async function queryOsv(packages: readonly LockedPackage[], options: OsvOptions = {}): Promise<OsvResult> {
  const ids = await queryIds(packages, options)
  const unique = [...new Set([...ids.values()].flatMap((set) => [...set]))].sort()
  const limit = options.maxAdvisories ?? MAX_ADVISORIES
  const fetched = unique.slice(0, limit)
  if (unique.length > limit) options.debug?.(`osv: ${unique.length - limit} advisories over the limit were not fetched`)

  const details = new Map<string, unknown>()
  for (let start = 0; start < fetched.length; start += DETAIL_CONCURRENCY) {
    const chunk = fetched.slice(start, start + DETAIL_CONCURRENCY)
    const docs = await Promise.all(chunk.map((id) => request(options, `/vulns/${encodeURIComponent(id)}`)))
    chunk.forEach((id, index) => {
      details.set(id, docs[index])
    })
  }

  const advisories = new Map<string, OsvAdvisory[]>()
  const byKey = new Map(packages.map((pkg) => [packageKey(pkg), pkg]))
  for (const [key, set] of ids) {
    const pkg = byKey.get(key)
    if (!pkg) continue
    const list = [...set]
      .filter((id) => details.has(id))
      .sort()
      .map((id) => advisoryFrom(details.get(id), id, pkg))
    if (list.length > 0) advisories.set(key, list)
  }
  return { advisories, skipped: unique.length - fetched.length }
}

/** The version that fixes every advisory, or null when one of them has no fix. */
export function versionFixingAll(advisories: readonly OsvAdvisory[]): string | null {
  let highest: string | null = null
  for (const advisory of advisories) {
    if (!advisory.fixed || !valid(advisory.fixed)) return null
    if (!highest || gt(advisory.fixed, highest)) highest = advisory.fixed
  }
  return highest
}

export type { PackageEcosystem }
