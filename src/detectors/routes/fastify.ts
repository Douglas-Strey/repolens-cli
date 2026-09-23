/**
 * Fastify: shorthand routes (`fastify.get('/x', handler)`), the object form
 * (`fastify.route({ method, url })`) and plugin prefixes
 * (`app.register(plugin, { prefix: '/users' })`) for imported, same-file and
 * inline plugins.
 */
import type { HttpMethod } from '../../types.ts'
import {
  type ArgValue,
  argValue,
  type BindingClass,
  chainOf,
  importsModule,
  isHandlerLike,
  type JsFile,
  type JsFrameworkFacts,
  jsBindings,
  localFunction,
  localNamesOf,
  mountTarget,
  namesPattern,
  objectProperties,
  type PendingModuleMount,
  receiverTrust,
  rootRefOf,
  stringValues,
  typedNames,
} from './js.ts'
import type { PrefixSpan, RouteDef } from './resolve.ts'
import { toHttpMethod } from './shared.ts'
import type { FunctionLiteral, SourceText, Span } from './source.ts'

export const FASTIFY_UNRESOLVED_NOTE = 'registered as a plugin; a prefix may apply'

const SHORTHAND_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all'])

function routePaths(value: ArgValue | undefined): string[] {
  if (!value) return []
  return (stringValues(value) ?? []).filter((path) => path.startsWith('/'))
}

function routeMethods(value: ArgValue | undefined): HttpMethod[] {
  if (!value) return []
  const methods: HttpMethod[] = []
  for (const name of stringValues(value) ?? []) {
    const method = toHttpMethod(name)
    if (method && !methods.includes(method)) methods.push(method)
  }
  return methods
}

/**
 * Shorthand routes take a handler, or an options object holding one
 * (`fastify.get('/x', { handler })`); `api.get('/users', { params })` is an HTTP client call.
 */
function hasHandler(src: SourceText, args: readonly Span[], values: readonly ArgValue[]): boolean {
  for (let i = 1; i < args.length; i++) {
    const value = values[i]
    if (
      value?.kind === 'object' ? objectProperties(src, value.open).has('handler') : isHandlerLike(src, args[i] as Span)
    )
      return true
  }
  return false
}

export function fastifyFacts(js: JsFile): JsFrameworkFacts {
  const { src, imports } = js
  const fastifyNames = new Set(['Fastify', 'fastify', ...localNamesOf(imports, 'fastify', ['default', '*', 'fastify'])])
  const appPattern = new RegExp(
    String.raw`^(?:await\s+)?(?:${namesPattern(fastifyNames)}|require\s*\(\s*['"]fastify['"]\s*\))\s*\(`,
  )
  const derivedPattern = /^([A-Za-z_$][\w$]*)\s*\.\s*withTypeProvider\s*(?:<[^;\n]{0,300}?>)?\s*\(/
  const classify = (rhs: string): BindingClass | null => {
    if (appPattern.test(rhs)) return { kind: 'app' }
    const derived = derivedPattern.exec(rhs)
    if (derived?.[1]) return { kind: 'router', parent: derived[1] }
    return null
  }
  const classifyExpr = (callee: string): 'app' | 'router' | null => (fastifyNames.has(callee) ? 'app' : null)

  const bindings = jsBindings(js, classify)
  const typed = typedNames(src.code, ['FastifyInstance'], (offset) => src.inLiteral(offset))
  const routes: RouteDef[] = []
  const spans: PrefixSpan[] = []
  const moduleMounts: PendingModuleMount[] = []
  let usesFastifyReceiver = false

  for (const call of js.calls) {
    const chain = chainOf(call)
    if (chain.root.kind === 'name' && (chain.root.name === 'fastify' || typed.has(chain.root.name))) {
      usesFastifyReceiver = true
    }
    const root = rootRefOf(chain.root, '', true, classifyExpr)
    const values = call.args.map((span) => argValue(src, span))

    if (SHORTHAND_METHODS.has(call.name)) {
      const method = toHttpMethod(call.name)
      if (!method || !hasHandler(src, call.args, values)) continue
      for (const path of routePaths(values[0])) {
        routes.push({ root, offset: call.offset, line: call.line, method, path, framework: 'fastify' })
      }
    } else if (call.name === 'route') {
      const options = values[0]
      if (options?.kind !== 'object') continue
      const props = objectProperties(src, options.open)
      const methodSpan = props.get('method')
      const urlSpan = props.get('url') ?? props.get('path')
      const methods = routeMethods(methodSpan ? argValue(src, methodSpan) : undefined)
      const paths = routePaths(urlSpan ? argValue(src, urlSpan) : undefined)
      for (const method of methods) {
        for (const path of paths) {
          routes.push({ root, offset: call.offset, line: call.line, method, path, framework: 'fastify' })
        }
      }
    } else if (call.name === 'register') {
      const plugin = values[0]
      if (!plugin) continue
      let prefix = ''
      let resolved = true
      const options = values[1]
      if (options?.kind === 'object') {
        const prefixSpan = objectProperties(src, options.open).get('prefix')
        if (prefixSpan) {
          const literal = stringValues(argValue(src, prefixSpan), js.constants)
          if (literal?.length === 1) prefix = literal[0] as string
          else resolved = false
        }
      } else if (options) {
        resolved = false
      }
      const mount = { parent: root, offset: call.offset, prefix, resolved }
      let fn: FunctionLiteral | null = null
      if (plugin.kind === 'function') {
        fn = plugin.fn
      } else {
        const target = mountTarget(js, plugin, new Set())
        if (target?.kind === 'module') moduleMounts.push({ ...mount, specifier: target.specifier })
        else if (plugin.kind === 'identifier' && !imports.locals.has(plugin.name)) fn = localFunction(js, plugin.name)
      }
      if (fn) spans.push({ ...mount, start: fn.body.start, end: fn.body.end, param: fn.param })
    }
  }

  return {
    importsFramework:
      importsModule(imports, 'fastify') || importsModule(imports, 'fastify-plugin') || usesFastifyReceiver,
    facts: {
      file: js.file,
      package: js.package,
      bindings,
      spans,
      localMounts: [],
      routes,
      scopes: [],
      trustName: receiverTrust(typed),
    },
    moduleMounts,
  }
}
