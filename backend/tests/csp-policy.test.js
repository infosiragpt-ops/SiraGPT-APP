/**
 * csp-policy — pins the env-var → CSP config resolution. Two
 * properties matter:
 *
 *   1. Default report-only. A fresh deploy must NEVER block
 *      content because of CSP — operators iterate by reading
 *      reports, then flip CSP_REPORT_ONLY=false when they're
 *      confident.
 *
 *   2. Operator overrides land on every directive. A deploy that
 *      tightens script-src to drop 'unsafe-eval' MUST be able to
 *      do so via CSP_SCRIPT_SRC without code changes.
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveCspConfig,
  buildCspDirectives,
  DEFAULT_SCRIPT_SRC,
  DEFAULT_STYLE_SRC,
  DEFAULT_OBJECT_SRC,
} = require("../src/middleware/csp-policy");

describe("resolveCspConfig — defaults", () => {
  test("enabled by default", () => {
    assert.equal(resolveCspConfig({}).enabled, true);
  });

  test("report-only by default (never blocks)", () => {
    assert.equal(resolveCspConfig({}).reportOnly, true);
  });

  test("CSP_ENABLED=false disables", () => {
    assert.equal(resolveCspConfig({ CSP_ENABLED: 'false' }).enabled, false);
  });

  test("CSP_REPORT_ONLY=false enforces (operator opt-in after observation)", () => {
    assert.equal(resolveCspConfig({ CSP_REPORT_ONLY: 'false' }).reportOnly, false);
  });

  test("script-src defaults include 'self', 'unsafe-inline', 'unsafe-eval' (Next.js + Mermaid)", () => {
    const cfg = resolveCspConfig({});
    assert.deepEqual(cfg.directives.scriptSrc, DEFAULT_SCRIPT_SRC);
    assert.ok(cfg.directives.scriptSrc.includes("'self'"));
    assert.ok(cfg.directives.scriptSrc.includes("'unsafe-inline'"));
  });

  test("object-src defaults to 'none' — blocks legacy plugin embeds", () => {
    assert.deepEqual(resolveCspConfig({}).directives.objectSrc, DEFAULT_OBJECT_SRC);
  });

  test("img-src is broad ('https:' allows any HTTPS image)", () => {
    const cfg = resolveCspConfig({});
    assert.ok(cfg.directives.imgSrc.includes('https:'));
    assert.ok(cfg.directives.imgSrc.includes('data:'));
    assert.ok(cfg.directives.imgSrc.includes('blob:'));
  });
});

describe("resolveCspConfig — env overrides", () => {
  test("CSP_SCRIPT_SRC drops 'unsafe-eval' (production tightening)", () => {
    const cfg = resolveCspConfig({
      CSP_SCRIPT_SRC: "'self' 'unsafe-inline'",
    });
    assert.deepEqual(cfg.directives.scriptSrc, ["'self'", "'unsafe-inline'"]);
    assert.ok(!cfg.directives.scriptSrc.includes("'unsafe-eval'"));
  });

  test("comma + whitespace separator both work", () => {
    const cfg = resolveCspConfig({
      CSP_CONNECT_SRC: "'self' https://api.example.com, https://other.example.com",
    });
    assert.deepEqual(cfg.directives.connectSrc, [
      "'self'",
      "https://api.example.com",
      "https://other.example.com",
    ]);
  });

  test("frame-ancestors override (clickjacking lockdown)", () => {
    const cfg = resolveCspConfig({ CSP_FRAME_ANCESTORS: "'none'" });
    assert.deepEqual(cfg.directives.frameAncestors, ["'none'"]);
  });

  test("CSP_REPORT_URI is captured for browser reporting", () => {
    const cfg = resolveCspConfig({ CSP_REPORT_URI: 'https://csp-report.example.com/r' });
    assert.equal(cfg.reportUri, 'https://csp-report.example.com/r');
  });
});

describe("buildCspDirectives", () => {
  test("emits a default-src fallback even though resolveCspConfig doesn't track it", () => {
    const directives = buildCspDirectives(resolveCspConfig({}));
    assert.deepEqual(directives.defaultSrc, ["'self'"]);
  });

  test("includes reportUri when configured, omits when not", () => {
    const withUri = buildCspDirectives(resolveCspConfig({ CSP_REPORT_URI: 'https://r.example.com' }));
    assert.deepEqual(withUri.reportUri, ['https://r.example.com']);

    const withoutUri = buildCspDirectives(resolveCspConfig({}));
    assert.equal(withoutUri.reportUri, undefined);
  });

  test("forwards every configured directive into the helmet shape", () => {
    const directives = buildCspDirectives(resolveCspConfig({
      CSP_SCRIPT_SRC: "'self'",
      CSP_STYLE_SRC: "'self'",
      CSP_OBJECT_SRC: "'none'",
    }));
    assert.deepEqual(directives.scriptSrc, ["'self'"]);
    assert.deepEqual(directives.styleSrc, ["'self'"]);
    assert.deepEqual(directives.objectSrc, ["'none'"]);
  });
});

describe("strict mode (CSP_STRICT=true)", () => {
  test("strict mode flips reportOnly to false by default (enforcement)", () => {
    const cfg = resolveCspConfig({ CSP_STRICT: 'true' });
    assert.equal(cfg.strict, true);
    assert.equal(cfg.reportOnly, false);
  });

  test("strict mode drops 'unsafe-eval' from script-src by default", () => {
    const cfg = resolveCspConfig({ CSP_STRICT: 'true' });
    assert.ok(!cfg.directives.scriptSrc.includes("'unsafe-eval'"));
  });

  test("strict mode locks frame-ancestors to 'none' by default", () => {
    const cfg = resolveCspConfig({ CSP_STRICT: 'true' });
    assert.deepEqual(cfg.directives.frameAncestors, ["'none'"]);
  });

  test("strict mode enables upgrade-insecure-requests", () => {
    const directives = buildCspDirectives(resolveCspConfig({ CSP_STRICT: 'true' }));
    assert.deepEqual(directives.upgradeInsecureRequests, []);
  });

  test("operator can still opt back into report-only with explicit override", () => {
    const cfg = resolveCspConfig({ CSP_STRICT: 'true', CSP_REPORT_ONLY: 'true' });
    assert.equal(cfg.reportOnly, true);
  });
});

const { buildCspDirectivesWithNonce, cspNonceMiddleware } = require("../src/middleware/csp-policy");

describe("CSP nonce support", () => {
  test("cspNonceMiddleware sets res.locals.cspNonce", () => {
    const mw = cspNonceMiddleware();
    const res = { locals: {} };
    let called = false;
    mw({}, res, () => { called = true; });
    assert.equal(called, true);
    assert.equal(typeof res.locals.cspNonce, 'string');
    assert.ok(res.locals.cspNonce.length > 0);
  });

  test("buildCspDirectivesWithNonce appends per-request nonce fns", () => {
    const directives = buildCspDirectivesWithNonce(resolveCspConfig({ CSP_USE_NONCE: 'true' }));
    const nonceFn = directives.scriptSrc[directives.scriptSrc.length - 1];
    assert.equal(typeof nonceFn, 'function');
    const out = nonceFn({}, { locals: { cspNonce: 'abc123' } });
    assert.equal(out, "'nonce-abc123'");
  });
});
