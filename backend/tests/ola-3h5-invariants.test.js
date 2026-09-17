'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('3H5-BE design/viz/plan/math/artifact never construct OpenRouter clients', () => {
  for (const rel of [
    'src/services/design-generator.js',
    'src/services/viz-generator.js',
    'src/services/plan-generator.js',
    'src/services/math-solver.js',
    'src/services/artifact-generator.js',
  ]) {
    const src = read(rel);
    assert.match(src, /strictDeepSeekClientForModel/);
    assert.doesNotMatch(src, /openrouter\.ai/);
    assert.doesNotMatch(src, /OPENROUTER_API_KEY/);
    assert.doesNotMatch(src, /gpt-4o/);
  }
});

test('3H5-BE native-llm strictDeepSeekClientForModel', () => {
  const native = require('../src/services/agent-runner/native-llm');
  assert.equal(typeof native.strictDeepSeekClientForModel, 'function');
  assert.equal(native.resolveNativeDeepSeekModel('gpt-4o'), 'deepseek-v4-flash');
  assert.equal(native.resolveNativeDeepSeekModel('deepseek-v4-pro'), 'deepseek-v4-pro');
  const env = { DEEPSEEK_API_KEY: 'sk-live-abcdef1234567890', DEEPSEEK_BASE_URL: 'https://api.deepseek.com' };
  const routed = native.strictDeepSeekClientForModel('openrouter/gpt-4o', env);
  assert.equal(routed.provider, 'DeepSeek');
  assert.equal(routed.model, 'deepseek-v4-flash');
  assert.equal(native.isOpenRouterClient(routed.client), false);
  assert.equal(native.isNativeDeepSeekClient(routed.client), true);
});

test('3H5-BE design.js DeepSeek-only key check', () => {
  const src = read('src/routes/design.js');
  assert.match(src, /DEEPSEEK_API_KEY not configured/);
  assert.doesNotMatch(src, /OPENROUTER_API_KEY/);
});

test('3H5-BE marco-teorico uses native DeepSeek', () => {
  const src = read('src/routes/marco-teorico.js');
  assert.match(src, /createNativeDeepSeekClient/);
  assert.match(src, /resolveNativeDeepSeekModel/);
  assert.doesNotMatch(src, /new OpenAI\(\{ apiKey: process\.env\.OPENAI_API_KEY \}\)/);
  assert.match(src, /deepseek-v4-flash/);
});

test('3H5-BE attachSseIds ignores Last-Event-ID on POST', () => {
  const { attachSseIds } = require('../src/services/observability/sse-event-id');
  const writes = [];
  const res = {
    write(chunk) { writes.push(String(chunk)); return true; },
  };
  attachSseIds(res, { method: 'POST', headers: { 'last-event-id': '40' } });
  res.write('data: {"type":"start"}\n\n');
  assert.match(writes[0], /^id: 1\n/);
});

test('3H5-BE attachSseIds honors Last-Event-ID on GET', () => {
  const { attachSseIds } = require('../src/services/observability/sse-event-id');
  const writes = [];
  const res = { write(chunk) { writes.push(String(chunk)); return true; } };
  attachSseIds(res, { method: 'GET', headers: { 'last-event-id': '40' } });
  res.write('data: {"ok":true}\n\n');
  assert.match(writes[0], /^id: 41\n/);
});

test('3H5-BE cron create fail-closed + deleteJob scoped', () => {
  const { createCron } = require('../src/services/agent-cron');
  const cron = createCron({ persistPath: `/tmp/siragpt-cron-3h5-${process.pid}.json`, now: () => Date.now() });
  const denied = cron.createJob({ prompt: 'hello', everyMs: 60_000 });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'user_required');
  const created = cron.createJob({ userId: 'alice', prompt: 'hello alice', everyMs: 60_000 });
  assert.equal(created.ok, true);
  const other = cron.deleteJob({ id: created.job.id, userId: 'bob' });
  assert.equal(other.deleted, false);
  const mine = cron.deleteJob({ id: created.job.id, userId: 'alice' });
  assert.equal(mine.deleted, true);
  assert.equal(cron.listJobs({ userId: 'alice' }).length, 0);
});

test('3H5-BE memory deleteUserEpisodes scoped', () => {
  const mem = require('../src/services/memory-search-persist');
  const file = `/tmp/siragpt-mem-3h5-${process.pid}.json`;
  mem.persistEpisode({ userId: 'alice', chatId: 'c1', text: 'secret alice', file });
  mem.persistEpisode({ userId: 'bob', chatId: 'c1', text: 'secret bob', file });
  const out = mem.deleteUserEpisodes({ userId: 'alice', file });
  assert.equal(out.deleted >= 1, true);
  assert.equal(mem.searchUserEpisodes({ userId: 'alice', query: 'secret', file }).length, 0);
  assert.equal(mem.searchUserEpisodes({ userId: 'bob', query: 'secret', file }).length, 1);
  assert.equal(mem.deleteUserEpisodes({ file }).error, 'user_required');
});

test('3H5-BE protocol leftover methods', () => {
  const { METHODS, isKnownMethod } = require('../src/services/agent-gateway/protocol');
  assert.equal(METHODS.SKILLS_PERSIST, 'skills.persist');
  assert.equal(METHODS.MEMORY_PERSIST, 'memory.persist');
  assert.equal(METHODS.MEMORY_DELETE, 'memory.delete');
  assert.equal(METHODS.CRON_DELETE, 'cron.delete');
  assert.equal(isKnownMethod('skills.persist'), true);
  assert.equal(isKnownMethod('cron.delete'), true);
});

test('3H5-BE gateway HTTP leftover routes wired', () => {
  const http = read('src/services/agent-gateway/http.js');
  assert.match(http, /skills\.persist/);
  assert.match(http, /memory\.persist/);
  assert.match(http, /memory\.delete/);
  assert.match(http, /cron\.delete/);
  assert.match(http, /\/api\/gateway\/agent\/wait/);
  assert.match(http, /abortSession\(sessionKey, body\.reason \|\| 'user_abort', actorUserId\(req\)\)/);
  const wrap = read('src/routes/gateway.js');
  assert.match(wrap, /router\.post\('\/skills'/);
  assert.match(wrap, /router\.delete\('\/cron'/);
  assert.match(wrap, /router\.post\('\/agent\/wait'/);
  assert.match(wrap, /persistUserSkill/);
  assert.match(wrap, /deleteUserEpisodes/);
  assert.match(wrap, /deleteJob/);
});

test('3H5-BE abortSession ownership', () => {
  const src = read('src/services/agent-gateway/index.js');
  assert.match(src, /function abortSession\(sessionKey, reason, actorUserId\)/);
  assert.match(src, /if \(owner && !actor\) throw fail\('forbidden'/);
});

test('3H5-BE rate-limit leftover paths', () => {
  const src = read('src/middleware/rate-limit-policy.js');
  assert.match(src, /\/api\/figma/);
  assert.match(src, /\/api\/cowork\/auto-file/);
  assert.match(src, /\/api\/se-agents/);
  assert.match(src, /\/api\/ai\/video-cancel/);
});

test('3H5-BE credit abort hold wired on images+paraphrase', () => {
  const images = read('src/routes/images.js');
  assert.equal((images.match(/attachAbortHoldOnClose/g) || []).length >= 3, true);
  const para = read('src/routes/paraphrase.js');
  assert.match(para, /attachAbortHoldOnClose/);
});

test('3H5-BE PII email mask + image promptLen', () => {
  const email = require('../src/services/email.js');
  assert.equal(typeof email.maskEmail, 'function');
  assert.equal(email.maskEmail('ada@example.com'), 'a***@example.com');
  const src = read('src/services/email.js');
  assert.doesNotMatch(src, /sent to \$\{user\.email\}/);
  const ai = read('src/services/ai-service.js');
  assert.match(ai, /promptLen:/);
  assert.doesNotMatch(ai, /for prompt: "\$\{prompt\}"/);
});

test('3H5-BE health+logger leftover secret/PII keys', () => {
  const health = read('src/services/observability/health-check.js');
  assert.match(health, /OPENAI_API_KEY\|GEMINI_API_KEY\|STRIPE_SECRET/);
  const log = read('src/services/observability/structured-logger.js');
  assert.match(log, /passport\|dob/);
});

test('3H5-BE sandbox idle leftover listFiles/collectOutputs', () => {
  const src = read('src/services/doc-agent/sandbox.js');
  assert.match(src, /listFiles', 'collectOutputs/);
});

test('3H5-BE attribution SSE ids + verify create_chart', () => {
  const attr = read('src/services/attribution-stream-emitter.js');
  assert.match(attr, /attachSseIds/);
  assert.match(attr, /id: \$\{id\}/);
  const verify = read('src/services/agent-runner/verify.js');
  assert.match(verify, /'create_chart'/);
});
