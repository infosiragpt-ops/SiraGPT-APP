#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# siraGPT — PostgreSQL Backup
# ──────────────────────────────────────────────────────────────
# Automated backup script for the siraGPT PostgreSQL database.
# Designed to run as a cron job or systemd timer.
#
# Usage:
#   ./scripts/backup-db.sh                    # backup using defaults
#   ./scripts/backup-db.sh /path/to/backups   # custom output dir
#
# Environment variables (from .env or docker-compose):
#   POSTGRES_USER      (default: postgres)
#   POSTGRES_PASSWORD  (default: postgres)
#   POSTGRES_DB        (default: siragpt)
#   POSTGRES_HOST      (default: localhost)
#   POSTGRES_PORT      (default: 5432)
#   BACKUP_RETENTION_DAYS (default: 30)
# ──────────────────────────────────────────────────────────────

set -euo pipefail

# ─── Config ─────────────────────────────────────────────────
BACKUP_DIR="${1:-./backups/postgres}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"

DB_USER="${POSTGRES_USER:-postgres}"
DB_PASS="${POSTGRES_PASSWORD:-postgres}"
DB_NAME="${POSTGRES_DB:-siragpt}"
DB_HOST="${POSTGRES_HOST:-localhost}"
DB_PORT="${POSTGRES_PORT:-5432}"

TIMESTAMP=$(date -u '+%Y-%m-%dT%H-%M-%SZ')
FILENAME="siragpt-${DB_NAME}-${TIMESTAMP}.sql.gz"

# ─── Ensure backup directory exists ─────────────────────────
mkdir -p "${BACKUP_DIR}"

# ─── Run pg_dump ────────────────────────────────────────────
echo "[backup] Starting backup of ${DB_NAME}@${DB_HOST}:${DB_PORT}"

PGPASSWORD="${DB_PASS}" pg_dump \
    -h "${DB_HOST}" \
    -p "${DB_PORT}" \
    -U "${DB_USER}" \
    -d "${DB_NAME}" \
    --no-owner \
    --no-acl \
    --compress=9 \
    --file="${BACKUP_DIR}/${FILENAME}"

# Verify backup integrity
if [ ! -s "${BACKUP_DIR}/${FILENAME}" ]; then
    echo "[backup] ERROR: backup file is empty!" >&2
    exit 1
fi

# Quick integrity check: verify gzip is valid
if ! gzip -t "${BACKUP_DIR}/${FILENAME}" 2>/dev/null; then
    echo "[backup] ERROR: backup file is corrupted!" >&2
    rm -f "${BACKUP_DIR}/${FILENAME}"
    exit 1
fi

BACKUP_SIZE=$(du -h "${BACKUP_DIR}/${FILENAME}" | cut -f1)
echo "[backup] ✅ Backup complete: ${BACKUP_DIR}/${FILENAME} (${BACKUP_SIZE})"

# ─── Cleanup old backups ────────────────────────────────────
echo "[backup] Cleaning backups older than ${RETENTION_DAYS} days..."
find "${BACKUP_DIR}" -name "siragpt-*.sql.gz" -type f -mtime "+${RETENTION_DAYS}" -delete
OLD_COUNT=$(find "${BACKUP_DIR}" -name "siragpt-*.sql.gz" -type f | wc -l)
echo "[backup] ${OLD_COUNT} backup(s) retained"

# ─── Create latest symlink ──────────────────────────────────
ln -sf "${BACKUP_DIR}/${FILENAME}" "${BACKUP_DIR}/siragpt-latest.sql.gz"

echo "[backup] All done."
