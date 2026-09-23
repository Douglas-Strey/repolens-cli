import type { Confidence, HttpMethod, Route } from '../../types.ts'
import { compareText } from '../../utils/compare.ts'
import { isTestFileName as isTestName, isUnder, NON_PROJECT_ROLES } from '../../utils/path-roles.ts'
import { baseName } from '../../utils/paths.ts'
import { redactCommand } from '../../utils/redact.ts'
import { cleanUntrusted } from '../../utils/text.ts'

/** Maximum number of routes reported; more sets `truncated`. */
export const MAX_ROUTES = 2000

/** Display and sort order of methods. */
export const METHOD_ORDER: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'ANY']

const METHOD_RANK = new Map<string, number>(METHOD_ORDER.map((method, index) => [method, index]))
const CONFIDENCE_RANK: Record<Confidence, number> = { high: 0, medium: 1, low: 2 }

/** Longest route path RepoLens reports; longer literals are almost certainly not routes. */
const MAX_PATH_LENGTH = 512

/**
 * Map a method name as written in code or a file name ("get", "Get", "GET",
 * "all", "Any") to an HttpMethod. Returns null for anything else.
 */
export function toHttpMethod(name: string): HttpMethod | null {
  const upper = name.toUpperCase()
  if (upper === 'ALL' || upper === 'ANY') return 'ANY'
  return METHOD_RANK.has(upper) ? (upper as HttpMethod) : null
}

export interface ParsedPath {
  path: string
  /** Extra context from the syntax, e.g. "optional catch-all". */
  notes: string[]
}

const IDENT_START = /[A-Za-z_$]/
const IDENT_PART = /[\w$]/

/** Index of the bracket closing the one at `open`, honoring nesting; -1 when unbalanced. */
function matchingBracket(text: string, open: number, left: string, right: string): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\\') {
      i++
    } else if (ch === left) {
      depth++
    } else if (ch === right) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

const FS_SEGMENT = /^\[\[\.\.\.([^\]/]*)\]\]|^\[\.\.\.([^\]/]*)\]|^\[\[([^\]/]+)\]\]|^\[([^\]/]+)\]/

/**
 * Normalize a route path written in any supported syntax and collect notes.
 *
 * - file-system segments: `[id]` → `:id`, `[...slug]` → `*slug`,
 *   `[[...slug]]` → `*slug` (optional catch-all), `[[id]]` → `:id` (optional)
 * - brace segments (Go, chi, gorilla): `{id}` / `{id:[0-9]+}` → `:id`,
 *   `{path...}` → `*path`, `{$}` → removed
 * - colon parameters keep their name; regex constraints (`:id(\\d+)`,
 *   `:id{[0-9]+}`) and optional markers (`:id?`) are dropped
 * - leading "/" ensured, duplicate slashes collapsed, trailing slash removed
 */
export function parseRoutePath(raw: string): ParsedPath {
  const notes = new Set<string>()
  let out = ''
  let i = 0
  while (i < raw.length) {
    const ch = raw[i] as string
    if (ch === '[') {
      const match = FS_SEGMENT.exec(raw.slice(i, i + 256))
      if (match) {
        if (match[1] !== undefined) {
          out += `*${match[1]}`
          notes.add('optional catch-all')
        } else if (match[2] !== undefined) {
          out += `*${match[2]}`
        } else if (match[3] !== undefined) {
          out += `:${match[3]}`
          notes.add('optional parameter')
        } else {
          out += `:${match[4]}`
        }
        i += match[0].length
        continue
      }
    } else if (ch === '{') {
      const close = matchingBracket(raw, i, '{', '}')
      if (close !== -1) {
        const inner = raw.slice(i + 1, close)
        const catchAll = /^([A-Za-z_]\w*)\.\.\.$/.exec(inner)
        const param = /^([A-Za-z_][\w-]*)(?::[\s\S]*)?$/.exec(inner)
        if (inner === '$') {
          // Go's "{$}" only anchors the match at the end of the path.
        } else if (catchAll) {
          out += `*${catchAll[1]}`
        } else if (param) {
          out += `:${param[1]}`
        } else {
          // Express 5 optional group, e.g. "/users{/:id}".
          out += parseRoutePath(inner).path
          notes.add('optional segment')
        }
        i = close + 1
        continue
      }
    } else if (ch === ':' && IDENT_START.test(raw[i + 1] ?? '')) {
      let j = i + 1
      while (j < raw.length && IDENT_PART.test(raw[j] as string)) j++
      out += `:${raw.slice(i + 1, j)}`
      const next = raw[j]
      if (next === '(' || next === '{') {
        const close = matchingBracket(raw, j, next, next === '(' ? ')' : '}')
        if (close !== -1) j = close + 1
      }
      if (raw[j] === '?') {
        notes.add('optional parameter')
        j++
      }
      i = j
      continue
    } else if (ch === '*') {
      let j = i + 1
      while (j < raw.length && /\w/.test(raw[j] as string)) j++
      out += raw.slice(i, j)
      i = j
      continue
    }
    out += ch
    i++
  }
  out = out.replace(/\/{2,}/g, '/')
  if (!out.startsWith('/')) out = `/${out}`
  if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1)
  return { path: out, notes: [...notes] }
}

/** Normalized route path (see parseRoutePath). */
export function normalizePath(raw: string): string {
  return parseRoutePath(raw).path
}

/** Join raw path parts (prefixes and a route path) with "/"; normalization collapses the extra slashes. */
export function joinRoutePath(...parts: string[]): string {
  return parts.filter((part) => part !== '').join('/')
}

export interface RouteInput {
  method: HttpMethod
  /** Raw path, normalized here. */
  path: string
  kind: Route['kind']
  framework: string
  file: string
  line?: number
  confidence: Confidence
  package: string
  note?: string
}

/** Whitespace other than a plain space: line breaks and tabs cannot be part of a route path, exotic spaces disguise one. */
const NON_SPACE_WHITESPACE = /[^\S ]/g

/**
 * Build a Route from raw input: normalizes the path, strips control, bidi,
 * zero-width and non-space whitespace characters (committed text must not be
 * able to inject terminal escapes or disguise a path) and redacts anything
 * that looks like a credential. Returns null for implausible paths.
 */
export function makeRoute(input: RouteInput): Route | null {
  const cleaned = cleanUntrusted(input.path).replace(NON_SPACE_WHITESPACE, '')
  if (cleaned.length > MAX_PATH_LENGTH) return null
  const parsed = parseRoutePath(cleaned)
  const notes = [...parsed.notes]
  if (input.note) notes.push(cleanUntrusted(input.note, { oneLine: true }))
  return {
    method: input.method,
    path: redactCommand(parsed.path),
    kind: input.kind,
    framework: input.framework,
    file: input.file,
    ...(input.line !== undefined ? { line: input.line } : {}),
    confidence: input.confidence,
    package: input.package,
    ...(notes.length > 0 ? { note: notes.join('; ') } : {}),
  }
}

/**
 * Route order: package, kind (api before page), path, method (METHOD_ORDER),
 * file, line, framework.
 */
export function compareRoutes(a: Route, b: Route): number {
  return (
    compareText(a.package ?? '.', b.package ?? '.') ||
    compareText(a.kind, b.kind) ||
    compareText(a.path, b.path) ||
    (METHOD_RANK.get(a.method) ?? 99) - (METHOD_RANK.get(b.method) ?? 99) ||
    compareText(a.file, b.file) ||
    (a.line ?? 0) - (b.line ?? 0) ||
    compareText(a.framework, b.framework)
  )
}

const routeKey = (route: Route) => `${route.method}\n${route.path}\n${route.framework}\n${route.file}`

/**
 * Sort, dedupe and cap the list at MAX_ROUTES. Variants of one registration
 * (same method, path, framework, file and line) keep the most confident one.
 * Resolved (high) registrations of the same route on several lines are one
 * route; unresolved ones are kept apart, since two unresolved `GET /` in one
 * file usually sit in different functions mounted under different prefixes.
 */
export function finalizeRoutes(routes: readonly Route[], truncated: boolean): { routes: Route[]; truncated: boolean } {
  const byLine = new Map<string, Route>()
  for (const route of [...routes].sort(compareRoutes)) {
    const key = `${routeKey(route)}\n${route.line ?? ''}`
    const existing = byLine.get(key)
    // Replacing keeps the entry's position, and routes differing only in confidence sort the same.
    if (!existing || CONFIDENCE_RANK[route.confidence] < CONFIDENCE_RANK[existing.confidence]) byLine.set(key, route)
  }
  const unique: Route[] = []
  const resolved = new Set<string>()
  for (const route of byLine.values()) {
    if (route.confidence === 'high') {
      const key = routeKey(route)
      if (resolved.has(key)) continue
      resolved.add(key)
    }
    unique.push(route)
  }
  if (unique.length > MAX_ROUTES) return { routes: unique.slice(0, MAX_ROUTES), truncated: true }
  return { routes: unique, truncated }
}

/**
 * Test, story and spec files by name, for file-system routing. Only dotted
 * suffixes count: the file name is the URL, and `speed-test.tsx` is the
 * /speed-test page, not a test.
 */
const TEST_NAME = /\.(?:test|spec|e2e-spec|e2e|stories|story)\.[cm]?[jt]sx?$|_test\.go$/

/** Test, story or spec file by name (used for file-system routing, where directory names are meaningful). */
export function isTestFileName(file: string): boolean {
  return TEST_NAME.test(baseName(file)) || file.split('/').includes('__tests__')
}

/**
 * Test, example, fixture, template, playground or benchmark code that should
 * not be scanned for route definitions. Directories are checked relative to
 * the owning package, so an explicitly included package such as
 * "examples/api" is still scanned.
 */
export function isNonAppSource(file: string, packageDir: string): boolean {
  return isTestName(file) || isTestFileName(file) || isUnder(file, NON_PROJECT_ROLES, packageDir)
}
