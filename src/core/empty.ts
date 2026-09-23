import type { Sections } from '../types.ts'

/** Empty value for every section; used when a detector fails so one bug never breaks the whole scan. */
export function emptySections(directory: string): Sections {
  return {
    project: { name: directory, directory, type: 'unknown', manifests: [], entrypoints: [], structure: [] },
    languages: [],
    runtimes: [],
    packageManagers: { primary: null, detected: [] },
    workspace: null,
    dependencies: { packages: [], total: 0 },
    frameworks: [],
    build: { tools: [] },
    testing: { tools: [], testFiles: 0 },
    linting: { tools: [] },
    scripts: { runner: null, scripts: [] },
    environment: { files: [], variables: [], usageTruncated: false },
    services: { composeFiles: [], services: [], dockerfiles: [] },
    databases: { databases: [], orms: [] },
    routes: { routes: [], truncated: false },
    ci: { providers: [], workflows: [] },
    git: null,
    configFiles: [],
  }
}
