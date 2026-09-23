/**
 * Builders shared by the doctor rule tests. Sections are built by hand
 * (test/factories.ts) so rules are tested independently of the detectors.
 */
import { expect } from 'vitest'
import type { Context } from '../../src/core/context.ts'
import { runDoctor } from '../../src/doctor/index.ts'
import type {
  Diagnostic,
  DoctorResult,
  DoctorRule,
  EnvFile,
  EnvFileKind,
  EnvironmentSection,
  EnvVariable,
  PortMapping,
  ProjectContext,
  Runtime,
  ScanOptions,
  Sections,
  Service,
  VersionSource,
} from '../../src/types.ts'
import { makeSections } from '../factories.ts'
import { contextFor, makeProject, SECRET_SENTINEL } from '../helpers.ts'

export { makeSections, SECRET_SENTINEL }

export function envVar(name: string, overrides: Partial<EnvVariable> = {}): EnvVariable {
  return {
    name,
    defined: false,
    documented: false,
    used: false,
    definedIn: [],
    documentedIn: [],
    usedIn: [],
    fallback: false,
    testOnly: false,
    public: false,
    sensitive: false,
    endpoints: [],
    suspiciousValueIn: [],
    ...overrides,
  }
}

export function envFile(path: string, kind: EnvFileKind, overrides: Partial<EnvFile> = {}): EnvFile {
  return { path, kind, variables: 1, ignored: null, tracked: null, ...overrides }
}

export function environment(
  files: EnvFile[],
  variables: EnvVariable[],
  overrides: Partial<EnvironmentSection> = {},
): EnvironmentSection {
  return { files, variables, usageTruncated: false, ...overrides }
}

export function service(name: string, overrides: Partial<Service> = {}): Service {
  return {
    name,
    source: 'docker-compose.yml',
    kind: 'other',
    ports: [],
    expose: [],
    dependsOn: [],
    volumes: [],
    environment: [],
    envFiles: [],
    profiles: [],
    healthcheck: false,
    ...overrides,
  }
}

export function port(host: PortMapping['host'], container: number | string = 80, extra: Partial<PortMapping> = {}) {
  const mapping: PortMapping = { host, container, protocol: 'tcp', raw: `${host}:${container}`, ...extra }
  return mapping
}

export function nodeRuntime(sources: VersionSource[]): Runtime {
  return { id: 'node', name: 'Node.js', version: null, sources }
}

export function exact(file: string, version: string, field?: string): VersionSource {
  const source: VersionSource = { file, raw: version, version, kind: 'exact' }
  if (field) source.field = field
  return source
}

/** Context for a temporary project built from a file map. */
export async function projectContext(files: Record<string, string> = {}, options: ScanOptions = {}): Promise<Context> {
  return contextFor(await makeProject(files), options)
}

/** Run a single rule's check (bypassing `applies`). */
export async function runCheck(rule: DoctorRule, sections: Sections, ctx?: ProjectContext): Promise<Diagnostic[]> {
  return rule.check(sections, ctx ?? (await projectContext()))
}

/** Run a rule through the real runner, so `applies` and statuses are exercised. */
export async function runRule(rule: DoctorRule, sections: Sections, ctx?: ProjectContext): Promise<DoctorResult> {
  return runDoctor(sections, ctx ?? (await projectContext()), [rule])
}

export function codesOf(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.map((d) => d.code)
}

export function subjectsOf(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.map((d) => d.subject ?? '')
}

/** Every diagnostic is well formed and never echoes a secret value. */
export function expectWellFormed(diagnostics: readonly Diagnostic[], secrets: readonly string[] = []): void {
  for (const diagnostic of diagnostics) {
    expect(diagnostic.code).toMatch(/^[A-Z][A-Z0-9_]+$/)
    expect(diagnostic.message.length).toBeGreaterThan(0)
    expect(diagnostic.subject, `${diagnostic.code} has a subject`).toBeTruthy()
    const text = JSON.stringify(diagnostic)
    expect(text).not.toContain(SECRET_SENTINEL)
    for (const secret of secrets) expect(text).not.toContain(secret)
    for (const file of diagnostic.files ?? []) {
      expect(file.startsWith('/')).toBe(false)
      expect(file).not.toContain('\\')
    }
  }
}
