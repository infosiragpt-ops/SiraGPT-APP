const { test } = require('node:test');
const assert = require('node:assert/strict');

require('../backend/tests/agent-tools.test.js');

const taskTools = require('../backend/src/services/agents/task-tools');
const agentTools = require('../backend/src/services/agents/agent-tools');

test('static_checks: flags request-controlled HTTP client URLs', async () => {
  const out = await agentTools.static_checks.handler(
    { source: 'proxy.js', content: "app.get('/proxy', (req, res) => fetch(req.query.url));\n" },
    { userId: 'u', collection: 'c' },
  );
  assert.ok(out.findings.some(f => f.rule === 'ssrf_user_controlled_url'));
});

test('static_checks: flags request-controlled redirect targets', async () => {
  const out = await agentTools.static_checks.handler(
    { source: 'redirect.js', content: "app.get('/next', (req, res) => res.redirect(req.query.next));\n" },
    { userId: 'u', collection: 'c' },
  );
  assert.ok(out.findings.some(f => f.rule === 'open_redirect'));
});

test('static_checks: flags JWT decode without verification', async () => {
  const out = await agentTools.static_checks.handler(
    { source: 'auth.js', content: "const claims = jwt.decode(req.headers.authorization);\n" },
    { userId: 'u', collection: 'c' },
  );
  assert.ok(out.findings.some(f => f.rule === 'jwt_decode_without_verify'));
});

test('static_checks: flags weak sensitive cookie settings', async () => {
  const out = await agentTools.static_checks.handler(
    { source: 'cookies.js', content: "res.cookie('session', token, { httpOnly: false });\n" },
    { userId: 'u', collection: 'c' },
  );
  assert.ok(out.findings.some(f => f.rule === 'insecure_cookie_options' && f.severity === 'high'));
});

test('static_checks: flags request object merge pollution risk', async () => {
  const out = await agentTools.static_checks.handler(
    { source: 'merge.js', content: "Object.assign(config, req.body);\n" },
    { userId: 'u', collection: 'c' },
  );
  assert.ok(out.findings.some(f => f.rule === 'prototype_pollution_merge'));
});

test('previewText: serialises circular objects without throwing', () => {
  const obj = { a: 1 };
  obj.self = obj;
  const out = taskTools.INTERNAL.previewText(obj, 200);
  assert.equal(typeof out, 'string');
  assert.match(out, /\[Circular\]/);
});

test('previewText: preserves primitive fallbacks', () => {
  assert.equal(taskTools.INTERNAL.previewText(BigInt(7)), '7');
  assert.equal(taskTools.INTERNAL.previewText(undefined), 'undefined');
});

test('previewText: redacts common secret-shaped values', () => {
  const out = taskTools.INTERNAL.previewText({
    key: `sk-proj-${'A'.repeat(40)}`,
    db: 'postgresql://app_user:verysecretpassword@db.example.com/app',
  }, 400);
  assert.ok(!out.includes('verysecretpassword'));
  assert.ok(!out.includes('sk-proj-'));
  assert.ok(out.includes('[REDACTED'));
});

test('previewText: redacts sensitive fields and auth headers', () => {
  const out = taskTools.INTERNAL.previewText({
    password: 'short-secret',
    headers: {
      authorization: 'Bearer leaked-token',
      cookie: 'session=leaked-session; theme=dark',
    },
  }, '800');
  assert.ok(!out.includes('short-secret'));
  assert.ok(!out.includes('leaked-token'));
  assert.ok(!out.includes('leaked-session'));
  assert.ok(out.includes('[REDACTED'));
});

test('previewText: escapes control characters in previews', () => {
  const out = taskTools.INTERNAL.previewText('ok\u0007bad\u0000end', 100);
  assert.equal(out, 'ok\\u0007bad\\0end');
});

test('previewText: truncates without dangling high surrogate', () => {
  const out = taskTools.INTERNAL.previewText('😀'.repeat(400), 401);
  assert.doesNotThrow(() => JSON.stringify(out));
  assert.ok(out.startsWith('😀'));
});
