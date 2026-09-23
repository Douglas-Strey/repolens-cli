# Diagnostics

**English** | [Português (Brasil)](pt-BR/diagnostics.md)

`repolens doctor` runs a set of checks against the scanned repository. Every problem it
finds is a **diagnostic** with a stable **code** such as `ENV_UNDOCUMENTED`. Codes are part
of the public contract: they are never renamed or reused, so you can safely filter on them
in scripts and CI.

```sh
repolens doctor --json | jq '.diagnostics[] | select(.code == "ENV_UNDOCUMENTED") | .subject'
```

Each diagnostic has a one-sentence `message`, a `hint` with a suggested fix, the `files`
involved (relative to the project root) and a `subject` (the variable, file, port or
package it is about). **Messages never contain secret values**: RepoLens only reports
variable names, file paths, versions and ports. Text taken from repository files (such as
workspace patterns or Compose service names) has control characters removed and its length
capped before it is printed, and repository paths inside suggested shell commands are
quoted when they contain shell metacharacters, so a hostile file name cannot turn a
copy-pasted hint into a different command.

## Severities

| Severity | Meaning | Fails `repolens doctor` |
| --- | --- | --- |
| `error` | Something is unsafe or broken right now (a committed secret, services that cannot start together). | by default (`--fail-on error`) |
| `warning` | Likely to cause a problem for someone working on the project. | with `--strict` / `--fail-on warning` |
| `info` | Worth knowing; low risk or a matter of convention. | with `--fail-on info` |

A few codes pick their severity from context (for example `DOCKER_PORT_CONFLICT` is an
error, or a warning when one of the services only starts with a Compose profile). This is
noted for each code below. These are the default severities: a configuration file can
change them (see [Configuring checks](#configuring-checks)).

## Passed, skipped and disabled checks

Every code is also a **check** with a positive title (for example "Environment variables
used in code are documented"). A check is `failed` when it produced diagnostics, `passed`
when it ran and found nothing, `skipped` when it had nothing to check, and `disabled` when
a configuration file turned it off (it does not run at all). A check is skipped when its
input files are absent (package-manager, script and Node.js checks without a
`package.json`, Docker checks without Compose files, Git checks outside a Git repository,
…) or could not be parsed (a broken `turbo.json` skips `TURBO_PIPELINE_KEY`;
`CONFIG_PARSE_ERROR` reports the file). A check is never shown as passed for something it
could not look at, and an empty directory skips every check. Skipping is decided from the
file index and parse results, not only from detector output, so a detector that fails
never hides a real problem. A check that fails to run is skipped too, and the failure is
reported as a scan warning.

In `--json` output, every check has a `status`, and `doctor.summary` counts the `passed`,
`failed`, `skipped` and `disabled` checks.

## Configuring checks

A [configuration file](configuration.md) can turn a check off or change its severity with
`doctor.rules`, by code:

```json
{ "doctor": { "rules": { "SCRIPT_MISSING_LINT": "off", "RUNTIME_EOL": "error" } } }
```

- `"off"` turns the check off: it does not run and is listed as `disabled`.
- `"error"`, `"warning"` or `"info"` reports everything the check finds at that severity,
  instead of the severities listed below.

A project's own config (`repolens.config.json`, or the `"repolens"` key in its
`package.json`) can't turn off or lower the security checks (`ENV_EXAMPLE_REAL_SECRET`,
`TRACKED_ENV_FILE`, `ENV_FILE_NOT_IGNORED`, `ENV_PUBLIC_SECRET`): a repository must not be
able to hide its own security findings. It may raise them to `"error"`. Your user config or
a file passed with `--config` can turn them off. See
[configuration.md](configuration.md#doctorrules) for the details.

## All codes

| Code | Severity | Category | Check |
| --- | --- | --- | --- |
| [`PACKAGE_JSON_INVALID`](#package_json_invalid) | error | configuration | package.json is valid JSON |
| [`CONFIG_PARSE_ERROR`](#config_parse_error) | warning | configuration | Configuration files parse |
| [`ENV_EXAMPLE_REAL_SECRET`](#env_example_real_secret) | error | security | Example env files contain no real credentials |
| [`TRACKED_ENV_FILE`](#tracked_env_file) | error / warning | security | Local env files are not committed |
| [`ENV_FILE_NOT_IGNORED`](#env_file_not_ignored) | warning | security | Local env files are ignored by Git |
| [`ENV_PUBLIC_SECRET`](#env_public_secret) | warning | security | No secret is exposed to the browser |
| [`ENV_UNDOCUMENTED`](#env_undocumented) | warning / info | environment | Environment variables used in code are documented |
| [`ENV_LOCAL_ONLY`](#env_local_only) | warning | environment | Local environment variables are documented |
| [`ENV_EXAMPLE_MISSING`](#env_example_missing) | warning / info | environment | An example env file documents the environment |
| [`ENV_UNUSED`](#env_unused) | info | environment | Documented environment variables are used |
| [`ENV_MISSING_LOCAL`](#env_missing_local) | info | environment | The local env file sets every documented variable |
| [`MULTIPLE_LOCKFILES`](#multiple_lockfiles) | warning | package-manager | Only one package manager lockfile is committed |
| [`PACKAGE_MANAGER_MISMATCH`](#package_manager_mismatch) | warning | package-manager | The lockfile matches the declared package manager |
| [`PACKAGE_MANAGER_UNDECLARED`](#package_manager_undeclared) | info | package-manager | The package manager is declared |
| [`LOCKFILE_MISSING`](#lockfile_missing) | info | package-manager | Dependencies are locked |
| [`NODE_VERSION_CONFLICT`](#node_version_conflict) | warning | runtime | Node.js version pins agree |
| [`NODE_VERSION_OUT_OF_RANGE`](#node_version_out_of_range) | warning | runtime | Node.js pins satisfy engines.node |
| [`RUNTIME_EOL`](#runtime_eol) | warning | runtime | Pinned runtimes are supported |
| [`GO_VERSION_CONFLICT`](#go_version_conflict) | warning | runtime | Go toolchains satisfy go.mod |
| [`WORKSPACE_DUPLICATE_CONFIG`](#workspace_duplicate_config) | warning | workspace | Workspaces are declared in one place |
| [`WORKSPACE_PATTERN_EMPTY`](#workspace_pattern_empty) | warning | workspace | Every workspace pattern matches a package |
| [`TURBO_PIPELINE_KEY`](#turbo_pipeline_key) | warning / info | workspace | turbo.json uses the current schema |
| [`DOCKER_PORT_CONFLICT`](#docker_port_conflict) | error / warning | docker | Compose services publish distinct host ports |
| [`COMPOSE_ENV_FILE_MISSING`](#compose_env_file_missing) | warning | docker | Compose env_file entries exist |
| [`ENV_PORT_MISMATCH`](#env_port_mismatch) | warning | docker | Env URLs point at published service ports |
| [`COMPOSE_VERSION_OBSOLETE`](#compose_version_obsolete) | info | docker | Compose files omit the obsolete version key |
| [`GITIGNORE_MISSING`](#gitignore_missing) | warning | git | The repository has a .gitignore |
| [`GITIGNORE_NODE_MODULES`](#gitignore_node_modules) | warning | git | node_modules is ignored by Git |
| [`SCRIPT_TEST_PLACEHOLDER`](#script_test_placeholder) | info | scripts | The test script runs real tests |
| [`SCRIPT_MISSING_TEST`](#script_missing_test) | info | scripts | package.json has a test script |
| [`SCRIPT_MISSING_LINT`](#script_missing_lint) | info | scripts | A lint script runs the configured linter |
| [`ESLINT_LEGACY_CONFIG`](#eslint_legacy_config) | warning / error / info | tooling | ESLint uses flat config |
| [`GO_SUM_MISSING`](#go_sum_missing) | warning | tooling | Go modules have a committed go.sum |
| [`NEXT_MIDDLEWARE_DEPRECATED`](#next_middleware_deprecated) | info | tooling | Next.js apps use the proxy convention |

---

## Configuration

### `PACKAGE_JSON_INVALID`

**Severity:** error · **Category:** configuration

- **What it checks:** the root `package.json` exists but is not valid JSON.
- **Why it matters:** package managers refuse to install, scripts can't run, and every
  check that reads `package.json` (lockfiles, scripts, workspaces) has nothing to work with.
- **How to fix:** fix the syntax error; a trailing comma or a missing quote is typical.
  The parser message is available with `--verbose` (it is never part of the diagnostic,
  because parser messages can quote file contents).
- **Example:** `package.json is not valid JSON`

### `CONFIG_PARSE_ERROR`

**Severity:** warning · **Category:** configuration

- **What it checks:** one diagnostic per configuration file RepoLens could not parse:
  YAML (Compose files, `pnpm-workspace.yaml`, CI workflows), JSON/JSONC (`turbo.json`,
  `tsconfig.json`, …) and `go.mod` files without a `module` line. The root `package.json`
  is reported by `PACKAGE_JSON_INVALID` instead. This check runs after all others, so it
  also sees files that only other checks read.
- **Why it matters:** the tools that own these files will usually fail too, and RepoLens
  skipped the file, so its other findings may be incomplete.
- **How to fix:** fix the syntax error. Run with `--verbose` to see the parser message.
- **Example:** `Couldn't parse docker-compose.yml`

## Security

The env file checks here and in [Environment](#environment) treat each env file by its
kind (the `kind` of each file in the environment section of the scan):

- **local**: one developer's values, never meant to be committed: `.env`, `.env.local`,
  `.env.*.local`, `local.env` and direnv's `.envrc`.
- **mode**: per-environment files that frameworks load and projects often commit on
  purpose: `.env.development`, `.env.production`, `.env.test`, `.env.ci`, `.env.staging`,
  `prod.env`, … (modes `development`, `develop`, `dev`, `production`, `prod`, `test`,
  `testing`, `ci`, `staging`, `stage`, `preview`, `qa`, `uat`, `e2e`, `integration`).
- **service**: any other env file a Compose service loads with `env_file` (`.env.db`).
- **example**: documentation templates: `.env.example`, `.env.sample`, `.env.template`,
  `env.example`, … (any env file name containing `example`, `sample`, `template`, `dist`,
  `defaults` or `schema`).
- **other**: env files of no known purpose (`.env.backup`, `.env.old`, `secrets.env`).
  `TRACKED_ENV_FILE` and `ENV_FILE_NOT_IGNORED` only report them when they hold a
  credential-shaped value; no other check looks at them. The encrypted `.env.vault` is meant
  to be committed and is never checked.

Env files are read at the root, in package and Go module directories, in directories with
a Compose file and next to the env files Compose services load, at most three directories
deep. Env files ignored by Git are read too.

### `ENV_EXAMPLE_REAL_SECRET`

**Severity:** error · **Category:** security

- **What it checks:** an example env file holds a value that matches a known credential
  format: AWS access key, GitHub, GitLab, npm or Slack token, Stripe live key, OpenAI,
  Anthropic, Google or SendGrid API key, or private key. Commented-out assignments
  (`# NAME=value`) count too. One diagnostic per variable, listing every example file that
  holds one.
- **Why it matters:** example files are committed and shared; a real credential in one is
  a leaked credential.
- **How to fix:** rotate the credential first (removing it from the file does not remove
  it from Git history), then replace the value with an empty placeholder (`NAME=`).
- **Example:** `.env.example contains what looks like a real credential in STRIPE_SECRET_KEY`

### `TRACKED_ENV_FILE`

**Severity:** error, or warning for committed defaults · **Category:** security

- **What it checks:** a local, mode, service or other env file is tracked by Git (read
  from `.git/index`, without running `git`). Only runs in Git repositories.
- **Severity:** a local file (`.env`, `.env.local`, `.env.production.local`, …) is always
  an error. Mode files, service files and `.envrc` are often committed on purpose with
  non-secret defaults (Vite, Next.js, direnv), so they are a warning, or an error when one
  of their values (commented-out assignments included) matches a known credential format
  (the formats of `ENV_EXAMPLE_REAL_SECRET`). A secret-looking name alone does not make it
  an error: `AUTH_SECRET=test-secret-not-real` in a committed `.env.test` is a warning.
  Mode and service files without variables, and mode files that only set browser-exposed
  variables (`VITE_API_URL`, `NEXT_PUBLIC_SITE_URL`), are not reported unless they hold a
  credential. An `.envrc` without variables (only `use flake`, `layout node`, …) is never
  reported. Env files of no known purpose (`.env.backup`) are only reported, as an error,
  when they hold a credential-shaped value.
- **Why it matters:** everyone who clones the repository gets the values, and they stay in
  Git history.
- **How to fix:** `git rm --cached .env`, add the file to `.gitignore`, and rotate any
  secret it contained. For a mode file, keep only non-secret defaults in it and put secrets
  in the matching `.local` file (`.env.production.local`), which is not committed.
- **Example:** `.env is tracked by Git`, or
  `.env.staging is tracked by Git and contains what looks like a real credential`

### `ENV_FILE_NOT_IGNORED`

**Severity:** warning · **Category:** security

- **What it checks:** an env file exists, is not tracked by Git and is not matched by
  `.gitignore`. Every local file is reported except `.envrc`. Mode, service and other env
  files are only reported when one of their values (commented-out assignments included)
  matches a known credential format; without one, they may be meant to be committed. Files
  Git already tracks are reported by `TRACKED_ENV_FILE` instead. Only runs in Git
  repositories, and is skipped when scanning a subdirectory of a repository (the
  `.gitignore` files above it are not visible to the scan).
- **Why it matters:** the next `git add .` commits it.
- **How to fix:** add the file name to `.gitignore`, or `.env*` together with
  `!.env.example`.
- **Example:** `.env is not ignored by Git and could be committed by accident`

### `ENV_PUBLIC_SECRET`

**Severity:** warning · **Category:** security

- **What it checks:** a variable (used in code or named in any env file) with a
  client-exposure prefix (`NEXT_PUBLIC_`, `NUXT_PUBLIC_`, `EXPO_PUBLIC_`, `REACT_APP_`,
  `VUE_APP_`, `STORYBOOK_`, `GATSBY_`, `PUBLIC_` or `VITE_`) whose name contains `SECRET`,
  `SECRETS`, `SECRETKEY`, `CLIENTSECRET`, `PASSWORD`, `PASSWD`, `PRIVATE_KEY`,
  `PRIVATEKEY`, `SERVICE_ROLE` or `SERVICEROLE` as a whole word between underscores
  (`VITE_DB_PASSWORD`, but not `NEXT_PUBLIC_SECRETARY_EMAIL`). Tokens and keys alone are
  not enough, since many are public by design (`NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN`,
  `…_PUBLISHABLE_KEY`, `…_ANON_KEY`).
- **Why it matters:** frameworks inline these variables into the JavaScript sent to every
  visitor.
- **How to fix:** rename the variable without the prefix (e.g. `JWT_SECRET`), read it only
  in server code, and rotate the value if it was ever deployed.
- **Example:** `NEXT_PUBLIC_JWT_SECRET is exposed to the browser bundle but looks like a secret`

## Environment

These checks use the environment section of the scan: variables referenced in code and
configuration, the names set in local and mode env files, and the names documented in
example files (see the file kinds under [Security](#security)). A commented-out line in
an example file (`# NAME=`) documents the name too. Some variables are treated specially:

- **Platform variables** are provided by the OS, shells, terminals, package managers, CI
  platforms or test runners, so these checks never report them: `NODE_ENV`, `CI`, `TZ`,
  `HOME`, `PATH`, `PWD`, `SHELL`, `USER`, `LANG`, `TERM`, `TMPDIR`, `HOSTNAME`, `DEBUG`,
  their Windows equivalents (`USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `TEMP`, `TMP`),
  terminal conventions (`NO_COLOR`, `FORCE_COLOR`, `COLORTERM`, `COLUMNS`, `LINES`,
  `LC_ALL`, `EDITOR`, `VISUAL`), Vite's `import.meta.env` built-ins (`MODE`, `DEV`,
  `PROD`, `SSR`, `BASE_URL`), the GitHub Actions default variables (`GITHUB_ACTIONS`,
  `GITHUB_SHA`, `GITHUB_TOKEN`, `GITHUB_REF_NAME`, `GITHUB_RUN_ID`, …, but not
  application names such as `GITHUB_CLIENT_ID`), and names starting with `npm_`,
  `RUNNER_`, `VERCEL_`, `NETLIFY`, `RENDER_`, `RAILWAY_`, `FLY_`, `CF_PAGES`,
  `NEXT_RUNTIME`, `NEXT_PHASE`, `VITEST`, `JEST_WORKER_ID` or `XDG_`. `PORT` is not on
  this list: it is application configuration. Variables listed in `environment.provided`
  in a [configuration file](configuration.md#environmentprovided) are treated like
  platform variables by these checks (the security checks still look at them).
- **Test-only variables** are referenced only from test code: test files (`*.test.ts`,
  `*_test.go`, `test_*.py`, …), test directories (`test/`, `__tests__/`, `e2e/`, …) and
  test-runner configuration (`playwright.config.ts`, `vitest.config.ts`, …). They are not
  configuration developers need to set. References in fixture, example, template,
  playground and benchmark directories are not counted at all.
- **Variables with a default** are read with a fallback by every reference in code
  (`process.env.PORT ?? 3000` or `|| 3000`, a schema `.default()`, …), so they are
  optional.

### `ENV_UNDOCUMENTED`

**Severity:** warning, or info when the variable has a default · **Category:** environment

- **What it checks:** a variable is used in code but missing from every example env file,
  while at least one example file exists and could be read. The diagnostic names the
  example file closest to where the variable is used (`apps/api/.env.example` for code in
  `apps/api`). In a workspace, only example files in the same package or in a directory
  above it count; when there is none, the message says so and the hint suggests creating
  `<package>/.env.example`. Test-only variables, platform variables and names a Next.js
  config provides through its `env` block are not reported.
- **Severity:** a warning, or informational when every reference has a default in code: the
  variable is worth documenting, but it does not block setup.
- **Why it matters:** new contributors copy the example file and then hit a runtime error
  or silent misbehavior.
- **How to fix:** add `NAME=` (without a value) to the example file.
- **Example:** `STRIPE_SECRET_KEY is used in code but missing from .env.example`. With a
  default: `PORT is used in code (with a default) but missing from .env.example`. In a
  workspace package without an example file:
  `STRIPE_KEY is used in apps/api but no example env file there documents it`

### `ENV_LOCAL_ONLY`

**Severity:** warning · **Category:** environment

- **What it checks:** a variable is set in a local env file (`.env`, `.env.local`, …) but
  not documented in any example file (and an example file exists). Mode and service files
  don't count, and neither does `.envrc`, which holds direnv settings (`AWS_PROFILE`) rather
  than the app's configuration. Variables that are also used in code outside tests are
  reported by `ENV_UNDOCUMENTED` instead, so each variable is reported once; a variable
  only tests read is reported here. The diagnostic names the example file closest to the
  local file.
- **Why it matters:** the project may depend on configuration only one machine has.
- **How to fix:** document it in the example file, or delete it from the local file if it
  is obsolete.
- **Example:** `SECRET_TOKEN is set in .env but missing from .env.example`

### `ENV_EXAMPLE_MISSING`

**Severity:** warning, or info for libraries and CLIs · **Category:** environment

- **What it checks:** there is no example env file at all, but code needs variables or a
  local env file exists. Code needs a variable when code outside tests reads it without a
  default, and it is neither a platform variable nor provided by a Next.js config `env`
  block: a server reading `process.env.PORT ?? 3000` needs no template. Mode files,
  service files and `.envrc` don't count as a local env file. Reported once; the hint
  lists up to five names (the variables code needs and those set in local files).
- **Severity:** a warning. For projects detected as a library or CLI without a local env
  file it is only informational, since those usually read optional settings.
- **Why it matters:** there is no way to know which variables to set without reading the
  code.
- **How to fix:** create `.env.example` with every name and no values, next to the local
  env file or at the root (the hint names the path).
- **Example:** `No .env.example documents the 2 environment variables used in code`, or
  `.env exists but there is no .env.example documenting which variables to set`

### `ENV_UNUSED`

**Severity:** info · **Category:** environment

- **What it checks:** a variable is documented in an example file but never referenced in
  code or configuration. Skipped when the project has no source files or usage scanning
  stopped early. Variables that something else may consume are not reported: names passed
  to Compose services (`environment:`), Dockerfile `ARG`s, variables documented
  next to a Compose file whose services load an `env_file`, platform variables, names that
  appear as a whole word in source code outside comments (a library may read them by
  name, as in `const MODE_ENV = "GIN_MODE"`), and names tools read on their own: `PORT`,
  `HOST`, `NODE_OPTIONS`, `NODE_TLS_REJECT_UNAUTHORIZED`, `NODE_EXTRA_CA_CERTS`,
  `DO_NOT_TRACK`, `NEXT_TELEMETRY_DISABLED`, `NEXTAUTH_URL`, `NEXTAUTH_SECRET`, `BROWSER`,
  `GENERATE_SOURCEMAP`, `GIN_MODE`, Go toolchain settings (`GOFLAGS`, `GOPROXY`,
  `GOPRIVATE`, `GOTOOLCHAIN`, `GOMAXPROCS`, `GOMEMLIMIT`, `GODEBUG`, `CGO_ENABLED`), and
  names starting with `NUXT_`, `NITRO_`, `AUTH_`, `COMPOSE_`, `DOCKER_`, `TURBO_`,
  `PRISMA_`, `ASTRO_TELEMETRY` or `SENTRY_`.
- **Why it matters:** stale documentation makes setup longer and more confusing.
- **How to fix:** remove it from the example file if nothing reads it anymore.
- **Example:** `LEGACY_FLAG is documented in .env.example but never referenced in code`

### `ENV_MISSING_LOCAL`

**Severity:** info · **Category:** environment

- **What it checks:** a local env file exists at the root (`.env`, `.env.local`, …; not
  `.envrc`), and a variable documented in a root example file and needed by code (used
  outside tests, without a default, not a platform variable) is set in no local or mode
  env file. Service files don't count: one Compose service loads them, not the app.
  Variables documented only in a nested example file are left out, since they belong in
  that package's env file. The message names the root `.env`, or `.env.local` when there
  is no `.env`.
- **Why it matters:** code reads the variable without a default, so the app will likely
  fail when it runs.
- **How to fix:** add the variable with your local value to `.env`.
- **Example:** `DATABASE_URL is not set in .env`

## Package manager

Lockfiles are read from the file index at the project root: `package-lock.json`,
`npm-shrinkwrap.json` (npm), `pnpm-lock.yaml` (pnpm), `yarn.lock` (Yarn), `bun.lock`,
`bun.lockb` (Bun). Lockfiles ignored by `.gitignore` are not counted as committed.

### `MULTIPLE_LOCKFILES`

**Severity:** warning · **Category:** package-manager

- **What it checks:** lockfiles of more than one package manager exist at the root
  (`bun.lock` and `bun.lockb` together count as one).
- **Why it matters:** people install different dependency trees depending on which tool
  they use, and the lockfiles drift apart.
- **How to fix:** keep the lockfile of the package manager the team uses and delete the
  others. When `package.json` declares a package manager, the hint names the files to
  delete.
- **Example:** `Found lockfiles for npm and pnpm: package-lock.json and pnpm-lock.yaml`

### `PACKAGE_MANAGER_MISMATCH`

**Severity:** warning · **Category:** package-manager

- **What it checks:** `package.json` declares a package manager (`packageManager` or
  `devEngines.packageManager`) but its lockfile is absent while another package manager's
  lockfile exists.
- **Why it matters:** CI and Corepack (where it is enabled) use the declared tool, which
  ignores the committed lockfile, so installs are not reproducible.
- **How to fix:** generate the right lockfile (`pnpm import` converts npm and Yarn
  lockfiles) and delete the other one, or correct the declaration.
- **Example:** `package.json declares pnpm in "packageManager", but package-lock.json is the only lockfile`

### `PACKAGE_MANAGER_UNDECLARED`

**Severity:** info · **Category:** package-manager

- **What it checks:** a lockfile exists but `package.json` has no `packageManager` field,
  no `devEngines.packageManager` and no Volta pin for npm, pnpm or Yarn.
- **Why it matters:** contributors and CI may use a different package manager or major
  version than the one that wrote the lockfile.
- **How to fix:** record the package manager and version in `package.json`, for example
  with `npm pkg set packageManager=pnpm@$(pnpm --version)`. The hint names the version
  when the repository reveals it (an exact `engines.pnpm`, or Yarn's `yarnPath` release
  file). The command does not need Corepack, which Node.js 25 and newer no longer bundle;
  Corepack, if you use it, then runs that version.
- **Example:** `package.json does not declare which package manager to use (found pnpm-lock.yaml)`

### `LOCKFILE_MISSING`

**Severity:** info · **Category:** package-manager

- **What it checks:** the root `package.json` (or a workspace package) declares
  dependencies but there is no lockfile at the root. Not reported when a lockfile name is
  matched by `.gitignore` or `.npmrc` sets `package-lock=false` or `lockfile=false` (not
  committing a lockfile is then deliberate), or when the scan root is a subdirectory of a Git repository (the
  lockfile usually lives at the repository root).
- **Why it matters:** every install can resolve different versions.
- **How to fix:** run the install command of your package manager and commit the lockfile.
- **Example:** `package.json declares dependencies but there is no lockfile`

## Runtime

Node.js pins are the exact versions from the runtimes section: `.nvmrc`, `.node-version`,
`.tool-versions`, Volta, Dockerfile `FROM node:…`, CI `setup-node`, and so on. Ranges such
as `engines.node` and aliases such as `lts/*` are not pins. A file that pins several major
versions (a CI test matrix) is left out of these checks.

### `NODE_VERSION_CONFLICT`

**Severity:** warning · **Category:** runtime

- **What it checks:** exact Node.js pins disagree on the major version. Reported once,
  listing every `file: version` pair. The hint suggests the most common pinned major that
  satisfies `engines.node`, or the lowest major `engines.node` allows. A file that pins
  several majors (a CI test matrix) is left out. In a monorepo, a directory with its own
  version file (`apps/legacy/.nvmrc`, `volta.node` in its `package.json`) may run a
  different major on purpose: its pins are compared among themselves and reported with
  the subject `node:<directory>`. Every other pin (CI workflows, Dockerfiles, packages
  without their own pin) is compared with the root pins (subject `node`).
- **Why it matters:** local, CI and production environments run different Node.js versions.
- **How to fix:** pin the same major version in every file.
- **Example:** `Node.js versions disagree (.node-version: 18.20.4, .nvmrc: 20)`

### `NODE_VERSION_OUT_OF_RANGE`

**Severity:** warning · **Category:** runtime

- **What it checks:** an exact pin cannot satisfy the `engines.node` range that applies to
  it: the one of the deepest package containing the pinning file, else the root
  `package.json`. Full versions are checked with `semver.satisfies`; partial pins (`20`,
  `20.11`) with `semver.intersects`. Invalid ranges are ignored. Skipped when no package
  declares `engines.node`.
- **Why it matters:** the pinned version is one the project says it does not support;
  package managers may refuse to install (`engine-strict`) or code may use missing APIs.
- **How to fix:** update the pin, or update `engines.node`.
- **Example:** `.nvmrc pins Node.js 20, which does not satisfy engines.node ">=22" in package.json`

### `RUNTIME_EOL`

**Severity:** warning · **Category:** runtime

- **What it checks:** an exact Node.js pin whose release line has reached end-of-life at
  the time of the scan. One diagnostic per major, listing the files. End-of-life dates:

  | Major | End of life | Major | End of life |
  | --- | --- | --- | --- |
  | 10 | 2021-04-30 | 19 | 2023-06-01 |
  | 12 | 2022-04-30 | 20 | 2026-04-30 |
  | 14 | 2023-04-30 | 21 | 2024-06-01 |
  | 16 | 2023-09-11 | 22 | 2027-04-30 |
  | 17 | 2022-06-01 | 23 | 2025-06-01 |
  | 18 | 2025-04-30 | 24 | 2028-04-30 |
  |  |  | 25 | 2026-06-01 |
  |  |  | 26 | 2029-04-30 |

  Majors that are not in the table are not reported. The programmatic API accepts a `now`
  option to make this check deterministic.
- **Why it matters:** end-of-life releases no longer get security fixes.
- **How to fix:** upgrade to a supported LTS release (the hint lists the active ones).
- **Example:** `Node.js 18 reached end-of-life on 2025-04-30 (pinned in .node-version)`

### `GO_VERSION_CONFLICT`

**Severity:** warning · **Category:** runtime

- **What it checks:** a Go toolchain used to build the project (a `golang:<version>` base
  image in a Dockerfile, or `setup-go` in CI) is older than the `go` directive of the
  module it builds (the module containing the file, or the only module). Floating tags
  such as `golang:1.25` are compared on major.minor; patch versions are only compared when
  the image pins one.
- **Why it matters:** the official `golang` images set `GOTOOLCHAIN=local`, so
  `go build` fails with "go.mod requires go >= …". In CI, the job either downloads a newer
  toolchain on every run or fails. Toolchains older than Go 1.21 do not enforce the `go`
  directive at all, so the build may instead fail on newer language features; the message
  says so for those versions.
- **How to fix:** use a newer image (`golang:1.25`), or `go-version-file: go.mod` in
  `actions/setup-go`.
- **Example:** `Dockerfile builds with Go 1.24, but go.mod requires go 1.25.1, and the official golang image sets GOTOOLCHAIN=local so the build fails`

## Workspace

### `WORKSPACE_DUPLICATE_CONFIG`

**Severity:** warning · **Category:** workspace

- **What it checks:** workspaces are declared both in `pnpm-workspace.yaml` and in the
  `workspaces` field of `package.json`. When `pnpm-workspace.yaml` has no `packages` list
  (it only holds settings or catalogs), this is reported only if the project does not
  declare or lock with npm, Yarn or Bun, since then pnpm ignores the `package.json` list.
- **Why it matters:** pnpm only reads `pnpm-workspace.yaml`, while npm, Yarn and Bun only
  read `package.json`, so the two lists drift apart and tools disagree on the packages.
- **How to fix:** keep one declaration: remove `workspaces` from `package.json` when you
  use pnpm, or remove the packages list from `pnpm-workspace.yaml` otherwise.
- **Example:** `Workspaces are declared in both pnpm-workspace.yaml and package.json with different patterns, but pnpm only reads pnpm-workspace.yaml`

### `WORKSPACE_PATTERN_EMPTY`

**Severity:** warning · **Category:** workspace

- **What it checks:** a (non-negated) pattern of the effective workspace declaration
  matches no directory containing a `package.json`. Patterns under directories RepoLens
  does not walk (ignored by Git) and scans that hit the file limit are skipped.
- **Why it matters:** usually a leftover from a moved or deleted package, or a typo that
  silently leaves a package out of the workspace.
- **How to fix:** remove the pattern, or fix it to match the package directory.
- **Example:** `Workspace pattern "tools/*" in pnpm-workspace.yaml matches no package`

### `TURBO_PIPELINE_KEY`

**Severity:** warning, or info when the turbo version is unknown · **Category:** workspace

- **What it checks:** `turbo.json` (at the root or in a package) uses the `pipeline` key
  while `turbo` 2 or newer is declared. Not reported for Turborepo 1, where `pipeline` is
  correct.
- **Why it matters:** Turborepo 2 renamed `pipeline` to `tasks` and refuses to run with the
  old key.
- **How to fix:** rename `pipeline` to `tasks`; `npx @turbo/codemod migrate` upgrades the
  whole configuration.
- **Example:** `turbo.json uses "pipeline", which Turborepo 2 renamed to "tasks"`

## Docker

These checks read the project's Compose files: `compose.yaml`, `compose.yml`,
`docker-compose.yml`, `docker-compose.yaml`, their override files
(`docker-compose.override.yml`) and variants (`compose.prod.yaml`), at the root and up to
two directories deep (`docker/`, `deploy/local/`). Files in test, fixture, example,
template, playground and benchmark directories are not part of the project and are left
out. `COMPOSE_ENV_FILE_MISSING` and `COMPOSE_VERSION_OBSOLETE` find and read these files
themselves, so they work even when the services section is empty; `DOCKER_PORT_CONFLICT`
and `ENV_PORT_MISMATCH` use the services section, which is built from the same files. A
file that fails to parse is left out (`CONFIG_PARSE_ERROR` reports it), and a check is
skipped when none of the Compose files could be parsed.

### `DOCKER_PORT_CONFLICT`

**Severity:** error, or warning when a profiled service is involved · **Category:** docker

- **What it checks:** two or more services publish the same literal host port with the
  same protocol on overlapping host IPs (an unspecified IP, `0.0.0.0` or `::` overlaps
  every address). Only services that run together are compared: a directory's default
  Compose file and its override file form one project; other files
  (`docker-compose.prod.yml`) and other directories are separate projects. The same
  service defined in a base file and its override is one service. Ports that use
  interpolation (`${PORT}`), ranges or port `0` (an ephemeral port) are skipped. One
  diagnostic per port and Compose project, listing the services involved (the first eight,
  then a count).
- **Why it matters:** the second service fails to start with "port is already allocated".
  Services with `profiles` only start on request, so the clash is then a warning.
- **How to fix:** give each service its own host port (`"8081:80"`).
- **Example:** `Services admin and web in docker-compose.yml both publish host port 8080`

### `COMPOSE_ENV_FILE_MISSING`

**Severity:** warning · **Category:** docker

- **What it checks:** a service references an `env_file` (resolved relative to the Compose
  file) that does not exist. Entries with `required: false`, interpolation, absolute paths
  or paths outside the project are skipped, as are files inside directories RepoLens does
  not walk (ignored by Git), whose existence is unknown. Files that exist but are ignored by
  Git count as existing. One diagnostic per missing file, listing the services that load it.
- **Why it matters:** `docker compose up` fails with "env file … not found".
- **How to fix:** create the file; the hint suggests `cp .env.example .env` when an example
  exists (paths with shell metacharacters are single-quoted in the suggested command). Or
  mark the entry optional with `required: false`.
- **Example:** `Service app in compose.yaml loads env_file .env, which does not exist`

### `ENV_PORT_MISMATCH`

**Severity:** warning · **Category:** docker

- **What it checks:** an env variable holds a URL to localhost with an explicit port and a
  database scheme (`postgres`/`postgresql`, `mysql`, `mariadb`, `mongodb`,
  `redis`/`rediss`), while Compose services of that technology publish literal host
  ports and none of them is that port. Services with interpolated host ports are skipped.
  Only the scheme, port and locality of the URL are used; the URL itself is never stored.
- **Why it matters:** the app can't connect to the database started by Compose.
- **How to fix:** use the published port in the env file, or publish that port.
- **Example:** `DATABASE_URL in .env.example uses port 5433, but the db service publishes 5432`

### `COMPOSE_VERSION_OBSOLETE`

**Severity:** info · **Category:** docker

- **What it checks:** a Compose file has a top-level `version` key.
- **Why it matters:** Compose V2 ignores it and prints "the attribute `version` is
  obsolete" on every run.
- **How to fix:** delete the line.
- **Example:** `docker-compose.yml sets the obsolete top-level "version" key`

## Git

### `GITIGNORE_MISSING`

**Severity:** warning · **Category:** git

- **What it checks:** the project is a Git repository without a `.gitignore` at its root.
  Skipped when scanning a subdirectory of a repository.
- **Why it matters:** dependencies, build output and local env files end up in commits.
- **How to fix:** create a `.gitignore`; the hint suggests entries based on what exists
  (`node_modules/`, `dist/`, `.env*` with `!.env.example`).
- **Example:** `The repository has no .gitignore file`

### `GITIGNORE_NODE_MODULES`

**Severity:** warning · **Category:** git

- **What it checks:** the project has a root `package.json` and a `.gitignore` that does
  not ignore `node_modules`. Rules that only match its contents (`node_modules/*`,
  `**/node_modules/**`) count as ignoring it. Not reported for Yarn Plug'n'Play installs,
  which create no `node_modules` (a `.pnp.cjs` loader, or `.yarnrc.yml` without a
  `nodeLinker` other than `pnp` in a Yarn project).
- **Why it matters:** one `git add .` commits thousands of files, often platform-specific
  binaries.
- **How to fix:** add `node_modules/` to `.gitignore`.
- **Example:** `.gitignore does not ignore node_modules`

## Scripts

### `SCRIPT_TEST_PLACEHOLDER`

**Severity:** info · **Category:** scripts

- **What it checks:** the root `test` script is the placeholder written by `npm init`
  (`echo "Error: no test specified" && exit 1`).
- **Why it matters:** `npm test` always fails, which breaks CI templates and tools that run
  it.
- **How to fix:** replace it with the real test command (the hint suggests one when a test
  runner is installed) or remove it.
- **Example:** `The "test" script in package.json is the npm placeholder that always fails`

### `SCRIPT_MISSING_TEST`

**Severity:** info · **Category:** scripts

- **What it checks:** the root package has a test runner (from the testing section or its
  dependencies: Vitest, Jest, Mocha, AVA, Playwright, …) or the project has JavaScript test
  files (`*.test.*`, `*.spec.*`, `__tests__/`), but the root `package.json` has no `test`
  script. `test:*` scripts and a `test` target in a root Makefile, justfile or Taskfile
  count as a test script. Test files in fixture, example and template directories do not
  count; without a `package.json` or anything to test, the check is skipped.
- **Why it matters:** `npm test` is the command people and tools try first.
- **How to fix:** add a `test` script (e.g. `"test": "vitest run"`).
- **Example:** `Vitest is set up, but package.json has no "test" script`

### `SCRIPT_MISSING_LINT`

**Severity:** info · **Category:** scripts

- **What it checks:** a linter (ESLint, Biome, oxlint, golangci-lint, …) is configured
  for the root package, but no root script lints: none is named `lint`/`lint:*`, none has
  the lint category, and none runs a linter command. Projects without a `package.json` or
  a root task file (Makefile, justfile, Taskfile) are skipped.
- **Why it matters:** contributors can't easily run the same checks as CI.
- **How to fix:** add a `lint` script (or a Makefile target).
- **Example:** `ESLint is configured, but package.json has no lint script`

## Tooling

### `ESLINT_LEGACY_CONFIG`

**Severity:** warning for ESLint 9, error for ESLint 10+, info when the version is unknown or when ESLint 9 is told to read it with `ESLINT_USE_FLAT_CONFIG=false` · **Category:** tooling

- **What it checks:** a legacy config (`.eslintrc`, `.eslintrc.js`, `.eslintrc.cjs`,
  `.eslintrc.json`, `.eslintrc.yaml`, `.eslintrc.yml`, or an `eslintConfig` field in
  `package.json`) at the root or in a package directory, while that package (or the root)
  declares ESLint 9 or newer. ESLint 8 and older are not reported.
- **Why it matters:** ESLint 9 only reads `eslint.config.js` by default and ESLint 10
  removed eslintrc support, so the legacy file is ignored or linting fails. A package
  script that sets `ESLINT_USE_FLAT_CONFIG=false` makes ESLint 9 read it on purpose, so
  that case is only informational (the option is gone in ESLint 10).
- **How to fix:** migrate with `npx @eslint/migrate-config .eslintrc.json`.
- **Example:** `.eslintrc.json is a legacy ESLint config, but ESLint 9 only reads eslint.config.js by default`

### `GO_SUM_MISSING`

**Severity:** warning · **Category:** tooling

- **What it checks:** a Go module has direct (non-`// indirect`) requirements that are not
  replaced by a local directory (or, in a `go.work` workspace, provided by another module of
  the repository), but no `go.sum` next to its `go.mod`, or its `go.sum` is ignored by Git.
- **Why it matters:** builds fail with "missing go.sum entry", and dependency checksums are
  not verified.
- **How to fix:** run `go mod tidy` in the module directory and commit `go.sum`.
- **Example:** `go.mod requires 3 modules but there is no go.sum next to it`

### `NEXT_MIDDLEWARE_DEPRECATED`

**Severity:** info · **Category:** tooling

- **What it checks:** a package depends on Next.js 16 or newer and has `middleware.ts` or
  `middleware.js` in its root or `src/`, with no `proxy.ts`/`proxy.js`. Packages that only
  declare `next` as a peer dependency are libraries and are skipped.
- **Why it matters:** Next.js 16 renamed the middleware convention to proxy; `middleware`
  is deprecated.
- **How to fix:** rename the file to `proxy.ts` and the exported function to `proxy`.
- **Example:** `middleware.ts uses the middleware convention, which Next.js 16 renamed to proxy`
