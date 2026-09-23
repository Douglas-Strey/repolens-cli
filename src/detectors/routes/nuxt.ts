/**
 * Nuxt file-system routing: server routes (`server/api`, `server/routes`) and
 * pages (`app/pages` in Nuxt 4, `pages` in Nuxt 3, or below the `srcDir` of
 * nuxt.config). Paths follow from file names alone, so every route is high
 * confidence.
 */
import type { HttpMethod, Route } from '../../types.ts'
import { dirOf, extOf, joinPath } from '../../utils/paths.ts'
import type { NuxtConfig } from './config.ts'
import { isTestFileName, joinRoutePath, makeRoute, toHttpMethod } from './shared.ts'

const SERVER_EXTENSIONS = new Set(['.ts', '.js', '.mjs', '.mts'])
const PAGE_EXTENSIONS = new Set(['.vue', '.tsx', '.jsx'])
const ENVIRONMENTS: Record<string, string> = {
  dev: 'development only',
  prod: 'production only',
  prerender: 'prerender only',
}

export interface FileRoute {
  method: HttpMethod
  /** Raw path (with [param] segments); normalized by makeRoute. */
  path: string
  note?: string
}

function stripExtension(file: string): string {
  const ext = extOf(file)
  return ext ? file.slice(0, -ext.length) : file
}

/** Drop route groups "(name)" and turn "index" into its parent. */
function pathSegments(segments: string[]): string[] {
  const out = segments.filter((segment) => !/^\(.*\)$/.test(segment))
  if (out[out.length - 1] === 'index') out.pop()
  return out
}

function isIgnoredSegment(segment: string): boolean {
  return segment.startsWith('.') || segment.startsWith('-')
}

/**
 * Route for a file below `server/api` (base "/api") or `server/routes`
 * (base ""), given its path relative to that directory, e.g. "users/[id].get.ts".
 */
export function nuxtServerRoute(relative: string, base: '/api' | ''): FileRoute | null {
  if (!SERVER_EXTENSIONS.has(extOf(relative)) || relative.endsWith('.d.ts')) return null
  const segments = stripExtension(relative).split('/')
  if (segments.some(isIgnoredSegment)) return null
  let name = segments.pop() as string
  let note: string | undefined
  const env = /^(.+)\.(dev|prod|prerender)$/.exec(name)
  if (env?.[1] && env[2]) {
    name = env[1]
    note = ENVIRONMENTS[env[2]]
  }
  let method: HttpMethod = 'ANY'
  const suffix = /^(.+)\.(get|post|put|patch|delete|head|options)$/i.exec(name)
  if (suffix?.[1] && suffix[2]) {
    name = suffix[1]
    method = toHttpMethod(suffix[2]) ?? 'ANY'
  }
  const path = `/${joinRoutePath(base.slice(1), ...pathSegments([...segments, name]))}`
  return { method, path, ...(note ? { note } : {}) }
}

/** Page route for a file below the pages directory, e.g. "products/[id].vue" → "/products/[id]". */
export function nuxtPageRoute(relative: string): FileRoute | null {
  if (!PAGE_EXTENSIONS.has(extOf(relative))) return null
  const segments = stripExtension(relative).split('/')
  if (segments.some(isIgnoredSegment)) return null
  return { method: 'GET', path: `/${pathSegments(segments).join('/')}` }
}

/** Files below `dir/` (posix, relative to the root), as paths relative to `dir`. */
export function filesBelow(files: readonly string[], dir: string): Array<{ file: string; relative: string }> {
  const prefix = dir === '.' ? '' : `${dir}/`
  const out: Array<{ file: string; relative: string }> = []
  for (const file of files) {
    if (file.startsWith(prefix)) out.push({ file, relative: file.slice(prefix.length) })
  }
  return out
}

export interface NuxtInput {
  /** Every indexed file. */
  files: readonly string[]
  /** The Nuxt package directory ("." = root). */
  packageDir: string
  hasDirectory(dir: string): boolean
  /** Owning package of a file, so nested packages are not attributed to this one. */
  ownerOf(file: string): string
  /** Routing options of nuxt.config (see parseNuxtConfig); defaults when absent. */
  config?: NuxtConfig
}

const SRC_DIR_NOTE = 'nuxt.config sets srcDir dynamically; routes assume the default layout'

/** Directories (relative to the package, with a trailing "/") holding pages and server routes. */
function layoutOf(input: NuxtInput): { pages: string; server: string } {
  const has = (dir: string) => input.hasDirectory(joinPath(input.packageDir, dir))
  const srcDir = input.config?.srcDir ?? null
  if (srcDir === null) return { pages: has('app/pages') ? 'app/pages/' : 'pages/', server: 'server/' }
  const src = srcDir === '.' ? '' : `${srcDir}/`
  // Nuxt 3 keeps server/ inside srcDir, Nuxt 4 at the package root.
  return { pages: `${src}pages/`, server: src !== '' && has(`${src}server`) ? `${src}server/` : 'server/' }
}

export function nuxtRoutes(input: NuxtInput): Route[] {
  const { packageDir } = input
  const routes: Route[] = []
  const configNote = input.config?.dynamic.includes('srcDir') ? SRC_DIR_NOTE : undefined
  const add = (file: string, route: FileRoute, kind: Route['kind'], extra?: string) => {
    const notes = [route.note, extra, configNote].filter((note): note is string => note !== undefined)
    const built = makeRoute({
      method: route.method,
      path: route.path,
      kind,
      framework: 'nuxt',
      file,
      confidence: 'high',
      package: packageDir,
      ...(notes.length > 0 ? { note: notes.join('; ') } : {}),
    })
    if (built) routes.push(built)
  }
  const layout = layoutOf(input)
  const serverApi = `${layout.server}api/`
  const serverRoutes = `${layout.server}routes/`
  const packageFiles = filesBelow(input.files, packageDir).filter(
    ({ file }) => !isTestFileName(file) && input.ownerOf(file) === packageDir,
  )
  for (const { file, relative } of packageFiles) {
    const route = relative.startsWith(serverApi)
      ? nuxtServerRoute(relative.slice(serverApi.length), '/api')
      : relative.startsWith(serverRoutes)
        ? nuxtServerRoute(relative.slice(serverRoutes.length), '')
        : null
    if (route) add(file, route, 'api')
  }

  const pages: Array<{ file: string; stem: string; route: FileRoute }> = []
  for (const { file, relative } of packageFiles) {
    if (!relative.startsWith(layout.pages)) continue
    const inside = relative.slice(layout.pages.length)
    const route = nuxtPageRoute(inside)
    if (route) pages.push({ file, stem: stripExtension(inside), route })
  }
  // `settings.vue` next to a `settings/` directory is the parent of nested routes: it wraps
  // them, and `settings/index.vue` (when present) is what `/settings` shows inside it.
  const pageDirs = new Set<string>()
  const indexDirs = new Set<string>()
  for (const { stem } of pages) {
    const dir = dirOf(stem)
    if (stem === 'index' || stem.endsWith('/index')) indexDirs.add(dir)
    for (let at = dir; at !== '.'; at = dirOf(at)) pageDirs.add(at)
  }
  for (const { file, stem, route } of pages) {
    if (!pageDirs.has(stem)) add(file, route, 'page')
    else if (!indexDirs.has(stem)) add(file, route, 'page', 'nested route parent')
  }
  return routes
}
