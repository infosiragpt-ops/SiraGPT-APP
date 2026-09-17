'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const DEFAULT_API_BASE_URL = 'http://localhost:5000/api';
const FORBIDDEN_API_HOST = /api\.siragpt\.com/i;

function isLoopbackOrigin(origin) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(String(origin || '').trim());
}

function getNormalizedApiBaseUrl(raw) {
  const value = String(raw || '').trim() || DEFAULT_API_BASE_URL;
  const trimmed = value.replace(/\/+$/, '');
  if (trimmed.endsWith('/api')) return trimmed;
  return `${trimmed}/api`;
}

function getSameOriginApiBaseUrl(raw, locationOrigin, nodeEnv) {
  const origin = String(locationOrigin || '').replace(/\/+$/, '');
  if (origin && !isLoopbackOrigin(origin)) return `${origin}/api`;
  const normalized = getNormalizedApiBaseUrl(raw);
  if (FORBIDDEN_API_HOST.test(normalized)) return '/api';
  if (nodeEnv === 'production' && /localhost:5000/i.test(normalized)) return '/api';
  return normalized;
}

describe('getSameOriginApiBaseUrl production contract', () => {
  test('siragpt.com origin never uses api.siragpt.com or localhost:5000', () => {
    const base = getSameOriginApiBaseUrl('https://api.siragpt.com/api', 'https://siragpt.com', 'production');
    assert.equal(base, 'https://siragpt.com/api');
    assert.doesNotMatch(base, /api\.siragpt\.com/);
    assert.doesNotMatch(base, /localhost:5000/);
  });

  test('production without a window does not fall back to localhost:5000', () => {
    const base = getSameOriginApiBaseUrl(undefined, '', 'production');
    assert.equal(base, '/api');
    assert.doesNotMatch(base, /localhost:5000/);
  });

  test('lib/api-base-url.ts implements the same production rules', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../lib/api-base-url.ts'), 'utf8');
    assert.match(src, /function getSameOriginApiBaseUrl/);
    assert.match(src, /api\\.siragpt\\.com/);
    assert.match(src, /NODE_ENV === "production"/);
    assert.match(src, /localhost:5000/);
    assert.match(src, /return "\/api"/);
  });
});
