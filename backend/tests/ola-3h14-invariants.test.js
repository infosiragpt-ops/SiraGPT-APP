'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

test('3H14-BE-001 queueHonesty pending in live status', () => {
  const src = read('src/services/agent-gateway/index.js');
  assert.match(src, /pending: qh\.pending/);
});

test('3H14-BE-002 public status redacts sessionKey/userId from deadLetter', () => {
  const { createGateway } = require('../src/services/agent-gateway');
  const gw = createGateway({ runner: { run: async () => ({ text: 'ok' }) } });
  gw.sessionDlq.push({ sessionKey: 'lane-secret', userId: 'user-secret', error: 'turn_timeout' });
  const st = gw.status();
  const blob = JSON.stringify(st);
  assert.equal(blob.includes('lane-secret'), false);
  assert.equal(blob.includes('user-secret'), false);
  assert.equal(st.queueHonesty.pending, 0);
  assert.equal(st.retryableDeadLetterCount >= 1, true);
});

test('3H14-BE-003 startAgent empty prompt fail-closed', () => {
  const { createGateway } = require('../src/services/agent-gateway');
  const gw = createGateway({ runner: { run: async () => ({ text: 'ok' }) } });
  let err = null;
  try { gw.startAgent({ sessionKey: 'k1', surface: 'chat', userId: 'u1', message: '  ' }); } catch (e) { err = e; }
  assert.equal(err && err.code, 'empty_prompt');
});

test('3H14-BE-004 startAgent prompt cap fail-closed', () => {
  const { createGateway } = require('../src/services/agent-gateway');
  const gw = createGateway({ runner: { run: async () => ({ text: 'ok' }) } });
  let err = null;
  try { gw.startAgent({ sessionKey: 'k1', surface: 'chat', userId: 'u1', message: 'x'.repeat(8001) }); } catch (e) { err = e; }
  assert.equal(err && err.code, 'prompt_too_long');
});

test('3H14-BE-005 startAgent idempotencyKey duplicate fail-closed', () => {
  const { createGateway } = require('../src/services/agent-gateway');
  const gw = createGateway({ runner: { run: async () => ({ text: 'ok' }) } });
  const a = gw.startAgent({ sessionKey: 'k1', surface: 'chat', userId: 'u1', message: 'hola', idempotencyKey: 'turn-ola14' });
  assert.equal(Boolean(a.runId), true);
  let err = null;
  try {
    gw.startAgent({ sessionKey: 'k1', surface: 'chat', userId: 'u1', message: 'hola', idempotencyKey: 'turn-ola14' });
  } catch (e) { err = e; }
  assert.equal(err && err.code, 'duplicate_turn');
});

test('3H14-BE-006 HTTP agent/dlq/skills leftovers wired', () => {
  const src = read('src/services/agent-gateway/http.js');
  assert.match(src, /failHttp/);
  assert.match(src, /idempotencyKey/);
  assert.match(src, /handlers\.dlq/);
  assert.match(src, /searchSkills/);
  assert.match(src, /searchPersistedSkills/);
});

test('3H14-BE-007 gateway.js mounts GET /dlq', () => {
  assert.match(read('src/routes/gateway.js'), /router\.get\('\/dlq', h\.dlq\)/);
});

test('3H14-BE-008 error taxonomy leftover turn_timeout retryable + httpStatus', () => {
  const tax = require('../src/services/error_codes');
  assert.equal(tax.CODES.DUPLICATE_TURN, 'duplicate_turn');
  assert.equal(tax.isRetryable('turn_timeout'), true);
  assert.equal(tax.isRetryable('duplicate_turn'), false);
  assert.equal(tax.httpStatusFor('session_queue_full'), 429);
  assert.equal(tax.httpStatusFor('user_required'), 401);
  assert.equal(tax.publicError('turn_timeout').retryable, true);
});

test('3H14-BE-009 webhook inbound oversized delivery-id fail-closed', () => {
  const wh = require('../src/routes/webhooks');
  const tooLong = wh.rememberInboundDelivery('d'.repeat(129));
  assert.equal(tooLong.error, 'delivery_id_too_long');
  const ok = wh.rememberInboundDelivery('del-1');
  assert.equal(ok.replay, false);
  const replay = wh.rememberInboundDelivery('del-1');
  assert.equal(replay.replay, true);
});

test('3H14-BE-010 memory-search leftover chatId filter + duplicate skip', () => {
  const os = require('os');
  const fs = require('fs');
  const file = path.join(os.tmpdir(), `ola3h14-mem-${Date.now()}.json`);
  const mem = require('../src/services/memory-search-persist');
  const a = mem.persistEpisode({ userId: 'u1', chatId: 'c1', text: 'alpha invoice', file });
  assert.equal(a.indexed, 1);
  const dup = mem.persistEpisode({ userId: 'u1', chatId: 'c1', text: 'alpha invoice', file });
  assert.equal(dup.duplicate, true);
  mem.persistEpisode({ userId: 'u1', chatId: 'c2', text: 'beta invoice', file });
  const scoped = mem.searchUserEpisodes({ userId: 'u1', query: 'invoice', chatId: 'c1', file });
  assert.equal(scoped.every((h) => h.chatId === 'c1'), true);
  assert.equal(scoped.length >= 1, true);
  try { fs.unlinkSync(file); } catch (_) {}
});

test('3H14-BE-011 memory route leftover persist search/delete', () => {
  const src = read('src/routes/memory.js');
  assert.match(src, /searchUserEpisodes/);
  assert.match(src, /persistEpisode/);
  assert.match(src, /deleteUserEpisodes/);
  assert.match(src, /persistCleared/);
});

test('3H14-BE-012 skills leftover recommendSkills hide admin', () => {
  const reg = require('../src/services/skills-registry');
  try { reg.registerSkill({ id: 'ola3h14-admin-wipe', label: 'wipe invoices', description: 'danger', clearance: 'admin', overwrite: true, tags: ['invoices'] }); } catch (_) {}
  const rec = reg.recommendSkills('invoices', { limit: 20 });
  assert.equal(rec.some((s) => s.id === 'ola3h14-admin-wipe'), false);
  const admin = reg.recommendSkills('invoices', { limit: 20, clearance: 'admin' });
  assert.equal(admin.some((s) => s.id === 'ola3h14-admin-wipe'), true);
});

test('3H14-BE-013 cron leftover oversized job id + inflight snapshot', async () => {
  const cron = require('../src/services/cron-as-turn');
  assert.equal(typeof cron.inflightSnapshot, 'function');
  assert.equal(cron.inflightSnapshot().max, 8);
  const too = await cron.dispatchCronJobAsAgentTurn({ startAgent() { return { runId: 'r' }; } }, {
    id: 'j'.repeat(129), userId: 'u1', prompt: 'hello',
  });
  assert.equal(too.code, 'cron_job_id_too_long');
});

test('3H14-BE-014 cron leftover tick unique duplicate', async () => {
  const cron = require('../src/services/cron-as-turn');
  const runner = { startAgent() { return { runId: 'r' }; } };
  const a = await cron.dispatchCronJobAsAgentTurn(runner, { id: 'ola14-tick', userId: 'u1', prompt: 'hello' });
  const b = await cron.dispatchCronJobAsAgentTurn(runner, { id: 'ola14-tick', userId: 'u1', prompt: 'hello' });
  assert.equal(typeof a.ok, 'boolean');
  assert.equal(b.code === 'duplicate_turn' || b.error === 'overlap_skipped' || b.error === 'duplicate_turn', true);
});

test('3H14-BE-015 health leftover gateway_queue webhook_hmac cron_inflight', () => {
  const hc = require('../src/services/observability/health-check');
  assert.equal(typeof hc.checkWebhookHmacConfigured, 'function');
  assert.equal(typeof hc.checkCronInflight, 'function');
  assert.equal(typeof hc.checkGatewayQueue, 'function');
  const hmac = hc.checkWebhookHmacConfigured({ SIRAGPT_WEBHOOK_HMAC_SECRET: '' });
  assert.equal(hmac.details.configured, false);
  assert.equal(JSON.stringify(hmac).includes('whsec'), false);
  const cron = hc.checkCronInflight();
  assert.equal(cron.name, 'cron_inflight');
  const src = read('src/services/observability/health-check.js');
  assert.match(src, /checkGatewayQueue\(\)/);
  assert.match(src, /checkWebhookHmacConfigured\(env\)/);
  assert.match(src, /checkCronInflight\(\)/);
});

test('3H14-BE-016 rate-limit leftover generate+stop webhooks/gateway/dlq', () => {
  const rl = require('../src/middleware/rate-limit-policy');
  assert.equal(rl.isSharedGenerateAgentPath('/api/webhooks/inbound'), true);
  assert.equal(rl.isSharedGenerateAgentPath('/api/gateway/memory'), true);
  assert.equal(rl.isSharedGenerateAgentPath('/api/gateway/dlq'), true);
  assert.equal(rl.isSharedGenerateAgentPath('/api/agent-keys'), true);
  assert.equal(rl.isStopStreamPath('/api/webhooks/x/abort'), true);
  assert.equal(rl.isStopStreamPath('/api/webhooks/inbound'), false);
  assert.equal(rl.isStopStreamPath('/api/gateway/status'), false);
});

test('3H14-BE-017 scheduled-agent-tasks leftover payload cap', async () => {
  const sat = require('../src/services/scheduled-agent-tasks');
  assert.equal(sat.MAX_PAYLOAD_CHARS, 8000);
  const empty = sat.assertTaskPayload({ prompt: '  ' });
  assert.equal(empty && empty.code, 'empty_prompt');
  const long = sat.assertTaskPayload({ prompt: 'x'.repeat(8001) });
  assert.equal(long && long.code, 'prompt_too_long');
  const ok = sat.assertTaskPayload({ prompt: 'hello' });
  assert.equal(ok, null);
  const sched = sat.createScheduler();
  let err = null;
  try {
    await sched.createTask({ userId: 'u1', cronExpr: '* * * * *', payload: { prompt: '' } });
  } catch (e) { err = e; }
  assert.equal(err && err.code, 'empty_prompt');
});

test('3H14-BE-018 CRON_CREATE leftover user/prompt fail-closed', () => {
  const src = read('src/services/agent-gateway/index.js');
  assert.match(src, /CRON_CREATE/);
  assert.match(src, /empty_prompt/);
  assert.match(src, /prompt_too_long/);
});

test('3H14-BE-019 HTTP abort leftover user_required', () => {
  const src = read('src/services/agent-gateway/http.js');
  assert.match(src, /async abort/);
  assert.equal(src.includes("if (!userId) return failHttp(res, 'user_required');"), true);
});

test('3H14-BE-020 memory search leftover user_required in gateway dispatch', () => {
  const src = read('src/services/agent-gateway/index.js');
  assert.match(src, /MEMORY_SEARCH/);
  assert.match(src, /if \(!userId\) return \{ hits: \[\], error: 'user_required' \}/);
});
