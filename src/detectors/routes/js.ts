/**
 * JavaScript/TypeScript facts shared by the Express, Fastify and Hono
 * extractors: imports, method calls with their receivers and arguments,
 * assignments, and relative module resolution.
 */
import { dirOf, joinPath, normalizeRelative } from '../../utils/paths.ts'
import type { Binding, FileFacts, ModuleMount, RootRef, Trust } from './resolve.ts'
import {
  analyzeSource,
  argumentSpans,
  calleeBefore,
  type FunctionLiteral,
  jsFunctionAt,
  leadingStringArgument,
  methodBefore,
  readStringLiteral,
  receiverBefore,
  type SourceText,
  type Span,
  skipSpaces,
  skipTypeArguments,
} from './source.ts'

export interface ImportedName {
  specifier: string
  /** "default", "*" (namespace / whole CommonJS module) or the exported name. */
  imported: string
}

export interface JsImports {
  /** Every module specifier imported, re-exported or required. */
  specifiers: Set<string>
  /** Local name → where it comes from. */
  locals: Map<string, ImportedName>
}

export type CallReceiver =
  | { kind: 'name'; name: string }
  | { kind: 'call'; call: JsCall }
  /** A call RepoLens does not collect, e.g. `new Hono()`; `start` is where the expression begins. */
  | { kind: 'expr'; callee: string; isNew: boolean; start: number }
  | { kind: 'unknown' }

export interface JsCall {
  name: string
  /** Offset of the method name. */
  offset: number
  line: number
  open: number
  /** Arguments; only the leading string literal when the brackets are unbalanced. */
  args: Span[]
  receiver: CallReceiver
}

export interface JsAssignment {
  name: string
  offset: number
  /** Start of the assigned expression. */
  rhs: number
}

export interface JsFile {
  file: string
  package: string
  src: SourceText
  imports: JsImports
  calls: JsCall[]
  assignments: JsAssignment[]
  /** Top-level `const X = '/literal'` values, used to resolve mount prefixes. */
  constants: Map<string, string>
}

export type ArgValue =
  | { kind: 'string'; value: string }
  | { kind: 'strings'; values: string[] }
  | { kind: 'dynamic' }
  | { kind: 'identifier'; name: string }
  | { kind: 'module'; specifier: string }
  | { kind: 'object'; open: number }
  | { kind: 'function'; fn: FunctionLiteral }
  /** A call such as `usersRouter(deps)`: the router a factory returns. */
  | { kind: 'call'; callee: string }
  | { kind: 'other' }

// The clause absorbs its own trailing whitespace; a separate \s* before "from" would make whitespace runs quadratic.
const IMPORT_CLAUSE = /\bimport[ \t\r\n]([\w$\s{},*]{1,1000}?)\bfrom\s*(['"])([^'"\n]{1,512})\2/g
const SPECIFIER_PATTERNS = [
  /\bfrom\s*(['"])([^'"\n]{1,512})\1/g,
  /\bimport\s*(['"])([^'"\n]{1,512})\1/g,
  /\b(?:require|import)\s*\(\s*(['"])([^'"\n]{1,512})\1\s*\)/g,
]
const REQUIRE_BINDING =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*|\{[^{}]{0,1000}\})\s*=\s*require\s*\(\s*(['"])([^'"\n]{1,512})\2\s*\)(\s*\.\s*[A-Za-z_$][\w$]*)?/g
// Identifier patterns start with a lookbehind rather than \b: "$" is not a word
// character, so \b would let every "$" start a new (quadratic) attempt.
const ASSIGNMENT =
  /(?<![\w$])(?:(?:const|let|var)\s+([A-Za-z_$][\w$]{0,255})\s*(?::[^=;\n]{1,300}?)?|([A-Za-z_$][\w$]{0,255})\s*)=(?![=>])\s*/g
const CONSTANT = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*string\s*)?=\s*(['"`])([^'"`\n$]{0,256})\2\s*[;\n]/g

function parseNamedList(list: string, separator: RegExp): Array<{ imported: string; local: string }> {
  const out: Array<{ imported: string; local: string }> = []
  for (const raw of list.split(',')) {
    const item = raw.trim().replace(/^type\s+/, '')
    const match = separator.exec(item)
    if (match?.[1]) out.push({ imported: match[1], local: match[2] ?? match[1] })
  }
  return out
}

/** Offsets to ignore when matching patterns: offsets inside string, template and regex literals. */
export type SkipOffset = (offset: number) => boolean

const NEVER: SkipOffset = () => false

export function parseJsImports(code: string, skip: SkipOffset = NEVER): JsImports {
  const specifiers = new Set<string>()
  const locals = new Map<string, ImportedName>()
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of code.matchAll(pattern)) if (match[2] && !skip(match.index)) specifiers.add(match[2])
  }
  for (const match of code.matchAll(IMPORT_CLAUSE)) {
    if (skip(match.index)) continue
    const clause = (match[1] ?? '').trim().replace(/^type\s+/, '')
    const specifier = match[3] as string
    const defaultName = /^([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(clause)
    if (defaultName?.[1] && defaultName[1] !== 'type') locals.set(defaultName[1], { specifier, imported: 'default' })
    const namespace = /\*\s*as\s+([A-Za-z_$][\w$]*)/.exec(clause)
    if (namespace?.[1]) locals.set(namespace[1], { specifier, imported: '*' })
    const named = /\{([^}]*)\}/.exec(clause)
    if (named?.[1] !== undefined) {
      for (const item of parseNamedList(named[1], /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/)) {
        locals.set(item.local, { specifier, imported: item.imported })
      }
    }
  }
  for (const match of code.matchAll(REQUIRE_BINDING)) {
    if (skip(match.index)) continue
    const target = match[1] as string
    const specifier = match[3] as string
    const member = match[4]?.replace(/[\s.]/g, '')
    if (target.startsWith('{')) {
      for (const item of parseNamedList(target.slice(1, -1), /^([A-Za-z_$][\w$]*)(?:\s*:\s*([A-Za-z_$][\w$]*))?$/)) {
        locals.set(item.local, { specifier, imported: item.imported })
      }
    } else {
      locals.set(target, { specifier, imported: member ?? '*' })
    }
  }
  return { specifiers, locals }
}

/** True when the file imports `name` or a subpath of it ("hono" matches "hono/quick"). */
export function importsModule(imports: JsImports, name: string): boolean {
  for (const specifier of imports.specifiers) {
    if (specifier === name || specifier.startsWith(`${name}/`)) return true
  }
  return false
}

/** Local names bound to `imported` from `module` (or a subpath of it). */
export function localNamesOf(imports: JsImports, module: string, imported: readonly string[]): string[] {
  const out: string[] = []
  for (const [local, from] of imports.locals) {
    const matchesModule = from.specifier === module || from.specifier.startsWith(`${module}/`)
    if (matchesModule && imported.includes(from.imported)) out.push(local)
  }
  return out
}

export function isRelativeSpecifier(specifier: string): boolean {
  return specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../')
}

const TS_FOR_JS: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
}
const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']

/**
 * Resolve a relative import to a file that `exists`, the way bundlers and
 * TypeScript do: exact file, TypeScript source for a ".js" specifier, added
 * extension, then directory index. Null when it escapes the root or is missing.
 */
export function resolveRelativeModule(
  from: string,
  specifier: string,
  exists: (file: string) => boolean,
): string | null {
  const joined = normalizeRelative(joinPath(dirOf(from), specifier))
  if (joined === null || joined === '.') return null
  const candidates: string[] = [joined]
  const ext = /\.[cm]?[jt]sx?$/.exec(joined)?.[0]
  if (ext && TS_FOR_JS[ext]) {
    const stem = joined.slice(0, -ext.length)
    for (const alt of TS_FOR_JS[ext] ?? []) candidates.push(stem + alt)
  }
  for (const alt of RESOLVE_EXTENSIONS) candidates.push(joined + alt)
  for (const alt of RESOLVE_EXTENSIONS) candidates.push(`${joined}/index${alt}`)
  return candidates.find(exists) ?? null
}

/** Methods whose calls are collected; frameworks decide what they mean. */
const CALL_NAMES = /\.\s*(get|post|put|patch|delete|options|head|all|route|use|register|on|basePath)\b/g

/**
 * Methods that configure an app or router and return it, so a chain can pass
 * through them: `app.disable('x-powered-by').use(cors()).get('/status', h)`.
 */
const CHAINABLE_METHODS = new Set([
  // Express
  'disable',
  'enable',
  'set',
  'engine',
  'param',
  // Hono
  'onError',
  'notFound',
  // Fastify
  'addHook',
  'addSchema',
  'addContentTypeParser',
  'decorate',
  'decorateReply',
  'decorateRequest',
  'setErrorHandler',
  'setNotFoundHandler',
  'setSerializerCompiler',
  'setValidatorCompiler',
  'withTypeProvider',
])

/** Longest run of uncollected chainable calls followed back to a receiver. */
const MAX_CHAIN_WALK = 32

/**
 * Receiver of a method called on the result of the call closing at `close`:
 * a collected call, else the receiver of chainable configuration calls, else
 * the callee of an uncollected call (`new Hono()`, `express()`).
 */
function callResultReceiver(src: SourceText, close: number, byClose: ReadonlyMap<number, JsCall>): CallReceiver {
  const { code } = src
  let current = close
  for (let steps = 0; steps < MAX_CHAIN_WALK; steps++) {
    const parent = byClose.get(current)
    if (parent) return { kind: 'call', call: parent }
    const open = src.openOf.get(current)
    if (open === undefined) return { kind: 'unknown' }
    const method = methodBefore(code, open)
    if (method && CHAINABLE_METHODS.has(method.name)) {
      const token = receiverBefore(code, method.dot, false)
      if (token.kind === 'name') return { kind: 'name', name: token.name }
      if (token.kind !== 'call') return { kind: 'unknown' }
      current = token.close
      continue
    }
    const callee = calleeBefore(code, open)
    return callee ? { kind: 'expr', ...callee } : { kind: 'unknown' }
  }
  return { kind: 'unknown' }
}

export function scanJsCalls(src: SourceText): JsCall[] {
  const { code } = src
  const calls: JsCall[] = []
  const byClose = new Map<number, JsCall>()
  for (const match of code.matchAll(CALL_NAMES)) {
    const dot = match.index
    if (src.inLiteral(dot)) continue
    const name = match[1] as string
    const offset = dot + match[0].length - name.length
    let open = skipSpaces(code, offset + name.length)
    open = skipTypeArguments(code, open)
    if (open === -1) continue
    open = skipSpaces(code, open)
    if (code[open] !== '(') continue

    let args = argumentSpans(src, open)
    if (!args) {
      const leading = leadingStringArgument(src, open, 'js')
      args = leading
        ? leading.more
          ? [leading.span, { start: leading.span.end, end: leading.span.end }]
          : [leading.span]
        : []
    }

    const token = receiverBefore(code, dot, false)
    let receiver: CallReceiver = { kind: 'unknown' }
    if (token.kind === 'name') receiver = { kind: 'name', name: token.name }
    else if (token.kind === 'call') receiver = callResultReceiver(src, token.close, byClose)
    const call: JsCall = { name, offset, line: src.lineAt(offset), open, args, receiver }
    calls.push(call)
    const close = src.closeOf.get(open)
    if (close !== undefined) byClose.set(close, call)
  }
  return calls
}

export function scanAssignments(code: string, skip: SkipOffset = NEVER): JsAssignment[] {
  const out: JsAssignment[] = []
  for (const match of code.matchAll(ASSIGNMENT)) {
    if (skip(match.index)) continue
    const name = match[1] ?? match[2]
    if (name) out.push({ name, offset: match.index, rhs: match.index + match[0].length })
  }
  return out
}

function scanConstants(code: string, skip: SkipOffset): Map<string, string> {
  const out = new Map<string, string>()
  for (const match of code.matchAll(CONSTANT)) {
    if (match[1] && match[3] !== undefined && !skip(match.index)) out.set(match[1], match[3])
  }
  return out
}

export function parseJsFile(file: string, packageDir: string, text: string): JsFile {
  const src = analyzeSource(text, 'js')
  const skip: SkipOffset = (offset) => src.inLiteral(offset)
  return {
    file,
    package: packageDir,
    src,
    imports: parseJsImports(src.code, skip),
    calls: scanJsCalls(src),
    assignments: scanAssignments(src.code, skip),
    constants: scanConstants(src.code, skip),
  }
}

const MODULE_CALL = /^(?:require|import)\s*\(\s*(['"])([^'"\n]{1,512})\1\s*\)(?:\s*\.\s*default)?$/
const MODULE_FACTORY_CALL = /^require\s*\(\s*(['"])([^'"\n]{1,512})\1\s*\)(?:\s*\.\s*default)?\s*\(/
const FACTORY_CALL = /^([A-Za-z_$][\w$]{0,255})\s*\(/

/** Classify one argument (or any expression span). */
export function argValue(src: SourceText, span: Span): ArgValue {
  const { code } = src
  if (span.end <= span.start) return { kind: 'other' }
  const first = code[span.start]
  if (first === '"' || first === "'" || first === '`') {
    const literal = readStringLiteral(code, span.start, 'js')
    if (literal && !literal.dynamic && literal.end === span.end) return { kind: 'string', value: literal.value }
    return { kind: 'dynamic' }
  }
  if (first === '[') {
    const close = src.closeOf.get(span.start)
    if (close !== span.end - 1) return { kind: 'other' }
    const values: string[] = []
    for (const element of argumentSpans(src, span.start) ?? []) {
      // Only flat arrays of strings matter; not recursing keeps `[[[[…]]]]` from overflowing the stack.
      if (code[element.start] === '[') return { kind: 'other' }
      const value = argValue(src, element)
      if (value.kind !== 'string') return value.kind === 'dynamic' ? value : { kind: 'other' }
      values.push(value.value)
    }
    return { kind: 'strings', values }
  }
  if (first === '{') {
    return src.closeOf.get(span.start) === span.end - 1 ? { kind: 'object', open: span.start } : { kind: 'other' }
  }
  const text = code.slice(span.start, Math.min(span.end, span.start + 600))
  const moduleCall = MODULE_CALL.exec(text)
  if (moduleCall?.[2]) return { kind: 'module', specifier: moduleCall[2] }
  if (/^[A-Za-z_$][\w$]*$/.test(text)) {
    if (text === 'async' || text === 'function') return { kind: 'other' }
    return { kind: 'identifier', name: text }
  }
  // Factories: `require('./routes')(db)` and `usersRouter(deps)`, when the call spans the whole argument.
  const factory = MODULE_FACTORY_CALL.exec(text) ?? FACTORY_CALL.exec(text)
  if (factory && src.closeOf.get(span.start + factory[0].length - 1) === span.end - 1) {
    if (factory.length > 2 && factory[2]) return { kind: 'module', specifier: factory[2] }
    if (factory[1] && factory[1] !== 'async' && factory[1] !== 'function') return { kind: 'call', callee: factory[1] }
  }
  const fn = jsFunctionAt(src, span)
  if (fn) return { kind: 'function', fn }
  return { kind: 'other' }
}

/** Resolve an argument to literal strings: string literals, arrays of them, or a same-file string constant. */
export function stringValues(value: ArgValue, constants?: ReadonlyMap<string, string>): string[] | null {
  if (value.kind === 'string') return [value.value]
  if (value.kind === 'strings') return value.values
  if (value.kind === 'identifier' && constants?.has(value.name)) return [constants.get(value.name) as string]
  return null
}

const NON_HANDLER_LITERAL = /^(?:[-+]?[\d.]|(?:null|undefined|true|false)$)/

/**
 * Could this argument be a route handler or middleware? Functions, identifiers,
 * member expressions, calls and arrays can; string, number and object literals
 * cannot, which is what tells `api.get('/users', { params })` (an HTTP client
 * call) apart from `app.get('/users', handler)`.
 */
export function isHandlerLike(src: SourceText, span: Span): boolean {
  const value = argValue(src, span)
  if (value.kind === 'string' || value.kind === 'strings' || value.kind === 'dynamic' || value.kind === 'object') {
    return false
  }
  return !NON_HANDLER_LITERAL.test(src.code.slice(span.start, Math.min(span.end, span.start + 16)))
}

/** Properties of the object literal whose "{" is at `open`: key → value span. */
export function objectProperties(src: SourceText, open: number): Map<string, Span> {
  const props = new Map<string, Span>()
  for (const span of argumentSpans(src, open) ?? []) {
    const text = src.code.slice(span.start, Math.min(span.end, span.start + 300))
    const key = /^(?:(['"])([\w$-]+)\1|([A-Za-z_$][\w$]*))\s*:\s*/.exec(text)
    if (key) {
      props.set((key[2] ?? key[3]) as string, { start: span.start + key[0].length, end: span.end })
    } else if (/^[A-Za-z_$][\w$]*$/.test(text)) {
      props.set(text, span)
    }
  }
  return props
}

export interface Chain {
  /** The receiver at the start of the chain. */
  root: CallReceiver
  /** Calls between the root and the current call, nearest first. */
  parents: JsCall[]
}

/** Walk a chained call (`a.route('/x').get(h).post(h)`) back to its root receiver. */
export function chainOf(call: JsCall): Chain {
  const parents: JsCall[] = []
  let receiver = call.receiver
  while (receiver.kind === 'call' && parents.length < 64) {
    parents.push(receiver.call)
    receiver = receiver.call.receiver
  }
  return { root: receiver, parents }
}

const assignmentsByRhs = new WeakMap<JsFile, Map<number, JsAssignment>>()

/**
 * The name an inline expression receiver is assigned to, when the whole chain
 * is the right-hand side of an assignment: in
 * `const books = new Hono().get('/', h)`, routes of the chain are registered
 * on `books`, so mounts of `books` apply to them.
 */
export function assignedName(js: JsFile, receiver: CallReceiver): JsAssignment | null {
  if (receiver.kind !== 'expr') return null
  let index = assignmentsByRhs.get(js)
  if (!index) {
    index = new Map()
    for (const assignment of js.assignments) index.set(assignment.rhs, assignment)
    assignmentsByRhs.set(js, index)
  }
  return index.get(receiver.start) ?? null
}

/** Build a RootRef for a receiver, given how the framework classifies inline constructor calls. */
export function rootRefOf(
  receiver: CallReceiver,
  prefix: string,
  resolved: boolean,
  classifyExpr: (callee: string, isNew: boolean) => 'app' | 'router' | null,
): RootRef {
  if (receiver.kind === 'name') return { kind: 'name', name: receiver.name, prefix, resolved }
  if (receiver.kind === 'expr') {
    const kind = classifyExpr(receiver.callee, receiver.isNew)
    if (kind) return { kind, prefix, resolved }
  }
  return { kind: 'unknown', prefix, resolved }
}

/** Receiver names commonly used for apps, routers and plugin instances. */
const CONVENTIONAL_RECEIVER =
  /^(?:app|application|server|srv|api|router|routes|route|fastify|instance|hono|v\d+|[A-Za-z]*(?:Router|App|Api|API|Server|Routes|Route|Plugin|Instance))$/

export function isConventionalReceiver(name: string): boolean {
  return CONVENTIONAL_RECEIVER.test(name)
}

/**
 * `FileFacts.trustName` for JavaScript frameworks: typed or conventionally named
 * receivers are routers, anything else is unknown. Built here rather than inline
 * in an extractor: a closure created there would share the extractor's scope and
 * keep the whole analyzed source of every file alive until resolution ends.
 */
export function receiverTrust(typed: ReadonlySet<string>): (name: string) => Trust {
  return (name) => (typed.has(name) || isConventionalReceiver(name) ? 'router' : 'unknown')
}

/** `name:`, `name?:` or `name: ns.` right before a type name. */
const TYPED_NAME_BEFORE =
  /(?<![\w$])([A-Za-z_$][\w$]{0,63})\s{0,16}(?:\?\s{0,16})?:\s{0,16}(?:[A-Za-z_$][\w$]{0,63}\.)?$/
// Longer than the longest possible match (180), so a match never starts at a cut-off identifier.
const TYPED_NAME_WINDOW = 192

/** Names annotated with one of `types` (`fastify: FastifyInstance`, `app: express.Application`). */
export function typedNames(code: string, types: readonly string[], skip: SkipOffset = NEVER): Set<string> {
  const out = new Set<string>()
  if (types.length === 0) return out
  // Find the (rare) type names first and look behind each for `name:`; one
  // pattern tried at every identifier of every file is a large share of the scan.
  const pattern = new RegExp(`(?<![\\w$])(?:${types.join('|')})\\b(?!\\s*\\.)`, 'g')
  for (const match of code.matchAll(pattern)) {
    const from = Math.max(0, match.index - TYPED_NAME_WINDOW)
    const found = TYPED_NAME_BEFORE.exec(code.slice(from, match.index))
    if (found?.[1] && !skip(from + found.index)) out.add(found[1])
  }
  return out
}

/** Text of the assigned expression, capped (for pattern matching). */
function rhsText(src: SourceText, assignment: JsAssignment): string {
  return src.code.slice(assignment.rhs, assignment.rhs + 400)
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Alternation of identifiers for use inside a RegExp. */
export function namesPattern(names: Iterable<string>): string {
  const list = [...new Set(names)].map(escapeRegExp)
  return list.length > 0 ? `(?:${list.join('|')})` : '(?!)'
}

const FUNCTION_DECLARATION = /(?<![\w$.])function\s*\*?\s*([A-Za-z_$][\w$]{0,255})\s*\(/g

interface LocalDeclarations {
  functions: Map<string, number>
  assignments: Map<string, JsAssignment[]>
}

const declarationCache = new WeakMap<JsFile, LocalDeclarations>()

/** Function declarations and assignments by name, indexed once per file. */
function declarationsOf(js: JsFile): LocalDeclarations {
  let found = declarationCache.get(js)
  if (!found) {
    found = { functions: new Map(), assignments: new Map() }
    for (const match of js.src.code.matchAll(FUNCTION_DECLARATION)) {
      const name = match[1] as string
      if (!found.functions.has(name) && !js.src.inLiteral(match.index)) found.functions.set(name, match.index)
    }
    for (const assignment of js.assignments) {
      const list = found.assignments.get(assignment.name)
      if (list) list.push(assignment)
      else found.assignments.set(assignment.name, [assignment])
    }
    declarationCache.set(js, found)
  }
  return found
}

/**
 * A function declared in this file under `name` (`function name() {}`,
 * `const name = async (x) => {}`), used when a plugin is registered by name.
 */
export function localFunction(js: JsFile, name: string): FunctionLiteral | null {
  const { code } = js.src
  const declarations = declarationsOf(js)
  const declared = declarations.functions.get(name)
  if (declared !== undefined) {
    const fn = jsFunctionAt(js.src, { start: declared, end: code.length })
    if (fn && code[fn.body.start] === '{') return fn
  }
  for (const assignment of declarations.assignments.get(name) ?? []) {
    const fn = jsFunctionAt(js.src, { start: assignment.rhs, end: code.length })
    if (fn && code[fn.body.start] === '{') return fn
  }
  return null
}

export interface PendingModuleMount extends Omit<ModuleMount, 'from' | 'target'> {
  /** Relative specifier of the mounted module, resolved by the caller. */
  specifier: string
}

/** What a JavaScript framework extractor reports for one file. */
export interface JsFrameworkFacts {
  /** The file imports the framework; routes only count in such files and in files they mount. */
  importsFramework: boolean
  facts: FileFacts
  moduleMounts: PendingModuleMount[]
}

export interface BindingClass {
  kind: 'app' | 'router'
  prefix?: string
  resolved?: boolean
  /** Derived from another receiver, e.g. `const api = app.basePath('/api')`. */
  parent?: string
}

/** Bindings for every assignment the framework recognizes as creating an app or router. */
export function jsBindings(js: JsFile, classify: (rhs: string) => BindingClass | null): Binding[] {
  const out: Binding[] = []
  for (const assignment of js.assignments) {
    const found = classify(rhsText(js.src, assignment))
    if (!found) continue
    out.push({
      name: assignment.name,
      offset: assignment.offset,
      scope: -1,
      kind: found.kind,
      prefix: found.prefix ?? '',
      resolved: found.resolved ?? true,
      ...(found.parent ? { parent: { kind: 'name' as const, name: found.parent, prefix: '', resolved: true } } : {}),
    })
  }
  return out
}

/**
 * Prefix contributed by the calls of a chain (from the root outwards), e.g.
 * `.basePath('/api')`. `step` returns a prefix string, null for a dynamic
 * prefix, or undefined when the call does not change the prefix.
 */
export function chainPrefix(chain: Chain, step: (call: JsCall) => string | null | undefined) {
  let prefix = ''
  let resolved = true
  for (let i = chain.parents.length - 1; i >= 0; i--) {
    const part = step(chain.parents[i] as JsCall)
    if (part === null) resolved = false
    else if (part !== undefined) prefix = prefix === '' ? part : `${prefix}/${part}`
  }
  return { prefix, resolved }
}

/** A mount target argument: a relatively imported module or a router bound in this file. */
export function mountTarget(
  js: JsFile,
  value: ArgValue,
  localNames: ReadonlySet<string>,
): { kind: 'module'; specifier: string } | { kind: 'local'; name: string } | null {
  if (value.kind === 'module') return isRelativeSpecifier(value.specifier) ? value : null
  if (value.kind !== 'identifier' && value.kind !== 'call') return null
  const name = value.kind === 'identifier' ? value.name : value.callee
  const imported = js.imports.locals.get(name)
  if (imported) {
    return isRelativeSpecifier(imported.specifier) ? { kind: 'module', specifier: imported.specifier } : null
  }
  return value.kind === 'identifier' && localNames.has(name) ? { kind: 'local', name } : null
}

/** An expression that probably holds a path (a variable named like a prefix), so a mount under it is unresolved. */
export function looksLikePathExpression(src: SourceText, span: Span): boolean {
  const text = src.code.slice(span.start, Math.min(span.end, span.start + 200))
  return /^[A-Za-z_$][\w$.]*$/.test(text) && /(?:prefix|path|base|url|mount)/i.test(text)
}
