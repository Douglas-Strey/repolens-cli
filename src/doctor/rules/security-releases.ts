/**
 * Security releases of the runtimes RepoLens reads pins for, curated from
 * each project's own announcements. RUNTIME_VULNERABLE compares exact pins
 * with this table, so a scan stays offline and deterministic; the table is
 * as current as the RepoLens release that ships it.
 *
 * Only what the announcements state is recorded: the fixed version of each
 * release line, the date, a link and, when the project rates it, the highest
 * severity fixed for that line. CVE ids are listed when the announcement
 * names them for every line of the release.
 *
 * Updating: add new releases at the end of a runtime's list, move
 * SECURITY_DATA_DATE, and run the tests (they check the table's shape).
 */

export type AdvisorySeverity = 'critical' | 'high' | 'medium' | 'low'

export interface SecurityFix {
  /** Fixed version, e.g. "8.3.36". */
  version: string
  /** Highest severity fixed for this line, when the project states it. */
  severity?: AdvisorySeverity
}

export interface SecurityRelease {
  /** Release date, YYYY-MM-DD. */
  date: string
  fixes: readonly SecurityFix[]
  /** CVE ids fixed on every line of the release, when the announcement names them. */
  cves?: readonly string[]
  /** The announcement. */
  url: string
}

export type VulnerabilityRuntime = 'node' | 'go' | 'php'

/** Date the table was last checked against the announcements. */
export const SECURITY_DATA_DATE = '2026-10-22'

const fix = (version: string, severity?: AdvisorySeverity): SecurityFix =>
  severity ? { version, severity } : { version }
const all = (severity: AdvisorySeverity | undefined, ...versions: string[]) => versions.map((v) => fix(v, severity))

const NODE_BLOG = 'https://nodejs.org/en/blog/vulnerability'
const PHP_2024 = 'https://www.php.net/archive/2024.php'
const PHP_2025 = 'https://www.php.net/archive/2025.php'
const PHP_2026 = 'https://www.php.net/archive/2026.php'
const GO_RELEASES = 'https://go.dev/doc/devel/release'

/** Security releases since 2024, oldest first. Release lines are majors for Node.js, minors for Go and PHP. */
export const SECURITY_RELEASES: Readonly<Record<VulnerabilityRuntime, readonly SecurityRelease[]>> = {
  node: [
    {
      date: '2024-02-14',
      fixes: all('high', '18.19.1', '20.11.1', '21.6.2'),
      url: `${NODE_BLOG}/february-2024-security-releases`,
    },
    {
      date: '2024-04-03',
      fixes: all('high', '18.20.1', '20.12.1', '21.7.2'),
      url: `${NODE_BLOG}/april-2024-security-releases`,
    },
    {
      date: '2024-04-10',
      fixes: all('high', '18.20.2', '20.12.2', '21.7.3'),
      url: `${NODE_BLOG}/april-2024-security-releases-2`,
    },
    {
      date: '2024-07-08',
      fixes: all('high', '18.20.4', '20.15.1', '22.4.1'),
      url: `${NODE_BLOG}/july-2024-security-releases`,
    },
    {
      date: '2025-01-21',
      fixes: [fix('18.20.6', 'medium'), ...all('high', '20.18.2', '22.13.1', '23.6.1')],
      url: `${NODE_BLOG}/january-2025-security-releases`,
    },
    {
      date: '2025-05-14',
      fixes: all('high', '20.19.2', '22.15.1', '23.11.1', '24.0.2'),
      url: `${NODE_BLOG}/may-2025-security-releases`,
    },
    {
      date: '2025-07-15',
      fixes: all('high', '20.19.4', '22.17.1', '24.4.1'),
      url: `${NODE_BLOG}/july-2025-security-releases`,
    },
    {
      date: '2026-01-13',
      fixes: all('high', '20.20.0', '22.22.0', '24.13.0', '25.3.0'),
      url: `${NODE_BLOG}/december-2025-security-releases`,
    },
    {
      date: '2026-03-24',
      fixes: all('high', '20.20.2', '22.22.2', '24.14.1', '25.8.2'),
      url: `${NODE_BLOG}/march-2026-security-releases`,
    },
    {
      date: '2026-06-18',
      fixes: all('high', '22.23.0', '24.17.0', '26.3.1'),
      url: `${NODE_BLOG}/june-2026-security-releases`,
    },
    {
      date: '2026-07-29',
      fixes: all('high', '22.23.2', '24.18.1', '26.5.1'),
      url: `${NODE_BLOG}/july-2026-security-releases`,
    },
    {
      date: '2026-10-21',
      fixes: all('high', '22.23.4', '24.22.1', '26.12.1'),
      url: `${NODE_BLOG}/october-2026-security-releases`,
    },
  ],
  php: [
    { date: '2024-04-11', fixes: all(undefined, '8.1.28', '8.2.18', '8.3.6'), url: PHP_2024 },
    { date: '2024-06-06', fixes: all(undefined, '8.1.29', '8.2.20', '8.3.8'), url: PHP_2024 },
    { date: '2024-09-26', fixes: all(undefined, '8.1.30', '8.2.24', '8.3.12'), url: PHP_2024 },
    { date: '2024-11-21', fixes: all(undefined, '8.1.31', '8.2.26', '8.3.14'), url: PHP_2024 },
    { date: '2025-03-13', fixes: all(undefined, '8.1.32', '8.2.28', '8.3.19', '8.4.5'), url: PHP_2025 },
    { date: '2025-07-03', fixes: all(undefined, '8.1.33', '8.2.29', '8.3.23', '8.4.10'), url: PHP_2025 },
    { date: '2025-12-18', fixes: all(undefined, '8.1.34', '8.2.30', '8.3.29', '8.4.16', '8.5.1'), url: PHP_2025 },
    {
      date: '2026-05-07',
      fixes: [...all(undefined, '8.2.31', '8.3.31'), ...all('high', '8.4.21', '8.5.6')],
      url: PHP_2026,
    },
    { date: '2026-07-02', fixes: all(undefined, '8.2.32', '8.3.32', '8.4.23', '8.5.8'), url: PHP_2026 },
    {
      date: '2026-07-30',
      fixes: [...all(undefined, '8.2.33', '8.3.33'), ...all('high', '8.4.24', '8.5.9')],
      url: PHP_2026,
    },
    {
      date: '2026-09-24',
      fixes: [...all(undefined, '8.2.34', '8.3.35'), ...all('high', '8.4.26', '8.5.11')],
      url: PHP_2026,
    },
    {
      date: '2026-10-21',
      fixes: all('critical', '8.2.35', '8.3.36', '8.4.27', '8.5.12'),
      cves: ['CVE-2026-109618', 'CVE-2026-109619'],
      url: PHP_2026,
    },
  ],
  // The Go release history names the packages fixed, not a severity.
  go: [
    { date: '2024-03-05', fixes: all(undefined, '1.21.8', '1.22.1'), url: GO_RELEASES },
    { date: '2024-04-03', fixes: all(undefined, '1.21.9', '1.22.2'), url: GO_RELEASES },
    { date: '2024-05-07', fixes: all(undefined, '1.21.10', '1.22.3'), url: GO_RELEASES },
    { date: '2024-06-04', fixes: all(undefined, '1.21.11', '1.22.4'), url: GO_RELEASES },
    { date: '2024-07-02', fixes: all(undefined, '1.21.12', '1.22.5'), url: GO_RELEASES },
    { date: '2024-09-05', fixes: all(undefined, '1.22.7', '1.23.1'), url: GO_RELEASES },
    { date: '2025-01-16', fixes: all(undefined, '1.22.11', '1.23.5'), url: GO_RELEASES },
    { date: '2025-02-04', fixes: all(undefined, '1.22.12', '1.23.6'), url: GO_RELEASES },
    { date: '2025-03-04', fixes: all(undefined, '1.23.7', '1.24.1'), url: GO_RELEASES },
    { date: '2025-04-01', fixes: all(undefined, '1.23.8', '1.24.2'), url: GO_RELEASES },
    { date: '2025-05-06', fixes: all(undefined, '1.24.3'), url: GO_RELEASES },
    { date: '2025-06-05', fixes: all(undefined, '1.23.10', '1.24.4'), url: GO_RELEASES },
    { date: '2025-07-08', fixes: all(undefined, '1.23.11', '1.24.5'), url: GO_RELEASES },
    { date: '2025-08-06', fixes: all(undefined, '1.23.12', '1.24.6'), url: GO_RELEASES },
    { date: '2025-09-03', fixes: all(undefined, '1.25.1'), url: GO_RELEASES },
    { date: '2025-10-07', fixes: all(undefined, '1.24.8', '1.25.2'), url: GO_RELEASES },
    { date: '2025-12-02', fixes: all(undefined, '1.24.11', '1.25.5'), url: GO_RELEASES },
    { date: '2026-01-15', fixes: all(undefined, '1.24.12', '1.25.6'), url: GO_RELEASES },
    { date: '2026-02-04', fixes: all(undefined, '1.24.13', '1.25.7'), url: GO_RELEASES },
    { date: '2026-03-05', fixes: all(undefined, '1.25.8', '1.26.1'), url: GO_RELEASES },
    { date: '2026-04-07', fixes: all(undefined, '1.25.9', '1.26.2'), url: GO_RELEASES },
    { date: '2026-05-07', fixes: all(undefined, '1.25.10', '1.26.3'), url: GO_RELEASES },
    { date: '2026-06-02', fixes: all(undefined, '1.25.11', '1.26.4'), url: GO_RELEASES },
    { date: '2026-07-07', fixes: all(undefined, '1.25.12', '1.26.5'), url: GO_RELEASES },
    { date: '2026-08-13', fixes: all(undefined, '1.25.13', '1.26.6'), url: GO_RELEASES },
    { date: '2026-10-08', fixes: all(undefined, '1.26.9', '1.27.2'), url: GO_RELEASES },
    { date: '2026-10-19', fixes: all(undefined, '1.26.10', '1.27.3'), url: GO_RELEASES },
  ],
}
