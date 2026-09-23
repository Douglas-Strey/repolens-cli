import type { Detector, SectionId } from '../types.ts'
import { buildDetector } from './build.ts'
import { ciDetector } from './ci.ts'
import { configFilesDetector } from './config-files.ts'
import { databasesDetector } from './databases.ts'
import { dependenciesDetector } from './dependencies.ts'
import { environmentDetector } from './environment.ts'
import { frameworksDetector } from './frameworks.ts'
import { gitDetector } from './git.ts'
import { languagesDetector } from './languages.ts'
import { lintingDetector } from './linting.ts'
import { packageManagersDetector } from './package-managers.ts'
import { projectDetector } from './project.ts'
import { routesDetector } from './routes/index.ts'
import { runtimesDetector } from './runtimes.ts'
import { scriptsDetector } from './scripts.ts'
import { servicesDetector } from './services.ts'
import { testingDetector } from './testing.ts'
import { workspaceDetector } from './workspace.ts'

/** One detector per section of the scan result. */
export type DetectorRegistry = { readonly [K in SectionId]: Detector<K> }

/**
 * Built-in detectors. The mapped type guarantees every section has exactly one
 * detector; the object is frozen so no consumer can change what every later
 * scan in the process does. Pass a different registry to `detect()` instead.
 */
export const detectors: DetectorRegistry = Object.freeze({
  project: projectDetector,
  languages: languagesDetector,
  runtimes: runtimesDetector,
  packageManagers: packageManagersDetector,
  workspace: workspaceDetector,
  dependencies: dependenciesDetector,
  frameworks: frameworksDetector,
  build: buildDetector,
  testing: testingDetector,
  linting: lintingDetector,
  scripts: scriptsDetector,
  environment: environmentDetector,
  services: servicesDetector,
  databases: databasesDetector,
  routes: routesDetector,
  ci: ciDetector,
  git: gitDetector,
  configFiles: configFilesDetector,
})
