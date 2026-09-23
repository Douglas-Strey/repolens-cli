import type { Detector, ToolKind } from '../types.ts'
import type { Invocation } from './knowledge/commands.ts'
import type { ProjectLayout } from './knowledge/layout.ts'
import {
  detectTools,
  JS_EXTENSIONS,
  type ScriptMatcher,
  sortTools,
  type ToolSpec,
  toolFacts,
} from './knowledge/tools.ts'

const JS = JS_EXTENSIONS

export const BUILD_KIND_ORDER: readonly ToolKind[] = ['task-runner', 'bundler', 'compiler', 'build']

/** Script names that check rather than build, e.g. "typecheck": "tsc" with noEmit in tsconfig.json. */
const CHECK_SCRIPT = /type-?check|check|lint|verify|test/i
const BUILD_SCRIPT = /build|compile|bundle|dist|prepack|prepare|prepublish|declarations?|dts|emit/i
/** Flags that make tsc write files somewhere specific. */
const OUTPUT_FLAGS = new Set([
  '--outDir',
  '--outFile',
  '-d',
  '--declaration',
  '--declarationDir',
  '--emitDeclarationOnly',
])
const EMIT_FLAGS = new Set(['-b', '--build', ...OUTPUT_FLAGS])
const NON_BUILD_FLAGS = new Set(['--noEmit', '--version', '-v', '--help', '-h', '--init', '--showConfig'])

/** Programs that produce the build output themselves (`vite build`, `next build`, …). */
const BUNDLER_BINS = new Set([
  'vite',
  'webpack',
  'webpack-cli',
  'rollup',
  'esbuild',
  'rolldown',
  'rspack',
  'rsbuild',
  'parcel',
  'tsup',
  'tsdown',
  'unbuild',
  'next',
  'nuxt',
  'nuxi',
  'astro',
  'remix',
  'react-router',
  'ng',
  'electron-vite',
  'react-scripts',
  'vue-cli-service',
])

function flagName(arg: string): string {
  return arg.split('=')[0] as string
}

/**
 * Does this invocation compile with tsc as a build step? `tsc --noEmit` and
 * check-style scripts are type checks, not builds. So is a bare `tsc` or
 * `tsc -b` next to a bundler ("tsc -b && vite build" in the Vite templates,
 * whose tsconfig sets noEmit): the bundler emits, unless tsc is told where to
 * write (e.g. `--emitDeclarationOnly`).
 */
export function runsTscBuild(invocation: Invocation, scriptName: string, script: readonly Invocation[] = []): boolean {
  if (invocation.bin !== 'tsc') return false
  if (invocation.args.some((arg) => NON_BUILD_FLAGS.has(flagName(arg)))) return false
  if (CHECK_SCRIPT.test(scriptName)) return false
  const writesOutput = invocation.args.some((arg) => OUTPUT_FLAGS.has(flagName(arg)))
  const bundled = script.some(
    (other) => BUNDLER_BINS.has(other.bin) || (other.bin === 'bun' && other.args[0] === 'build'),
  )
  if (bundled && !writesOutput) return false
  return BUILD_SCRIPT.test(scriptName) || invocation.args.some((arg) => EMIT_FLAGS.has(flagName(arg)))
}

const TSC_BUILD: ScriptMatcher = { label: 'tsc', test: runsTscBuild }

/** Known build tools. Meta-frameworks (Nuxt, Next.js, SvelteKit, Astro) bundle internally; their bundler is only reported when declared directly. */
export const BUILD_TOOLS: readonly ToolSpec[] = [
  // Bundlers
  { id: 'vite', name: 'Vite', kind: 'bundler', dependencies: ['vite'], bins: ['vite'], configs: [`vite.config.${JS}`] },
  {
    id: 'webpack',
    name: 'webpack',
    kind: 'bundler',
    dependencies: ['webpack'],
    bins: ['webpack', 'webpack-cli'],
    configs: [`webpack.config.${JS}`, `webpack.*.${JS}`],
  },
  {
    id: 'rollup',
    name: 'Rollup',
    kind: 'bundler',
    dependencies: ['rollup'],
    bins: ['rollup'],
    configs: [`rollup.config.${JS}`],
  },
  { id: 'esbuild', name: 'esbuild', kind: 'bundler', dependencies: ['esbuild'] },
  { id: 'rolldown', name: 'Rolldown', kind: 'bundler', dependencies: ['rolldown'], configs: [`rolldown.config.${JS}`] },
  {
    id: 'rspack',
    name: 'Rspack',
    kind: 'bundler',
    dependencies: ['@rspack/core', '@rspack/cli'],
    bins: ['rspack'],
    configs: [`rspack.config.${JS}`],
  },
  {
    id: 'rsbuild',
    name: 'Rsbuild',
    kind: 'bundler',
    dependencies: ['@rsbuild/core'],
    bins: ['rsbuild'],
    configs: [`rsbuild.config.${JS}`],
  },
  { id: 'parcel', name: 'Parcel', kind: 'bundler', dependencies: ['parcel'], configs: ['.parcelrc'] },
  {
    id: 'tsup',
    name: 'tsup',
    kind: 'bundler',
    dependencies: ['tsup'],
    bins: ['tsup'],
    configs: [`tsup.config.${JS}`, 'tsup.config.json'],
  },
  { id: 'tsdown', name: 'tsdown', kind: 'bundler', dependencies: ['tsdown'], configs: [`tsdown.config.${JS}`] },
  {
    id: 'unbuild',
    name: 'unbuild',
    kind: 'bundler',
    dependencies: ['unbuild'],
    configs: [{ pattern: `build.config.${JS}`, weak: true }],
  },
  // Compilers
  { id: 'swc', name: 'SWC', kind: 'compiler', dependencies: ['@swc/core', '@swc/cli'], configs: ['.swcrc'] },
  {
    id: 'babel',
    name: 'Babel',
    kind: 'compiler',
    dependencies: ['@babel/core'],
    configs: [`babel.config.${JS}`, 'babel.config.json', '.babelrc', '.babelrc.{js,cjs,mjs,cts,json}'],
    packageJsonFields: [{ key: 'babel' }],
  },
  { id: 'tsc', name: 'tsc', kind: 'compiler', scripts: [TSC_BUILD], versionFrom: 'typescript' },
  // Task runners
  {
    id: 'turbo',
    name: 'Turborepo',
    kind: 'task-runner',
    dependencies: ['turbo'],
    configs: ['turbo.json', 'turbo.jsonc'],
  },
  { id: 'nx', name: 'Nx', kind: 'task-runner', dependencies: ['nx'], configs: ['nx.json'] },
  { id: 'lerna', name: 'Lerna', kind: 'task-runner', dependencies: ['lerna'], configs: ['lerna.json'] },
  { id: 'make', name: 'Make', kind: 'task-runner', configs: ['Makefile', 'makefile', 'GNUmakefile'] },
  { id: 'just', name: 'just', kind: 'task-runner', configs: ['justfile', 'Justfile', '.justfile'] },
  {
    id: 'task',
    name: 'Task',
    kind: 'task-runner',
    configs: ['Taskfile.{yml,yaml}', 'taskfile.{yml,yaml}', 'Taskfile.dist.{yml,yaml}'],
  },
  // Release builds
  { id: 'goreleaser', name: 'GoReleaser', kind: 'build', configs: ['.goreleaser.{yml,yaml}', 'goreleaser.{yml,yaml}'] },
]

/**
 * Shared lint, format and TypeScript config packages ("@acme/eslint-config",
 * "@repo/typescript-config", "prettier-config-x", "@acme/tsconfig"), matched
 * on the unscoped name.
 */
const CONFIG_PACKAGE =
  /^(?:(?:eslint|prettier|stylelint|commitlint|typescript|ts|biome|lint)-config|tsconfig|eslint-plugin|config-(?:eslint|prettier|typescript|ts|stylelint))(?:-|$)|-(?:eslint|prettier|stylelint|typescript)-config$|-tsconfig$/

export function isConfigPackageName(name: string): boolean {
  return CONFIG_PACKAGE.test(name.replace(/^@[^/]+\//, '').toLowerCase())
}

/** Directories of packages that only share configuration; their compilers are not the project's build tools. */
export function configOnlyPackages(layout: ProjectLayout): Set<string> {
  return new Set(
    layout.manifests.filter((m) => m.dir !== '.' && m.name && isConfigPackageName(m.name)).map((m) => m.dir),
  )
}

export const buildDetector: Detector<'build'> = {
  id: 'build',
  title: 'Build tools',
  async run(ctx) {
    const facts = await ctx.use(toolFacts)
    const tools = detectTools(BUILD_TOOLS, { ...facts, configOnlyPackages: configOnlyPackages(facts.layout) })
    return { tools: sortTools(tools, BUILD_KIND_ORDER) }
  },
}
