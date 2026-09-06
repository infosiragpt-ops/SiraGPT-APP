#!/usr/bin/env bash
# Explicitly authorized Lenovo rehearsal only. No production DB connection/app
# startup, runtime installation, publisher, restart, DNS, prune or volume removal.
set -Eeuo pipefail
umask 077
die() { printf '[rehearsal] %s\n' "$1" >&2; exit 1; }
[[ $# == 4 ]] || die 'Expected source directory, candidate SHA, private bundle directory, manifest SHA.'
SOURCE=$1; TARGET=$2; BUNDLE=$3; MANIFEST=$4
[[ $SOURCE =~ ^/home/user/deployments/doc-sandbox-phase1-tests/candidate-[A-Za-z0-9-]+$ ]] || die 'Unscoped source.'
[[ $BUNDLE =~ ^/home/user/deployments/doc-sandbox-phase1-tests/rehearsal-client-[A-Za-z0-9-]+$ ]] || die 'Unscoped bundle.'
[[ $TARGET =~ ^[a-f0-9]{40}$ && $MANIFEST =~ ^[a-f0-9]{64}$ ]] || die 'Full source identities required.'
actual=$(realpath "$SOURCE"); [[ $actual == "$SOURCE" ]] || die 'Source symlink.'
actual=$(realpath "$BUNDLE"); [[ $actual == "$BUNDLE" ]] || die 'Bundle symlink.'
actual=$(id -u); [[ $actual == 1000 ]] || die 'Expected unprivileged deployment user.'
PG_IMAGE=sha256:a36250871de0833b8757561c72f2477ef1ddd1101afa4e617fb552e0de514c6b
NODE_IMAGE=sha256:40f438311ab39713e617fc96b6dcbf5bdc62bf5141ddca954f739386da64176e
BACKUP=/home/user/deployments/iliagpt/backups/reviewed-81f3d9a63150-mBFiKm/database.dump.gz
BACKUP_HASH=48f4917bea18aec60d81fdf2f0754a3309b430b8af7bef47f0e7c45c383ffb16
SCOPE=doc-sandbox-phase1-rehearsal
PG_NAME=doc-sandbox-rehearsal-postgres
for file in "$BACKUP" "$BUNDLE/source-manifest.json" "$BUNDLE/phase1-migration-rehearsal.cjs"; do
  [[ -f $file && ! -L $file ]] || die 'Missing or unsafe required file.'
done
actual=$(realpath "$BACKUP"); [[ $actual == "$BACKUP" ]] || die 'Backup symlink.'
actual=$(stat -c '%a' "$BACKUP"); [[ $actual == 600 ]] || die 'Private backup required.'
actual=$(stat -c '%a' "$BUNDLE"); [[ $actual == 700 ]] || die 'Private bundle required.'
actual=$(sha256sum "$BACKUP"); [[ ${actual%% *} == "$BACKUP_HASH" ]] || die 'Backup identity changed.'
actual=$(sha256sum "$BUNDLE/source-manifest.json"); [[ ${actual%% *} == "$MANIFEST" ]] || die 'Manifest changed.'
for relative in prisma package.json package-lock.json node_modules; do
  [[ -e $SOURCE/backend/$relative && ! -L $SOURCE/backend/$relative ]] || die 'Missing or symlinked candidate input.'
done
for image in "$PG_IMAGE" "$NODE_IMAGE"; do
  actual=$(docker image inspect --format '{{.Id}} {{.Os}}/{{.Architecture}}' "$image")
  [[ $actual == "$image linux/amd64" ]] || die 'Required immutable image unavailable.'
done
existing=$(docker ps -a --filter "name=^/${PG_NAME}$" --format '{{.ID}}')
[[ -z $existing ]] || die 'Existing rehearsal PostgreSQL must be reviewed, not replaced.'
nonce=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n'); [[ $nonce =~ ^[a-f0-9]{32}$ ]] || die 'Invalid nonce.'
NETWORK="doc-sandbox-rehearsal-$nonce"
EVIDENCE=$(mktemp -d /home/user/deployments/doc-sandbox-phase1-tests/migration-rehearsal-XXXXXXXX)
chmod 700 "$EVIDENCE"
PG_ID=''; CLIENT_ID=''; CLIENT_NAME=''
verify_instance() {
  local value
  value=$(docker inspect --format '{{.Id}}|{{.Image}}|{{index .Config.Labels "siragpt.scope"}}|{{index .Config.Labels "siragpt.rehearsal"}}' "$1") || return 1
  [[ $value == "$1|$2|$SCOPE|$nonce" ]]
}
finish() {
  local status=$?
  trap - EXIT INT TERM HUP
  set +e
  # A failed create command can leave an object before reporting its ID. Resolve
  # only our exact name, then require full immutable ID/image/scope/nonce below.
  if [[ -z $PG_ID ]]; then PG_ID=$(docker inspect --format '{{.Id}}' "$PG_NAME" 2>/dev/null); fi
  if [[ -z $CLIENT_ID && -n $CLIENT_NAME ]]; then CLIENT_ID=$(docker inspect --format '{{.Id}}' "$CLIENT_NAME" 2>/dev/null); fi
  if [[ -n $CLIENT_ID ]]; then
    if verify_instance "$CLIENT_ID" "$NODE_IMAGE"; then docker stop -t 10 "$CLIENT_ID" >/dev/null || status=2; else status=2; fi
  fi
  if [[ -n $PG_ID ]]; then
    if verify_instance "$PG_ID" "$PG_IMAGE"; then docker stop -t 15 "$PG_ID" >/dev/null || status=2; else status=2; fi
  fi
  printf '[rehearsal] Exit=%s; private evidence=%s; scoped cleanup attempted (exit 2 means cleanup failed); no volumes removed.\n' "$status" "$EVIDENCE"
  exit "$status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
docker network create --internal --label "siragpt.scope=$SCOPE" --label "siragpt.rehearsal=$nonce" "$NETWORK" >/dev/null
actual=$(docker network inspect --format '{{.Internal}}' "$NETWORK"); [[ $actual == true ]] || die 'Network is not internal.'
PG_ID=$(docker create --name "$PG_NAME" --label "siragpt.scope=$SCOPE" --label "siragpt.rehearsal=$nonce" --network "$NETWORK" --pull never \
  --user 999:999 --read-only --cap-drop ALL --security-opt no-new-privileges --memory 2g --memory-swap 2g --cpus 1 --pids-limit 128 \
  --tmpfs /var/lib/postgresql/data:rw,nosuid,nodev,noexec,size=1536m,uid=999,gid=999,mode=0700 \
  --tmpfs /var/run/postgresql:rw,nosuid,nodev,noexec,size=16m,uid=999,gid=999,mode=0755 --tmpfs /tmp:rw,nosuid,nodev,noexec,size=32m \
  -e POSTGRES_USER=doc_fixture -e POSTGRES_PASSWORD=fixture-only-isolated -e POSTGRES_DB=doc_sandbox_fixture "$PG_IMAGE")
[[ $PG_ID =~ ^[a-f0-9]{64}$ ]] && verify_instance "$PG_ID" "$PG_IMAGE" || die 'New PostgreSQL identity rejected.'
actual=$(docker inspect --format '{{len .HostConfig.PortBindings}}|{{.HostConfig.Privileged}}' "$PG_ID"); [[ $actual == '0|false' ]] || die 'Unsafe PostgreSQL container.'
docker start "$PG_ID" >/dev/null
ready=0
for ((attempt=0; attempt<30; attempt++)); do
  if docker exec "$PG_ID" pg_isready -U doc_fixture -d doc_sandbox_fixture >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[[ $ready == 1 ]] || die 'Isolated PostgreSQL not ready.'
DB_A="doc_sandbox_rehearsal_$nonce"
second=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n'); [[ $second =~ ^[a-f0-9]{32}$ ]] || die 'Invalid recovery nonce.'
DB_B="doc_sandbox_rehearsal_$second"
[[ $DB_A != "$DB_B" ]] || die 'Distinct recovery database required.'
restore() {
  timeout -s TERM -k 15 30 docker exec "$PG_ID" createdb -U doc_fixture --template template0 "$2" 2> "$EVIDENCE/$3-create.log"
  gzip -dc "$1" | timeout -s TERM -k 15 240 docker exec -i "$PG_ID" sh -c 'status=0; pg_restore -U doc_fixture --dbname "$1" --no-owner --no-privileges --single-transaction --exit-on-error || status=$?; cat >/dev/null || exit 1; exit "$status"' sh "$2" > "$EVIDENCE/$3-restore.log" 2>&1
}
run_phase() {
  CLIENT_NAME="rehearsal-$nonce-$1"
  CLIENT_ID=$(docker create --name "$CLIENT_NAME" --label "siragpt.scope=$SCOPE" --label "siragpt.rehearsal=$nonce" --network "$NETWORK" --pull never \
    --user 1000:1000 --read-only --cap-drop ALL --security-opt no-new-privileges --memory 1g --memory-swap 1g --cpus 1 --pids-limit 128 \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=256m --mount "type=bind,src=$SOURCE/backend/prisma,dst=/workspace/backend/prisma,readonly" \
    --mount "type=bind,src=$SOURCE/backend/node_modules,dst=/workspace/backend/node_modules,readonly" \
    --mount "type=bind,src=$SOURCE/backend/package.json,dst=/workspace/backend/package.json,readonly" \
    --mount "type=bind,src=$SOURCE/backend/package-lock.json,dst=/workspace/backend/package-lock.json,readonly" \
    --mount "type=bind,src=$BUNDLE/phase1-migration-rehearsal.cjs,dst=/rehearsal.cjs,readonly" \
    --mount "type=bind,src=$BUNDLE/source-manifest.json,dst=/source-manifest.json,readonly" --mount "type=bind,src=$EVIDENCE,dst=/evidence" \
    --entrypoint node -e NODE_ENV=test "$NODE_IMAGE" /rehearsal.cjs "--phase=$1" "--database=$2" "--candidate-sha=$TARGET" "--backup-sha256=$BACKUP_HASH" "--source-manifest-sha256=$MANIFEST")
  [[ $CLIENT_ID =~ ^[a-f0-9]{64}$ ]] && verify_instance "$CLIENT_ID" "$NODE_IMAGE" || die 'Client identity rejected.'
  timeout -s TERM -k 15 240 docker start -ai "$CLIENT_ID" > "$EVIDENCE/$1-client.log" 2>&1
  actual=$(docker inspect --format '{{.State.Status}}|{{.State.ExitCode}}' "$CLIENT_ID")
  [[ $actual == 'exited|0' ]] || die 'Rehearsal phase failed.'
  CLIENT_ID=''; CLIENT_NAME=''
  printf '[rehearsal] %s passed.\n' "$1"
}
cp "$BACKUP" "$EVIDENCE/pre-f1.dump.gz"
actual=$(sha256sum "$EVIDENCE/pre-f1.dump.gz"); [[ ${actual%% *} == "$BACKUP_HASH" ]] || die 'Copied backup changed.'
gzip -t "$EVIDENCE/pre-f1.dump.gz"
restore "$EVIDENCE/pre-f1.dump.gz" "$DB_A" source
run_phase baseline "$DB_A"
run_phase upgrade "$DB_A"
timeout -s TERM -k 15 240 docker exec "$PG_ID" pg_dump -U doc_fixture --dbname "$DB_A" -Fc 2> "$EVIDENCE/post-f1-dump.log" | gzip -c > "$EVIDENCE/post-f1.dump.gz"
gzip -t "$EVIDENCE/post-f1.dump.gz"
restore "$EVIDENCE/post-f1.dump.gz" "$DB_B" recovery
run_phase recovered "$DB_B"
sha256sum "$EVIDENCE/pre-f1.dump.gz" "$EVIDENCE/post-f1.dump.gz" > "$EVIDENCE/archive-hashes.txt"
printf 'scope=%s\npostgres=%s\nnetwork=%s\nsource=%s\ncandidate=%s\n' "$SCOPE" "$PG_ID" "$NETWORK" "$SOURCE" "$TARGET" > "$EVIDENCE/infrastructure.txt"
printf '[rehearsal] Real restore, strict migration, preservation and post-admission restore passed. Application downgrade NOT verified.\n'
