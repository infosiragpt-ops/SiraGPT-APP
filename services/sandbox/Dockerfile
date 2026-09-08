# SiraGPT document-task sandbox microservice — container image.
#
# The service is a zero-dependency Node HTTP API that drives ephemeral runner
# containers (siragpt-doc-sandbox) through the host's Docker socket. Run it as
# a compose service on the same host as the app, on the internal network only,
# with `/var/run/docker.sock` mounted and SANDBOX_API_KEY set. It binds
# 0.0.0.0 INSIDE the container (never publish the port to the host).
FROM node:22-alpine

RUN apk add --no-cache docker-cli tini

WORKDIR /srv/sandbox
COPY package.json server.js ./
COPY lib ./lib
COPY scripts ./scripts

ENV NODE_ENV=production \
    SANDBOX_BIND=0.0.0.0 \
    SANDBOX_PORT=4000

EXPOSE 4000

HEALTHCHECK --interval=20s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["tini", "--"]
CMD ["node", "server.js"]
