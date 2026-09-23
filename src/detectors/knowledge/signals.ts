/**
 * Evidence handling shared by the framework and tool detectors.
 *
 * Detectors turn every observation (a dependency, a config file, a script)
 * into a `Signal`; `mergeSignals` folds all signals for one framework or
 * tool into packages, confidence, version and evidence.
 */
import type { DependencyRef, DependencyType } from '../../facts/dependencies.ts'
import type { Confidence } from '../../types.ts'
import { compareText } from '../../utils/compare.ts'
import { REDACTED, redactCommand } from '../../utils/redact.ts'
import { cleanVersion } from '../../utils/versions.ts'

/**
 * Higher is stronger. Named "strength" rather than "rank": other tables in the
 * code base rank the most important item first (0 = error, 0 = high).
 */
export const CONFIDENCE_STRENGTH: Readonly<Record<Confidence, number>> = { high: 2, medium: 1, low: 0 }

/** Evidence lists longer than this are cut and end with "and N more". */
export const MAX_EVIDENCE = 6

export interface Signal {
  /** Package directory the observation belongs to ("." = root). */
  package: string
  confidence: Confidence
  /** Short human-readable description, never containing secret values. */
  evidence: string
  /** Config file behind the observation, if any. */
  configFile?: string
  /** Cleaned display version, only for dependency observations. */
  version?: string
}

export interface MergedSignals {
  packages: string[]
  confidence: Confidence
  evidence: string[]
  configFiles: string[]
  version?: string
}

export function maxConfidence(a: Confidence, b: Confidence): Confidence {
  return CONFIDENCE_STRENGTH[a] >= CONFIDENCE_STRENGTH[b] ? a : b
}

export function minConfidence(a: Confidence, b: Confidence): Confidence {
  return CONFIDENCE_STRENGTH[a] <= CONFIDENCE_STRENGTH[b] ? a : b
}

/** Plain code-unit order, except that the root "." always comes first. */
export function comparePackageDirs(a: string, b: string): number {
  if (a === b) return 0
  if (a === '.') return -1
  if (b === '.') return 1
  return compareText(a, b)
}

function unique<T>(items: Iterable<T>): T[] {
  return [...new Set(items)]
}

/**
 * Fold signals into one finding. Confidence is the strongest signal, the
 * version comes from the strongest signal that has one, and evidence is
 * listed strongest first (stable within a confidence level).
 */
export function mergeSignals(signals: readonly Signal[]): MergedSignals | null {
  if (signals.length === 0) return null
  const ranked = signals
    .map((signal, index) => ({ signal, index }))
    .sort(
      (a, b) =>
        CONFIDENCE_STRENGTH[b.signal.confidence] - CONFIDENCE_STRENGTH[a.signal.confidence] || a.index - b.index,
    )
    .map(({ signal }) => signal)

  const strongest = ranked[0] as Signal
  const version = ranked.find((signal) => signal.version !== undefined)?.version
  const evidence = unique(ranked.map((signal) => signal.evidence))
  const merged: MergedSignals = {
    packages: unique(signals.map((signal) => signal.package)).sort(comparePackageDirs),
    confidence: strongest.confidence,
    evidence:
      evidence.length > MAX_EVIDENCE
        ? [...evidence.slice(0, MAX_EVIDENCE - 1), `and ${evidence.length - MAX_EVIDENCE + 1} more`]
        : evidence,
    configFiles: unique(signals.flatMap((signal) => (signal.configFile ? [signal.configFile] : []))).sort(compareText),
  }
  if (version !== undefined) merged.version = version
  return merged
}

// ---------------------------------------------------------------------------
// Display helpers (untrusted text → safe evidence)
// ---------------------------------------------------------------------------

/** Characters a plain semver range, Go version or dist-tag consists of. URLs and paths are excluded on purpose. */
const SAFE_RANGE = /^[\w.^~<>=|*+ :-]{1,64}$/
const SAFE_VERSION = /^[\w.^~<>=|*+ -]{1,64}$/
const SAFE_NAME = /^[@\w./-]{1,214}$/

function survivesRedaction(text: string): boolean {
  return !redactCommand(text).includes(REDACTED)
}

/**
 * A declared range as it may appear in evidence, or undefined when it is not
 * a plain range (git URLs, tarball URLs and file paths can carry credentials).
 */
export function displayRange(range: string): string | undefined {
  const trimmed = range.trim()
  return SAFE_RANGE.test(trimmed) && survivesRedaction(trimmed) ? trimmed : undefined
}

/** Cleaned version for the `version` field, or undefined when the range is not a plain version. */
export function displayVersion(range: string | undefined): string | undefined {
  const version = cleanVersion(range)
  return version !== undefined && SAFE_VERSION.test(version) && survivesRedaction(version) ? version : undefined
}

/** Package or module name as it may appear in evidence. */
export function displayName(name: string): string | undefined {
  return SAFE_NAME.test(name) && survivesRedaction(name) ? name : undefined
}

/** package.json script names are free text; keep them short, printable and free of credential formats. */
export function displayScriptName(name: string): string {
  const printable = redactCommand(name.replace(/[^\w:.@/+-]/g, '?'))
  return printable.length > 40 ? `${printable.slice(0, 39)}…` : printable
}

const DEPENDENCY_LABELS: Readonly<Record<DependencyType, string>> = {
  dependencies: 'dependency',
  devDependencies: 'devDependency',
  peerDependencies: 'peerDependency',
  optionalDependencies: 'optionalDependency',
  go: 'dependency',
}

/** e.g. "dependency nuxt@^4.1.2 in apps/web/package.json" or "indirect dependency github.com/x/y@v1.2.0 in go.mod". */
export function dependencyEvidence(ref: DependencyRef): string {
  const label = ref.indirect ? 'indirect dependency' : DEPENDENCY_LABELS[ref.type]
  const name = displayName(ref.name) ?? 'package'
  const range = displayRange(ref.range)
  return `${label} ${name}${range ? `@${range}` : ''} in ${ref.file}`
}

export function configEvidence(path: string, note?: string): string {
  return `config file ${path}${note ? ` (${note})` : ''}`
}
