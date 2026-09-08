#!/usr/bin/env bash
# Real PostgreSQL/S3 failure-path test with previously generated Python evidence.
# No provider, production environment, host administration or validator substitute.
set -euo pipefail
source_dir=${1:?Absolute isolated candidate required}
evidence_path=${2:?Absolute synthetic evidence bundle required}
evidence_sha=${3:?Externally recorded SHA-256 required}
case "$source_dir" in
  /home/user/deployments/doc-sandbox-phase1-tests/candidate-[a-zA-Z0-9-]*) ;;
  *) echo 'Refusing unscoped test source directory' >&2; exit 1 ;;
esac
test "$(realpath "$source_dir")" = "$source_dir"
case "$evidence_path" in
  "$source_dir"/output/*.json) ;;
  *) echo 'Refusing evidence outside the private candidate output' >&2; exit 1 ;;
esac
test "$(realpath "$evidence_path")" = "$evidence_path"
test "$(stat -c %a "$source_dir/output")" = 700
test "$(stat -c %u "$source_dir/output")" = "$(id -u)"
test -f "$evidence_path"
test "$(stat -c %a "$evidence_path")" = 600
test "$(stat -c %u "$evidence_path")" = "$(id -u)"
test "$(stat -c %s "$evidence_path")" -le 1048576
[[ "$evidence_sha" =~ ^[a-f0-9]{64}$ ]]
test "$(sha256sum "$evidence_path" | cut -d ' ' -f 1)" = "$evidence_sha"
test -f "$source_dir/package.json"
test -f "$source_dir/backend/node_modules/tsx/dist/loader.mjs"
test -f "$source_dir/backend/tests/doc-sandbox-failure-retention.integration.test.ts"

targets=(doc-sandbox-test-postgres doc-sandbox-test-redis doc-sandbox-test-minio)
service_ids=()
for target in "${targets[@]}"; do
  target_id=$(docker inspect "$target" --format '{{.Id}}')
  test "$(docker inspect "$target_id" --format '{{index .Config.Labels "siragpt.scope"}}')" = doc-sandbox-phase1-test
  test "$(docker inspect "$target_id" --format '{{.State.Status}}')" = exited
  test "$(docker inspect "$target_id" --format '{{len .HostConfig.PortBindings}}')" = 0
  service_ids+=("$target_id")
done
test "$(docker network inspect doc-sandbox-phase1-test --format '{{.Internal}}')" = true
command -v timeout >/dev/null
runner_state=$(mktemp -d "$source_dir/output/runner-state-XXXXXX")
started=()
cleanup() {
  original_status=$?
  cleanup_failed=0
  if test -s "$runner_state/id"; then
    runner_id=$(<"$runner_state/id")
    if [[ "$runner_id" =~ ^[a-f0-9]{64}$ ]] && test "$(docker inspect "$runner_id" --format '{{index .Config.Labels "siragpt.scope"}}' 2>/dev/null)" = doc-sandbox-phase1-test; then
      if ! docker stop --time 10 "$runner_id" >/dev/null; then cleanup_failed=1; fi
    fi
  fi
  for started_id in "${started[@]}"; do
    if ! docker stop --time 10 "$started_id" >/dev/null; then cleanup_failed=1; fi
  done
  if ((original_status == 0 && cleanup_failed != 0)); then exit 1; fi
  exit "$original_status"
}
trap cleanup EXIT
for target in "${service_ids[@]}"; do
  docker start "$target" >/dev/null
  started+=("$target")
done
timeout -s TERM -k 15 180 docker run --rm --name doc-sandbox-test-failure-runner \
  --cidfile "$runner_state/id" --label siragpt.scope=doc-sandbox-phase1-test \
  --network doc-sandbox-phase1-test --user 1000:1000 --cpus 1 --memory 1g --pids-limit 256 --read-only \
  --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp:rw,noexec,nosuid,size=128m \
  --mount "type=bind,src=$source_dir,dst=$source_dir,readonly" \
  --workdir "$source_dir" --entrypoint node \
  -e DOC_SANDBOX_TEST_DATABASE_URL=postgresql://doc_fixture:fixture-only-isolated@doc-sandbox-test-postgres:5432/doc_sandbox_fixture \
  -e DOC_SANDBOX_TEST_REDIS_URL=redis://doc-sandbox-test-redis:6379/0 \
  -e DOC_SANDBOX_TEST_S3_ENDPOINT=http://doc-sandbox-test-minio:9000 \
  -e DOC_SANDBOX_TEST_S3_ACCESS_KEY_ID=docfixture -e DOC_SANDBOX_TEST_S3_SECRET_ACCESS_KEY=fixture-only-isolated-s3 \
  -e "DOC_SANDBOX_TEST_FAILURE_BUNDLE_PATH=$evidence_path" \
  -e "DOC_SANDBOX_TEST_FAILURE_BUNDLE_SHA256=$evidence_sha" \
  sha256:40f438311ab39713e617fc96b6dcbf5bdc62bf5141ddca954f739386da64176e \
  --import "$source_dir/backend/node_modules/tsx/dist/loader.mjs" --test --test-concurrency=1 \
  backend/tests/doc-sandbox-failure-retention.integration.test.ts
