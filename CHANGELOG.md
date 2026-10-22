# Changelog

All notable changes to RepoLens are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). The JSON output has its own
`schemaVersion`; see [docs/json-schema.md](docs/json-schema.md).

## [Unreleased]

## [0.5.0] - 2026-10-22

### Added

- `RUNTIME_VULNERABLE`: `repolens doctor` reports an exact PHP, Node.js or Go version that
  is older than the latest security release of its line, pinned in a Dockerfile, a CI
  setup step, a GitLab CI image or a version file. The diagnostic names the files, how
  many security releases the pin misses, the severity the project gave them, the CVEs and
  the version to upgrade to. Missing a fix rated critical is an error. The security
  releases come from php.net, the Node.js security posts and the Go release history, in
  a table that ships with RepoLens (updated 2026-10-22), so the scan stays offline. A
  repository's own config can't turn the check off.
  ([#36](https://github.com/Douglas-Strey/repolens-cli/issues/36))
- PHP runtime detection: `composer.json` (`require.php`, `config.platform.php`),
  `.php-version`, `.tool-versions`, mise, official `php` Docker images and
  `shivammathur/setup-php` in GitHub Actions.
- `repolens doctor --online` (`DEPENDENCY_VULNERABLE`): looks the exact versions in the
  project's lockfiles up in OSV.dev and reports each package version with known
  vulnerabilities, with the highest rating, the advisory and CVE ids and the version that
  fixes them. It reads `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`,
  `yarn.lock` (classic and Berry), `bun.lock`, `composer.lock` and `go.mod`. It is the
  only feature that uses the network, and only with the flag: it sends package names and
  versions, nothing else. Without `--online` RepoLens stays fully offline.
  ([#36](https://github.com/Douglas-Strey/repolens-cli/issues/36))

## [0.4.0] - 2026-10-22

### Added

- `repolens mcp`: a Model Context Protocol server over stdio, so AI assistants (Claude
  Code, Codex, Cursor, …) can ask about the project. Six tools (`get_project_overview`,
  `get_services`, `get_environment_variables`, `get_routes`, `get_scripts`,
  `get_diagnostics`) answer with the matching part of the Markdown report, or JSON on
  request, for the project or a subdirectory inside it, scanning the files fresh on every
  call. The protocol is implemented in RepoLens, with no new dependency, for both the
  2026-07-28 revision and the earlier `initialize` ones. Without a path it serves
  `$CLAUDE_PROJECT_DIR` when set. ([#10](https://github.com/Douglas-Strey/repolens-cli/issues/10))
- `ENV_UNDOCUMENTED` treats more host-injected variables as platform-provided (Heroku
  dyno metadata, AWS Lambda, GitLab CI, CircleCI, Travis, Buildkite, Amplify-managed
  names, Coolify, Koyeb, App Engine, Cloud Run and Deno Deploy), so they are not reported
  as missing from `.env.example`. User-set Amplify `AMPLIFY_*` names and `HEROKU_API_KEY`
  stay reportable. ([#2](https://github.com/Douglas-Strey/repolens-cli/issues/2))
- Git's ignore rules from outside the scanned directory now apply: when you scan a
  subdirectory, the `.gitignore` files of the directories above it up to the repository
  root, and in every repository its `info/exclude` (also from a linked worktree) and your
  global excludes file (`core.excludesFile` from your own Git config, else
  `~/.config/git/ignore`). Still without running `git`. The programmatic `scan()` applies
  the global file only when you pass `gitExcludesFile` (see `gitExcludesFile()`).
  `ENV_FILE_NOT_IGNORED` and `GITIGNORE_NODE_MODULES` now run when you scan a subdirectory
  too, unless Git ignores that directory as a whole. `GITIGNORE_NODE_MODULES` and the
  lockfile check count only the repository's `.gitignore` files, since `info/exclude` and
  the global file protect only your machine (`FileIndex.isIgnored` takes `shared: true`
  for that).
  ([#14](https://github.com/Douglas-Strey/repolens-cli/issues/14))
- Docker Compose `include` and `extends`: services from included files join the project
  of the file that includes them (port conflicts, `docker compose up` and missing
  `env_file` checks see them), and a service that extends another one inherits its image,
  ports, environment, env files and build, with paths resolved as Compose does. In JSON,
  an included service has `includedFrom`. GitLab CI local `include` (wildcards and nested
  includes too): included jobs are merged into the pipeline the way GitLab merges them,
  and the workflow lists them under `includes`. Only files inside the scanned directory
  are read, never URLs. ([#12](https://github.com/Douglas-Strey/repolens-cli/issues/12))
- GitLab CI job `extends`: a job gets the script, image and tags of the templates it
  extends (one or a list, later ones winning), so its tasks and `runsOn` reflect them.
  ([#31](https://github.com/Douglas-Strey/repolens-cli/issues/31))

## [0.3.0] - 2026-10-21

### Added

- Monorepos: when you scan a subdirectory of a Git repository, the repository root's
  configuration applies too, below the scanned directory's own. Its `ignore` patterns are
  relative to the root, like a root `.gitignore`. Nothing above the repository root is
  read, the root's file has the same limits as any project config, and `--config` replaces
  both. ([#13](https://github.com/Douglas-Strey/repolens-cli/issues/13))
- `doctor.ignore` in configuration files leaves single findings out by check code and
  subject (`*` wildcards allowed), while the check keeps reporting everything else.
  Ignored findings don't count toward `--fail-on` but are never hidden: the summary counts
  them, `--verbose` lists them, and `--json` output has them under `ignored` with
  `summary.ignored`. `--verbose` prints the entry to copy for every finding. An entry that
  matches nothing is reported, and a project's own config can't ignore security findings.
  ([#11](https://github.com/Douglas-Strey/repolens-cli/issues/11))

## [0.2.0] - 2026-10-21

### Added

- `repolens setup`: sets up a freshly cloned project by creating the local env file from
  the example, starting the backing services with Docker Compose and installing
  dependencies (npm, pnpm, Yarn, Bun, Go modules). It shows the plan first, including the
  install lifecycle scripts and Compose images involved, and asks before running anything.
  `--dry-run` shows the plan only, `--yes` skips the question, and `--ignore-scripts`
  installs without lifecycle scripts. Project scripts are left for you to run, programs
  are never taken from the repository, and existing env files are never changed. It is
  the only command that runs anything; see docs/security.md.
- `ENV_EXAMPLE_REAL_SECRET` and command redaction recognize Hugging Face, Shopify, PyPI and
  DigitalOcean tokens and Linear API keys. Thanks to @umeraamir69 for the first outside
  contribution (#25).

### Fixed

- Two regular expressions (the `rm -rf` check for agent examples and a cleanup of
  package-manager evidence) could take quadratic time on crafted input. Inputs were
  already capped, so no repository could trigger it; both now run in linear time.
- The Homebrew formula script waits up to about 12 minutes for a just-published npm
  tarball instead of 2, so the tap update no longer fails right after a release.

### Changed

- `ignore` updated to 7.0.12.

## [0.1.1] - 2026-10-20

No changes to the CLI or the API.

### Changed

- First version published by the release workflow through npm trusted publishing, so the
  package now carries an npm provenance attestation linking it to its source commit.
- Development docs: `HOMEBREW_TAP_TOKEN` must be a repository secret, not an environment
  secret, for the release workflow to update the Homebrew tap.

## [0.1.0] - 2026-10-20

First public release, on npm as `@douglas-strey/repolens`.

### Added

- `repolens` / `repolens scan`: repository overview covering project type, languages,
  package manager, runtime versions, entry points, Git branch and remote, frameworks per
  package, workspace packages, a suggested quick start, Docker Compose services and
  Dockerfiles, databases and ORMs, environment variables (names only), scripts (package.json,
  Makefile, justfile, Taskfile, Deno), API routes and pages, CI workflows and tooling.
- `repolens doctor` with 34 checks and stable diagnostic codes across environment,
  security, runtime, package manager, workspace, Docker, scripts, Git, tooling and
  configuration; `--fail-on` and `--strict` for CI.
- `repolens report`: Markdown report for onboarding, audits and documentation.
- `repolens agent` and `repolens agent init` (experimental): concise context files for
  coding agents in `.repolens/`.
- Configuration files: a project's `repolens.config.json` (or `"repolens"` in package.json)
  and a user config (`~/.config/repolens/config.json`) with `ignore` patterns, `maxFiles`,
  `doctor.failOn`, per-check `doctor.rules`, `environment.provided` and output preferences;
  `--config`, `--no-config` and `repolens config`. A JSON Schema ships in
  `schema/config.schema.json`.
- `--json` output with `schemaVersion: 1`, and a programmatic API (`scan()` and typed results).
- Distribution through npm (`npx @douglas-strey/repolens`) and a Homebrew tap
  (`brew install douglas-strey/tap/repolens`).
- Route extraction for Nuxt, Next.js (App and Pages Router), Express, Fastify, NestJS, Hono,
  Gin, Echo, chi, Fiber, Gorilla mux and `net/http`, with prefix resolution across files,
  Next.js `basePath`/`pageExtensions` and Nuxt `srcDir`.
- Clear usage errors instead of silently ignored flags (`--strict` outside `doctor`,
  `report --json`, `doctor --markdown`, `-q` with `-v`), and suggestions for mistyped
  commands.
- Security model: no execution of project code or `git`, secret values never printed,
  reads confined to the scanned directory, limits against hostile input, no telemetry and
  no network access.
