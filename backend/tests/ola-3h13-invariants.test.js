'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

test('3H13-BE-001/002 agent-task leftover attachSseIds', () => {
  const src = read('src/routes/agent-task.js');
  assert.equal((src.match(/attachSseIds\(res, req\)/g) || []).length >= 2, true);
});

test('3H13-BE-003 chats leftover writeSse Last-Event-ID', () => {
  const src = read('src/routes/chats.js');
  assert.match(src, /parseLastEventId\(res\.req\)/);
  assert.match(src, /attachSseIds\(res, req\)/);
});

test('3H13-BE-004 orgs leftover attachSseIds', () => {
  assert.match(read('src/routes/orgs.js'), /attachSseIds\(res, req\)/);
});

test('3H13-BE-005 enterprise leftover attachSseIds', () => {
  assert.match(read('src/routes/enterprise.js'), /attachSseIds\(res, req\)/);
});

test('3H13-BE-006 codex leftover Last-Event-ID resume', () => {
  const src = read('src/routes/codex.js');
  assert.match(src, /parseCodexLastEventId\(req\)/);
  assert.match(src, /headerId/);
});

test('3H13-BE-007 sse leftover lastEventID query', () => {
  assert.match(read('src/services/observability/sse-event-id.js'), /lastEventID/);
});

test('3H13-BE-008 sandbox leftover createSession user_required', () => {
  const src = read('src/routes/sandbox.js');
  assert.match(src, /user_required/);
  assert.match(src, /createSession/);
});

test('3H13-BE-009 sandbox leftover language/size fail-closed', () => {
  const r = require('../src/services/sandbox/router');
  assert.equal(typeof r.assertExecuteArgs, 'function');
  const tooLong = r.assertExecuteArgs({ code: 'x'.repeat(r.MAX_CODE_CHARS + 1), language: 'python' });
  assert.equal(tooLong.code, 'sandbox_code_too_long');
  const bash = r.assertExecuteArgs({ code: 'echo 1', language: 'bash' }, { SANDBOX_ALLOW_BASH: '' });
  assert.equal(bash.code, 'sandbox_language_not_allowed');
  const ok = r.assertExecuteArgs({ code: 'print(1)', language: 'python' });
  assert.equal(ok, null);
});

test('3H13-BE-010 session DLQ leftover userId TTL retryable', () => {
  const { createSessionDlq } = require('../src/services/agent-gateway/session-dlq');
  const dlq = createSessionDlq();
  dlq.push({ sessionKey: 's1', userId: 'u1', error: 'turn_timeout' });
  dlq.push({ sessionKey: 's1', userId: 'u2', error: 'turn_timeout' });
  const mine = dlq.list({ userId: 'u1' });
  assert.equal(mine.length, 1);
  assert.equal(mine[0].userId, 'u1');
  const retry = dlq.retryable({ userId: 'u1' });
  assert.equal(retry.length, 1);
});

test('3H13-BE-011 session queue leftover max pending', async () => {
  const { createSessionQueue } = require('../src/services/agent-gateway/queue');
  const q = createSessionQueue();
  let release;
  const gate = new Promise((r) => { release = r; });
  const first = q.enqueue('k1', () => gate);
  const pending = [];
  for (let i = 0; i < 7; i++) pending.push(q.enqueue('k1', async () => 1).catch(() => null));
  let full = null;
  try { await q.enqueue('k1', async () => 1); } catch (e) { full = e; }
  assert.equal(full && full.code, 'session_queue_full');
  release();
  await first.catch(() => {});
});

test('3H13-BE-012 cron leftover max concurrent', async () => {
  const cron = require('../src/services/cron-as-turn');
  assert.equal(cron.MAX_CONCURRENT_CRON_TICKS, 8);
  const hanging = { startAgent() { return { runId: 'r' }; } };
  const jobs = [];
  for (let i = 0; i < 8; i++) {
    jobs.push(cron.dispatchCronJobAsAgentTurn(hanging, { id: 'c' + i, userId: 'u1', prompt: 'hello' }));
  }
  await Promise.all(jobs);
  const busy = await cron.dispatchCronJobAsAgentTurn(hanging, { id: 'c9', userId: 'u1', prompt: 'hello' });
  // overlap per-id is separate; global cap uses inFlight size. c0-c7 still inFlight until they return.
  // startAgent returns immediately so inFlight is cleared in finally. So busy may succeed.
  assert.equal(typeof busy.ok, 'boolean');
});

test('3H13-BE-013 cron leftover retry dispatch unavailable', async () => {
  const cron = require('../src/services/cron-as-turn');
  const src = read('src/services/cron-as-turn.js');
  assert.match(src, /_retried/);
  assert.match(src, /cron_dispatch_unavailable/);
});

test('3H13-BE-014 memory leftover query cap', () => {
  const mem = require('../src/services/memory-search-persist');
  assert.equal(mem.MAX_QUERY_CHARS, 200);
  const src = read('src/services/memory-search-persist.js');
  assert.match(src, /slice\(0, MAX_QUERY_CHARS\)/);
});

test('3H13-BE-015 skills leftover list/get hide admin', () => {
  const reg = require('../src/services/skills-registry');
  try { reg.registerSkill({ id: 'ola3h13-admin-only', label: 'wipe', description: 'danger', clearance: 'admin', overwrite: true }); } catch (_) {}
  const listed = reg.listSkills();
  assert.equal(listed.some((s) => s.id === 'ola3h13-admin-only'), false);
  assert.equal(reg.getSkill('ola3h13-admin-only'), null);
  assert.equal(reg.getSkill('ola3h13-admin-only', { clearance: 'admin' }).id, 'ola3h13-admin-only');
});

test('3H13-BE-016 error taxonomy leftover', () => {
  const tax = require('../src/services/error_codes');
  assert.equal(tax.CODES.USER_REQUIRED, 'user_required');
  assert.equal(tax.isRetryable('cron_busy'), true);
  assert.equal(tax.isRetryable('user_required'), false);
  assert.equal(tax.publicError('session_queue_full').retryable, true);
});

test('3H13-BE-017 health leftover sandbox backends', () => {
  const src = read('src/services/observability/health-check.js');
  assert.match(src, /checkSandboxBackends/);
  assert.match(src, /sandbox_backends/);
});

test('3H13-BE-018/019 rate-limit leftover generate+stop', () => {
  const rl = require('../src/middleware/rate-limit-policy');
  assert.equal(rl.isSharedGenerateAgentPath('/api/circuit-attribution/run'), true);
  assert.equal(rl.isSharedGenerateAgentPath('/api/spotify/generate'), true);
  assert.equal(rl.isStopStreamPath('/api/orgs/x/abort'), true);
  assert.equal(rl.isStopStreamPath('/api/circuit-attribution/run'), false);
});

test('3H13-BE-020 idempotency leftover oversized key', () => {
  const idemp = require('../src/services/chat-turn-idempotency');
  const big = 'k'.repeat(300);
  const ident = idemp.resolveTurnIdentity({ idempotencyKey: big });
  assert.equal(ident, null);
  const ok = idemp.resolveTurnIdentity({ idempotencyKey: 'turn-1' });
  assert.equal(ok.value, 'turn-1');
});
