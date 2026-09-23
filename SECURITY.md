# Security Policy

**English** | [Português (Brasil)](SECURITY.pt-BR.md)

RepoLens is built to be run on repositories you don't trust yet: a fresh clone, a
candidate's take-home project, a vendor's code drop. Security bugs are taken seriously.

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report it privately through GitHub:
[Security → Report a vulnerability](https://github.com/Douglas-Strey/repolens-cli/security/advisories/new).

Include what you ran, what happened, and a minimal repository that reproduces it if
possible. You should get an initial response within a week. Once a fix is released, the
advisory will be published with credit to you, unless you'd rather stay anonymous.

## What counts as a vulnerability

Anything that breaks the guarantees in [docs/security.md](docs/security.md), for example:

- RepoLens prints, writes or otherwise leaks the **value** of an environment variable,
  token, password or other secret found in a scanned repository.
- Scanning a repository causes RepoLens to **execute** code or commands from that
  repository (scripts, config files, Git hooks, `git` itself, Docker, …).
- A crafted repository makes RepoLens **read files outside** the scanned directory
  (other than the parent Git metadata described in the security model), for example
  through symlinks or path traversal.
- A crafted repository makes RepoLens hang or use unbounded memory (for example
  through YAML alias bombs, huge files or FIFOs).

## Supported versions

Only the latest published version receives security fixes.
