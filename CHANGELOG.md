# Changelog

All notable changes to RepoLens are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). The JSON output has its own
`schemaVersion`; see [docs/json-schema.md](docs/json-schema.md).

## [Unreleased]

First public release (0.1.0). Move these entries under `## [0.1.0] - <date>` when releasing.

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
- Distribution through npm (`npx repolens-cli`) and a Homebrew tap
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
