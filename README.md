<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img alt="RepoLens" src="assets/logo-light.svg" width="340">
  </picture>
</p>

<h3 align="center">Understand any repository in seconds.</h3>

<p align="center">
  <a href="https://www.npmjs.com/package/repolens-cli"><img alt="npm version" src="https://img.shields.io/npm/v/repolens-cli?color=0969da"></a>
  <a href="https://github.com/Douglas-Strey/repolens-cli/actions/workflows/ci.yml"><img alt="CI status" src="https://github.com/Douglas-Strey/repolens-cli/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Node.js 22 or newer" src="https://img.shields.io/badge/node-%3E%3D22-417e38">
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <img alt="No telemetry" src="https://img.shields.io/badge/telemetry-none-2da44e">
</p>

<p align="center"><b>English</b> · <a href="README.pt-BR.md">Português (Brasil)</a></p>

RepoLens reads a codebase and tells you how it fits together: the stack, what has to be
running, which environment variables you need, how to start it, and what's misconfigured.

**No configuration needed. No cloud upload. No AI API. It never runs your code.**

```sh
npx repolens-cli
```

<p align="center">
  <img src="assets/demo-scan.svg" alt="RepoLens output for a pnpm + Turborepo monorepo: project type, languages, package manager, runtimes, frameworks per package, workspace packages, a suggested quick start, Docker services with ports, databases, environment variables, scripts, API routes, CI jobs, tooling and one potential issue" width="760">
</p>

## Why

Joining a project usually starts with 20 minutes of archaeology. Which package manager?
Which Node version, and why does the Dockerfile disagree with `.nvmrc`? What has to be
running locally? Which env vars does the code actually read, and why isn't that one in
`.env.example`?

RepoLens does that pass for you, reading only the files in the repository.

## Quick start

```sh
npx repolens-cli              # overview of the current directory
npx repolens-cli doctor       # setup problems, with suggested fixes
npx repolens-cli ../other-repo --json
```

Or install it to use the shorter command, `repolens`:

```sh
brew install douglas-strey/tap/repolens   # macOS and Linux (Homebrew)
npm install -g repolens-cli                # any OS with Node.js 22+
```

Works on macOS, Linux and Windows. The npm package needs Node.js 22 or newer; Homebrew
installs Node for you.

> **Scanning a repository you don't trust?** Run RepoLens from *outside* it, e.g.
> `cd ~ && npx repolens-cli ~/path/to/repo`, or use a global install. When `npx` runs
> inside a repository, npm itself honors that repository's `.npmrc` and `node_modules`,
> which could substitute a different package before RepoLens even starts.

## What it shows

| | |
| --- | --- |
| **Project** | Type (monorepo, app, library, CLI), languages, package manager, runtime versions, Go `main` packages and `bin` commands, Git branch and remote |
| **Frameworks** | Per workspace package, with version and the evidence behind each detection |
| **Workspace** | pnpm / npm / Yarn / Bun workspaces, Turborepo, Nx, Lerna, `go.work`, with each package's framework |
| **Quick start** | Suggested first commands: copy the env file, start Compose services, install, run |
| **Services** | Docker Compose services with images, published ports and profiles, plus Dockerfiles (base images, stages, exposed ports) |
| **Databases** | PostgreSQL, MySQL, MongoDB, Redis, SQLite and more, from drivers, Compose images, env URLs and Prisma / Drizzle / TypeORM config, plus the ORM in use |
| **Environment** | Every variable: is it set in `.env`, documented in `.env.example`, used in code? **Names only**; values are never printed |
| **Scripts** | package.json scripts with the exact command to run them, plus Makefile, justfile, Taskfile and Deno tasks |
| **Routes** | API routes and pages for Nuxt, Next.js, Express, Fastify, NestJS, Hono, Gin, Echo, chi, Fiber, Gorilla mux and `net/http` |
| **CI** | Workflows and what each job does (lint, test, build, deploy, …) |
| **Tooling** | Test frameworks, linters, formatters, type checkers, Git hooks and build tools |

Use `--verbose` to see low-confidence findings, the evidence behind each detection, and
every variable, route and script.

## `repolens doctor`

`doctor` runs 34 checks for problems that cost teams time. Each finding has a stable
code, a one-line explanation and a suggested fix:

<p align="center">
  <img src="assets/demo-doctor.svg" alt="repolens doctor output: checks grouped by category with one environment warning and a suggested fix" width="760">
</p>

Some of the things it catches:

- env vars **used in code but missing from `.env.example`**, and documented ones nothing reads
- **`.env` files tracked by Git**, or not covered by `.gitignore`
- a **real credential committed to `.env.example`** (AWS keys, GitHub tokens, Stripe live keys, …), reported by variable name only
- secrets exposed to the browser (`NEXT_PUBLIC_…SECRET`, `VITE_…PASSWORD`)
- **`package-lock.json` next to `pnpm-lock.yaml`**, or a lockfile that contradicts `packageManager`
- **Node versions that disagree** across `.nvmrc`, `.node-version`, `engines`, Dockerfiles and CI, and end-of-life versions
- a `go.mod` that asks for a newer Go than the Docker image or CI provides
- **two Compose services publishing the same port**, and `DATABASE_URL` pointing at 5433 while Postgres is published on 5432
- `env_file` entries that don't exist, obsolete Compose `version:` keys
- `turbo.json` still using `pipeline` on Turborepo 2, legacy `.eslintrc` with ESLint 9+, duplicated workspace config
- config files that don't parse

See every check in [docs/diagnostics.md](docs/diagnostics.md).

```sh
repolens doctor              # exits 1 on errors
repolens doctor --strict     # also fails on warnings
repolens doctor --json       # for scripts and CI
```

A plain `repolens` scan always exits 0 when it completes, so adding it to a CI log never
breaks a build. Gate on `doctor` instead:

```yaml
- run: npx --yes repolens-cli doctor --fail-on error
```

## Configuration

RepoLens needs no configuration. To adjust it, add a `repolens.config.json` to the project
(shared with everyone who scans it, including CI) or a user config at
`~/.config/repolens/config.json` (your defaults everywhere):

```jsonc
{
  "$schema": "https://unpkg.com/repolens-cli/schema/config.schema.json",
  "ignore": ["legacy/", "src/generated/"],        // .gitignore syntax
  "doctor": {
    "failOn": "warning",                            // default for --fail-on
    "rules": { "ENV_UNUSED": "off", "LOCKFILE_MISSING": "error" }
  },
  "environment": { "provided": ["FLY_*"] }          // set by the platform, never "missing"
}
```

`repolens config` shows which files apply and the settings in effect, and `--no-config`
ignores them all. Configuration is plain JSON that RepoLens never executes, and a
repository's own config can't turn off its security checks. See
[docs/configuration.md](docs/configuration.md).

## JSON output

```sh
repolens --json | jq '.environment.variables[] | select(.used and (.documented | not)) | .name'
repolens --json | jq '.routes.routes[] | "\(.method) \(.path)"'
```

The JSON output is versioned (`"schemaVersion": 1`), deterministic (no timestamps, sorted
arrays, relative paths only) and documented in [docs/json-schema.md](docs/json-schema.md).
TypeScript types are exported from the package:

```ts
import { scan } from 'repolens-cli'

const result = await scan({ cwd: '/path/to/repo' })
console.log(result.frameworks.map((f) => f.name))
```

## Reports and agent context

`repolens report` writes the whole picture as Markdown, which is handy for onboarding docs,
technical audits, or pasting into an AI chat:

```sh
repolens report --output REPOLENS.md
```

`repolens agent init` *(experimental)* generates short, structured context for coding
agents such as Claude Code, Codex, Cursor or Copilot. It covers the commands to run, the
conventions RepoLens can back with evidence ("use pnpm, not npm", "Node 22", "CI runs
lint, test and build"), the structure, services, env var names and known issues:

```sh
repolens agent init        # writes .repolens/*.md
repolens agent             # prints agent-context.md to stdout
```

Point your agent at it from `AGENTS.md` or `CLAUDE.md`. Review the files before committing
them; they never contain secret values.

## Supported technologies

| Area | Support |
| --- | --- |
| Languages | JavaScript, TypeScript and Go in depth. File counts for Python, Rust, Ruby, PHP, Java, Kotlin, Swift, C/C++, C#, Shell and more |
| Package managers | npm, pnpm (including catalogs), Yarn Classic and Berry, Bun, Go modules; `packageManager` and `devEngines` |
| Runtimes | Node.js (`.nvmrc`, `.node-version`, `.tool-versions`, mise, `engines`, Volta, `devEngines`, Dockerfiles, CI), Go, Bun, Deno |
| Monorepos | pnpm, npm, Yarn and Bun workspaces, Turborepo, Nx, Lerna, `go.work` |
| Frameworks | Nuxt, Next.js, Remix, React Router, SvelteKit, Astro, Angular, React, Vue, Svelte, Solid, Preact, Qwik, Express, Fastify, NestJS, Koa, Hono, hapi, Elysia, AdonisJS, tRPC, Electron, React Native, Expo, Gatsby, Docusaurus, VitePress; Go: Gin, Echo, chi, Fiber, Gorilla mux, gRPC, `net/http` |
| Routes | Nuxt (server routes and pages, `srcDir`), Next.js (App and Pages Router, `basePath`, `pageExtensions`), Express, Fastify, NestJS, Hono, Gin, Echo, chi, Fiber, Gorilla mux, `net/http`; router prefixes are resolved across files, including Go routers passed to functions |
| Databases & ORMs | PostgreSQL, MySQL, MariaDB, SQLite/libSQL, MongoDB, Redis/Valkey, CockroachDB, SQL Server, ClickHouse and more; Prisma, Drizzle, TypeORM, Sequelize, MikroORM, Kysely, Knex, Mongoose, GORM, Ent, sqlx, sqlc |
| Containers | Docker Compose (all file names, overrides and variants, long and short syntax), Dockerfiles (multi-stage, `ARG` substitution) |
| CI | GitHub Actions, GitLab CI, CircleCI, Forgejo/Gitea Actions; Azure Pipelines, Jenkins, Travis, Bitbucket, Buildkite, Drone and Woodpecker are listed |
| Tooling | Vitest, Jest, Mocha, AVA, `node:test`, Bun test, Playwright, Cypress, go test, pytest; ESLint, Biome, Oxlint, Prettier, golangci-lint, Ruff; Husky, Lefthook, lint-staged; Vite, webpack, Rollup, esbuild, tsup, tsdown and more |

Other repositories still get languages, Makefile/justfile targets, CI, key config files
and the generic doctor checks. Missing something? [Request a detector](https://github.com/Douglas-Strey/repolens-cli/issues/new?template=detector_request.yml);
most are a table entry and a test.

## Privacy and security

RepoLens is built to be the first thing you run in a repository you don't know yet.

- **It never executes anything from the repository.** No scripts, no config files (it reads
  `nuxt.config.ts` as text), no Docker. It doesn't even run `git`: repository config can
  make `git` run arbitrary commands, so branch, remotes and tracked files are read straight
  from `.git/`.
- **It never prints secret values.** The `.env` parser keeps variable names and throws the
  values away. Committed text it echoes back (scripts, dependency URLs, Git remotes) is
  redacted. The test suite checks that sentinel secrets never show up in any output format.
- **It only reads inside the directory you point it at.** Symlinks are resolved and checked,
  directory symlinks are never followed, and FIFOs, binaries and huge files are skipped.
- **No telemetry, no network.** RepoLens makes no network requests at all.

The full model is in [docs/security.md](docs/security.md). Found a hole? Please
[report it privately](SECURITY.md).

## How it works

RepoLens walks the repository once, respecting `.gitignore` and skipping `node_modules`,
`vendor` and build caches. Independent **detectors** then read what they need through a
shared, cached, sandboxed context, each producing one section of the result. **Doctor
rules** check those facts, and **renderers** turn them into terminal, JSON, Markdown or
agent output.

```
walk (.gitignore-aware) → file index → detectors (parallel, memoized) → doctor rules → renderers
```

Every uncertain finding carries a confidence level and its evidence, and low-confidence
findings stay hidden unless you ask for them. Runtime dependencies are `yaml`, `ignore` and
`semver`, none of which has dependencies of its own. More in
[docs/architecture.md](docs/architecture.md).

**Speed:** on an Apple M1 Max with Node.js 26, scanning this repository (about 420 files)
takes around 35 ms, a synthetic 500-package monorepo (3,000 files) around 250 ms, and
3,000 packages (18,000 files) around 1.2 s. Run `pnpm bench` to measure on your machine.

## Roadmap

**v0.1 (now)**: everything above. JavaScript/TypeScript and Go in depth; terminal, JSON,
Markdown and agent output; 34 doctor checks; user and project configuration files.

**Next**
- Python (Django, Flask, FastAPI, uv/Poetry), Rust (Cargo workspaces), PHP (Laravel, Composer)
- An MCP server (`repolens mcp`) exposing overview, services, env vars, routes, scripts and diagnostics as tools
- More routes: SvelteKit, Remix / React Router, Astro endpoints
- Following Compose `include:`/`extends:` and GitLab `include:`
- Ignoring a single finding (one variable, one file) in the config file, not only whole checks
- Submitting the formula to `homebrew-core` (so `brew install repolens` works without the tap)

**Later**
- A plugin API for third-party detectors (`@repolens/detector-*`)
- Architecture and dependency graphs
- Editor extensions

Nothing on this list exists yet. [ROADMAP.md](ROADMAP.md) describes each item, with where
to start and how big it is, if you'd like to help build one. Ideas and votes are welcome
in [Discussions](https://github.com/Douglas-Strey/repolens-cli/discussions).

## FAQ

**Why is the npm package called `repolens-cli`?**
The `repolens` name on npm was already taken. The command you run is still `repolens`.

**Does it upload my code or use an AI model?**
No. Everything happens locally with static analysis. There is no network access, account
or API key.

**Is it safe on a repository I don't trust?**
That's the main design goal: it never executes project code, config files, hooks or `git`,
and it never reads outside the directory you scan (except the enclosing `.git` metadata
when you scan a subdirectory). See [docs/security.md](docs/security.md).

**It reported something wrong or missed something.**
Please [open an issue](https://github.com/Douglas-Strey/repolens-cli/issues/new/choose)
with the file names involved. Run with `--verbose` to see the evidence behind each
detection.

**How is this different from a linter?**
Linters check code. RepoLens checks how a repository is put together: the setup that
decides whether a new contributor can run it on day one.

## Contributing

Contributions are very welcome, especially new detectors and doctor checks.

```sh
pnpm install
pnpm test
pnpm dev -- ../some-project
```

Start with [CONTRIBUTING.md](CONTRIBUTING.md) and
[docs/creating-a-detector.md](docs/creating-a-detector.md).

## License

[MIT](LICENSE) © Douglas Strey
