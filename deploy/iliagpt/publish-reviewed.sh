#!/usr/bin/env bash
# Reviewed Lenovo-only release. Invoke with: <approved target SHA> <expected live SHA>.
# No migrations, DNS changes, gateway recreation, pruning or checkout replacement.
set -Eeuo pipefail
umask 077
export LC_ALL=C
REPO=/home/user/SiraGPT-APP
DEPLOY=/home/user/deployments/iliagpt
LOCK=/tmp/siragpt-publish.lock
ORIGIN=https://siragpt.com
exec 3>&1
die() { printf '[publish] %s\n' "$1" >&3; exit 1; }
[[ $# == 2 && $1 =~ ^[0-9a-f]{40}$ && $2 =~ ^[0-9a-f]{40}$ ]] || die 'Two full lowercase commit SHAs are required.'
TARGET=$1; PREVIOUS=$2
[[ $TARGET != "$PREVIOUS" ]] || die 'Target is already the expected live release.'
[[ -d $REPO && -d $DEPLOY && ! -L $REPO && ! -L $DEPLOY ]] || die 'Unexpected Lenovo paths.'
mkdir "$LOCK" 2>/dev/null || die 'Another publication owns the lock; do not remove it automatically.'
ACTIVATED=0; ENV_CHANGED=0; BACKUP=''; LOG=/dev/null
COMPOSE=(docker compose -p iliagpt -f "$DEPLOY/compose.yaml" --env-file "$DEPLOY/.env")
checkout_clean() {
  local changes head
  head=$(git rev-parse HEAD) && changes=$(git status --porcelain) || return 1
  [[ $head == "$TARGET" && -z $changes ]]
}

# Rewrite only release metadata, preserving all other current environment keys.
write_release_keys() {
  local temporary
  temporary=$(mktemp "$DEPLOY/.env.release.XXXXXX") || return 1
  awk 'FILENAME == ARGV[1] { split($0,a,"="); values[a[1]]=$0; next }
    /^[[:space:]]*(export[[:space:]]+)?(GIT_COMMIT|SIRAGPT_VERSION)[[:space:]]*=/ {
      key=$0; sub(/^[[:space:]]*(export[[:space:]]+)?/,"",key); sub(/[[:space:]]*=.*/,"",key);
      if (!seen[key]++ && key in values) print values[key]; next }
    { print } END { if (!seen["GIT_COMMIT"]) print values["GIT_COMMIT"];
      if (!seen["SIRAGPT_VERSION"]) print values["SIRAGPT_VERSION"] }' "$1" "$DEPLOY/.env" > "$temporary" || return 1
  chmod 600 "$temporary" && mv "$temporary" "$DEPLOY/.env"
}
healthy() {
  local service id
  for service in runner backend frontend; do
    id=$("${COMPOSE[@]}" ps -q "$service") || return 1
    [[ -n $id && $id != *$'\n'* ]] || return 1
    [[ $(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$id") == 'running healthy' ]] || return 1
  done
}
http_release() {
  local backend
  backend=$("${COMPOSE[@]}" ps -q backend) || return 1
  [[ -n $backend && $backend != *$'\n'* ]] || return 1
  curl --fail --silent --show-error --connect-timeout 5 --max-time 15 -H 'Cache-Control: no-cache' "$ORIGIN/api/version" |
    docker exec -i "$backend" node -e 'let s="";process.stdin.on("data",b=>s+=b).on("end",()=>{try{if(JSON.parse(s).commit!==process.argv[1])process.exit(1)}catch{process.exit(1)}})' "$1" || return 1
  curl --fail --silent --show-error --connect-timeout 5 --max-time 15 -H 'Cache-Control: no-cache' "$ORIGIN/api/health/ready" |
    docker exec -i "$backend" node -e 'let s="";process.stdin.on("data",b=>s+=b).on("end",()=>{try{const j=JSON.parse(s);if(j.status!=="healthy"||!Array.isArray(j.checks))process.exit(1);for(const n of ["database","redis","migrations"]){const c=j.checks.filter(x=>x.name===n);if(c.length!==1||c[0].status!=="healthy")process.exit(1)}if(j.checks.some(c=>c.critical&&c.status!=="healthy"))process.exit(1)}catch{process.exit(1)}})'
}
wait_release() {
  local attempt
  for ((attempt=0; attempt<24; attempt++)); do
    if healthy && http_release "$1"; then return 0; fi
    sleep 5
  done
  return 1
}
finish() {
  local status=$? rollback_ok=1
  trap - EXIT INT TERM HUP
  set +e
  if [[ $status != 0 ]]; then
    if [[ $ENV_CHANGED == 1 ]]; then write_release_keys "$BACKUP/release.keys" || rollback_ok=0; fi
    if [[ $ACTIVATED == 1 ]]; then
      # Shell exports override .env in Compose, so remove ONLY our two exports.
      unset GIT_COMMIT SIRAGPT_VERSION
      "${COMPOSE[@]}" -f "$BACKUP/rollback.yaml" up -d --no-deps --no-build --pull never runner backend frontend || rollback_ok=0
      wait_release "$PREVIOUS" || rollback_ok=0
      if [[ $rollback_ok == 1 ]]; then printf '[publish] Failed; previous release restored and verified.\n' >&3;
      else printf '[publish] CRITICAL: rollback verification failed; manual recovery required.\n' >&3; status=2; fi
    elif [[ $rollback_ok != 1 ]]; then printf '[publish] CRITICAL: release metadata restoration failed.\n' >&3; status=2;
    else printf '[publish] Stopped before activation.\n' >&3; fi
  fi
  rmdir "$LOCK" || status=2
  exit "$status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
[[ ! -L $DEPLOY/backups ]] || die 'Backup directory must not be a symbolic link.'
mkdir -p "$DEPLOY/backups"
BACKUP=$(mktemp -d "$DEPLOY/backups/reviewed-${TARGET:0:12}-XXXXXX")
LOG="$BACKUP/publish.log"
touch "$LOG"; chmod 600 "$LOG"
# Command output may contain credentials: never replay it to the terminal.
exec >> "$LOG" 2>&1
printf '[publish] Private evidence: %s\n' "$BACKUP" >&3
for file in .env compose.yaml Caddyfile; do
  [[ -f $DEPLOY/$file && ! -L $DEPLOY/$file ]] || die 'Deployment configuration is missing or unsafe.'
done
cd "$REPO"
git fetch --no-tags origin production-main
checkout_clean || die 'Checkout must be clean and already at the approved target.'
git merge-base --is-ancestor "$TARGET" refs/remotes/origin/production-main || die 'Target is not in production-main.'
git merge-base --is-ancestor "$PREVIOUS" "$TARGET" || die 'Expected live release is not an ancestor of the target.'
schema_changes=$(git diff --name-only "$PREVIOUS" "$TARGET" -- ':(glob)**/migrations/**' ':(glob)**/schema.prisma' ':(glob)**/schema.sql' ':(glob)**/drizzle/**')
[[ -z $schema_changes ]] || die 'Schema or migration changes require a separate reviewed release.'
"${COMPOSE[@]}" config -q
healthy && http_release "$PREVIOUS" || die 'Live release or container health differs from the approved baseline.'
for file in .env compose.yaml Caddyfile; do cp "$DEPLOY/$file" "$BACKUP/$file"; chmod 600 "$BACKUP/$file"; done
grep -E '^(GIT_COMMIT|SIRAGPT_VERSION)=' "$DEPLOY/.env" > "$BACKUP/release.keys" || true
awk -F= '$1=="GIT_COMMIT"{g++} $1=="SIRAGPT_VERSION"{v++} END{exit !(g==1 && v==1)}' "$BACKUP/release.keys" || die 'Both unique existing release metadata keys are required.'
"${COMPOSE[@]}" exec -T db sh -c 'exec pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"' | gzip -c > "$BACKUP/database.dump.gz"
gzip -t "$BACKUP/database.dump.gz"
gzip -dc "$BACKUP/database.dump.gz" | "${COMPOSE[@]}" exec -T db pg_restore --list > "$BACKUP/database-contents.txt"
printf 'services:\n' > "$BACKUP/rollback.yaml"
for service in runner backend frontend; do
  id=$("${COMPOSE[@]}" ps -q "$service")
  image=$(docker inspect --format '{{.Image}}' "$id")
  [[ $image =~ ^sha256:[0-9a-f]{64}$ ]] || die 'Running image identity cannot be verified.'
  tag="iliagpt-$service:rollback-${BACKUP##*/}"
  docker image tag "$image" "$tag"
  printf '%s %s\n' "$service" "$image" >> "$BACKUP/rollback.images"
  printf '  %s:\n    image: %s\n    pull_policy: never\n' "$service" "$tag" >> "$BACKUP/rollback.yaml"
done
export GIT_COMMIT="$TARGET" SIRAGPT_VERSION="reviewed-${TARGET:0:12}-${BACKUP##*-}"
printf 'GIT_COMMIT=%s\nSIRAGPT_VERSION=%s\n' "$GIT_COMMIT" "$SIRAGPT_VERSION" > "$BACKUP/target.keys"
printf '[publish] Building runner, backend and frontend.\n' >&3
"${COMPOSE[@]}" build runner backend frontend
backend=$("${COMPOSE[@]}" ps -q backend)
candidate=$("${COMPOSE[@]}" config --format json | docker exec -i "$backend" node -e 'let s="";process.stdin.on("data",b=>s+=b).on("end",()=>{try{const i=JSON.parse(s).services.backend.image;if(i!=="iliagpt-backend:"+process.argv[1])process.exit(1);process.stdout.write(i)}catch{process.exit(1)}})' "$SIRAGPT_VERSION")
docker run --rm --network none --entrypoint node "$candidate" scripts/image-size-security-patch.cjs --verify
# Refuse a concurrent publication/config edit after a potentially long build.
checkout_clean || die 'Checkout changed during the build.'
cmp -s "$DEPLOY/compose.yaml" "$BACKUP/compose.yaml" && cmp -s "$DEPLOY/Caddyfile" "$BACKUP/Caddyfile" || die 'Deployment configuration changed during the build.'
healthy && http_release "$PREVIOUS" || die 'Live release changed during the build.'
while read -r service expected_image; do
  id=$("${COMPOSE[@]}" ps -q "$service")
  [[ $(docker inspect --format '{{.Image}}' "$id") == "$expected_image" ]] || die 'Running image changed during the build.'
done < "$BACKUP/rollback.images"
grep -E '^(GIT_COMMIT|SIRAGPT_VERSION)=' "$DEPLOY/.env" > "$BACKUP/preactivation.keys" || true
cmp -s "$BACKUP/release.keys" "$BACKUP/preactivation.keys" || die 'Release metadata changed during the build.'
ENV_CHANGED=1
write_release_keys "$BACKUP/target.keys"
ACTIVATED=1
"${COMPOSE[@]}" up -d --no-deps --no-build --pull never runner backend frontend
wait_release "$TARGET" || die 'Target health or public release verification failed.'
[[ ! -L $DEPLOY/releases.log && ( ! -e $DEPLOY/releases.log || -f $DEPLOY/releases.log ) ]] || die 'Release journal path is unsafe.'
printf '%s target=%s previous=%s version=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$TARGET" "$PREVIOUS" "$SIRAGPT_VERSION" >> "$DEPLOY/releases.log"
chmod 600 "$DEPLOY/releases.log"
printf '[publish] Target release healthy and verified.\n' >&3
