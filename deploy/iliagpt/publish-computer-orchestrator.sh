#!/usr/bin/env bash
# Versioned companion to the reviewed app publisher. Invoke only after its
# exact-tree CI gate and successful app publication, with the approved SHA.
set -Eeuo pipefail
umask 077
export LC_ALL=C
REPO=/home/user/SiraGPT-APP
DEPLOY=/home/user/deployments/iliagpt
LOCK=/tmp/siragpt-publish.lock
ORIGIN=https://siragpt.com
IMAGE=siragpt-computer-orchestrator:latest
LABEL=org.siragpt.computer.source-tree
exec 3>&1
die() { printf '[computer-publish] %s\n' "$1" >&3; exit 1; }
[[ $# == 1 && $1 =~ ^[0-9a-f]{40}$ ]] || die 'One full lowercase approved commit SHA is required.'
TARGET=$1
[[ -d $REPO && -d $DEPLOY && ! -L $REPO && ! -L $DEPLOY ]] || die 'Unexpected Lenovo paths.'
mkdir "$LOCK" 2>/dev/null || die 'Another publication owns the lock; do not remove it automatically.'
TAGGED=0; ACTIVATED=0; PREVIOUS=''; EVIDENCE=''
COMPOSE=(docker compose -p iliagpt -f "$DEPLOY/compose.yaml" --env-file "$DEPLOY/.env")
container_id() {
  local id
  id=$("${COMPOSE[@]}" ps -q computer-orchestrator) || return 1
  [[ $id =~ ^[0-9a-f]{12,64}$ ]] || return 1
  printf '%s' "$id"
}
healthy() {
  local id
  id=$(container_id) || return 1
  [[ $(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$id") == 'running healthy' ]]
}
wait_image() {
  local expected=$1 id attempt
  for ((attempt=0; attempt<24; attempt++)); do
    id=$(container_id) || return 1
    if healthy && [[ $(docker inspect --format '{{.Image}}' "$id") == "$expected" ]]; then return 0; fi
    sleep 5
  done
  return 1
}
app_baseline() {
  local head changes
  head=$(git rev-parse HEAD) && changes=$(git status --porcelain) || return 1
  [[ $head == "$TARGET" && -z $changes ]] || return 1
  curl -fsS --connect-timeout 5 --max-time 15 -H 'Cache-Control: no-cache' "$ORIGIN/api/version" |
    jq -e --arg target "$TARGET" '.commit == $target' >/dev/null || return 1
  curl -fsS --connect-timeout 5 --max-time 15 -H 'Cache-Control: no-cache' "$ORIGIN/api/health/ready" |
    jq -e '.status == "healthy" and (.checks | type == "array") and
      ([.checks[] | select(.name == "database" or .name == "redis" or .name == "migrations")] |
       length == 3 and (map(.name) | unique | length == 3) and all(.status == "healthy")) and
      all(.checks[]; (.critical != true or .status == "healthy"))' >/dev/null
}
finish() {
  local status=$? rollback_ok=1
  trap - EXIT INT TERM HUP
  set +e
  if [[ $status != 0 ]]; then
    if [[ $TAGGED == 1 ]]; then
      docker image tag "$PREVIOUS" "$IMAGE" || rollback_ok=0
      if [[ $ACTIVATED == 1 && $rollback_ok == 1 ]]; then
        # The private override pins the immutable prior image, regardless of
        # tag movement. It changes only this existing control-plane service.
        "${COMPOSE[@]}" -f "$EVIDENCE/rollback.yaml" up -d --no-deps --no-build --pull never computer-orchestrator &&
          wait_image "$PREVIOUS" || rollback_ok=0
      fi
      if [[ $rollback_ok == 1 ]]; then printf '[computer-publish] Failed; previous orchestrator image restored and verified.\n' >&3;
      else printf '[computer-publish] CRITICAL: orchestrator rollback verification failed; manual recovery required.\n' >&3; status=2; fi
    else printf '[computer-publish] Stopped before activation.\n' >&3; fi
  fi
  rmdir "$LOCK" || status=2
  exit "$status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
[[ ! -L $DEPLOY/backups ]] || die 'Evidence directory must not be a symbolic link.'
mkdir -p "$DEPLOY/backups"
EVIDENCE=$(mktemp -d "$DEPLOY/backups/computer-${TARGET:0:12}-XXXXXX")
# Never replay tool output: Compose/build/runtime failures may contain secrets.
exec >> "$EVIDENCE/publish.log" 2>&1
printf '[computer-publish] Private evidence: %s\n' "$EVIDENCE" >&3
for file in .env compose.yaml; do
  [[ -f $DEPLOY/$file && ! -L $DEPLOY/$file ]] || die 'Existing deployment configuration is missing or unsafe.'
done
cd "$REPO"
git fetch --no-tags origin production-main
git merge-base --is-ancestor "$TARGET" refs/remotes/origin/production-main || die 'Target is not in production-main.'
app_baseline || die 'Checkout, live release or readiness differs from the approved target.'
# Read configuration only through Compose; do not create a missing service or
# modify configuration, credentials, profiles, networks or desktop containers.
"${COMPOSE[@]}" config --format json | jq -e --arg image "$IMAGE" '.services["computer-orchestrator"].image == $image' >/dev/null ||
  die 'The existing orchestrator service must use the reviewed image tag.'
ID=$(container_id) || die 'Exactly one existing orchestrator container is required.'
healthy || die 'Existing orchestrator is not healthy.'
PREVIOUS=$(docker inspect --format '{{.Image}}' "$ID")
[[ $PREVIOUS =~ ^sha256:[0-9a-f]{64}$ ]] || die 'The immutable previous image is unavailable.'
[[ $(docker image inspect --format '{{.Id}}' "$IMAGE") == "$PREVIOUS" ]] || die 'The image tag differs from the running baseline.'
[[ $(docker inspect --format '{{.Config.Image}}' "$ID") == "$IMAGE" || $(docker inspect --format '{{.Config.Image}}' "$ID") == "$PREVIOUS" ]] ||
  die 'Unexpected running orchestrator image reference.'
printf '%s\n' "$PREVIOUS" > "$EVIDENCE/previous-image"
printf 'services:\n  computer-orchestrator:\n    image: %s\n' "$PREVIOUS" > "$EVIDENCE/rollback.yaml"
cksum "$DEPLOY/compose.yaml" "$DEPLOY/.env" > "$EVIDENCE/config.checksums"
TREE=$(git rev-parse "$TARGET:services/computer-orchestrator")
[[ $TREE =~ ^[0-9a-f]{40}$ ]] || die 'Approved orchestrator source tree is unavailable.'
# Git blob IDs verify the bytes actually installed, independently of image
# labels. Include every top-level JS module, the desktop entrypoint and assets.
git ls-tree -r "$TARGET:services/computer-orchestrator" > "$EVIDENCE/source-tree"
while read -r mode type blob source; do
  [[ $type == blob && $mode != 120000 ]] || die 'Unexpected non-regular source entry.'
  installed=''
  case "$source" in
    */*) if [[ $source == desktop-look/* ]]; then installed="/opt/sira-orch/$source"; fi ;;
    *.js) installed="/opt/sira-orch/$source" ;;
    start-desktop.sh) installed=/usr/local/bin/start-desktop.sh ;;
  esac
  if [[ -n $installed ]]; then printf '%s\t%s\n' "$blob" "$installed"; fi
done < "$EVIDENCE/source-tree" > "$EVIDENCE/manifest"
[[ -s $EVIDENCE/manifest ]] && grep -q $'\t/opt/sira-orch/server.js$' "$EVIDENCE/manifest" || die 'Source manifest is incomplete.'
VERIFY=$(cat <<'JS'
const fs=require('node:fs'),crypto=require('node:crypto');
try {
  const rows=fs.readFileSync(0,'utf8').trim().split('\n');
  if(!rows.length)process.exit(1);
  for(const row of rows){
    const [expected,file]=row.split('\t');
    if(!/^[a-f0-9]{40}$/.test(expected)||!fs.lstatSync(file).isFile())process.exit(1);
    const bytes=fs.readFileSync(file);
    const actual=crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if(actual!==expected)process.exit(1);
  }
} catch { process.exit(1); }
JS
)
verify_running() { docker exec -i "$1" node -e "$VERIFY" < "$EVIDENCE/manifest"; }
LABEL_VALUE=$(docker image inspect --format "{{index .Config.Labels \"$LABEL\"}}" "$PREVIOUS")
if [[ $LABEL_VALUE == "$TREE" ]] && verify_running "$ID"; then
  app_baseline && healthy || die 'Release changed during verification.'
  [[ $(container_id) == "$ID" && $(docker inspect --format '{{.Image}}' "$ID") == "$PREVIOUS" && $(docker image inspect --format '{{.Id}}' "$IMAGE") == "$PREVIOUS" ]] || die 'Running image or tag changed during verification.'
  printf '[computer-publish] Running orchestrator source and health verified; no update required.\n' >&3
  exit 0
fi
CANDIDATE="siragpt-computer-orchestrator:candidate-${TARGET:0:12}"
# Only tracked bytes from TARGET enter the build, never a dirty/ignored context.
git archive --format=tar "$TARGET:services/computer-orchestrator" > "$EVIDENCE/source.tar"
printf '[computer-publish] Building the approved orchestrator source.\n' >&3
docker build --quiet --label "$LABEL=$TREE" -t "$CANDIDATE" - < "$EVIDENCE/source.tar"
CANDIDATE_ID=$(docker image inspect --format '{{.Id}}' "$CANDIDATE")
[[ $CANDIDATE_ID =~ ^sha256:[0-9a-f]{64}$ ]] || die 'Candidate image identity is invalid.'
[[ $(docker image inspect --format "{{index .Config.Labels \"$LABEL\"}}" "$CANDIDATE_ID") == "$TREE" ]] || die 'Candidate source label does not match.'
docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --entrypoint node -i "$CANDIDATE_ID" -e "$VERIFY" < "$EVIDENCE/manifest"
# Load the actual server and exercise only loopback /health. Fake driver has no
# Docker socket, credentials, user profiles, network egress or session creation.
docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --entrypoint node "$CANDIDATE_ID" -e '
const {createOrchestrator}=require("/opt/sira-orch/server.js");
const {server}=createOrchestrator({driver:"fake",env:{}});
const timer=setTimeout(()=>process.exit(1),10000);
server.listen(0,"127.0.0.1",async()=>{
  let ok=false;
  try { const r=await fetch(`http://127.0.0.1:${server.address().port}/health`); const j=await r.json(); ok=r.ok&&j.ok===true&&j.driver==="fake"&&j.sessions===0; } catch {}
  server.closeAllConnections();server.close(()=>{clearTimeout(timer);process.exit(ok?0:1)});
});'
# Recheck under the same publication lock after the potentially long build.
app_baseline && healthy || die 'Release or health changed during the build.'
[[ $(container_id) == "$ID" && $(docker inspect --format '{{.Image}}' "$ID") == "$PREVIOUS" ]] || die 'Running orchestrator changed during the build.'
cksum "$DEPLOY/compose.yaml" "$DEPLOY/.env" > "$EVIDENCE/preactivation.checksums"
cmp -s "$EVIDENCE/config.checksums" "$EVIDENCE/preactivation.checksums" || die 'Deployment configuration changed during the build.'
[[ $(docker image inspect --format '{{.Id}}' "$IMAGE") == "$PREVIOUS" ]] || die 'The image tag changed during the build.'
# Pin activation as well: another tag writer cannot select a different image.
printf 'services:\n  computer-orchestrator:\n    image: %s\n' "$CANDIDATE_ID" > "$EVIDENCE/activate.yaml"
TAGGED=1
docker image tag "$CANDIDATE_ID" "$IMAGE"
ACTIVATED=1
"${COMPOSE[@]}" -f "$EVIDENCE/activate.yaml" up -d --no-deps --no-build --pull never computer-orchestrator
wait_image "$CANDIDATE_ID" || die 'Candidate orchestrator did not become healthy.'
verify_running "$(container_id)" && app_baseline || die 'Live source or release verification failed.'
printf '[computer-publish] Orchestrator source and health verified for %s.\n' "$TARGET" >&3
