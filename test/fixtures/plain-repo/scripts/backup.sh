#!/usr/bin/env bash
# Archive the output directory with a timestamp.
set -euo pipefail

OUT_DIR="${OUT_DIR:-output}"
BACKUP_DIR="${BACKUP_DIR:-backups}"

mkdir -p "${BACKUP_DIR}"
tar -czf "${BACKUP_DIR}/output-$(date +%F).tar.gz" "${OUT_DIR}"
echo "Backup written to ${BACKUP_DIR}"
