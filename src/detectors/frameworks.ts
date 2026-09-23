import { coerce, compare } from 'semver'
import { type DependencyIndex, type DependencyRef, dependencies } from '../facts/dependencies.ts'
import { manifests } from '../facts/manifests.ts'
import { MAX_SOURCE_FILE_BYTES, sourceFiles } from '../facts/source-files.ts'
import type { Confidence, Detector, Framework, ProjectContext } from '../types.ts'
import { compareText } from '../utils/compare.ts'
import { mapLimit } from '../utils/limit.ts'
import type { ProjectLayout } from './knowledge/layout.ts'
import { goModuleOf, projectLayout } from './knowledge/layout.ts'
import {
  CONFIDENCE_STRENGTH,
  configEvidence,
  dependencyEvidence,
  displayVersion,
  mergeSignals,
  type Signal,
} from './knowledge/signals.ts'
import { type ConfigPattern, JS_EXTENSIONS, locateConfigs } from './knowledge/tools.ts'

export type FrameworkCategory = Framework['category']

export interface FrameworkSpec {
  id: string
  name: string
  category: FrameworkCategory
  ecosystem: Framework['ecosystem']
  /** npm packages or Go module paths; any of them identifies the framework. */
  dependencies: readonly string[]
  configs?: readonly (string | ConfigPattern)[]
  /** Go HTTP routers: a module using one is not also reported as plain net/http. */
  httpRouter?: boolean
}

export const CATEGORY_ORDER: readonly FrameworkCategory[] = [
  'fullstack',
  'frontend',
  'backend',
  'static-site',
  'mobile',
  'desktop',
  'library',
]

const JS = JS_EXTENSIONS

/** Known frameworks. Order matters: it is the display order within a category. */
export const FRAMEWORKS: readonly FrameworkSpec[] = [
  // Full-stack meta-frameworks
  {
    id: 'nuxt',
    name: 'Nuxt',
    category: 'fullstack',
    ecosystem: 'node',
    dependencies: ['nuxt'],
    configs: [`nuxt.config.${JS}`],
  },
  {
    id: 'next',
    name: 'Next.js',
    category: 'fullstack',
    ecosystem: 'node',
    dependencies: ['next'],
    configs: [`next.config.${JS}`],
  },
  {
    id: 'remix',
    name: 'Remix',
    category: 'fullstack',
    ecosystem: 'node',
    dependencies: ['@remix-run/react'],
    configs: [`remix.config.${JS}`],
  },
  {
    id: 'react-router',
    name: 'React Router',
    category: 'fullstack',
    ecosystem: 'node',
    dependencies: ['@react-router/dev'],
    configs: [`react-router.config.${JS}`],
  },
  {
    id: 'sveltekit',
    name: 'SvelteKit',
    category: 'fullstack',
    ecosystem: 'node',
    dependencies: ['@sveltejs/kit'],
    // Plain Svelte + Vite projects have a svelte.config.js too.
    configs: [{ pattern: `svelte.config.${JS}`, weak: true }],
  },
  // Frontend
  {
    id: 'angular',
    name: 'Angular',
    category: 'frontend',
    ecosystem: 'node',
    dependencies: ['@angular/core'],
    configs: ['angular.json'],
  },
  { id: 'react', name: 'React', category: 'frontend', ecosystem: 'node', dependencies: ['react'] },
  { id: 'vue', name: 'Vue', category: 'frontend', ecosystem: 'node', dependencies: ['vue'] },
  { id: 'svelte', name: 'Svelte', category: 'frontend', ecosystem: 'node', dependencies: ['svelte'] },
  { id: 'solid', name: 'Solid', category: 'frontend', ecosystem: 'node', dependencies: ['solid-js'] },
  { id: 'preact', name: 'Preact', category: 'frontend', ecosystem: 'node', dependencies: ['preact'] },
  { id: 'qwik', name: 'Qwik', category: 'frontend', ecosystem: 'node', dependencies: ['@builder.io/qwik'] },
  // Backend (Node)
  { id: 'express', name: 'Express', category: 'backend', ecosystem: 'node', dependencies: ['express'] },
  { id: 'fastify', name: 'Fastify', category: 'backend', ecosystem: 'node', dependencies: ['fastify'] },
  {
    id: 'nestjs',
    name: 'NestJS',
    category: 'backend',
    ecosystem: 'node',
    dependencies: ['@nestjs/core'],
    configs: ['nest-cli.json'],
  },
  { id: 'koa', name: 'Koa', category: 'backend', ecosystem: 'node', dependencies: ['koa'] },
  // @hono/hono is Hono on JSR (Deno: "jsr:@hono/hono@^4").
  { id: 'hono', name: 'Hono', category: 'backend', ecosystem: 'node', dependencies: ['hono', '@hono/hono'] },
  { id: 'hapi', name: 'hapi', category: 'backend', ecosystem: 'node', dependencies: ['@hapi/hapi'] },
  { id: 'elysia', name: 'Elysia', category: 'backend', ecosystem: 'node', dependencies: ['elysia'] },
  {
    id: 'adonisjs',
    name: 'AdonisJS',
    category: 'backend',
    ecosystem: 'node',
    dependencies: ['@adonisjs/core'],
    configs: ['adonisrc.ts', '.adonisrc.json'],
  },
  { id: 'trpc', name: 'tRPC', category: 'backend', ecosystem: 'node', dependencies: ['@trpc/server'] },
  // Backend (Go)
  {
    id: 'gin',
    name: 'Gin',
    category: 'backend',
    ecosystem: 'go',
    dependencies: ['github.com/gin-gonic/gin'],
    httpRouter: true,
  },
  {
    id: 'echo',
    name: 'Echo',
    category: 'backend',
    ecosystem: 'go',
    dependencies: ['github.com/labstack/echo/v4', 'github.com/labstack/echo'],
    httpRouter: true,
  },
  {
    id: 'chi',
    name: 'chi',
    category: 'backend',
    ecosystem: 'go',
    dependencies: ['github.com/go-chi/chi/v5', 'github.com/go-chi/chi'],
    httpRouter: true,
  },
  {
    id: 'fiber',
    name: 'Fiber',
    category: 'backend',
    ecosystem: 'go',
    dependencies: ['github.com/gofiber/fiber/v3', 'github.com/gofiber/fiber/v2'],
    httpRouter: true,
  },
  {
    id: 'gorilla-mux',
    name: 'Gorilla mux',
    category: 'backend',
    ecosystem: 'go',
    dependencies: ['github.com/gorilla/mux'],
    httpRouter: true,
  },
  { id: 'grpc', name: 'gRPC', category: 'backend', ecosystem: 'go', dependencies: ['google.golang.org/grpc'] },
  // Static sites
  {
    id: 'astro',
    name: 'Astro',
    category: 'static-site',
    ecosystem: 'node',
    dependencies: ['astro'],
    configs: [`astro.config.${JS}`],
  },
  {
    id: 'gatsby',
    name: 'Gatsby',
    category: 'static-site',
    ecosystem: 'node',
    dependencies: ['gatsby'],
    configs: [`gatsby-config.${JS}`],
  },
  {
    id: 'docusaurus',
    name: 'Docusaurus',
    category: 'static-site',
    ecosystem: 'node',
    dependencies: ['@docusaurus/core'],
    configs: [`docusaurus.config.${JS}`],
  },
  {
    id: 'vitepress',
    name: 'VitePress',
    category: 'static-site',
    ecosystem: 'node',
    dependencies: ['vitepress'],
    // docs/ is VitePress's documented default source directory.
    configs: [`.vitepress/config.${JS}`, `docs/.vitepress/config.${JS}`],
  },
  // Mobile
  { id: 'react-native', name: 'React Native', category: 'mobile', ecosystem: 'node', dependencies: ['react-native'] },
  { id: 'expo', name: 'Expo', category: 'mobile', ecosystem: 'node', dependencies: ['expo'], configs: ['eas.json'] },
  // Desktop
  {
    id: 'electron',
    name: 'Electron',
    category: 'desktop',
    ecosystem: 'node',
    dependencies: ['electron'],
    configs: [`forge.config.${JS}`, 'electron-builder.{json,json5,yml,yaml,toml}', `electron.vite.config.${JS}`],
  },
]

/** Go's standard library HTTP server, reported only for modules without a router framework. */
export const NET_HTTP = {
  id: 'go-net-http',
  name: 'net/http',
  category: 'backend',
  ecosystem: 'go',
} as const satisfies Pick<FrameworkSpec, 'id' | 'name' | 'category' | 'ecosystem'>

/**
 * A framework in `dependencies` is used by the package; in `devDependencies`
 * it is often only a tool or a library's test setup, and in
 * `peerDependencies` the package merely works with it.
 */
export function frameworkDependencyConfidence(ref: DependencyRef): Confidence {
  switch (ref.type) {
    case 'go':
      return ref.indirect ? 'low' : 'high'
    case 'dependencies':
      return 'high'
    case 'devDependencies':
    case 'optionalDependencies':
      return 'medium'
    case 'peerDependencies':
      return 'low'
  }
}

export function frameworkSignals(spec: FrameworkSpec, deps: DependencyIndex, layout: ProjectLayout): Signal[] {
  const signals: Signal[] = []
  for (const name of spec.dependencies) {
    for (const ref of deps.get(name)) {
      if (ref.ecosystem !== spec.ecosystem) continue
      const signal: Signal = {
        package: ref.package,
        confidence: frameworkDependencyConfidence(ref),
        evidence: dependencyEvidence(ref),
      }
      const version = displayVersion(ref.range)
      if (version !== undefined) signal.version = version
      signals.push(signal)
    }
  }
  const hasDependency = signals.length > 0
  for (const located of locateConfigs(layout, spec.configs ?? [])) {
    const withoutDependency: Confidence = located.config.weak ? 'low' : 'medium'
    signals.push({
      package: located.package,
      confidence: hasDependency ? 'high' : withoutDependency,
      evidence: configEvidence(located.path, located.config.note),
      configFile: located.path,
    })
  }
  return signals
}

const PLAIN_VERSION = /^\d+(?:\.\d+){0,2}(?:[-+][0-9A-Za-z.-]+)?$/

/**
 * Version to show when packages declare different majors of a framework
 * (React ^18 in apps/a, ^19 in apps/b): "lowest–highest", e.g.
 * "18.3.1–19.1.0", instead of whichever package came first. Only the
 * strongest signals count, so a library's peer range does not widen an
 * app's version. Undefined when they agree on a major; each package's own
 * range is in the evidence.
 */
export function versionSummary(signals: readonly Signal[]): string | undefined {
  const versioned = signals.filter((signal) => signal.version !== undefined && PLAIN_VERSION.test(signal.version))
  if (versioned.length < 2) return undefined
  const strongest = Math.max(...versioned.map((signal) => CONFIDENCE_STRENGTH[signal.confidence]))
  const parsed = versioned
    .filter((signal) => CONFIDENCE_STRENGTH[signal.confidence] === strongest)
    .flatMap((signal) => {
      const version = coerce(signal.version)
      return version ? [{ text: signal.version as string, version }] : []
    })
  if (new Set(parsed.map((entry) => entry.version.major)).size < 2) return undefined
  parsed.sort((a, b) => compare(a.version, b.version) || compareText(a.text, b.text))
  return `${parsed[0]?.text}–${parsed[parsed.length - 1]?.text}`
}

export function frameworkFromSignals(
  spec: Pick<FrameworkSpec, 'id' | 'name' | 'category' | 'ecosystem'>,
  signals: readonly Signal[],
): Framework | null {
  const merged = mergeSignals(signals)
  if (!merged) return null
  const version = versionSummary(signals) ?? merged.version
  return {
    id: spec.id,
    name: spec.name,
    ...(version === undefined ? {} : { version }),
    category: spec.category,
    ecosystem: spec.ecosystem,
    packages: merged.packages,
    confidence: merged.confidence,
    evidence: merged.evidence,
  }
}

export function detectFrameworks(
  deps: DependencyIndex,
  layout: ProjectLayout,
  specs: readonly FrameworkSpec[] = FRAMEWORKS,
): Framework[] {
  const found: Framework[] = []
  for (const spec of specs) {
    const framework = frameworkFromSignals(spec, frameworkSignals(spec, deps, layout))
    if (framework) found.push(framework)
  }
  return found
}

/** By category (CATEGORY_ORDER), then by position in FRAMEWORKS; net/http goes after the Go routers. */
export function sortFrameworks(frameworks: readonly Framework[]): Framework[] {
  const position = new Map(FRAMEWORKS.map((spec, index) => [spec.id, index]))
  const rank = (framework: Framework) => position.get(framework.id) ?? FRAMEWORKS.length
  return [...frameworks].sort(
    (a, b) =>
      CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) ||
      rank(a) - rank(b) ||
      compareText(a.id, b.id),
  )
}

// ---------------------------------------------------------------------------
// Go net/http
// ---------------------------------------------------------------------------

// `[ \t]` rather than `\s`: with the m flag, `^\s*` restarted at every line of
// a long blank run and made the scan quadratic on hostile files.
const NET_HTTP_IMPORT = /^[ \t]*(?:import[ \t]+)?(?:[\w.]+[ \t]+)?"net\/http"[ \t]*(?:\/\/.*)?$/m
const NET_HTTP_SERVER = /\b(?:HandleFunc|ListenAndServe(?:TLS)?)\s*\(|\.Handle\s*\(\s*["`]/

/** Does this Go source import net/http and register handlers or start a server with it? */
export function servesNetHttp(source: string): boolean {
  return NET_HTTP_IMPORT.test(source) && NET_HTTP_SERVER.test(source)
}

const NET_HTTP_LISTEN = /\bListenAndServe(?:TLS)?\s*\(/

/** Does this Go source start an HTTP server with net/http (not just register handlers)? */
export function startsNetHttpServer(source: string): boolean {
  return NET_HTTP_IMPORT.test(source) && NET_HTTP_LISTEN.test(source)
}

/** Go module directories that do not directly require an HTTP router framework. */
export function modulesWithoutRouter(goModuleDirs: readonly string[], deps: DependencyIndex): string[] {
  const routers = new Set(FRAMEWORKS.filter((spec) => spec.httpRouter).flatMap((spec) => spec.dependencies))
  return goModuleDirs.filter(
    (dir) => !deps.inPackage(dir).some((ref) => ref.ecosystem === 'go' && !ref.indirect && routers.has(ref.name)),
  )
}

const SCAN_BATCH = 16

/** First file (in path order) for which `test` holds; reads in small parallel batches and stops early. */
export async function findFirst(
  files: readonly string[],
  test: (file: string) => Promise<boolean>,
): Promise<string | null> {
  for (let start = 0; start < files.length; start += SCAN_BATCH) {
    const batch = files.slice(start, start + SCAN_BATCH)
    const results = await mapLimit(batch, SCAN_BATCH, test)
    const index = results.indexOf(true)
    if (index !== -1) return batch[index] as string
  }
  return null
}

async function detectNetHttp(ctx: ProjectContext, deps: DependencyIndex): Promise<Framework[]> {
  const project = await ctx.use(manifests)
  const candidates = modulesWithoutRouter(
    project.goModules.map((mod) => mod.dir),
    deps,
  )
  if (candidates.length === 0) return []
  const { files } = await ctx.use(sourceFiles)
  const moduleDirs = new Set(project.goModules.map((mod) => mod.dir))
  const goFilesByModule = new Map<string, string[]>(candidates.map((dir) => [dir, []]))
  for (const file of files) {
    if (file.ext !== '.go' || file.path.endsWith('_test.go')) continue
    const module = goModuleOf(file.path, moduleDirs)
    if (module !== null) goFilesByModule.get(module)?.push(file.path)
  }
  const found: Framework[] = []
  for (const dir of candidates) {
    const goFiles = goFilesByModule.get(dir) ?? []
    const match = await findFirst(goFiles, async (file) => {
      const text = await ctx.readText(file, { cache: false, maxBytes: MAX_SOURCE_FILE_BYTES })
      return text !== null && servesNetHttp(text)
    })
    if (!match) continue
    const framework = frameworkFromSignals(NET_HTTP, [
      { package: dir, confidence: 'medium', evidence: `net/http handlers in ${match}` },
    ])
    if (framework) found.push(framework)
  }
  return found
}

export const frameworksDetector: Detector<'frameworks'> = {
  id: 'frameworks',
  title: 'Frameworks',
  async run(ctx) {
    const [deps, layout] = await Promise.all([ctx.use(dependencies), ctx.use(projectLayout)])
    const found = detectFrameworks(deps, layout)
    found.push(...(await detectNetHttp(ctx, deps)))
    return sortFrameworks(found)
  },
}
