/**
 * webauthn-config — pins the env-vars → relying-party config
 * resolution and the origin allowlist check used by the (future)
 * registration / authentication endpoints. Two properties matter:
 *
 *   1. Default-disabled. A misconfigured deploy that forgets to
 *      set rpID + origin must NOT silently expose a passkey
 *      surface bound to the wrong identity (which would let a
 *      different domain steal credentials).
 *
 *   2. Origin equality, not suffix match. WebAuthn spec requires
 *      exact origin matching; suffix-allowlist semantics (used by
 *      our CORS layer) are WRONG here.
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveWebAuthnConfig,
  assertOriginAllowed,
  DEFAULT_RP_NAME,
} = require("../src/services/webauthn/webauthn-config");

describe("resolveWebAuthnConfig", () => {
  test("disabled when neither rpID nor origin is set", () => {
    const cfg = resolveWebAuthnConfig({});
    assert.equal(cfg.configured, false);
    assert.equal(cfg.enabled, false);
  });

  test("disabled when only rpID is set (no origin)", () => {
    const cfg = resolveWebAuthnConfig({ WEBAUTHN_RP_ID: "example.com" });
    assert.equal(cfg.configured, false);
    assert.equal(cfg.enabled, false);
  });

  test("disabled when only origin is set (no rpID)", () => {
    const cfg = resolveWebAuthnConfig({ WEBAUTHN_ORIGIN: "https://app.example.com" });
    assert.equal(cfg.configured, false);
  });

  test("auto-enables when BOTH rpID and origin are set", () => {
    const cfg = resolveWebAuthnConfig({
      WEBAUTHN_RP_ID: "example.com",
      WEBAUTHN_ORIGIN: "https://app.example.com",
    });
    assert.equal(cfg.configured, true);
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.rpID, "example.com");
    assert.deepEqual(cfg.origins, ["https://app.example.com"]);
  });

  test("supports multiple origins (prod + staging) via comma-separated list", () => {
    const cfg = resolveWebAuthnConfig({
      WEBAUTHN_RP_ID: "example.com",
      WEBAUTHN_ORIGIN: "https://app.example.com, https://staging.example.com",
    });
    assert.deepEqual(cfg.origins, [
      "https://app.example.com",
      "https://staging.example.com",
    ]);
  });

  test("WEBAUTHN_ORIGINS is honored as an alias of WEBAUTHN_ORIGIN", () => {
    const cfg = resolveWebAuthnConfig({
      WEBAUTHN_RP_ID: "example.com",
      WEBAUTHN_ORIGINS: "https://a.example.com",
    });
    assert.deepEqual(cfg.origins, ["https://a.example.com"]);
  });

  test("WEBAUTHN_ENABLED=false explicitly disables even when configured", () => {
    const cfg = resolveWebAuthnConfig({
      WEBAUTHN_RP_ID: "example.com",
      WEBAUTHN_ORIGIN: "https://app.example.com",
      WEBAUTHN_ENABLED: "false",
    });
    assert.equal(cfg.configured, true);
    assert.equal(cfg.enabled, false);
  });

  test("rpName defaults to siraGPT when not provided", () => {
    const cfg = resolveWebAuthnConfig({
      WEBAUTHN_RP_ID: "example.com",
      WEBAUTHN_ORIGIN: "https://app.example.com",
    });
    assert.equal(cfg.rpName, DEFAULT_RP_NAME);
  });

  test("rpName is overridable", () => {
    const cfg = resolveWebAuthnConfig({
      WEBAUTHN_RP_ID: "example.com",
      WEBAUTHN_ORIGIN: "https://app.example.com",
      WEBAUTHN_RP_NAME: "Sira Internal",
    });
    assert.equal(cfg.rpName, "Sira Internal");
  });
});

describe("assertOriginAllowed", () => {
  const cfg = resolveWebAuthnConfig({
    WEBAUTHN_RP_ID: "example.com",
    WEBAUTHN_ORIGIN: "https://app.example.com,https://staging.example.com",
  });

  test("matches exact origin", () => {
    assert.equal(assertOriginAllowed("https://app.example.com", cfg), true);
    assert.equal(assertOriginAllowed("https://staging.example.com", cfg), true);
  });

  test("rejects different scheme (http vs https) — exact match required", () => {
    assert.equal(assertOriginAllowed("http://app.example.com", cfg), false);
  });

  test("rejects different port", () => {
    assert.equal(assertOriginAllowed("https://app.example.com:4443", cfg), false);
  });

  test("rejects subdomain not in allowlist (no suffix match)", () => {
    assert.equal(assertOriginAllowed("https://other.example.com", cfg), false);
  });

  test("rejects when config is disabled", () => {
    const off = resolveWebAuthnConfig({});
    assert.equal(assertOriginAllowed("https://app.example.com", off), false);
  });

  test("rejects empty / non-string origin", () => {
    assert.equal(assertOriginAllowed("", cfg), false);
    assert.equal(assertOriginAllowed(null, cfg), false);
    assert.equal(assertOriginAllowed(undefined, cfg), false);
  });
});
