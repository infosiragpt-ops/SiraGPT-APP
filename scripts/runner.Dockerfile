FROM oven/bun:1
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git nodejs tini util-linux \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /workspace/projects /runner-cache /runner-home /runner-tmp \
  && chmod 0711 /workspace/projects /runner-cache /runner-home /runner-tmp

ENV RUNNER_CACHE_ROOT=/runner-cache \
    RUNNER_HOME_ROOT=/runner-home \
    RUNNER_TMP_ROOT=/runner-tmp

# Unlike the bind-mounted control script, this helper is baked into the image,
# root-owned and non-writable. Generated code only reaches it after setpriv has
# dropped to that project's uid.
COPY --chown=0:0 code-runner-fs-helper.js /opt/code-runner/code-runner-fs-helper.js
RUN chmod 0555 /opt/code-runner/code-runner-fs-helper.js

# Tini reaps any orphaned grandchildren left by package-manager/dev-server
# trees. The runner itself still creates and terminates a process group per
# project with setsid.
ENTRYPOINT ["/usr/bin/tini", "--"]
