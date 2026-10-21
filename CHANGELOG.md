# Changelog

All notable changes to RepoLens are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). The JSON output has its own
`schemaVersion`; see [docs/json-schema.md](docs/json-schema.md).

## [Unreleased]

### Added

- `ENV_UNDOCUMENTED` treats more host-injected variables as platform-provided (Heroku
  dyno metadata, AWS Lambda, GitLab CI, CircleCI, Travis, Buildkite, Amplify-managed
  names, Coolify, Koyeb, App Engine, Cloud Run and Deno Deploy), so they are not reported
  as missing from `.env.example`. User-set Amplify `AMPLIFY_*` names and `HEROKU_API_KEY`
  stay reportable.

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
