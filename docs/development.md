# Development

**English** | [Português (Brasil)](pt-BR/development.md)

## Setup

You need Node.js 24 (see `.nvmrc`; Node 22.18+ also works) and pnpm. The pnpm version is
pinned in `package.json` (`packageManager`): install it with `npm install -g pnpm@11` or
`corepack enable` if you have Corepack (it is no longer bundled with Node.js 25+).

```sh
git clone https://github.com/Douglas-Strey/repolens-cli.git
cd repolens-cli
pnpm install
git config core.hooksPath .githooks   # commit-msg hook (strips AI attribution trailers)
pnpm test
pnpm dev -- ../some-project        # run the CLI from source against any directory
```

`pnpm dev` runs `src/cli.ts` directly with Node's built-in TypeScript support. There is no
build step or watcher to keep running.

## Scripts

| Script | What it does |
| --- | --- |
| `pnpm dev -- [args]` | Run the CLI from source, e.g. `pnpm dev -- doctor ../app --verbose`. |
| `pnpm test` | Run the test suite once (Vitest). |
| `pnpm test:watch` | Re-run tests on change. |
| `pnpm coverage` | Tests with a coverage report in `coverage/`. |
| `pnpm lint` | Lint and check formatting (Biome). `pnpm lint:fix` fixes what it can. |
| `pnpm typecheck` | Type-check everything (TypeScript, no emit). |
| `pnpm build` | Compile `src/` to `dist/`. |
| `pnpm bench [path]` | Time scans of a directory (default: this repository). `--generate <n>` benchmarks a synthetic monorepo with `n` packages. |
| `pnpm check` | Lint, typecheck and test, which is what CI runs. |

## Project layout

```
src/
  cli.ts              bin entry (keep it tiny)
  cli/                argument parsing, help text, command dispatch, exit codes
  core/               walker, file index, safe file reads, parsing, scan orchestration
  config/             configuration files: loading, validation, merging
  facts/              shared analyzers: manifests, dependency index, source files, Git
  detectors/          one detector per section of the scan result
  doctor/             doctor runner and rules (rules/*.ts)
  output/             terminal, Markdown and JSON renderers
  agent/              .repolens/ agent context generator
  utils/              small helpers (paths, globs, redaction, versions)
  types.ts            every public type; the JSON output contract
  index.ts            programmatic API
test/
  fixtures/           small realistic repositories (see fixtures/README.md)
  helpers.ts          copyFixture, makeProject, runCli, gitInit, …
  factories.ts        hand-built scan results for renderer and doctor tests
docs/                 user and contributor documentation
schema/               JSON Schema for configuration files (shipped in the package)
scripts/              benchmark, release helpers, screenshot generator
```

See [architecture.md](architecture.md) for how the pieces fit together and
[creating-a-detector.md](creating-a-detector.md) for adding support for a technology.

## Tests

- **Detectors** are tested against copies of the fixtures in `test/fixtures/` and against
  small projects built inline with `makeProject({ 'package.json': '…' })`.
- **Renderers** are tested with snapshot files built from `test/factories.ts`. When you
  change the output on purpose, update snapshots with `pnpm vitest run -u` and review the
  diff.
- **Security behavior** has dedicated tests: secret sentinel values in fixtures must never
  appear in any output, symlinks can't escape the root, FIFOs don't hang the scan, and the
  `git` binary is never executed.
- Tests always scan a **copy** of a fixture in a temporary directory, so this repository's
  own `.git` never leaks into results.

A few tests create symlinks, FIFOs or unreadable files. They are skipped automatically on
platforms that don't support them (for example FIFOs on Windows).

## Debugging

```sh
pnpm dev -- ../app --verbose                  # evidence, low-confidence findings, parser errors
REPOLENS_DEBUG=1 pnpm dev -- ../app --json    # also per-detector timings and skipped files on stderr
pnpm dev -- ../app --json | jq .meta
```

Debug lines go to stderr, so they stay separate from `--json` output.

## Releasing

1. Update `CHANGELOG.md` (move items from "Unreleased" into a new version section).
2. Bump the version: `npm version <patch|minor|major> --no-git-tag-version`, then commit.
3. Tag and push: `git tag v1.2.3 && git push origin main --tags`.

The [release workflow](../.github/workflows/release.yml) runs the full check suite and
publishes to npm with **trusted publishing** (OIDC, with provenance). There is no npm
token stored in the repository. It then creates a GitHub release from the changelog
section.

Before the first automated release, the package has to exist on npm and have a trusted
publisher configured. Publish the first version manually (`npm publish --access public`),
then on npmjs.com open the package settings, choose **Trusted publisher → GitHub Actions**,
and enter the repository (`Douglas-Strey/repolens-cli`), the workflow file (`release.yml`) and
the environment (`npm`). Then push that version's tag as usual: the workflow sees the
version is already on npm, skips publishing, and still creates the GitHub release and
updates the Homebrew tap.

### Homebrew

`brew install douglas-strey/tap/repolens` installs from the
[`Douglas-Strey/homebrew-tap`](https://github.com/Douglas-Strey/homebrew-tap) repository.
The formula installs the published npm tarball with Homebrew's Node.js, the standard
pattern for Node CLIs. `scripts/homebrew-formula.ts` generates it:

```sh
node scripts/homebrew-formula.ts 0.1.0                        # hashes the tarball on npm
node scripts/homebrew-formula.ts 0.1.0 --tarball repolens-cli-0.1.0.tgz   # before publishing
```

The release workflow's `homebrew` job regenerates `Formula/repolens.rb` in the tap and
pushes it after every npm release. One-time setup:

1. Create the public repository `Douglas-Strey/homebrew-tap` with an empty `Formula/`
   directory. The `homebrew-` prefix is what makes `douglas-strey/tap` work.
2. Create a fine-grained personal access token limited to that repository with
   **Contents: read and write**, and give it an expiry date.
3. Add it to this repository as the `HOMEBREW_TAP_TOKEN` Actions secret (environment
   `npm`). Without the secret the job is skipped and the formula can be updated by hand
   with the script above.

Once the project meets Homebrew's notability requirements, the same formula can be
submitted to `homebrew-core`.
