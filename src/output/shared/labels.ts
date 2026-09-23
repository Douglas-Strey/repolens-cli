/**
 * Display names shared by every renderer, so the terminal, the Markdown
 * report and the agent files use one vocabulary.
 */
import type { Database, DiagnosticCategory, Framework, ProjectType, Severity, Tool, ToolKind } from '../../types.ts'

/** Section, row and column names that appear in more than one output. */
export const TERMS = {
  entryPoints: 'Entry points',
  runtimes: 'Runtimes',
  runtime: 'Runtime',
  issues: 'Potential issues',
  scripts: 'Scripts',
  tooling: 'Tooling',
  configFiles: 'Configuration files',
  quickStart: 'Quick start',
  /** Environment table columns: set in an env file with values, documented in an example, referenced in code. */
  local: 'local',
  example: 'example',
  code: 'code',
} as const

const PROJECT_TYPE_LABEL: Record<ProjectType, string | null> = {
  monorepo: 'Monorepo',
  application: 'Application',
  library: 'Library',
  cli: 'CLI tool',
  unknown: null,
}

export function projectTypeLabel(type: ProjectType): string | null {
  return PROJECT_TYPE_LABEL[type] ?? null
}

const FRAMEWORK_CATEGORY_LABEL: Record<Framework['category'], string> = {
  frontend: 'frontend',
  backend: 'backend',
  fullstack: 'full-stack',
  mobile: 'mobile',
  desktop: 'desktop',
  'static-site': 'static site',
  library: 'library',
}

export function frameworkCategory(framework: Framework): string {
  return FRAMEWORK_CATEGORY_LABEL[framework.category] ?? framework.category
}

const TOOL_KIND_LABEL: Record<ToolKind, string> = {
  build: 'build',
  bundler: 'bundler',
  compiler: 'compiler',
  'task-runner': 'task runner',
  test: 'tests',
  e2e: 'end-to-end tests',
  linter: 'linter',
  formatter: 'formatter',
  typechecker: 'type checker',
  'git-hooks': 'Git hooks',
  orm: 'ORM',
  other: 'other',
}

export function toolKindLabel(tool: Tool): string {
  return TOOL_KIND_LABEL[tool.kind] ?? tool.kind
}

/** Package directory for display ("." is the repository root). */
export function packageLabel(path: string): string {
  return path === '.' || path === '' ? 'root' : path
}

/** Doctor categories in display order. Security comes first: its errors are the ones that must not scroll by. */
export const DOCTOR_CATEGORIES: readonly DiagnosticCategory[] = [
  'security',
  'runtime',
  'package-manager',
  'environment',
  'docker',
  'workspace',
  'scripts',
  'git',
  'tooling',
  'configuration',
]

const CATEGORY_TITLE: Record<DiagnosticCategory, string> = {
  runtime: 'Runtime',
  'package-manager': 'Package manager',
  environment: 'Environment',
  security: 'Security',
  docker: 'Docker',
  workspace: 'Workspace',
  scripts: 'Scripts',
  git: 'Git',
  tooling: 'Tooling',
  configuration: 'Configuration',
}

export function categoryTitle(category: string): string {
  const known = CATEGORY_TITLE[category as DiagnosticCategory]
  if (known) return known
  const words = category.replace(/[-_]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export const SEVERITY_TITLE: Record<Severity, string> = { error: 'Errors', warning: 'Warnings', info: 'Info' }

const DATABASE_SOURCE_ORDER: ReadonlyArray<Database['sources'][number]> = ['docker', 'dependency', 'config', 'env']
const DATABASE_SOURCE_LABEL: Record<Database['sources'][number], string> = {
  docker: 'Docker',
  dependency: 'dependency',
  config: 'config',
  env: 'env',
}

/** ["Docker", "config", "env"] */
export function databaseSources(database: Database): string[] {
  return DATABASE_SOURCE_ORDER.filter((source) => database.sources.includes(source)).map(
    (source) => DATABASE_SOURCE_LABEL[source],
  )
}
