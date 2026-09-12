#!/usr/bin/env bash
# Build, register and start the GitHub Actions self-hosted runner on the
# Lenovo. Run it FROM THE DEPLOY BASTION (ssh siragpt-lenovo), inside a copy
# of this directory, e.g. /home/user/deployments/siragpt-publisher/runner.
#
#   First install:  RUNNER_TOKEN_FILE=/path/to/token ./install.sh
#   Re-deploy:      ./install.sh            (keeps the existing registration)
#
# RUNNER_TOKEN_FILE holds a short-lived registration token minted with
#   gh api -X POST repos/infosiragpt-ops/SiraGPT-APP/actions/runners/registration-token --jq .token
# It is read once, never echoed, and can be deleted right after.
#
# What it creates on the host (additive; nothing existing is modified):
#   image     siragpt-github-runner:<version>
#   volume    siragpt-github-runner-home   (runner identity + work dir)
#   container siragpt-github-runner        (restart unless-stopped)
set -Eeuo pipefail

DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
RUNNER_VERSION=${RUNNER_VERSION:-2.337.0}
COMPOSE_VERSION=${COMPOSE_VERSION:-v5.4.0}
IMAGE=siragpt-github-runner:${RUNNER_VERSION}
NAME=siragpt-github-runner
VOLUME=siragpt-github-runner-home
REPO_URL=${RUNNER_REPO_URL:-https://github.com/infosiragpt-ops/SiraGPT-APP}
HOST_UID=${HOST_UID:-$(stat -c %u /home/user/SiraGPT-APP)}
HOST_GID=${HOST_GID:-$(stat -c %g /home/user/SiraGPT-APP)}
DOCKER_SOCK_GID=${DOCKER_SOCK_GID:-$(stat -c %g /var/run/docker.sock)}

log() { printf '[runner-install] %s\n' "$*"; }

log "building $IMAGE (uid=$HOST_UID gid=$HOST_GID sock_gid=$DOCKER_SOCK_GID)"
docker build \
  --build-arg "RUNNER_VERSION=$RUNNER_VERSION" \
  --build-arg "COMPOSE_VERSION=$COMPOSE_VERSION" \
  --build-arg "HOST_UID=$HOST_UID" \
  --build-arg "HOST_GID=$HOST_GID" \
  --build-arg "DOCKER_SOCK_GID=$DOCKER_SOCK_GID" \
  -t "$IMAGE" "$DIR"

docker volume create "$VOLUME" >/dev/null

if docker run --rm -v "$VOLUME:/home/runner" --entrypoint test "$IMAGE" -f /home/runner/.runner; then
  log "runner already registered (identity on volume $VOLUME)"
else
  [[ -n ${RUNNER_TOKEN_FILE:-} && -f $RUNNER_TOKEN_FILE ]] \
    || { log "first registration needs RUNNER_TOKEN_FILE=<file with a registration token>"; exit 1; }
  env_file=$(mktemp)
  chmod 600 "$env_file"
  printf 'RUNNER_REPO_URL=%s\nRUNNER_NAME=%s\nRUNNER_LABELS=%s\nRUNNER_TOKEN=%s\n' \
    "$REPO_URL" "${RUNNER_NAME:-siragpt-lenovo}" "${RUNNER_LABELS:-siragpt-lenovo}" "$(tr -d '[:space:]' < "$RUNNER_TOKEN_FILE")" > "$env_file"
  log "registering runner ${RUNNER_NAME:-siragpt-lenovo} with $REPO_URL"
  docker run --rm -v "$VOLUME:/home/runner" --env-file "$env_file" "$IMAGE" register
  rm -f "$env_file"
fi

if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
  log "replacing existing container $NAME"
  docker rm -f "$NAME" >/dev/null
fi

log "starting $NAME"
docker run -d --name "$NAME" --restart unless-stopped \
  --memory 3g --cpus 4 \
  --label siragpt.role=github-runner \
  -v "$VOLUME:/home/runner" \
  -v /home/user:/home/user \
  -v /var/run/docker.sock:/var/run/docker.sock \
  "$IMAGE" run >/dev/null

sleep 5
docker logs --tail 5 "$NAME" 2>&1 | sed 's/^/[runner] /'
log "done — check Settings → Actions → Runners in GitHub for '${RUNNER_NAME:-siragpt-lenovo}' (Idle)"
