/**
 * The tools `repolens mcp` serves: one per part of the scan an assistant
 * asks about. Each one scans fresh, so answers follow edits, and returns the
 * matching part of the Markdown report (or of the JSON output, on request).
 * The same rules as every other output apply: variable names only, never
 * values, and no absolute paths.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { filterByConfidence } from '../core/confidence.ts'
import { RepoLensError } from '../core/errors.ts'
import { type ReportSection, renderMarkdown } from '../output/markdown.ts'
import type { ScanOptions, ScanResult } from '../types.ts'
import { isWithin, normalizeRelative, toPosix } from '../utils/paths.ts'
import { cleanUntrusted } from '../utils/text.ts'
import type { ToolDefinition, ToolResult } from './protocol.ts'

interface RepoLensTool {
  definition: ToolDefinition
  /** Report sections of the Markdown answer. */
  sections: readonly ReportSection[]
  /** List each diagnostic's files too. */
  verbose?: boolean
  /** The JSON answer: the matching part of `repolens --json`. */
  json: (result: ScanResult) => Record<string, unknown>
}

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description:
        'Directory to analyze, relative to the project the server was started in (for example a workspace package such as "apps/web"). Defaults to the project itself.',
    },
    format: {
      type: 'string',
      enum: ['markdown', 'json'],
      description:
        'markdown (default) is compact and readable; json is the matching part of `repolens --json`, with every field.',
    },
  },
  additionalProperties: false,
} as const

/** Every tool only reads files; answers depend on nothing but the repository. */
const ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }

function tool(name: string, title: string, description: string, rest: Omit<RepoLensTool, 'definition'>): RepoLensTool {
  return { definition: { name, title, description, inputSchema: INPUT_SCHEMA, annotations: ANNOTATIONS }, ...rest }
}

export const REPOLENS_TOOLS: readonly RepoLensTool[] = [
  tool(
    'get_project_overview',
    'Project overview',
    'What the project is: type, languages, runtimes, package manager, frameworks, workspace packages, entry points, how to start it, CI, tooling and Git. Call this first in an unfamiliar repository.',
    {
      sections: [
        'overview',
        'quickStart',
        'architecture',
        'languages',
        'frameworks',
        'ci',
        'tooling',
        'git',
        'scanNotes',
      ],
      json: (r) => ({
        project: r.project,
        languages: r.languages,
        runtimes: r.runtimes,
        packageManagers: r.packageManagers,
        workspace: r.workspace,
        frameworks: r.frameworks,
        build: r.build,
        testing: r.testing,
        linting: r.linting,
        ci: r.ci,
        git: r.git,
      }),
    },
  ),
  tool(
    'get_services',
    'Services and databases',
    'Docker Compose services (image, ports, dependencies, env files), Dockerfiles, databases and ORMs, and the command that starts the backing services.',
    { sections: ['services', 'databases'], json: (r) => ({ services: r.services, databases: r.databases }) },
  ),
  tool(
    'get_environment_variables',
    'Environment variables',
    'Environment variable names the code reads, where each is documented (.env.example) or set, and which are secret or exposed to the browser. Values are never included.',
    { sections: ['environment'], json: (r) => ({ environment: r.environment }) },
  ),
  tool(
    'get_routes',
    'Routes',
    'HTTP API routes and pages, with method, path, framework and the file that defines them.',
    { sections: ['routes'], json: (r) => ({ routes: r.routes }) },
  ),
  tool(
    'get_scripts',
    'Scripts and commands',
    'How to install, run, test and build: package.json scripts, Makefile and justfile targets, and the suggested quick start.',
    { sections: ['quickStart', 'scripts'], json: (r) => ({ scripts: r.scripts }) },
  ),
  tool(
    'get_diagnostics',
    'Diagnostics',
    'Problems `repolens doctor` finds (undocumented env vars, committed secrets, port clashes, version mismatches, …), each with a stable code, the files involved and a suggested fix.',
    {
      sections: ['issues', 'scanNotes'],
      verbose: true,
      json: (r) => ({
        checks: r.doctor.checks,
        diagnostics: r.doctor.diagnostics,
        ...(r.doctor.ignored ? { ignored: r.doctor.ignored } : {}),
        summary: r.doctor.summary,
      }),
    },
  ),
]

export const SERVER_INSTRUCTIONS =
  'RepoLens describes the repository this server was started in by reading its files: it never runs project code, and reports environment variables by name only. Start with get_project_overview, then ask for services, environment variables, routes, scripts or diagnostics. Each call scans the files as they are now. Pass `path` to look at a subdirectory such as one workspace package.'

export interface ToolContext {
  /** Real absolute path of the project the server was started in. */
  root: string
  /** Scan options for a directory inside the root (configuration files, limits, ignore files). */
  scanOptions: (dir: string) => Promise<ScanOptions>
  scan: (options: ScanOptions) => Promise<ScanResult>
}

function invalid(message: string): ToolResult {
  return { text: message, isError: true }
}

/** The directory `path` names inside the root, or an error for the model to correct. */
async function resolveDirectory(root: string, value: unknown): Promise<string | ToolResult> {
  if (value === undefined) return root
  if (typeof value !== 'string') return invalid('`path` must be a string.')
  const relative = normalizeRelative(value)
  if (relative === null) {
    return invalid('`path` must be a directory inside the project, relative to it (for example "apps/web").')
  }
  let real: string
  try {
    real = await fs.realpath(path.join(root, relative))
  } catch {
    return invalid(`${cleanUntrusted(toPosix(relative), { oneLine: true })} does not exist in the project.`)
  }
  // A link inside the project must not lead the scan out of it.
  if (!isWithin(root, real)) return invalid('`path` must be a directory inside the project.')
  return real
}

/** Run one RepoLens tool. Arguments are checked here: the model gets the problem back and can retry. */
export async function callRepoLensTool(
  name: string,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  const found = REPOLENS_TOOLS.find((candidate) => candidate.definition.name === name)
  if (!found) return invalid(`Unknown tool ${name}.`)
  const unknown = Object.keys(args).filter((key) => key !== 'path' && key !== 'format')
  if (unknown.length > 0) {
    return invalid(`Unknown argument ${cleanUntrusted(unknown[0] ?? '', { oneLine: true })}: use path and format.`)
  }
  const format = args.format ?? 'markdown'
  if (format !== 'markdown' && format !== 'json') return invalid('`format` must be "markdown" or "json".')
  const dir = await resolveDirectory(context.root, args.path)
  if (typeof dir !== 'string') return dir

  let result: ScanResult
  try {
    result = filterByConfidence(await context.scan(await context.scanOptions(dir)), 'medium')
  } catch (error) {
    if (error instanceof RepoLensError) return invalid(cleanUntrusted(error.message))
    throw error
  }
  if (format === 'json') {
    return { text: JSON.stringify({ schemaVersion: result.schemaVersion, ...found.json(result) }, null, 2) }
  }
  return { text: renderMarkdown(result, { sections: found.sections, verbose: found.verbose === true }).trimEnd() }
}
