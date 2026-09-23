# Security model

**English** | [Português (Brasil)](pt-BR/security.md)

RepoLens is meant to be the first thing you run in a repository you don't know yet. That
only works if running it is safe, so the rules below are hard constraints, not goals.
Breaking any of them is a security bug; please [report it privately](../SECURITY.md).

## Guarantees

### 1. RepoLens never executes anything from the repository

- No `package.json` scripts, lifecycle hooks, Makefile targets or shell commands.
- No JavaScript or TypeScript config files are imported or evaluated.
  `nuxt.config.ts`, `next.config.mjs`, `vite.config.ts` and friends are read as text and
  analyzed with conservative patterns.
- **RepoLens does not run the `git` binary.** Repository-level Git config can make `git`
  execute arbitrary programs (`core.fsmonitor`, `core.pager`, diff/merge drivers, filters),
  so branch, HEAD, remotes and the list of tracked files are read straight from `.git/HEAD`,
  `.git/config`, `packed-refs` and the binary `.git/index`. There is a test that plants a
  `core.fsmonitor` command and asserts it never runs.
- No Docker, database or network calls. Compose files and Dockerfiles are parsed; nothing
  is started or contacted.

### 2. Secret values never reach the output

- `.env`-style files are parsed by a dedicated parser (`src/core/dotenv.ts`) that keeps only
  the variable **name** and a few derived facts: whether the value is empty, the URL scheme,
  port and whether the host is local (used to catch port mismatches). The value itself is
  dropped inside the parser and is never stored, logged or thrown.
- Docker Compose `environment:` blocks contribute names only.
- Example files such as `.env.example` are checked against well-known credential formats
  (AWS keys, GitHub/GitLab/npm tokens, Stripe live keys, private keys, …). A match is reported
  as "`.env.example` contains what looks like a real credential in `NAME`", never with the
  value.
- Text that RepoLens echoes back from committed files (package.json scripts, dependency
  ranges, Git remotes) goes through redaction: credentials in URLs, `SECRET_NAME=value`
  assignments, `--password`/`--token` flags and known token formats are replaced with `***`.
- The test suite scans fixtures whose secret values all contain a sentinel string and
  asserts that the sentinel appears in no output format (terminal, JSON, Markdown, agent
  files).

### 3. RepoLens only reads inside the directory you point it at

- Every project file is read through one function (`readTextWithin` in `src/core/fs.ts`)
  that rejects absolute paths and `..` traversal and resolves the **real** path (following
  symlinks, including symlinked parent directories) before checking it is still inside the
  project root.
- The directory walker never follows directory symlinks, so symlink loops can't trap it and
  links can't lead it outside the root. File symlinks are indexed only when they resolve to a
  regular file inside the root.
- **One deliberate exception:** when you scan a subdirectory of a Git repository, RepoLens
  looks upward for the enclosing `.git` directory (as `git` itself would) to report the
  branch and tracked files, and uses the Git index to see which lockfiles exist in the
  directories above (to tell you where to run `install`). It only reads Git metadata
  files there. A `.git` *file*
  (linked worktrees, submodules) is only followed when the Git directory it names points
  back at this checkout, so a crafted `.git` file can't make RepoLens report another
  repository on your machine.

### 4. Hostile input can't hang or exhaust RepoLens

| Input | Protection |
| --- | --- |
| Huge files | Files over 1 MiB are skipped (source files scanned for routes/env usage: 512 KiB). |
| Binary files | Skipped when a NUL byte appears in the first 8 KB. |
| FIFOs, sockets, devices | Never opened for reading (`stat` check plus `O_NONBLOCK` on POSIX). |
| Huge repositories | Indexing stops at 100,000 files (`--max-files`) and 20 directory levels, and reports that the scan is incomplete. |
| YAML alias bombs | Documents that would expand to more than 1,000,000 nodes, nest too deeply, or use recursive aliases are rejected. |
| Hostile `.gitignore` files | At most 2,000 ignore rules apply to any one path and 50,000 in total (with a warning); glob matching runs in linear time. |
| Malformed JSON/YAML/JSONC | Reported as a warning; the rest of the scan continues. Parser messages give a line and column, never the file's contents. |
| Pathological source files | Source files over 512 KiB are skipped, and route and environment-variable patterns are written to avoid catastrophic backtracking (tested with adversarial inputs). |
| A detector bug | The failing section is left empty and a warning is recorded; other sections are unaffected. |

### 5. A repository's own configuration can't hide its problems

A scanned repository can ship a `repolens.config.json` (see
[configuration.md](configuration.md)). RepoLens reads it as JSON, never executes it, and
limits what it can do:

- It can't turn off or lower the **security** checks (`ENV_PUBLIC_SECRET`,
  `ENV_EXAMPLE_REAL_SECRET`, `TRACKED_ENV_FILE`, `ENV_FILE_NOT_IGNORED`). Only your user
  config or a file you pass with `--config` can.
- Its `ignore` patterns leave paths out of the analysis, but don't change what RepoLens
  considers ignored by Git: a local `.env` it lists is still reported if Git would commit it.
- It can't set terminal preferences, and its `maxFiles` is capped at 1,000,000.
- The file is read like any other project file: inside the root, at most 256 KiB, no
  symlinks leading out, no FIFOs. A file RepoLens can't use is ignored with a warning.
- Whenever it applies, the output says so ("Configured by repolens.config.json: 2 checks
  turned off"), and `--json` lists it under `meta.config`. Use `--no-config` to see an
  untrusted repository without its own settings.

Warnings about configuration name settings and check codes, never the values in the file.

### 6. Writing files is just as careful

`--output` and `repolens agent init` never write through a symlink and never open a FIFO
at the target path, so a scanned repository can't redirect them. `agent init` also
refuses to overwrite files it didn't generate unless you pass `--force`.

## Privacy

- **No telemetry.** RepoLens has no analytics, crash reporting or update checks, and makes
  no network requests at all. If telemetry is ever considered it will be opt-in, off by
  default, and announced in the changelog.
- Output never includes absolute paths from your machine. Paths are relative to the scanned
  directory, and the project is identified by its directory name.

## Running RepoLens itself safely

RepoLens can only protect you once it is running. When you use `npx repolens-cli` *inside*
an untrusted repository, npm resolves the package first, and npm honors that repository's
`.npmrc` (which can point at another registry) and its `node_modules` (which can contain a
package with the same name). Run it from outside the repository instead:

```sh
cd ~ && npx repolens-cli ~/code/unknown-repo
# or install once and use the binary
npm install -g repolens-cli && repolens ~/code/unknown-repo
```

## What the output does contain

Treat RepoLens output like a description of your repository: it's fine to share where your
code is shareable. It includes file paths, dependency names and versions, script commands
(redacted as described above), environment variable **names**, Docker service names, images
and ports, route paths, CI job names, Git branch and sanitized remote URLs.

`repolens agent init` writes these facts into `.repolens/`. Review those files before
committing them.

## Known limitations

- Redaction of echoed text is defense in depth, not a guarantee: a secret committed in an
  unusual format inside a `package.json` script could still be displayed, because it is
  already in the repository. Environment variable values are different: they are never
  displayed in any format.
- Parent `.gitignore` files above the scanned directory are not applied, and neither is
  the global `core.excludesFile`. Matching is case-sensitive, as on Linux.
