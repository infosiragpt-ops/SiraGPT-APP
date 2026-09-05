#!/usr/bin/env bash
# Lenovo test services only. Does not publish or load any production environment.
set -euo pipefail
source_dir=${1:?Absolute uploaded candidate directory required}
case "$source_dir" in
  /home/user/deployments/doc-sandbox-phase1-tests/candidate-[a-zA-Z0-9-]*) ;;
  *) echo 'Refusing unscoped test source directory' >&2; exit 1 ;;
esac
test "$(realpath "$source_dir")" = "$source_dir"
test -f "$source_dir/package.json"
test -f "$source_dir/backend/package.json"
targets=(doc-sandbox-test-postgres doc-sandbox-test-redis doc-sandbox-test-minio)
for target in "${targets[@]}"; do
  test "$(docker inspect "$target" --format '{{index .Config.Labels "siragpt.scope"}}')" = doc-sandbox-phase1-test
  test "$(docker inspect "$target" --format '{{.State.Status}}')" = exited
  test "$(docker inspect "$target" --format '{{len .HostConfig.PortBindings}}')" = 0
done
test "$(docker network inspect doc-sandbox-phase1-test --format '{{.Internal}}')" = true
started=()
cleanup() {
  # Restore only services this invocation started, never touch application services.
  if ((${#started[@]})); then docker stop --time 10 "${started[@]}" >/dev/null; fi
}
trap cleanup EXIT
for target in "${targets[@]}"; do
  docker start "$target" >/dev/null
  started+=("$target")
done
docker run --rm --name doc-sandbox-test-runner --label siragpt.scope=doc-sandbox-phase1-test \
  --network doc-sandbox-phase1-test --user 1000:1000 --cpus 1 --memory 1g --pids-limit 256 --read-only \
  --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp:rw,noexec,nosuid,size=128m \
  --mount "type=bind,src=$source_dir,dst=/app/doc-sandbox-tests,readonly" \
  --workdir /app/doc-sandbox-tests --entrypoint node \
  -e DOC_SANDBOX_TEST_DATABASE_URL=postgresql://doc_fixture:fixture-only-isolated@doc-sandbox-test-postgres:5432/doc_sandbox_fixture \
  -e DOC_SANDBOX_TEST_REDIS_URL=redis://doc-sandbox-test-redis:6379/0 \
  -e DOC_SANDBOX_TEST_S3_ENDPOINT=http://doc-sandbox-test-minio:9000 \
  -e DOC_SANDBOX_TEST_S3_ACCESS_KEY_ID=docfixture -e DOC_SANDBOX_TEST_S3_SECRET_ACCESS_KEY=fixture-only-isolated-s3 \
  sha256:0efa5d4f999ae8493821248e37cd7745cc439a292fb4c13385905ae5e5d3f5da \
  --import /app/node_modules/tsx/dist/loader.mjs --test --test-concurrency=1 \
  backend/tests/doc-sandbox-api.integration.test.ts backend/tests/doc-sandbox-storage.integration.test.ts \
  backend/tests/doc-sandbox-persistence.integration.test.ts backend/tests/doc-sandbox-persistence.queue.test.ts
