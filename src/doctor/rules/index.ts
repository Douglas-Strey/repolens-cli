import type { DoctorRule } from '../../types.ts'
import { configurationRules } from './configuration.ts'
import { dockerRules } from './docker.ts'
import { environmentRules } from './environment.ts'
import { gitRules } from './git.ts'
import { packageManagerRules } from './package-manager.ts'
import { runtimeRules } from './runtime.ts'
import { scriptRules } from './scripts.ts'
import { securityRules } from './security.ts'
import { toolingRules } from './tooling.ts'
import { workspaceRules } from './workspace.ts'

/**
 * Built-in doctor rules. Order here is the order checks are listed in output.
 * Every code is documented in docs/diagnostics.md and never renamed once released.
 * Frozen so consumers can't change the built-in list; to add a rule, pass
 * `[...doctorRules, myRule]` to runDoctor.
 */
export const doctorRules: readonly DoctorRule[] = Object.freeze([
  ...configurationRules,
  ...securityRules,
  ...environmentRules,
  ...packageManagerRules,
  ...runtimeRules,
  ...workspaceRules,
  ...dockerRules,
  ...gitRules,
  ...scriptRules,
  ...toolingRules,
])
