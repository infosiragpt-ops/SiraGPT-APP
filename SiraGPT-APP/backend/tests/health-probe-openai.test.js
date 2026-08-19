'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createOpenAIProbe } = require('../src/health/probes/provider-openai');

test('exports createOpenAIProbe', () => {
  assert.equal(typeof createOpenAIProbe, 'function');
});

test('passes when the upstream returns any 1xx-5xx code (host is reachable)', async () => {
  let receivedUrl = null;
  let receivedOpts = null;
  const fetchImpl = async (url, opts) => {
    receivedUrl = url;
    receivedOpts = opts;
    return { status: 200 };
  };
  const probe = createOpenAIProbe({ fetchImpl, baseUrl: 'https://api.openai.com/v1' });
  const result = await probe.run();
  assert.equal(result.status, 'pass');
  assert.equal(receivedUrl, 'https://api.openai.com/v1');
  assert.equal(receivedOpts.method, 'HEAD');
  assert.ok(receivedOpts.signal, 'must supply an AbortController signal');
  assert.equal(result.details.httpStatus, 200);
  assert.equal(result.details.baseUrl, 'https://api.openai.com/v1');
});

test('passes on 401 (auth-failure but host is reachable)', async () => {
  const fetchImpl = async () => ({ status: 401 });
  const probe = createOpenAIProbe({ fetchImpl });
  const result = await probe.run();
  assert.equal(result.status, 'pass', 'reachable upstream is "pass" even with 401');
  assert.equal(result.details.httpStatus, 401);
});

test('passes on 4xx and 5xx (host responded)', async () => {
  for (const status of [403, 404, 429, 500, 502, 503, 599]) {
    const fetchImpl = async () => ({ status });
    const probe = createOpenAIProbe({ fetchImpl });
    const result = await probe.run();
    assert.equal(result.status, 'pass', `${status} must still be "pass" (host responded)`);
  }
});

test('fails when fetch rejects (host unreachable)', async () => {
  const fetchImpl = async () => { throw new Error('ENOTFOUND'); };
  const probe = createOpenAIProbe({ fetchImpl });
  // The Probe class will catch the throw and convert to a fail status
  const result = await probe.run();
  assert.equal(result.status, 'fail');
});

test('details echo configured method + driverElapsedMs is a number', async () => {
  const fetchImpl = async () => ({ status: 200 });
  const probe = createOpenAIProbe({ fetchImpl, method: 'GET' });
  const result = await probe.run();
  assert.equal(result.details.method, 'GET');
  assert.equal(typeof result.details.driverElapsedMs, 'number');
  assert.ok(result.details.driverElapsedMs >= 0);
});

test('respects OPENAI_BASE_URL env override when no baseUrl is supplied', async () => {
  const orig = process.env.OPENAI_BASE_URL;
  try {
    process.env.OPENAI_BASE_URL = 'https://custom.openai.proxy/v1';
    let receivedUrl = null;
    const fetchImpl = async (url) => { receivedUrl = url; return { status: 200 }; };
    const probe = createOpenAIProbe({ fetchImpl });
    await probe.run();
    assert.equal(receivedUrl, 'https://custom.openai.proxy/v1');
  } finally {
    if (orig !== undefined) process.env.OPENAI_BASE_URL = orig;
    else delete process.env.OPENAI_BASE_URL;
  }
});

test('explicit baseUrl wins over the env override', async () => {
  const orig = process.env.OPENAI_BASE_URL;
  try {
    process.env.OPENAI_BASE_URL = 'https://env.local/v1';
    let receivedUrl = null;
    const fetchImpl = async (url) => { receivedUrl = url; return { status: 200 }; };
    const probe = createOpenAIProbe({ fetchImpl, baseUrl: 'https://explicit.local/v1' });
    await probe.run();
    assert.equal(receivedUrl, 'https://explicit.local/v1');
  } finally {
    if (orig !== undefined) process.env.OPENAI_BASE_URL = orig;
    else delete process.env.OPENAI_BASE_URL;
  }
});

test('does NOT include any Authorization header (only reachability probe)', async () => {
  let receivedOpts = null;
  const fetchImpl = async (_url, opts) => { receivedOpts = opts; return { status: 200 }; };
  const probe = createOpenAIProbe({ fetchImpl });
  await probe.run();
  // The probe code intentionally omits Authorization — verify
  assert.equal(receivedOpts.headers?.Authorization, undefined);
  assert.equal(receivedOpts.headers?.['authorization'], undefined);
});

test('probe.name defaults to "provider-openai" and can be overridden', () => {
  const a = createOpenAIProbe({ fetchImpl: async () => ({ status: 200 }) });
  const b = createOpenAIProbe({ name: 'openai-eu', fetchImpl: async () => ({ status: 200 }) });
  assert.equal(a.name, 'provider-openai');
  assert.equal(b.name, 'openai-eu');
});
