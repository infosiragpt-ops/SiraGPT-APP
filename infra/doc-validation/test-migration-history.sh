#!/usr/bin/env bash
# Already-running isolated test PostgreSQL only; never starts/stops services.
set -euo pipefail
source_dir=${1:?Absolute candidate directory required}
base_ref=${2:-origin/production-main}
case "$source_dir" in
  /home/user/deployments/doc-sandbox-phase1-tests/candidate-[a-zA-Z0-9-]*) ;;
  *) echo 'Refusing unscoped test source directory' >&2; exit 1 ;;
esac
test "$(realpath "$source_dir")" = "$source_dir"
base_commit=$(git -C "$source_dir" rev-parse --verify "$base_ref^{commit}")
candidate_commit=$(git -C "$source_dir" rev-parse --verify 'HEAD^{commit}')
test "$(docker inspect doc-sandbox-history-postgres --format '{{index .Config.Labels "siragpt.scope"}}')" = doc-sandbox-phase1-test
test "$(docker inspect doc-sandbox-history-postgres --format '{{.State.Status}}')" = running
test "$(docker inspect doc-sandbox-history-postgres --format '{{len .HostConfig.PortBindings}}')" = 0
test "$(docker inspect doc-sandbox-history-postgres --format '{{.Image}}')" = sha256:a36250871de0833b8757561c72f2477ef1ddd1101afa4e617fb552e0de514c6b
test "$(docker network inspect doc-sandbox-phase1-test --format '{{.Internal}}')" = true
evidence_dir=$(mktemp -d /tmp/doc-sandbox-migration-history.XXXXXXXX)
mkdir "$evidence_dir/base"
git -C "$source_dir" archive "$base_commit" backend/prisma | tar -x -C "$evidence_dir/base"
printf 'Migration evidence: %s\n' "$evidence_dir"
docker run --rm --name "doc-sandbox-migration-history-${evidence_dir##*.}" --label siragpt.scope=doc-sandbox-phase1-test \
  --network doc-sandbox-phase1-test --user 1000:1000 --cpus 1 --memory 1g --pids-limit 256 --read-only \
  --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp:rw,noexec,nosuid,size=128m \
  --mount "type=bind,src=$source_dir,dst=/workspace,readonly" \
  --mount "type=bind,src=$evidence_dir,dst=/evidence" \
  --workdir /tmp --entrypoint node -e NODE_ENV=test \
  sha256:40f438311ab39713e617fc96b6dcbf5bdc62bf5141ddca954f739386da64176e \
  /workspace/infra/doc-validation/test-migration-history.cjs "$base_commit" "$candidate_commit"
