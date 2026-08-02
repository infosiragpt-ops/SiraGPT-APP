#!/usr/bin/env bash
# Create a release-scoped production backup and prove it can be restored in an
# isolated PostgreSQL container before any migration is allowed to run.

set -Eeuo pipefail
umask 077

DOCKER_BIN="${DOCKER_BIN:-docker}"
GZIP_BIN="${GZIP_BIN:-gzip}"
SHA256_BIN="${SHA256_BIN:-sha256sum}"
OPENSSL_BIN="${OPENSSL_BIN:-openssl}"
RELEASE_SHA="${RELEASE_SHA:-}"
BACKUP_DIR="${BACKUP_DIR:-$PWD/backups/releases}"
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-}"
RESTORE_TIMEOUT_SECONDS="${RESTORE_TIMEOUT_SECONDS:-180}"
MIN_BACKUP_BYTES="${MIN_BACKUP_BYTES:-200}"

RESTORE_CONTAINER=""
PARTIAL_BACKUP=""
PARTIAL_MANIFEST=""

fail() {
  echo "[pre-deploy-db-backup] ERROR: $*" >&2
  exit 1
}

cleanup() {
  local status="$?"
  if [[ -n "${RESTORE_CONTAINER}" ]]; then
    "${DOCKER_BIN}" stop --time 5 "${RESTORE_CONTAINER}" >/dev/null 2>&1 \
      || "${DOCKER_BIN}" rm --force "${RESTORE_CONTAINER}" >/dev/null 2>&1 \
      || true
  fi
  if [[ -n "${PARTIAL_BACKUP}" && -f "${PARTIAL_BACKUP}" ]]; then
    rm -f "${PARTIAL_BACKUP}"
  fi
  if [[ -n "${PARTIAL_MANIFEST}" && -f "${PARTIAL_MANIFEST}" ]]; then
    rm -f "${PARTIAL_MANIFEST}"
  fi
  exit "${status}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if ! [[ "${RELEASE_SHA}" =~ ^[0-9a-f]{40}$ ]]; then
  fail "RELEASE_SHA must be a lowercase 40-character Git SHA"
fi
if ! [[ "${RESTORE_TIMEOUT_SECONDS}" =~ ^[1-9][0-9]*$ ]]; then
  fail "RESTORE_TIMEOUT_SECONDS must be a positive integer"
fi
if ! [[ "${MIN_BACKUP_BYTES}" =~ ^[1-9][0-9]*$ ]]; then
  fail "MIN_BACKUP_BYTES must be a positive integer"
fi
if [[ -L "${BACKUP_DIR}" ]]; then
  fail "BACKUP_DIR must not be a symlink"
fi

mkdir -p "${BACKUP_DIR}"
chmod 0700 "${BACKUP_DIR}"

if [[ -z "${POSTGRES_CONTAINER}" ]]; then
  POSTGRES_CONTAINER="$("${DOCKER_BIN}" ps \
    --filter 'label=com.docker.compose.service=db' \
    --format '{{.Names}}' | sed -n '1p')"
fi
if [[ -z "${POSTGRES_CONTAINER}" ]]; then
  fail "no running Compose PostgreSQL container was found"
fi

SOURCE_IMAGE_ID="$("${DOCKER_BIN}" inspect --format '{{.Image}}' "${POSTGRES_CONTAINER}")"
if ! [[ "${SOURCE_IMAGE_ID}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  fail "source PostgreSQL image identity is invalid"
fi
"${DOCKER_BIN}" image inspect "${SOURCE_IMAGE_ID}" >/dev/null

SOURCE_IDENTITY="$("${DOCKER_BIN}" exec "${POSTGRES_CONTAINER}" sh -lc \
  'printf "%s\n%s\n" "${POSTGRES_USER:-postgres}" "${POSTGRES_DB:-postgres}"')"
SOURCE_USER="$(printf '%s\n' "${SOURCE_IDENTITY}" | sed -n '1p')"
SOURCE_DATABASE="$(printf '%s\n' "${SOURCE_IDENTITY}" | sed -n '2p')"
if [[ -z "${SOURCE_USER}" || -z "${SOURCE_DATABASE}" ]]; then
  fail "source PostgreSQL user/database identity is unavailable"
fi

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_BASENAME="siragpt_release_${RELEASE_SHA}_${TIMESTAMP}_$$.sql.gz"
BACKUP_FILE="${BACKUP_DIR}/${BACKUP_BASENAME}"
CHECKSUM_FILE="${BACKUP_FILE}.sha256"
MANIFEST_FILE="${BACKUP_FILE}.manifest"
PARTIAL_BACKUP="$(mktemp "${BACKUP_DIR}/.${BACKUP_BASENAME}.XXXXXX.partial")"

echo "[pre-deploy-db-backup] Creating release checkpoint for ${RELEASE_SHA}"
if ! {
  "${DOCKER_BIN}" exec "${POSTGRES_CONTAINER}" pg_dump \
    --no-owner \
    --no-acl \
    --format=plain \
    --username "${SOURCE_USER}" \
    --dbname "${SOURCE_DATABASE}" \
    | "${GZIP_BIN}" -9 > "${PARTIAL_BACKUP}"
}; then
  fail "pg_dump or compression failed"
fi

"${GZIP_BIN}" -t "${PARTIAL_BACKUP}" || fail "backup gzip integrity check failed"
BACKUP_SIZE="$(wc -c < "${PARTIAL_BACKUP}" | tr -d '[:space:]')"
if [[ "${BACKUP_SIZE}" -lt "${MIN_BACKUP_BYTES}" ]]; then
  fail "backup is unexpectedly small (${BACKUP_SIZE} bytes)"
fi
mv "${PARTIAL_BACKUP}" "${BACKUP_FILE}"
PARTIAL_BACKUP=""
chmod 0600 "${BACKUP_FILE}"

BACKUP_SHA256="$("${SHA256_BIN}" "${BACKUP_FILE}" | awk '{print $1}')"
printf '%s  %s\n' "${BACKUP_SHA256}" "${BACKUP_BASENAME}" > "${CHECKSUM_FILE}"
chmod 0600 "${CHECKSUM_FILE}"
(
  cd "${BACKUP_DIR}"
  "${SHA256_BIN}" --check --strict "$(basename "${CHECKSUM_FILE}")" >/dev/null
) || fail "backup checksum verification failed"

SOURCE_TABLES="$("${DOCKER_BIN}" exec "${POSTGRES_CONTAINER}" psql \
  -X -Atq \
  --username "${SOURCE_USER}" \
  --dbname "${SOURCE_DATABASE}" \
  --command "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname = 'public';")"
SOURCE_MIGRATION_TABLE="$("${DOCKER_BIN}" exec "${POSTGRES_CONTAINER}" psql \
  -X -Atq \
  --username "${SOURCE_USER}" \
  --dbname "${SOURCE_DATABASE}" \
  --command "SELECT CASE WHEN to_regclass('public.\"_prisma_migrations\"') IS NULL THEN 'missing' ELSE 'present' END;")"
if ! [[ "${SOURCE_TABLES}" =~ ^[1-9][0-9]*$ ]] || [[ "${SOURCE_MIGRATION_TABLE}" != "present" ]]; then
  fail "source schema or Prisma migration history is unavailable"
fi
SOURCE_MIGRATIONS="$("${DOCKER_BIN}" exec "${POSTGRES_CONTAINER}" psql \
  -X -Atq \
  --username "${SOURCE_USER}" \
  --dbname "${SOURCE_DATABASE}" \
  --command 'SELECT count(*) FROM "_prisma_migrations";')"
if ! [[ "${SOURCE_MIGRATIONS}" =~ ^[0-9]+$ ]]; then
  fail "source Prisma migration count is invalid"
fi

RESTORE_PASSWORD="$("${OPENSSL_BIN}" rand -hex 24)"
RESTORE_CONTAINER="siragpt-restore-${RELEASE_SHA:0:12}-$$"
"${DOCKER_BIN}" run -d --rm \
  --network none \
  --name "${RESTORE_CONTAINER}" \
  --env "POSTGRES_PASSWORD=${RESTORE_PASSWORD}" \
  --env POSTGRES_DB=siragpt_restore \
  "${SOURCE_IMAGE_ID}" >/dev/null

RESTORE_DEADLINE=$(( $(date +%s) + RESTORE_TIMEOUT_SECONDS ))
until "${DOCKER_BIN}" exec "${RESTORE_CONTAINER}" pg_isready \
  --username postgres --dbname siragpt_restore >/dev/null 2>&1; do
  if [[ $(date +%s) -ge "${RESTORE_DEADLINE}" ]]; then
    fail "isolated PostgreSQL restore container did not become ready"
  fi
  sleep 1
done

echo "[pre-deploy-db-backup] Restoring checkpoint in a network-isolated PostgreSQL container"
if ! {
  "${GZIP_BIN}" -dc "${BACKUP_FILE}" \
    | "${DOCKER_BIN}" exec -i "${RESTORE_CONTAINER}" psql \
      -X -v ON_ERROR_STOP=1 \
      --username postgres \
      --dbname siragpt_restore >/dev/null
}; then
  fail "isolated restore failed"
fi

RESTORED_TABLES="$("${DOCKER_BIN}" exec "${RESTORE_CONTAINER}" psql \
  -X -Atq \
  --username postgres \
  --dbname siragpt_restore \
  --command "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname = 'public';")"
RESTORED_MIGRATIONS="$("${DOCKER_BIN}" exec "${RESTORE_CONTAINER}" psql \
  -X -Atq \
  --username postgres \
  --dbname siragpt_restore \
  --command 'SELECT count(*) FROM "_prisma_migrations";')"
if [[ "${RESTORED_TABLES}" != "${SOURCE_TABLES}" ]]; then
  fail "restored public table count differs from source (${RESTORED_TABLES}/${SOURCE_TABLES})"
fi
if [[ "${RESTORED_MIGRATIONS}" != "${SOURCE_MIGRATIONS}" ]]; then
  fail "restored migration history differs from source (${RESTORED_MIGRATIONS}/${SOURCE_MIGRATIONS})"
fi

VERIFIED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
PARTIAL_MANIFEST="$(mktemp "${BACKUP_DIR}/.${BACKUP_BASENAME}.XXXXXX.manifest")"
{
  printf 'release_sha=%s\n' "${RELEASE_SHA}"
  printf 'backup_file=%s\n' "${BACKUP_BASENAME}"
  printf 'sha256=%s\n' "${BACKUP_SHA256}"
  printf 'bytes=%s\n' "${BACKUP_SIZE}"
  printf 'source_image=%s\n' "${SOURCE_IMAGE_ID}"
  printf 'public_tables=%s\n' "${SOURCE_TABLES}"
  printf 'prisma_migrations=%s\n' "${SOURCE_MIGRATIONS}"
  printf 'restore_network=none\n'
  printf 'restore_verified_at=%s\n' "${VERIFIED_AT}"
} > "${PARTIAL_MANIFEST}"
mv "${PARTIAL_MANIFEST}" "${MANIFEST_FILE}"
PARTIAL_MANIFEST=""
chmod 0600 "${MANIFEST_FILE}"

"${DOCKER_BIN}" stop --time 5 "${RESTORE_CONTAINER}" >/dev/null
RESTORE_CONTAINER=""

echo "[pre-deploy-db-backup] Restore proof passed: ${BACKUP_FILE}"
echo "[pre-deploy-db-backup] Manifest: ${MANIFEST_FILE}"
