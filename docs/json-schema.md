# JSON output

**English** | [Português (Brasil)](pt-BR/json-schema.md)

`repolens --json` prints one JSON document describing the repository. It is designed to be
consumed by scripts, CI jobs, dashboards and AI agents.

```sh
repolens --json | jq '.frameworks[].name'
repolens --json | jq '.environment.variables[] | select(.used and (.documented | not)) | .name'
repolens doctor --json | jq '.diagnostics[].code'
```

## Stability

- Every document starts with `"schemaVersion": 1`.
- Within a schema version, fields are **only added**, never removed, renamed or changed
  in meaning. Consumers should ignore fields they don't know.
- A breaking change bumps `schemaVersion`, and the release notes will say so.
- Diagnostic `code`s are stable identifiers and are never renamed.
- The TypeScript definitions in [`src/types.ts`](../src/types.ts) are the source of truth
  and are exported from the package (`import type { ScanResult } from 'repolens-cli'`).

## Guarantees

- **No secret values.** Environment variables appear by name only, with boolean flags.
  URL-shaped values are reduced to `{ scheme, port, local }`.
- **No absolute paths.** All paths are relative to the scanned directory, with `/`
  separators on every OS. `"."` means the root.
- **Deterministic.** No timestamps, and arrays are sorted, so identical input produces
  identical output. Collections are sorted by their natural key (name or path), findings
  by confidence and then name, routes by package, kind, path and method. Lists that
  mirror a file (Compose ports, CI jobs, package.json scripts) keep the file's order.
- Low-confidence findings are omitted unless `--verbose` is passed. Every finding that can
  be uncertain carries a `confidence` (`"high"`, `"medium"`, `"low"`) and `evidence`.

## Top-level shape

```jsonc
{
  "schemaVersion": 1,
  "tool": { "name": "repolens", "version": "0.1.0" },
  "project": { … },          // name, type, license, manifests, entrypoints, structure
  "languages": [ … ],        // { name, kind, files, share }
  "runtimes": [ … ],         // Node.js, Go, Bun, Deno with every version source
  "packageManagers": { … },  // primary + detected, lockfiles, declarations
  "workspace": { … } | null, // monorepo tools, patterns, packages
  "dependencies": { … },     // direct dependencies per package
  "frameworks": [ … ],
  "build": { "tools": [ … ] },
  "testing": { "tools": [ … ], "testFiles": 23 },
  "linting": { "tools": [ … ] },
  "scripts": { "runner": "pnpm", "scripts": [ … ] },
  "environment": { "files": [ … ], "variables": [ … ], "usageTruncated": false },
  "services": { "composeFiles": [ … ], "services": [ … ], "dockerfiles": [ … ] },
  "databases": { "databases": [ … ], "orms": [ … ] },
  "routes": { "routes": [ … ], "truncated": false },
  "ci": { "providers": [ … ], "workflows": [ … ] },
  "git": { … } | null,
  "configFiles": [ … ],
  "doctor": { "checks": [ … ], "diagnostics": [ … ], "summary": { … } },
  "meta": { "files": 162, "truncated": false, "warnings": [ … ], "config": { … } }
}
```

## Sections

### `project`

| Field | Type | Notes |
| --- | --- | --- |
| `name` | string | `package.json` name, Go module name, or the directory name. |
| `directory` | string | Name of the scanned directory (never a full path). |
| `description`, `version`, `license`, `homepage`, `repository` | string? | From `package.json` (license can also come from a recognized `LICENSE` file; the repository URL has credentials stripped). |
| `type` | `"monorepo" \| "application" \| "library" \| "cli" \| "unknown"` | |
| `private` | boolean? | |
| `manifests` | string[] | Root manifests found: `package.json`, `go.mod`, `pyproject.toml`, … |
| `entrypoints` | `{ kind: "go-main" \| "bin", path, name? }[]` | Go `main` packages and `bin` commands. |
| `structure` | `{ path, files }[]` | Top-level directories by indexed file count (at most 15). |

### `languages[]`

`{ "name": "TypeScript", "kind": "programming" | "markup" | "style", "files": 96, "share": 0.738 }`.
`share` is the fraction of counted files, sorted by `files` in descending order. Data and
documentation files (JSON, YAML, Markdown) are not counted.

### `runtimes[]`

```json
{
  "id": "node",
  "name": "Node.js",
  "version": "22",
  "sources": [
    { "file": ".nvmrc", "raw": "22", "version": "22", "kind": "exact" },
    { "file": "package.json", "field": "engines.node", "raw": ">=22", "version": ">=22", "kind": "range" },
    { "file": "Dockerfile", "field": "FROM", "raw": "node:20-alpine", "version": "20", "kind": "exact" }
  ]
}
```

`kind` is `exact` (a pin, possibly partial such as `22`), `range` (a semver range) or
`alias` (`lts/*`, `node:lts`; `version` is `null` when the alias can't be resolved
statically). `version` at the top is the value to display.

### `packageManagers`

`primary` is the package manager to use for scripts (`null` if none). `detected` lists
everything found: `{ id, name, version?, lockfiles[], declared, guessed?, installFrom?, evidence[] }`:

- `declared`: the `packageManager` or `devEngines` field names it.
- `guessed`: nothing decided it (no declaration, no unambiguous lockfile), so treat it as a
  best guess.
- `installFrom`: when you scanned a package inside a larger repository, the directory
  (relative to the repository root, `""` for the root) that dependencies must be
  installed from.

### `workspace`

`null` for single-package repositories.
`{ tools: [{ id, name, configFile }], patterns: string[], packages: [{ name, path, version?, private?, ecosystem }] }`.

### `dependencies`

`{ packages: [{ path, name, ecosystem, dependencies: [{ name, version, kind }] }], total }`, where
`kind` is `prod`, `dev`, `peer`, `optional` or `indirect` (Go). `total` counts unique names,
excluding indirect ones.

### `frameworks[]`, `build.tools[]`, `testing.tools[]`, `linting.tools[]`, `databases.orms[]`

Frameworks: `{ id, name, version?, category, ecosystem, packages[], confidence, evidence[] }`.
When packages use different major versions, `version` is a range summary such as
`"18.3.1–19.1.0"` and `evidence` lists each package's declaration.
Tools: `{ id, name, kind, version?, configFiles[], packages[], confidence, evidence[] }`.
`packages` lists the package directories where it was found.

### `scripts`

`{ runner, scripts: [{ name, command, run, source, package?, category }] }`: `run` is what
you type (`pnpm dev`, `make test`), `command` is the script body with inline secrets
redacted, and `category` is one of `dev`, `start`, `build`, `test`, `lint`, `format`,
`typecheck`, `database`, `deploy`, `release`, `setup`, `other`.

### `environment`

```json
{
  "files": [{ "path": ".env", "kind": "local", "variables": 3, "ignored": true, "tracked": false }],
  "variables": [
    {
      "name": "DATABASE_URL",
      "defined": true,
      "documented": true,
      "used": true,
      "definedIn": [".env"],
      "documentedIn": [".env.example"],
      "usedIn": ["src/db.ts"],
      "fallback": false,
      "testOnly": false,
      "public": false,
      "sensitive": false,
      "endpoints": [{ "file": ".env.example", "scheme": "postgres", "port": 5432, "local": true }],
      "suspiciousValueIn": []
    }
  ],
  "usageTruncated": false
}
```

`files[].kind` says what an env file is for:

| Kind | Files | Meaning |
| --- | --- | --- |
| `local` | `.env`, `.env.local`, `.env.*.local`, `local.env`, `.envrc` | One developer's values, never meant to be committed. |
| `mode` | `.env.development`, `.env.production`, `.env.test`, `.env.staging`, `.env.ci`, `prod.env`, … | Framework mode files, often committed on purpose with non-secret defaults. |
| `service` | Files a Compose service loads with `env_file` that are none of the above (`.env.db`) | Values for one container. |
| `example` | `.env.example`, `.env.sample`, `.env.template`, `.env.dist`, `env.example`, … | Documentation templates. |
| `other` | Anything else, such as an encrypted `.env.vault` or a `.env.backup` | Listed, but its variables are not reported. |

`files[].variables` counts active assignments only; commented-out lines don't count.

- `defined`: set in a file that holds values (`local`, `mode` or `service`).
- `documented`: listed in an example file. Commented-out entries count (`# SENTRY_DSN=`
  documents the name without setting it).
- `used`: referenced in code or configuration (`process.env.X`, `import.meta.env.X`,
  `os.Getenv("X")`, Prisma `env("X")`, Compose `${X}`, `%X%` placeholders in a Vite or
  Create React App `index.html`, schema libraries such as zod, Joi, envalid and t3-env, …).
  Comments are skipped.
- `usedIn`: up to five files that reference the variable.
- `fallback`: every reference supplies a default (`process.env.PORT ?? 3000`, a schema
  default), so the variable is optional.
- `testOnly`: only tests reference it (test files, test directories, test-runner configs).
- `public`: exposed to browser bundles by its prefix (`NEXT_PUBLIC_`, `VITE_`, `NUXT_PUBLIC_`,
  `PUBLIC_`, `EXPO_PUBLIC_`, `REACT_APP_`, `VUE_APP_`, …).
- `sensitive`: the name looks like a secret.
- `endpoints`: URL-shaped values reduced to scheme, port and whether the host is local.
  The value itself is never included.
- `suspiciousValueIn`: example files whose value for this variable looks like a real
  credential. Only file paths are included.
- `ignored` is `null` when RepoLens can't tell, and `tracked` is `null` outside a Git repository.

### `services`

Compose services: `{ name, source, image?, build?, dockerfile?, technology?: { id, name }, kind, ports: [{ host, container, protocol, hostIp?, raw }], expose[], dependsOn[], volumes[], environment[] (names only), envFiles[], profiles[], healthcheck }`.
Services with the same name in Compose files of the same directory (base file plus
overrides) are merged. `dockerfiles`: `{ path, baseImages[], stages, exposes[], args[] }`
(`ARG` names only).

### `databases`

`{ databases: [{ id, name, kind, sources: ("dependency" | "docker" | "env" | "config")[], confidence, evidence[] }], orms: Tool[] }`.

### `routes`

`{ routes: [{ method, path, kind: "api" | "page", framework, file, line?, confidence, package?, note? }], truncated }`.
Paths use `:param` for parameters and `*name` for catch-alls. `note` explains a lower
confidence or a detail, for example "prefix may apply" (a router mounted under a prefix
that can't be resolved statically), "optional parameter", "nested route parent", or a
`next.config`/`nuxt.config` value that isn't a literal. `truncated` is `true` when route
scanning stopped at its file limit or prefix resolution hit its work budget.

### `ci`

`{ providers: [{ id, name, files[] }], workflows: [{ provider, file, name?, triggers[], jobs: [{ id, name?, tasks[], runsOn[] }] }] }`,
where `tasks` is inferred from job names, commands and actions: `lint`, `format`,
`typecheck`, `test`, `e2e`, `build`, `deploy`, `release`, `security`, `docs`.

### `git`

`null` outside a Git repository.
`{ branch, head, remotes: [{ name, url, host? }], submodules[], lfs, trackedFiles, linkedWorktree }`.
Read directly from `.git`; remote URLs never include credentials.

### `configFiles[]`

`{ path, category, description }` for recognized configuration files.

### `doctor`

```json
{
  "checks": [
    {
      "code": "MULTIPLE_LOCKFILES",
      "title": "Only one package manager lockfile is committed",
      "category": "package-manager",
      "status": "failed"
    }
  ],
  "diagnostics": [
    {
      "code": "MULTIPLE_LOCKFILES",
      "severity": "warning",
      "category": "package-manager",
      "message": "Found lockfiles for npm and pnpm: package-lock.json and pnpm-lock.yaml",
      "hint": "Delete package-lock.json and keep pnpm-lock.yaml, since package.json declares pnpm",
      "files": ["package-lock.json", "pnpm-lock.yaml"],
      "subject": "lockfiles"
    }
  ],
  "summary": { "passed": 10, "failed": 5, "skipped": 19, "disabled": 0, "errors": 0, "warnings": 7, "infos": 0 }
}
```

`status` is `passed`, `failed`, `skipped` when a check doesn't apply to the repository (for
example Docker checks when there are no Compose files), or `disabled` when a
[configuration file](configuration.md) turned it off. A severity set in `doctor.rules`
replaces the severity of every diagnostic that check reports. See
[diagnostics.md](diagnostics.md) for every code.

### `meta`

`{ files, truncated, warnings: [{ kind, file?, message, detail? }], config }`: the number of
indexed files, whether indexing stopped at the file limit, non-fatal problems, and the
configuration that applied.

`kind` is `"parse"` (a file couldn't be parsed), `"size"` (a file was skipped for being too
large), `"limit"` (a scan limit was hit), `"error"` (a detector or check failed) or
`"config"` (a configuration file has a setting RepoLens ignored). `detail` holds the parser
message; it never quotes file contents or absolute paths.

`config` lists the [configuration files](configuration.md) that applied, lowest precedence
first, and the merged settings:

```json
{
  "sources": [{ "kind": "user" }, { "kind": "project", "file": "repolens.config.json" }],
  "settings": { "ignore": ["legacy/"], "doctor": { "rules": { "ENV_UNUSED": "off" } } }
}
```

`kind` is `"user"` (your user config), `"project"` (the scanned directory's
`repolens.config.json` or the `"repolens"` key of its `package.json`) or `"file"` (a file
passed with `--config`). `file` is relative to the scanned directory, and absent for files
outside it. `sources` is empty when no configuration applied.

## `repolens doctor --json`

A smaller document with just the doctor results:

```jsonc
{
  "schemaVersion": 1,
  "tool": { "name": "repolens", "version": "0.1.0" },
  "project": { "name": "acme-api", "directory": "acme-api" },
  "checks": [ … ],
  "diagnostics": [ … ],
  "summary": { … },
  "config": { "sources": [ … ], "settings": { … } }
}
```
