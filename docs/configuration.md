# Configuration

**English** | [Português (Brasil)](pt-BR/configuration.md)

RepoLens works without any configuration. When you want to change what it looks at or
how strict `repolens doctor` is, add a JSON file. There are two kinds:

- **Your user config** applies to every repository you scan: checks you never care
  about, your preferred `--fail-on` level, colors.
- **A project config** lives in the repository, so everyone who scans it (and CI)
  gets the same results: paths to leave out, variables the platform provides, checks
  that don't fit the project.

```sh
repolens config          # which files apply here, and the settings in effect
```

## Where the files live

| File | Location |
| --- | --- |
| User config | `~/.config/repolens/config.json`. `$XDG_CONFIG_HOME/repolens/config.json` when `XDG_CONFIG_HOME` is set, `%APPDATA%\repolens\config.json` on Windows, or any path in `REPOLENS_CONFIG`. |
| Project config | `repolens.config.json` in the scanned directory, or a `"repolens"` key in its `package.json`. |
| Repository root config | The same file at the root of the Git repository, when you scan a subdirectory of it (see [Monorepos](#monorepos)). Directories in between and above the repository are never searched. |

Both use the same format: JSON, with comments and trailing commas allowed. RepoLens only
ever reads these files as data; it never runs a JavaScript config.

## Example

```jsonc
// repolens.config.json
{
  "$schema": "https://unpkg.com/@douglas-strey/repolens/schema/config.schema.json",

  // Generated code and a vendored copy of an old app: not part of the project.
  "ignore": ["legacy/", "src/generated/"],

  "doctor": {
    // CI fails on warnings too.
    "failOn": "warning",
    "rules": {
      // Variables are documented in docs/setup.md instead of .env.example.
      "ENV_EXAMPLE_MISSING": "off",
      "ENV_UNDOCUMENTED": "off",
      // A missing lockfile breaks our deploys.
      "LOCKFILE_MISSING": "error"
    }
  },

  "environment": {
    // Set by Fly.io at runtime.
    "provided": ["FLY_*", "PRIMARY_REGION"]
  }
}
```

The same settings in `package.json`:

```json
{
  "name": "acme-api",
  "repolens": {
    "doctor": { "failOn": "warning" }
  }
}
```

The `$schema` line gives you completion and validation in editors that support JSON Schema
(VS Code, JetBrains IDEs, Zed…). The schema also ships in the package as
`@douglas-strey/repolens/schema/config.schema.json`.

## Settings

### `ignore`

Paths to leave out of the scan, in [.gitignore syntax](https://git-scm.com/docs/gitignore),
relative to the scanned directory. RepoLens already skips everything your `.gitignore`
files ignore, plus `node_modules`, `vendor`, build caches and other generated
directories, so this is for committed files that aren't part of the project: vendored
copies, generated code, fixtures, archived apps.

```json
{ "ignore": ["legacy/", "*.generated.ts", "examples/*", "!examples/basic/"] }
```

As in `.gitignore`, a `!` pattern brings back something an earlier pattern left out, but
not inside a directory that is left out entirely: `examples/*` plus `!examples/basic/`
keeps one example, `examples/` would not. A `!` rule in a `.gitignore` file can't bring
back what these patterns leave out.

RepoLens reads up to 1,000 patterns, and refuses patterns with more than three `**`
segments because they are too slow to match.

Ignoring a file doesn't make RepoLens pretend it is ignored by Git: a local `.env` listed
here is still reported by `ENV_FILE_NOT_IGNORED` if Git would commit it.

### `maxFiles`

Stop indexing after this many files, from 1 to 1,000,000 (default 100,000). `--max-files`
takes precedence.

### `doctor.failOn`

The default for `--fail-on`: `error` (the default), `warning`, `info` or `never`. The
command-line options `--fail-on` and `--strict` take precedence.

### `doctor.rules`

Settings for individual checks, by [code](diagnostics.md):

- `"off"` turns the check off. It is listed as `disabled` in `--json` output and counted
  in the summary.
- `"error"`, `"warning"` or `"info"` reports everything the check finds at that severity.

```json
{ "doctor": { "rules": { "SCRIPT_MISSING_LINT": "off", "RUNTIME_EOL": "error" } } }
```

A misspelled code is reported with a suggestion (`Unknown check "ENV_UNDOCUMNTED" … did you
mean ENV_UNDOCUMENTED?`), and the setting is ignored.

**Security checks** (`ENV_PUBLIC_SECRET`, `ENV_EXAMPLE_REAL_SECRET`, `TRACKED_ENV_FILE`,
`ENV_FILE_NOT_IGNORED`, `RUNTIME_VULNERABLE`, `DEPENDENCY_VULNERABLE`) can't be turned off or lowered by a project config: RepoLens is
often run on repositories nobody has reviewed yet, and those must not be able to hide
their own security findings. A project config may raise them to `"error"`. To turn one
off, use your user config or a file passed with `--config`.

### `doctor.ignore`

Single findings to leave out, by check [code](diagnostics.md) and subject. Unlike turning a
check off, the check keeps running and still reports everything else:

```json
{
  "doctor": {
    "ignore": [
      { "code": "ENV_UNDOCUMENTED", "subject": "LEGACY_TOKEN", "reason": "removed in v3" },
      { "code": "ENV_UNUSED", "subject": "FEATURE_*" }
    ]
  }
}
```

- `code` and `subject` are required. The subject is what the finding is about: a variable
  name, a file, a service port (`8080/tcp`), a runtime (`node@18`). `repolens doctor
  --verbose` prints the entry for each finding, ready to copy:
  `Ignore: { "code": "ENV_UNDOCUMENTED", "subject": "LEGACY_TOKEN" }`.
- `*` in `subject` matches any characters.
- `reason` is optional, for whoever reads the file. RepoLens never prints it.

Ignored findings don't count toward `--fail-on`, but they are never hidden: the summary says
how many there are ("1 ignored"), `--verbose` lists them, and `--json` output has them under
`ignored` (see [json-schema.md](json-schema.md)). An entry that matches no finding of a check
that ran is reported as a configuration warning, so a stale exception can't quietly hide the
problem if it comes back. Entries from every configuration file add up; at most 1,000 are
read from each file.

Like `doctor.rules`, a project config can't ignore findings of the **security checks**;
your user config or a file passed with `--config` can.

### `environment.provided`

Variables your platform or tooling sets, so they never need to be in an env file. Like
`CI` or `NODE_ENV`, the doctor then never reports them as undocumented, missing, local-only
or unused. `*` matches any characters.

```json
{ "environment": { "provided": ["FLY_*", "RAILWAY_*", "INTERNAL_METRICS_URL"] } }
```

The variables still appear in the environment section of the scan.

### `output` (user config only)

Terminal preferences. A project can't set these: they are yours.

```json
{ "output": { "color": "never", "ascii": true } }
```

- `color`: `auto` (the default), `always` or `never`. `--color`, `--no-color`, `NO_COLOR`
  and `FORCE_COLOR` take precedence.
- `ascii`: use `+`, `!` and `x` instead of `✓`, `⚠` and `✗`, like `REPOLENS_ASCII=1`.

## Precedence

From lowest to highest:

1. Your user config.
2. The repository root's config, when a subdirectory is scanned.
3. The scanned directory's config.
4. Command-line options (`--fail-on`, `--strict`, `--max-files`, `--color`…).

A file passed with `--config` takes the place of both 2 and 3. Later sources override
single values (`maxFiles`, `doctor.failOn`, each `doctor.rules` entry). Lists (`ignore`,
`doctor.ignore`, `environment.provided`) accumulate.

## Monorepos

When you scan a subdirectory of a Git repository (`repolens doctor apps/web`), RepoLens also
reads the configuration at the repository root, found the way Git finds `.git`. Shared
settings can live in one place, and a package can still add or override its own in
`apps/web/repolens.config.json`. Only the root and the scanned directory are read, never a
directory in between or above the repository; outside a Git repository only the scanned
directory is.

`ignore` patterns in the root's file are relative to the root, as in a root `.gitignore`:
`apps/web/legacy/` leaves out `legacy/` when you scan `apps/web`, and `**/fixtures/` applies
everywhere. `repolens config apps/web` lists the root file and the patterns it adds.

The root's file is held to the same limits as any project config (it can't turn off or
ignore security checks), and is named by its relative path in the output:

```
Configured by ../../repolens.config.json: 1 check turned off, 1 ignore pattern.
```

## Command-line options

| Option | Effect |
| --- | --- |
| `--config <file>` | Use this file instead of the project's config files (the scanned directory's and the repository root's). Your user config still applies. |
| `--no-config` | Ignore every configuration file, yours and the project's. |

`repolens config [path]` shows which files apply to a directory and the merged settings;
add `--json` for a machine-readable version.

## Invalid settings

A configuration problem never fails a scan. Unknown keys, wrong types and values out of
range are reported on stderr and ignored, so a config written for a newer RepoLens still
works with an older one:

```
⚠ Unknown setting "doctor.failon" in repolens.config.json (did you mean "failOn"?)
```

They also appear in `--json` output under `meta.warnings` with `"kind": "config"`. A project
config RepoLens can't parse is ignored the same way. Your user config and a `--config` file
are different: if they are missing or aren't valid JSON, RepoLens stops with exit code 2 so
you can fix them.

## Reviewing an untrusted repository

A project config shapes the results, so RepoLens always says when one applied:

```
Configured by repolens.config.json: 2 checks turned off, 1 ignore pattern.
```

`--json` output lists it under `meta.config`. When you are evaluating a repository you
don't trust, run with `--no-config` to see it without its own settings. Security checks
can't be turned off by the repository in either case.
