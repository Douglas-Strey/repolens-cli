import { getString, getStringMap, isRecord, toStringArray } from '../core/parse.ts'
import type { Analyzer, ProjectContext } from '../types.ts'
import { compareText } from '../utils/compare.ts'
import { matchPatterns } from '../utils/glob.ts'
import { isUnder, NON_PROJECT_ROLES } from '../utils/path-roles.ts'
import { depthOf, dirOf, joinPath, normalizeRelative } from '../utils/paths.ts'

export type ManifestRole = 'root' | 'workspace' | 'nested'

export interface PackageManifest {
  /** Package directory relative to the root ("." for the root). */
  dir: string
  /** Path of the package.json file. */
  file: string
  role: ManifestRole
  name?: string
  version?: string
  description?: string
  license?: string
  private?: boolean
  type?: string
  scripts: Record<string, string>
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
  peerDependencies: Record<string, string>
  optionalDependencies: Record<string, string>
  engines: Record<string, string>
  /** The `packageManager` field, e.g. "pnpm@10.17.1+sha512…". */
  packageManager?: string
  /** Normalized `workspaces` patterns (array form or `{ packages: [] }` form). */
  workspaces: string[]
  hasBin: boolean
  /** The parsed file, for detectors that need other fields (volta, devEngines, prettier, …). */
  raw: Record<string, unknown>
}

export interface GoRequire {
  path: string
  version: string
  indirect: boolean
}

export interface GoModule {
  dir: string
  file: string
  role: ManifestRole
  /** Module path, e.g. "github.com/acme/api". */
  module: string
  /** `go` directive, e.g. "1.25.1". */
  goVersion?: string
  /** `toolchain` directive without the "go" prefix, e.g. "1.25.2". */
  toolchain?: string
  requires: GoRequire[]
  hasGoSum: boolean
}

/** A package imported through a deno.json import map (`jsr:` or `npm:` specifier). */
export interface DenoImport {
  /** Package name from the specifier, e.g. "@hono/hono" for "jsr:@hono/hono@^4". */
  name: string
  /** Version range from the specifier, "*" when it has none. */
  range: string
  registry: 'jsr' | 'npm'
}

export interface DenoConfig {
  /** Directory of the config file ("." for the root). */
  dir: string
  /** deno.json or deno.jsonc. */
  file: string
  role: ManifestRole
  name?: string
  imports: DenoImport[]
}

export interface WorkspaceDeclaration {
  source: 'pnpm-workspace.yaml' | 'package.json' | 'lerna.json' | 'go.work'
  file: string
  patterns: string[]
}

export interface ProjectManifests {
  /** Root package.json, or null when missing or malformed. */
  root: PackageManifest | null
  /** True when a root package.json exists but could not be parsed. */
  rootInvalid: boolean
  /** Root first, then workspace members / nested packages sorted by directory. */
  packages: PackageManifest[]
  goModules: GoModule[]
  /** Every workspace declaration found (more than one JS declaration is a doctor finding). */
  workspaces: WorkspaceDeclaration[]
  /** The patterns actually used to resolve JS workspace members. */
  effectivePatterns: string[]
  /** pnpm catalogs: catalog name ("default" for `catalog:`) → package → range. */
  catalogs: Record<string, Record<string, string>>
  /** Root deno.json/deno.jsonc and the Deno workspace members it lists (always set by the analyzer). */
  deno?: DenoConfig[]
}

const MAX_NESTED_PACKAGE_DEPTH = 3
const MAX_NESTED_GO_DEPTH = 4

/**
 * Most workspace patterns used from one declaration. The list comes from the
 * repository and every package.json is matched against every pattern (30,000
 * patterns and 300 packages took 17 s); real workspaces declare a handful.
 */
export const MAX_WORKSPACE_PATTERNS = 500

/**
 * False for manifests below test, fixture, example, template, playground or
 * benchmark directories (see NON_PROJECT_ROLES) or underscore-prefixed ones:
 * they hold sample or test projects, not parts of the project itself. Used
 * only when no workspace declaration says which packages belong.
 */
export function isProjectPath(file: string): boolean {
  if (isUnder(file, NON_PROJECT_ROLES)) return false
  const segments = file.split('/')
  segments.pop()
  return !segments.some((segment) => segment.startsWith('_'))
}

export function normalizeManifest(raw: Record<string, unknown>, file: string, role: ManifestRole): PackageManifest {
  const workspacesField = raw.workspaces
  const workspaces = isRecord(workspacesField)
    ? toStringArray(workspacesField.packages)
    : toStringArray(workspacesField)
  const manifest: PackageManifest = {
    dir: dirOf(file),
    file,
    role,
    scripts: getStringMap(raw, 'scripts'),
    dependencies: getStringMap(raw, 'dependencies'),
    devDependencies: getStringMap(raw, 'devDependencies'),
    peerDependencies: getStringMap(raw, 'peerDependencies'),
    optionalDependencies: getStringMap(raw, 'optionalDependencies'),
    engines: getStringMap(raw, 'engines'),
    workspaces,
    hasBin: typeof raw.bin === 'string' || isRecord(raw.bin),
    raw,
  }
  const name = getString(raw, 'name')
  if (name) manifest.name = name
  const version = getString(raw, 'version')
  if (version) manifest.version = version
  const description = getString(raw, 'description')
  if (description) manifest.description = description
  const license = getString(raw, 'license')
  if (license) manifest.license = license
  if (typeof raw.private === 'boolean') manifest.private = raw.private
  const type = getString(raw, 'type')
  if (type) manifest.type = type
  const packageManager = getString(raw, 'packageManager')
  if (packageManager) manifest.packageManager = packageManager
  return manifest
}

/** Replace `catalog:` / `catalog:<name>` ranges with the catalog entry, when there is one. */
export function resolveCatalogs(manifest: PackageManifest, catalogs: ProjectManifests['catalogs']): void {
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const) {
    const deps = manifest[field]
    for (const [dep, spec] of Object.entries(deps)) {
      if (!spec.startsWith('catalog:')) continue
      const catalogName = spec.slice('catalog:'.length).trim() || 'default'
      if (!Object.hasOwn(catalogs, catalogName)) continue
      const catalog = catalogs[catalogName] as Record<string, string>
      const resolved = Object.hasOwn(catalog, dep) ? catalog[dep] : undefined
      if (resolved) deps[dep] = resolved
    }
  }
}

/** Keys that would change an object's prototype instead of adding an entry. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** pnpm catalogs from pnpm-workspace.yaml: `catalog:` is "default", `catalogs.<name>` are named. */
export function readCatalogs(pnpmWorkspace: unknown): ProjectManifests['catalogs'] {
  const catalogs: ProjectManifests['catalogs'] = {}
  if (!isRecord(pnpmWorkspace)) return catalogs
  const toMap = (value: unknown) => {
    const out: Record<string, string> = {}
    if (isRecord(value)) {
      for (const [k, v] of Object.entries(value)) {
        if (UNSAFE_KEYS.has(k)) continue
        if (typeof v === 'string') out[k] = v
        else if (typeof v === 'number') out[k] = String(v)
      }
    }
    return out
  }
  if (isRecord(pnpmWorkspace.catalog)) catalogs.default = toMap(pnpmWorkspace.catalog)
  if (isRecord(pnpmWorkspace.catalogs)) {
    for (const [name, value] of Object.entries(pnpmWorkspace.catalogs)) {
      if (!UNSAFE_KEYS.has(name)) catalogs[name] = toMap(value)
    }
  }
  return catalogs
}

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

function unquote(token: string): string {
  return token.replace(/^["`]|["`]$/g, '')
}

/** Parse the parts of go.mod RepoLens needs. Returns null when there is no `module` directive. */
export function parseGoMod(text: string): Omit<GoModule, 'dir' | 'file' | 'role' | 'hasGoSum'> | null {
  let module: string | undefined
  let goVersion: string | undefined
  let toolchain: string | undefined
  const requires: GoRequire[] = []
  let block: string | null = null

  for (const rawLine of text.split(/\r?\n/)) {
    const indirect = /\/\/\s*indirect\b/.test(rawLine)
    const line = rawLine.replace(/\/\/.*$/, '').trim()
    if (line === '') continue

    if (block) {
      if (line === ')') {
        block = null
        continue
      }
      if (block === 'require') {
        const [path, version] = line.split(/\s+/)
        if (path && version) requires.push({ path: unquote(path), version, indirect })
      }
      continue
    }

    const blockStart = /^(require|replace|exclude|retract|tool|godebug|ignore)\s*\($/.exec(line)
    if (blockStart?.[1]) {
      block = blockStart[1]
      continue
    }
    const [directive, ...args] = line.split(/\s+/)
    switch (directive) {
      case 'module':
        if (args[0]) module = unquote(args[0])
        break
      case 'go':
        if (args[0]) goVersion = args[0]
        break
      case 'toolchain':
        if (args[0]) toolchain = args[0].replace(/^go/, '')
        break
      case 'require':
        if (args[0] && args[1]) requires.push({ path: unquote(args[0]), version: args[1], indirect })
        break
    }
  }

  if (!module) return null
  const result: Omit<GoModule, 'dir' | 'file' | 'role' | 'hasGoSum'> = { module, requires }
  if (goVersion) result.goVersion = goVersion
  if (toolchain) result.toolchain = toolchain
  return result
}

/** Directories listed by `use` directives in go.work. */
export function parseGoWork(text: string): string[] {
  const uses: string[] = []
  let inUse = false
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\/\/.*$/, '').trim()
    if (line === '') continue
    if (inUse) {
      if (line === ')') inUse = false
      else uses.push(unquote(line))
      continue
    }
    if (/^use\s*\($/.test(line)) {
      inUse = true
      continue
    }
    const single = /^use\s+(\S+)/.exec(line)
    if (single?.[1]) uses.push(unquote(single[1]))
  }
  return uses
}

// ---------------------------------------------------------------------------
// Deno
// ---------------------------------------------------------------------------

const DENO_CONFIG_FILES = ['deno.json', 'deno.jsonc']
/** Import map entries read per config; real ones hold dozens. */
const MAX_DENO_IMPORTS = 1000
// jsr:@scope/name@range/sub/path, npm:name@range, npm:/@scope/name; prefix mappings ("jsr:/@std/") do not match.
const DENO_SPECIFIER = /^(jsr|npm):\/?((?:@[a-z0-9][\w.-]{0,100}\/)?[a-z0-9][\w.-]{0,100})(?:@([^/\s]{1,64}))?(?:\/|$)/i

/** Package behind a Deno import specifier, or null for URLs, paths and prefix mappings. */
export function parseDenoSpecifier(specifier: string): DenoImport | null {
  const match = DENO_SPECIFIER.exec(specifier.trim())
  if (!match?.[1] || !match[2]) return null
  const registry = match[1].toLowerCase() === 'jsr' ? 'jsr' : 'npm'
  return { name: match[2], range: match[3] ?? '*', registry }
}

/** Packages imported by a parsed import map (`imports` of deno.json or of a separate import map file). */
export function denoImports(imports: unknown): DenoImport[] {
  if (!isRecord(imports)) return []
  const out: DenoImport[] = []
  const seen = new Set<string>()
  for (const specifier of Object.values(imports).slice(0, MAX_DENO_IMPORTS)) {
    if (typeof specifier !== 'string') continue
    const parsed = parseDenoSpecifier(specifier)
    if (!parsed || UNSAFE_KEYS.has(parsed.name) || seen.has(parsed.name)) continue
    seen.add(parsed.name)
    out.push(parsed)
  }
  return out
}

/** Deno 2 workspace members: `"workspace": ["./a"]` or `"workspace": { "members": [...] }`. */
function denoWorkspacePatterns(doc: Record<string, unknown>): string[] {
  const field = doc.workspace
  const list = isRecord(field) ? toStringArray(field.members) : toStringArray(field)
  return list.slice(0, MAX_WORKSPACE_PATTERNS).map((entry) => joinPath(entry.replace(/\/+$/, '')))
}

async function readDenoConfig(
  ctx: ProjectContext,
  file: string,
  role: ManifestRole,
): Promise<{ config: DenoConfig; doc: Record<string, unknown> } | null> {
  const doc = await ctx.readJsonc(file)
  if (!isRecord(doc)) return null
  const dir = dirOf(file)
  let imports = denoImports(doc.imports)
  // A separate import map is only used when deno.json has no "imports" of its own.
  const importMap = doc.imports === undefined ? getString(doc, 'importMap') : undefined
  const mapFile = importMap ? normalizeRelative(joinPath(dir, importMap)) : null
  if (mapFile && mapFile !== '.' && ctx.files.has(mapFile)) {
    const map = await ctx.readJsonc(mapFile)
    if (isRecord(map)) imports = denoImports(map.imports)
  }
  const config: DenoConfig = { dir, file, role, imports }
  const name = getString(doc, 'name')
  if (name) config.name = name
  return { config, doc }
}

/** Root deno.json(c) and the members of a Deno workspace. */
async function loadDenoConfigs(ctx: ProjectContext): Promise<DenoConfig[]> {
  const rootFile = DENO_CONFIG_FILES.find((file) => ctx.files.has(file))
  if (!rootFile) return []
  const root = await readDenoConfig(ctx, rootFile, 'root')
  if (!root) return []
  const patterns = denoWorkspacePatterns(root.doc)
  if (patterns.length === 0) return [root.config]
  const memberFiles = new Map<string, string>()
  for (const name of DENO_CONFIG_FILES) {
    for (const file of ctx.files.byName(name)) {
      const dir = dirOf(file)
      if (dir !== '.' && !memberFiles.has(dir) && matchPatterns(patterns, dir)) memberFiles.set(dir, file)
    }
  }
  const members = await Promise.all(
    [...memberFiles.values()].sort(compareText).map((file) => readDenoConfig(ctx, file, 'workspace')),
  )
  return [root.config, ...members.flatMap((member) => (member ? [member.config] : []))]
}

// ---------------------------------------------------------------------------
// Analyzer
// ---------------------------------------------------------------------------

async function loadGoModules(
  ctx: ProjectContext,
): Promise<{ modules: GoModule[]; declaration: WorkspaceDeclaration | null }> {
  const goModFiles = ctx.files.byName('go.mod')
  let declaration: WorkspaceDeclaration | null = null
  const workspaceDirs = new Set<string>()
  if (ctx.files.has('go.work')) {
    const text = await ctx.readText('go.work')
    if (text !== null) {
      const uses = parseGoWork(text)
      declaration = { source: 'go.work', file: 'go.work', patterns: uses }
      for (const use of uses) workspaceDirs.add(joinPath(use))
    }
  }

  const candidates = goModFiles.flatMap((file) => {
    const dir = dirOf(file)
    const role: ManifestRole = dir === '.' ? 'root' : workspaceDirs.has(dir) ? 'workspace' : 'nested'
    if (role === 'nested' && (depthOf(file) > MAX_NESTED_GO_DEPTH || !isProjectPath(file))) return []
    return [{ file, dir, role }]
  })
  const texts = await Promise.all(candidates.map(({ file }) => ctx.readText(file)))
  const modules: GoModule[] = []
  candidates.forEach(({ file, dir, role }, index) => {
    const text = texts[index]
    if (text === null || text === undefined) return
    const parsed = parseGoMod(text)
    if (!parsed) {
      ctx.warn({ kind: 'parse', file, message: `Couldn't parse ${file}`, detail: 'No module directive found' })
      return
    }
    modules.push({ dir, file, role, ...parsed, hasGoSum: ctx.files.has(joinPath(dir, 'go.sum')) })
  })
  return { modules, declaration }
}

/**
 * Role of a non-root package.json: a workspace member when workspace patterns
 * exist (and match its directory), otherwise a shallow nested package outside
 * test/example directories. Null when it is not part of the project.
 */
export function memberRole(file: string, patterns: readonly string[]): ManifestRole | null {
  if (patterns.length > 0) return matchPatterns(patterns, dirOf(file)) ? 'workspace' : null
  return depthOf(file) <= MAX_NESTED_PACKAGE_DEPTH && isProjectPath(file) ? 'nested' : null
}

/** The first MAX_WORKSPACE_PATTERNS patterns, with a warning when there are more. */
function limitPatterns(ctx: ProjectContext, file: string, patterns: string[]): string[] {
  if (patterns.length <= MAX_WORKSPACE_PATTERNS) return patterns
  ctx.warn({
    kind: 'limit',
    file,
    message: `Used only the first ${MAX_WORKSPACE_PATTERNS} of ${patterns.length} workspace patterns in ${file}`,
  })
  return patterns.slice(0, MAX_WORKSPACE_PATTERNS)
}

/** Parse a package.json; anything but a JSON object is reported once and yields null. */
async function readManifest(ctx: ProjectContext, file: string): Promise<Record<string, unknown> | null> {
  const raw = await ctx.readJson(file)
  if (isRecord(raw)) return raw
  // Same message as a JSON syntax error, so the two are deduplicated.
  ctx.warn({
    kind: 'parse',
    file,
    message: `Couldn't parse ${file}`,
    detail: raw === null ? 'Missing, unreadable or invalid JSON' : 'Expected a JSON object',
  })
  return null
}

export const manifests: Analyzer<ProjectManifests> = {
  id: 'manifests',
  async run(ctx) {
    const workspaces: WorkspaceDeclaration[] = []

    // Root package.json
    let root: PackageManifest | null = null
    let rootInvalid = false
    if (ctx.files.has('package.json')) {
      const raw = await readManifest(ctx, 'package.json')
      if (raw) root = normalizeManifest(raw, 'package.json', 'root')
      else rootInvalid = true
    }
    if (root && root.workspaces.length > 0) {
      root.workspaces = limitPatterns(ctx, 'package.json', root.workspaces)
      workspaces.push({ source: 'package.json', file: 'package.json', patterns: root.workspaces })
    }

    // pnpm-workspace.yaml (also the home of pnpm catalogs)
    let catalogs: ProjectManifests['catalogs'] = {}
    let pnpmPatterns: string[] | null = null
    if (ctx.files.has('pnpm-workspace.yaml')) {
      const doc = await ctx.readYaml('pnpm-workspace.yaml')
      if (isRecord(doc)) {
        pnpmPatterns = limitPatterns(ctx, 'pnpm-workspace.yaml', toStringArray(doc.packages))
        catalogs = readCatalogs(doc)
        workspaces.push({ source: 'pnpm-workspace.yaml', file: 'pnpm-workspace.yaml', patterns: pnpmPatterns })
      }
    }

    // lerna.json (legacy; only used when nothing else declares packages)
    let lernaPatterns: string[] | null = null
    if (ctx.files.has('lerna.json')) {
      const lerna = await ctx.readJson('lerna.json')
      if (isRecord(lerna) && Array.isArray(lerna.packages)) {
        lernaPatterns = limitPatterns(ctx, 'lerna.json', toStringArray(lerna.packages))
        workspaces.push({ source: 'lerna.json', file: 'lerna.json', patterns: lernaPatterns })
      }
    }

    const effectivePatterns =
      pnpmPatterns && pnpmPatterns.length > 0
        ? pnpmPatterns
        : root && root.workspaces.length > 0
          ? root.workspaces
          : (lernaPatterns ?? [])

    // Other package.json files: workspace members when patterns exist, otherwise shallow nested packages.
    const members = ctx.files.byName('package.json').flatMap((file) => {
      if (file === 'package.json') return []
      const role = memberRole(file, effectivePatterns)
      return role ? [{ file, role }] : []
    })
    const raws = await Promise.all(members.map(({ file }) => readManifest(ctx, file)))
    const packages: PackageManifest[] = []
    members.forEach(({ file, role }, index) => {
      const raw = raws[index]
      if (raw) packages.push(normalizeManifest(raw, file, role))
    })
    packages.sort((a, b) => compareText(a.dir, b.dir))
    if (root) packages.unshift(root)
    for (const manifest of packages) resolveCatalogs(manifest, catalogs)

    const [go, deno] = await Promise.all([loadGoModules(ctx), loadDenoConfigs(ctx)])
    if (go.declaration) workspaces.push(go.declaration)

    return {
      root,
      rootInvalid,
      packages,
      goModules: go.modules,
      workspaces,
      effectivePatterns,
      catalogs,
      deno,
    }
  },
}
