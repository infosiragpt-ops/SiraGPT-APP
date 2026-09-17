# GitHub Actions self-hosted runner for the Lenovo production box.
#
# One long-lived container (siragpt-github-runner) polls GitHub — outbound
# HTTPS only, no inbound ports, no Cloudflare changes — and executes the
# `Publish production (Lenovo)` workflow, which runs the reviewed
# /home/user/deployments/iliagpt/publish.sh exactly like a human operator.
#
# The container sees the SAME host paths the script hard-codes
# (/home/user/SiraGPT-APP, /home/user/deployments/iliagpt) and the host
# Docker socket, so Compose resolves bind mounts and build contexts
# identically to a publish run from the deploy bastion.
#
# Build/install from the bastion with ./install.sh (see README.md).
ARG RUNNER_VERSION=2.337.0
FROM ghcr.io/actions/actions-runner:${RUNNER_VERSION}

ARG COMPOSE_VERSION=v5.4.0
# Host identity of the repo/deployment files and of the docker socket group.
ARG HOST_UID=1000
ARG HOST_GID=1000
ARG DOCKER_SOCK_GID=137

USER root

RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl ca-certificates jq gzip \
 && rm -rf /var/lib/apt/lists/*

# The base image ships the docker CLI but not the compose plugin; publish.sh
# needs `docker compose` (v2 syntax). Pin the same major as the host.
RUN mkdir -p /usr/local/lib/docker/cli-plugins \
 && curl -fsSL "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-x86_64" \
      -o /usr/local/lib/docker/cli-plugins/docker-compose \
 && chmod 755 /usr/local/lib/docker/cli-plugins/docker-compose \
 && docker compose version

# Run as the host's uid/gid so every file the publish creates (git refs,
# backups, release journal) stays owned by the Lenovo user, and join the
# docker socket group. The base image reserves uid 1000 for "ubuntu".
RUN if getent passwd ubuntu >/dev/null; then userdel -r ubuntu; fi \
 && if getent group ubuntu >/dev/null; then groupdel ubuntu; fi \
 && groupmod -g "${HOST_GID}" runner \
 && usermod -u "${HOST_UID}" -g "${HOST_GID}" runner \
 && groupmod -g "${DOCKER_SOCK_GID}" docker \
 && usermod -aG docker runner \
 && chown -R runner:runner /home/runner

COPY entrypoint.sh /usr/local/bin/siragpt-runner-entrypoint
RUN chmod 755 /usr/local/bin/siragpt-runner-entrypoint

USER runner
WORKDIR /home/runner
ENTRYPOINT ["/usr/local/bin/siragpt-runner-entrypoint"]
CMD ["run"]
