/**
 * Rules for coding agents derived from scan data. Every rule is backed by a
 * concrete fact (a declared package manager, a version file, a CI job, a
 * config file) and says where that fact comes from; nothing is guessed.
 * Rules are returned as Markdown bullet text.
 */
import { verifyCommands, workspaceScriptExample } from '../output/commands.ts'
import { code, codeList, inline, text } from '../output/markdown/syntax.ts'
import { ciProviderName, runtimeSource, workflowLabel, workflowTasks } from '../output/shared/facts.ts'
import { joinWords, safeText } from '../output/shared/text.ts'
import type { CiTask, PackageManagerId, ScanResult } from '../types.ts'
import { compareText } from '../utils/compare.ts'

const JS_MANAGERS: readonly PackageManagerId[] = ['npm', 'pnpm', 'yarn', 'bun']
/** Managers worth warning against; bun is only named when it is the one in use. */
const COMMON_MANAGERS: readonly PackageManagerId[] = ['npm', 'pnpm', 'yarn']

/** "Use pnpm (packageManager field in package.json); do not use npm or yarn." */
export function packageManagerRule(result: ScanResult): string | null {
  const primary = result.packageManagers.primary
  if (!primary || !JS_MANAGERS.includes(primary.id)) return null
  // npm without a declaration or lockfile is only RepoLens's default for a bare package.json:
  // not enough to tell anyone to avoid the other package managers.
  if (!primary.declared && primary.lockfiles.length === 0 && primary.id === 'npm') return null
  const reason = primary.declared
    ? text(withoutTrailingParenthetical(primary.evidence[0] ?? 'declared in package.json'))
    : primary.lockfiles.length > 0
      ? `lockfile ${codeList(primary.lockfiles)}`
      : text(primary.evidence[0] ?? 'detected')
  const others = COMMON_MANAGERS.filter((id) => id !== primary.id)
  return `Use ${text(primary.name)} (${reason}); do not use ${joinWords(others, 'or')}.`
}

/** "packageManager field in package.json (pnpm@10.17.1)" → "packageManager field in package.json", avoiding nested parentheses. */
function withoutTrailingParenthetical(value: string): string {
  return value.replace(/\s*\([^()]*\)\s*$/, '') || value
}

/** Doctor codes saying the files that pin this runtime disagree, e.g. NODE_VERSION_CONFLICT. */
function runtimeDisagreements(result: ScanResult, runtimeId: string): string[] {
  const prefix = `${runtimeId.toUpperCase()}_VERSION_`
  const codes = result.doctor.diagnostics
    .filter((diagnostic) => diagnostic.severity !== 'info' && diagnostic.code.startsWith(prefix))
    .map((diagnostic) => diagnostic.code)
  return [...new Set(codes)].sort(compareText)
}

/**
 * "Use Node.js 22 (`.nvmrc`) and Go 1.25 (`go.mod` go directive)." When the
 * doctor found that files pin different versions, the rule says so instead
 * of presenting one of them as settled.
 */
export function runtimeRule(result: ScanResult): string | null {
  const parts: string[] = []
  for (const runtime of result.runtimes) {
    if (!runtime.version) continue
    const source = runtimeSource(runtime)
    const notes: string[] = []
    if (source) notes.push(`${code(source.file)}${source.field ? ` ${text(source.field)}` : ''}`)
    const disagreements = runtimeDisagreements(result, runtime.id)
    if (disagreements.length > 0) notes.push(`other files disagree, see ${joinWords(disagreements.map(code))}`)
    const where = notes.length > 0 ? ` (${notes.join('; ')})` : ''
    parts.push(`${text(runtime.name)} ${inline(safeText(runtime.version))}${where}`)
  }
  return parts.length > 0 ? `Use ${joinWords(parts)}.` : null
}

/** "Run `pnpm lint`, `pnpm typecheck` and `pnpm test` before finishing a change." (never a watch or placeholder script) */
export function verifyRule(result: ScanResult): string | null {
  const checks = verifyCommands(result)
  if (checks.length === 0) return null
  return `Run ${joinWords(checks.map((c) => code(safeText(c.command))))} before finishing a change.`
}

/** "Never commit `.env` files; document new variables in `.env.example`." */
export function envRule(result: ScanResult): string | null {
  const { files } = result.environment
  if (files.length === 0) return null
  const examples = files.filter((file) => file.kind === 'example').map((file) => file.path)
  const rootExample = examples.find((path) => !path.includes('/')) ?? examples[0]
  const document = rootExample ? `; document new variables in ${code(rootExample)}` : ''
  return `Never commit ${code('.env')} files or paste their values${document}.`
}

/** Command pattern for running one workspace package's script. */
export function filterPattern(manager: PackageManagerId | undefined): string | null {
  switch (manager) {
    case 'pnpm':
      return 'pnpm --filter <package> <script>'
    case 'yarn':
      return 'yarn workspace <package> <script>'
    case 'bun':
      return 'bun run --filter <package> <script>'
    case 'npm':
      return 'npm run <script> -w <directory>'
    default:
      return null
  }
}

/** "Monorepo (pnpm workspaces, Turborepo): packages live in `apps/*` …; run a package script with `…`." */
export function workspaceRule(result: ScanResult): string | null {
  const workspace = result.workspace
  if (!workspace || workspace.packages.length === 0) return null
  const tools = workspace.tools.map((tool) => text(tool.name))
  const patterns = workspace.patterns.filter((pattern) => !pattern.startsWith('!'))
  const head = `Monorepo${tools.length > 0 ? ` (${tools.join(', ')})` : ''}`
  const where = patterns.length > 0 ? `packages live in ${joinWords(patterns.map(code))}` : ''
  const hasNodePackages = workspace.packages.some((pkg) => pkg.ecosystem === 'node')
  const pattern = hasNodePackages ? filterPattern(result.packageManagers.primary?.id) : null
  // An agent may run the example to try it: never a clean-up script that deletes files.
  const example = workspaceScriptExample(result)
  let run = ''
  if (pattern) {
    run = `run a package script with ${code(pattern)}`
    if (example) run += ` (e.g. ${code(safeText(example.run))})`
  }
  const parts = [where, run].filter((part) => part !== '')
  return parts.length > 0 ? `${head}: ${parts.join('; ')}.` : null
}

const CHECK_TASKS: readonly CiTask[] = ['lint', 'format', 'typecheck', 'test', 'e2e', 'build']

/** One rule per CI workflow that runs checks: "CI (GitHub Actions `ci.yml`) runs: lint, typecheck, test, build." */
export function ciRules(result: ScanResult, limit = 3): string[] {
  const rules: string[] = []
  const workflows = [...result.ci.workflows].sort((a, b) => compareText(a.file, b.file))
  for (const workflow of workflows) {
    const tasks = workflowTasks(workflow).filter((task) => CHECK_TASKS.includes(task))
    if (tasks.length === 0) continue
    const provider = ciProviderName(result, workflow.provider)
    rules.push(`CI (${text(provider)} ${code(workflowLabel(workflow.file))}) runs: ${tasks.join(', ')}.`)
  }
  if (rules.length > limit) {
    const hidden = rules.length - limit
    return [...rules.slice(0, limit), `${hidden} more CI workflow${hidden === 1 ? '' : 's'} run checks.`]
  }
  return rules
}

/** "Code style is enforced by Biome (`biome.json`) and Prettier (`.prettierrc`)." */
export function styleRule(result: ScanResult): string | null {
  const tools = result.linting.tools.filter((tool) => tool.kind === 'linter' || tool.kind === 'formatter')
  if (tools.length === 0) return null
  const names = tools.map((tool) =>
    tool.configFiles.length > 0 ? `${text(tool.name)} (${codeList(tool.configFiles.slice(0, 2))})` : text(tool.name),
  )
  return `Code style is enforced by ${joinWords(names)}.`
}

/** "Tests use Vitest; end-to-end tests use Playwright." */
export function testingRule(result: ScanResult): string | null {
  const unit = result.testing.tools.filter((tool) => tool.kind !== 'e2e').map((tool) => text(tool.name))
  const e2e = result.testing.tools.filter((tool) => tool.kind === 'e2e').map((tool) => text(tool.name))
  const parts: string[] = []
  if (unit.length > 0) parts.push(`Tests use ${joinWords(unit)}`)
  if (e2e.length > 0) parts.push(`${parts.length > 0 ? 'end-to-end' : 'End-to-end'} tests use ${joinWords(e2e)}`)
  return parts.length > 0 ? `${parts.join('; ')}.` : null
}

/** "Database access goes through Prisma (`apps/api/prisma/schema.prisma`)." */
export function ormRule(result: ScanResult): string | null {
  const orms = result.databases.orms
  if (orms.length === 0) return null
  const names = orms.map((orm) =>
    orm.configFiles.length > 0 ? `${text(orm.name)} (${codeList(orm.configFiles.slice(0, 2))})` : text(orm.name),
  )
  return `Database access goes through ${joinWords(names)}.`
}

/** All conventions, most important first. */
export function conventions(result: ScanResult): string[] {
  return [
    packageManagerRule(result),
    runtimeRule(result),
    verifyRule(result),
    workspaceRule(result),
    envRule(result),
    ...ciRules(result),
    styleRule(result),
    testingRule(result),
    ormRule(result),
  ].filter((rule): rule is string => rule !== null)
}
