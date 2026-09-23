/**
 * Next.js file-system routing: the App Router (`app/` or `src/app/`: page and
 * route handler files) and the Pages Router (`pages/` or `src/pages/`). Only
 * route handlers are read, to find which HTTP methods they export, plus the
 * `basePath` and `pageExtensions` options of `next.config.*` (read
 * statically, never executed).
 */
import type { HttpMethod, Route } from '../../types.ts'
import { mapLimit } from '../../utils/limit.ts'
import { baseName, extOf, joinPath } from '../../utils/paths.ts'
import { NEXT_CONFIG_FILES, type NextConfig, parseNextConfig } from './config.ts'
import { filesBelow } from './nuxt.ts'
import { isTestFileName, joinRoutePath, makeRoute, type RouteInput, toHttpMethod } from './shared.ts'
import { analyzeSource } from './source.ts'

const PAGE_FILE = /^page\.(?:tsx|jsx|ts|js|mdx)$/
const ROUTE_FILE = /^route\.(?:ts|js|tsx|jsx)$/
const PAGES_ROUTER_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mdx'])
const PAGES_ROUTER_SPECIAL = new Set(['_app', '_document', '_error', '_middleware'])
const HANDLER_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])

/**
 * URL path of an App Router directory (relative to `app/`), or null when the
 * directory is not routable: private folders (`_x`) and intercepting routes
 * (`(.)x`, `(..)x`, `(...)x`) are excluded, route groups `(x)` and parallel
 * slots `@x` are removed.
 */
export function nextAppPath(dir: string): string | null {
  const out: string[] = []
  for (const raw of dir === '' || dir === '.' ? [] : dir.split('/')) {
    if (raw.startsWith('_')) return null
    if (/^\(\.{1,3}\)/.test(raw)) return null
    if (/^\(.*\)$/.test(raw) || raw.startsWith('@')) continue
    // "%5F" is how an App Router segment starts with a literal underscore.
    out.push(raw.replace(/^%5F/i, '_'))
  }
  return `/${out.join('/')}`
}

/** `page.tsx` → "page" for a configured extension list (`pageExtensions`), else null. */
function stemOf(name: string, pageExtensions: readonly string[]): string | null {
  let best: string | null = null
  for (const ext of pageExtensions) {
    if (name.endsWith(`.${ext}`) && (best === null || ext.length > best.length)) best = ext
  }
  return best === null ? null : name.slice(0, -(best.length + 1))
}

/**
 * App Router file (relative to `app/`) → page or route handler, or null.
 * `pageExtensions` (from next.config) replaces the default extensions.
 */
export function nextAppFile(
  relative: string,
  pageExtensions: readonly string[] | null = null,
): { kind: 'page' | 'handler'; path: string } | null {
  const name = baseName(relative)
  let kind: 'page' | 'handler' | null
  if (pageExtensions) {
    const stem = stemOf(name, pageExtensions)
    kind = stem === 'page' ? 'page' : stem === 'route' ? 'handler' : null
  } else {
    kind = PAGE_FILE.test(name) ? 'page' : ROUTE_FILE.test(name) ? 'handler' : null
  }
  if (!kind) return null
  const dir = relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : ''
  const path = nextAppPath(dir)
  return path === null ? null : { kind, path }
}

/**
 * Pages Router file (relative to `pages/`) → route, or null for special and
 * non-page files. With `pageExtensions` (e.g. `['page.tsx', 'api.ts']`) only
 * files ending in one of them are pages, and the whole extension is removed.
 */
export function nextPagesRoute(
  relative: string,
  pageExtensions: readonly string[] | null = null,
): { kind: 'page' | 'api'; path: string } | null {
  if (relative.endsWith('.d.ts')) return null
  let stem: string | null
  if (pageExtensions) {
    stem = stemOf(relative, pageExtensions)
  } else {
    const ext = extOf(relative)
    stem = PAGES_ROUTER_EXTENSIONS.has(ext) ? relative.slice(0, -ext.length) : null
  }
  if (stem === null || stem === '' || stem.endsWith('/')) return null
  const segments = stem.split('/')
  const name = segments[segments.length - 1] as string
  if (PAGES_ROUTER_SPECIAL.has(name)) return null
  if (name === 'index') segments.pop()
  const kind = segments[0] === 'api' ? 'api' : 'page'
  return { kind, path: `/${segments.join('/')}` }
}

const EXPORTED_FUNCTION = /\bexport\s+(?:async\s+)?function\s*(?:\*\s*)?([A-Z]+)\b/g
const EXPORTED_CONST = /\bexport\s+(?:const|let|var)\s+([A-Z]+)\b/g
const EXPORTED_DESTRUCTURED = /\bexport\s+(?:const|let|var)\s*\{([^{}]{0,1000})\}\s*=/g
const EXPORT_LIST = /\bexport\s*\{([^{}]{0,2000})\}/g

/** HTTP methods a route handler exports, with the 1-based line of each export. */
export function nextHandlerMethods(text: string): Array<{ method: HttpMethod; line: number }> {
  const src = analyzeSource(text, 'js')
  const found = new Map<HttpMethod, number>()
  const add = (name: string, offset: number) => {
    // `const doc = 'export function DELETE() {}'` exports nothing.
    if (src.inLiteral(offset)) return
    const method = HANDLER_METHODS.has(name) ? toHttpMethod(name) : null
    if (method && !found.has(method)) found.set(method, src.lineAt(offset))
  }
  for (const match of src.code.matchAll(EXPORTED_FUNCTION)) add(match[1] as string, match.index)
  for (const match of src.code.matchAll(EXPORTED_CONST)) add(match[1] as string, match.index)
  for (const match of src.code.matchAll(EXPORTED_DESTRUCTURED)) {
    for (const item of (match[1] ?? '').split(',')) {
      const bound = item.split(':').pop()?.trim() ?? ''
      add(bound, match.index)
    }
  }
  for (const match of src.code.matchAll(EXPORT_LIST)) {
    for (const item of (match[1] ?? '').split(',')) {
      const exported =
        item
          .trim()
          .replace(/^type\s+/, '')
          .split(/\s+as\s+/)
          .pop()
          ?.trim() ?? ''
      add(exported, match.index)
    }
  }
  return [...found].map(([method, line]) => ({ method, line }))
}

export interface NextInput {
  files: readonly string[]
  packageDir: string
  hasDirectory(dir: string): boolean
  ownerOf(file: string): string
  /** Read a route handler; null when unreadable. */
  read(file: string): Promise<string | null>
}

function routerDir(input: NextInput, name: 'app' | 'pages'): string | null {
  const has = (dir: string) => input.hasDirectory(joinPath(input.packageDir, dir))
  // Next.js ignores src/app and src/pages as soon as app/ or pages/ exists at the package root.
  const base = has('app') || has('pages') ? '' : 'src/'
  return has(`${base}${name}`) ? `${base}${name}` : null
}

/** The package's `next.config.*`, parsed statically; defaults when there is none. */
async function readConfig(input: NextInput, packageFiles: ReadonlyArray<{ file: string; relative: string }>) {
  const present = new Map(packageFiles.map(({ file, relative }) => [relative, file]))
  const file = NEXT_CONFIG_FILES.map((name) => present.get(name)).find((found) => found !== undefined)
  return parseNextConfig(file === undefined ? null : await input.read(file))
}

const DYNAMIC_NOTES: Record<NextConfig['dynamic'][number], string> = {
  basePath: 'next.config sets basePath dynamically; a prefix may apply',
  pageExtensions: 'next.config sets pageExtensions dynamically; files were matched by the default extensions',
}

export async function nextRoutes(input: NextInput): Promise<Route[]> {
  const { packageDir } = input
  const routes: Route[] = []
  const allFiles = filesBelow(input.files, packageDir).filter(({ file }) => input.ownerOf(file) === packageDir)
  const config = await readConfig(input, allFiles)
  const configNotes = config.dynamic.map((option) => DYNAMIC_NOTES[option])
  const push = (route: Omit<RouteInput, 'framework' | 'package'>) => {
    const notes = [route.note, ...configNotes].filter((note): note is string => note !== undefined)
    const built = makeRoute({
      ...route,
      framework: 'next',
      package: packageDir,
      path: joinRoutePath(config.basePath, route.path),
      // A basePath RepoLens cannot read may change every path.
      confidence: config.dynamic.includes('basePath') && route.confidence === 'high' ? 'medium' : route.confidence,
      ...(notes.length > 0 ? { note: notes.join('; ') } : {}),
    })
    if (built) routes.push(built)
  }
  const packageFiles = allFiles.filter(({ file }) => !isTestFileName(file))
  const extensions = config.pageExtensions

  const appDir = routerDir(input, 'app')
  if (appDir) {
    const handlers: Array<{ file: string; path: string }> = []
    const slotPages: Array<{ file: string; path: string }> = []
    const pagePaths = new Set<string>()
    for (const { file, relative } of packageFiles) {
      if (!relative.startsWith(`${appDir}/`)) continue
      const inside = relative.slice(appDir.length + 1)
      const entry = nextAppFile(inside, extensions)
      if (!entry) continue
      if (entry.kind === 'handler') {
        handlers.push({ file, path: entry.path })
      } else if (inside.split('/').some((segment) => segment.startsWith('@'))) {
        slotPages.push({ file, path: entry.path })
      } else {
        pagePaths.add(entry.path)
        push({ method: 'GET', path: entry.path, kind: 'page', file, confidence: 'high' })
      }
    }
    // A parallel-route slot renders inside the page at the same URL; it only adds a URL no page serves.
    for (const { file, path } of slotPages) {
      if (!pagePaths.has(path)) push({ method: 'GET', path, kind: 'page', file, confidence: 'high' })
    }
    const texts = await mapLimit(handlers, 8, (handler) => input.read(handler.file))
    for (const [index, handler] of handlers.entries()) {
      const text = texts[index] ?? null
      const methods = text === null ? [] : nextHandlerMethods(text)
      if (methods.length === 0) {
        push({
          method: 'ANY',
          path: handler.path,
          kind: 'api',
          file: handler.file,
          confidence: 'low',
          note: 'no exported HTTP method handlers found',
        })
      }
      for (const { method, line } of methods) {
        push({ method, path: handler.path, kind: 'api', file: handler.file, line, confidence: 'high' })
      }
    }
  }

  const pagesDir = routerDir(input, 'pages')
  if (pagesDir) {
    for (const { file, relative } of packageFiles) {
      if (!relative.startsWith(`${pagesDir}/`)) continue
      const entry = nextPagesRoute(relative.slice(pagesDir.length + 1), extensions)
      if (!entry) continue
      push({
        method: entry.kind === 'api' ? 'ANY' : 'GET',
        path: entry.path,
        kind: entry.kind,
        file,
        confidence: 'high',
      })
    }
  }
  return routes
}
