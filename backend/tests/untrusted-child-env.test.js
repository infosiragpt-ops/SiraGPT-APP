'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildUntrustedChildEnv, ALLOWED_ENV_KEYS } = require('../src/utils/untrusted-child-env');

test('does not forward SiraGPT secrets into an untrusted child env', () => {
  const secretKeys = [
    'SESSION_SECRET', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET',
    'DATABASE_URL', 'R2_SECRET_ACCESS_KEY', 'R2_ACCESS_KEY_ID',
    'GEMINI_API_KEY', 'FAL_API_KEY', 'JINA_API_KEY', 'OPENAI_API_KEY',
  ];
  const saved = {};
  for (const k of secretKeys) {
    saved[k] = process.env[k];
    process.env[k] = `secret-${k}`;
  }
  try {
    const env = buildUntrustedChildEnv();
    for (const k of secretKeys) {
      assert.equal(env[k], undefined, `${k} must not leak into untrusted child env`);
    }
  } finally {
    for (const k of secretKeys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test('forwards essential toolchain vars (PATH) when present', () => {
  const saved = process.env.PATH;
  process.env.PATH = saved || '/usr/bin:/bin';
  try {
    const env = buildUntrustedChildEnv();
    assert.equal(env.PATH, process.env.PATH);
  } finally {
    if (saved === undefined) delete process.env.PATH;
    else process.env.PATH = saved;
  }
});

test('explicit extras are always included and override the base', () => {
  const env = buildUntrustedChildEnv({ PORT: '4321', NODE_ENV: 'development' });
  assert.equal(env.PORT, '4321');
  assert.equal(env.NODE_ENV, 'development');
});

test('drops any non-allowlisted host var by default', () => {
  process.env.__SIRA_NONLISTED_PROBE__ = 'nope';
  try {
    const env = buildUntrustedChildEnv({ PORT: '1' });
    assert.equal(env.__SIRA_NONLISTED_PROBE__, undefined);
    for (const k of Object.keys(env)) {
      const allowed = ALLOWED_ENV_KEYS.includes(k) || k === 'PORT';
      assert.ok(allowed, `unexpected key "${k}" present in untrusted child env`);
    }
  } finally {
    delete process.env.__SIRA_NONLISTED_PROBE__;
  }
});
