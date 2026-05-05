const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  frontendOrigin,
  popupResponseHtml,
  signOAuthState,
  verifyOAuthState,
} = require('../src/services/oauth-state');

const env = {
  JWT_SECRET: 'oauth-state-test-secret-at-least-32-bytes',
  FRONTEND_URL: 'https://app.example.com/auth/callback?ignored=true',
};

test('OAuth state is signed, service-scoped and resolves the user id', () => {
  const state = signOAuthState({ userId: 'user-1', service: 'gmail' }, env);
  assert.equal(typeof state, 'string');
  assert.deepEqual(verifyOAuthState(state, { service: 'gmail' }, env), {
    userId: 'user-1',
    service: 'gmail',
  });
});

test('OAuth state rejects service confusion and tampering', () => {
  const state = signOAuthState({ userId: 'user-1', service: 'gmail' }, env);
  assert.throws(() => verifyOAuthState(state, { service: 'google_services' }, env), /Invalid OAuth state/);
  assert.throws(() => verifyOAuthState(`${state}x`, { service: 'gmail' }, env));
});

test('OAuth popup HTML posts only to the configured frontend origin', () => {
  assert.equal(frontendOrigin(env), 'https://app.example.com');
  const html = popupResponseHtml({ status: 'success', service: 'gmail' }, env);
  assert.match(html, /postMessage/);
  assert.match(html, /"https:\/\/app\.example\.com"/);
  assert.doesNotMatch(html, /postMessage\([^,]+,\s*['"]\*['"]\)/);
});
