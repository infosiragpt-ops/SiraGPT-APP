# Keep both runtimes reproducible. Node 22 is required by the full-stack
# starter's node:sqlite backend; the Debian package previously installed Node
# 20 and made that starter fail only after a preview was launched.
FROM node:22.17.0-bookworm-slim@sha256:b04ce4ae4e95b522112c2e5c52f781471a5cbc3b594527bcddedee9bc48c03a0 AS node-runtime
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4

COPY --from=node-runtime /usr/local/ /usr/local/
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git procps tini util-linux \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /workspace/projects /runner-cache /runner-home /runner-tmp \
  && chmod 0711 /workspace/projects /runner-cache /runner-home /runner-tmp

ENV RUNNER_CACHE_ROOT=/runner-cache \
    RUNNER_HOME_ROOT=/runner-home \
    RUNNER_TMP_ROOT=/runner-tmp

# The upstream Bun image defaults to /home/bun/app. Under runsc that inherited
# directory is not traversable by the root sandbox process, so make the real
# runner workspace the image-level default as well as the Compose default.
WORKDIR /workspace

# Unlike the bind-mounted control script, this helper is baked into the image,
# root-owned and non-writable. Generated code only reaches it after setpriv has
# dropped to that project's uid.
COPY --chown=0:0 code-runner-fs-helper.js /opt/code-runner/code-runner-fs-helper.js
RUN chmod 0555 /opt/code-runner/code-runner-fs-helper.js

# Tini reaps any orphaned grandchildren left by package-manager/dev-server
# trees. The runner itself still creates and terminates a process group per
# project with setsid.
ENTRYPOINT ["/usr/bin/tini", "--"]
