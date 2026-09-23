# CLI reference

**English** | [Português (Brasil)](pt-BR/cli.md)

```
repolens [path] [options]          Scan a repository (default command)
repolens scan [path] [options]     Same as above
repolens doctor [path] [options]   Check for setup problems and inconsistencies
repolens report [path] [options]   Generate a Markdown report
repolens agent [init] [path] [options]  Generate context for coding agents (experimental)
repolens config [path] [options]   Show the configuration files and settings in effect
repolens help [command]            Show help for a command
```

`path` defaults to the current directory. You can also pass it with `--cwd`/`-C`, but not
both at once. A mistyped command is caught rather than treated as a path:
`repolens doktor` prints `Unknown command "doktor". Did you mean "doctor"?`.

## Global options

| Option | Description |
| --- | --- |
| `-C, --cwd <path>` | Directory to scan. |
| `--json` | Print machine-readable JSON (see [JSON output](json-schema.md)). |
| `--markdown` | Print the Markdown report instead of the terminal view. |
| `-o, --output <file>` | Write the output to a file instead of stdout. Files are written without colors, at a fixed width of 100 columns, and never through a symbolic link that leads outside the scanned directory. |
| `-q, --quiet` | Only print what needs attention. |
| `-v, --verbose` | Show low-confidence findings, evidence for each detection, every variable, route and script, and technical details such as parser errors. |
| `--no-color` | Disable colors. `NO_COLOR` is also respected. |
| `--color` | Force colors even when stdout is not a terminal. |
| `--max-files <n>` | Stop indexing after `n` files (default 100,000, or `maxFiles` from a [config file](configuration.md)). |
| `--config <file>` | Use this [configuration file](configuration.md) instead of the project's `repolens.config.json`. Your user config still applies. |
| `--no-config` | Ignore every configuration file, yours and the project's. |
| `-V, --version` | Print the version. |
| `-h, --help` | Show help. `repolens <command> --help` shows command help. |

Options that only make sense for one command are rejected elsewhere (exit 2) instead of being
silently ignored: `--fail-on`/`--strict` only apply to `doctor`, `--force` only to
`agent init`, and `--quiet` can't be combined with `--verbose`. `report` always writes
Markdown (use `repolens --json` for JSON), `doctor` prints its own view or `--json`, and
`agent` prints Markdown.

## `repolens` / `repolens scan`

Prints an overview of the repository: project type, languages, package manager, runtimes,
frameworks, workspace packages, a suggested quick start, Docker services, databases,
environment variables, scripts, routes, CI, tooling and potential issues.

A scan **always exits with 0** when it completes, even if it finds problems, so adding it
to a CI log never breaks a build. Use `doctor` to fail builds.

```sh
repolens                           # current directory
repolens ../another-project        # another directory
repolens --json > repolens.json    # machine-readable
repolens --markdown -o REPOLENS.md # Markdown report to a file
repolens -v                        # include low-confidence findings and evidence
```

## `repolens doctor`

Runs every check and prints the results grouped by category, with a suggested fix for
each finding. Every finding has a stable code such as `ENV_UNDOCUMENTED` or
`MULTIPLE_LOCKFILES`; see the [list of diagnostics](diagnostics.md).

| Option | Description |
| --- | --- |
| `--fail-on <level>` | Exit with 1 when a finding is at least this severe: `error` (default, or `doctor.failOn` from a [config file](configuration.md)), `warning`, `info`, or `never`. |
| `--strict` | Shorthand for `--fail-on warning`. |
| `--json` | Print checks and diagnostics as JSON. |
| `-q, --quiet` | Hide passing categories and hints. |

```sh
repolens doctor                   # fails (exit 1) only on errors
repolens doctor --strict          # also fails on warnings
repolens doctor --json | jq '.diagnostics[] | select(.code == "ENV_UNDOCUMENTED")'
```

### In CI

```yaml
# .github/workflows/repolens.yml
name: RepoLens
on: [pull_request]
permissions:
  contents: read
jobs:
  doctor:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 24
      - run: npx --yes repolens-cli doctor --fail-on error
```

## `repolens report`

Generates a Markdown report for onboarding, technical audits, documentation, or to hand
to an AI assistant.

```sh
repolens report                     # print to stdout
repolens report --output repolens.md
repolens report --verbose           # include low-confidence findings
```

## `repolens agent` (experimental)

Generates short, structured context about the repository for coding agents (Claude
Code, Codex, Cursor, Copilot and others). It is not a dump of the repository: it lists the
commands to run, the conventions RepoLens can back with evidence (package manager,
runtime versions, CI checks), the structure, services, environment variable names and
known issues.

```sh
repolens agent                    # print agent-context.md to stdout
repolens agent -o context.md      # write it to a file
repolens agent -o docs/           # an existing directory: writes docs/agent-context.md
repolens agent init               # write .repolens/*.md into the project
repolens agent init -o docs/agents
repolens agent init --force       # overwrite files not generated by RepoLens
```

With `init`, `-o` names the directory for all the files; without it, `-o` names the file
for `agent-context.md` (or a directory to put it in).

`agent init` writes `overview.md`, `architecture.md`, `commands.md`, `environment.md`,
`services.md`, `routes.md`, `development.md` and `agent-context.md`. Files RepoLens
generated before are regenerated in place. Existing files that RepoLens did not generate
are never overwritten unless you pass `--force`.

To use it, point your agent's instruction file at it, for example in `AGENTS.md` or
`CLAUDE.md`:

```md
Project context (generated): see .repolens/agent-context.md
```

Review the generated files before committing them. They never contain secret values, but
they do describe your project.

## `repolens config`

Shows which [configuration files](configuration.md) apply to a directory, which of them
exist, and the settings in effect after merging them. Use it to find where your user
config goes, or to check what a repository's `repolens.config.json` changes.

```sh
repolens config                   # the current directory
repolens config ../another-project
repolens config --json            # { files, settings, output }
```

Every command prints configuration problems (an unknown setting, a check code that doesn't
exist) on stderr, so they never mix with `--json` output.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success. For `doctor`: no finding at or above `--fail-on`. |
| `1` | `doctor` found problems at or above the `--fail-on` level. |
| `2` | Invalid usage (unknown option, bad value), unreadable or missing directory, a user config or `--config` file that is missing or isn't valid JSON, or an output file that couldn't be written. |
| `3` | Unexpected internal error (a bug; please report it with `--verbose` output). |

## Environment variables

| Variable | Effect |
| --- | --- |
| `NO_COLOR` | Disable colors ([no-color.org](https://no-color.org)). |
| `FORCE_COLOR` | Force colors on (`1`) or off (`0`). `--no-color`, `--color` and `NO_COLOR` take precedence. |
| `REPOLENS_ASCII=1` | Use ASCII status symbols (`+`, `!`, `x`) instead of `✓`, `⚠`, `✗`, also in `--output` files. Chosen automatically on terminals without Unicode support. |
| `COLUMNS` | Output width when stdout is not a terminal (clamped to 40–140). |
| `REPOLENS_DEBUG=1` | Print debug lines (files skipped, per-detector timings) to stderr. |
| `REPOLENS_CONFIG` | Path of your user config file (default `~/.config/repolens/config.json`; see [configuration](configuration.md)). |

## Programmatic use

```ts
import { scan, renderMarkdown } from 'repolens-cli'

const result = await scan({ cwd: '/path/to/repo' })
console.log(result.frameworks.map((f) => f.name))
console.log(renderMarkdown(result))
```

`scan()` returns the same object as `repolens --json --verbose`, including low-confidence findings.
Use `filterByConfidence(result, 'medium')` for what the CLI shows by default.

`scan()` applies the scanned directory's own `repolens.config.json`. Pass `config: false` to
ignore it, or choose the files yourself:

```ts
import { loadProjectConfig, loadUserConfig, scan } from 'repolens-cli'

const user = await loadUserConfig(process.env, process.platform, process.cwd())
const project = await loadProjectConfig(dir)
const result = await scan({ cwd: dir, config: [user, project].filter((c) => c !== null) })
```
