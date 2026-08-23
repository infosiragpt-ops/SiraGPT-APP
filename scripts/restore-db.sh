#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# restore-db.sh — restore drill: latest S3 backup → scratch DB → verify.
#
# Proves that the newest siraGPT_*.sql.gz backup in S3 can actually be
# restored into a working Postgres with the expected schema and data.
# Never touches the live application database: it restores into a
# disposable database whose name is prefixed DRILL_DB_PREFIX (default:
# siragpt_drill_) and drops it afterwards.
#
# Usage:
#   ./scripts/restore-db.sh                          # auto-download from S3
#   ./scripts/restore-db.sh /path/to/backup.sql.gz   # local file, skip download
#   DRILL_KEEP_SCRATCH_DB=1 ./scripts/restore-db.sh  # don't drop the drill DB
#
# Env vars:
#   DATABASE_URL          required. Postgres ADMIN connection string (the
#                         drill connects to this server and creates/drops its
#                         own scratch database). Falls back to
#                         PRISMA_DATABASE_URL, matching backup-db.sh.
#   BACKUP_BUCKET         required unless a backup file is passed as $1.
#   BACKUP_ACCESS_KEY_ID / BACKUP_SECRET_ACCESS_KEY
#   BACKUP_S3_ENDPOINT / BACKUP_S3_REGION   optional, same semantics as db-backup.yml
#   DRILL_MIN_TABLES      minimum table count to accept (default: 100;
#                         production schema has 138 Prisma models).
#   DRILL_CORE_TABLES     comma-separated tables that must exist AND have >0 rows
#                         (default: "users,chats,messages").
#   DRILL_KEEP_SCRATCH_DB set to 1 to keep the scratch database for inspection.
#   PG_RESTORE_BIN        optional. Defaults to `psql` on PATH.
#   AWS_BIN               optional. Defaults to `aws` on PATH.
#
# Exit codes:
#   0 success | 1 missing config | 2 download failure | 3 checksum mismatch
#   4 gzip corrupt | 5 psql/restore failure | 6 verification failed
# ──────────────────────────────────────────────────────────────

set -euo pipefail

DATABASE_URL="${DATABASE_URL:-${PRISMA_DATABASE_URL:-}}"
BACKUP_FILE_ARG="${1:-}"

if [[ -z "${DATABASE_URL}" ]]; then
  echo "[restore-db] ERROR: DATABASE_URL/PRISMA_DATABASE_URL is not set" >&2
  exit 1
fi

PSQL_BIN="${PG_RESTORE_BIN:-psql}"
AWS_BIN="${AWS_BIN:-aws}"
MIN_TABLES="${DRILL_MIN_TABLES:-100}"
CORE_TABLES="${DRILL_CORE_TABLES:-users,chats,messages}"
KEEP_SCRATCH="${DRILL_KEEP_SCRATCH_DB:-0}"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/siragpt-restore-drill.XXXXXX")"

db_url_part() {
  # Extract one component from the postgres:// URL without printing the rest.
  local part="$1"
  case "${part}" in
    user)
      printf '%s\n' "${DATABASE_URL}" \
        | sed -n -E -e 's#^[A-Za-z][A-Za-z0-9+.-]*://([^:@/]*):[^@/]*@.*#\1#p' \
                    -e 's#^[A-Za-z][A-Za-z0-9+.-]*://([^:@/]*)@.*#\1#p' | head -n 1 ;;
    password)
      printf '%s\n' "${DATABASE_URL}" \
        | sed -n -E 's#^[A-Za-z][A-Za-z0-9+.-]*://[^:@/]+:([^@/]*)@.*#\1#p' | head -n 1 ;;
    host)
      printf '%s\n' "${DATABASE_URL}" \
        | sed -n -E 's#^[A-Za-z][A-Za-z0-9+.-]*://([^@/]*)@([^:/]*).*#\2#p' | head -n 1 ;;
    port)
      printf '%s\n' "${DATABASE_URL}" \
        | sed -n -E 's#^[A-Za-z][A-Za-z0-9+.-]*://[^@/]*@[^:/]*:([0-9]+)/.*#\1#p' | head -n 1 ;;
    *) return 1 ;;
  esac
}

cleanup() {
  if [[ -n "${DRILL_DB:-}" && "${KEEP_SCRATCH}" != "1" ]]; then
    echo "[restore-db] Dropping scratch database ${DRILL_DB}…"
    psql_admin -v ON_ERROR_STOP=1 -c "DROP DATABASE \"${DRILL_DB}\";" >/dev/null 2>&1 || \
      echo "[restore-db] WARN: could not drop scratch DB ${DRILL_DB}; remove it manually." >&2
  fi
  if [[ "${KEEP_SCRATCH}" != "1" ]]; then
    rm -rf "${WORK_DIR}"
  fi
}
trap cleanup EXIT

# Parse admin connection params out of DATABASE_URL without leaking it.
DB_HOST="$(db_url_part host)"
DB_PORT="$(db_url_part port)"
DB_USER="$(db_url_part user)"
DB_PASS="$(db_url_part password)"
DB_PORT="${DB_PORT:-5432}"

if [[ -z "${DB_HOST}" || -z "${DB_USER}" ]]; then
  echo "[restore-db] ERROR: could not parse host/user out of DATABASE_URL" >&2
  exit 1
fi

psql_admin() {
  PGPASSWORD="${DB_PASS}" "${PSQL_BIN}" \
    -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d postgres "$@"
}

# ── 1. Obtain the backup file ────────────────────────────────
if [[ -n "${BACKUP_FILE_ARG}" ]]; then
  BACKUP_FILE="${BACKUP_FILE_ARG}"
  echo "[restore-db] Using provided backup file: ${BACKUP_FILE}"
else
  for v in BACKUP_BUCKET BACKUP_ACCESS_KEY_ID BACKUP_SECRET_ACCESS_KEY; do
    if [[ -z "${!v:-}" ]]; then
      echo "[restore-db] ERROR: ${v} is not set and no backup file was provided" >&2
      exit 1
    fi
  done

  export AWS_ACCESS_KEY_ID="${BACKUP_ACCESS_KEY_ID}"
  export AWS_SECRET_ACCESS_KEY="${BACKUP_SECRET_ACCESS_KEY}"
  AWS_ARGS=()
  [[ -n "${BACKUP_S3_ENDPOINT:-}" ]] && AWS_ARGS+=(--endpoint-url "${BACKUP_S3_ENDPOINT}")
  [[ -n "${BACKUP_S3_REGION:-}" ]] && AWS_ARGS+=(--region "${BACKUP_S3_REGION}")
  # Portable empty-array expansion: works under set -u on both macOS bash 3.2
  # and the VPS's GNU bash without passing a stray empty argument.
  AWS_EXPAND=( )
  [[ ${#AWS_ARGS[@]} -gt 0 ]] && AWS_EXPAND=( "${AWS_ARGS[@]}" )

  echo "[restore-db] Listing s3://${BACKUP_BUCKET}/ …"
  LATEST_KEY="$("${AWS_BIN}" ${AWS_EXPAND[@]+"${AWS_EXPAND[@]}"} s3 ls "s3://${BACKUP_BUCKET}/" \
    | awk '$4 ~ /^siraGPT_(daily|weekly)_[0-9]{8}T[0-9]{6}Z\.sql\.gz$/ {print $4}' \
    | sort | tail -n 1 || true)"
  if [[ -z "${LATEST_KEY}" ]]; then
    echo "[restore-db] ERROR: no siraGPT_*.sql.gz backups found in s3://${BACKUP_BUCKET}/" >&2
    exit 2
  fi
  echo "[restore-db] Latest backup in S3: ${LATEST_KEY}"

  "${AWS_BIN}" ${AWS_EXPAND[@]+"${AWS_EXPAND[@]}"} s3 cp "s3://${BACKUP_BUCKET}/${LATEST_KEY}" "${WORK_DIR}/${LATEST_KEY}" --only-show-errors
  "${AWS_BIN}" ${AWS_EXPAND[@]+"${AWS_EXPAND[@]}"} s3 cp "s3://${BACKUP_BUCKET}/${LATEST_KEY}.sha256" "${WORK_DIR}/${LATEST_KEY}.sha256" --only-show-errors 2>/dev/null || true
  BACKUP_FILE="${WORK_DIR}/${LATEST_KEY}"
fi

# ── 2. Integrity gates before touching Postgres ─────────────
if [[ -f "${BACKUP_FILE}.sha256" ]]; then
  echo "[restore-db] Verifying sha256…"
  # Compare hashes directly instead of trusting `sha256sum -c` exit status:
  # some builds return 0 even for improperly formatted check files.
  EXPECTED_SHA="$(awk '{print $1}' "${BACKUP_FILE}.sha256" | head -n 1)"
  ACTUAL_SHA="$(sha256sum "${BACKUP_FILE}" | awk '{print $1}')"
  if [[ -z "${EXPECTED_SHA}" || -z "${ACTUAL_SHA}" || "${EXPECTED_SHA}" != "${ACTUAL_SHA}" ]]; then
    echo "[restore-db] ERROR: sha256 checksum MISMATCH for ${BACKUP_FILE##*/} (expected=${EXPECTED_SHA:-<empty>} actual=${ACTUAL_SHA:-<empty>})" >&2
    exit 3
  fi
else
  echo "[restore-db] WARN: no .sha256 sidecar found; skipping checksum gate."
fi

if ! gzip -t "${BACKUP_FILE}"; then
  echo "[restore-db] ERROR: backup file failed gzip integrity check" >&2
  exit 4
fi

# ── 3. Restore into a disposable database ────────────────────
DRILL_DB="$(printf 'siragpt_drill_%s' "$(date -u +%Y%m%dT%H%M%SZ)")"
echo "[restore-db] Creating scratch database ${DRILL_DB}…"
psql_admin -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"${DRILL_DB}\";"

psql_drill() {
  PGPASSWORD="${DB_PASS}" "${PSQL_BIN}" \
    -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DRILL_DB}" "$@"
}

echo "[restore-db] Restoring $(du -h "${BACKUP_FILE}" | cut -f1) into ${DRILL_DB}…"
RESTORE_LOG="${WORK_DIR}/restore.log"
if ! gunzip -c "${BACKUP_FILE}" | psql_drill -v ON_ERROR_STOP=1 -q >"${RESTORE_LOG}" 2>&1; then
  echo "[restore-db] ERROR: psql restore failed. Last errors:" >&2
  grep -E '^psql.*ERROR|^ERROR' "${RESTORE_LOG}" | head -20 >&2 || tail -20 "${RESTORE_LOG}" >&2
  echo "[restore-db] Scratch DB ${DRILL_DB} kept for inspection; work dir: ${WORK_DIR}" >&2
  DRILL_DB=""   # cleanup must not drop the evidence
  KEEP_SCRATCH=1
  exit 5
fi

# ── 4. Verify the restored content ───────────────────────────
TABLE_COUNT="$(psql_drill -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';")"
echo "[restore-db] Restored public tables: ${TABLE_COUNT} (minimum required: ${MIN_TABLES})"
if ! [[ "${TABLE_COUNT}" =~ ^[0-9]+$ ]] || (( TABLE_COUNT < MIN_TABLES )); then
  echo "[restore-db] ERROR: restored schema has too few tables (${TABLE_COUNT} < ${MIN_TABLES})" >&2
  exit 6
fi

FAILED_CORE=""
IFS=',' read -ra CORE_ARR <<< "${CORE_TABLES}"
for t in "${CORE_ARR[@]}"; do
  t_trimmed="$(printf '%s' "${t}" | tr -d '[:space:]')"
  [[ -z "${t_trimmed}" ]] && continue
  ROWS="$(psql_drill -tAc "SELECT count(*) FROM \"${t_trimmed}\";" 2>/dev/null || echo "-1")"
  echo "[restore-db] Core table ${t_trimmed}: ${ROWS} rows"
  if ! [[ "${ROWS}" =~ ^[0-9]+$ ]] || (( ROWS < 1 )); then
    FAILED_CORE+="${t_trimmed} "
  fi
done
if [[ -n "${FAILED_CORE}" ]]; then
  echo "[restore-db] ERROR: core tables empty or missing after restore: ${FAILED_CORE}" >&2
  exit 6
fi

echo "[restore-db] ✅ RESTORE DRILL PASSED — backup ${BACKUP_FILE##*/} restores cleanly (${TABLE_COUNT} tables, core data present)."
