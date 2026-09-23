#!/usr/bin/env bash
# Render demo/repolens.gif from demo/demo.tape.
#
#   ./demo/render.sh
#
# `vhs demo/demo.tape` writes the GIF directly on most setups. Some VHS builds
# (seen with VHS 0.12 on macOS) record the frames and then exit without encoding
# the GIF, so this script asks VHS for the PNG frames and encodes them with
# FFmpeg, applying the tape's size, padding and background like VHS would.
set -euo pipefail
cd "$(dirname "$0")/.."

for tool in vhs ffmpeg pnpm; do
  command -v "$tool" >/dev/null || { echo "$tool is required (brew install vhs ffmpeg)" >&2; exit 1; }
done

pnpm build >/dev/null

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

tape=demo/demo.tape
setting() { awk -v key="$1" '$1 == "Set" && $2 == key { print $3 }' "$tape"; }
width="$(setting Width)"
height="$(setting Height)"
background="$(grep -o '"background": *"#[0-9a-fA-F]*"' "$tape" | grep -o '#[0-9a-fA-F]*')"
output="$(awk '$1 == "Output" { print $2 }' "$tape")"

sed "s#^Output .*#Output \"$work/frames/\"#" "$tape" > "$work/demo.tape"
vhs --quiet "$work/demo.tape"

ffmpeg -loglevel error -y \
  -framerate 50 -i "$work/frames/frame-text-%05d.png" \
  -framerate 50 -i "$work/frames/frame-cursor-%05d.png" \
  -filter_complex "[0][1]overlay,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${background},fps=20,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" \
  "$output"

echo "Wrote $output ($(du -h "$output" | cut -f1))"
