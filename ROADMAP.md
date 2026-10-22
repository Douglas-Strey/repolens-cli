# Roadmap

**English** | [Português (Brasil)](ROADMAP.pt-BR.md)

RepoLens 0.4 covers JavaScript/TypeScript and Go in depth: the overview, 34 doctor checks,
`repolens setup`, `repolens mcp` for AI assistants, terminal, JSON, Markdown and agent
output, and configuration files (including per-finding ignores and a monorepo root's
config). This page lists what comes next, with enough detail that you can pick an item up
and start.

**Want to work on something?** Every item below links to its issue, and the
[roadmap board](https://github.com/users/Douglas-Strey/projects/1) shows what's next, in progress and done. Comment on
the issue saying you're taking it, so two people don't build the same thing (ideas for new
items go in [Discussions](https://github.com/Douglas-Strey/repolens-cli/discussions)). Then read
[CONTRIBUTING.md](CONTRIBUTING.md) and
[docs/creating-a-detector.md](docs/creating-a-detector.md). The ground rules there are not
negotiable: static analysis only, no secret values in any output, deterministic results.

Sizes are rough: **S** is an afternoon, **M** a few evenings, **L** a larger piece of work
best split into several PRs.

## Good first contributions

Small, self-contained changes, usually a table entry plus a test.

- **Missing config files and tools (S, [#1](https://github.com/Douglas-Strey/repolens-cli/issues/1)).** If RepoLens doesn't recognize a config file or a
  tool your project uses, add it to `src/detectors/config-files.ts` or
  `src/detectors/knowledge/tools.ts`, with a test in `test/detectors/`.
- **Platform variables (S, [#2](https://github.com/Douglas-Strey/repolens-cli/issues/2)).** Variables a hosting platform sets on its own (like
  `RENDER_*` or `FLY_*`) must never be reported as undocumented. Add the ones we miss to
  `PLATFORM_NAMES` / `PLATFORM_PREFIXES` in `src/doctor/rules/environment.ts`.
- **Credential formats (S, [#3](https://github.com/Douglas-Strey/repolens-cli/issues/3)).** `ENV_EXAMPLE_REAL_SECRET` recognizes AWS, GitHub, GitLab, npm,
  Slack, Stripe, OpenAI, Anthropic, Google and SendGrid credentials and private keys. More
  formats go in `CREDENTIAL_PATTERNS` (`src/utils/redact.ts`). Patterns must be bounded (no
  catastrophic backtracking; there is a test for it), and test tokens must be built at
  runtime, never committed.
- **Frameworks without routes yet (M).** SvelteKit, Remix / React Router and Astro are
  detected, but their routes are not listed. Each is file-based routing, like the existing
  Nuxt and Next.js extractors in `src/detectors/routes/nuxt.ts` and `next.ts`:
  - SvelteKit ([#4](https://github.com/Douglas-Strey/repolens-cli/issues/4)): `src/routes/**/+page.svelte` (pages) and `+server.ts` (endpoints, one
    exported function per HTTP method).
  - Remix / React Router 7 ([#5](https://github.com/Douglas-Strey/repolens-cli/issues/5)): `app/routes/` file conventions.
  - Astro ([#6](https://github.com/Douglas-Strey/repolens-cli/issues/6)): `src/pages/**/*.astro` (pages) and `src/pages/**/*.{ts,js}` (endpoints).

## Next

### More languages (L)

Today other languages only get file counts, Makefile/justfile targets, CI and the generic
checks. Each ecosystem below needs the same pieces the JavaScript and Go support has:
package manager and lockfile, runtime version pins, frameworks, routes, environment variable
usage, scripts, and doctor checks where they make sense. One language per PR series; start
with detection (package manager, runtime, frameworks) and add routes after.

- **Python ([#7](https://github.com/Douglas-Strey/repolens-cli/issues/7)):** uv (`uv.lock`), Poetry, Pipenv and pip (`requirements*.txt`); runtime from
  `.python-version`, `requires-python` and `.tool-versions`; Django, Flask and FastAPI;
  routes from FastAPI/Flask decorators and Django `urls.py`; env usage through
  `os.environ` / `os.getenv` and pydantic-settings. `src/detectors/knowledge/python.ts`
  already reads `requirements*.txt`, `pyproject.toml` and `Pipfile` (for tools like pytest
  and Ruff) and is the place to start.
- **Rust ([#8](https://github.com/Douglas-Strey/repolens-cli/issues/8)):** `Cargo.toml` and `Cargo.lock`, Cargo workspaces, `rust-toolchain.toml`; Axum,
  Actix Web and Rocket routes; `std::env::var` usage.
- **PHP ([#9](https://github.com/Douglas-Strey/repolens-cli/issues/9)):** `composer.json` and `composer.lock`; Laravel (`routes/web.php`,
  `routes/api.php`) and Symfony.

### Smaller improvements (S–M)

- **homebrew-core ([#15](https://github.com/Douglas-Strey/repolens-cli/issues/15)).** Submit the formula so `brew install repolens` works without the tap,
  once the project meets Homebrew's notability requirements.

## Later

- **Plugin API** ([#16](https://github.com/Douglas-Strey/repolens-cli/issues/16)) for third-party detectors (`@repolens/detector-*`). Needs a stable
  detector interface and a trust model: plugins run code, scans never do.
- **Architecture and dependency graphs** ([#17](https://github.com/Douglas-Strey/repolens-cli/issues/17)), for example Mermaid output of workspace packages
  and the services they talk to.
- **Editor extensions** ([#18](https://github.com/Douglas-Strey/repolens-cli/issues/18)) built on `repolens --json`.
- **Translated CLI output ([#19](https://github.com/Douglas-Strey/repolens-cli/issues/19)).** The docs are in English and Portuguese; the CLI only speaks
  English. Needs a message catalog; diagnostic codes and JSON output stay the same.

## Not planned

Anything that breaks the ground rules: running project code or `git`, uploading anything,
telemetry, or requiring an AI API.
