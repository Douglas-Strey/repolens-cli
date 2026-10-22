import { gt, valid } from 'semver'
import type { Diagnostic, DoctorRule, Runtime, Severity } from '../../types.ts'
import { compareText } from '../../utils/compare.ts'
import {
  type AdvisorySeverity,
  SECURITY_RELEASES,
  type SecurityRelease,
  type VulnerabilityRuntime,
} from './security-releases.ts'
import { formatList, safeText, uniqueSorted } from './shared.ts'

const RUNTIME_NAMES: Readonly<Record<VulnerabilityRuntime, string>> = { node: 'Node.js', go: 'Go', php: 'PHP' }
const RUNTIME_ORDER: readonly VulnerabilityRuntime[] = ['node', 'go', 'php']
const SEVERITY_RANK: Readonly<Record<AdvisorySeverity, number>> = { low: 0, medium: 1, high: 2, critical: 3 }

/**
 * Fields that name a version without running it: go.mod's `go` and
 * `toolchain` lines are minimums (a newer local toolchain builds the module),
 * and Composer's `config.platform.php` is what dependencies are resolved for.
 */
const NOT_RUNNING: ReadonlySet<string> = new Set(['go directive', 'toolchain', 'config.platform.php'])

export interface RuntimePin {
  runtime: VulnerabilityRuntime
  /** Full version, "8.3.10". */
  version: string
  file: string
}

/**
 * Exact, complete version pins of Node.js, Go and PHP. A partial pin
 * ("8.3", "php:8.3-fpm") follows its line's latest patch, so it is left out,
 * like ranges and aliases.
 */
export function runtimePins(runtimes: readonly Runtime[]): RuntimePin[] {
  const pins: RuntimePin[] = []
  const seen = new Set<string>()
  for (const runtime of runtimes) {
    if (!(RUNTIME_ORDER as readonly string[]).includes(runtime.id)) continue
    for (const source of runtime.sources) {
      if (source.kind !== 'exact' || !source.version || NOT_RUNNING.has(source.field ?? '')) continue
      const version = source.version.replace(/^v/, '')
      if (!/^\d+\.\d+\.\d+$/.test(version) || !valid(version)) continue
      const key = `${runtime.id}\0${version}\0${source.file}`
      if (seen.has(key)) continue
      seen.add(key)
      pins.push({ runtime: runtime.id as VulnerabilityRuntime, version, file: source.file })
    }
  }
  return pins
}

/** Release line of a version: the major for Node.js, major.minor for Go and PHP. */
export function releaseLine(runtime: VulnerabilityRuntime, version: string): string {
  const [major, minor] = version.split('.')
  return runtime === 'node' ? `${major}` : `${major}.${minor}`
}

export interface MissedFix {
  version: string
  severity?: AdvisorySeverity
  release: SecurityRelease
}

/** Security releases of `version`'s line that came after it, oldest first. */
export function missedFixes(
  runtime: VulnerabilityRuntime,
  version: string,
  releases: readonly SecurityRelease[] = SECURITY_RELEASES[runtime],
): MissedFix[] {
  const line = releaseLine(runtime, version)
  const out: MissedFix[] = []
  for (const release of releases) {
    for (const fix of release.fixes) {
      if (releaseLine(runtime, fix.version) === line && gt(fix.version, version)) {
        out.push({ version: fix.version, ...(fix.severity ? { severity: fix.severity } : {}), release })
      }
    }
  }
  return out
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/**
 * One diagnostic per runtime version pinned with known vulnerabilities:
 * newer security releases exist on its line. An error when one of them fixes
 * a critical vulnerability, a warning otherwise.
 */
export function findVulnerableRuntimes(
  pins: readonly RuntimePin[],
  table: Readonly<Record<VulnerabilityRuntime, readonly SecurityRelease[]>> = SECURITY_RELEASES,
): Diagnostic[] {
  const filesByPin = new Map<string, { runtime: VulnerabilityRuntime; version: string; files: string[] }>()
  for (const pin of pins) {
    const key = `${pin.runtime}\0${pin.version}`
    const entry = filesByPin.get(key) ?? { runtime: pin.runtime, version: pin.version, files: [] }
    entry.files.push(pin.file)
    filesByPin.set(key, entry)
  }
  const ordered = [...filesByPin.values()].sort(
    (a, b) => RUNTIME_ORDER.indexOf(a.runtime) - RUNTIME_ORDER.indexOf(b.runtime) || compareText(a.version, b.version),
  )

  const out: Diagnostic[] = []
  for (const { runtime, version, files } of ordered) {
    const missed = missedFixes(runtime, version, table[runtime])
    if (missed.length === 0) continue
    const latest = missed.reduce((best, fix) => (gt(fix.version, best.version) ? fix : best))
    const highest = missed.reduce<AdvisorySeverity | undefined>(
      (best, fix) =>
        fix.severity && (!best || SEVERITY_RANK[fix.severity] > SEVERITY_RANK[best]) ? fix.severity : best,
      undefined,
    )
    const name = RUNTIME_NAMES[runtime]
    const pinnedIn = uniqueSorted(files)
    const shown = safeText(version, 40)
    const rated = highest ? `, rated up to ${highest}` : ''
    const fixes = latest.release.cves?.length ? `, which fixes ${formatList([...latest.release.cves])}` : ''
    const severity: Severity = highest === 'critical' ? 'error' : 'warning'
    out.push({
      code: 'RUNTIME_VULNERABLE',
      severity,
      category: 'security',
      message: `${name} ${shown} (pinned in ${formatList(pinnedIn)}) misses ${plural(missed.length, 'security release')}${rated}; the latest is ${latest.version} (${latest.release.date})`,
      hint: `Upgrade to ${name} ${latest.version} or later${fixes}: ${latest.release.url}`,
      files: pinnedIn,
      subject: `${runtime}@${shown}`,
    })
  }
  return out
}

export const runtimeVulnerable: DoctorRule = {
  code: 'RUNTIME_VULNERABLE',
  category: 'security',
  title: 'Pinned runtimes have no known vulnerabilities',
  applies: (scan) => runtimePins(scan.runtimes).length > 0,
  check: (scan) => findVulnerableRuntimes(runtimePins(scan.runtimes)),
}
