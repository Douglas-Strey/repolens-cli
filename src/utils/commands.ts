import type { PackageManagerId } from '../types.ts'
import { cleanUntrusted } from './text.ts'

/**
 * Quote a value for a POSIX shell only when needed, so common names stay
 * readable. Values come from untrusted repositories: a file named
 * `x; curl … | sh` must never turn a suggested command into a different one.
 */
export function shellQuote(value: string): string {
  const cleaned = cleanUntrusted(value, { oneLine: true })
  // A leading dash would be read as an option by the command it is passed to.
  const arg = cleaned.startsWith('-') ? `./${cleaned}` : cleaned
  if (/^[A-Za-z0-9@%+=:,./_-]+$/.test(arg)) return arg
  return `'${arg.replaceAll("'", `'\\''`)}'`
}

/** Scripts npm can run without `run`. */
const NPM_SHORTCUTS = new Set(['test', 'start', 'stop', 'restart'])

/** Command a developer types to run a package.json script with the given package manager. */
export function runScriptCommand(manager: PackageManagerId | null | undefined, script: string): string {
  switch (manager) {
    case 'pnpm':
      return `pnpm ${script}`
    case 'yarn':
      return `yarn ${script}`
    case 'bun':
      return `bun run ${script}`
    default:
      return NPM_SHORTCUTS.has(script) ? `npm ${script}` : `npm run ${script}`
  }
}

/** Prefix used for running scripts ("pnpm", "npm run", …). */
export function scriptRunner(manager: PackageManagerId | null | undefined): string {
  switch (manager) {
    case 'pnpm':
      return 'pnpm'
    case 'yarn':
      return 'yarn'
    case 'bun':
      return 'bun run'
    default:
      return 'npm run'
  }
}

/** Command that installs dependencies. */
export function installCommand(manager: PackageManagerId | null | undefined): string {
  switch (manager) {
    case 'pnpm':
      return 'pnpm install'
    case 'yarn':
      return 'yarn install'
    case 'bun':
      return 'bun install'
    case 'go':
      return 'go mod download'
    default:
      return 'npm install'
  }
}
