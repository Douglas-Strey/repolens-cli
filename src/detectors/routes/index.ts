/**
 * Route extraction.
 *
 * File-system routers (Nuxt, Next.js) are derived from file names. Code-based
 * routers (Express, Fastify, Hono, NestJS, Go) are found by reading only the
 * source files of packages that depend on the framework, with a lexical pass
 * that ignores comments and strings; nothing is executed.
 */
import { type DependencyIndex, dependencies } from '../../facts/dependencies.ts'
import { type GoModule, manifests, type ProjectManifests } from '../../facts/manifests.ts'
import { createOwnerResolver, MAX_SOURCE_FILE_BYTES, type SourceFile, sourceFiles } from '../../facts/source-files.ts'
import type { Detector, ProjectContext, Route } from '../../types.ts'
import { mapLimit } from '../../utils/limit.ts'
import { dirOf, isInDir, joinPath } from '../../utils/paths.ts'
import { NUXT_CONFIG_FILES, parseNuxtConfig } from './config.ts'
import { EXPRESS_UNRESOLVED_NOTE, expressFacts } from './express.ts'
import { FASTIFY_UNRESOLVED_NOTE, fastifyFacts } from './fastify.ts'
import { GO_UNRESOLVED_NOTE, type GoFileFacts, type GoFramework, goFacts, goModuleFrameworks } from './go.ts'
import { HONO_UNRESOLVED_NOTE, honoFacts } from './hono.ts'
import { type JsFile, type JsFrameworkFacts, parseJsFile, resolveRelativeModule } from './js.ts'
import { type NestFileFacts, nestFacts, nestRoutes } from './nest.ts'
import { nextRoutes } from './next.ts'
import { nuxtRoutes } from './nuxt.ts'
import { type FileFacts, type ModuleMount, resolveRoutes } from './resolve.ts'
import { finalizeRoutes, isNonAppSource, MAX_ROUTES } from './shared.ts'

export { normalizePath } from './shared.ts'

type JsFramework = 'express' | 'fastify' | 'hono'

const JS_FRAMEWORKS: Record<JsFramework, { extract: (js: JsFile) => JsFrameworkFacts; note: string }> = {
  express: { extract: expressFacts, note: EXPRESS_UNRESOLVED_NOTE },
  fastify: { extract: fastifyFacts, note: FASTIFY_UNRESOLVED_NOTE },
  hono: { extract: honoFacts, note: HONO_UNRESOLVED_NOTE },
}

const JS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx'])
const READ_CONCURRENCY = 16
/** Files are processed in fixed-size batches so the definition cap below is deterministic. */
const BATCH_SIZE = 64
/** Stop reading more files after this many raw route definitions (a memory guard for huge repos). */
const MAX_DEFINITIONS = MAX_ROUTES * 5

interface JsFileResult {
  kind: 'js'
  file: string
  package: string
  frameworks: Partial<Record<JsFramework, JsFrameworkFacts>>
  nest?: NestFileFacts
}

interface GoFileResult {
  kind: 'go'
  file: string
  module: string
  facts: GoFileFacts
}

type FileResult = JsFileResult | GoFileResult

interface ScanPlan {
  jsFrameworks: Map<string, JsFramework[]>
  nestPackages: Set<string>
  goModules: Map<string, Set<GoFramework>>
  goModuleList: readonly GoModule[]
}

/** Push without spreading, which overflows the stack for very large arrays. */
function append<T>(target: T[], items: readonly T[]): void {
  for (const item of items) target.push(item)
}

function definitionsIn(result: FileResult): number {
  if (result.kind === 'go') return result.facts.facts.routes.length
  let count = result.nest?.routes.length ?? 0
  for (const facts of Object.values(result.frameworks)) count += facts?.facts.routes.length ?? 0
  return count
}

/** Deepest Go module directory containing `file`. */
function goModuleOf(modules: readonly GoModule[], file: string): string | null {
  let best: string | null = null
  for (const mod of modules) {
    if (isInDir(file, mod.dir) && (best === null || mod.dir.length > best.length)) best = mod.dir
  }
  return best
}

function analyzeFile(source: SourceFile, text: string, plan: ScanPlan, goModule: string | null): FileResult | null {
  if (source.ext === '.go') {
    const allowed = goModule === null ? undefined : plan.goModules.get(goModule)
    if (goModule === null || !allowed) return null
    return { kind: 'go', file: source.path, module: goModule, facts: goFacts(source.path, goModule, text, allowed) }
  }
  const js = parseJsFile(source.path, source.package, text)
  const result: JsFileResult = { kind: 'js', file: source.path, package: source.package, frameworks: {} }
  for (const framework of plan.jsFrameworks.get(source.package) ?? []) {
    result.frameworks[framework] = JS_FRAMEWORKS[framework].extract(js)
  }
  if (plan.nestPackages.has(source.package)) result.nest = nestFacts(js.src, js.imports)
  return result
}

/**
 * Routes of one JavaScript framework: files that import it, plus files they
 * mount (transitively), resolved together so prefixes carry across files.
 */
function jsFrameworkRoutes(
  results: readonly JsFileResult[],
  framework: JsFramework,
): { routes: Route[]; truncated: boolean } {
  const byFile = new Map<string, JsFrameworkFacts>()
  for (const result of results) {
    const facts = result.frameworks[framework]
    if (facts) byFile.set(result.file, facts)
  }
  const inScope = new Set<string>()
  const queue: string[] = []
  for (const [file, facts] of byFile) {
    if (facts.importsFramework) {
      inScope.add(file)
      queue.push(file)
    }
  }
  const mounts: ModuleMount[] = []
  const exists = (file: string) => byFile.has(file)
  for (let next = 0; next < queue.length; next++) {
    const file = queue[next] as string
    for (const pending of byFile.get(file)?.moduleMounts ?? []) {
      const target = resolveRelativeModule(file, pending.specifier, exists)
      if (!target) continue
      const { specifier: _specifier, ...mount } = pending
      mounts.push({ ...mount, from: file, target })
      if (!inScope.has(target)) {
        inScope.add(target)
        queue.push(target)
      }
    }
  }
  const files: FileFacts[] = []
  for (const [file, facts] of byFile) if (inScope.has(file)) files.push(facts.facts)
  return resolveRoutes(files, mounts, { unresolvedNote: JS_FRAMEWORKS[framework].note })
}

/** Directory of a Go package of the scanned modules, from its import path; null for other packages. */
function goPackageDir(modules: readonly GoModule[], importPath: string): string | null {
  let best: GoModule | null = null
  for (const mod of modules) {
    const inside = importPath === mod.module || importPath.startsWith(`${mod.module}/`)
    if (inside && (best === null || mod.module.length > best.module.length)) best = mod
  }
  if (!best) return null
  return best.module === importPath ? best.dir : joinPath(best.dir, importPath.slice(best.module.length + 1))
}

function goRoutes(
  results: readonly GoFileResult[],
  modules: readonly GoModule[],
): { routes: Route[]; truncated: boolean } {
  // Functions by Go package (directory) and name, for `r.Mount("/x", newRouter())` and
  // `users.Register(v1.Group("/users"))` across files and packages.
  type GoFunc = GoFileFacts['funcs'][number] & { file: string }
  const funcsByDir = new Map<string, Map<string, GoFunc[]>>()
  for (const result of results) {
    const dir = dirOf(result.file)
    let byName = funcsByDir.get(dir)
    if (!byName) {
      byName = new Map()
      funcsByDir.set(dir, byName)
    }
    for (const fn of result.facts.funcs) {
      const list = byName.get(fn.name)
      const entry = { ...fn, file: result.file }
      if (list) list.push(entry)
      else byName.set(fn.name, [entry])
    }
  }
  // Only an unambiguous function: build-tagged variants of one function are skipped.
  const uniqueFunc = (dir: string | null, name: string): GoFunc | undefined => {
    const matches = dir === null ? undefined : funcsByDir.get(dir)?.get(name)
    return matches?.length === 1 ? matches[0] : undefined
  }
  const mounts: ModuleMount[] = []
  for (const result of results) {
    const dir = dirOf(result.file)
    for (const mount of result.facts.functionMounts) {
      const target = uniqueFunc(dir, mount.funcName)
      if (!target) continue
      const { funcName: _funcName, ...rest } = mount
      mounts.push({ ...rest, from: result.file, target: target.file, range: { start: target.start, end: target.end } })
    }
    for (const argument of result.facts.routerArguments) {
      const targetDir = argument.importPath === null ? dir : goPackageDir(modules, argument.importPath)
      const target = uniqueFunc(targetDir, argument.funcName)
      const param = target?.params[argument.index]
      if (!target || !param) continue
      mounts.push({
        from: result.file,
        target: target.file,
        range: { start: target.start, end: target.end },
        param: param.name,
        parent: argument.parent,
        offset: argument.offset,
        prefix: '',
        resolved: true,
      })
    }
  }
  return resolveRoutes(
    results.map((result) => result.facts.facts),
    mounts,
    { unresolvedNote: GO_UNRESOLVED_NOTE },
  )
}

function planScan(project: ProjectManifests, deps: DependencyIndex): ScanPlan {
  const jsFrameworks = new Map<string, JsFramework[]>()
  for (const framework of Object.keys(JS_FRAMEWORKS) as JsFramework[]) {
    for (const dir of deps.packagesWith(framework)) {
      const list = jsFrameworks.get(dir) ?? []
      list.push(framework)
      jsFrameworks.set(dir, list)
    }
  }
  const nestPackages = new Set([...deps.packagesWith('@nestjs/core'), ...deps.packagesWith('@nestjs/common')])
  const goModules = new Map<string, Set<GoFramework>>()
  for (const mod of project.goModules) {
    goModules.set(mod.dir, goModuleFrameworks(mod.requires.map((req) => req.path)))
  }
  return { jsFrameworks, nestPackages, goModules, goModuleList: project.goModules }
}

async function codeRoutes(
  ctx: ProjectContext,
  plan: ScanPlan,
  candidates: Array<{ source: SourceFile; goModule: string | null }>,
): Promise<{ routes: Route[]; truncated: boolean }> {
  const maxBytes = Math.min(MAX_SOURCE_FILE_BYTES, ctx.options.maxFileSize)
  const results: FileResult[] = []
  let definitions = 0
  let truncated = false
  for (let start = 0; start < candidates.length; start += BATCH_SIZE) {
    const batch = candidates.slice(start, start + BATCH_SIZE)
    const analyzed = await mapLimit(batch, READ_CONCURRENCY, async ({ source, goModule }) => {
      const text = await ctx.readText(source.path, { cache: false, maxBytes })
      if (text === null) return null
      try {
        return analyzeFile(source, text, plan, goModule)
      } catch (error) {
        ctx.debug(`routes: skipped ${source.path} (${String(error)})`)
        return null
      }
    })
    for (const result of analyzed) {
      if (!result) continue
      results.push(result)
      definitions += definitionsIn(result)
    }
    if (definitions > MAX_DEFINITIONS) {
      truncated = true
      ctx.debug(`routes: stopped reading after ${definitions} route definitions`)
      break
    }
  }

  const jsResults = results.filter((result): result is JsFileResult => result.kind === 'js')
  const goResults = results.filter((result): result is GoFileResult => result.kind === 'go')
  const routes: Route[] = []
  for (const framework of Object.keys(JS_FRAMEWORKS) as JsFramework[]) {
    const resolved = jsFrameworkRoutes(jsResults, framework)
    append(routes, resolved.routes)
    truncated ||= resolved.truncated
  }

  const nestByPackage = new Map<string, Array<{ file: string; facts: NestFileFacts }>>()
  for (const result of jsResults) {
    if (!result.nest) continue
    const list = nestByPackage.get(result.package) ?? []
    list.push({ file: result.file, facts: result.nest })
    nestByPackage.set(result.package, list)
  }
  for (const [pkg, files] of nestByPackage) append(routes, nestRoutes(pkg, files))

  const go = goRoutes(goResults, plan.goModuleList)
  append(routes, go.routes)
  return { routes, truncated: truncated || go.truncated }
}

export const routesDetector: Detector<'routes'> = {
  id: 'routes',
  title: 'Routes',
  async run(ctx) {
    const [project, deps, sources] = await Promise.all([
      ctx.use(manifests),
      ctx.use(dependencies),
      ctx.use(sourceFiles),
    ])
    const routes: Route[] = []
    const owner = createOwnerResolver(project)
    const hasDirectory = (dir: string) => ctx.files.hasDirectory(dir)

    const maxBytes = Math.min(MAX_SOURCE_FILE_BYTES, ctx.options.maxFileSize)
    for (const packageDir of deps.packagesWith('nuxt')) {
      const configFile = NUXT_CONFIG_FILES.map((name) => joinPath(packageDir, name)).find((file) => ctx.files.has(file))
      const config = parseNuxtConfig(configFile === undefined ? null : await ctx.readText(configFile, { maxBytes }))
      append(routes, nuxtRoutes({ files: ctx.files.files, packageDir, hasDirectory, ownerOf: owner, config }))
    }
    for (const packageDir of deps.packagesWith('next')) {
      const read = (file: string) => ctx.readText(file, { cache: false, maxBytes })
      append(routes, await nextRoutes({ files: ctx.files.files, packageDir, hasDirectory, ownerOf: owner, read }))
    }

    const plan = planScan(project, deps)
    const candidates: Array<{ source: SourceFile; goModule: string | null }> = []
    for (const source of sources.files) {
      if (source.ext === '.go') {
        const goModule = goModuleOf(project.goModules, source.path)
        if (goModule !== null && !isNonAppSource(source.path, goModule)) candidates.push({ source, goModule })
      } else if (
        JS_EXTENSIONS.has(source.ext) &&
        (plan.jsFrameworks.has(source.package) || plan.nestPackages.has(source.package)) &&
        !isNonAppSource(source.path, source.package)
      ) {
        candidates.push({ source, goModule: null })
      }
    }
    const code = await codeRoutes(ctx, plan, candidates)
    append(routes, code.routes)
    const truncated = code.truncated || (sources.truncated && candidates.length > 0)
    return finalizeRoutes(routes, truncated)
  },
}
