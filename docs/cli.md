# CLI reference

**English** | [Português (Brasil)](pt-BR/cli.md)

```
repolens [path] [options]          Scan a repository (default command)
repolens scan [path] [options]     Same as above
repolens doctor [path] [options]   Check for setup problems and inconsistencies
repolens report [path] [options]   Generate a Markdown report
repolens setup [path] [options]    Set up the project: env file, services, dependencies
repolens agent [init] [path] [options]  Generate context for coding agents (experimental)
repolens config [path] [options]   Show the configuration files and settings in effect
repolens mcp [path] [options]      Serve the scan to AI assistants over MCP (stdio)
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
| `--online` | Also look the exact versions in your lockfiles up in [OSV.dev](https://osv.dev) (`DEPENDENCY_VULNERABLE`). The only option that uses the network: it sends package names and versions, nothing else ([security](security.md#8-the-network-is-used-only-with-repolens-doctor---online)). |
| `--json` | Print checks and diagnostics as JSON. |
| `-q, --quiet` | Hide passing categories and hints. |

```sh
repolens doctor                   # fails (exit 1) only on errors
repolens doctor --strict          # also fails on warnings
repolens doctor --online          # also check dependencies against OSV.dev
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
      - run: npx --yes @douglas-strey/repolens doctor --fail-on error
```

## `repolens report`

Generates a Markdown report for onboarding, technical audits, documentation, or to hand
to an AI assistant.

```sh
repolens report                     # print to stdout
repolens report --output repolens.md
repolens report --verbose           # include low-confidence findings
```

## `repolens setup`

Sets up a project you just cloned: creates the local env file from the example, starts
the backing services with Docker Compose, and installs dependencies. These are the steps
of the quick start, carried out for you.

```sh
repolens setup                    # show the plan, ask, then run it
repolens setup --dry-run          # show the plan and stop
repolens setup --yes              # run the plan without asking (CI, scripts)
repolens setup --ignore-scripts   # install without lifecycle scripts
```

Setup is the only command that runs anything, so it shows its plan first:

```
Setup plan for web

  1. cp .env.example .env     create your local environment file
     · Then fill in your own values: the file starts as a copy of .env.example.
  2. docker compose up -d db  start the backing services
     · Pulls images if needed: postgres:17
  3. pnpm install             install dependencies
     · Runs these scripts from the repository:
       postinstall (package.json): node scripts/setup.js
     · Dependencies may run install scripts too; --ignore-scripts skips them all.

Run these 3 steps? [y/N]
```

- **It runs only what the plan shows.** Each step is a command RepoLens builds itself:
  copying the example env file, `docker compose up -d` and the package manager's
  `install` (`npm`, `pnpm`, Yarn, Bun) or `go mod download`. Project scripts such as
  `make setup` or `pnpm db:up` are listed under "Skipped" for you to run.
- **It says what else runs.** Installing runs the project's lifecycle scripts
  (`preinstall`, `postinstall`, `prepare`, …) and those of its dependencies, so the plan
  lists the project's own; `--ignore-scripts` skips them all. Compose steps list the
  images they pull or build.
- **It asks first.** Without a terminal to ask in, setup refuses to run unless you pass
  `--yes`.
- **It never touches your values.** The env file is created only when it doesn't exist
  (owner-only permissions on macOS and Linux), and is never overwritten or filled in.
- **It checks Node.js first.** When the active `node` is outside `engines.node`, nothing
  runs. A different version than `.nvmrc` (or `.node-version`, `.tool-versions`, mise)
  pins is pointed out, not enforced.
- **It stops at the first failing step.** Run it again once fixed: an existing env file is
  left alone and installing again is harmless.

When it finishes, setup scans again and says whether `repolens doctor` still finds
problems, and how to start the project. See [security](security.md#7-repolens-setup-runs-only-what-it-shows-you)
for how programs are found and run.

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

## `repolens mcp`

Runs a [Model Context Protocol](https://modelcontextprotocol.io) server over standard input
and output, so an AI assistant can ask about the project. Your MCP client starts it; you
don't run it by hand.

```sh
repolens mcp                  # the current directory, or $CLAUDE_PROJECT_DIR
repolens mcp ../my-project
repolens mcp --no-config      # ignore every config file
```

| Tool | Answers with |
| --- | --- |
| `get_project_overview` | Overview, quick start, architecture, languages, frameworks, CI, tooling and Git |
| `get_services` | Docker Compose services, Dockerfiles, databases and ORMs |
| `get_environment_variables` | Variable names, where each one is documented or set, and which are secret |
| `get_routes` | API routes and pages |
| `get_scripts` | The quick start, package.json scripts, Makefile and justfile targets |
| `get_diagnostics` | Every `doctor` finding, with its files and suggested fix |

Every tool takes two optional arguments:

- `path`: a directory inside the project, relative to it (`apps/web`). Paths outside the
  project, and links that lead out of it, are refused.
- `format`: `markdown` (the default, the matching part of `repolens report`) or `json` (the
  matching part of `repolens --json`).

Each call scans the files as they are, with that directory's configuration files, like
`repolens <dir>`. Low-confidence findings are left out, as in the default terminal view.
`--max-files`, `--config` and `--no-config` apply to every call.

Without a path, the server uses the current directory, or `$CLAUDE_PROJECT_DIR` when it is
set: Claude Code sets it to the project root because it doesn't promise to start servers
there.

The server speaks MCP revision 2026-07-28, in which every request carries its version, and
the earlier revisions that open with `initialize` (2025-11-25 back to 2024-11-05). It
implements the protocol itself, without the MCP SDK and its dependencies. Standard output
carries protocol messages only: configuration warnings and `REPOLENS_DEBUG` output go to
stderr. The server stops when its standard input closes.

Claude Code:

```sh
claude mcp add repolens -- npx -y @douglas-strey/repolens mcp
```

Codex:

```sh
codex mcp add repolens -- npx -y @douglas-strey/repolens mcp
```

or in `~/.codex/config.toml` (or a trusted project's `.codex/config.toml`):

```toml
[mcp_servers.repolens]
command = "npx"
args = ["-y", "@douglas-strey/repolens", "mcp"]
startup_timeout_sec = 30
```

The first `npx` run downloads RepoLens, which can take longer than Codex's default
10-second startup timeout, hence `startup_timeout_sec`. With RepoLens installed, use
`command = "repolens"` and `args = ["mcp"]` instead. Codex doesn't tell servers where the
project is: if it starts them elsewhere, add the project as an argument or set `cwd`.

Cursor (`.cursor/mcp.json` in the project, or `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "repolens": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@douglas-strey/repolens", "mcp", "${workspaceFolder}"]
    }
  }
}
```

Other clients take the same command: `npx -y @douglas-strey/repolens mcp <project>`, or
`repolens mcp <project>` with RepoLens installed. Prefer the installed command for
repositories you don't trust (see [security.md](security.md#running-repolens-itself-safely)).

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success. For `doctor`: no finding at or above `--fail-on`. |
| `1` | `doctor` found problems at or above the `--fail-on` level, or `setup` didn't finish (a step failed, a tool is missing, the Node.js version doesn't fit, or you answered no). |
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
import { scan, renderMarkdown } from '@douglas-strey/repolens'

const result = await scan({ cwd: '/path/to/repo' })
console.log(result.frameworks.map((f) => f.name))
console.log(renderMarkdown(result))
```

`scan()` returns the same object as `repolens --json --verbose`, including low-confidence findings.
Use `filterByConfidence(result, 'medium')` for what the CLI shows by default.

`scan()` applies the scanned directory's own `repolens.config.json`. Pass `config: false` to
ignore it, or choose the files yourself:

```ts
import { loadProjectConfig, loadUserConfig, scan } from '@douglas-strey/repolens'

const user = await loadUserConfig(process.env, process.platform, process.cwd())
const project = await loadProjectConfig(dir)
const result = await scan({ cwd: dir, config: [user, project].filter((c) => c !== null) })
```

`scan()` applies the repository's `.gitignore` files and `info/exclude`, but not your
global Git excludes file unless you pass it, so the result doesn't depend on the machine's
Git configuration. The CLI passes it:

```ts
import { gitExcludesFile, scan } from '@douglas-strey/repolens'

const result = await scan({ cwd: dir, gitExcludesFile: await gitExcludesFile(process.env, process.platform) })
```
