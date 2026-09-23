import { useOr } from '../core/context.ts'
import { getString, isRecord } from '../core/parse.ts'
import {
  type Dockerfiles,
  dockerfiles,
  type ExpansionBudget,
  MAX_DOCKERFILE_EXPANSION,
  substituteArgs,
} from '../facts/docker.ts'
import { type GoModule, manifests, type PackageManifest } from '../facts/manifests.ts'
import type { Detector, ProjectContext, Runtime, VersionSource } from '../types.ts'
import { compareText } from '../utils/compare.ts'
import { dirOf, joinPath } from '../utils/paths.ts'
import { redactCommand } from '../utils/redact.ts'
import { cleanUntrusted } from '../utils/text.ts'
import { type ExpressionScope, expandExpression, githubStyleWorkflows } from './ci.ts'

export type RuntimeId = 'node' | 'go' | 'bun' | 'deno'

export interface NormalizedVersion {
  version: string | null
  kind: VersionSource['kind']
}

const RUNTIME_ORDER: readonly RuntimeId[] = ['node', 'go', 'bun', 'deno']
const RUNTIME_NAMES: Readonly<Record<RuntimeId, string>> = { node: 'Node.js', go: 'Go', bun: 'Bun', deno: 'Deno' }

/** Values longer than this are not versions; they are dropped rather than echoed. */
const MAX_RAW_LENGTH = 200

// ---------------------------------------------------------------------------
// Version normalization
// ---------------------------------------------------------------------------

/** Node.js LTS codenames (`lts/iron`, Docker tags such as `iron-alpine`) → major version. */
export const NODE_CODENAMES: ReadonlyMap<string, string> = new Map([
  ['argon', '4'],
  ['boron', '6'],
  ['carbon', '8'],
  ['dubnium', '10'],
  ['erbium', '12'],
  ['fermium', '14'],
  ['gallium', '16'],
  ['hydrogen', '18'],
  ['iron', '20'],
  ['jod', '22'],
  ['krypton', '24'],
])

function unquote(value: string): string {
  return value.trim().replace(/^(["'])(.*)\1$/, '$2')
}

const PLAIN_VERSION = /^v?(\d+(?:\.\d+){0,2})(?:\.[x*])*$/i
const PRERELEASE_VERSION = /^v?(\d+(?:\.\d+){0,2}-?(?:rc|beta|alpha|pre|canary)[0-9a-z.]*)$/i

/**
 * Classify a declared version: "22", "v22.1.0", "22.x" → exact; ">=22",
 * "^1.2", "20 || 22" → range (kept as written); words such as "latest",
 * "stable" or "lts/*" → alias with a null version.
 */
export function normalizeVersion(raw: string): NormalizedVersion {
  const value = unquote(raw)
  const plain = PLAIN_VERSION.exec(value)
  if (plain?.[1]) return { version: plain[1], kind: 'exact' }
  const prerelease = PRERELEASE_VERSION.exec(value)
  if (prerelease?.[1]) return { version: prerelease[1], kind: 'exact' }
  if (/^[<>=^~v\d]/i.test(value) && /\d/.test(value) && /^[\w.*<>=^~|\s+-]+$/.test(value)) {
    return { version: value, kind: 'range' }
  }
  return { version: null, kind: 'alias' }
}

/** Like normalizeVersion, plus nvm aliases: "lts/iron" → alias "20"; "lts/*", "node", "stable" → alias null. */
export function normalizeNodeVersion(raw: string): NormalizedVersion {
  const value = unquote(raw).toLowerCase()
  const lts = /^lts\/(.+)$/.exec(value)
  if (lts) return { version: NODE_CODENAMES.get(lts[1] ?? '') ?? null, kind: 'alias' }
  const codename = NODE_CODENAMES.get(value)
  if (codename) return { version: codename, kind: 'alias' }
  return normalizeVersion(raw)
}

function normalizeFor(runtime: RuntimeId, raw: string): NormalizedVersion {
  return runtime === 'node' ? normalizeNodeVersion(raw) : normalizeVersion(raw)
}

// ---------------------------------------------------------------------------
// Version files
// ---------------------------------------------------------------------------

/** First meaningful line of .nvmrc / .node-version / .dvmrc, without comments. */
export function parseVersionFile(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const value = line.replace(/#.*$/, '').trim()
    if (value !== '') return value.split(/\s+/)[0] ?? null
  }
  return null
}

/** `tool version` pairs from .tool-versions (asdf/mise); the first listed version is the preferred one. */
export function parseToolVersions(text: string): Array<{ tool: string; version: string }> {
  const tools: Array<{ tool: string; version: string }> = []
  for (const line of text.split(/\r?\n/)) {
    const [tool, version] = line.replace(/#.*$/, '').trim().split(/\s+/)
    if (tool && version) tools.push({ tool, version })
  }
  return tools
}

function stripTomlComment(line: string): string {
  let quote: string | null = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote) {
      if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '#') {
      return line.slice(0, i)
    }
  }
  return line
}

function tomlToolValue(expression: string): string | null {
  const value = expression.trim()
  const quoted = /^"([^"]*)"|^'([^']*)'/.exec(value)
  if (quoted) return quoted[1] ?? quoted[2] ?? null
  const array = /^\[\s*(?:"([^"]*)"|'([^']*)')/.exec(value)
  if (array) return array[1] ?? array[2] ?? null
  const table = /\bversion\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(value)
  if (table) return table[1] ?? table[2] ?? null
  const bare = /^(\d[\d.]*)\s*$/.exec(value)
  return bare?.[1] ?? null
}

/**
 * Tool versions from a mise config (`[tools]` table or `tools.x = …` keys).
 * A line-based reader, not a TOML parser: it understands the common forms
 * `node = "22"`, `node = ["22", "20"]` and `node = { version = "22" }`.
 */
export function parseMiseTools(text: string): Array<{ tool: string; version: string }> {
  const tools: Array<{ tool: string; version: string }> = []
  let inTools = false
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim()
    if (line === '') continue
    const header = /^\[([^\]]*)\]$/.exec(line)
    if (header) {
      inTools = header[1]?.trim() === 'tools'
      continue
    }
    const entry = inTools
      ? /^(["']?)([\w:@/.-]+)\1\s*=\s*(.+)$/.exec(line)
      : /^tools\.(["']?)([\w:@/.-]+)\1\s*=\s*(.+)$/.exec(line)
    if (!entry?.[2] || !entry[3]) continue
    const version = tomlToolValue(entry[3])
    if (version) tools.push({ tool: entry[2].replace(/^core:/, ''), version })
  }
  return tools
}

const TOOL_NAMES: Readonly<Record<string, RuntimeId>> = {
  node: 'node',
  nodejs: 'node',
  go: 'go',
  golang: 'go',
  bun: 'bun',
  deno: 'deno',
}

function toolRuntime(tool: string): RuntimeId | null {
  return Object.hasOwn(TOOL_NAMES, tool) ? (TOOL_NAMES[tool] ?? null) : null
}

// ---------------------------------------------------------------------------
// Container images
// ---------------------------------------------------------------------------

export interface ImageRef {
  /** Registry host, lowercased, or null for Docker Hub shorthand. */
  registry: string | null
  /** Repository path, lowercased, e.g. "node", "library/node", "oven/bun". */
  repository: string
  tag: string | null
}

/** Split an image reference ("docker.io/library/node:22-alpine@sha256:…") into its parts. */
export function parseImageRef(reference: string): ImageRef | null {
  let value = reference.trim()
  if (value === '' || /\s/.test(value)) return null
  const at = value.indexOf('@')
  if (at !== -1) value = value.slice(0, at)
  let tag: string | null = null
  const colon = value.lastIndexOf(':')
  if (colon > value.lastIndexOf('/')) {
    tag = value.slice(colon + 1) || null
    value = value.slice(0, colon)
  }
  const segments = value.split('/')
  let registry: string | null = null
  if (segments.length > 1 && /[.:]|^localhost$/.test(segments[0] ?? '')) {
    registry = (segments.shift() as string).toLowerCase()
  }
  const repository = segments.join('/').toLowerCase()
  return repository === '' ? null : { registry, repository, tag }
}

const DOCKER_HUB_REGISTRIES = new Set(['docker.io', 'index.docker.io', 'registry-1.docker.io', 'mirror.gcr.io'])

/** Official image name ("node", "golang", "oven/bun") for Docker Hub references and well-known mirrors. */
function officialRepository(ref: ImageRef): string | null {
  let repository = ref.repository
  if (ref.registry === 'public.ecr.aws') {
    if (!repository.startsWith('docker/library/')) return null
    repository = repository.slice('docker/'.length)
  } else if (ref.registry !== null && !DOCKER_HUB_REGISTRIES.has(ref.registry)) {
    return null
  }
  return repository.startsWith('library/') ? repository.slice('library/'.length) : repository
}

const IMAGE_RUNTIMES: Readonly<Record<string, RuntimeId>> = {
  node: 'node',
  golang: 'go',
  'oven/bun': 'bun',
  'denoland/deno': 'deno',
}

/**
 * Version implied by an image tag: "22-alpine" → exact "22", "1.25.1-bookworm"
 * → "1.25.1", "iron-slim" → alias "20" (Node.js), "lts", "latest", "alpine"
 * or no tag → alias null. Deno's "alpine-2.5.0" style is understood too.
 */
export function versionFromImageTag(runtime: RuntimeId, tag: string | null): NormalizedVersion {
  if (tag === null) return { version: null, kind: 'alias' }
  const value = tag.toLowerCase().replace(/^(?:alpine|debian|distroless|ubuntu|bin)-(?=\d)/, '')
  const numeric = /^v?(\d+(?:\.\d+){0,2}(?:rc\d+|beta\d+)?)(?:$|-)/.exec(value)
  if (numeric?.[1]) return { version: numeric[1], kind: 'exact' }
  const word = /^([a-z]+)(?:$|-)/.exec(value)
  const codename = runtime === 'node' && word?.[1] ? NODE_CODENAMES.get(word[1]) : undefined
  return { version: codename ?? null, kind: 'alias' }
}

/** Runtime and version of an official runtime image, or null for any other image. */
export function imageRuntime(reference: string): { runtime: RuntimeId; version: NormalizedVersion } | null {
  const ref = parseImageRef(reference)
  if (!ref) return null
  const official = officialRepository(ref)
  const runtime = official !== null && Object.hasOwn(IMAGE_RUNTIMES, official) ? IMAGE_RUNTIMES[official] : undefined
  return runtime ? { runtime, version: versionFromImageTag(runtime, ref.tag) } : null
}

/** Image references are short; anything longer is not worth substituting or matching. */
const MAX_IMAGE_LENGTH = 512

// ---------------------------------------------------------------------------
// CI
// ---------------------------------------------------------------------------

const SETUP_ACTIONS: ReadonlyArray<{ pattern: RegExp; runtime: RuntimeId; input: string; field: string }> = [
  { pattern: /^actions\/setup-node(?:@|$)/i, runtime: 'node', input: 'node-version', field: 'setup-node' },
  { pattern: /^actions\/setup-go(?:@|$)/i, runtime: 'go', input: 'go-version', field: 'setup-go' },
  { pattern: /^oven-sh\/setup-bun(?:@|$)/i, runtime: 'bun', input: 'bun-version', field: 'setup-bun' },
  { pattern: /^denoland\/setup-deno(?:@|$)/i, runtime: 'deno', input: 'deno-version', field: 'setup-deno' },
]

export interface DeclaredVersion {
  runtime: RuntimeId
  field: string
  raw: string
}

function scalar(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() === '' ? null : value.trim()
  if (typeof value === 'number') return String(value)
  return null
}

/**
 * Versions requested from setup-node / setup-go / setup-bun / setup-deno in a
 * GitHub Actions workflow. Matrix and env expressions are expanded when their
 * values are literal (one entry per value); `*-version-file` inputs are
 * skipped because RepoLens reads those files directly.
 */
export function setupActionVersions(workflow: unknown): DeclaredVersion[] {
  if (!isRecord(workflow) || !isRecord(workflow.jobs)) return []
  const found: DeclaredVersion[] = []
  for (const job of Object.values(workflow.jobs)) {
    if (!isRecord(job) || !Array.isArray(job.steps)) continue
    const strategy = isRecord(job.strategy) ? job.strategy : {}
    for (const step of job.steps) {
      const uses = getString(step, 'uses')
      if (!uses || !isRecord(step)) continue
      const action = SETUP_ACTIONS.find((candidate) => candidate.pattern.test(uses.trim()))
      if (!action || !isRecord(step.with)) continue
      const value = scalar(step.with[action.input])
      if (value === null) continue
      const scope: ExpressionScope = { matrix: strategy.matrix, env: [step.env, job.env, workflow.env] }
      for (const raw of expandExpression(value, scope) ?? []) {
        found.push({ runtime: action.runtime, field: action.field, raw })
      }
    }
  }
  return found
}

function gitlabImageName(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  return getString(value, 'name')
}

function variablesOf(value: unknown): Map<string, string> {
  const vars = new Map<string, string>()
  if (!isRecord(value)) return vars
  for (const [name, entry] of Object.entries(value)) {
    const literal = scalar(entry) ?? scalar(isRecord(entry) ? entry.value : undefined)
    if (literal !== null) vars.set(name, literal)
  }
  return vars
}

/**
 * Images used by .gitlab-ci.yml (top-level, `default:` and per job), with
 * `$VARIABLES` substituted the way Dockerfile ARGs are: within one budget per
 * file, and never for variables with secret-looking names.
 */
export function gitlabImages(doc: unknown): string[] {
  if (!isRecord(doc)) return []
  const globals = variablesOf(doc.variables)
  const images = new Set<string>()
  const budget: ExpansionBudget = { remaining: MAX_DOCKERFILE_EXPANSION }
  const add = (value: unknown, locals?: Map<string, string>) => {
    const name = gitlabImageName(value)
    if (!name || name.length > MAX_IMAGE_LENGTH) return
    // Job variables override global ones; looked up rather than merged so many jobs stay cheap.
    const scope = locals ? { get: (key: string) => locals.get(key) ?? globals.get(key) } : globals
    images.add(substituteArgs(name, scope, budget))
  }
  add(doc.image)
  if (isRecord(doc.default)) add(doc.default.image)
  for (const [key, job] of Object.entries(doc)) {
    if (key.startsWith('.') || !isRecord(job) || job.image === undefined) continue
    add(job.image, variablesOf(job.variables))
  }
  return [...images]
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

/** Where a source came from; decides which one is shown as the runtime's version. */
export type SourceOrigin =
  | 'version-file'
  | 'manifest-pin'
  | 'engines'
  | 'package-manager'
  | 'go-mod'
  | 'go-work'
  | 'docker'
  | 'ci'

export interface RuntimeSource {
  runtime: RuntimeId
  origin: SourceOrigin
  /** Declared by the project root (package.json, go.mod, …) rather than a sub-package. */
  root: boolean
  source: VersionSource
}

/** Collected sources, deduplicated, in collection order (which is display priority). */
interface SourceList {
  items: RuntimeSource[]
  seen: Set<string>
}

function addSource(list: SourceList, runtime: RuntimeId, origin: SourceOrigin, root: boolean, source: VersionSource) {
  const raw = cleanUntrusted(source.raw, { oneLine: true })
  if (raw === '' || raw.length > MAX_RAW_LENGTH) return
  // Local paths ("/Users/me/.nvm/…", "~/node") are not versions and would leak the author's file system.
  if (/^(?:[/~\\]|[a-zA-Z]:[\\/])/.test(raw)) return
  const redacted = redactCommand(raw)
  // A value that needed redaction is not a version; never let it through `version` either.
  const safe: VersionSource =
    redacted === raw ? { ...source, raw } : { ...source, raw: redacted, version: null, kind: 'alias' }
  const key = `${runtime}\0${safe.file}\0${safe.field ?? ''}\0${safe.raw}`
  if (list.seen.has(key)) return
  list.seen.add(key)
  list.items.push({ runtime, origin, root, source: safe })
}

/** Add a version declared as a plain string, normalized for its runtime. */
function addDeclared(
  list: SourceList,
  runtime: RuntimeId,
  origin: SourceOrigin,
  root: boolean,
  location: { file: string; field?: string },
  raw: string,
) {
  if (raw.length > MAX_RAW_LENGTH) return
  addSource(list, runtime, origin, root, { ...location, raw, ...normalizeFor(runtime, raw) })
}

const VERSION_FILES: ReadonlyArray<{ name: string; runtime: RuntimeId }> = [
  { name: '.nvmrc', runtime: 'node' },
  { name: '.node-version', runtime: 'node' },
  { name: '.dvmrc', runtime: 'deno' },
]
const MISE_FILES = ['mise.toml', '.mise.toml']
const ROOT_MISE_FILES = ['.config/mise.toml', '.config/mise/config.toml', 'mise/config.toml', '.mise/config.toml']

async function collectVersionFiles(ctx: ProjectContext, dir: string, list: SourceList): Promise<void> {
  const root = dir === '.'
  for (const { name, runtime } of VERSION_FILES) {
    const file = joinPath(dir, name)
    if (!ctx.files.has(file)) continue
    const text = await ctx.readText(file)
    const value = text === null ? null : parseVersionFile(text)
    if (value) addDeclared(list, runtime, 'version-file', root, { file }, value)
  }

  const toolVersions = joinPath(dir, '.tool-versions')
  if (ctx.files.has(toolVersions)) {
    for (const { tool, version } of parseToolVersions((await ctx.readText(toolVersions)) ?? '')) {
      const runtime = toolRuntime(tool)
      // "path:/…" and "ref:…" point at local checkouts, not versions.
      if (runtime && !/^(?:path|ref):/.test(version)) {
        addDeclared(list, runtime, 'version-file', root, { file: toolVersions, field: tool }, version)
      }
    }
  }

  const miseFiles = root ? [...MISE_FILES, ...ROOT_MISE_FILES] : MISE_FILES
  for (const name of miseFiles) {
    const file = joinPath(dir, name)
    if (!ctx.files.has(file)) continue
    for (const { tool, version } of parseMiseTools((await ctx.readText(file)) ?? '')) {
      const runtime = toolRuntime(tool)
      const value = version.replace(/^prefix:/, '')
      if (runtime && !/^(?:path|ref|sub-\d+):/.test(value)) {
        addDeclared(list, runtime, 'version-file', root, { file, field: `tools.${tool}` }, value)
      }
    }
  }
}

function devEngineRuntimes(raw: Record<string, unknown>): Array<{ name: string; version: string }> {
  const devEngines = raw.devEngines
  if (!isRecord(devEngines)) return []
  const entries = Array.isArray(devEngines.runtime) ? devEngines.runtime : [devEngines.runtime]
  const out: Array<{ name: string; version: string }> = []
  for (const entry of entries) {
    const name = getString(entry, 'name')
    const version = getString(entry, 'version')
    if (name && version) out.push({ name: name.toLowerCase(), version })
  }
  return out
}

/** engines / devEngines values are semver ranges even when they look like a plain version ("22"). */
function range(raw: string): NormalizedVersion {
  const value = raw.trim()
  return /\d/.test(value) && /^[\w.*<>=^~|\s+-]+$/.test(value)
    ? { version: value, kind: 'range' }
    : { version: null, kind: 'alias' }
}

function collectManifest(manifest: PackageManifest, list: SourceList): void {
  const root = manifest.dir === '.'
  const file = manifest.file
  const nodeEngine = manifest.engines.node
  if (nodeEngine !== undefined) {
    addSource(list, 'node', 'engines', root, { file, field: 'engines.node', raw: nodeEngine, ...range(nodeEngine) })
  }
  const bunEngine = manifest.engines.bun
  if (bunEngine !== undefined) {
    addSource(list, 'bun', 'engines', root, { file, field: 'engines.bun', raw: bunEngine, ...range(bunEngine) })
  }
  const volta = isRecord(manifest.raw.volta) ? manifest.raw.volta : null
  const voltaNode = getString(volta, 'node')
  if (voltaNode) addDeclared(list, 'node', 'manifest-pin', root, { file, field: 'volta.node' }, voltaNode)
  for (const { name, version } of devEngineRuntimes(manifest.raw)) {
    const runtime = name === 'node' || name === 'bun' || name === 'deno' ? name : null
    if (runtime) {
      addSource(list, runtime, 'engines', root, { file, field: 'devEngines.runtime', raw: version, ...range(version) })
    }
  }
  const packageManager = /^bun@([^+\s]+)/.exec(manifest.packageManager ?? '')
  if (packageManager?.[1]) {
    const raw = `bun@${packageManager[1]}`
    addSource(list, 'bun', 'package-manager', root, {
      file,
      field: 'packageManager',
      raw,
      ...normalizeVersion(packageManager[1]),
    })
  }
}

function goRaw(directive: string, version: string): string {
  return directive === 'toolchain' && /^\d/.test(version) ? `toolchain go${version}` : `${directive} ${version}`
}

function collectGoModule(mod: GoModule, list: SourceList): void {
  const root = mod.dir === '.'
  if (mod.goVersion) {
    addSource(list, 'go', 'go-mod', root, {
      file: mod.file,
      field: 'go directive',
      raw: goRaw('go', mod.goVersion),
      ...normalizeVersion(mod.goVersion),
    })
  }
  if (mod.toolchain) {
    addSource(list, 'go', 'go-mod', root, {
      file: mod.file,
      field: 'toolchain',
      raw: goRaw('toolchain', mod.toolchain),
      ...normalizeVersion(mod.toolchain),
    })
  }
}

/** `go` and `toolchain` directives of a go.work file. */
export function parseGoWorkVersions(text: string): { go?: string; toolchain?: string } {
  const out: { go?: string; toolchain?: string } = {}
  const go = /^[ \t]*go[ \t]+(\S+)/m.exec(text)
  if (go?.[1]) out.go = go[1]
  const toolchain = /^[ \t]*toolchain[ \t]+go?(\S+)/m.exec(text)
  if (toolchain?.[1]) out.toolchain = toolchain[1]
  return out
}

/** Official runtime images among Dockerfile base images (stage references and oversized references skipped). */
export function dockerfileSources(found: Dockerfiles): Array<{ file: string; image: string }> {
  const out: Array<{ file: string; image: string }> = []
  for (const file of found.files) {
    for (const stage of file.stages) {
      if (!stage.fromStage && stage.image.length <= MAX_IMAGE_LENGTH) out.push({ file: file.path, image: stage.image })
    }
  }
  return out
}

async function collectDockerfiles(ctx: ProjectContext, list: SourceList): Promise<void> {
  const found = await useOr(ctx, dockerfiles, { files: [], truncated: false })
  for (const { file, image } of dockerfileSources(found)) {
    const match = imageRuntime(image)
    if (match) addSource(list, match.runtime, 'docker', false, { file, field: 'FROM', raw: image, ...match.version })
  }
}

async function collectCi(ctx: ProjectContext, list: SourceList): Promise<void> {
  const workflows = githubStyleWorkflows(ctx.files)
  const docs = await Promise.all(workflows.map(({ file }) => ctx.readYaml(file)))
  workflows.forEach(({ file }, i) => {
    for (const declared of setupActionVersions(docs[i])) {
      addDeclared(list, declared.runtime, 'ci', false, { file, field: declared.field }, declared.raw)
    }
  })
  for (const file of ['.gitlab-ci.yml', '.gitlab-ci.yaml']) {
    if (!ctx.files.has(file)) continue
    for (const image of gitlabImages(await ctx.readYaml(file))) {
      const match = imageRuntime(image)
      if (match) addSource(list, match.runtime, 'ci', false, { file, field: 'image', raw: image, ...match.version })
    }
  }
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

function isPin(found: RuntimeSource): boolean {
  return found.source.version !== null && found.source.kind !== 'range'
}

function firstVersion(items: readonly RuntimeSource[], predicate: (found: RuntimeSource) => boolean): string | null {
  return items.find((found) => predicate(found) && found.source.version !== null)?.source.version ?? null
}

/**
 * The version shown for a runtime. Collection order puts root-level files
 * before workspace packages, so "first" means "closest to the root".
 */
export function displayVersion(runtime: RuntimeId, items: readonly RuntimeSource[]): string | null {
  const pinned = (origins: readonly SourceOrigin[]) =>
    firstVersion(items, (found) => origins.includes(found.origin) && isPin(found))
  const exactFrom = (origins: readonly SourceOrigin[]) =>
    firstVersion(items, (found) => origins.includes(found.origin) && found.source.kind === 'exact')
  const rootEngines = () =>
    firstVersion(items, (found) => found.origin === 'engines' && found.root && found.source.kind === 'range')
  switch (runtime) {
    case 'node':
      return pinned(['version-file', 'manifest-pin']) ?? rootEngines() ?? exactFrom(['docker']) ?? exactFrom(['ci'])
    case 'go':
      return (
        firstVersion(items, (f) => f.origin === 'go-mod' && f.root && f.source.field === 'go directive') ??
        firstVersion(items, (f) => f.origin === 'go-mod' && f.source.field === 'go directive') ??
        firstVersion(items, (f) => f.origin === 'go-work' && f.source.field === 'go directive') ??
        exactFrom(['version-file', 'docker', 'ci'])
      )
    case 'bun':
      return exactFrom(['package-manager']) ?? pinned(['version-file']) ?? rootEngines() ?? exactFrom(['docker', 'ci'])
    case 'deno':
      return pinned(['version-file']) ?? exactFrom(['ci', 'docker'])
  }
}

export interface RuntimeEvidence {
  /** Directories with a package.json ("." = root, also when the root one is malformed). */
  packageDirs: readonly string[]
  /** A go.mod or go.work exists. */
  goModule: boolean
  /** Directories with a go.mod, plus "." for a root go.work. Defaults to the root when `goModule` is set. */
  goDirs?: readonly string[]
  /** Directories with bun.lock, bun.lockb or bunfig.toml. */
  bunDirs: readonly string[]
  /** Directories with deno.json or deno.jsonc. */
  denoDirs: readonly string[]
}

/**
 * Directories where the project itself declares each runtime: manifests,
 * lockfiles and version files. Docker images and CI steps are not project
 * evidence (a Node.js step that lints the docs of a Go project does not make
 * it a Node.js project). Bun and Deno also read package.json, so a
 * package.json only counts for Node.js when neither of them is in use in its
 * directory or at the root.
 */
function projectRuntimeDirs(evidence: RuntimeEvidence, items: readonly RuntimeSource[]): Map<RuntimeId, Set<string>> {
  const declaredDirs = (runtime: RuntimeId) =>
    items
      .filter((f) => f.runtime === runtime && f.origin !== 'docker' && f.origin !== 'ci')
      .map((f) => (f.root ? '.' : dirOf(f.source.file)))
  const bunDirs = new Set([...evidence.bunDirs, ...declaredDirs('bun')])
  const denoDirs = new Set([...evidence.denoDirs, ...declaredDirs('deno')])
  const explained = (dir: string) => [bunDirs, denoDirs].some((dirs) => dirs.has('.') || dirs.has(dir))
  const nodeDirs = new Set([...evidence.packageDirs.filter((dir) => !explained(dir)), ...declaredDirs('node')])
  // A Go version in .tool-versions alone does not make a Go project.
  const goDirs = new Set(evidence.goModule ? [...(evidence.goDirs ?? ['.']), ...declaredDirs('go')] : [])
  return new Map<RuntimeId, Set<string>>([
    ['node', nodeDirs],
    ['go', goDirs],
    ['bun', bunDirs],
    ['deno', denoDirs],
  ])
}

/**
 * Runtimes the project evidently uses: every runtime it declares itself, plus
 * Node.js whenever any Node.js version source exists (Docker images and CI
 * included). A Docker image or CI step alone does not make a Bun or Deno project.
 */
export function presentRuntimes(evidence: RuntimeEvidence, items: readonly RuntimeSource[]): Set<RuntimeId> {
  const dirs = projectRuntimeDirs(evidence, items)
  const present = new Set<RuntimeId>()
  for (const id of RUNTIME_ORDER) {
    if ((dirs.get(id)?.size ?? 0) > 0 || (id === 'node' && items.some((f) => f.runtime === 'node'))) present.add(id)
  }
  return present
}

/**
 * Display rank of each runtime: 0 when the project root declares it, 1 when
 * only a nested package does, 2 when only Docker images or CI mention it. The
 * first runtime listed is read as the project's primary one.
 */
export function rankRuntimes(evidence: RuntimeEvidence, items: readonly RuntimeSource[]): Map<RuntimeId, number> {
  const ranks = new Map<RuntimeId, number>()
  for (const [id, dirs] of projectRuntimeDirs(evidence, items)) ranks.set(id, dirs.has('.') ? 0 : dirs.size > 0 ? 1 : 2)
  return ranks
}

/**
 * Assemble runtimes ordered by `ranks` (lowest first), then in fixed order
 * (node, go, bun, deno); sources sorted by file, then field.
 */
export function buildRuntimes(
  items: readonly RuntimeSource[],
  present: ReadonlySet<RuntimeId>,
  ranks: ReadonlyMap<RuntimeId, number> = new Map(),
): Runtime[] {
  const ordered = RUNTIME_ORDER.filter((id) => present.has(id)).sort(
    (a, b) => (ranks.get(a) ?? 0) - (ranks.get(b) ?? 0),
  )
  return ordered.map((id) => {
    const own = items.filter((found) => found.runtime === id)
    const sources = own
      .map((found) => found.source)
      .sort((a, b) => compareText(a.file, b.file) || compareText(a.field ?? '', b.field ?? ''))
    return { id, name: RUNTIME_NAMES[id], version: displayVersion(id, own), sources }
  })
}

export const runtimesDetector: Detector<'runtimes'> = {
  id: 'runtimes',
  title: 'Runtimes',
  async run(ctx) {
    const project = await ctx.use(manifests)
    const list: SourceList = { items: [], seen: new Set() }

    const dirs = [
      ...new Set(['.', ...project.packages.map((p) => p.dir), ...project.goModules.map((m) => m.dir)]),
    ].sort((a, b) => (a === '.' ? -1 : b === '.' ? 1 : compareText(a, b)))

    // Root first, then packages: collection order is display priority.
    const packagesByDir = new Map(project.packages.map((p) => [p.dir, p]))
    for (const dir of dirs) {
      await collectVersionFiles(ctx, dir, list)
      const manifest = packagesByDir.get(dir)
      if (manifest) collectManifest(manifest, list)
    }

    for (const mod of project.goModules) collectGoModule(mod, list)
    if (ctx.files.has('go.work')) {
      const work = parseGoWorkVersions((await ctx.readText('go.work')) ?? '')
      if (work.go) {
        addSource(list, 'go', 'go-work', true, {
          file: 'go.work',
          field: 'go directive',
          raw: goRaw('go', work.go),
          ...normalizeVersion(work.go),
        })
      }
      if (work.toolchain) {
        addSource(list, 'go', 'go-work', true, {
          file: 'go.work',
          field: 'toolchain',
          raw: goRaw('toolchain', work.toolchain),
          ...normalizeVersion(work.toolchain),
        })
      }
    }

    await collectDockerfiles(ctx, list)
    await collectCi(ctx, list)

    const dirsWith = (...names: string[]) =>
      dirs.filter((dir) => names.some((name) => ctx.files.has(joinPath(dir, name))))
    const evidence: RuntimeEvidence = {
      packageDirs: [...packagesByDir.keys(), ...(ctx.files.has('package.json') ? ['.'] : [])],
      goModule: project.goModules.length > 0 || ctx.files.has('go.mod') || ctx.files.has('go.work'),
      goDirs: [
        ...project.goModules.map((mod) => mod.dir),
        ...(ctx.files.has('go.mod') || ctx.files.has('go.work') ? ['.'] : []),
      ],
      bunDirs: dirsWith('bun.lock', 'bun.lockb', 'bunfig.toml'),
      denoDirs: dirsWith('deno.json', 'deno.jsonc'),
    }
    return buildRuntimes(list.items, presentRuntimes(evidence, list.items), rankRuntimes(evidence, list.items))
  },
}
