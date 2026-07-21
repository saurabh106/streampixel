#!/usr/bin/env bash
set -euo pipefail

STORAGE_DIR="${STORAGE_PATH:-/opt/streampixel/storage}"

echo "==> Creating storage directory at ${STORAGE_DIR}"
mkdir -p "${STORAGE_DIR}/projects"
mkdir -p "${STORAGE_DIR}/tmp"

echo "==> Setting permissions (777) recursively on ${STORAGE_DIR}"
chmod -R 777 "${STORAGE_DIR}"

echo "==> Storage directory ready:"
ls -ld "${STORAGE_DIR}"
ls -ld "${STORAGE_DIR}/projects"
ls -ld "${STORAGE_DIR}/tmp"
