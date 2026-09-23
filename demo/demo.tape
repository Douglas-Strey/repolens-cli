# RepoLens terminal demo, recorded with VHS (https://github.com/charmbracelet/vhs).
#
#   pnpm build && vhs demo/demo.tape
#
# If VHS records but writes no GIF (seen with VHS 0.12 on macOS), use
# ./demo/render.sh instead: it renders the same tape via PNG frames and FFmpeg.
#
# The demo scans a copy of test/fixtures/monorepo, a small but realistic pnpm +
# Turborepo monorepo with Nuxt, Fastify, a Go service and Docker Compose. It runs
# the locally built CLI, so the recording always shows the real output of this
# version. Nothing is mocked.

Output demo/repolens.gif

Require node

Set Shell "bash"
Set FontSize 14
Set Width 1000
Set Height 1480
Set Padding 24
Set Theme { "name": "RepoLens", "background": "#0d1117", "foreground": "#e6edf3", "cursor": "#e6edf3", "selection": "#264f78", "black": "#484f58", "red": "#ff7b72", "green": "#3fb950", "yellow": "#d29922", "blue": "#58a6ff", "magenta": "#bc8cff", "cyan": "#39c5cf", "white": "#b1bac4", "brightBlack": "#8b949e", "brightRed": "#ffa198", "brightGreen": "#56d364", "brightYellow": "#e3b341", "brightBlue": "#79c0ff", "brightMagenta": "#d2a8ff", "brightCyan": "#56d4dd", "brightWhite": "#ffffff" }
Set TypingSpeed 45ms

Hide
Type `export REPOLENS_BIN="$PWD/dist/cli.js" DEMO_DIR="$(mktemp -d)/acme"` Enter
Type `cp -R test/fixtures/monorepo "$DEMO_DIR" && cd "$DEMO_DIR" && mv _gitignore .gitignore` Enter
Type `git init -q && git add -A && git -c user.name=demo -c user.email=demo@repolens.invalid commit -qm init --no-gpg-sign` Enter
Type `repolens() { node "$REPOLENS_BIN" "$@"; }` Enter
Type `export PS1='\[\e[2m\]~/acme\[\e[0m\] $ '` Enter
Type "clear" Enter
Show

Sleep 600ms
Type "repolens"
Sleep 400ms
Enter
Sleep 7s

Type "clear" Enter
Sleep 300ms
Type "repolens doctor"
Sleep 400ms
Enter
Sleep 7s
