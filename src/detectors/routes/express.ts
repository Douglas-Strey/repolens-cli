/**
 * Express: `app.get('/x', handler)`, `router.route('/x').get(h).post(h)`, and
 * `app.use('/prefix', router)` mounts (same file or relatively imported).
 */
import {
  type ArgValue,
  argValue,
  assignedName,
  type BindingClass,
  chainOf,
  importsModule,
  isHandlerLike,
  type JsCall,
  type JsFile,
  type JsFrameworkFacts,
  jsBindings,
  localNamesOf,
  looksLikePathExpression,
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

export const EXPRESS_UNRESOLVED_NOTE = 'mounted by a router; prefix may apply'

const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all'])

function routePaths(value: ArgValue): string[] {
  return (stringValues(value) ?? []).filter((path) => path.startsWith('/'))
}

/** The `.route('/path')` call a method chain hangs off, if the chain is `x.route(p).get(h).post(h)`. */
function routeChainPath(js: JsFile, call: JsCall): { path: string; route: JsCall } | null {
  const { parents } = chainOf(call)
  for (const parent of parents) {
    if (parent.name === 'route') {
      const span = parent.args[0]
      if (!span || parent.args.length !== 1) return null
      const path = routePaths(argValue(js.src, span))[0]
      return path === undefined ? null : { path, route: parent }
    }
    if (!ROUTE_METHODS.has(parent.name)) return null
  }
  return null
}

export function expressFacts(js: JsFile): JsFrameworkFacts {
  const { src, imports } = js
  const expressNames = new Set(['express', ...localNamesOf(imports, 'express', ['default', '*'])])
  const routerNames = new Set(['Router', ...localNamesOf(imports, 'express', ['Router'])])
  const requireExpress = String.raw`require\s*\(\s*['"]express['"]\s*\)`
  const appPattern = new RegExp(String.raw`^(?:await\s+)?(?:${namesPattern(expressNames)}|${requireExpress})\s*\(`)
  const routerPattern = new RegExp(
    String.raw`^(?:new\s+)?(?:(?:${namesPattern(expressNames)}|${requireExpress})\s*\.\s*)?${namesPattern(routerNames)}\s*\(`,
  )
  const classify = (rhs: string): BindingClass | null => {
    if (routerPattern.test(rhs)) return { kind: 'router' }
    if (appPattern.test(rhs)) return { kind: 'app' }
    return null
  }
  const classifyExpr = (callee: string): 'app' | 'router' | null => {
    if (expressNames.has(callee)) return 'app'
    const [base, member] = callee.split('.')
    if (routerNames.has(callee) || (member === 'Router' && base !== undefined && expressNames.has(base)))
      return 'router'
    return null
  }

  const bindings = jsBindings(js, classify)
  const boundNames = new Set(bindings.map((binding) => binding.name))
  const typed = typedNames(src.code, ['Router', 'IRouter', 'Express', 'Application'], (offset) => src.inLiteral(offset))
  const routes: RouteDef[] = []
  const localMounts: LocalMount[] = []
  const moduleMounts: PendingModuleMount[] = []

  const boundAt = new Set(bindings.map((binding) => binding.offset))

  for (const call of js.calls) {
    const chain = chainOf(call)
    // `const users = express.Router().get('/', h)`: the chain registers its routes on `users`.
    const assigned = assignedName(js, chain.root)
    const root: RootRef =
      assigned && boundAt.has(assigned.offset)
        ? { kind: 'name', name: assigned.name, prefix: '', resolved: true }
        : rootRefOf(chain.root, '', true, classifyExpr)

    if (ROUTE_METHODS.has(call.name)) {
      const method = toHttpMethod(call.name)
      if (!method) continue
      const first = call.args[0]
      const firstValue = first ? argValue(src, first) : null
      const chained = firstValue && firstValue.kind !== 'string' && firstValue.kind !== 'strings'
      const routeChain = chained || !first ? routeChainPath(js, call) : null
      if (routeChain) {
        routes.push({
          root,
          offset: routeChain.route.offset,
          line: routeChain.route.line,
          method,
          path: routeChain.path,
          framework: 'express',
        })
        continue
      }
      // A handler must follow the path: `app.get('title')` reads a setting and
      // `api.get('/users', { params })` is an HTTP client call.
      if (!firstValue || !call.args.slice(1).some((span) => isHandlerLike(src, span))) continue
      for (const path of routePaths(firstValue)) {
        routes.push({ root, offset: call.offset, line: call.line, method, path, framework: 'express' })
      }
      continue
    }

    const firstSpan = call.args[0]
    if (call.name !== 'use' || !firstSpan) continue
    const values = call.args.map((span) => argValue(src, span))
    const first = values[0] as ArgValue
    let prefixes: string[] = ['']
    let resolved = true
    let targetsFrom = 0
    const literal = stringValues(first, js.constants)
    if (literal) {
      prefixes = literal
      targetsFrom = 1
    } else if (
      first.kind === 'dynamic' ||
      (!mountTarget(js, first, boundNames) && looksLikePathExpression(src, firstSpan))
    ) {
      resolved = false
      targetsFrom = 1
    }
    for (const value of values.slice(targetsFrom)) {
      const target = mountTarget(js, value, boundNames)
      if (!target) continue
      for (const prefix of prefixes) {
        const mount = { parent: root, offset: call.offset, prefix, resolved }
        if (target.kind === 'module') moduleMounts.push({ ...mount, specifier: target.specifier })
        else localMounts.push({ ...mount, target: target.name })
      }
    }
  }

  return {
    importsFramework: importsModule(imports, 'express'),
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
