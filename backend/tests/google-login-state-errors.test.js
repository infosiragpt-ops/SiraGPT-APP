'use strict';

/**
 * Google login state failures (prod 2026-09-28: «Google OAuth state
 * validation failed: jwt expired» as a warning on every slow consent screen,
 * and a raw JSON 503 in the browser tab when the state store was down).
 * /api/auth/google and its callback are top-level browser navigations: they
 * must always land on /auth/login?error=<code> with a code the (UI-locked)
 * login page already maps — it toasts an unknown code verbatim.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');

const {
  googleLoginStateFailure,
  isExpectedOAuthStateError,
} = require('../src/services/auth/oauth-state-http');

function coded(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function expiredJwtError() {
  const token = jwt.sign({ typ: 'oauth_state' }, 'secret', { expiresIn: '-1s' });
  try {
    jwt.verify(token, 'secret');
  } catch (error) {
    return error;
  }
  throw new Error('expected jwt.verify to throw');
}

const SCENARIOS = [
  { name: 'expired state (coded)', error: coded('OAUTH_STATE_EXPIRED', 'jwt expired'), expected: { redirectCode: 'invalid_state', level: 'info' } },
  { name: 'expired state (raw TokenExpiredError)', error: expiredJwtError(), expected: { redirectCode: 'invalid_state', level: 'info' } },
  { name: 'replayed / already used state', error: coded('OAUTH_STATE_REPLAYED_OR_EXPIRED'), expected: { redirectCode: 'invalid_state', level: 'info' } },
  { name: 'tampered state', error: coded('OAUTH_STATE_INVALID', 'invalid signature'), expected: { redirectCode: 'invalid_state', level: 'warn' } },
  { name: 'binding mismatch', error: coded('OAUTH_STATE_BINDING_INVALID'), expected: { redirectCode: 'invalid_state', level: 'warn' } },
  { name: 'state store unavailable', error: coded('OAUTH_STATE_STORE_UNAVAILABLE'), expected: { redirectCode: 'oauth_state_unavailable', level: 'error' } },
  { name: 'state store at capacity', error: coded('OAUTH_STATE_STORE_CAPACITY'), expected: { redirectCode: 'oauth_state_unavailable', level: 'error' } },
  { name: 'unknown error', error: new Error('boom'), expected: { redirectCode: 'invalid_state', level: 'warn' } },
];

describe('googleLoginStateFailure', () => {
  for (const scenario of SCENARIOS) {
    test(`callback: ${scenario.name}`, () => {
      assert.deepEqual(googleLoginStateFailure(scenario.error), scenario.expected);
    });
  }

  test('issuance (/google) always maps to oauth_state_unavailable at error level', () => {
    for (const scenario of SCENARIOS) {
      assert.deepEqual(
        googleLoginStateFailure(scenario.error, { phase: 'issue' }),
        { redirectCode: 'oauth_state_unavailable', level: 'error' },
      );
    }
  });

  test('isExpectedOAuthStateError only covers expiry and replay', () => {
    assert.equal(isExpectedOAuthStateError(coded('OAUTH_STATE_EXPIRED')), true);
    assert.equal(isExpectedOAuthStateError(coded('OAUTH_STATE_REPLAYED_OR_EXPIRED')), true);
    assert.equal(isExpectedOAuthStateError(expiredJwtError()), true);
    assert.equal(isExpectedOAuthStateError(coded('OAUTH_STATE_INVALID')), false);
    assert.equal(isExpectedOAuthStateError(null), false);
  });

  test('every produced code is one the login page already maps (never toasted raw)', () => {
    const page = fs.readFileSync(path.resolve(__dirname, '../../app/auth/login/page.tsx'), 'utf8');
    const friendly = page.match(/const friendly[^=]*=\s*\{([\s\S]*?)\n\s*\}/);
    assert.ok(friendly, 'login page friendly map must exist');
    const keys = new Set([...friendly[1].matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1]));
    const produced = new Set();
    for (const scenario of SCENARIOS) {
      produced.add(googleLoginStateFailure(scenario.error).redirectCode);
      produced.add(googleLoginStateFailure(scenario.error, { phase: 'issue' }).redirectCode);
    }
    for (const code of produced) assert.ok(keys.has(code), `login page does not map «${code}»`);
  });
});

describe('routes/auth.js Google browser flow', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/routes/auth.js'), 'utf8');

  function block(startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    assert.ok(start >= 0, `missing ${startMarker}`);
    const end = source.indexOf(endMarker, start + startMarker.length);
    assert.ok(end > start, `missing end marker ${endMarker}`);
    return source.slice(start, end);
  }

  const issue = block("router.get('/google', ", "router.get('/google/callback'");
  const callback = block("router.get('/google/callback'", 'passport.authenticate(\'google\', { session: false }');

  test('neither handler answers a raw JSON 503 into the browser tab', () => {
    assert.doesNotMatch(issue, /sendOAuthStateUnavailable/);
    assert.doesNotMatch(callback, /sendOAuthStateUnavailable/);
  });

  test('both handlers use the helper, log at its level and always redirect', () => {
    assert.match(issue, /googleLoginStateFailure\(error, \{ phase: 'issue' \}\)/);
    assert.match(callback, /googleLoginStateFailure\(error\)/);
    for (const handler of [issue, callback]) {
      assert.match(handler, /console\[failure\.level\]/);
      assert.match(handler, /res\.redirect\(getGooglePostCallbackURL\(failure\.redirectCode\)\)/);
      assert.doesNotMatch(handler, /console\.warn\('Google OAuth state/);
    }
  });

  test('the XHR (JSON) OAuth routes keep the actionable 503', () => {
    assert.match(source, /sendOAuthStateUnavailable\(res, \{ provider: 'gmail', error \}\)/);
    assert.match(source, /sendOAuthStateUnavailable\(res, \{ provider: 'google_services', error \}\)/);
  });
});
