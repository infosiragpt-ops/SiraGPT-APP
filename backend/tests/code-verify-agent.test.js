'use strict';

// verify-agent.buildVerdict — turns a page snapshot + collected signals into a
// verdict. Focus: the error-overlay finding now carries the REAL overlay text
// so the auto-repair loop gets an actionable message (not just "there is an
// overlay"). buildVerdict is pure, so no browser is needed.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildVerdict, emptySnapshot } = require('../src/services/code/verify-agent');

function baseArgs(overrides = {}) {
  return {
    navStatus: 200,
    snapshot: { ...emptySnapshot(), rootHasContent: true },
    markers: [],
    consoleErrors: [],
    pageErrors: [],
    failedResponses: [],
    ...overrides,
  };
}

test('clean render → ok:true, no findings', () => {
  const v = buildVerdict(baseArgs());
  assert.equal(v.ok, true);
  assert.equal(v.findings.length, 0);
});

test('error overlay WITH extracted text → finding includes the real error', () => {
  const v = buildVerdict(baseArgs({
    snapshot: {
      ...emptySnapshot(),
      rootHasContent: true,
      hasErrorOverlay: true,
      overlayText: "ReferenceError: foo is not defined",
    },
  }));
  assert.equal(v.ok, false);
  const overlay = v.findings.find((f) => f.kind === 'error_overlay');
  assert.ok(overlay, 'expected an error_overlay finding');
  assert.match(overlay.message, /ReferenceError: foo is not defined/);
  assert.match(overlay.message, /overlay de error/i);
});

test('error overlay WITHOUT text → generic message, no dangling "Error:"', () => {
  const v = buildVerdict(baseArgs({
    snapshot: { ...emptySnapshot(), rootHasContent: true, hasErrorOverlay: true, overlayText: '' },
  }));
  const overlay = v.findings.find((f) => f.kind === 'error_overlay');
  assert.ok(overlay);
  assert.doesNotMatch(overlay.message, /Error:\s*$/);
  assert.match(overlay.message, /overlay de error/i);
});

test('overlayText is whitespace-only → treated as absent (generic message)', () => {
  const v = buildVerdict(baseArgs({
    snapshot: { ...emptySnapshot(), rootHasContent: true, hasErrorOverlay: true, overlayText: '   ' },
  }));
  const overlay = v.findings.find((f) => f.kind === 'error_overlay');
  assert.ok(overlay);
  assert.doesNotMatch(overlay.message, /Error:/);
});

test('emptySnapshot carries an overlayText field (shape stability)', () => {
  assert.equal(typeof emptySnapshot().overlayText, 'string');
});
