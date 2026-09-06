#!/usr/bin/env bash
# Run only browser admission/Stop tests. No production configuration or provider access.
set -euo pipefail
source_dir=${1:?Absolute candidate directory required}
database=${2:?Existing fully migrated doc_sandbox_history database required}
evidence=${3:?New absolute /tmp/doc-sandbox-browser-* evidence directory required}
postgres_service=${4:-doc-sandbox-history-postgres}
case "$source_dir" in /home/user/deployments/doc-sandbox-phase1-tests/candidate-[a-zA-Z0-9-]*) ;; *) exit 1 ;; esac
case "$database" in doc_sandbox_history_[a-z0-9_]*) ;; *) exit 1 ;; esac
case "$evidence" in /tmp/doc-sandbox-browser-[a-zA-Z0-9-]*) ;; *) exit 1 ;; esac
case "$postgres_service" in doc-sandbox-test-postgres|doc-sandbox-history-postgres) ;; *) exit 1 ;; esac
test "$(realpath "$source_dir")" = "$source_dir"
test "$(docker network inspect doc-sandbox-phase1-test --format '{{.Internal}}')" = true
for target in "$postgres_service" doc-sandbox-test-redis; do
  test "$(docker inspect "$target" --format '{{index .Config.Labels "siragpt.scope"}}')" = doc-sandbox-phase1-test
  state=$(docker inspect "$target" --format '{{.State.Status}}')
  test "$state" = exited || test "$state" = running
  test "$(docker inspect "$target" --format '{{len .HostConfig.PortBindings}}')" = 0
done
for target in doc-sandbox-browser-backend doc-sandbox-browser-frontend; do
  if docker inspect "$target" >/dev/null 2>&1; then echo "Existing browser container requires reconciliation: $target" >&2; exit 1; fi
done
if ss -lntH | awk '{print $4}' | grep -Eq ':(15161|15162)$'; then echo 'Browser test ports are already in use' >&2; exit 1; fi
node "$source_dir/infra/doc-validation/browser-test-fixture.cjs" configure "$source_dir" "$evidence" "$database" "$postgres_service"
mkdir -p "$source_dir/backend/data" "$source_dir/backend/uploads" "$source_dir/.next"
umask 077
started=()
applications=()
proxies=()
cleanup() {
  for proxy in "${proxies[@]}"; do kill "$proxy" 2>/dev/null || true; done
  for application in "${applications[@]}"; do
    docker logs "$application" > "$evidence/$application.log" 2>&1 || true
    docker stop --time 15 "$application" >/dev/null 2>&1 || true
    docker rm "$application" >/dev/null 2>&1 || true
  done
  if ((${#started[@]})); then docker stop --time 10 "${started[@]}" >/dev/null; fi
}
trap cleanup EXIT
for target in "$postgres_service" doc-sandbox-test-redis; do
  if test "$(docker inspect "$target" --format '{{.State.Running}}')" != true; then docker start "$target" >/dev/null; started+=("$target"); fi
done
for attempt in {1..30}; do
  if docker exec "$postgres_service" pg_isready -U doc_fixture -d "$database" >/dev/null; then break; fi
  sleep 1
done
image=sha256:40f438311ab39713e617fc96b6dcbf5bdc62bf5141ddca954f739386da64176e
common=(--network doc-sandbox-phase1-test --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges --read-only
  --label siragpt.scope=doc-sandbox-phase1-test --mount "type=bind,src=$source_dir,dst=/app,readonly" --entrypoint node)
docker run --rm "${common[@]}" --cpus 1 --memory 1g --pids-limit 256 --tmpfs /tmp:rw,nosuid,size=256m,uid=1000,gid=1000 \
  --env-file "$evidence/backend.env" --workdir /app/backend "$image" /app/infra/doc-validation/browser-test-fixture.cjs seed
docker run -d --name doc-sandbox-browser-backend "${common[@]}" --cpus 1 --memory 2g --pids-limit 512 \
  --tmpfs /tmp:rw,nosuid,size=512m,uid=1000,gid=1000 --env-file "$evidence/backend.env" \
  --tmpfs /app/backend/data:rw,nosuid,size=128m,uid=1000,gid=1000 --tmpfs /app/backend/uploads:rw,nosuid,size=128m,uid=1000,gid=1000 \
  -p 127.0.0.1:15161:15161 --workdir /app/backend "$image" index.js >/dev/null
applications+=(doc-sandbox-browser-backend)
node "$source_dir/infra/doc-validation/browser-test-fixture.cjs" proxy backend > "$evidence/backend-proxy.log" 2>&1 &
proxies+=("$!")
backend_ready=0
for attempt in {1..90}; do
  if curl --silent --fail --max-time 2 http://127.0.0.1:15161/health >/dev/null; then backend_ready=1; break; fi
  if test "$(docker inspect doc-sandbox-browser-backend --format '{{.State.Running}}')" != true; then break; fi
  sleep 1
done
test "$backend_ready" = 1
docker run -d --name doc-sandbox-browser-frontend "${common[@]}" --cpus 2 --memory 6g --pids-limit 768 \
  --tmpfs /tmp:rw,nosuid,size=512m,uid=1000,gid=1000 --tmpfs /app/.next:rw,nosuid,size=3g,uid=1000,gid=1000 \
  -e NODE_ENV=development -e NEXT_TELEMETRY_DISABLED=1 -e NODE_OPTIONS=--max-old-space-size=4096 \
  -e NEXT_PUBLIC_API_URL=http://127.0.0.1:15161/api -e BACKEND_INTERNAL_URL=http://doc-sandbox-browser-backend:15161 \
  -p 127.0.0.1:15162:15162 --workdir /app "$image" node_modules/next/dist/bin/next dev --hostname 0.0.0.0 --port 15162 >/dev/null
applications+=(doc-sandbox-browser-frontend)
node "$source_dir/infra/doc-validation/browser-test-fixture.cjs" proxy frontend > "$evidence/frontend-proxy.log" 2>&1 &
proxies+=("$!")
frontend_ready=0
for attempt in {1..60}; do
  if curl --silent --fail --max-time 5 http://127.0.0.1:15162/auth/login >/dev/null; then frontend_ready=1; break; fi
  if test "$(docker inspect doc-sandbox-browser-frontend --format '{{.State.Running}}')" != true; then break; fi
  sleep 1
done
test "$frontend_ready" = 1
curl --silent --fail --max-time 180 http://127.0.0.1:15162/agentes >/dev/null
node "$source_dir/infra/doc-validation/browser-test-fixture.cjs" run "$source_dir" "$evidence"
