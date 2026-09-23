import type { Style } from '../output/style.ts'
import type { Command } from './args.ts'

const REPO_URL = 'https://github.com/Douglas-Strey/repolens-cli'

export function mainHelp(s: Style, version: string): string {
  return `${s.bold('RepoLens')} ${s.dim(`v${version}`)}
Understand any repository in seconds. Static, local, no telemetry.

${s.bold('Usage')}
  repolens [path] [options]                Scan a repository (default command)
  repolens doctor [path] [options]         Check for setup problems and inconsistencies
  repolens report [path] [options]         Generate a Markdown report
  repolens agent [init] [path] [options]   Generate context for coding agents ${s.dim('(experimental)')}
  repolens config [path]                   Show the configuration files and settings in effect
  repolens help [command]                  Show help for a command

${s.bold('Options')}
  -C, --cwd <path>       Directory to scan ${s.dim('(default: current directory)')}
      --json             Print machine-readable JSON
      --markdown         Print a Markdown report
  -o, --output <file>    Write output to a file instead of stdout
  -q, --quiet            Only print what needs attention
  -v, --verbose          Show low-confidence findings, evidence and technical details
      --max-files <n>    Stop indexing after n files ${s.dim('(default: 100000)')}
      --config <file>    Use this config file instead of the project's repolens.config.json
      --no-config        Ignore every config file ${s.dim('(user and project)')}
      --color            Force colors, even when not writing to a terminal
      --no-color         Disable colors ${s.dim('(NO_COLOR is also respected)')}
  -V, --version          Print the version
  -h, --help             Show help ${s.dim('(repolens <command> --help for a command)')}

${s.bold('Environment')}
  NO_COLOR, FORCE_COLOR  Disable or force colors
  REPOLENS_ASCII=1       Use ASCII symbols instead of Unicode, also in --output files
  REPOLENS_CONFIG        Path of the user config file ${s.dim('(default: ~/.config/repolens/config.json)')}
  REPOLENS_DEBUG=1       Print timings and skipped files to stderr
  COLUMNS                Output width when stdout is not a terminal

${s.bold('Examples')}
  ${s.cyan('npx repolens-cli')}
  ${s.cyan('repolens --json > repolens.json')}
  ${s.cyan('repolens ../another-project')}
  ${s.cyan('repolens doctor --strict')}
  ${s.cyan('repolens report --output repolens.md')}

${s.bold('Exit codes')}
  0  Success
  1  doctor found problems at or above the --fail-on level
  2  Invalid usage, unreadable directory, or an output file that couldn't be written
  3  Unexpected internal error

RepoLens never executes project code, never uploads anything, and never prints secret values.
Docs: ${REPO_URL}#readme
`
}

const COMMAND_HELP: Record<Command, (s: Style) => string> = {
  scan: (s) => `${s.bold('repolens scan')} [path] [options]

Scan a repository and print an overview: stack, workspace, services,
environment variables, scripts, routes, CI and potential issues.
This is the default command, so ${s.cyan('repolens')} and ${s.cyan('repolens scan')} are the same.

Always exits with 0 when the scan completes, so it never breaks CI.

${s.bold('Options')}
  --json, --markdown, -o/--output, -q/--quiet, -v/--verbose, -C/--cwd, --color, --no-color
      --max-files <n>    Stop indexing after n files ${s.dim('(default: 100000)')}
`,
  doctor: (s) => `${s.bold('repolens doctor')} [path] [options]

Look for setup problems: undocumented environment variables, conflicting
runtime versions, competing lockfiles, tracked .env files, Docker port
conflicts, deprecated configuration and more. Every finding has a stable code
(e.g. ENV_UNDOCUMENTED) so you can script against it.

${s.bold('Options')}
      --fail-on <level>  Exit with 1 when a finding is at least this severe:
                         error ${s.dim('(default)')}, warning, info, never
                         ${s.dim('(the default can be set with doctor.failOn in a config file)')}
      --strict           Same as --fail-on warning
      --json             Print checks and diagnostics as JSON
  -q, --quiet            Hide passing categories and hints
  -o, --output <file>    Write the result to a file

For a Markdown version, use ${s.cyan('repolens report')}: it lists every finding.
`,
  report: (s) => `${s.bold('repolens report')} [path] [options]

Generate a Markdown report for onboarding, audits, documentation, or to hand to
an AI assistant. Prints to stdout unless --output is given.

${s.bold('Options')}
  -o, --output <file>    Write the report to a file
  -v, --verbose          Include low-confidence findings and evidence

For JSON, use ${s.cyan('repolens --json')}.
`,
  agent: (s) => `${s.bold('repolens agent')} [init] [path] [options]  ${s.dim('(experimental)')}

Generate concise, structured context about the repository for coding agents
(Claude Code, Codex, Cursor, and others). Never includes secret values.

  repolens agent             Print agent-context.md to stdout
  repolens agent init        Write .repolens/*.md into the project

${s.bold('Options')}
  -o, --output <path>    agent: the file to write agent-context.md to, or an
                         existing directory to write it into
                         agent init: the directory for the generated files
                         ${s.dim('(default: <project>/.repolens)')}
  -f, --force            agent init: overwrite files that were not generated by RepoLens

Review generated files before committing them.
`,
  config: (s) => `${s.bold('repolens config')} [path] [options]

Show which configuration files RepoLens reads for a directory and the
settings in effect after merging them:

  1. your user config ${s.dim('(~/.config/repolens/config.json, or $REPOLENS_CONFIG)')}
  2. the project's repolens.config.json ${s.dim('(or the "repolens" key of package.json)')},
     or the file given with --config

Later files take precedence, and command-line options override them all.

${s.bold('Options')}
      --json             Print the files and settings as JSON
      --config <file>    Use this file instead of the project's own
      --no-config        Ignore every config file

Docs: https://github.com/Douglas-Strey/repolens-cli/blob/main/docs/configuration.md
`,
  help: (s) => `${s.bold('repolens help')} [command]

Show help for a command: scan, doctor, report, agent, config.
`,
}

export function commandHelp(command: Command, s: Style): string {
  return COMMAND_HELP[command](s)
}
