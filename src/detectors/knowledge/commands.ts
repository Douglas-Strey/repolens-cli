/**
 * Just enough shell parsing to tell which programs a package.json script
 * runs ("rimraf dist && tsc -p tsconfig.build.json" runs rimraf and tsc).
 * Nothing is ever executed.
 */
import { baseName } from '../../utils/paths.ts'

export interface Invocation {
  /** Program name without directories, e.g. "tsc" for "./node_modules/.bin/tsc". */
  bin: string
  args: string[]
}

/** Split a command into simple commands (on &&, ||, |, ;, &, newlines and parentheses) made of tokens. */
export function splitCommand(command: string): string[][] {
  const segments: string[][] = []
  let current: string[] = []
  let token = ''
  let inToken = false
  let quote: string | null = null

  const endToken = () => {
    if (inToken) current.push(token)
    token = ''
    inToken = false
  }
  const endSegment = () => {
    endToken()
    if (current.length > 0) segments.push(current)
    current = []
  }

  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string
    if (quote !== null) {
      if (ch === quote) quote = null
      else if (ch === '\\' && quote === '"' && i + 1 < command.length) token += command[++i]
      else token += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      inToken = true
    } else if (ch === '\\' && i + 1 < command.length) {
      token += command[++i]
      inToken = true
    } else if (ch === ' ' || ch === '\t' || ch === '\r') {
      endToken()
    } else if (ch === '&' || ch === '|' || ch === ';' || ch === '(' || ch === ')' || ch === '\n') {
      endSegment()
    } else {
      token += ch
      inToken = true
    }
  }
  endSegment()
  return segments
}

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** Programs that run the command that follows them (after their own flags). */
const WRAPPERS = new Set(['npx', 'pnpx', 'bunx', 'cross-env', 'cross-env-shell', 'env', 'c8', 'nyc', 'time', 'nohup'])

/** Package manager subcommands that run a package binary. */
const EXEC_SUBCOMMANDS = new Set(['exec', 'dlx', 'x'])

/** First real program of a simple command, skipping env assignments and runners like npx or cross-env. */
export function toInvocation(tokens: readonly string[]): Invocation | null {
  let i = 0
  while (i < tokens.length) {
    const token = tokens[i] as string
    if (ENV_ASSIGNMENT.test(token)) {
      i++
      continue
    }
    const name = baseName(token)
    if (name === 'dotenv' || name === 'dotenv-cli') {
      const separator = tokens.indexOf('--', i)
      if (separator === -1) return null
      i = separator + 1
      continue
    }
    if (WRAPPERS.has(name)) {
      i++
      while (tokens[i]?.startsWith('-')) i++
      continue
    }
    const next = tokens[i + 1]
    if (
      (name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun') &&
      next &&
      EXEC_SUBCOMMANDS.has(next)
    ) {
      i += 2
      while (tokens[i]?.startsWith('-')) i++
      continue
    }
    // `pnpm tsc` / `yarn tsc` run a package binary (when no script has that name).
    if ((name === 'pnpm' || name === 'yarn') && next && !next.startsWith('-') && next !== 'run') {
      i++
      continue
    }
    break
  }
  const bin = tokens[i]
  if (bin === undefined) return null
  return { bin: baseName(bin), args: tokens.slice(i + 1) }
}

/** Every program a script runs, in order. */
export function parseInvocations(command: string): Invocation[] {
  const out: Invocation[] = []
  for (const segment of splitCommand(command)) {
    const invocation = toInvocation(segment)
    if (invocation) out.push(invocation)
  }
  return out
}
