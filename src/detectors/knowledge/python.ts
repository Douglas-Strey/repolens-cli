/**
 * Python dependency declarations (requirements*.txt, pyproject.toml, Pipfile)
 * in the root and package directories, for detecting pytest, Ruff, mypy, …
 * Only package names and plain version specifiers are kept; option lines
 * (-r, --index-url, …) and URLs are skipped because they can carry credentials.
 */
import type { Analyzer } from '../../types.ts'
import { locateFiles, projectLayout } from './layout.ts'

export interface PythonRequirement {
  /** Normalized name (PEP 503): lowercase, runs of "-", "_", "." become "-". */
  name: string
  /** Version specifier such as "==8.4.2" or ">=8,<9", when plain. */
  spec?: string
}

export interface PythonRequirementRef extends PythonRequirement {
  file: string
  package: string
}

export interface PyprojectInfo {
  file: string
  package: string
  /** Table headers, e.g. ["project", "tool.pytest.ini_options", "tool.ruff"]. */
  tables: string[]
}

export interface PythonFacts {
  requirements: PythonRequirementRef[]
  pyprojects: PyprojectInfo[]
}

export const PYTHON_MANIFEST_PATTERNS: readonly string[] = [
  'requirements*.txt',
  'requirements/*.txt',
  'pyproject.toml',
  'Pipfile',
]

export function normalizePythonName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-')
}

const REQUIREMENT =
  /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(?:\[[^\]]*\])?\s*((?:(?:===|==|!=|<=|>=|~=|<|>)\s*[A-Za-z0-9.*+!_-]+\s*,?\s*)+)?/

/** Parse one PEP 508 requirement string ("pytest>=8,<9; python_version>'3.9'"). */
export function parseRequirement(text: string): PythonRequirement | null {
  const match = REQUIREMENT.exec(text.trim())
  if (!match?.[1]) return null
  const requirement: PythonRequirement = { name: normalizePythonName(match[1]) }
  const spec = match[2]?.replace(/\s+/g, '').replace(/,$/, '')
  if (spec) requirement.spec = spec
  return requirement
}

export function parseRequirementsTxt(text: string): PythonRequirement[] {
  const out: PythonRequirement[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/(?:^|\s)#.*$/, '').trim()
    if (line === '' || line.startsWith('-')) continue
    const requirement = parseRequirement(line)
    if (requirement) out.push(requirement)
  }
  return out
}

/** Quoted strings on a TOML line, and whether an array closes on it (a "]" outside strings). */
function scanTomlLine(line: string): { strings: string[]; closes: boolean } {
  const strings: string[] = []
  let closes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '#') break
    if (ch === ']') closes = true
    if (ch !== '"' && ch !== "'") continue
    let j = i + 1
    let value = ''
    while (j < line.length && line[j] !== ch) {
      if (line[j] === '\\' && ch === '"') j++
      value += line[j] ?? ''
      j++
    }
    strings.push(value)
    i = j
  }
  return { strings, closes }
}

function unquoteKey(key: string): string {
  return key.trim().replace(/^["']|["']$/g, '')
}

function isRequirementArray(table: string, key: string): boolean {
  return (
    (table === 'project' && key === 'dependencies') ||
    table === 'project.optional-dependencies' ||
    table === 'dependency-groups' ||
    table === 'tool.pdm.dev-dependencies' ||
    (table === 'tool.uv' && key === 'dev-dependencies')
  )
}

const POETRY_DEPENDENCY_TABLE = /^tool\.poetry(?:\.group\.[^.]+)?\.(?:dev-)?dependencies$/
const PIPFILE_TABLES = new Set(['packages', 'dev-packages'])

/** Poetry/Pipfile values: "^8.0", { version = ">=8" }, "*". */
function specFromValue(value: string): string | undefined {
  const { strings } = scanTomlLine(value)
  const raw = value.trim().startsWith('{') ? /version\s*=\s*["']([^"']*)["']/.exec(value)?.[1] : strings[0]
  if (!raw || raw === '*' || !/^[\w.*+!,<>=~^ -]+$/.test(raw)) return undefined
  return raw.replace(/\s+/g, '')
}

// Every quantifier is followed by a character it cannot match, so matching
// stays linear on hostile input (a lazy name between two `\s*` was cubic).
const TABLE_HEADER = /^\[\[?([^\]]*)\]\]?[ \t]*(?:#.*)?$/

/** Table name of a trimmed `[table]` / `[[array.of.tables]]` line, or null. */
export function tableHeader(line: string): string | null {
  const match = TABLE_HEADER.exec(line)
  // `["a", "b"]` is an element of a multi-line array, not a header.
  if (!match?.[1] || match[1].includes(',')) return null
  const name = match[1]
    .split('.')
    .map((part) => part.trim().replace(/["']/g, ''))
    .join('.')
  return name === '' ? null : name
}

/**
 * Minimal TOML reader for pyproject.toml and Pipfile: table headers and
 * dependency declarations. It is line based, which is enough for the ways
 * these files are written in practice.
 */
export function parsePythonToml(text: string): { tables: string[]; requirements: PythonRequirement[] } {
  const tables: string[] = []
  const requirements: PythonRequirement[] = []
  let table = ''
  let inArray = false

  const addStrings = (strings: string[]) => {
    for (const value of strings) {
      const requirement = parseRequirement(value)
      if (requirement) requirements.push(requirement)
    }
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    if (inArray) {
      const { strings, closes } = scanTomlLine(line)
      addStrings(strings)
      if (closes) inArray = false
      continue
    }
    const name = tableHeader(line)
    if (name !== null) {
      table = name
      tables.push(table)
      continue
    }
    const pair = /^([A-Za-z0-9_."'-]+)\s*=\s*(.*)$/.exec(line)
    if (!pair?.[1] || pair[2] === undefined) continue
    const key = unquoteKey(pair[1])
    const value = pair[2]
    if (isRequirementArray(table, key)) {
      if (!value.trimStart().startsWith('[')) continue
      const { strings, closes } = scanTomlLine(value)
      addStrings(strings)
      inArray = !closes
    } else if (POETRY_DEPENDENCY_TABLE.test(table) || PIPFILE_TABLES.has(table)) {
      if (key === 'python') continue
      const requirement: PythonRequirement = { name: normalizePythonName(key) }
      const spec = specFromValue(value)
      if (spec) requirement.spec = spec
      requirements.push(requirement)
    }
  }
  return { tables, requirements }
}

/** True when `tables` contains `prefix` or a subtable of it ("tool.ruff" matches "tool.ruff.lint"). */
export function hasTable(tables: readonly string[], prefix: string): boolean {
  return tables.some((table) => table === prefix || table.startsWith(`${prefix}.`))
}

export const pythonFacts: Analyzer<PythonFacts> = {
  id: 'knowledge:python-facts',
  async run(ctx) {
    const layout = await ctx.use(projectLayout)
    const requirements: PythonRequirementRef[] = []
    const pyprojects: PyprojectInfo[] = []
    for (const located of locateFiles(layout, PYTHON_MANIFEST_PATTERNS)) {
      const text = await ctx.readText(located.path)
      if (text === null) continue
      const at = { file: located.path, package: located.package }
      if (located.path.endsWith('.txt')) {
        for (const requirement of parseRequirementsTxt(text)) requirements.push({ ...requirement, ...at })
        continue
      }
      const parsed = parsePythonToml(text)
      for (const requirement of parsed.requirements) requirements.push({ ...requirement, ...at })
      if (located.rel.endsWith('pyproject.toml')) pyprojects.push({ ...at, tables: parsed.tables })
    }
    return { requirements, pyprojects }
  },
}
