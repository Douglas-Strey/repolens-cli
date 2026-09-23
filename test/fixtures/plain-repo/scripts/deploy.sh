#!/usr/bin/env bash
# Deploy the latest build to the target host.
set -euo pipefail

TARGET_HOST="${1:?usage: deploy.sh <host>}"
RELEASE="$(date +%Y%m%d%H%M%S)"

echo "Deploying release ${RELEASE} to ${TARGET_HOST}"
rsync -az --delete --exclude '.venv' ./ "deploy@${TARGET_HOST}:/srv/plain-repo/releases/${RELEASE}/"
ssh "deploy@${TARGET_HOST}" "ln -sfn /srv/plain-repo/releases/${RELEASE} /srv/plain-repo/current"
echo "Done."
