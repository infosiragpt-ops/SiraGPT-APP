'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const request = require('supertest');

let proxyPolicy;
let loadError;
try {
  proxyPolicy = require('../src/middleware/trust-proxy-policy');
} catch (error) {
  loadError = error;
}

test('trust proxy policy module loads and defaults to direct-connect safety', () => {
  assert.ifError(loadError);
  assert.deepEqual(proxyPolicy.resolveTrustProxyPolicy({}), {
    mode: 'none',
    value: false,
  });
  assert.deepEqual(proxyPolicy.resolveTrustProxyPolicy({ TRUST_PROXY_HOPS: '0' }), {
    mode: 'none',
    value: false,
  });
});

test('trust proxy policy accepts a bounded hop count or validated CIDRs', () => {
  assert.deepEqual(
    proxyPolicy.resolveTrustProxyPolicy({ TRUST_PROXY_HOPS: '1' }),
    { mode: 'hops', value: 1 },
  );
  assert.deepEqual(
    proxyPolicy.resolveTrustProxyPolicy({
      TRUST_PROXY_CIDR: '10.0.0.0/8, 192.168.1.10/32',
    }),
    {
      mode: 'cidr',
      value: ['10.0.0.0/8', '192.168.1.10/32'],
    },
  );
});

test('trust proxy policy rejects ambiguity and malformed hop/CIDR values', () => {
  const cases = [
    { TRUST_PROXY_HOPS: '-1' },
    { TRUST_PROXY_HOPS: '1.5' },
    { TRUST_PROXY_HOPS: '99' },
    { TRUST_PROXY_CIDR: 'not-a-cidr' },
    { TRUST_PROXY_CIDR: '10.0.0.0/99' },
    { TRUST_PROXY_HOPS: '1', TRUST_PROXY_CIDR: '10.0.0.0/8' },
  ];
  for (const env of cases) {
    assert.throws(
      () => proxyPolicy.resolveTrustProxyPolicy(env),
      (error) => error.code === 'TRUST_PROXY_POLICY_INVALID',
    );
  }
});

async function observedIp(policy, forwardedFor) {
  const app = express();
  app.set('trust proxy', policy.value);
  app.get('/ip', (req, res) => res.json({ ip: req.ip }));
  const response = await request(app)
    .get('/ip')
    .set('X-Forwarded-For', forwardedFor);
  return response.body.ip;
}

test('direct topology ignores X-Forwarded-For while one-hop topology trusts only Caddy', async () => {
  const direct = proxyPolicy.resolveTrustProxyPolicy({ TRUST_PROXY_HOPS: '0' });
  const caddy = proxyPolicy.resolveTrustProxyPolicy({ TRUST_PROXY_HOPS: '1' });

  const directIp = await observedIp(direct, '198.51.100.10');
  assert.notEqual(directIp, '198.51.100.10');
  assert.equal(await observedIp(caddy, '198.51.100.10'), '198.51.100.10');
  assert.equal(
    await observedIp(caddy, '198.51.100.10, 203.0.113.9'),
    '203.0.113.9',
    'one trusted hop must not trust a spoofable leftmost chain',
  );
});

test('backend index uses the validated trust proxy policy instead of unconditional hop trust', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.match(source, /resolveTrustProxyPolicy/);
  assert.doesNotMatch(source, /app\.set\(['"]trust proxy['"],\s*1\s*\)/);
});
