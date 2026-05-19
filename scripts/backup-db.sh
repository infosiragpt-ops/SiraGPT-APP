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

# Source the project .env if present so POSTGRES_USER / POSTGRES_PASSWORD
# / POSTGRES_DB pick up the deployed values. Without this, the defaults
# below fell back to user "postgres" which doesn't exist on the VPS —
# its Postgres container was initialised with user "myuser".
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
if [[ -f "${PROJECT_ROOT}/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "${PROJECT_ROOT}/.env"
    set +a
fi

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
BACKUP_BYTES=$(wc -c < "${BACKUP_DIR}/${FILENAME}" | tr -d ' ')
echo "[backup] ✅ Backup complete: ${BACKUP_DIR}/${FILENAME} (${BACKUP_SIZE})"

# ─── Cleanup old backups ────────────────────────────────────
echo "[backup] Cleaning backups older than ${RETENTION_DAYS} days..."
find "${BACKUP_DIR}" -name "siragpt-*.sql.gz" -type f -mtime "+${RETENTION_DAYS}" -delete
OLD_COUNT=$(find "${BACKUP_DIR}" -name "siragpt-*.sql.gz" -type f | wc -l)
echo "[backup] ${OLD_COUNT} backup(s) retained"

# ─── Create latest symlink ──────────────────────────────────
ln -sf "${BACKUP_DIR}/${FILENAME}" "${BACKUP_DIR}/siragpt-latest.sql.gz"

# ─── Record backup metadata into SystemSettings ─────────────
# Cycle 45: the /api/admin/backups endpoint reads this row to surface
# last-backup timestamp, size, retention count, and next ETA.
# Schedule defaults to 02:00 UTC daily (see ops/cron.d/siragpt-backup);
# override via BACKUP_CRON_SCHEDULE for non-standard installs.
META_TS=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
META_SCHEDULE="${BACKUP_CRON_SCHEDULE:-0 2 * * *}"
META_JSON=$(printf '{"timestamp":"%s","sizeBytes":%s,"sizeMB":%s,"filename":"%s","retained":%s,"retentionDays":%s,"schedule":"%s"}' \
    "${META_TS}" \
    "${BACKUP_BYTES:-0}" \
    "$(awk -v b="${BACKUP_BYTES:-0}" 'BEGIN{printf "%.2f", b/1048576}')" \
    "${FILENAME}" \
    "${OLD_COUNT:-0}" \
    "${RETENTION_DAYS}" \
    "${META_SCHEDULE}")

echo "[backup] Recording metadata into system_settings(key='last_db_backup')..."
if ! PGPASSWORD="${DB_PASS}" psql \
    -h "${DB_HOST}" \
    -p "${DB_PORT}" \
    -U "${DB_USER}" \
    -d "${DB_NAME}" \
    --quiet \
    --no-psqlrc \
    -v ON_ERROR_STOP=1 \
    -v meta="${META_JSON}" \
    -c "INSERT INTO system_settings (id, key, value) VALUES ('last_db_backup', 'last_db_backup', :'meta') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;" \
    >/dev/null 2>&1; then
    echo "[backup] WARN: failed to record metadata to system_settings (table missing or DB unreachable). Continuing." >&2
fi

echo "[backup] All done."
