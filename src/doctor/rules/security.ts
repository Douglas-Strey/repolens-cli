import { envTextHasCredential } from '../../core/dotenv.ts'
import { isPublicName, PUBLIC_PREFIXES } from '../../detectors/environment.ts'
import { gitLayout } from '../../facts/git.ts'
import type {
  Diagnostic,
  DoctorRule,
  EnvFile,
  EnvironmentSection,
  EnvVariable,
  ProjectContext,
  Severity,
} from '../../types.ts'
import { shellQuote } from '../../utils/commands.ts'
import { baseName } from '../../utils/paths.ts'
import { isUnreadable } from './environment.ts'
import { formatList, unique, uniqueSorted } from './shared.ts'

/** Client-exposure prefixes, longest first, so NEXT_PUBLIC_ wins over PUBLIC_. */
const PREFIXES_LONGEST_FIRST = [...PUBLIC_PREFIXES].sort((a, b) => b.length - a.length)

/**
 * Names that say "secret" outright. Tokens and keys alone are not enough:
 * map, analytics and backend-as-a-service clients ship tokens that are public
 * by design (NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN, …_PUBLISHABLE_KEY, …_ANON_KEY,
 * CESIUM_ION_TOKEN).
 */
const SECRET_NAME = /(?:^|_)(?:SECRETS?|SECRETKEY|CLIENTSECRET|PASSWORD|PASSWD|PRIVATE_?KEY|SERVICE_?ROLE)(?:_|$)/

/** Name of a browser-exposed variable that suggests it holds a secret. */
export function looksLikePublicSecret(name: string): boolean {
  return SECRET_NAME.test(name.toUpperCase())
}

/** The variable name without its client-exposure prefix, e.g. NEXT_PUBLIC_X_SECRET → X_SECRET. */
export function withoutPublicPrefix(name: string): string | null {
  const prefix = PREFIXES_LONGEST_FIRST.find((p) => name.startsWith(p) && name.length > p.length)
  return prefix ? name.slice(prefix.length) : null
}

export function findPublicSecrets(env: EnvironmentSection): Diagnostic[] {
  const out: Diagnostic[] = []
  for (const variable of env.variables) {
    if (!variable.public || !looksLikePublicSecret(variable.name)) continue
    const serverName = withoutPublicPrefix(variable.name)
    out.push({
      code: 'ENV_PUBLIC_SECRET',
      severity: 'warning',
      category: 'security',
      message: `${variable.name} is exposed to the browser bundle but looks like a secret`,
      hint: `${serverName ? `Rename it to ${serverName}` : 'Drop the public prefix'} and read it only in server code; rotate the value if it has ever been deployed`,
      files: unique([...variable.usedIn, ...variable.definedIn, ...variable.documentedIn]),
      subject: variable.name,
    })
  }
  return out
}

export function findRealSecretsInExamples(env: EnvironmentSection): Diagnostic[] {
  const out: Diagnostic[] = []
  for (const variable of env.variables) {
    const files = uniqueSorted(variable.suspiciousValueIn)
    if (files.length === 0) continue
    out.push({
      code: 'ENV_EXAMPLE_REAL_SECRET',
      severity: 'error',
      category: 'security',
      message: `${formatList(files)} ${files.length === 1 ? 'contains' : 'contain'} what looks like a real credential in ${variable.name}`,
      hint: `Rotate the credential now, then replace the value with an empty placeholder (${variable.name}=)`,
      files,
      subject: variable.name,
    })
  }
  return out
}

function isEnvrc(path: string): boolean {
  return baseName(path) === '.envrc'
}

/** Env files that set values (local, mode and service files; not examples or unknown files). */
function setsValues(file: EnvFile): boolean {
  return file.kind === 'local' || file.kind === 'mode' || file.kind === 'service'
}

/**
 * Env files of no known purpose (.env.backup, .env.old, secrets.env). They
 * are only reported when they hold a credential-shaped value. The encrypted
 * .env.vault is meant to be committed.
 */
function isUnknownEnvFile(file: EnvFile): boolean {
  return file.kind === 'other' && baseName(file.path) !== '.env.vault'
}

/** Env files the Git checks look at: those that set values, and unknown ones that may. */
function mayHoldValues(file: EnvFile): boolean {
  return setsValues(file) || isUnknownEnvFile(file)
}

/** Every variable the file defines is exposed to the browser anyway (VITE_API_URL, NEXT_PUBLIC_SITE_URL). */
export function definesOnlyPublic(path: string, variables: readonly EnvVariable[]): boolean {
  return variables.every((v) => !v.definedIn.includes(path) || isPublicName(v.name))
}

/** Tells whether an env file holds a value in a well-known credential format. */
export type CredentialCheck = (path: string) => boolean

/**
 * Committed env files. A local file (.env, .env.local, .env.*.local) is an
 * error: it holds one machine's values. Mode and service files
 * (.env.production, .env.test, a Compose service's .env.db) and .envrc are
 * often committed on purpose with non-secret defaults: an error only when a
 * value matches a known credential format, nothing when a mode file only
 * sets browser-public variables, a warning otherwise.
 */
export function findTrackedEnvFiles(
  env: EnvironmentSection,
  hasCredential: CredentialCheck = () => false,
): Diagnostic[] {
  const out: Diagnostic[] = []
  for (const file of env.files) {
    if (file.tracked !== true || !mayHoldValues(file)) continue
    const path = file.path
    const envrc = isEnvrc(path)
    // An .envrc without variables only holds direnv directives (use flake, layout node).
    if (envrc && file.variables === 0) continue
    const untrack = `\`git rm --cached ${shellQuote(path)}\``
    const credential = hasCredential(path)
    let severity: Severity
    let hint: string
    if (file.kind === 'local' && !envrc) {
      severity = 'error'
      hint = `Run ${untrack}, add ${path} to .gitignore and rotate any secrets it contained`
    } else if (credential) {
      severity = 'error'
      hint =
        file.kind === 'mode'
          ? `Rotate the credential, move secrets to ${path}.local (not committed) and keep only non-secret defaults in ${path}`
          : `Rotate the credential, then run ${untrack} and add ${path} to .gitignore`
    } else if (
      file.kind === 'other' ||
      file.variables === 0 ||
      (file.kind === 'mode' && definesOnlyPublic(path, env.variables))
    ) {
      continue
    } else {
      severity = 'warning'
      hint = envrc
        ? `Make sure ${path} holds no secrets, or run ${untrack} and add it to .gitignore`
        : file.kind === 'mode'
          ? `Keep only non-secret defaults in ${path} and put secrets in ${path}.local, or run ${untrack}`
          : `Keep only non-secret defaults in ${path}, or run ${untrack} and add it to .gitignore`
    }
    out.push({
      code: 'TRACKED_ENV_FILE',
      severity,
      category: 'security',
      message: credential
        ? `${path} is tracked by Git and contains what looks like a real credential`
        : `${path} is tracked by Git`,
      hint,
      files: [path],
      subject: path,
    })
  }
  return out
}

/**
 * Env files Git would pick up with the next `git add .`: every local file
 * (.envrc aside, a script often committed on purpose), and mode or service
 * files holding a credential-shaped value.
 */
export function findUnignoredEnvFiles(
  env: EnvironmentSection,
  hasCredential: CredentialCheck = () => false,
): Diagnostic[] {
  const out: Diagnostic[] = []
  for (const file of env.files) {
    if (!mayHoldValues(file) || isEnvrc(file.path) || file.tracked === true || file.ignored !== false) continue
    if (file.kind !== 'local' && !hasCredential(file.path)) continue
    out.push({
      code: 'ENV_FILE_NOT_IGNORED',
      severity: 'warning',
      category: 'security',
      message: `${file.path} is not ignored by Git and could be committed by accident`,
      hint: `Add ${baseName(file.path)} to .gitignore (or .env* together with !.env.example)`,
      files: [file.path],
      subject: file.path,
    })
  }
  return out
}

/**
 * Credential check for committed mode and service files. Reads each file
 * through the dotenv parser, which only answers yes or no: values never
 * leave it, and local files (always reported) are never read here.
 */
async function credentialCheck(ctx: ProjectContext, files: readonly EnvFile[]): Promise<CredentialCheck> {
  const found = new Set<string>()
  for (const file of files) {
    if (file.kind !== 'mode' && file.kind !== 'service' && !isEnvrc(file.path) && !isUnknownEnvFile(file)) continue
    // Not cached: the raw text holds secrets.
    const text = await ctx.readText(file.path, { cache: false })
    if (text !== null && envTextHasCredential(text)) found.add(file.path)
  }
  return (path) => found.has(path)
}

export const envPublicSecret: DoctorRule = {
  code: 'ENV_PUBLIC_SECRET',
  category: 'security',
  title: 'No secret is exposed to the browser',
  applies: (scan) => scan.environment.variables.some((v) => v.public),
  check: (scan) => findPublicSecrets(scan.environment),
}

export const envExampleRealSecret: DoctorRule = {
  code: 'ENV_EXAMPLE_REAL_SECRET',
  category: 'security',
  title: 'Example env files contain no real credentials',
  applies: (scan, ctx) =>
    scan.environment.files.some((file) => file.kind === 'example' && !isUnreadable(ctx, file.path)),
  check: (scan) => findRealSecretsInExamples(scan.environment),
}

export const trackedEnvFile: DoctorRule = {
  code: 'TRACKED_ENV_FILE',
  category: 'security',
  title: 'Local env files are not committed',
  applies: (scan) => scan.git !== null && scan.environment.files.some(mayHoldValues),
  async check(scan, ctx) {
    const tracked = scan.environment.files.filter((file) => file.tracked === true)
    return findTrackedEnvFiles(scan.environment, await credentialCheck(ctx, tracked))
  },
}

export const envFileNotIgnored: DoctorRule = {
  code: 'ENV_FILE_NOT_IGNORED',
  category: 'security',
  title: 'Local env files are ignored by Git',
  // When scanning a subdirectory, .gitignore files above it were not loaded, so "not ignored" is unreliable.
  applies: async (scan, ctx) =>
    scan.git !== null && scan.environment.files.some(mayHoldValues) && (await ctx.use(gitLayout))?.prefix === '',
  async check(scan, ctx) {
    if ((await ctx.use(gitLayout))?.prefix !== '') return []
    const exposed = scan.environment.files.filter((file) => file.ignored === false && file.tracked !== true)
    return findUnignoredEnvFiles(scan.environment, await credentialCheck(ctx, exposed))
  },
}

export const securityRules: DoctorRule[] = [envExampleRealSecret, trackedEnvFile, envFileNotIgnored, envPublicSecret]
