/**
 * NestJS: `@Controller('users')` classes with `@Get(':id')`-style method
 * decorators, plus `app.setGlobalPrefix('api')` from any file of the package.
 */
import type { HttpMethod, Route } from '../../types.ts'
import {
  type ArgValue,
  argValue,
  importsModule,
  type JsImports,
  objectProperties,
  parseJsImports,
  stringValues,
} from './js.ts'
import { joinRoutePath, makeRoute, normalizePath, parseRoutePath } from './shared.ts'
import { analyzeSource, argumentSpans, type SourceText } from './source.ts'

const DECORATORS: Record<string, HttpMethod> = {
  Get: 'GET',
  Post: 'POST',
  Put: 'PUT',
  Patch: 'PATCH',
  Delete: 'DELETE',
  Head: 'HEAD',
  Options: 'OPTIONS',
  All: 'ANY',
  Sse: 'GET',
}

const DECORATOR = /(?<![\w$.])@(Controller|Get|Post|Put|Patch|Delete|Head|Options|All|Sse)\s*\(/g
const GLOBAL_PREFIX = /\.\s*setGlobalPrefix\s*\(/g
const EXTRA_PREFIXES = /\bRouterModule\s*\.\s*(?:register|forRoutes)\s*\(|\bVersioningType\s*\.\s*URI\b/g

export interface NestRouteDef {
  method: HttpMethod
  /** Controller path joined with the method path, before any global prefix. */
  path: string
  line: number
  note?: string
}

export interface NestGlobalPrefix {
  prefix: string
  /** Normalized paths excluded from the prefix. */
  exclude: string[]
}

export interface NestFileFacts {
  importsNest: boolean
  routes: NestRouteDef[]
  globalPrefix: NestGlobalPrefix | null
  /** RouterModule or URI versioning can add path segments RepoLens does not resolve. */
  extraPrefixes: boolean
}

/** Paths from a decorator argument list: none → [""], literals → their values, anything else → null (dynamic). */
function decoratorPaths(src: SourceText, open: number, allowObject: boolean): string[] | null {
  const args = argumentSpans(src, open)
  if (!args) return null
  const first = args[0]
  if (!first) return ['']
  const value: ArgValue = argValue(src, first)
  if (allowObject && value.kind === 'object') {
    const pathSpan = objectProperties(src, value.open).get('path')
    if (!pathSpan) return ['']
    return stringValues(argValue(src, pathSpan))
  }
  return stringValues(value)
}

function globalPrefixOf(src: SourceText): NestGlobalPrefix | null {
  for (const match of src.code.matchAll(GLOBAL_PREFIX)) {
    if (src.inLiteral(match.index)) continue
    const open = match.index + match[0].length - 1
    const args = argumentSpans(src, open)
    const first = args?.[0]
    if (!args || !first) continue
    const prefix = stringValues(argValue(src, first))
    if (prefix?.length !== 1) continue
    const exclude: string[] = []
    const options = args[1] ? argValue(src, args[1]) : null
    if (options?.kind === 'object') {
      const excludeSpan = objectProperties(src, options.open).get('exclude')
      const list = excludeSpan ? argValue(src, excludeSpan) : null
      if (list?.kind === 'strings') {
        for (const value of list.values) exclude.push(normalizePath(value))
      } else if (excludeSpan && src.code[excludeSpan.start] === '[') {
        for (const element of argumentSpans(src, excludeSpan.start) ?? []) {
          const item = argValue(src, element)
          const values =
            item.kind === 'object'
              ? stringValues(argValue(src, objectProperties(src, item.open).get('path') ?? element))
              : stringValues(item)
          for (const value of values ?? []) exclude.push(normalizePath(value))
        }
      }
    }
    return { prefix: prefix[0] as string, exclude }
  }
  return null
}

/** Controllers, routes and global prefix declared in one file. */
export function extractNestFacts(text: string): NestFileFacts {
  const src = analyzeSource(text, 'js')
  return nestFacts(
    src,
    parseJsImports(src.code, (offset) => src.inLiteral(offset)),
  )
}

/** Same as extractNestFacts, for a file that has already been analyzed. */
export function nestFacts(src: SourceText, imports: JsImports): NestFileFacts {
  const { code } = src
  const importsNest = importsModule(imports, '@nestjs/common')
  const routes: NestRouteDef[] = []
  let controller: string[] | null = null
  if (importsNest) {
    for (const match of code.matchAll(DECORATOR)) {
      if (src.inLiteral(match.index)) continue
      const name = match[1] as string
      const open = match.index + match[0].length - 1
      if (name === 'Controller') {
        controller = decoratorPaths(src, open, true) ?? []
        continue
      }
      if (!controller) continue
      const paths = decoratorPaths(src, open, false)
      const method = DECORATORS[name]
      if (!paths || !method) continue
      const line = src.lineAt(match.index)
      for (const base of controller) {
        for (const path of paths) {
          // Normalized here (global prefix exclusions compare normalized paths); keep syntax notes such as ":id?".
          const parsed = parseRoutePath(joinRoutePath(base, path))
          const notes = name === 'Sse' ? [...parsed.notes, 'server-sent events'] : parsed.notes
          routes.push({ method, path: parsed.path, line, ...(notes.length > 0 ? { note: notes.join('; ') } : {}) })
        }
      }
    }
  }
  return {
    importsNest,
    routes,
    globalPrefix: globalPrefixOf(src),
    extraPrefixes: [...code.matchAll(EXTRA_PREFIXES)].some((match) => !src.inLiteral(match.index)),
  }
}

/** Routes for one Nest package: every file's routes with the package-wide global prefix applied. */
export function nestRoutes(packageDir: string, files: ReadonlyArray<{ file: string; facts: NestFileFacts }>): Route[] {
  const globalPrefix = files.map((entry) => entry.facts.globalPrefix).find((prefix) => prefix !== null) ?? null
  const extraPrefixes = files.some((entry) => entry.facts.extraPrefixes)
  const routes: Route[] = []
  for (const { file, facts } of files) {
    for (const def of facts.routes) {
      const excluded = globalPrefix?.exclude.includes(def.path) ?? false
      const path = globalPrefix && !excluded ? joinRoutePath(globalPrefix.prefix, def.path) : def.path
      const notes = [def.note, extraPrefixes ? 'RouterModule or versioning may add a prefix' : undefined].filter(
        (note): note is string => note !== undefined,
      )
      const route = makeRoute({
        method: def.method,
        path,
        kind: 'api',
        framework: 'nestjs',
        file,
        line: def.line,
        confidence: extraPrefixes ? 'medium' : 'high',
        package: packageDir,
        ...(notes.length > 0 ? { note: notes.join('; ') } : {}),
      })
      if (route) routes.push(route)
    }
  }
  return routes
}
