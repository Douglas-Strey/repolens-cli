import path from 'node:path'
import { useOr } from '../core/context.ts'
import { getString, isRecord } from '../core/parse.ts'
import { type DependencyIndex, dependencies } from '../facts/dependencies.ts'
import { manifests, type PackageManifest, type ProjectManifests } from '../facts/manifests.ts'
import { MAX_SOURCE_FILE_BYTES } from '../facts/source-files.ts'
import type { Detector, DirectorySummary, Entrypoint, ProjectContext, ProjectSection, ProjectType } from '../types.ts'
import { compareText } from '../utils/compare.ts'
import { mapLimit } from '../utils/limit.ts'
import { isUnder, NON_PROJECT_ROLES } from '../utils/path-roles.ts'
import { baseName, dirOf, joinPath, normalizeRelative } from '../utils/paths.ts'
import { redactCommand, sanitizeUrl } from '../utils/redact.ts'
import { findFirst, startsNetHttpServer } from './frameworks.ts'
import { goModuleOf } from './knowledge/layout.ts'
import { workspaceDetector } from './workspace.ts'

/** Root files that describe a project, in output order. */
export const ROOT_MANIFESTS: readonly string[] = [
  'package.json',
  'go.mod',
  'go.work',
  'deno.json',
  'deno.jsonc',
  'Cargo.toml',
  'pyproject.toml',
  'requirements.txt',
  'Pipfile',
  'setup.py',
  'Gemfile',
  'composer.json',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'mix.exs',
  'pubspec.yaml',
  'Package.swift',
]

const LICENSE_FILES = [
  'LICENSE',
  'LICENSE.md',
  'LICENSE.txt',
  'LICENCE',
  'LICENCE.md',
  'LICENCE.txt',
  'COPYING',
  'COPYING.md',
  'COPYING.txt',
]

const MAX_STRUCTURE_ENTRIES = 15
/** Longest repository/homepage value considered; real ones are far shorter. */
const MAX_URL_LENGTH = 2048
const READ_CONCURRENCY = 16
/** Upper bound on directories inspected for Go `main` packages. */
const MAX_GO_MAIN_DIRS = 2000
/** Files tried per directory before giving up on finding its package clause. */
const MAX_GO_FILES_PER_DIR = 20
/** Go files searched for a net/http server when nothing else shows an application. */
const MAX_GO_SERVER_FILES = 200

// ---------------------------------------------------------------------------
// Name, repository, license
// ---------------------------------------------------------------------------

/** Display name of a Go module: last path element, skipping a major-version suffix ("…/api/v2" → "api"). */
export function goModuleName(modulePath: string): string {
  const segments = modulePath.split('/').filter(Boolean)
  let last = segments.pop() ?? modulePath
  if (/^v\d+$/.test(last) && segments.length > 0) last = segments.pop() as string
  return last
}

const SHORTHAND_HOSTS: Readonly<Record<string, string>> = {
  github: 'https://github.com/',
  gitlab: 'https://gitlab.com/',
  bitbucket: 'https://bitbucket.org/',
  gist: 'https://gist.github.com/',
}

/**
 * An scp-style path inside an ssh URL, which npm accepts:
 * ssh://git@github.com:user/repo.git → https://github.com/user/repo.git.
 * The userinfo is dropped; a numeric port is left alone.
 */
function sshScpToHttps(url: string): string {
  const match = /^(?:ssh|git):\/\/([^/\s]*)(.*)$/is.exec(url)
  if (!match) return url
  const authority = match[1] ?? ''
  const hostPart = authority.slice(authority.lastIndexOf('@') + 1)
  const colon = hostPart.indexOf(':')
  if (colon <= 0 || /^\d*$/.test(hostPart.slice(colon + 1))) return url
  return `https://${hostPart.slice(0, colon)}/${hostPart.slice(colon + 1)}${match[2] ?? ''}`
}

/**
 * Normalize package.json `repository` (a string or `{ url }`) to a browsable
 * https URL without credentials. Returns undefined for values that are not URLs.
 */
export function normalizeRepositoryUrl(value: unknown): string | undefined {
  const raw = (typeof value === 'string' ? value : getString(value, 'url'))?.trim()
  // Also keeps hostile input away from regexes that backtrack on long strings.
  if (!raw || raw.length > MAX_URL_LENGTH) return undefined
  let url = raw

  const shorthand = /^(github|gitlab|bitbucket|gist):(.+)$/.exec(url)
  if (shorthand?.[1] && shorthand[2]) {
    url = `${SHORTHAND_HOSTS[shorthand[1]]}${shorthand[2].replace(/^\/+/, '')}`
  } else if (/^[\w-]+\/[\w.-]+$/.test(url)) {
    // "user/repo"; GitHub user names have no dots, so "gitlab.com/group" is not one.
    url = `https://github.com/${url}`
  } else if (/^(?:www\.)?(?:github\.com|gitlab\.com|bitbucket\.org)\//i.test(url)) {
    url = `https://${url}`
  }

  url = url.replace(/^git\+/, '')
  // scp-style: git@github.com:user/repo.git
  const scp = /^(?:[^@/\s:]+@)?([^/\s:]+\.[^/\s:]+):(?!\/\/)(.+)$/.exec(url)
  if (scp?.[1] && scp[2] && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `https://${scp[1]}/${scp[2]}`
  url = sshScpToHttps(url).replace(/^(?:ssh|git):\/\//i, 'https://')

  url = sanitizeUrl(url)
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
  if (!/^https?:\/\/[^\s/]+/i.test(url)) return undefined
  return redactCommand(url)
}

/** Normalized text used to match license files: lowercase, single spaces. */
function normalizeLicenseText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d]/g, "'")
    .replace(/[^a-z0-9.,'()/-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const KNOWN_LICENSES = [
  'MIT',
  'Apache-2.0',
  'BSD-3-Clause',
  'BSD-2-Clause',
  'GPL-3.0',
  'GPL-2.0',
  'AGPL-3.0',
  'LGPL-3.0',
  'MPL-2.0',
  'ISC',
  'Unlicense',
]

/**
 * Distinctive wording per license, matched against normalized text. GPL-family
 * titles are only matched near the top: the GPL itself mentions the AGPL.
 */
const LICENSE_TESTS: ReadonlyArray<readonly [string, (text: string, head: string) => boolean]> = [
  ['AGPL-3.0', (_, head) => /gnu affero general public license version 3/.test(head)],
  ['LGPL-3.0', (_, head) => /gnu lesser general public license version 3/.test(head)],
  ['GPL-3.0', (_, head) => /gnu general public license version 3/.test(head)],
  ['GPL-2.0', (_, head) => /gnu general public license version 2, june 1991/.test(head)],
  ['MPL-2.0', (_, head) => /mozilla public license,? version 2\.0/.test(head)],
  ['Apache-2.0', (text) => /apache license,? version 2\.0/.test(text)],
  ['Unlicense', (text) => /this is free and unencumbered software released into the public domain/.test(text)],
  [
    'MIT',
    (text) =>
      /permission is hereby granted, free of charge, to any person obtaining a copy/.test(text) &&
      /the above copyright notice and this permission notice shall be included/.test(text),
  ],
  [
    'ISC',
    (text) =>
      /permission to use, copy, modify, and(?:\/or)? distribute this software for any purpose with or without fee is hereby granted/.test(
        text,
      ) && /provided that the above copyright notice and this permission notice appear in all copies/.test(text),
  ],
  [
    'BSD-3-Clause',
    (text) => isBsd(text) && /neither the name of|names of its contributors may (?:not )?be used/.test(text),
  ],
  [
    'BSD-2-Clause',
    (text) => isBsd(text) && !/neither the name of|names of its contributors may (?:not )?be used/.test(text),
  ],
]

function isBsd(text: string): boolean {
  return (
    /redistribution and use in source and binary forms, with or without modification, are permitted/.test(text) &&
    !/all advertising materials mentioning features/.test(text) // BSD-4-Clause
  )
}

/**
 * Identify a license from the text of a LICENSE/COPYING file. Answers only
 * when an SPDX tag or exactly one license's distinctive wording is found, so
 * dual-license or unfamiliar texts return undefined.
 */
export function identifyLicense(text: string): string | undefined {
  // Only a single identifier; expressions such as "MIT OR Apache-2.0" are not one license.
  const spdx = /SPDX-License-Identifier:[ \t]*([A-Za-z0-9.+-]+)[ \t]*$/m.exec(text)?.[1]
  if (spdx) {
    const base = spdx.replace(/-(?:only|or-later)$|\+$/, '').toLowerCase()
    const match = KNOWN_LICENSES.find((id) => id.toLowerCase() === base)
    if (match) return match
  }
  const normalized = normalizeLicenseText(text)
  const head = normalized.slice(0, 600)
  const matches = LICENSE_TESTS.filter(([, test]) => test(normalized, head)).map(([id]) => id)
  return matches.length === 1 ? matches[0] : undefined
}

/** package.json `license`, including the legacy `{ type }` and `licenses: [{ type }]` forms. */
export function manifestLicense(raw: Record<string, unknown>): string | undefined {
  const license = raw.license
  if (typeof license === 'string' && license.trim() !== '') return license.trim()
  const fromObject = getString(license, 'type')
  if (fromObject) return fromObject
  if (Array.isArray(raw.licenses)) {
    const types = raw.licenses.map((entry) => getString(entry, 'type')).filter((type): type is string => !!type)
    if (types.length > 0) return types.join(' OR ')
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Project type
// ---------------------------------------------------------------------------

/** Frameworks that make a package an application. Server frameworks only count as runtime dependencies. */
const FRONTEND_APP_DEPENDENCIES = [
  'next',
  'nuxt',
  '@remix-run/node',
  '@react-router/dev',
  'astro',
  '@sveltejs/kit',
  '@angular/core',
  'react-scripts',
  'gatsby',
  'expo',
  'react-native',
]
const SERVER_APP_DEPENDENCIES = [
  'express',
  'fastify',
  '@nestjs/core',
  'koa',
  'hono',
  '@hono/hono',
  '@oak/oak',
  '@hapi/hapi',
  'elysia',
  '@adonisjs/core',
]
const GO_APP_MODULES = [
  'github.com/gin-gonic/gin',
  'github.com/labstack/echo',
  'github.com/go-chi/chi',
  'github.com/gofiber/fiber',
  'github.com/gorilla/mux',
]

/** Fields only a package meant for publishing needs. */
const PUBLISH_FIELDS = ['exports', 'module', 'types', 'typings', 'files', 'publishConfig']
/** `main` pointing at build output; applications usually point it at the file they run. */
const BUILD_OUTPUT_MAIN = /^(?:\.\/)?(?:dist|lib|cjs|esm|umd)\//

/**
 * A package prepared for publishing: not private, with a publish-only field or
 * a `main` inside build output. `main` alone proves nothing: `npm init -y`
 * writes "main": "index.js" into every new application.
 */
export function isLibraryShaped(raw: Record<string, unknown>): boolean {
  if (raw.private === true) return false
  if (PUBLISH_FIELDS.some((key) => raw[key] !== undefined && raw[key] !== null)) return true
  const main = getString(raw, 'main')
  return main !== undefined && BUILD_OUTPUT_MAIN.test(main.trim())
}

/** Server framework in the manifest's runtime dependencies, if any. */
export function serverFramework(manifest: Pick<PackageManifest, 'dependencies'>): string | undefined {
  return SERVER_APP_DEPENDENCIES.find((name) => Object.hasOwn(manifest.dependencies, name))
}

function goModuleMatches(name: string, prefix: string): boolean {
  return name === prefix || name.startsWith(`${prefix}/`)
}

/**
 * Evidence that some package is an application. Dev dependencies only count
 * for packages that are not publishable libraries (a Nuxt module keeps nuxt in
 * devDependencies for its playground); peer dependencies never count.
 */
export function applicationEvidence(
  project: ProjectManifests,
  deps: DependencyIndex,
  hasFile: (path: string) => boolean,
): string | undefined {
  for (const manifest of project.packages) {
    const library = isLibraryShaped(manifest.raw)
    const declares = (name: string, allowDev: boolean) =>
      Object.hasOwn(manifest.dependencies, name) || (allowDev && Object.hasOwn(manifest.devDependencies, name))
    const where = manifest.file
    for (const name of FRONTEND_APP_DEPENDENCIES) {
      if (declares(name, !library)) return `dependency ${name} in ${where}`
    }
    if (declares('electron', true)) return `dependency electron in ${where}`
    for (const name of SERVER_APP_DEPENDENCIES) {
      if (declares(name, false)) return `dependency ${name} in ${where}`
    }
    if (declares('vite', !library) && hasFile(joinPath(manifest.dir, 'index.html'))) {
      return `dependency vite with ${joinPath(manifest.dir, 'index.html')}`
    }
    // Something to start is what an application has and a library does not.
    if (manifest.role === 'root' && !library && manifest.scripts.start?.trim()) {
      return `"start" script in ${where}`
    }
  }
  for (const config of project.deno ?? []) {
    const app = config.imports.find(
      (dep) => SERVER_APP_DEPENDENCIES.includes(dep.name) || FRONTEND_APP_DEPENDENCIES.includes(dep.name),
    )
    if (app) return `import ${app.name} in ${config.file}`
  }
  for (const ref of deps.all) {
    if (ref.ecosystem !== 'go' || ref.indirect) continue
    if (GO_APP_MODULES.some((prefix) => goModuleMatches(ref.name, prefix))) {
      return `dependency ${ref.name} in ${ref.file}`
    }
  }
  return undefined
}

export function inferProjectType(input: {
  workspacePackages: number
  root: PackageManifest | null
  applicationEvidence?: string
  goMainPackages: number
  hasRootGoModule: boolean
}): ProjectType {
  if (input.workspacePackages >= 2) return 'monorepo'
  // `"bin": {}` or a bin pointing outside the root is not a command. A server
  // framework outranks bin: such a package is a server with a launcher command.
  const server = input.root ? serverFramework(input.root) : undefined
  if (input.root && binEntrypoints(input.root).length > 0 && !server) return 'cli'
  if (input.applicationEvidence || server || input.goMainPackages > 0) return 'application'
  if (input.root && isLibraryShaped(input.root.raw)) return 'library'
  if (input.hasRootGoModule) return 'library'
  return 'unknown'
}

// ---------------------------------------------------------------------------
// Entrypoints and structure
// ---------------------------------------------------------------------------

/**
 * Package name from a Go file's package clause, or null when there is none or
 * the file is excluded from builds (`//go:build ignore` scripts).
 */
export function goPackageName(text: string): string | null {
  let inBlock = false
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim()
    if (inBlock) {
      const end = line.indexOf('*/')
      if (end === -1) continue
      inBlock = false
      line = line.slice(end + 2).trim()
    }
    if (line === '') continue
    if (line.startsWith('//')) {
      if (/^\/\/\s*(?:go:build|\+build)\s+ignore\s*$/.test(line)) return null
      continue
    }
    if (line.startsWith('/*')) {
      const end = line.indexOf('*/', 2)
      if (end === -1) {
        inBlock = true
        continue
      }
      line = line.slice(end + 2).trim()
      if (line === '') continue
    }
    return /^package\s+([A-Za-z_]\w*)/.exec(line)?.[1] ?? null
  }
  return null
}

/**
 * Programs in test, fixture, example, template, playground or benchmark
 * directories are samples or helpers, not the project's entry points. Go also
 * ignores directories starting with "." or "_".
 */
function isEntrypointPath(file: string): boolean {
  if (isUnder(file, NON_PROJECT_ROLES)) return false
  const segments = file.split('/')
  segments.pop()
  return !segments.some((segment) => segment.startsWith('.') || segment.startsWith('_'))
}

/**
 * Candidate files per directory: main.go anywhere, .go files directly under
 * cmd/<name>/, and .go files at the top of each Go module (a server in
 * server.go or hello.go). main.go is tried first.
 */
export function goMainCandidates(
  mainFiles: readonly string[],
  cmdFiles: readonly string[],
  moduleRootFiles: readonly string[] = [],
): Map<string, string[]> {
  const byDir = new Map<string, string[]>()
  for (const file of [...mainFiles, ...cmdFiles, ...moduleRootFiles]) {
    if (file.endsWith('_test.go') || !isEntrypointPath(file)) continue
    const dir = dirOf(file)
    const list = byDir.get(dir)
    if (!list) byDir.set(dir, [file])
    else if (!list.includes(file)) list.push(file)
  }
  for (const [dir, list] of byDir) {
    list.sort((a, b) => {
      const aMain = baseName(a) === 'main.go'
      const bMain = baseName(b) === 'main.go'
      if (aMain !== bMain) return aMain ? -1 : 1
      return compareText(a, b)
    })
    // The first readable file decides; the cap only matters when many files lack a package clause.
    if (list.length > MAX_GO_FILES_PER_DIR) byDir.set(dir, list.slice(0, MAX_GO_FILES_PER_DIR))
  }
  return byDir
}

async function goMainPackages(ctx: ProjectContext, moduleDirs: readonly string[]): Promise<string[]> {
  const modules = new Set(moduleDirs)
  const moduleRootFiles = ctx.files.byExtension('.go').filter((file) => modules.has(dirOf(file)))
  const candidates = goMainCandidates(ctx.files.byName('main.go'), ctx.files.glob('**/cmd/*/*.go'), moduleRootFiles)
  let dirs = [...candidates.keys()].sort(compareText)
  if (dirs.length > MAX_GO_MAIN_DIRS) {
    ctx.debug(`project: checking only ${MAX_GO_MAIN_DIRS} of ${dirs.length} Go directories for main packages`)
    dirs = dirs.slice(0, MAX_GO_MAIN_DIRS)
  }
  const isMain = await mapLimit(dirs, READ_CONCURRENCY, async (dir) => {
    // Every non-test file of a Go package shares one package clause, so the first readable one decides.
    for (const file of candidates.get(dir) ?? []) {
      const text = await ctx.readText(file, { cache: false })
      const name = text === null ? null : goPackageName(text)
      if (name !== null) return name === 'main'
    }
    return false
  })
  return dirs.filter((_, i) => isMain[i])
}

export interface GoServer {
  file: string
  /** The file belongs to a `main` package (its directory is an entry point). */
  main: boolean
}

/**
 * First Go file (path order, bounded) that starts a net/http server. Only
 * consulted when no main package was found: a module that calls
 * ListenAndServe is an application even when its main package lives in an
 * unusual place.
 */
async function goHttpServer(ctx: ProjectContext, moduleDirs: readonly string[]): Promise<GoServer | null> {
  const modules = new Set(moduleDirs)
  const files = ctx.files
    .byExtension('.go')
    .filter((file) => !file.endsWith('_test.go') && isEntrypointPath(file) && goModuleOf(file, modules) !== null)
    .slice(0, MAX_GO_SERVER_FILES)
  let found: GoServer | null = null
  await findFirst(files, async (file) => {
    const text = await ctx.readText(file, { cache: false, maxBytes: MAX_SOURCE_FILE_BYTES })
    if (text === null || !startsNetHttpServer(text)) return false
    found = { file, main: goPackageName(text) === 'main' }
    return true
  })
  return found
}

/** Unscoped part of a package name, which npm uses as the command for a string `bin`. */
function commandName(packageName: string): string {
  return packageName.replace(/^@[^/]+\//, '')
}

/** `bin` commands of a manifest. Paths escaping the root are dropped. */
export function binEntrypoints(manifest: Pick<PackageManifest, 'dir' | 'name' | 'raw'>): Entrypoint[] {
  const bin = manifest.raw.bin
  const pairs: Array<[string, string]> = []
  if (typeof bin === 'string') {
    const name = manifest.name ? commandName(manifest.name) : baseName(bin).replace(/\.[^.]+$/, '')
    pairs.push([name, bin])
  } else if (isRecord(bin)) {
    for (const [name, file] of Object.entries(bin)) if (typeof file === 'string') pairs.push([name, file])
  }
  const out: Entrypoint[] = []
  for (const [name, file] of pairs) {
    const target = normalizeRelative(joinPath(manifest.dir, file.trim()))
    if (target === null || target === '.' || name.trim() === '') continue
    out.push({ kind: 'bin', path: target, name: name.trim() })
  }
  return out
}

export function compareEntrypoints(a: Entrypoint, b: Entrypoint): number {
  return compareText(a.kind, b.kind) || compareText(a.path, b.path) || compareText(a.name ?? '', b.name ?? '')
}

/** Top-level directories with their file counts, largest first, then by name. */
export function summarizeStructure(files: readonly string[], limit = MAX_STRUCTURE_ENTRIES): DirectorySummary[] {
  const counts = new Map<string, number>()
  for (const file of files) {
    const slash = file.indexOf('/')
    if (slash <= 0) continue
    const top = file.slice(0, slash)
    counts.set(top, (counts.get(top) ?? 0) + 1)
  }
  return [...counts]
    .map(([dir, count]) => ({ path: dir, files: count }))
    .sort((a, b) => b.files - a.files || compareText(a.path, b.path))
    .slice(0, limit)
}

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

async function licenseFromFile(ctx: ProjectContext): Promise<string | undefined> {
  for (const file of LICENSE_FILES) {
    if (!ctx.files.has(file)) continue
    const text = await ctx.readText(file)
    const license = text === null ? undefined : identifyLicense(text)
    if (license) return license
  }
  return undefined
}

export const projectDetector: Detector<'project'> = {
  id: 'project',
  title: 'Project',
  async run(ctx) {
    const [project, deps, workspace] = await Promise.all([
      ctx.use(manifests),
      ctx.use(dependencies),
      useOr(ctx, workspaceDetector, null),
    ])
    const goModuleDirs = project.goModules.map((mod) => mod.dir)
    const goMains = await goMainPackages(ctx, goModuleDirs)
    const directory = path.basename(ctx.root)
    const root = project.root
    const rootGo = project.goModules.find((mod) => mod.dir === '.')

    let appEvidence = applicationEvidence(project, deps, (file) => ctx.files.has(file))
    const typeInput = {
      workspacePackages: workspace?.packages.length ?? 0,
      root,
      applicationEvidence: appEvidence,
      goMainPackages: goMains.length,
      hasRootGoModule: rootGo !== undefined,
    }
    let type = inferProjectType(typeInput)
    if ((type === 'library' || type === 'unknown') && goModuleDirs.length > 0 && !(root && isLibraryShaped(root.raw))) {
      const server = await goHttpServer(ctx, goModuleDirs)
      if (server) {
        appEvidence = `net/http server in ${server.file}`
        type = inferProjectType({ ...typeInput, applicationEvidence: appEvidence })
        if (server.main && !goMains.includes(dirOf(server.file))) goMains.push(dirOf(server.file))
      }
    }
    ctx.debug(`project: type ${type}${type === 'application' && appEvidence ? ` (${appEvidence})` : ''}`)

    const section: ProjectSection = {
      name: root?.name ?? (rootGo ? goModuleName(rootGo.module) : directory),
      directory,
      type,
      manifests: ROOT_MANIFESTS.filter((file) => ctx.files.has(file)),
      entrypoints: [],
      structure: summarizeStructure(ctx.files.files),
    }

    if (root?.description) section.description = root.description
    if (root?.version) section.version = root.version
    const license = (root ? manifestLicense(root.raw) : undefined) ?? (await licenseFromFile(ctx))
    if (license) section.license = license
    if (root?.private !== undefined) section.private = root.private
    const repository = root ? normalizeRepositoryUrl(root.raw.repository) : undefined
    if (repository) section.repository = repository
    const homepage = getString(root?.raw, 'homepage')?.trim()
    if (homepage && homepage.length <= MAX_URL_LENGTH && /^https?:\/\/[^\s/]/i.test(homepage)) {
      section.homepage = redactCommand(sanitizeUrl(homepage))
    }

    const entrypoints: Entrypoint[] = goMains.map((dir) => ({ kind: 'go-main', path: dir }))
    for (const manifest of project.packages) {
      if (manifest.role === 'root' || manifest.role === 'workspace') entrypoints.push(...binEntrypoints(manifest))
    }
    section.entrypoints = entrypoints.sort(compareEntrypoints)
    return section
  },
}
