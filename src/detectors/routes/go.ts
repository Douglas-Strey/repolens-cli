/**
 * Go routers: net/http (`mux.HandleFunc("GET /x", h)`), gin and echo
 * (`r.GET`, `r.Group`), chi (`r.Get`, `r.Route`, `r.Mount`), fiber
 * (`app.Get`, `app.Group`) and gorilla/mux (`r.HandleFunc(...).Methods(...)`,
 * `PathPrefix(...).Subrouter()`).
 */
import type { HttpMethod } from '../../types.ts'
import {
  type Binding,
  createBindingLookup,
  type FileFacts,
  type LocalMount,
  type PrefixSpan,
  type RootRef,
  type RouteDef,
  type Scope,
  scopeIndex,
  type Trust,
} from './resolve.ts'
import { toHttpMethod } from './shared.ts'
import {
  analyzeSource,
  argumentSpans,
  type FunctionLiteral,
  goFunctionAt,
  leadingStringArgument,
  readStringLiteral,
  receiverBefore,
  type SourceText,
  type Span,
} from './source.ts'

export type GoFramework = 'gin' | 'echo' | 'chi' | 'fiber' | 'gorilla-mux' | 'go-net-http'

export const GO_UNRESOLVED_NOTE = 'registered on a router group; a prefix may apply'

const FRAMEWORK_IMPORTS: ReadonlyArray<{ id: GoFramework; pattern: RegExp }> = [
  { id: 'gin', pattern: /^github\.com\/gin-gonic\/gin$/ },
  { id: 'echo', pattern: /^github\.com\/labstack\/echo(?:\/v\d+)?$/ },
  { id: 'chi', pattern: /^github\.com\/go-chi\/chi(?:\/v\d+)?$/ },
  { id: 'fiber', pattern: /^github\.com\/gofiber\/fiber(?:\/v\d+)?$/ },
  { id: 'gorilla-mux', pattern: /^github\.com\/gorilla\/mux$/ },
  { id: 'go-net-http', pattern: /^net\/http$/ },
]

/** Framework id for a Go import path, or null. */
export function goFrameworkOf(importPath: string): GoFramework | null {
  return FRAMEWORK_IMPORTS.find((entry) => entry.pattern.test(importPath))?.id ?? null
}

/** Frameworks a module can use: those it requires, plus the standard library's net/http. */
export function goModuleFrameworks(requires: Iterable<string>): Set<GoFramework> {
  const out = new Set<GoFramework>(['go-net-http'])
  for (const path of requires) {
    const id = goFrameworkOf(path)
    if (id) out.add(id)
  }
  return out
}

/** Default package name of an import path ("github.com/labstack/echo/v4" → "echo"). */
function packageNameOf(importPath: string): string {
  const segments = importPath.split('/')
  let name = segments[segments.length - 1] ?? ''
  if (/^v\d+$/.test(name) && segments.length > 1) name = segments[segments.length - 2] ?? name
  return name.replace(/[^\w]/g, '_')
}

const IMPORT_SPEC = /^\s*(?:([A-Za-z_]\w{0,127}|\.|_)\s+)?"([^"\n]{1,512})"/

/**
 * Import alias → import path. Blank and dot imports are skipped. Go requires
 * imports before any other declaration, so only the file header is parsed,
 * with a single forward pass.
 */
export function parseGoImports(code: string): Map<string, string> {
  const out = new Map<string, string>()
  const add = (spec: string) => {
    const match = IMPORT_SPEC.exec(spec)
    if (!match?.[2] || match[1] === '_' || match[1] === '.') return
    out.set(match[1] ?? packageNameOf(match[2]), match[2])
  }
  const header = /^(?:func|type|var|const)\b/m.exec(code)
  const end = header ? header.index : code.length
  let at = code.indexOf('import')
  while (at !== -1 && at < end) {
    let j = at + 'import'.length
    while (j < end && /\s/.test(code[j] as string)) j++
    if (code[j] === '(') {
      const close = code.indexOf(')', j)
      if (close === -1) break
      for (const line of code.slice(j + 1, close).split(/[\n;]/)) add(line)
      at = code.indexOf('import', close)
    } else {
      add(code.slice(j, Math.min(end, j + 600)))
      at = code.indexOf('import', j)
    }
  }
  return out
}

const CONSTRUCTORS: Record<GoFramework, readonly string[]> = {
  gin: ['Default', 'New'],
  echo: ['New'],
  chi: ['NewRouter', 'NewMux'],
  fiber: ['New'],
  'gorilla-mux': ['NewRouter'],
  'go-net-http': ['NewServeMux'],
}

/** Parameter types: framework → type name → root application or router/group. */
const PARAM_TYPES: Record<GoFramework, Record<string, 'app' | 'router'>> = {
  gin: { Engine: 'app', RouterGroup: 'router', IRouter: 'router', IRoutes: 'router' },
  echo: { Echo: 'app', Group: 'router' },
  chi: { Mux: 'router', Router: 'router' },
  fiber: { App: 'app', Router: 'router' },
  'gorilla-mux': { Router: 'router' },
  'go-net-http': { ServeMux: 'app' },
}

const UPPER_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'Any'])
const TITLE_METHODS = new Set(['Get', 'Post', 'Put', 'Patch', 'Delete', 'Head', 'Options', 'All'])

/** Which frameworks provide a registration method, in order of preference. */
function candidatesFor(name: string): GoFramework[] {
  if (UPPER_METHODS.has(name)) return ['gin', 'echo']
  if (name === 'All') return ['fiber']
  if (TITLE_METHODS.has(name)) return ['chi', 'fiber']
  if (name === 'Handle' || name === 'HandleFunc') return ['gorilla-mux', 'chi', 'go-net-http']
  if (name === 'Method' || name === 'MethodFunc') return ['chi']
  return []
}

const CALL_NAMES =
  /\.\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|Any|Get|Post|Put|Patch|Delete|Head|Options|All|Handle|HandleFunc|Method|MethodFunc|Group|Route|Mount|Methods|PathPrefix|Subrouter|With)\s*\(/g
const FUNC_DECL = /^func[ \t]+(?:\([^)\n]{0,300}\)[ \t]*)?([A-Za-z_]\w{0,255})[ \t]*(?:\[[^\]\n]{0,300}\][ \t]*)?\(/gm
// Anchored with a lookbehind and bounded, so long identifiers or selector chains stay linear.
// `var r = gin.Default()` is covered too: the name after `var` matches on its own.
const ASSIGNMENT = /(?<![\w.])([A-Za-z_]\w{0,255}(?:\.[A-Za-z_]\w{0,255}){0,4})[ \t]*:?=(?!=)\s*/g
const CONSTANT = /(?<![\w.])([A-Za-z_]\w{0,255})\s*(?:string\s*)?:?=\s*"(\/[^"\n]{0,256})"/g
const METHOD_CONSTANT = /^(?:[A-Za-z_]\w*\.)?Method(Get|Post|Put|Patch|Delete|Head|Options)$/

type GoArg =
  | { kind: 'string'; value: string }
  | { kind: 'ident'; name: string }
  | { kind: 'func'; fn: FunctionLiteral }
  | { kind: 'call'; callee: string }
  | { kind: 'other' }

function goArg(src: SourceText, span: Span | undefined): GoArg {
  if (!span || span.end <= span.start) return { kind: 'other' }
  const { code } = src
  const literal = readStringLiteral(code, span.start, 'go')
  if (literal) return literal.end === span.end ? { kind: 'string', value: literal.value } : { kind: 'other' }
  const text = code.slice(span.start, Math.min(span.end, span.start + 300))
  if (/^[A-Za-z_][\w.]*$/.test(text)) return { kind: 'ident', name: text }
  const fn = goFunctionAt(src, span)
  if (fn) return { kind: 'func', fn }
  const call = /^([A-Za-z_][\w.]*)\s*\(/.exec(text)
  if (call?.[1] && src.closeOf.get(span.start + call[0].length - 1) === span.end - 1) {
    return { kind: 'call', callee: call[1] }
  }
  return { kind: 'other' }
}

/**
 * Could the last argument of `r.Get("/x", …)` be a handler? String and number
 * literals and addresses (`cache.Get("/key", &out)`) cannot: every supported
 * router takes a handler function there.
 */
function goHandlerLike(src: SourceText, span: Span | undefined): boolean {
  if (!span) return false
  // An empty span stands for arguments that follow a call with unbalanced brackets: unknown, so allowed.
  return span.end <= span.start || !/^[&"`'\d-]/.test(src.code[span.start] as string)
}

/*
 * `FileFacts.trustName` for Go: unbound receivers are routers, the net/http
 * package itself is the application. Built at module level: a closure created
 * inside goFacts would keep the whole analyzed source of every file alive.
 */
const trustAsRouter = (): Trust => 'router'

function goTrust(httpAliases: ReadonlySet<string>): (name: string) => Trust {
  return (name) => (httpAliases.has(name) ? 'app' : 'router')
}

function methodOf(arg: GoArg): HttpMethod | null {
  if (arg.kind === 'string') return /^[A-Z]+$/.test(arg.value) ? toHttpMethod(arg.value) : null
  if (arg.kind === 'ident') {
    const constant = METHOD_CONSTANT.exec(arg.name)
    return constant?.[1] ? toHttpMethod(constant[1]) : null
  }
  return null
}

/** Split a net/http pattern ("GET /items/{id}", "/debug/vars") into method and path. Null for host patterns. */
export function parseServeMuxPattern(pattern: string): { method: HttpMethod; path: string } | null {
  const match = /^(?:([A-Z]+)\s+)?(\S.*)$/.exec(pattern.trim())
  if (!match) return null
  const path = match[2] as string
  if (!path.startsWith('/')) return null
  if (!match[1]) return { method: 'ANY', path }
  const method = toHttpMethod(match[1])
  return method && method !== 'ANY' ? { method, path } : null
}

interface GoCall {
  name: string
  offset: number
  line: number
  args: Span[]
  receiver: { kind: 'name'; name: string } | { kind: 'call'; call: GoCall } | { kind: 'unknown' }
}

/** A parameter typed as a framework application or router/group. */
interface RouterParam {
  name: string
  kind: 'app' | 'router'
  framework: GoFramework
}

interface GoFunc {
  name: string
  start: number
  end: number
  params: Map<string, RouterParam>
  /** Router parameters by position (null for any other parameter). */
  positional: Array<RouterParam | null>
}

export interface GoFunctionMount {
  funcName: string
  parent: RootRef
  offset: number
  prefix: string
  resolved: boolean
}

/**
 * A router passed to a function: `users.Register(v1.Group("/users"))` or
 * `registerRoutes(api)`. The caller (index.ts) finds the function and, when
 * the parameter at `index` is a router, mounts the function's routes on it.
 */
export interface GoRouterArgument {
  /** Import path of the callee's package; null for a function of the same package (or a method). */
  importPath: string | null
  funcName: string
  index: number
  /** The router passed, including inline groups (`v1.Group("/users")`). */
  parent: RootRef
  offset: number
}

export interface GoFileFacts {
  facts: FileFacts
  /** Top-level function bodies (for `r.Mount("/x", someRouter())` across files of the package). */
  funcs: Array<{ name: string; start: number; end: number; params: Array<{ name: string } | null> }>
  functionMounts: GoFunctionMount[]
  routerArguments: GoRouterArgument[]
}

/** The next "{" within a short window (result types are short); bounded so malformed files stay linear. */
function braceAfter(code: string, from: number): number {
  const index = code.slice(from, from + 1024).indexOf('{')
  return index === -1 ? -1 : from + index
}

function scanFuncs(src: SourceText, imports: Map<string, string>): GoFunc[] {
  const { code } = src
  const funcs: GoFunc[] = []
  for (const match of code.matchAll(FUNC_DECL)) {
    if (src.inLiteral(match.index)) continue
    const open = match.index + match[0].length - 1
    const close = src.closeOf.get(open)
    if (close === undefined) continue
    let brace = braceAfter(code, close)
    // Skip `interface{}` / `struct{…}` in result types.
    for (let guard = 0; brace !== -1 && guard < 8; guard++) {
      if (!/\b(?:interface|struct)\s*$/.test(code.slice(Math.max(close, brace - 12), brace))) break
      const skip = src.closeOf.get(brace)
      brace = skip === undefined ? -1 : braceAfter(code, skip)
    }
    if (brace === -1) continue
    const end = src.closeOf.get(brace)
    if (end === undefined) continue
    const positional = parseParams(src, open, imports)
    const params = new Map<string, RouterParam>()
    for (const param of positional) if (param) params.set(param.name, param)
    funcs.push({ name: match[1] as string, start: brace, end: end + 1, params, positional })
  }
  return funcs
}

const PARAM = /^([A-Za-z_]\w*)(?:\s+([\s\S]*))?$/
const QUALIFIED_TYPE = /^(?:\.\.\.)?\*?\s*([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/

/**
 * Parameters of the parameter list opening at `open`, by position, with the
 * router ones identified. Grouped names share the type that follows them
 * (`a, b *gin.RouterGroup`).
 */
function parseParams(src: SourceText, open: number, imports: ReadonlyMap<string, string>): Array<RouterParam | null> {
  const spans = argumentSpans(src, open) ?? []
  const names: Array<string | null> = []
  const types: Array<string | null> = []
  for (const span of spans.slice(0, 64)) {
    const match = PARAM.exec(src.code.slice(span.start, Math.min(span.end, span.start + 300)))
    names.push(match?.[1] ?? null)
    types.push(match ? (match[2]?.trim() ?? null) : '')
  }
  const out: Array<RouterParam | null> = []
  let type: string | null = null
  for (let i = names.length - 1; i >= 0; i--) {
    type = types[i] ?? type
    const name = names[i]
    const qualified = type ? QUALIFIED_TYPE.exec(type) : null
    const framework = qualified ? goFrameworkOf(imports.get(qualified[1] as string) ?? '') : null
    const kind = framework ? PARAM_TYPES[framework][qualified?.[2] as string] : undefined
    out.push(name && name !== '_' && framework && kind ? { name, kind, framework } : null)
  }
  return out.reverse()
}

function scanCalls(src: SourceText): { calls: GoCall[]; byClose: Map<number, GoCall> } {
  const { code } = src
  const calls: GoCall[] = []
  const byClose = new Map<number, GoCall>()
  for (const match of code.matchAll(CALL_NAMES)) {
    if (src.inLiteral(match.index)) continue
    const name = match[1] as string
    const open = match.index + match[0].length - 1
    let args = argumentSpans(src, open)
    if (!args) {
      const leading = leadingStringArgument(src, open, 'go')
      args = leading
        ? leading.more
          ? [leading.span, { start: leading.span.end, end: leading.span.end }]
          : [leading.span]
        : []
    }
    const token = receiverBefore(code, match.index, true)
    let receiver: GoCall['receiver'] = { kind: 'unknown' }
    if (token.kind === 'name') receiver = { kind: 'name', name: token.name }
    else if (token.kind === 'call') {
      const parent = byClose.get(token.close)
      if (parent) receiver = { kind: 'call', call: parent }
    }
    const nameOffset = match.index + match[0].indexOf(name)
    const call: GoCall = { name, offset: nameOffset, line: src.lineAt(nameOffset), args, receiver }
    calls.push(call)
    const close = src.closeOf.get(open)
    if (close !== undefined) byClose.set(close, call)
  }
  return { calls, byClose }
}

/** Frameworks that accept a path without a leading "/" (or an empty one) on a group. */
const RELATIVE_PATH_FRAMEWORKS: ReadonlySet<GoFramework> = new Set(['gin', 'echo', 'fiber'])
/** Calls whose result is a router: the argument forms `F(r.Group("/x"))` passes. */
const ROUTER_EXPRESSIONS = new Set(['Group', 'PathPrefix', 'Subrouter', 'With'])
/** Function or `pkg.Function` calls; a selector chain (`a.b.F(`) does not match. */
const FUNCTION_CALL = /(?<![\w.])([A-Za-z_]\w{0,255})(?:[ \t]*\.[ \t]*([A-Za-z_]\w{0,255}))?[ \t]*\(/g
const NOT_CALLEES = new Set(['func', 'if', 'for', 'switch', 'return', 'go', 'defer', 'select', 'case', 'range'])
/** Most router arguments recorded per file (each is a potential mount; generated code can have thousands). */
const MAX_ROUTER_ARGUMENTS = 2000

/**
 * Calls passing a router to a function (`users.Register(v1.Group("/users"))`,
 * `setupRoutes(r)`). `routerOf` returns the router an argument is, or null.
 * `pkg.F(…)` names a function of an imported package; `F(…)` and method calls
 * (`s.routes(r)`) are looked up by name in the same package. Calls on the
 * framework packages themselves (`gin.Default()`) are skipped.
 */
function scanRouterArguments(
  src: SourceText,
  imports: ReadonlyMap<string, string>,
  frameworks: ReadonlyMap<string, GoFramework>,
  routerOf: (span: Span, offset: number) => RootRef | null,
): GoRouterArgument[] {
  const out: GoRouterArgument[] = []
  for (const match of src.code.matchAll(FUNCTION_CALL)) {
    if (out.length >= MAX_ROUTER_ARGUMENTS) break
    const first = match[1] as string
    const second = match[2]
    if (NOT_CALLEES.has(first) || frameworks.has(first) || src.inLiteral(match.index)) continue
    const open = match.index + match[0].length - 1
    const args = argumentSpans(src, open)
    if (!args) continue
    const importPath = second === undefined ? null : (imports.get(first) ?? null)
    const funcName = second ?? first
    for (const [index, span] of args.slice(0, 16).entries()) {
      const parent = routerOf(span, match.index)
      if (parent) out.push({ importPath, funcName, index, parent, offset: match.index })
    }
  }
  return out
}

/**
 * Route facts for one Go file. `allowed` are the frameworks its module
 * requires (net/http is always allowed); the file must import them too.
 */
export function goFacts(
  file: string,
  packageDir: string,
  text: string,
  allowed: ReadonlySet<GoFramework>,
): GoFileFacts {
  const src = analyzeSource(text, 'go')
  const { code } = src
  const imports = parseGoImports(code)
  const aliases = new Map<string, GoFramework>()
  for (const [alias, path] of imports) {
    const framework = goFrameworkOf(path)
    if (framework && allowed.has(framework)) aliases.set(alias, framework)
  }
  const imported = new Set(aliases.values())
  const empty: GoFileFacts = {
    facts: {
      file,
      package: packageDir,
      bindings: [],
      spans: [],
      localMounts: [],
      routes: [],
      scopes: [],
      trustName: trustAsRouter,
    },
    funcs: [],
    functionMounts: [],
    routerArguments: [],
  }
  if (imported.size === 0) return empty

  const funcs = scanFuncs(src, imports)
  const scopes: Scope[] = funcs.map((fn) => ({
    start: fn.start,
    end: fn.end,
    params: new Map([...fn.params].map(([name, param]) => [name, param.kind])),
  }))
  const scopeIndexAt = (offset: number) => scopeIndex(scopes, offset)
  const httpAliases = new Set(
    [...aliases].filter(([, framework]) => framework === 'go-net-http').map(([alias]) => alias),
  )

  const constants = new Map<string, string>()
  for (const match of code.matchAll(CONSTANT)) {
    if (!src.inLiteral(match.index)) constants.set(match[1] as string, match[2] as string)
  }
  const prefixArg = (arg: GoArg): { prefix: string; resolved: boolean } => {
    if (arg.kind === 'string') return { prefix: arg.value, resolved: true }
    if (arg.kind === 'ident' && constants.has(arg.name))
      return { prefix: constants.get(arg.name) as string, resolved: true }
    return { prefix: '', resolved: false }
  }

  // Bindings: constructors, groups and subrouters.
  const bindings: Binding[] = []
  for (const match of code.matchAll(ASSIGNMENT)) {
    if (src.inLiteral(match.index)) continue
    const name = match[1] as string
    const rhsStart = match.index + match[0].length
    const rhs = code.slice(rhsStart, rhsStart + 300)
    const ctor = /^&?\s*([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*\(/.exec(rhs)
    const ctorFramework = ctor ? aliases.get(ctor[1] as string) : undefined
    if (ctor && ctorFramework && CONSTRUCTORS[ctorFramework].includes(ctor[2] as string)) {
      bindings.push({
        name,
        offset: match.index,
        scope: scopeIndexAt(match.index),
        kind: 'app',
        prefix: '',
        resolved: true,
        framework: ctorFramework,
      })
      continue
    }
    const derived = /^([A-Za-z_][\w.]*)\s*\.\s*(Group|PathPrefix|With|Subrouter)\s*\(/.exec(rhs)
    if (!derived?.[1] || aliases.has(derived[1])) continue
    const open = rhsStart + derived[0].length - 1
    let prefix = ''
    let resolved = true
    if (derived[2] === 'Group' || derived[2] === 'PathPrefix') {
      const arg = goArg(src, argumentSpans(src, open)?.[0])
      if (arg.kind === 'func') continue
      ;({ prefix, resolved } = prefixArg(arg))
    }
    bindings.push({
      name,
      offset: match.index,
      scope: scopeIndexAt(match.index),
      kind: 'router',
      prefix,
      resolved,
      parent: { kind: 'name', name: derived[1], prefix: '', resolved: true },
    })
  }

  const lookup = createBindingLookup(bindings, scopes)
  const frameworkOfName = (name: string, offset: number, depth = 0): GoFramework | null => {
    if (depth > 8) return null
    if (httpAliases.has(name)) return 'go-net-http'
    const binding = lookup(name, offset)
    if (binding?.framework) return binding.framework as GoFramework
    if (binding?.parent?.kind === 'name') return frameworkOfName(binding.parent.name, binding.offset, depth + 1)
    return funcs[scopeIndexAt(offset)]?.params.get(name)?.framework ?? null
  }

  const { calls, byClose } = scanCalls(src)
  const routes: RouteDef[] = []
  const spans: PrefixSpan[] = []
  const localMounts: LocalMount[] = []
  const functionMounts: GoFunctionMount[] = []
  const defsByCall = new Map<GoCall, RouteDef>()
  const boundNames = new Set(bindings.map((binding) => binding.name))

  /** Root of a call chain (calls nearest first), with the prefixes of inline groups (`r.Group("/a").Group("/b")`). */
  const chainRoot = (chain: readonly GoCall[], receiver: GoCall['receiver']) => {
    let prefix = ''
    let resolved = true
    let groups = 0
    for (let i = chain.length - 1; i >= 0; i--) {
      const parent = chain[i] as GoCall
      if (parent.name !== 'Group' && parent.name !== 'PathPrefix') continue
      const arg = goArg(src, parent.args[0])
      if (arg.kind === 'func') continue
      const part = prefixArg(arg)
      prefix = prefix === '' ? part.prefix : `${prefix}/${part.prefix}`
      resolved &&= part.resolved
      groups++
    }
    const name = receiver.kind === 'name' ? receiver.name : null
    const root: RootRef = name ? { kind: 'name', name, prefix, resolved } : { kind: 'unknown', prefix, resolved }
    return { root, name, groups }
  }
  const chainOf = (call: GoCall) => {
    const parents: GoCall[] = []
    let receiver = call.receiver
    while (receiver.kind === 'call' && parents.length < 32) {
      parents.push(receiver.call)
      receiver = receiver.call.receiver
    }
    return { parents, receiver }
  }
  /** Is the name a router group here: derived from another router, or a typed group parameter? */
  const isGroup = (name: string, offset: number): boolean =>
    lookup(name, offset)?.parent !== undefined || funcs[scopeIndexAt(offset)]?.params.get(name)?.kind === 'router'

  for (const call of calls) {
    const { parents, receiver } = chainOf(call)
    const { root, name: rootName, groups } = chainRoot(parents, receiver)
    const values = call.args.map((span) => goArg(src, span))

    if (call.name === 'Methods') {
      const first = call.receiver.kind === 'call' ? defsByCall.get(call.receiver.call) : undefined
      const methods = values.map(methodOf).filter((method): method is HttpMethod => method !== null)
      if (first && first.method === 'ANY' && methods.length > 0) {
        first.method = methods[0] as HttpMethod
        for (const method of methods.slice(1)) routes.push({ ...first, method })
      }
      continue
    }
    if (call.name === 'Route' || (call.name === 'Group' && values[0]?.kind === 'func')) {
      const fnArg = call.name === 'Route' ? values[1] : values[0]
      if (fnArg?.kind !== 'func') continue
      const { prefix, resolved } =
        call.name === 'Route' ? prefixArg(values[0] as GoArg) : { prefix: '', resolved: true }
      spans.push({
        start: fnArg.fn.body.start,
        end: fnArg.fn.body.end,
        param: fnArg.fn.param,
        parent: root,
        offset: call.offset,
        prefix,
        resolved,
      })
      continue
    }
    if (call.name === 'Mount') {
      const target = values[1]
      if (!target) continue
      const { prefix, resolved } = prefixArg(values[0] as GoArg)
      if (target.kind === 'ident' && boundNames.has(target.name)) {
        localMounts.push({ target: target.name, parent: root, offset: call.offset, prefix, resolved })
      } else if (target.kind === 'call') {
        const segments = target.callee.split('.')
        const funcName = segments[segments.length - 1] as string
        if (segments.length === 1 || !imports.has(segments[0] as string)) {
          functionMounts.push({ funcName, parent: root, offset: call.offset, prefix, resolved })
        }
      }
      continue
    }
    if (call.name === 'Group' || call.name === 'PathPrefix' || call.name === 'With' || call.name === 'Subrouter')
      continue

    let method: HttpMethod | null = null
    let path: string | null = null
    let candidates = candidatesFor(call.name)
    if (call.name === 'Handle' || call.name === 'HandleFunc') {
      const first = values[0]
      const second = values[1]
      if (first?.kind === 'string' && second?.kind === 'string' && methodOf(first) && values.length >= 3) {
        // gin: r.Handle("GET", "/path", handler)
        method = methodOf(first)
        path = second.value
        candidates = ['gin']
      } else if (first?.kind === 'string' && values.length >= 2) {
        const pattern = parseServeMuxPattern(first.value)
        if (pattern) {
          method = pattern.method
          path = pattern.path
        }
      }
    } else if (call.name === 'Method' || call.name === 'MethodFunc') {
      const second = values[1]
      if (values.length >= 3 && second?.kind === 'string') {
        method = methodOf(values[0] as GoArg)
        path = second.value
      }
    } else {
      const first = values[0]
      if (values.length >= 2 && first?.kind === 'string' && goHandlerLike(src, call.args[call.args.length - 1])) {
        method = toHttpMethod(call.name)
        path = first.value
      }
    }
    if (!method || path === null) continue
    if (rootName && httpAliases.has(rootName) && call.name !== 'Handle' && call.name !== 'HandleFunc') continue

    const fromRoot = rootName ? frameworkOfName(rootName, call.offset) : null
    const framework =
      fromRoot && candidates.includes(fromRoot) ? fromRoot : candidates.find((candidate) => imported.has(candidate))
    if (!framework) continue
    // gin, echo and fiber join a group's prefix with any path: `users.GET("", h)` is the group itself.
    const onGroup = groups > 0 || (rootName !== null && isGroup(rootName, call.offset))
    if (!path.startsWith('/') && !(RELATIVE_PATH_FRAMEWORKS.has(framework) && onGroup)) continue
    const def: RouteDef = { root, offset: call.offset, line: call.line, method, path, framework }
    routes.push(def)
    defsByCall.set(call, def)
  }

  const routerArguments = scanRouterArguments(src, imports, aliases, (span, offset) => {
    // An inline group spanning the whole argument: `v1.Group("/users")`, `r.PathPrefix("/x").Subrouter()`.
    const last = byClose.get(span.end - 1)
    if (last) {
      if (!ROUTER_EXPRESSIONS.has(last.name)) return null
      if (last.name === 'Group' && goArg(src, last.args[0]).kind === 'func') return null
      const { parents, receiver } = chainOf(last)
      if (parents.some((parent) => !ROUTER_EXPRESSIONS.has(parent.name))) return null
      const { root, name } = chainRoot([last, ...parents], receiver)
      return name && code.startsWith(name, span.start) ? root : null
    }
    // A router variable or parameter: `setupRoutes(api)`.
    const name = span.end - span.start <= 256 ? code.slice(span.start, span.end) : ''
    if (!/^[A-Za-z_][\w.]*$/.test(name)) return null
    const known = lookup(name, offset) !== undefined || funcs[scopeIndexAt(offset)]?.params.has(name)
    return known ? { kind: 'name', name, prefix: '', resolved: true } : null
  })

  return {
    facts: {
      file,
      package: packageDir,
      bindings,
      spans,
      localMounts,
      routes,
      scopes,
      trustName: goTrust(httpAliases),
    },
    funcs: funcs.map((fn) => ({
      name: fn.name,
      start: fn.start,
      end: fn.end,
      params: fn.positional.map((param) => (param ? { name: param.name } : null)),
    })),
    functionMounts,
    routerArguments,
  }
}
