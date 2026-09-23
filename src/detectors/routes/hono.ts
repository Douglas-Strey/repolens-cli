/**
 * Hono: `app.get('/x', handler)`, `app.on('GET', '/x', handler)`, chained
 * routes, `basePath()`, and sub-apps mounted with `app.route('/prefix', sub)`.
 */
import type { HttpMethod } from '../../types.ts'
import {
  type ArgValue,
  argValue,
  assignedName,
  type BindingClass,
  chainOf,
  chainPrefix,
  importsModule,
  isHandlerLike,
  type JsFile,
  type JsFrameworkFacts,
  jsBindings,
  localNamesOf,
  mountTarget,
  namesPattern,
  type PendingModuleMount,
  receiverTrust,
  rootRefOf,
  stringValues,
  typedNames,
} from './js.ts'
import type { LocalMount, RootRef, RouteDef } from './resolve.ts'
import { toHttpMethod } from './shared.ts'

export const HONO_UNRESOLVED_NOTE = 'not created with new Hono() in this file; a prefix may apply'

const SHORTHAND_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'all'])
const HONO_MODULES = ['hono', '@hono/zod-openapi']

function routePaths(value: ArgValue | undefined): string[] {
  if (!value) return []
  return (stringValues(value) ?? []).filter((path) => path.startsWith('/'))
}

export function honoFacts(js: JsFile): JsFrameworkFacts {
  const { src, imports } = js
  const honoNames = new Set([
    'Hono',
    ...localNamesOf(imports, 'hono', ['Hono']),
    ...localNamesOf(imports, '@hono/zod-openapi', ['OpenAPIHono']),
  ])
  const names = namesPattern(honoNames)
  const appPattern = new RegExp(String.raw`^new\s+${names}\b`)
  const appWithBase = new RegExp(
    String.raw`^new\s+${names}\b[^;\n]{0,300}?\)\s*\.\s*basePath\s*\(\s*(['"\x60])([^'"\x60\n$]*)\1\s*\)`,
  )
  const derivedBase = /^([A-Za-z_$][\w$]*)\s*\.\s*basePath\s*\(\s*(['"`])([^'"`\n$]*)\2\s*\)/
  const classify = (rhs: string): BindingClass | null => {
    const withBase = appWithBase.exec(rhs)
    if (withBase) return { kind: 'app', prefix: withBase[2] ?? '' }
    if (appPattern.test(rhs)) return { kind: 'app' }
    const derived = derivedBase.exec(rhs)
    if (derived?.[1]) return { kind: 'router', parent: derived[1], prefix: derived[3] ?? '' }
    return null
  }
  const classifyExpr = (callee: string, isNew: boolean): 'app' | 'router' | null =>
    isNew && honoNames.has(callee) ? 'app' : null

  const bindings = jsBindings(js, classify)
  const boundNames = new Set(bindings.map((binding) => binding.name))
  const typed = typedNames(src.code, ['Hono', 'OpenAPIHono'], (offset) => src.inLiteral(offset))
  const routes: RouteDef[] = []
  const localMounts: LocalMount[] = []
  const moduleMounts: PendingModuleMount[] = []

  const bindingAt = new Map(bindings.map((binding) => [binding.offset, binding]))

  for (const call of js.calls) {
    const chain = chainOf(call)
    // `const books = new Hono().get('/', h)`: the chain registers its routes on `books`.
    const assigned = assignedName(js, chain.root)
    const binding = assigned ? bindingAt.get(assigned.offset) : undefined
    // That binding's prefix already holds the chain's first basePath().
    let skipBase = binding !== undefined && binding.prefix !== ''
    const { prefix, resolved } = chainPrefix(chain, (parent) => {
      if (parent.name !== 'basePath') return undefined
      if (skipBase) {
        skipBase = false
        return undefined
      }
      const span = parent.args[0]
      const value = span ? stringValues(argValue(src, span)) : null
      return value?.length === 1 ? (value[0] as string) : null
    })
    // A route before the binding's basePath() (still to skip) is not under its prefix: keep the inline app.
    const root: RootRef =
      binding && !skipBase
        ? { kind: 'name', name: binding.name, prefix, resolved }
        : rootRefOf(chain.root, prefix, resolved, classifyExpr)
    const values = call.args.map((span) => argValue(src, span))
    // Handlers and middleware follow the path; `api.get('/users', { params })` is an HTTP client call.
    const handlerFrom = (index: number) => call.args.slice(index).some((span) => isHandlerLike(src, span))

    let methods: HttpMethod[] = []
    let paths: string[] = []
    if (SHORTHAND_METHODS.has(call.name) && handlerFrom(1)) {
      const method = toHttpMethod(call.name)
      if (method) methods = [method]
      paths = routePaths(values[0])
    } else if (call.name === 'on' && handlerFrom(2)) {
      for (const name of stringValues(values[0] as ArgValue) ?? []) {
        const method = toHttpMethod(name)
        if (method && !methods.includes(method)) methods.push(method)
      }
      paths = routePaths(values[1])
    } else if (call.name === 'route' && values.length === 2) {
      const literal = stringValues(values[0] as ArgValue, js.constants)
      const target = mountTarget(js, values[1] as ArgValue, boundNames)
      if (!target) continue
      for (const mountPrefix of literal ?? ['']) {
        const mount = { parent: root, offset: call.offset, prefix: mountPrefix, resolved: literal !== null }
        if (target.kind === 'module') moduleMounts.push({ ...mount, specifier: target.specifier })
        else localMounts.push({ ...mount, target: target.name })
      }
      continue
    }
    for (const method of methods) {
      for (const path of paths) {
        routes.push({ root, offset: call.offset, line: call.line, method, path, framework: 'hono' })
      }
    }
  }

  return {
    importsFramework: HONO_MODULES.some((name) => importsModule(imports, name)),
    facts: {
      file: js.file,
      package: js.package,
      bindings,
      spans: [],
      localMounts,
      routes,
      scopes: [],
      trustName: receiverTrust(typed),
    },
    moduleMounts,
  }
}
