# RepoLens threat model

Notes for security scanners and reviewers (including Anthropic's OSS Scanner). The
user-facing version of these rules is [docs/security.md](../docs/security.md); the
reporting policy is [SECURITY.md](../SECURITY.md).

## What RepoLens is

A command-line tool (`repolens`, npm package `@douglas-strey/repolens`) and a small
programmatic API (`scan()`) that statically analyze a local repository and print an
overview, setup diagnostics (`repolens doctor`), a Markdown report, or context files for
coding agents. It is meant to be the **first thing someone runs in a repository they don't
trust yet**: a fresh clone, a candidate's take-home project, a vendor's code drop.

`repolens setup` is the one command that runs programs: after showing a plan and asking,
it copies the example env file, runs `docker compose up -d` and the package manager's
install.

## Trust boundaries

**Adversarial (attacker-controlled):** everything inside the scanned directory and its
enclosing `.git` metadata. That includes file contents, file and directory names
(newlines, control characters, shell metacharacters, leading dashes), symlinks and
hard links, FIFOs and other special files, `.gitignore` rules, `.git/HEAD`, `.git/config`,
`packed-refs`, the binary `.git/index`, a `.git` *file* pointing elsewhere, the project's
`repolens.config.json` (or the `"repolens"` key of `package.json`), and sizes and nesting
designed to exhaust resources.

**Trusted:** the person running RepoLens and everything they control: command-line
arguments, the user config file (`~/.config/repolens/config.json` or `$REPOLENS_CONFIG`), a
file passed with `--config`, environment variables, `PATH`, the installed Node.js, package
managers and Docker, and callers of the programmatic API.

The victim is the person running RepoLens (and, for `--output`/`agent init`/`setup`, their
file system), plus anyone who copies a command RepoLens suggests into a shell.

## In scope, by severity

Severity reflects what an attacker who controls the scanned repository can achieve when the
victim runs RepoLens on it.

### Critical

- **Code execution during analysis.** `repolens`, `scan`, `doctor`, `report`, `agent` and
  `config` must never execute anything from the repository: no scripts, no
  importing/evaluating config files (they are read as text), no `git` binary, no Docker, no
  shell. Any path from repository content to execution in these commands.
- **`repolens setup` running something it didn't show or wasn't allowed to.** Setup must
  run only the commands printed in its plan, only after a "yes" in a terminal or `--yes`,
  only programs found on `PATH` outside the repository (absolute path, no shell), and never
  project scripts (`make setup`, `pnpm db:up`). Examples: an argument injected into the
  `docker compose` or install command line, a program resolved from inside the repository
  (`node_modules/.bin`, a relative `PATH` entry, a link into the repo, Windows' current
  directory search), `cmd.exe` reinterpreting arguments of a `.cmd` shim, the plan hiding a
  project lifecycle script that install will run.

### High

- **Secret disclosure.** Environment variable *values* (from `.env`-style files and
  Compose `environment:` blocks) must never appear in any output: terminal, `--json`,
  `--markdown`, `report`, `agent` files, warnings, error messages, debug output
  (`REPOLENS_DEBUG=1`) or stack traces. The `.env` parser (`src/core/dotenv.ts`) drops values
  inside the parser.
- **Reading outside the scanned directory** and reflecting the content in output: symlinks
  (including symlinked parent directories), `..` traversal, a crafted `.git` file or
  `commondir`/`gitdir` pointer, the setup env-file copy following a link.
- **Writing outside the intended location.** `--output`, `agent init` and setup's env file
  must not write through a symlink, open a FIFO, escape the scanned directory through a
  link, or overwrite an existing file (setup never overwrites; `agent init` only overwrites
  its own generated files without `--force`).
- **Command injection in suggested commands.** Commands RepoLens prints for copy-and-paste
  (quick start, `docker compose -f <file> up -d <services>`, `cp <example> <target>`, script
  invocations) embed repository-controlled names. They go through `shellQuote`
  (`src/utils/commands.ts`) and `isCopyableCommand` (`src/output/commands.ts`); a name that
  turns a suggestion into a different shell command is a bug.
- **The release pipeline.** Anything that lets someone other than a maintainer publish to
  npm (`.github/workflows/release.yml`, trusted publishing through the `npm` environment)
  or push to the Homebrew tap.

### Medium

- **Terminal injection.** Repository text in output passes through `cleanUntrusted`
  (`src/utils/text.ts`), which strips control, bidi, zero-width and Unicode tag
  characters. Escape sequences that move the cursor, rewrite earlier lines, set the window
  title, create hyperlinks (OSC 8) or otherwise forge what the victim sees.
- **A repository hiding its own problems.** A project's `repolens.config.json` must not be
  able to turn off or lower the security checks (`ENV_PUBLIC_SECRET`,
  `ENV_EXAMPLE_REAL_SECRET`, `TRACKED_ENV_FILE`, `ENV_FILE_NOT_IGNORED`), make a Git-tracked
  `.env` look ignored, raise `maxFiles` above 1,000,000 or set terminal preferences.
- **Denial of service.** Hangs, unbounded memory or CPU on crafted input: huge or binary
  files, FIFOs, deep or huge trees, YAML alias bombs, pathological `.gitignore` rules,
  regular expressions with catastrophic backtracking in route and env-variable extraction,
  malformed `.git/index`. Limits are listed in docs/security.md §4; bypassing one is in scope.

### Low

- Gaps in redaction of *committed* text RepoLens echoes back (package.json script bodies,
  dependency URLs, Git remote URLs). This is defense in depth: the text is already in the
  repository. Credentials embedded in remote URLs are expected to be removed
  (`sanitizeUrl` in `src/utils/redact.ts`).
- Absolute paths from the victim's machine appearing in output (outputs are meant to be
  relative to the scanned directory).

## Out of scope

- **What `repolens setup` is documented to run, after the user agrees:** the package
  manager's install and the lifecycle scripts of the project and its dependencies (the
  plan lists the project's own; `--ignore-scripts` skips them all), and the images
  Docker Compose pulls or builds. Malicious code in those is the repository's, not a
  RepoLens vulnerability, unless setup failed to disclose or ran it without consent.
- **npm resolving the package inside an untrusted repository** (`npx` honoring the
  repository's `.npmrc` or `node_modules` before RepoLens starts). Documented, with the
  mitigation of running from outside the repository.
- **Trusted inputs:** malicious command-line arguments, user config, `--config` files,
  environment variables, `PATH` directories outside the repository, programmatic API
  options, or a compromised Node.js, package manager or Docker installation.
- **Detection accuracy** (a missed framework, a wrong diagnostic) without a security
  consequence. Please file those as regular issues.
- **Vulnerabilities in dependencies** (`yaml`, `ignore`, `semver`) that RepoLens's use of
  them doesn't make reachable. Report those upstream.
- **Development-only code:** `scripts/` (screenshot, benchmark, release helpers run by
  maintainers), test fixtures, and the `demo/` assets.
- **Secrets committed in plain text in a scanned repository** being visible in output
  other than env-variable values (see Low): RepoLens reports on the repository; it can't
  un-commit them.

## Where the boundaries live in the code

| Concern | Code |
| --- | --- |
| Reading project files inside the root only | `src/core/fs.ts` (`readTextWithin`), `src/core/context.ts` |
| Walking the tree (no directory symlinks, limits) | `src/core/walker.ts`, `src/core/file-index.ts` |
| Git metadata without running `git` | `src/facts/git.ts`, `src/detectors/git.ts` |
| `.env` parsing that drops values | `src/core/dotenv.ts` |
| Redaction of echoed text | `src/utils/redact.ts` |
| Terminal-safe text | `src/utils/text.ts` (`cleanUntrusted`) |
| Shell quoting of suggestions | `src/utils/commands.ts`, `src/output/commands.ts` |
| Project config limits | `src/config/` |
| Writing output files | `src/cli/main.ts` (`writeFileSafely`, `assertStaysInside`) |
| Setup plan, program lookup, execution | `src/setup/plan.ts`, `src/setup/host.ts`, `src/cli/setup.ts` |
| Release and publishing | `.github/workflows/release.yml`, `scripts/lib/homebrew.ts` |

## Building and testing offline

```sh
pnpm install --frozen-lockfile   # needs network; everything below runs offline
pnpm build
pnpm test                        # vitest: unit, integration and adversarial tests
node dist/cli.js <path-to-crafted-repo>
node dist/cli.js doctor <path> --json
node dist/cli.js setup <path> --dry-run   # shows the plan, runs nothing
```

Fixture secret values contain the sentinel `REPOLENS_FIXTURE_SECRET`, and tests assert it
never appears in any output format: a proof of concept that makes a sentinel value appear
is a convincing one. `REPOLENS_DEBUG=1` adds debug lines on stderr.

## How we'd like reports

- **Proof of concept:** a minimal repository (a file tree with contents, or a script that
  creates it), the exact command run, and the observed versus expected result. Build
  credential-shaped strings at runtime rather than committing real-looking ones.
- **Root cause:** the file and function where the boundary fails.
- **Patch:** a minimal fix plus a regression test in `test/` in the style of the existing
  ones (tests scan a copy of a fixture or a temp project made with `makeProject`). A
  merge-ready patch is welcome but not required.
- **Deduplication:** one report per root cause. The same leak reachable through several
  output formats (terminal, JSON, Markdown, agent files) is one report; list the formats.
  Separate bypasses of the same helper through unrelated inputs may be separate reports.
