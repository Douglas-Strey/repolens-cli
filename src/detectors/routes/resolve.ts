/**
 * Prefix resolution shared by the code-based extractors (Express, Fastify,
 * Hono, Go routers).
 *
 * Extractors describe each file as facts: which names are bound to an app or
 * router (and with which prefix), which routers are mounted on which, which
 * function bodies run as a plugin/closure under a prefix, and which routes are
 * registered on which receiver. This module turns those facts into routes with
 * full paths and an honest confidence:
 *
 * - high: the chain from the route up to an application object is fully known
 * - medium: the receiver is a router whose mount point is unknown (a prefix may apply)
 * - low: the receiver could not be identified as a router at all
 *
 * The work is bounded whatever the input: every router is resolved once per
 * binding (not once per place it is referenced), only the first MAX_MOUNTS
 * mounts of a router are followed, and a work budget per file and per scan
 * stops resolution early. Past the budget, routes are still reported, as
 * unresolved (medium), and the section is marked truncated.
 */
import type { Confidence, HttpMethod, Route } from '../../types.ts'
import { compareText } from '../../utils/compare.ts'
import { joinRoutePath, MAX_ROUTES, makeRoute } from './shared.ts'

/** What a route or mount is called on. `prefix` is accumulated along a call chain (`app.basePath('/x').get(…)`). */
export type RootRef =
  | { kind: 'name'; name: string; prefix: string; resolved: boolean }
  | { kind: 'app' | 'router' | 'unknown'; prefix: string; resolved: boolean }

export type Trust = 'app' | 'router' | 'unknown'

export interface Binding {
  name: string
  offset: number
  /** Index of the enclosing scope (Go function), or -1 for file-wide visibility. */
  scope: number
  kind: 'app' | 'router'
  /** Prefix added by this binding (group, basePath, subrouter). */
  prefix: string
  /** False when the prefix is dynamic. */
  resolved: boolean
  /** The receiver this binding derives from (`v1 := r.Group("/v1")`). */
  parent?: RootRef
  framework?: string
}

/** A function body that runs with a prefixed receiver (Fastify plugin, chi `Route` closure). */
export interface PrefixSpan {
  start: number
  end: number
  /** Parameter that names the prefixed receiver; null when unknown. */
  param: string | null
  parent: RootRef
  offset: number
  prefix: string
  resolved: boolean
}

/** A router bound in the same file mounted on another receiver (`app.use('/api', router)`). */
export interface LocalMount {
  target: string
  parent: RootRef
  offset: number
  prefix: string
  resolved: boolean
}

/** A router defined in another file (or another function) mounted under a prefix. */
export interface ModuleMount {
  from: string
  target: string
  /** Only routes inside this range of the target are mounted (a Go function body). */
  range?: { start: number; end: number }
  /**
   * Only routes registered through this parameter of the target function are
   * mounted: `users.Register(v1.Group("/users"))` passes a group for the
   * `r *gin.RouterGroup` parameter of `func Register(r *gin.RouterGroup)`.
   */
  param?: string
  parent: RootRef
  offset: number
  prefix: string
  resolved: boolean
}

export interface RouteDef {
  root: RootRef
  offset: number
  line: number
  method: HttpMethod
  path: string
  framework: string
}

/** A function body with its own bindings. Scopes of a file are disjoint and sorted by `start`. */
export interface Scope {
  start: number
  end: number
  /** Typed parameters: name → whether it is a root application or a router/group. */
  params: ReadonlyMap<string, 'app' | 'router'>
}

export interface FileFacts {
  file: string
  package: string
  bindings: Binding[]
  spans: PrefixSpan[]
  localMounts: LocalMount[]
  routes: RouteDef[]
  scopes: Scope[]
  /** How much to trust a receiver name that is neither bound nor a typed parameter. */
  trustName(name: string): Trust
}

export interface ResolveOptions {
  /** Note for routes whose mount point is unknown, e.g. "mounted by a router; prefix may apply". */
  unresolvedNote: string
}

interface Resolved {
  prefix: string
  /** The chain ends at an application object. */
  rooted: boolean
  /** Every prefix along the chain is known. */
  resolved: boolean
  trust: Trust
  /** The chain ends at this typed parameter of the enclosing function; its callers decide the prefix. */
  param?: string | undefined
}

interface FilePrefix {
  prefix: string
  complete: boolean
}

const MAX_DEPTH = 8
const MAX_VARIANTS = 16
/**
 * Mounts (or plugin registrations, or callers) followed per router. A router
 * mounted in more places than this is generated or adversarial code; the
 * first ones in source order are enough to report plausible prefixes.
 */
const MAX_MOUNTS = 64
/** Resolution work (prefix variants built) allowed per file, and per scan. */
const FILE_BUDGET = 100_000
const TOTAL_BUDGET = 1_000_000
/** Resolution stops producing routes past this many (the final list is capped at MAX_ROUTES anyway). */
const MAX_OUTPUT = MAX_ROUTES * 5

const UNRESOLVED: readonly Resolved[] = [{ prefix: '', rooted: false, resolved: false, trust: 'router' }]

const resolvedKey = (r: Resolved) => `${r.prefix}\n${r.rooted ? 1 : 0}${r.resolved ? 1 : 0}${r.trust}\n${r.param ?? ''}`
const filePrefixKey = (p: FilePrefix) => `${p.prefix}\n${p.complete ? 1 : 0}`

/**
 * Dedupe variants and keep the most plausible ones: complete chains first,
 * then shorter prefixes. Cyclic or heavily cross-mounted routers can produce
 * many variants; the cap keeps output (and work) bounded.
 */
function best<T extends { prefix: string }>(items: T[], complete: (item: T) => boolean, key: (item: T) => string): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const item of items) {
    const id = key(item)
    if (seen.has(id)) continue
    seen.add(id)
    out.push(item)
  }
  out.sort(
    (a, b) =>
      Number(complete(b)) - Number(complete(a)) || a.prefix.length - b.prefix.length || compareText(a.prefix, b.prefix),
  )
  return out.slice(0, MAX_VARIANTS)
}

const isComplete = (r: Resolved) => r.rooted && r.resolved

interface RangeGroup {
  id: number
  start: number
  end: number
  edges: ModuleMount[]
}

/** Mounts into one file: those covering the whole file, and those limited to a range (a Go function body). */
interface IncomingEdges {
  whole: ModuleMount[]
  ranges: Map<string, RangeGroup>
  /** Range groups sorted by start. */
  sorted: RangeGroup[]
}

/**
 * Range groups containing `offset`. Ranges are function bodies, which do not
 * overlap, so a binary search finds the candidate; a short backward walk covers
 * nested or overlapping ranges from malformed input.
 */
function rangesContaining(sorted: readonly RangeGroup[], offset: number): RangeGroup[] {
  let lo = 0
  let hi = sorted.length - 1
  let last = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if ((sorted[mid] as RangeGroup).start <= offset) {
      last = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  const out: RangeGroup[] = []
  for (let i = last; i >= 0 && i > last - 8; i--) {
    const group = sorted[i] as RangeGroup
    if (offset < group.end) out.push(group)
  }
  return out.sort((a, b) => a.id - b.id)
}

/** Index of the scope containing `offset` (binary search over disjoint, sorted scopes), or -1. */
export function scopeIndex(scopes: readonly Scope[], offset: number): number {
  let lo = 0
  let hi = scopes.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const scope = scopes[mid] as Scope
    if (offset < scope.start) hi = mid - 1
    else if (offset >= scope.end) lo = mid + 1
    else return mid
  }
  return -1
}

export type BindingLookup = (name: string, offset: number) => Binding | undefined

/**
 * Find the binding a name refers to at an offset: the latest visible
 * assignment before it, else the first one after it (hoisting, callbacks).
 * Bindings are indexed by name and binary-searched, so files with thousands
 * of assignments stay fast. Plain names are visible within their scope;
 * selector names (`s.router`) are fields and visible file-wide.
 */
export function createBindingLookup(bindings: readonly Binding[], scopes: readonly Scope[]): BindingLookup {
  const byName = new Map<string, Binding[]>()
  for (const binding of bindings) {
    const list = byName.get(binding.name)
    if (list) list.push(binding)
    else byName.set(binding.name, [binding])
  }
  for (const list of byName.values()) list.sort((a, b) => a.offset - b.offset)
  return (name, offset) => {
    const list = byName.get(name)
    if (!list) return undefined
    const scope = scopeIndex(scopes, offset)
    const visible = (binding: Binding) => name.includes('.') || binding.scope === -1 || binding.scope === scope
    let lo = 0
    let hi = list.length - 1
    let last = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if ((list[mid] as Binding).offset < offset) {
        last = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    for (let i = last; i >= 0; i--) if (visible(list[i] as Binding)) return list[i]
    for (let i = last + 1; i < list.length; i++) if (visible(list[i] as Binding)) return list[i]
    return undefined
  }
}

const lookups = new WeakMap<FileFacts, BindingLookup>()
/** Local mounts by target name, then by the binding the target refers to at the mount (null: unbound). */
const mountIndex = new WeakMap<FileFacts, Map<string, Map<Binding | null, LocalMount[]>>>()

function bindingFor(facts: FileFacts, name: string, offset: number): Binding | undefined {
  let lookup = lookups.get(facts)
  if (!lookup) {
    lookup = createBindingLookup(facts.bindings, facts.scopes)
    lookups.set(facts, lookup)
  }
  return lookup(name, offset)
}

/**
 * Mounts of the router a binding creates. Only mounts naming the same binding
 * apply: a `router` declared inside a factory function is not the top-level
 * `router` that `app.use('/v2', router)` mounts. Indexed once per file, so a
 * name mounted thousands of times is not rescanned for every binding.
 */
function mountsFor(facts: FileFacts, name: string, binding: Binding | null): readonly LocalMount[] {
  let index = mountIndex.get(facts)
  if (!index) {
    index = new Map()
    for (const mount of facts.localMounts) {
      let byBinding = index.get(mount.target)
      if (!byBinding) {
        byBinding = new Map()
        index.set(mount.target, byBinding)
      }
      const target = bindingFor(facts, mount.target, mount.offset) ?? null
      const list = byBinding.get(target)
      if (list) list.push(mount)
      else byBinding.set(target, [mount])
    }
    mountIndex.set(facts, index)
  }
  return index.get(name)?.get(binding) ?? []
}

interface SpanIndex {
  /** Spans by start, then by end descending, so a backward walk meets inner spans first. */
  sorted: PrefixSpan[]
  /** Largest `end` among sorted[0..i]: once it is <= offset, no earlier span can contain the offset. */
  maxEnd: number[]
}

const spanIndexes = new WeakMap<FileFacts, SpanIndex>()

function spanIndexOf(facts: FileFacts): SpanIndex {
  let index = spanIndexes.get(facts)
  if (!index) {
    const sorted = [...facts.spans].sort((a, b) => a.start - b.start || b.end - a.end)
    const maxEnd: number[] = []
    let max = -1
    for (const span of sorted) {
      max = Math.max(max, span.end)
      maxEnd.push(max)
    }
    index = { sorted, maxEnd }
    spanIndexes.set(facts, index)
  }
  return index
}

/** The innermost spans containing `offset` whose parameter is `name` (identical spans are all returned, in source order). */
function spansFor(facts: FileFacts, name: string, offset: number): PrefixSpan[] {
  if (facts.spans.length === 0) return []
  const { sorted, maxEnd } = spanIndexOf(facts)
  let lo = 0
  let hi = sorted.length - 1
  let last = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if ((sorted[mid] as PrefixSpan).start <= offset) {
      last = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  const innermost: PrefixSpan[] = []
  for (let i = last; i >= 0 && (maxEnd[i] as number) > offset; i--) {
    const span = sorted[i] as PrefixSpan
    const current = innermost[0]
    if (current && span.start < current.start) break
    if (offset >= span.end || (span.param !== null && span.param !== name)) continue
    if (!current || (span.start === current.start && span.end === current.end)) innermost.push(span)
  }
  return innermost.reverse()
}

/** Memo key: what a name resolves to depends on its binding (or span, or scope), not on where it is used. */
type NameKey = Binding | string

interface FileState {
  /** Results that hold wherever the name is used. */
  memo: Map<NameKey, readonly Resolved[]>
  /** Results cut short by a cycle or the depth limit: valid for the current query only. */
  volatile: Map<NameKey, { query: number; result: readonly Resolved[] }>
  /** Names being resolved → their position on the resolution stack. */
  pending: Map<NameKey, number>
  spent: number
}

/** State of one resolveRoutes call. */
interface Run {
  files: Map<FileFacts, FileState>
  /** Current query (one route receiver or mount parent resolved from the top). */
  query: number
  stack: number
  /** Lowest stack position the current computation cut a cycle at, or -1 after the depth limit. */
  lowest: number
  spent: number
  /** The budget ran out: some prefixes were not resolved. */
  exhausted: boolean
}

function stateOf(run: Run, facts: FileFacts): FileState {
  let state = run.files.get(facts)
  if (!state) {
    state = { memo: new Map(), volatile: new Map(), pending: new Map(), spent: 0 }
    run.files.set(facts, state)
  }
  return state
}

function charge(run: Run, state: FileState, amount: number): void {
  state.spent += amount
  run.spent += amount
}

function overBudget(run: Run, state: FileState): boolean {
  if (state.spent <= FILE_BUDGET && run.spent <= TOTAL_BUDGET) return false
  run.exhausted = true
  return true
}

/** Resolve a receiver from the top: a new query. */
function query(run: Run, facts: FileFacts, root: RootRef, offset: number): readonly Resolved[] {
  run.query++
  run.lowest = Number.POSITIVE_INFINITY
  return resolveRoot(run, facts, root, offset, 0)
}

function resolveRoot(run: Run, facts: FileFacts, root: RootRef, offset: number, depth: number): readonly Resolved[] {
  if (depth > MAX_DEPTH) {
    // The cut depends on where the query started, so nothing on the stack may be memoized for good.
    run.lowest = -1
    return UNRESOLVED
  }
  if (root.kind !== 'name') {
    return [{ prefix: root.prefix, rooted: root.kind === 'app', resolved: root.resolved, trust: root.kind }]
  }
  const found = resolveName(run, facts, root.name, offset, depth)
  if (root.prefix === '' && root.resolved) return found
  return found.map((r) => ({
    ...r,
    prefix: joinRoutePath(r.prefix, root.prefix),
    resolved: r.resolved && root.resolved,
  }))
}

/**
 * Memoized name resolution. Routers mounted on each other would otherwise be
 * explored exponentially; a name already being resolved is a cycle and ends
 * as an unresolved router. Where a cycle is cut depends on where the query
 * entered it, so results of names on a cycle (and results cut by the depth
 * limit) are only reused within the same query: every route sees the cycle
 * from its own receiver, whatever order routes are resolved in.
 */
function resolveName(run: Run, facts: FileFacts, name: string, offset: number, depth: number): readonly Resolved[] {
  const state = stateOf(run, facts)
  if (overBudget(run, state)) return UNRESOLVED
  const binding = bindingFor(facts, name, offset)
  const spans = spansFor(facts, name, offset)
  const span = spans[0]
  // A binding inside the span shadows the span's parameter.
  const viaSpans = span !== undefined && !(binding && binding.offset >= span.start && binding.offset < offset)
  const key: NameKey = viaSpans
    ? `s${span.start}:${span.end}\n${name}`
    : (binding ?? `n${scopeIndex(facts.scopes, offset)}\n${name}`)

  const position = state.pending.get(key)
  if (position !== undefined) {
    run.lowest = Math.min(run.lowest, position)
    return UNRESOLVED
  }
  const cached = state.memo.get(key)
  if (cached) return cached
  const volatile = state.volatile.get(key)
  if (volatile && volatile.query === run.query) return volatile.result

  const own = run.stack++
  state.pending.set(key, own)
  const outer = run.lowest
  run.lowest = Number.POSITIVE_INFINITY
  const result = viaSpans
    ? fromSpans(run, state, facts, spans, depth)
    : fromBinding(run, state, facts, name, offset, binding, depth)
  state.pending.delete(key)
  run.stack--
  // Cuts strictly below this name (cycles it is not part of) are the same for every query that reaches it.
  if (run.lowest > own) state.memo.set(key, result)
  else state.volatile.set(key, { query: run.query, result })
  run.lowest = Math.min(outer, run.lowest)
  return result
}

function fromSpans(run: Run, state: FileState, facts: FileFacts, spans: PrefixSpan[], depth: number): Resolved[] {
  const out: Resolved[] = []
  for (const span of spans.slice(0, MAX_MOUNTS)) {
    for (const r of resolveRoot(run, facts, span.parent, span.offset, depth + 1)) {
      out.push({
        prefix: joinRoutePath(r.prefix, span.prefix),
        rooted: r.rooted,
        resolved: r.resolved && span.resolved,
        trust: r.trust === 'unknown' ? 'router' : r.trust,
        param: r.param,
      })
    }
  }
  charge(run, state, out.length + 1)
  return best(out, isComplete, resolvedKey)
}

function fromBinding(
  run: Run,
  state: FileState,
  facts: FileFacts,
  name: string,
  offset: number,
  binding: Binding | undefined,
  depth: number,
): readonly Resolved[] {
  let base: readonly Resolved[]
  if (binding?.parent) {
    base = resolveRoot(run, facts, binding.parent, binding.offset, depth + 1).map((r) => ({
      ...r,
      prefix: joinRoutePath(r.prefix, binding.prefix),
      resolved: r.resolved && binding.resolved,
      trust: r.trust === 'unknown' ? 'router' : r.trust,
    }))
  } else if (binding) {
    base = [{ prefix: binding.prefix, rooted: binding.kind === 'app', resolved: binding.resolved, trust: binding.kind }]
  } else {
    const scope = facts.scopes[scopeIndex(facts.scopes, offset)]
    const param = scope?.params.get(name)
    const trust: Trust = param ?? facts.trustName(name)
    base = [{ prefix: '', rooted: trust === 'app', resolved: true, trust, param: param ? name : undefined }]
  }

  const mounts = mountsFor(facts, name, binding ?? null)
  if (mounts.length === 0) {
    charge(run, state, 1)
    return base
  }
  const out: Resolved[] = []
  for (const mount of mounts.slice(0, MAX_MOUNTS)) {
    for (const r of resolveRoot(run, facts, mount.parent, mount.offset, depth + 1)) {
      for (const b of base) {
        out.push({
          prefix: joinRoutePath(r.prefix, mount.prefix, b.prefix),
          rooted: r.rooted,
          resolved: r.resolved && mount.resolved && b.resolved,
          trust: b.trust === 'unknown' ? 'router' : b.trust,
          param: r.param,
        })
      }
    }
  }
  charge(run, state, out.length + 1)
  return best(out, isComplete, resolvedKey)
}

/** Incoming module mounts by target file, split into whole-file mounts and range groups. */
function incomingEdges(byFile: ReadonlyMap<string, FileFacts>, mounts: readonly ModuleMount[]) {
  const incoming = new Map<string, IncomingEdges>()
  for (const mount of mounts) {
    if (!byFile.has(mount.from) || !byFile.has(mount.target)) continue
    let entry = incoming.get(mount.target)
    if (!entry) {
      entry = { whole: [], ranges: new Map(), sorted: [] }
      incoming.set(mount.target, entry)
    }
    if (!mount.range) {
      entry.whole.push(mount)
      continue
    }
    const rangeKey = `${mount.range.start}:${mount.range.end}`
    let group = entry.ranges.get(rangeKey)
    if (!group) {
      group = { id: entry.ranges.size, start: mount.range.start, end: mount.range.end, edges: [] }
      entry.ranges.set(rangeKey, group)
    }
    group.edges.push(mount)
  }
  for (const entry of incoming.values()) {
    entry.sorted = [...entry.ranges.values()].sort((a, b) => a.start - b.start || a.end - b.end)
  }
  return incoming
}

/**
 * Turn per-file facts and cross-file mounts into routes. Only files present in
 * `files` are considered; mounts from or into other files are ignored.
 */
export function resolveRoutes(
  files: readonly FileFacts[],
  mounts: readonly ModuleMount[],
  options: ResolveOptions,
): { routes: Route[]; truncated: boolean } {
  const byFile = new Map(files.map((facts) => [facts.file, facts]))
  const incoming = incomingEdges(byFile, mounts)
  const run: Run = { files: new Map(), query: 0, stack: 0, lowest: 0, spent: 0, exhausted: false }
  const memo = new Map<string, FilePrefix[] | null>()
  // Cycles between files (or recursive Go functions) are cut like cycles of names in resolveName.
  const volatile = new Map<string, { query: number; result: FilePrefix[] }>()
  const onPath = new Map<string, number>()
  let lowest = Number.POSITIVE_INFINITY
  let topQuery = 0
  const CUT: FilePrefix[] = [{ prefix: '', complete: false }]

  /**
   * Prefixes the files mounting `file` put in front of a route at `offset`.
   * `param` is the function parameter the route's receiver comes from, if any:
   * mounts through a parameter only apply to receivers derived from it.
   */
  const filePrefixes = (
    file: string,
    offset: number,
    param: string | undefined,
    depth: number,
  ): FilePrefix[] | null => {
    const entry = incoming.get(file)
    if (!entry) return null
    const groups = rangesContaining(entry.sorted, offset)
    if (entry.whole.length === 0 && groups.length === 0) return null
    // The edge set is identified by the range groups it came from, so the key stays short however many edges there are.
    const key = `${file}\n${groups.map((group) => group.id).join(',')}\n${param ?? ''}`
    const cached = memo.get(key)
    if (cached !== undefined) return cached
    const recent = volatile.get(key)
    if (recent && recent.query === topQuery) return recent.result
    const position = onPath.get(key)
    if (position !== undefined) {
      lowest = Math.min(lowest, position)
      return CUT
    }
    const edges: ModuleMount[] = []
    for (const edge of entry.whole) {
      if (edges.length >= MAX_MOUNTS) break
      edges.push(edge)
    }
    for (const group of groups) {
      for (const edge of group.edges) {
        if (edges.length >= MAX_MOUNTS) break
        if (edge.param === undefined || edge.param === param) edges.push(edge)
      }
    }
    if (edges.length === 0) {
      memo.set(key, null)
      return null
    }
    if (depth > MAX_DEPTH) {
      lowest = -1
      return CUT
    }
    if (run.spent > TOTAL_BUDGET) {
      run.exhausted = true
      return CUT
    }
    onPath.set(key, depth)
    const outerLowest = lowest
    lowest = Number.POSITIVE_INFINITY
    const out: FilePrefix[] = []
    for (const edge of edges) {
      const parentFacts = byFile.get(edge.from) as FileFacts
      for (const parent of query(run, parentFacts, edge.parent, edge.offset)) {
        const prefix = joinRoutePath(parent.prefix, edge.prefix)
        const resolved = parent.resolved && edge.resolved
        const above = filePrefixes(edge.from, edge.offset, parent.param, depth + 1)
        if (above) {
          for (const outer of above)
            out.push({ prefix: joinRoutePath(outer.prefix, prefix), complete: outer.complete && resolved })
        } else {
          out.push({ prefix, complete: parent.rooted && resolved })
        }
      }
    }
    onPath.delete(key)
    run.spent += out.length
    const result = best(out, (prefix) => prefix.complete, filePrefixKey)
    if (lowest > depth) memo.set(key, result)
    else volatile.set(key, { query: topQuery, result })
    lowest = Math.min(outerLowest, lowest)
    return result
  }
  const outerPrefixes = (file: string, offset: number, param: string | undefined) => {
    topQuery++
    lowest = Number.POSITIVE_INFINITY
    return filePrefixes(file, offset, param, 0)
  }

  const routes: Route[] = []
  for (const facts of files) {
    for (const def of facts.routes) {
      if (routes.length >= MAX_OUTPUT) return { routes, truncated: true }
      const variants: Array<{ prefix: string; complete: boolean; trust: Trust }> = []
      for (const receiver of query(run, facts, def.root, def.offset)) {
        const outer = outerPrefixes(facts.file, def.offset, receiver.param)
        if (outer) {
          for (const o of outer) {
            const prefix = joinRoutePath(o.prefix, receiver.prefix)
            variants.push({ prefix, complete: o.complete && receiver.resolved, trust: receiver.trust })
          }
        } else {
          const complete = receiver.rooted && receiver.resolved
          variants.push({ prefix: receiver.prefix, complete, trust: receiver.trust })
        }
      }
      // One definition mounted in many places still yields a bounded number of routes.
      for (const variant of variants.slice(0, MAX_VARIANTS)) {
        const confidence: Confidence = variant.trust === 'unknown' ? 'low' : variant.complete ? 'high' : 'medium'
        const note =
          confidence === 'high'
            ? undefined
            : confidence === 'low'
              ? 'receiver could not be identified as a router'
              : options.unresolvedNote
        const route = makeRoute({
          method: def.method,
          path: joinRoutePath(variant.prefix, def.path),
          kind: 'api',
          framework: def.framework,
          file: facts.file,
          line: def.line,
          confidence,
          package: facts.package,
          ...(note ? { note } : {}),
        })
        if (route) routes.push(route)
      }
    }
  }
  return { routes, truncated: run.exhausted }
}
