/**
 * Directory roles that mark files as not being part of the project itself:
 * tests, fixtures, examples, templates and similar. Every detector and doctor
 * rule classifies paths with this one table instead of keeping its own list.
 *
 * Callers pick the roles that matter to them, e.g. environment usage ignores
 * fixtures and examples but may still want to know about tests.
 */

export type PathRole = 'test' | 'fixture' | 'example' | 'template' | 'playground' | 'benchmark' | 'docs'

const ROLE_SEGMENTS: Readonly<Record<PathRole, readonly string[]>> = {
  test: ['test', 'tests', '__tests__', 'spec', 'specs', '__mocks__', 'e2e', 'cypress'],
  fixture: ['fixture', 'fixtures', '__fixtures__', 'testdata', 'mocks'],
  example: ['example', 'examples', 'sample', 'samples', 'demo', 'demos'],
  template: ['template', 'templates', 'boilerplate', 'scaffold', 'scaffolds'],
  playground: ['playground', 'playgrounds', 'sandbox', 'sandboxes'],
  benchmark: ['bench', 'benchmark', 'benchmarks'],
  docs: ['docs', 'doc', 'documentation', 'website'],
}

/** Roles that mean "sample or test code, not the project": the usual default. */
export const NON_PROJECT_ROLES: readonly PathRole[] = [
  'test',
  'fixture',
  'example',
  'template',
  'playground',
  'benchmark',
]

const SEGMENT_ROLE = new Map<string, PathRole>()
for (const [role, segments] of Object.entries(ROLE_SEGMENTS) as Array<[PathRole, readonly string[]]>) {
  for (const segment of segments) SEGMENT_ROLE.set(segment, role)
}

/** Role of a single directory name, if any. */
export function roleOfSegment(segment: string): PathRole | undefined {
  return SEGMENT_ROLE.get(segment.toLowerCase())
}

/**
 * Roles of the directories a path lives in (the file name itself is not
 * considered). `relativeTo` limits the check to directories below a base
 * directory, e.g. a package root.
 */
export function pathRoles(file: string, relativeTo = '.'): Set<PathRole> {
  let rest = file
  if (relativeTo !== '.' && relativeTo !== '') {
    if (!file.startsWith(`${relativeTo}/`)) return new Set()
    rest = file.slice(relativeTo.length + 1)
  }
  const segments = rest.split('/')
  segments.pop()
  const roles = new Set<PathRole>()
  for (const segment of segments) {
    const role = roleOfSegment(segment)
    if (role) roles.add(role)
  }
  return roles
}

/** Is the path inside a directory with one of the given roles? */
export function isUnder(file: string, roles: readonly PathRole[] = NON_PROJECT_ROLES, relativeTo = '.'): boolean {
  const found = pathRoles(file, relativeTo)
  return roles.some((role) => found.has(role))
}

/** Test files by name: *.test.ts, *.spec.js, foo_test.go, test_foo.py, … */
export function isTestFileName(file: string): boolean {
  const name = file.slice(file.lastIndexOf('/') + 1)
  return (
    /[.-](?:test|spec|e2e-spec)\.[cm]?[jt]sx?$/.test(name) ||
    /_test\.go$/.test(name) ||
    /^test_.*\.py$|_test\.py$/.test(name) ||
    /_spec\.rb$/.test(name)
  )
}
