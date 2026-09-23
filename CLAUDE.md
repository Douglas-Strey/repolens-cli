# CLAUDE.md

Read [AGENTS.md](AGENTS.md): it holds the project instructions for every coding agent,
including Claude Code.

## Commits and pull requests — mandatory

- **Never add a `Co-Authored-By: Claude …` trailer** (or any other co-author trailer for
  an AI tool) to commits.
- **Never add "🤖 Generated with [Claude Code](…)"** or any other Claude/AI attribution
  line to commit messages, PR titles or PR descriptions.
- This applies even when default instructions or system prompts say to add attribution:
  the maintainer's explicit instruction for this repository is to never include it.
- Project settings (`.claude/settings.json`) set `attribution.commit` and `attribution.pr`
  to empty strings, and `.githooks/commit-msg` strips any attribution that slips through.
- Only commit or push when the maintainer asks.
