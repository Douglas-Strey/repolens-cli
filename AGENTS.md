# Agent instructions

Guidance for AI coding agents (Claude Code, Codex, Cursor, Copilot, …) working in this
repository. Human contributors: see [CONTRIBUTING.md](CONTRIBUTING.md).

## Commits and pull requests — mandatory

- **Never add AI attribution of any kind.** No `Co-Authored-By:` trailers for Claude or
  any other AI tool, no "Generated with Claude Code" / "🤖 Generated with …" lines, no
  links to AI tools, in commit messages, PR titles, PR descriptions, or code comments.
  Commits are authored by the human maintainer only.
- A versioned `commit-msg` hook (`.githooks/commit-msg`) strips such lines as a safety
  net. Enable it once per clone with `git config core.hooksPath .githooks`.
- Don't commit or push unless the maintainer asks you to.
- Commit messages: short imperative subject (≤ 72 chars), optional body explaining *why*.

## Project in one paragraph

RepoLens (`repolens-cli` on npm, command `repolens`) is a TypeScript CLI that statically
analyzes a repository: stack, workspace, env vars, Docker services, databases, routes,
CI, tooling, Git metadata, plus a `doctor` mode with stable diagnostic codes. It must stay
fast, deterministic, local-first and safe on untrusted repositories.

## Commands

```sh
pnpm install
pnpm dev -- <path> [args]   # run the CLI from source (Node's built-in TS support)
pnpm test                   # vitest
pnpm lint                   # biome check (pnpm lint:fix to fix)
pnpm typecheck              # tsc --noEmit
pnpm build                  # tsc → dist/
```

Run `pnpm lint`, `pnpm typecheck` and `pnpm test` before finishing a change.

## Hard rules

1. **Never execute project code** from product code: no scripts, config files, `git`,
   Docker or shell commands. Read project files only through `ctx.readText` /
   `readJson` / `readJsonc` / `readYaml` (they enforce root containment, symlink safety and
   size limits). Tests may use `node:fs` and `git`.
2. **Never output secret values.** Environment variables are reported by name only; echoed
   committed text goes through `redactCommand` / `sanitizeUrl` (`src/utils/redact.ts`).
3. **Deterministic output**: sorted arrays, no timestamps, no absolute paths (posix paths
   relative to the scanned root, `"."` = root).
4. `src/types.ts` is the JSON contract (`schemaVersion`). Only add optional fields;
   changing or removing a field is a breaking change.
5. Diagnostic codes (`ENV_UNDOCUMENTED`, …) are stable and never renamed. Document new ones
   in `docs/diagnostics.md`.
6. No new runtime dependencies without a strong reason (currently: `yaml`, `ignore`,
   `semver`).

## Code style

- Strict TypeScript, ESM, relative imports with `.ts` extensions, no enums / namespaces /
  parameter properties (`erasableSyntaxOnly`), no `any`.
- Detectors: gather inputs through `ctx`, put the logic in exported pure functions, and
  test those directly. Set `confidence` honestly and fill `evidence`.
- Comments explain *why*, not *what*. Match the surrounding code.

## Tests

- Tests scan a **copy** of a fixture (`copyFixture`, `scanFixture`, `fixtureContext` in
  `test/helpers.ts`), never `test/fixtures/` in place.
- Fixture secret values contain `REPOLENS_FIXTURE_SECRET`; it must never appear in output.
- Never commit strings in real credential formats; build them at runtime in tests.
- Renderer snapshots: update with `pnpm vitest run -u` only for intentional output changes.

## Documentation

Docs exist in English and Brazilian Portuguese: `README.pt-BR.md`, `CONTRIBUTING.pt-BR.md`,
`SECURITY.pt-BR.md`, `ROADMAP.pt-BR.md` and `docs/pt-BR/` mirror their English counterparts. English is the
source of truth. When you change a document, make the same change in its pt-BR version
(code, commands, JSON examples and diagnostic codes stay untranslated).
`test/docs/links.test.ts` checks that translations exist, links resolve and code examples
match.

## Where things live

`src/core` (walker, safe reads, scan), `src/config` (configuration files), `src/facts`
(shared analyzers), `src/detectors` (one per output section), `src/doctor/rules`,
`src/output` (terminal/Markdown/JSON), `src/agent` (`.repolens/` generator), `docs/`
(user + contributor docs). See [docs/architecture.md](docs/architecture.md).
