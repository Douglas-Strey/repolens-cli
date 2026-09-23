# Contributing to RepoLens

**English** | [Português (Brasil)](CONTRIBUTING.pt-BR.md)

Thanks for helping! RepoLens gets better every time someone teaches it about a framework,
a config file or a setup mistake it didn't know yet.

## Ways to help

- **Pick an item from the [roadmap](ROADMAP.md).** Each one says where to start and how
  big it is.
- **Try it on your repositories** and [open an issue](https://github.com/Douglas-Strey/repolens-cli/issues/new/choose)
  when it gets something wrong. A wrong detection is a bug, and a missed one is a detector request.
- **Add or improve a detector.** See [docs/creating-a-detector.md](docs/creating-a-detector.md);
  most additions are a table entry plus a test.
- **Add a doctor check** for a setup problem that cost you time.
- **Improve the docs.** If something confused you, it will confuse others.

## Development setup

```sh
git clone https://github.com/Douglas-Strey/repolens-cli.git
cd repolens-cli
pnpm install
git config core.hooksPath .githooks
pnpm test
pnpm dev -- ../some-project
```

You need Node.js 24 (Node 22.18+ works) and pnpm 11 (`npm install -g pnpm@11`; the exact
version is pinned in `package.json`). [docs/development.md](docs/development.md) covers the scripts, the project
layout and debugging.

## Ground rules

These keep RepoLens trustworthy on untrusted repositories. PRs that break them can't be
merged, however useful they are otherwise.

1. **Static analysis only.** Never execute project code, config files, scripts, `git`,
   Docker or shell commands. Read files through `ctx.readText` / `readJson` / `readJsonc`
   / `readYaml`.
2. **Never output secret values.** Environment variables are reported by name. Anything
   echoed from committed files goes through the helpers in `src/utils/redact.ts`.
3. **Prefer a miss over a false positive.** Use `confidence` honestly and fill `evidence`.
   Low-confidence findings are hidden by default.
4. **Deterministic output.** Sorted collections, no timestamps, no absolute paths.
5. **No new runtime dependencies** without discussing it in an issue first.

## Pull requests

- Keep PRs focused: one detector, one check or one fix per PR is ideal.
- Add tests. Detection logic needs a fixture or an inline test project, and output changes
  need updated snapshots (`pnpm vitest run -u`, then review the diff).
- Run `pnpm check` (lint + typecheck + tests) before pushing. CI runs lint and typecheck
  on Linux and the tests on Linux, macOS and Windows with Node.js 22, 24 and 26.
- Update the docs when behavior changes: `docs/json-schema.md` for JSON output,
  `docs/diagnostics.md` for doctor checks, and the supported-technologies table in the
  README for new detectors.
- Add a line under **Unreleased** in `CHANGELOG.md` for user-facing changes.
- Commit messages: a short imperative subject ("Detect SvelteKit routes"), plus a body
  explaining *why* when it isn't obvious. Don't add AI attribution trailers; the
  `commit-msg` hook in `.githooks/` strips them.

## Translations

The documentation is available in English and Brazilian Portuguese (`README.pt-BR.md`,
`CONTRIBUTING.pt-BR.md`, `SECURITY.pt-BR.md`, `ROADMAP.pt-BR.md` and `docs/pt-BR/`). English is the source of
truth. When you change a document that has a translation, update the translation in the
same PR if you can; otherwise say so in the PR and it will be updated separately. Code,
commands, JSON examples and diagnostic codes are never translated, and a test checks that
every document has a translation with the same code examples.

## Stability promises

- Diagnostic codes (`ENV_UNDOCUMENTED`, …) are never renamed or reused.
- The JSON output only gains optional fields within a `schemaVersion`. Removing or
  changing a field requires a new schema version.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Be kind; assume good
intent.

## Security issues

Please don't open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).
