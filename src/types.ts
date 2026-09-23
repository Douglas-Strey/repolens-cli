/**
 * Public types for RepoLens.
 *
 * Everything in `ScanResult` is part of the documented JSON output
 * (see docs/json-schema.md). Changing the shape of an existing field is a
 * breaking change and requires bumping `SCHEMA_VERSION`. Adding optional
 * fields is not.
 *
 * Security invariant: no type in this file may carry the *value* of an
 * environment variable, secret, or credential. Only names and derived,
 * non-sensitive facts (for example "this URL points at localhost:5432").
 */

export const SCHEMA_VERSION = 1 as const

/** How sure a detector is about a finding. Low-confidence findings are only shown with --verbose. */
export type Confidence = 'high' | 'medium' | 'low'

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export type ProjectType = 'monorepo' | 'application' | 'library' | 'cli' | 'unknown'

export interface ProjectSection {
  /** package.json name, Go module name, or the directory name as a fallback. */
  name: string
  /** Basename of the scanned directory (never an absolute path). */
  directory: string
  description?: string
  version?: string
  license?: string
  type: ProjectType
  private?: boolean
  /** Repository URL from the manifest, with any credentials stripped. */
  repository?: string
  homepage?: string
  /** Root-level manifests that describe the project, e.g. ["package.json", "go.mod"]. */
  manifests: string[]
  /** Program entry points: Go `main` packages and package.json `bin` commands. */
  entrypoints: Entrypoint[]
  /** Top-level directories with their indexed file counts, largest first (at most 15). */
  structure: DirectorySummary[]
}

export interface Entrypoint {
  /** "go-main": directory of a Go `main` package; "bin": a package.json `bin` command. */
  kind: 'go-main' | 'bin'
  /** Directory (go-main) or script file (bin), relative to the root. */
  path: string
  /** Command name for "bin" entries. */
  name?: string
}

export interface DirectorySummary {
  path: string
  files: number
}

export type LanguageKind = 'programming' | 'markup' | 'style'

export interface LanguageStat {
  /** Display name, e.g. "TypeScript". */
  name: string
  kind: LanguageKind
  files: number
  /** Share of all counted files, 0..1, rounded to 3 decimals. */
  share: number
}

export interface VersionSource {
  /** File that declares the version, e.g. ".nvmrc" or ".github/workflows/ci.yml". */
  file: string
  /** Field inside the file, e.g. "engines.node", "FROM", "setup-node", "go directive". */
  field?: string
  /** The declared value as written (never contains secrets). */
  raw: string
  /**
   * Normalized version or range, e.g. "22", "22.11.0", ">=22", "1.25".
   * `null` when the value cannot be interpreted (e.g. "lts/*", "latest").
   */
  version: string | null
  /**
   * "exact" = pins a version (even partially, e.g. "22"); "range" = semver range;
   * "alias" = a name such as "lts/*" or "node:lts" (`version` holds the major when it is known).
   */
  kind: 'exact' | 'range' | 'alias'
}

export interface Runtime {
  /** "node" | "go" | "bun" | "deno" | … */
  id: string
  /** Display name, e.g. "Node.js". */
  name: string
  /** Best summary for display, e.g. ">=22" or "1.25". `null` if nothing declares a version. */
  version: string | null
  sources: VersionSource[]
}

export type PackageManagerId = 'npm' | 'pnpm' | 'yarn' | 'bun' | 'go' | (string & {})

export interface PackageManagerInfo {
  id: PackageManagerId
  /** Display name, e.g. "pnpm", "Yarn", "Go modules". The Yarn flavor (Berry/Classic) is stated in `evidence`. */
  name: string
  /** Declared version (packageManager/devEngines field), if any. */
  version?: string
  lockfiles: string[]
  /** True when declared explicitly (packageManager, devEngines). */
  declared: boolean
  /** True when RepoLens had to infer it (no declaration and no unambiguous lockfile). Treat it as a best guess. */
  guessed?: boolean
  /**
   * Set when dependencies must be installed from a directory above the scanned one:
   * the directory relative to the repository root ("" = the repository root).
   */
  installFrom?: string
  evidence: string[]
}

export interface PackageManagerSection {
  /** The package manager to use for running scripts, if one can be determined. */
  primary: PackageManagerInfo | null
  detected: PackageManagerInfo[]
}

export interface WorkspaceTool {
  /** "pnpm" | "npm" | "yarn" | "bun" | "turbo" | "nx" | "lerna" | "go-work" */
  id: string
  name: string
  configFile: string
}

export interface WorkspacePackage {
  /** Package name (from package.json / go.mod), falls back to the path. */
  name: string
  /** Relative directory, posix separators, e.g. "apps/web". */
  path: string
  version?: string
  private?: boolean
  ecosystem: 'node' | 'go'
}

export interface WorkspaceSection {
  tools: WorkspaceTool[]
  /** Workspace globs as declared (including negations). */
  patterns: string[]
  packages: WorkspacePackage[]
}

export type DependencyKind = 'prod' | 'dev' | 'peer' | 'optional' | 'indirect'

export interface DependencyEntry {
  name: string
  /** Declared range or version, with any embedded credentials redacted. */
  version: string
  kind: DependencyKind
}

export interface PackageDependencies {
  /** Package directory ("." = root). */
  path: string
  /** Package or module name, falls back to the path. */
  name: string
  ecosystem: 'node' | 'go'
  dependencies: DependencyEntry[]
}

export interface DependenciesSection {
  /** Direct dependencies per package (root first). Go `// indirect` requirements are included with kind "indirect". */
  packages: PackageDependencies[]
  /** Number of unique dependency names across all packages (excluding indirect). */
  total: number
}

export interface Framework {
  /** Stable id, e.g. "nuxt". */
  id: string
  name: string
  /**
   * Declared version, cleaned for display (e.g. "4.1.2" from "^4.1.2"). When packages
   * use different majors, a "lowest–highest" summary such as "18.3.1–19.1.0".
   */
  version?: string
  category: 'frontend' | 'backend' | 'fullstack' | 'mobile' | 'desktop' | 'static-site' | 'library'
  ecosystem: 'node' | 'go'
  /** Package directories where it was found ("." = root). */
  packages: string[]
  confidence: Confidence
  evidence: string[]
}

export type ToolKind =
  | 'build'
  | 'bundler'
  | 'compiler'
  | 'task-runner'
  | 'test'
  | 'e2e'
  | 'linter'
  | 'formatter'
  | 'typechecker'
  | 'git-hooks'
  | 'orm'
  | 'other'

/** Generic shape for build tools, test frameworks, linters, formatters, ORMs, … */
export interface Tool {
  id: string
  name: string
  kind: ToolKind
  version?: string
  configFiles: string[]
  packages: string[]
  confidence: Confidence
  evidence: string[]
}

export interface TestingSection {
  tools: Tool[]
  /** Number of files that look like tests (*.test.*, *.spec.*, *_test.go, __tests__/…). */
  testFiles: number
}

export interface LintingSection {
  tools: Tool[]
}

export interface BuildSection {
  tools: Tool[]
}

export type ScriptCategory =
  | 'dev'
  | 'start'
  | 'build'
  | 'test'
  | 'lint'
  | 'format'
  | 'typecheck'
  | 'database'
  | 'deploy'
  | 'release'
  | 'setup'
  | 'other'

export interface Script {
  name: string
  /** Script body with inline secrets redacted. */
  command: string
  /** Command to run it, e.g. "pnpm dev", "npm run lint", "make test". */
  run: string
  /** File the script comes from: "package.json", "apps/web/package.json", "Makefile", "justfile", "Taskfile.yml". */
  source: string
  /** Package directory for package.json scripts ("." = root). */
  package?: string
  category: ScriptCategory
}

export interface ScriptsSection {
  /** Command prefix used for package.json scripts, e.g. "pnpm", "npm run". */
  runner: string | null
  scripts: Script[]
}

/**
 * - "local": values for one developer's machine, never meant to be committed
 *   (.env, .env.local, .env.*.local, .envrc).
 * - "mode": framework mode files that projects often commit on purpose
 *   (.env.development, .env.production, .env.test, .env.ci, .env.staging).
 * - "service": files a Compose service loads with `env_file` that are not
 *   local or mode files (e.g. .env.db).
 * - "example": documentation templates (.env.example, .env.sample, .env.template, …).
 * - "other": anything else (e.g. encrypted .env.vault).
 */
export type EnvFileKind = 'local' | 'mode' | 'service' | 'example' | 'other'

export interface EnvFile {
  path: string
  kind: EnvFileKind
  /** Number of variables declared in the file. */
  variables: number
  /** Whether the file is matched by .gitignore. `null` if unknown. */
  ignored: boolean | null
  /** Whether the file is tracked by Git (read from .git/index). `null` if not a Git repository or unknown. */
  tracked: boolean | null
}

/** Non-sensitive facts derived from a URL-like value. The value itself is never stored. */
export interface EnvEndpoint {
  file: string
  /** URL scheme without ":", e.g. "postgres", "redis", "http". */
  scheme: string
  /** Explicit port, or null when the URL has none. */
  port: number | null
  /**
   * True when the host is local: localhost, *.localhost, 127.0.0.0/8, ::1, ::,
   * 0.0.0.0, or no host at all (file:, sqlite:, unix sockets).
   */
  local: boolean
}

export interface EnvVariable {
  name: string
  /** Present in a local, mode or service env file (anything that holds values, not an example). */
  defined: boolean
  /** Present in an example/template env file. */
  documented: boolean
  /** Referenced in source code or configuration. */
  used: boolean
  definedIn: string[]
  documentedIn: string[]
  /** Up to 5 files where the variable is referenced. */
  usedIn: string[]
  /** Every reference in code supplies a default (`?? 'x'`, `|| 3000`, a schema default), so it is optional. */
  fallback: boolean
  /** Only referenced from tests (test files or test directories), not application code. */
  testOnly: boolean
  /** Exposed to client-side bundles by a framework prefix (NEXT_PUBLIC_, VITE_, NUXT_PUBLIC_, PUBLIC_, EXPO_PUBLIC_, REACT_APP_, …). */
  public: boolean
  /** The name suggests a secret (…_SECRET, …_TOKEN, …_PASSWORD, …_KEY, …). */
  sensitive: boolean
  /** URL-shaped values, reduced to scheme/port/locality. */
  endpoints: EnvEndpoint[]
  /** Documentation files (e.g. .env.example) whose value looks like a real credential. Only file paths, never values. */
  suspiciousValueIn: string[]
}

export interface EnvironmentSection {
  files: EnvFile[]
  variables: EnvVariable[]
  /** True when source scanning stopped early because of file limits. */
  usageTruncated: boolean
}

export interface PortMapping {
  /** Published host port (number when literal, string when it uses ${VAR} interpolation or a range). */
  host: number | string | null
  container: number | string
  protocol: 'tcp' | 'udp' | (string & {})
  /** Host IP binding, e.g. "127.0.0.1". */
  hostIp?: string
  raw: string
}

export type ServiceKind =
  | 'database'
  | 'cache'
  | 'queue'
  | 'storage'
  | 'search'
  | 'mail'
  | 'proxy'
  | 'observability'
  | 'app'
  | 'other'

export interface Service {
  name: string
  /** Compose file that defines the service. */
  source: string
  image?: string
  /** Build context, when the service is built locally. */
  build?: string
  dockerfile?: string
  /** Recognized technology, e.g. { id: "postgresql", name: "PostgreSQL" }. */
  technology?: { id: string; name: string }
  kind: ServiceKind
  ports: PortMapping[]
  expose: string[]
  dependsOn: string[]
  volumes: string[]
  /** Environment variable NAMES only. */
  environment: string[]
  envFiles: string[]
  profiles: string[]
  healthcheck: boolean
}

export interface Dockerfile {
  path: string
  /** Base images per stage, in order (e.g. ["node:22-alpine", "node:22-alpine"]). */
  baseImages: string[]
  stages: number
  exposes: string[]
  /** ARG names (never values). */
  args: string[]
}

export interface ServicesSection {
  composeFiles: string[]
  services: Service[]
  dockerfiles: Dockerfile[]
}

export type DatabaseKind =
  | 'relational'
  | 'document'
  | 'key-value'
  | 'search'
  | 'wide-column'
  | 'graph'
  | 'time-series'
  | 'other'

export interface Database {
  /** "postgresql" | "mysql" | "mariadb" | "sqlite" | "mongodb" | "redis" | "cockroachdb" | … */
  id: string
  name: string
  kind: DatabaseKind
  /** How it was found. */
  sources: Array<'dependency' | 'docker' | 'env' | 'config'>
  confidence: Confidence
  evidence: string[]
}

export interface DatabasesSection {
  databases: Database[]
  /** ORMs / query builders (kind "orm"). */
  orms: Tool[]
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS' | 'ANY'

export interface Route {
  method: HttpMethod
  /** Normalized path using ":param" for parameters and "*name" for catch-alls. */
  path: string
  kind: 'api' | 'page'
  /** Framework id that defines the route, e.g. "nuxt", "express", "go-net-http". */
  framework: string
  file: string
  line?: number
  confidence: Confidence
  /** Package directory ("." = root). */
  package?: string
  /** Extra context, e.g. "mounted with a prefix that could not be resolved". */
  note?: string
}

export interface RoutesSection {
  routes: Route[]
  /** True when route scanning stopped early because of limits. */
  truncated: boolean
}

export type CiTask =
  | 'lint'
  | 'format'
  | 'typecheck'
  | 'test'
  | 'e2e'
  | 'build'
  | 'deploy'
  | 'release'
  | 'security'
  | 'docs'

export interface CiJob {
  id: string
  name?: string
  /** What the job appears to do, inferred from names and commands. */
  tasks: CiTask[]
  /** Operating systems / images, e.g. ["ubuntu-latest", "windows-latest"]. */
  runsOn: string[]
}

export interface CiWorkflow {
  /** Provider id, e.g. "github-actions", "gitlab-ci". */
  provider: string
  file: string
  name?: string
  /** Triggers, e.g. ["push", "pull_request"]. */
  triggers: string[]
  jobs: CiJob[]
}

export interface CiProvider {
  id: string
  name: string
  files: string[]
}

export interface CiSection {
  providers: CiProvider[]
  workflows: CiWorkflow[]
}

export interface GitRemote {
  name: string
  /** URL with credentials removed. */
  url: string
  /** "github" | "gitlab" | "bitbucket" | "azure" | … when recognizable. */
  host?: string
}

export interface GitSection {
  /**
   * Current branch. Null when HEAD is detached, or when the branch can't be
   * read without running git (for example reftable repositories).
   */
  branch: string | null
  /** Abbreviated HEAD commit (7 chars), when resolvable without running git. */
  head: string | null
  remotes: GitRemote[]
  /** Paths of submodules declared in .gitmodules. */
  submodules: string[]
  /** True when .gitattributes routes files through Git LFS. */
  lfs: boolean
  /** Number of files in the Git index, or null if the index could not be read. */
  trackedFiles: number | null
  /** True when .git is a file (worktree or submodule checkout). */
  linkedWorktree: boolean
}

export type ConfigCategory =
  | 'package'
  | 'workspace'
  | 'runtime'
  | 'typescript'
  | 'framework'
  | 'build'
  | 'test'
  | 'lint'
  | 'format'
  | 'docker'
  | 'ci'
  | 'environment'
  | 'git'
  | 'editor'
  | 'deploy'
  | 'database'
  | 'other'

export interface ConfigFile {
  path: string
  category: ConfigCategory
  /** Short human description, e.g. "Nuxt configuration". */
  description: string
}

/** All detector-produced sections of a scan, keyed by detector id. */
export interface Sections {
  project: ProjectSection
  languages: LanguageStat[]
  runtimes: Runtime[]
  packageManagers: PackageManagerSection
  workspace: WorkspaceSection | null
  dependencies: DependenciesSection
  frameworks: Framework[]
  build: BuildSection
  testing: TestingSection
  linting: LintingSection
  scripts: ScriptsSection
  environment: EnvironmentSection
  services: ServicesSection
  databases: DatabasesSection
  routes: RoutesSection
  ci: CiSection
  git: GitSection | null
  configFiles: ConfigFile[]
}

export type SectionId = keyof Sections

// ---------------------------------------------------------------------------
// Doctor
// ---------------------------------------------------------------------------

export type Severity = 'error' | 'warning' | 'info'

export type DiagnosticCategory =
  | 'runtime'
  | 'package-manager'
  | 'environment'
  | 'security'
  | 'docker'
  | 'workspace'
  | 'scripts'
  | 'git'
  | 'tooling'
  | 'configuration'

export interface Diagnostic {
  /** Stable identifier, e.g. "ENV_UNDOCUMENTED". Never renamed once released. */
  code: string
  severity: Severity
  category: DiagnosticCategory
  /** One sentence describing the problem. Never contains secret values. */
  message: string
  /** Suggested fix. */
  hint?: string
  /** Files involved, relative to the project root. */
  files?: string[]
  /** What the diagnostic is about (variable name, service name, …); useful for grouping. */
  subject?: string
}

export interface CheckResult {
  /** Same as the diagnostic code the check can emit. */
  code: string
  title: string
  category: DiagnosticCategory
  /**
   * "skipped" = not applicable to this repository; "disabled" = turned off
   * in a configuration file (`doctor.rules`).
   */
  status: 'passed' | 'failed' | 'skipped' | 'disabled'
}

export interface DoctorSummary {
  passed: number
  failed: number
  skipped: number
  /** Checks turned off in a configuration file. */
  disabled: number
  errors: number
  warnings: number
  infos: number
}

export interface DoctorResult {
  checks: CheckResult[]
  diagnostics: Diagnostic[]
  summary: DoctorSummary
}

// ---------------------------------------------------------------------------
// Scan result
// ---------------------------------------------------------------------------

export interface ScanWarning {
  /**
   * Machine-readable category: "parse" (a file couldn't be parsed), "size"
   * (a file was skipped for being too large), "limit" (a scan limit was hit),
   * "error" (a detector or doctor check failed), "config" (a configuration
   * file has a setting RepoLens ignored). Match on this, never on `message`.
   */
  kind: 'parse' | 'size' | 'limit' | 'error' | 'config'
  /** File that caused the warning, relative to the root. */
  file?: string
  /** Human readable, e.g. "Couldn't parse docker-compose.yml". */
  message: string
  /** Technical details (parser error, never file contents or absolute paths). Shown with --verbose only. */
  detail?: string
}

export interface ScanMeta {
  /** Files indexed (after ignore rules). */
  files: number
  /** True when the file walk hit its file-count limit. */
  truncated: boolean
  /** Non-fatal problems encountered while scanning. */
  warnings: ScanWarning[]
  /** Configuration that applied to this scan. */
  config: EffectiveConfig
}

export interface ScanResult extends Sections {
  schemaVersion: typeof SCHEMA_VERSION
  tool: { name: 'repolens'; version: string }
  doctor: DoctorResult
  meta: ScanMeta
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** The lowest severity that makes `repolens doctor` exit with 1; "never" always exits with 0. */
export type FailOn = Severity | 'never'

/** A doctor check's setting in `doctor.rules`: turned off, or every finding reported at this severity. */
export type RuleSetting = 'off' | Severity

/**
 * Settings from a configuration file: `repolens.config.json` (or the
 * "repolens" key of package.json) in the scanned directory, the user config
 * file, or a file passed with --config. See docs/configuration.md.
 */
export interface RepoLensConfig {
  /** Paths to leave out of the scan, in .gitignore syntax, relative to the scanned directory. */
  ignore?: string[]
  /** Stop indexing after this many files (1 to 1,000,000). --max-files takes precedence. */
  maxFiles?: number
  doctor?: {
    /** Default for --fail-on. */
    failOn?: FailOn
    /** Per-check settings by code, e.g. { "ENV_UNUSED": "off", "LOCKFILE_MISSING": "error" }. */
    rules?: Record<string, RuleSetting>
  }
  environment?: {
    /**
     * Variables the platform or tooling provides (names, `*` matches any
     * characters): like CI or NODE_ENV, the doctor never expects them in an
     * example env file or a local one.
     */
    provided?: string[]
  }
  /** Terminal preferences. Only read from the user config file. */
  output?: {
    color?: 'auto' | 'always' | 'never'
    /** ASCII status symbols (+, !, x) instead of Unicode ones. */
    ascii?: boolean
  }
}

/**
 * Where a configuration came from. "project" is the scanned directory's own
 * file, "user" the user config file, "file" a file passed with --config.
 */
export interface ConfigSource {
  kind: 'user' | 'project' | 'file'
  /**
   * The file, relative to the scanned directory (project config, or a
   * --config file inside it). Absent otherwise: output never carries
   * absolute paths.
   */
  file?: string
}

/** A configuration file after validation. */
export interface LoadedConfig {
  source: ConfigSource
  /** How messages name the file: "repolens.config.json", "your user config". */
  label: string
  /** The valid settings. Invalid ones were dropped with a warning. */
  config: RepoLensConfig
  /** Problems found in the file (kind "config"). */
  warnings: ScanWarning[]
}

/** The configuration a scan used, after merging every file. */
export interface EffectiveConfig {
  /** Files that applied, lowest precedence first. Empty when none did. */
  sources: ConfigSource[]
  /**
   * The merged settings that took effect (`output` excluded): later files
   * override earlier ones, `ignore` and `environment.provided` accumulate.
   */
  settings: Omit<RepoLensConfig, 'output'>
}

// ---------------------------------------------------------------------------
// Extension points
// ---------------------------------------------------------------------------

export interface ScanOptions {
  /** Directory to scan. Defaults to process.cwd(). */
  cwd?: string
  /** Maximum number of files to index. Default 100_000. */
  maxFiles?: number
  /** Maximum directory depth. Default 20. */
  maxDepth?: number
  /** Largest file RepoLens will read, in bytes. Default 1 MiB. */
  maxFileSize?: number
  /** Reference time for date-based checks (e.g. runtime end-of-life). Default: now. */
  now?: Date
  /** Receives debug messages (enabled with REPOLENS_DEBUG=1 in the CLI). */
  debug?: (message: string) => void
  /**
   * Configuration files to apply, lowest precedence first (see
   * loadProjectConfig, loadUserConfig and loadConfigFile). Default "project":
   * the scanned directory's own config file, if it has one. `false` applies none.
   * `maxFiles` above takes precedence over the files' setting.
   */
  config?: 'project' | false | readonly LoadedConfig[]
}

export interface ResolvedScanOptions {
  cwd: string
  maxFiles: number
  maxDepth: number
  maxFileSize: number
  now: Date
  debug: (message: string) => void
  /** The merged configuration (empty until the context is created). */
  config: EffectiveConfig
}

/** Read-only view of the files RepoLens indexed. All paths are relative, posix-style. */
export interface FileIndex {
  /** Indexed files (not ignored), sorted. */
  readonly files: readonly string[]
  /** Files that exist in traversed directories but are matched by .gitignore (e.g. ".env"). Sorted. */
  readonly ignoredFiles: readonly string[]
  /** Directories that were traversed, relative to the root (the root itself is not listed). */
  readonly directories: ReadonlySet<string>
  readonly truncated: boolean
  /** True when the file exists in the index (ignored files included when `includeIgnored`). */
  has(path: string, options?: { includeIgnored?: boolean }): boolean
  hasDirectory(path: string): boolean
  /** Files with this exact basename, e.g. byName("package.json"). */
  byName(name: string, options?: { includeIgnored?: boolean }): string[]
  /** Files with one of these extensions (with dot, lowercase), e.g. byExtension(".ts", ".tsx"). */
  byExtension(...extensions: string[]): string[]
  /** Files matching a glob (supports *, **, ?, {a,b}). */
  glob(pattern: string, options?: { includeIgnored?: boolean }): string[]
  /**
   * Whether a path (existing or not) is matched by the repository's .gitignore
   * rules. Pass `{ directory: true }` to test a directory (e.g. "node_modules").
   */
  isIgnored(path: string, options?: { directory?: boolean }): boolean
}

/**
 * An analyzer computes something from a project. Results are memoized per scan,
 * so any detector can depend on another with `ctx.use(analyzer)`.
 */
export interface Analyzer<T> {
  id: string
  run(ctx: ProjectContext): Promise<T>
}

/** A detector produces one section of the scan result. */
export interface Detector<K extends SectionId = SectionId> extends Analyzer<Sections[K]> {
  id: K
  /** Human-readable name used in debug output. */
  title: string
}

export interface ReadOptions {
  /** Override the maximum size for this read. */
  maxBytes?: number
  /** Cache the content for other detectors (default true). Pass false when scanning many source files. */
  cache?: boolean
}

export interface ProjectContext {
  /** Absolute, real path of the project root. Never include it in output. */
  readonly root: string
  readonly options: ResolvedScanOptions
  readonly files: FileIndex
  /** Run (or reuse the memoized result of) another analyzer. */
  use<T>(analyzer: Analyzer<T>): Promise<T>
  /**
   * Read a text file relative to the root. Returns null when the file is missing,
   * larger than the size limit, binary, a symlink escaping the root, or unreadable.
   */
  readText(path: string, options?: ReadOptions): Promise<string | null>
  /** Parse JSON. Records a scan warning and returns null on malformed input. */
  readJson<T = unknown>(path: string): Promise<T | null>
  /** Parse JSON with comments and trailing commas (tsconfig.json, biome.json, turbo.json, …). */
  readJsonc<T = unknown>(path: string): Promise<T | null>
  /** Parse the first YAML document. Records a scan warning and returns null on malformed input. */
  readYaml<T = unknown>(path: string): Promise<T | null>
  /** Record a non-fatal problem shown in verbose output and JSON `meta.warnings`. */
  warn(warning: ScanWarning): void
  /** Warnings recorded so far (complete once all detectors have run, e.g. inside doctor rules). */
  readonly warnings: readonly ScanWarning[]
  debug(message: string): void
}

export interface DoctorRule {
  /** Stable diagnostic code emitted by this rule. */
  code: string
  category: DiagnosticCategory
  /** Short name of what the rule checks, phrased positively: "Lockfiles agree". */
  title: string
  /**
   * Return false when the rule does not apply (counted as skipped, not
   * passed), including when it can't look at what it checks.
   */
  applies?(scan: Sections, ctx: ProjectContext): boolean | Promise<boolean>
  /**
   * Run after every other rule has finished. For rules that read
   * `ctx.warnings`, which other rules can still add to while they run.
   */
  final?: boolean
  check(scan: Sections, ctx: ProjectContext): Diagnostic[] | Promise<Diagnostic[]>
}
