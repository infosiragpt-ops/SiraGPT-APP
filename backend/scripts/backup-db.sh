#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# backup-db.sh — pg_dump → gzip → rotate.
#
# What it does:
#   1. Dumps the database addressed by $DATABASE_URL via `pg_dump`.
#   2. Writes a timestamped, gzip-compressed file under ./backups/.
#   3. Retention policy:
#        - keep last 7 DAILY backups  (siraGPT_daily_*.sql.gz)
#        - keep last 4 WEEKLY backups (siraGPT_weekly_*.sql.gz, Sundays)
#      Older daily/weekly backups are deleted with `find -mtime`.
#
# Env vars:
#   DATABASE_URL   required. Postgres connection string.
#   BACKUP_DIR     optional. Defaults to ./backups (resolved from $PWD).
#   PG_DUMP_BIN    optional. Defaults to `pg_dump` on PATH.
#
# Exit codes:
#   0 success | 1 missing DATABASE_URL | 2 pg_dump failure | 3 gzip failure
# ──────────────────────────────────────────────────────────────────────

set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "[backup-db] ERROR: DATABASE_URL is not set" >&2
  exit 1
fi

BACKUP_DIR="${BACKUP_DIR:-$PWD/backups}"
PG_DUMP_BIN="${PG_DUMP_BIN:-pg_dump}"

mkdir -p "$BACKUP_DIR"

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
# 0 = Sunday on both GNU and BSD `date`. Sundays are "weekly".
DOW="$(date -u +%u)"   # 1..7 (Monday..Sunday). 7 == Sunday.
if [[ "$DOW" == "7" ]]; then
  KIND="weekly"
else
  KIND="daily"
fi

OUT_FILE="$BACKUP_DIR/siraGPT_${KIND}_${TIMESTAMP}.sql.gz"

echo "[backup-db] Dumping $KIND backup → $OUT_FILE"

# pg_dump → gzip in a single pipe. -Fp = plain SQL (compressible).
# Use --no-owner / --no-acl so the dump restores cleanly into a fresh DB
# with a different role.
if ! "$PG_DUMP_BIN" --no-owner --no-acl --dbname="$DATABASE_URL" \
     | gzip -9 > "$OUT_FILE"; then
  echo "[backup-db] ERROR: pg_dump|gzip failed" >&2
  # Clean up partial file so the rotation logic doesn't keep it.
  rm -f "$OUT_FILE"
  exit 2
fi

# Sanity check the resulting file is non-trivial. A "successful" dump of
# an empty schema is still ≥ a few hundred bytes (header + SET statements).
SIZE="$(wc -c < "$OUT_FILE" | tr -d ' ')"
if [[ "$SIZE" -lt 200 ]]; then
  echo "[backup-db] ERROR: dump file looks empty (${SIZE} bytes)" >&2
  rm -f "$OUT_FILE"
  exit 3
fi

echo "[backup-db] OK — ${SIZE} bytes"

# ── Retention ─────────────────────────────────────────────────────────
# We don't track a sequence file — just trust mtime + the kind prefix.
# `find -mtime +N` keeps the last N+1 days; we want to keep 7 dailies and
# 4 weeklies (~28 days), so:
echo "[backup-db] Pruning old daily backups (>7 days)…"
find "$BACKUP_DIR" -type f -name 'siraGPT_daily_*.sql.gz' -mtime +7 -print -delete || true

echo "[backup-db] Pruning old weekly backups (>28 days)…"
find "$BACKUP_DIR" -type f -name 'siraGPT_weekly_*.sql.gz' -mtime +28 -print -delete || true

echo "[backup-db] Done."
