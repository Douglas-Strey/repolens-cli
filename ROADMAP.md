# Roadmap

**English** | [Português (Brasil)](ROADMAP.pt-BR.md)

RepoLens 0.1 covers JavaScript/TypeScript and Go in depth: the overview, 34 doctor checks,
terminal, JSON, Markdown and agent output, and configuration files. This page lists what
comes next, with enough detail that you can pick an item up and start.

**Want to work on something?** Comment on its issue, or open one (or a
[Discussion](https://github.com/Douglas-Strey/repolens-cli/discussions)) saying which item
you're taking, so two people don't build the same thing. Then read
[CONTRIBUTING.md](CONTRIBUTING.md) and
[docs/creating-a-detector.md](docs/creating-a-detector.md). The ground rules there are not
negotiable: static analysis only, no secret values in any output, deterministic results.

Sizes are rough: **S** is an afternoon, **M** a few evenings, **L** a larger piece of work
best split into several PRs.

## Good first contributions

Small, self-contained changes, usually a table entry plus a test.

- **Missing config files and tools (S).** If RepoLens doesn't recognize a config file or a
  tool your project uses, add it to `src/detectors/config-files.ts` or
  `src/detectors/knowledge/tools.ts`, with a test in `test/detectors/`.
- **Platform variables (S).** Variables a hosting platform sets on its own (like
  `RENDER_*` or `FLY_*`) must never be reported as undocumented. Add the ones we miss to
  `PLATFORM_NAMES` / `PLATFORM_PREFIXES` in `src/doctor/rules/environment.ts`.
- **Credential formats (S).** `ENV_EXAMPLE_REAL_SECRET` recognizes AWS, GitHub, GitLab, npm,
  Slack, Stripe, OpenAI, Anthropic, Google and SendGrid credentials and private keys. More
  formats go in `CREDENTIAL_PATTERNS` (`src/utils/redact.ts`). Patterns must be bounded (no
  catastrophic backtracking; there is a test for it), and test tokens must be built at
  runtime, never committed.
- **Frameworks without routes yet (M).** SvelteKit, Remix / React Router and Astro are
  detected, but their routes are not listed. Each is file-based routing, like the existing
  Nuxt and Next.js extractors in `src/detectors/routes/nuxt.ts` and `next.ts`:
  - SvelteKit: `src/routes/**/+page.svelte` (pages) and `+server.ts` (endpoints, one
    exported function per HTTP method).
  - Remix / React Router 7: `app/routes/` file conventions.
  - Astro: `src/pages/**/*.astro` (pages) and `src/pages/**/*.{ts,js}` (endpoints).

## Next

### More languages (L)

Today other languages only get file counts, Makefile/justfile targets, CI and the generic
checks. Each ecosystem below needs the same pieces the JavaScript and Go support has:
package manager and lockfile, runtime version pins, frameworks, routes, environment variable
usage, scripts, and doctor checks where they make sense. One language per PR series; start
with detection (package manager, runtime, frameworks) and add routes after.

- **Python:** uv (`uv.lock`), Poetry, Pipenv and pip (`requirements*.txt`); runtime from
  `.python-version`, `requires-python` and `.tool-versions`; Django, Flask and FastAPI;
  routes from FastAPI/Flask decorators and Django `urls.py`; env usage through
  `os.environ` / `os.getenv` and pydantic-settings. `src/detectors/knowledge/python.ts`
  already reads `requirements*.txt`, `pyproject.toml` and `Pipfile` (for tools like pytest
  and Ruff) and is the place to start.
- **Rust:** `Cargo.toml` and `Cargo.lock`, Cargo workspaces, `rust-toolchain.toml`; Axum,
  Actix Web and Rocket routes; `std::env::var` usage.
- **PHP:** `composer.json` and `composer.lock`; Laravel (`routes/web.php`,
  `routes/api.php`) and Symfony.

### `repolens mcp`: an MCP server (M)

Expose the scan to AI assistants as MCP tools over stdio. The internal API already maps
onto the tools (see "Ready for MCP" in [docs/architecture.md](docs/architecture.md)), so
the command is a thin adapter over `scan()`. RepoLens has three runtime dependencies and
adding one needs discussion: open an issue on whether to use the official SDK or a small
JSON-RPC implementation before starting.

### Configuration: ignore a single finding (M)

`doctor.rules` can turn off a whole check. Projects also need to silence one finding (one
variable, one file) and keep the check. Proposed shape:

```json
{ "doctor": { "ignore": [{ "code": "ENV_UNDOCUMENTED", "subject": "LEGACY_TOKEN" }] } }
```

It must follow the rules in [docs/configuration.md](docs/configuration.md): a project's own
file can't hide security findings, and the output says how many findings were ignored.
Touches `src/config/`, `src/doctor/index.ts`, `schema/config.schema.json` and the docs in
both languages.

### Smaller improvements (S–M)

- **Compose `include:` and `extends:`, GitLab CI `include:`.** Follow local includes
  (never URLs) so services and CI jobs defined in other files show up.
  `src/facts/compose.ts`, `src/detectors/ci.ts`.
- **Config lookup from a subdirectory.** When you scan `apps/web`, also read the
  repository root's `repolens.config.json`, the way `.git` is already found above the
  scanned directory. `src/config/load.ts`.
- **Parent `.gitignore` files and `core.excludesFile`.** When scanning a subdirectory of a
  repository, apply the ignore files above it, still without running `git`.
  `src/core/walker.ts`.
- **homebrew-core.** Submit the formula so `brew install repolens` works without the tap,
  once the project meets Homebrew's notability requirements.

## Later

- **Plugin API** for third-party detectors (`@repolens/detector-*`). Needs a stable
  detector interface and a trust model: plugins run code, scans never do.
- **Architecture and dependency graphs**, for example Mermaid output of workspace packages
  and the services they talk to.
- **Editor extensions** built on `repolens --json`.
- **Translated CLI output.** The docs are in English and Portuguese; the CLI only speaks
  English. Needs a message catalog; diagnostic codes and JSON output stay the same.

## Not planned

Anything that breaks the ground rules: running project code or `git`, uploading anything,
telemetry, or requiring an AI API.
