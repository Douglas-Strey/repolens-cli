/**
 * The project's Dockerfiles, found and parsed once for every detector that
 * needs them: the services section lists them, the runtimes section reads the
 * versions of their base images.
 *
 * Parsing is bounded and never leaks build secrets: ARG substitution shares
 * one character budget per file (a self-referencing `ARG A=$A$A` chain or
 * thousands of `FROM $LONG` lines can't exhaust memory), and ARGs with
 * secret-looking names are never substituted, so `ARG NPM_TOKEN=…` can't
 * surface through an image reference.
 */
import type { Analyzer } from '../types.ts'
import { compareText } from '../utils/compare.ts'
import { mapLimit } from '../utils/limit.ts'
import { isUnder, NON_PROJECT_ROLES } from '../utils/path-roles.ts'
import { baseName, depthOf } from '../utils/paths.ts'
import { isSensitiveName, REDACTED, redactCommand } from '../utils/redact.ts'
import { cleanUntrusted } from '../utils/text.ts'

/** Dockerfiles are looked for up to this many directories deep (services/api/docker/Dockerfile). */
export const MAX_DOCKERFILE_DEPTH = 4
/** Dockerfiles read per scan; the rest are left out (deterministically, by path). */
export const MAX_DOCKERFILES = 200
const READ_CONCURRENCY = 8

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** `dockerfile.go`, `Dockerfile.md`: source code and documentation about Dockerfiles, not Dockerfiles. */
const NOT_A_DOCKERFILE_SUFFIX = /\.(?:[cm]?[jt]sx?|go|py|rb|rs|java|kt|md|mdx|txt|json|ya?ml|toml|html?|snap)$/i

/**
 * Dockerfile, Containerfile, Dockerfile.dev, dockerfile.prod, api.Dockerfile,
 * web.containerfile (any case). Not `.dockerignore` files, and not code or
 * documentation that merely starts with "dockerfile." (dockerfile.go).
 */
export function isDockerfileName(name: string): boolean {
  if (/\.dockerignore$/i.test(name)) return false
  if (/\.(?:dockerfile|containerfile)$/i.test(name)) return true
  return /^(?:dockerfile|containerfile)(?:\..+)?$/i.test(name) && !NOT_A_DOCKERFILE_SUFFIX.test(name)
}

/** A Dockerfile that describes this project: not too deep, and not below test, fixture, example or template directories. */
export function isProjectDockerfile(file: string): boolean {
  return depthOf(file) <= MAX_DOCKERFILE_DEPTH && isDockerfileName(baseName(file)) && !isUnder(file, NON_PROJECT_ROLES)
}

/** Project Dockerfiles among indexed paths, sorted by path. */
export function findDockerfiles(files: readonly string[]): string[] {
  return files.filter(isProjectDockerfile).sort(compareText)
}

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

export interface DockerInstruction {
  /** Uppercased instruction, e.g. "FROM". */
  keyword: string
  /** Everything after the keyword, with line continuations joined. */
  args: string
}

const HEREDOC = /<<(-?)(["']?)([A-Za-z_][A-Za-z0-9_]*)\2/g

/**
 * Split a Dockerfile into instructions: honors the `# escape=` parser
 * directive, joins line continuations, drops comments and skips heredoc
 * bodies (so their contents are never mistaken for instructions).
 */
export function dockerInstructions(text: string): DockerInstruction[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  let escapeChar = '\\'
  for (const line of lines) {
    const directive = /^#\s*([A-Za-z]+)\s*=\s*(\S+)\s*$/.exec(line)
    if (!directive) break
    if (directive[1]?.toLowerCase() === 'escape' && (directive[2] === '`' || directive[2] === '\\')) {
      escapeChar = directive[2]
    }
  }

  const instructions: DockerInstruction[] = []
  // Pending heredoc terminators, consumed by index: Array#shift would make a flood of heredocs quadratic.
  const heredocs: string[] = []
  let nextHeredoc = 0
  let current = ''
  const flush = () => {
    const line = current.trim()
    current = ''
    if (line === '') return
    const space = line.search(/\s/)
    const keyword = (space === -1 ? line : line.slice(0, space)).toUpperCase()
    const args = space === -1 ? '' : line.slice(space + 1).trim()
    instructions.push({ keyword, args })
    if (keyword === 'RUN' || keyword === 'COPY' || keyword === 'ADD') {
      for (const match of args.matchAll(HEREDOC)) if (match[3]) heredocs.push(match[3])
    }
  }

  for (const rawLine of lines) {
    if (nextHeredoc < heredocs.length) {
      if (rawLine.trim() === heredocs[nextHeredoc]) nextHeredoc++
      continue
    }
    const line = rawLine.trim()
    // Docker skips comment lines everywhere and blank lines inside a continuation.
    if (line === '' || line.startsWith('#')) continue
    if (line.endsWith(escapeChar)) {
      current += `${line.slice(0, -1)} `
      continue
    }
    current += line
    flush()
  }
  flush()
  return instructions
}

/** Whitespace-separated words, keeping quoted sections together. */
function splitWords(text: string): string[] {
  return text.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
}

function unquote(value: string): string {
  return value.replace(/^(["'])(.*)\1$/, '$2')
}

/** `ARG A`, `ARG A=1`, `ARG A=1 B="two"` → [{ name, value? }]. */
function parseArgs(args: string): Array<{ name: string; value?: string }> {
  const out: Array<{ name: string; value?: string }> = []
  for (const word of splitWords(args)) {
    const eq = word.indexOf('=')
    const name = eq === -1 ? word : word.slice(0, eq)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue
    out.push(eq === -1 ? { name } : { name, value: unquote(word.slice(eq + 1)) })
  }
  return out
}

// ---------------------------------------------------------------------------
// Substitution
// ---------------------------------------------------------------------------

/**
 * Default number of characters substituteArgs may insert. Real image references
 * are short; the cap stops self-referencing chains (`ARG A=$A$A`, repeated)
 * from doubling a value until the string length limit throws.
 */
export const MAX_ARG_EXPANSION = 512
/**
 * Characters ARG substitution may insert across one whole file, so that
 * thousands of `FROM $LONG` lines cannot multiply it into megabytes of output.
 */
export const MAX_DOCKERFILE_EXPANSION = 4_096
/** Global ARG defaults remembered for FROM substitution. */
const MAX_GLOBAL_ARGS = 256

// `[^}$]` keeps the word from running past the next variable, so unterminated `${A:-` floods stay linear.
const ARG_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?([-+])([^}$]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g

/** Characters substitution may still insert; share one object across calls to bound them together. */
export interface ExpansionBudget {
  remaining: number
}

/**
 * Substitute variables (`$NAME`, `${NAME}`, `${NAME:-default}`,
 * `${NAME:+alt}`) using known values: Dockerfile ARG defaults, GitLab CI
 * variables. Unknown variables are kept as written; variables with
 * secret-looking names are never substituted. Once the budget is spent,
 * further references are kept as written.
 */
export function substituteArgs(
  value: string,
  args: Pick<ReadonlyMap<string, string>, 'get'>,
  budget: ExpansionBudget = { remaining: MAX_ARG_EXPANSION },
): string {
  return value.replace(
    ARG_REFERENCE,
    (
      match,
      braced: string | undefined,
      operator: string | undefined,
      word: string | undefined,
      bare: string | undefined,
    ) => {
      const name = (braced ?? bare) as string
      if (isSensitiveName(name)) return match
      const known = args.get(name)
      let replacement: string
      if (operator === '-') replacement = known !== undefined && known !== '' ? known : (word ?? '')
      else if (operator === '+') {
        if (known === undefined) return match
        replacement = known === '' ? '' : (word ?? '')
      } else if (known === undefined) return match
      else replacement = known
      if (replacement.length > budget.remaining) return match
      budget.remaining -= replacement.length
      return replacement
    },
  )
}

/** `${NAME:-default}`, `${NAME-default}`, `${NAME:+alt}`, `${NAME:?message}`. */
const INTERPOLATION_WITH_WORD = /\$\{([A-Za-z_][A-Za-z0-9_]*)(:?[-+?])([^}$]*)\}/g

/**
 * Hide the fallback written after a secret-looking variable (`${DB_PASSWORD:-hunter2}` →
 * `${DB_PASSWORD:-***}`). Purely numeric fallbacks are kept: they are ports, not secrets.
 */
export function redactInterpolation(text: string): string {
  return text.replace(INTERPOLATION_WITH_WORD, (match, name: string, operator: string, word: string) =>
    word === '' || /^\d+(?:-\d+)?$/.test(word) || !isSensitiveName(name) ? match : `$\{${name}${operator}${REDACTED}}`,
  )
}

/**
 * Committed text echoed in the output (images, ports, paths): control and
 * invisible characters are removed, interpolation fallbacks and credential
 * formats redacted.
 */
export function cleanEchoedText(value: string): string {
  return redactCommand(redactInterpolation(cleanUntrusted(value, { oneLine: true })))
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface DockerStage {
  /**
   * Base image with global ARG defaults substituted and secrets redacted, or
   * the name of the earlier stage this one builds on.
   */
  image: string
  /** Stage name from "AS <name>". */
  name?: string
  /** `image` names an earlier stage of the same file, not an image. */
  fromStage: boolean
}

export interface ParsedDockerfile {
  /** One entry per FROM instruction, in order. */
  stages: DockerStage[]
  /** EXPOSE values as written (credential formats redacted), without duplicates. */
  exposes: string[]
  /** ARG names only (never values), sorted. */
  args: string[]
}

/** Extract stages, exposed ports and ARG names from Dockerfile text. */
export function parseDockerfile(text: string): ParsedDockerfile {
  const globalArgs = new Map<string, string>()
  const argNames = new Set<string>()
  const stages: DockerStage[] = []
  const stageNames = new Set<string>()
  const exposes = new Set<string>()
  const budget: ExpansionBudget = { remaining: MAX_DOCKERFILE_EXPANSION }
  let seenFrom = false

  for (const { keyword, args } of dockerInstructions(text)) {
    if (keyword === 'ARG') {
      for (const arg of parseArgs(args)) {
        argNames.add(arg.name)
        // Only ARGs declared before the first FROM are visible to FROM lines.
        if (!seenFrom && arg.value !== undefined && (globalArgs.has(arg.name) || globalArgs.size < MAX_GLOBAL_ARGS)) {
          globalArgs.set(arg.name, substituteArgs(arg.value, globalArgs, budget))
        }
      }
    } else if (keyword === 'FROM') {
      const words = splitWords(args).filter((word) => !word.startsWith('--'))
      const raw = words[0]
      if (!raw) continue
      seenFrom = true
      const image = cleanEchoedText(substituteArgs(unquote(raw), globalArgs, budget))
      const stage: DockerStage = { image, fromStage: stageNames.has(image.toLowerCase()) }
      const name = words[1]?.toLowerCase() === 'as' ? words[2] : undefined
      if (name) {
        stage.name = cleanEchoedText(name)
        stageNames.add(name.toLowerCase())
      }
      stages.push(stage)
    } else if (keyword === 'EXPOSE') {
      for (const word of splitWords(args)) exposes.add(cleanEchoedText(unquote(word)))
    }
  }

  return { stages, exposes: [...exposes], args: [...argNames].sort(compareText) }
}

// ---------------------------------------------------------------------------
// Fact
// ---------------------------------------------------------------------------

export interface DockerfileInfo extends ParsedDockerfile {
  path: string
}

export interface Dockerfiles {
  /** Parsed project Dockerfiles, sorted by path. Unreadable files are left out. */
  files: DockerfileInfo[]
  /** More than MAX_DOCKERFILES were found; the list holds the first ones by path. */
  truncated: boolean
}

export const dockerfiles: Analyzer<Dockerfiles> = {
  id: 'dockerfiles',
  async run(ctx) {
    let paths = findDockerfiles(ctx.files.files)
    const truncated = paths.length > MAX_DOCKERFILES
    if (truncated) {
      ctx.debug(`dockerfiles: limited to ${MAX_DOCKERFILES} of ${paths.length} Dockerfiles`)
      paths = paths.slice(0, MAX_DOCKERFILES)
    }
    const parsed = await mapLimit(paths, READ_CONCURRENCY, async (path): Promise<DockerfileInfo | null> => {
      // Not cached: nothing else reads Dockerfiles, and there can be many large ones.
      const text = await ctx.readText(path, { cache: false })
      return text === null ? null : { path, ...parseDockerfile(text) }
    })
    return { files: parsed.filter((file): file is DockerfileInfo => file !== null), truncated }
  },
}
