/**
 * logger-redaction — verifies that the structured logger censors
 * known-sensitive fields (auth headers, cookies, tokens, passwords)
 * before they reach stdout, regardless of where they appear in the
 * log payload (request shape, body shape, top-level, one-level nested).
 *
 * Why this matters:
 *   - The logger is the last hop before stdout. If a route handler
 *     accidentally calls `req.log.info({ req })` or `logger.info(user)`,
 *     redaction is the only thing standing between us and an auth
 *     bearer or password landing in Datadog / CloudWatch / Loki.
 *   - This test pins the redact contract so future edits to logger.js
 *     can't silently drop a path or weaken `[REDACTED]` to e.g. removal
 *     (which would change downstream log shape too).
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { Writable } = require("node:stream");
const pino = require("pino");

const { REDACT_PATHS, REDACTION_CENSOR, redactPayloadDeep } = require("../src/middleware/logger");

// Build a pino instance with the same redact config but writing into a
// buffer so we can assert the serialized JSON. We deliberately mirror
// the production config (level, censor, remove) rather than re-importing
// the production logger — pino caches its destination, and the prod
// logger is wired to stdout. Mirroring keeps the test hermetic.
function buildBufferedLogger() {
  const lines = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString("utf8"));
      cb();
    },
  });
  const logger = pino(
    {
      level: "info",
      redact: {
        paths: REDACT_PATHS,
        censor: REDACTION_CENSOR,
        remove: false,
      },
      formatters: {
        log(object) {
          return redactPayloadDeep(object);
        },
      },
    },
    sink,
  );
  return { logger, lines };
}

function lastLine(lines) {
  // pino emits one JSON object per line; trim the trailing newline.
  const raw = lines[lines.length - 1];
  return JSON.parse(raw.trim());
}

describe("logger redaction", () => {
  test("production logger sanitizes DSNs in object messages, Errors, and positional msg", () => {
    const backendRoot = path.resolve(__dirname, "..");
    const child = spawnSync(process.execPath, ["-e", `
      const { logger } = require('./src/middleware/logger');
      const dsn = 'postgresql://project-user:secret@project-db.internal/tenant_123';
      logger.error({ message: \`failed \${dsn}\` });
      logger.error({ err: new Error(\`failed \${dsn}\`) });
      logger.error(\`failed \${dsn}\`);
    `], {
      cwd: backendRoot,
      encoding: "utf8",
      env: { ...process.env, LOG_LEVEL: "error" },
    });

    assert.equal(child.status, 0, child.stderr);
    const records = child.stdout.trim().split("\n").filter(Boolean).map(JSON.parse);
    assert.equal(records.length, 3);
    assert.equal(records[0].message, "failed [REDACTED_DATABASE_URL]");
    assert.equal(records[1].err.message, "failed [REDACTED_DATABASE_URL]");
    assert.equal(records[1].msg, "failed [REDACTED_DATABASE_URL]");
    assert.equal(records[2].msg, "failed [REDACTED_DATABASE_URL]");
    assert.doesNotMatch(
      child.stdout,
      /project-user|secret|project-db\.internal|tenant_123/,
      "the serialized logger output must not contain any DSN component",
    );
  });

  test("censors auth headers on the req shape", () => {
    const { logger, lines } = buildBufferedLogger();
    logger.info({
      req: {
        headers: {
          authorization: "Bearer leaked-jwt",
          cookie: "session=leaked-session",
          "x-api-key": "leaked-api-key",
          "x-auth-token": "leaked-auth-token",
          "x-access-token": "leaked-access-token",
          // Non-sensitive header should pass through verbatim.
          "user-agent": "Mozilla/5.0",
        },
      },
    }, "test");
    const out = lastLine(lines);
    assert.equal(out.req.headers.authorization, "[REDACTED]");
    assert.equal(out.req.headers.cookie, "[REDACTED]");
    assert.equal(out.req.headers["x-api-key"], "[REDACTED]");
    assert.equal(out.req.headers["x-auth-token"], "[REDACTED]");
    assert.equal(out.req.headers["x-access-token"], "[REDACTED]");
    assert.equal(out.req.headers["user-agent"], "Mozilla/5.0");
  });

  test("censors body credentials on the req.body shape", () => {
    const { logger, lines } = buildBufferedLogger();
    logger.info({
      req: {
        body: {
          email: "user@example.com",
          password: "leaked-password",
          token: "leaked-token",
          refreshToken: "leaked-rt-camel",
          refresh_token: "leaked-rt-snake",
          accessToken: "leaked-at-camel",
          access_token: "leaked-at-snake",
          apiKey: "leaked-key-camel",
          api_key: "leaked-key-snake",
          clientSecret: "leaked-cs-camel",
          client_secret: "leaked-cs-snake",
          secret: "leaked-secret",
        },
      },
    }, "auth-attempt");
    const out = lastLine(lines);
    assert.equal(out.req.body.email, "user@example.com"); // not in redact list
    assert.equal(out.req.body.password, "[REDACTED]");
    assert.equal(out.req.body.token, "[REDACTED]");
    assert.equal(out.req.body.refreshToken, "[REDACTED]");
    assert.equal(out.req.body.refresh_token, "[REDACTED]");
    assert.equal(out.req.body.accessToken, "[REDACTED]");
    assert.equal(out.req.body.access_token, "[REDACTED]");
    assert.equal(out.req.body.apiKey, "[REDACTED]");
    assert.equal(out.req.body.api_key, "[REDACTED]");
    assert.equal(out.req.body.clientSecret, "[REDACTED]");
    assert.equal(out.req.body.client_secret, "[REDACTED]");
    assert.equal(out.req.body.secret, "[REDACTED]");
  });

  test("censors set-cookie on the response shape", () => {
    const { logger, lines } = buildBufferedLogger();
    logger.info({
      res: {
        headers: {
          "set-cookie": ["session=leaked"],
          "content-type": "application/json",
        },
      },
    }, "response");
    const out = lastLine(lines);
    assert.equal(out.res.headers["set-cookie"], "[REDACTED]");
    assert.equal(out.res.headers["content-type"], "application/json");
  });

  test("censors top-level credential keys", () => {
    const { logger, lines } = buildBufferedLogger();
    logger.info({
      password: "top-pw",
      token: "top-token",
      refreshToken: "top-rt",
      accessToken: "top-at",
      apiKey: "top-key",
      clientSecret: "top-cs",
      secret: "top-secret",
      authorization: "Bearer top",
      cookie: "session=top",
      // Sibling fields stay visible.
      userId: "user-42",
      action: "login",
    }, "top-level");
    const out = lastLine(lines);
    assert.equal(out.password, "[REDACTED]");
    assert.equal(out.token, "[REDACTED]");
    assert.equal(out.refreshToken, "[REDACTED]");
    assert.equal(out.accessToken, "[REDACTED]");
    assert.equal(out.apiKey, "[REDACTED]");
    assert.equal(out.clientSecret, "[REDACTED]");
    assert.equal(out.secret, "[REDACTED]");
    assert.equal(out.authorization, "[REDACTED]");
    assert.equal(out.cookie, "[REDACTED]");
    assert.equal(out.userId, "user-42");
    assert.equal(out.action, "login");
  });

  test("censors one-level-nested credentials via wildcard paths", () => {
    const { logger, lines } = buildBufferedLogger();
    logger.info({
      user: { id: "u1", password: "nested-pw", token: "nested-token" },
      creds: { apiKey: "nested-key", clientSecret: "nested-cs" },
      session: { cookie: "nested-cookie", authorization: "Bearer nested" },
    }, "nested");
    const out = lastLine(lines);
    assert.equal(out.user.id, "u1");
    assert.equal(out.user.password, "[REDACTED]");
    assert.equal(out.user.token, "[REDACTED]");
    assert.equal(out.creds.apiKey, "[REDACTED]");
    assert.equal(out.creds.clientSecret, "[REDACTED]");
    assert.equal(out.session.cookie, "[REDACTED]");
    assert.equal(out.session.authorization, "[REDACTED]");
  });

  test("does not remove keys — log shape stays stable for downstream parsers", () => {
    const { logger, lines } = buildBufferedLogger();
    logger.info({ password: "x" }, "shape");
    const out = lastLine(lines);
    // The point of `remove: false`: dashboards keyed off `password`
    // shouldn't break, they should just see `[REDACTED]`.
    assert.ok("password" in out, "password key must remain in serialized output");
    assert.equal(out.password, "[REDACTED]");
  });

  test("censors sensitive keys at arbitrary nested depths", () => {
    const { logger, lines } = buildBufferedLogger();
    logger.info({
      workflow: {
        provider: {
          credentials: {
            apiKey: "deep-api-key",
            nested: { clientSecret: "deep-client-secret" },
          },
        },
      },
    }, "deep");
    const out = lastLine(lines);
    assert.equal(out.workflow.provider.credentials.apiKey, "[REDACTED]");
    assert.equal(out.workflow.provider.credentials.nested.clientSecret, "[REDACTED]");
  });
});
