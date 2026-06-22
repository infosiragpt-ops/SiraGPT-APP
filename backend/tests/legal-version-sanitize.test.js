"use strict";

// Regression tests for the legal route's `version` path-traversal guard.
// The two GET endpoints and POST /accept all resolve a client-supplied
// `version` into a filesystem path via _loadDocument; an unsafe value used to
// allow reading arbitrary `.md` files outside the legal directory.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const legalRouter = require("../src/routes/legal");

test("isSafeVersion accepts 'latest' and well-formed version tokens", () => {
  assert.equal(legalRouter.isSafeVersion("latest"), true);
  assert.equal(legalRouter.isSafeVersion("1.0.0"), true);
  assert.equal(legalRouter.isSafeVersion("2026-05-19"), true);
  assert.equal(legalRouter.isSafeVersion("v2"), true);
  assert.equal(legalRouter.isSafeVersion("a"), true);
});

test("isSafeVersion rejects traversal and separator payloads", () => {
  for (const bad of [
    "../../../../etc/hosts",
    "/../../../CLAUDE",
    "..",
    "../secret",
    "foo/bar",
    "foo\\bar",
    ".hidden",
    "", // empty
    "a".repeat(64), // over the length cap
  ]) {
    assert.equal(legalRouter.isSafeVersion(bad), false, `should reject: ${JSON.stringify(bad)}`);
  }
});

test("isSafeVersion rejects non-string input", () => {
  assert.equal(legalRouter.isSafeVersion(undefined), false);
  assert.equal(legalRouter.isSafeVersion(null), false);
  assert.equal(legalRouter.isSafeVersion(42), false);
  assert.equal(legalRouter.isSafeVersion({}), false);
});

test("_loadDocument returns null for traversal versions (no arbitrary file read)", () => {
  // A traversal payload that would otherwise resolve to <repo>/CLAUDE.md must
  // be rejected at the loader chokepoint before touching the filesystem.
  assert.equal(legalRouter._loadDocument("privacy-policy", "/../../../CLAUDE"), null);
  assert.equal(legalRouter._loadDocument("privacy-policy", "../../../../etc/hosts"), null);
  // Unknown slug is still null.
  assert.equal(legalRouter._loadDocument("not-a-doc", "latest"), null);
});
