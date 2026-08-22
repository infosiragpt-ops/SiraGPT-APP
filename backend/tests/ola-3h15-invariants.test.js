'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

test('3H15-BE-001 startAgent leftover user_required (never unscoped generate)', () => {
  const { createGateway } = require('../src/services/agent-gateway');
  const gw = createGateway({ runner: { run: async () => ({ text: 'ok' }) } });
  let err = null;
  try { gw.startAgent({ sessionKey: 'k1', surface: 'chat', message: 'hola' }); } catch (e) { err = e; }
  assert.equal(err && err.code, 'user_required');
});

test('3H15-BE-002/003/004/005 HTTP leftover user_required on skillsDelete/load memoryDelete cronGet connect', () => {
  const src = read('src/services/agent-gateway/http.js');
  assert.match(src, /async skillsDelete[\s\S]*if \(!userId\) return failHttp\(res, 'user_required'\)/);
  assert.match(src, /async skillsLoad[\s\S]*if \(!userId\) return failHttp\(res, 'user_required'\)/);
  assert.match(src, /async memoryDelete[\s\S]*if \(!userId\) return failHttp\(res, 'user_required'\)/);
  assert.match(src, /async cronGet[\s\S]*if \(!userId\) return failHttp\(res, 'user_required'\)/);
  assert.match(src, /async connect[\s\S]*if \(!userId\) return failHttp\(res, 'user_required'\)/);
});

test('3H15-BE-006/007/008 gateway list/load leftover user_required', () => {
  const { createGateway } = require('../src/services/agent-gateway');
  const gw = createGateway({ runner: { run: async () => ({ text: 'ok' }) } });
  return Promise.resolve()
    .then(() => gw.handleFrame({ handshakeDone: true }, { type: 'req', id: '1', method: 'skills.list', params: {} }))
    .then((out) => {
      const payload = out.payload || out;
      assert.equal(payload.error, 'user_required');
      assert.deepEqual(payload.skills || [], []);
    })
    .then(() => gw.handleFrame({ handshakeDone: true }, { type: 'req', id: '2', method: 'skills.load', params: { name: 'x' } }))
    .then((out) => {
      const payload = out.payload || out;
      assert.equal(payload.error, 'user_required');
    })
    .then(() => gw.handleFrame({ handshakeDone: true }, { type: 'req', id: '3', method: 'cron.list', params: {} }))
    .then((out) => {
      const payload = out.payload || out;
      assert.equal(payload.error, 'user_required');
      assert.deepEqual(payload.jobs || [], []);
    });
});

test('3H15-BE-009/010 gateway persist leftover empty/cap', () => {
  const { createGateway } = require('../src/services/agent-gateway');
  const gw = createGateway({ runner: { run: async () => ({ text: 'ok' }) } });
  return Promise.resolve()
    .then(() => gw.handleFrame({ handshakeDone: true, userId: 'u1' }, {
      type: 'req', id: 'p1', method: 'skills.persist', params: { name: '', body: 'x', userId: 'u1' },
    }))
    .then((out) => {
      const payload = out.payload || out;
      assert.equal(payload.error, 'invalid_skill_name');
    })
    .then(() => gw.handleFrame({ handshakeDone: true, userId: 'u1' }, {
      type: 'req', id: 'p2', method: 'skills.persist', params: { name: 'ok', body: 'x'.repeat(16001), userId: 'u1' },
    }))
    .then((out) => {
      const payload = out.payload || out;
      assert.equal(payload.error, 'payload_too_long');
    })
    .then(() => gw.handleFrame({ handshakeDone: true, userId: 'u1' }, {
      type: 'req', id: 'p3', method: 'memory.persist', params: { text: '  ', userId: 'u1' },
    }))
    .then((out) => {
      const payload = out.payload || out;
      assert.equal(payload.error, 'empty_text');
    })
    .then(() => gw.handleFrame({ handshakeDone: true, userId: 'u1' }, {
      type: 'req', id: 'p4', method: 'memory.persist', params: { text: 'x'.repeat(4001), userId: 'u1' },
    }))
    .then((out) => {
      const payload = out.payload || out;
      assert.equal(payload.error, 'payload_too_long');
    });
});

test('3H15-BE-011/012 HTTP persist leftover empty/cap failHttp', () => {
  const src = read('src/services/agent-gateway/http.js');
  assert.match(src, /failHttp\(res, 'invalid_skill_name'\)/);
  assert.match(src, /failHttp\(res, 'empty_text'\)/);
  assert.match(src, /failHttp\(res, 'payload_too_long'\)/);
});

test('3H15-BE-013 HTTP leftover failHttp on persist catch + payload.error', () => {
  const src = read('src/services/agent-gateway/http.js');
  assert.match(src, /if \(out && out\.payload && out\.payload\.error\) return failHttp/);
  assert.match(src, /return failHttp\(res, \(err && err\.code\) \|\| 'bad_request'/);
});

test('3H15-BE-014 error taxonomy leftover empty_text / invalid_skill_name / payload_too_long / retry_unavailable', () => {
  const tax = require('../src/services/error_codes');
  assert.equal(tax.CODES.EMPTY_TEXT, 'empty_text');
  assert.equal(tax.CODES.INVALID_SKILL_NAME, 'invalid_skill_name');
  assert.equal(tax.CODES.CHAT_ID_TOO_LONG, 'chat_id_too_long');
  assert.equal(tax.CODES.RETRY_UNAVAILABLE, 'retry_unavailable');
  assert.equal(tax.httpStatusFor('user_required'), 401);
  assert.equal(tax.httpStatusFor('retry_unavailable'), 409);
  assert.equal(tax.httpStatusFor('payload_too_long'), 413);
  assert.equal(tax.httpStatusFor('chat_id_too_long'), 413);
  assert.equal(tax.isRetryable('empty_text'), false);
  assert.equal(tax.publicError('empty_text').retryable, false);
});

test('3H15-BE-015/016 health leftover chat_run_worker + skills_persist wired', () => {
  const src = read('src/services/observability/health-check.js');
  assert.match(src, /checks\.push\(checkChatRunWorkerHeartbeat\(\)\)/);
  assert.match(src, /checks\.push\(checkSkillsPersistUnscoped\(\)\)/);
  const health = require('../src/services/observability/health-check');
  const skills = health.checkSkillsPersistUnscoped();
  assert.equal(skills.name, 'skills_persist');
  assert.equal(skills.critical, false);
  assert.equal(skills.details.unscopedEmpty, true);
  const worker = health.checkChatRunWorkerHeartbeat();
  assert.equal(worker.name, 'chat_run_worker');
  assert.equal(worker.critical, false);
});

test('3H15-BE-017/018 rate-limit leftover generate/stop remaining paths', () => {
  const { isSharedGenerateAgentPath, isStopStreamPath } = require('../src/middleware/rate-limit-policy');
  assert.equal(isSharedGenerateAgentPath('/api/artifacts'), true);
  assert.equal(isSharedGenerateAgentPath('/api/admin-queues'), true);
  assert.equal(isSharedGenerateAgentPath('/api/document-index-internal'), true);
  assert.equal(isSharedGenerateAgentPath('/api/ai-failover-health'), true);
  assert.equal(isStopStreamPath('/api/gateway/dlq/ack'), true);
  assert.equal(isStopStreamPath('/api/admin-queues/retry'), true);
  assert.equal(isStopStreamPath('/api/ai/generate'), false);
});

test('3H15-BE-019 webhooks leftover inbound replay map cap', () => {
  const wh = require('../src/routes/webhooks');
  assert.equal(wh.INBOUND_IDEM_MAX, 10000);
  const src = read('src/routes/webhooks.js');
  assert.match(src, /INBOUND_IDEM_MAX/);
  assert.match(src, /inboundDeliverySeen\.size >= INBOUND_IDEM_MAX/);
});

test('3H15-BE-020 HTTP leftover readBody size cap', () => {
  const src = read('src/services/agent-gateway/http.js');
  assert.match(src, /256 \* 1024/);
  assert.match(src, /payload_too_long/);
});

test('3H15-BE-021/022 DLQ leftover POST ack user-scoped + retry_unavailable', () => {
  const { createSessionDlq } = require('../src/services/agent-gateway/session-dlq');
  const dlq = createSessionDlq();
  dlq.push({ sessionKey: 'lane-a', userId: 'u1', runId: 'r1', error: 'turn_timeout' });
  dlq.push({ sessionKey: 'lane-b', userId: 'u2', runId: 'r2', error: 'turn_timeout' });
  const denied = dlq.ack({ userId: '' });
  assert.equal(denied.error, 'user_required');
  const other = dlq.ack({ userId: 'u3' });
  assert.equal(other.acked, 0);
  const mine = dlq.ack({ userId: 'u1' });
  assert.equal(mine.acked, 1);
  const left = dlq.list({ userId: 'u2' });
  assert.equal(left.length, 1);
  assert.equal(dlq.list({ userId: 'u1' }).length, 0);
  const counts = dlq.snapshotCount();
  assert.equal(JSON.stringify(counts).includes('lane-'), false);
  assert.equal(JSON.stringify(counts).includes('u2'), false);
  const src = read('src/services/agent-gateway/http.js');
  assert.match(src, /handlers\.dlqPost/);
  assert.match(src, /failHttp\(res, 'retry_unavailable'\)/);
  assert.match(read('src/routes/gateway.js'), /router\.post\('\/dlq', h\.dlqPost\)/);
});

test('3H15-BE-023 memory leftover chatId cap + oversized text fail-closed', () => {
  const persist = require('../src/services/memory-search-persist');
  const file = path.join(os.tmpdir(), `ola3h15-mem-${process.pid}.json`);
  try { fs.unlinkSync(file); } catch (_) {}
  const empty = persist.persistEpisode({ userId: 'u1', text: '  ', file });
  assert.equal(empty.error, 'empty_text');
  const longChat = persist.persistEpisode({ userId: 'u1', chatId: 'c'.repeat(129), text: 'hola', file });
  assert.equal(longChat.error, 'chat_id_too_long');
  const longText = persist.persistEpisode({ userId: 'u1', text: 'x'.repeat(4001), file });
  assert.equal(longText.error, 'payload_too_long');
  const ok = persist.persistEpisode({ userId: 'u1', chatId: 'chat-1', text: 'hola', file });
  assert.equal(ok.indexed, 1);
  try { fs.unlinkSync(file); } catch (_) {}
});

test('3H15-BE-024 skills leftover oversized body fail-closed (not silent slice)', () => {
  const persist = require('../src/services/skills-persist');
  const root = path.join(os.tmpdir(), `ola3h15-skills-${process.pid}`);
  let err = null;
  try {
    persist.persistUserSkill({ userId: 'u1', name: 'demo', body: 'x'.repeat(16001), root });
  } catch (e) { err = e; }
  assert.equal(err && err.code, 'payload_too_long');
  const ok = persist.persistUserSkill({ userId: 'u1', name: 'demo', body: 'hello', description: 'd', root });
  assert.equal(ok.persisted, true);
  const unscoped = persist.listPersistedSkills({ userId: '' });
  assert.deepEqual(unscoped, []);
});

test('3H15-BE-025 cron leftover job-id cap on create', () => {
  const { createCron } = require('../src/services/agent-cron');
  const cron = createCron({ persistPath: path.join(os.tmpdir(), `ola3h15-cron-${process.pid}.json`) });
  const tooLong = cron.createJob({
    userId: 'u1', prompt: 'tick', everyMs: 60000, id: 'j'.repeat(129),
  });
  assert.equal(tooLong.code, 'cron_job_id_too_long');
  const ok = cron.createJob({ userId: 'u1', prompt: 'tick', everyMs: 60000, id: 'job-ok' });
  assert.equal(ok.ok, true);
});

test('3H15-BE-026 gateway.js leftover liveSkills never unscoped list/load', () => {
  const src = read('src/routes/gateway.js');
  assert.match(src, /never list unscoped/);
  assert.match(src, /if \(!userId\) return \[\]/);
  assert.match(src, /never load unscoped/);
  assert.match(src, /error: 'user_required'/);
});

test('3H15-BE-027 memory route leftover empty_text / payload_too_long taxonomy', () => {
  const src = read('src/routes/memory.js');
  assert.match(src, /empty_text/);
  assert.match(src, /payload_too_long/);
  assert.match(src, /chat_id_too_long/);
});

test('3H15-BE-028 default cron stub leftover never lists unscoped jobs', () => {
  const src = read('src/services/agent-gateway/index.js');
  assert.match(src, /default stub never lists\/creates unscoped jobs/);
  assert.match(src, /startAgent requires userId/);
});
