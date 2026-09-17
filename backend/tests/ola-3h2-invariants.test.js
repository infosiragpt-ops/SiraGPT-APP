'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('3H2-BE-001 stripHealthSecrets drops env and api_key', () => {
  const { stripHealthSecrets } = require('../src/services/observability/health-check');
  const out = stripHealthSecrets({ ok: true, env: { DEEPSEEK_API_KEY: 'sk' }, api_key: 'x', details: { token: 't', ping: 1 } });
  assert.equal(out.env, undefined);
  assert.equal(out.api_key, undefined);
  assert.equal(out.details.token, undefined);
  assert.equal(out.details.ping, 1);
});

test('3H2-BE-002/003 shared generate budget key is used for generate paths', () => {
  const { makeJwtAwareKeyGenerator, isSharedGenerateAgentPath, sharedGenerateAgentTaskKey } = require('../src/middleware/rate-limit-policy');
  assert.equal(isSharedGenerateAgentPath('/api/doc/generate'), true);
  assert.equal(isSharedGenerateAgentPath('/api/search/agentic'), true);
  assert.equal(isSharedGenerateAgentPath('/api/cowork/analyze-stream'), true);
  const gen = makeJwtAwareKeyGenerator(null);
  const key = gen({ originalUrl: '/api/ai/generate', ip: '1.2.3.4' });
  assert.equal(key, sharedGenerateAgentTaskKey(null, '1.2.3.4'));
  assert.match(key, /^ip-generate-agent:/);
});

test('3H2-BE-004 attachSseIds prepends id: to data frames', () => {
  const { attachSseIds, parseLastEventId } = require('../src/services/observability/sse-event-id');
  const chunks = [];
  const res = { write(s) { chunks.push(s); return true; } };
  attachSseIds(res, { headers: { 'last-event-id': '2' } });
  res.write('data: {"a":1}\n\n');
  res.write(': ping\n\n');
  assert.match(chunks[0], /^id: 3\ndata:/);
  assert.match(chunks[1], /^: ping/);
  assert.equal(parseLastEventId({ headers: { 'last-event-id': '9' } }), 9);
});

test('3H2-BE-013 EDIT_TOOLS includes leftover Word/PPT tools', () => {
  const { EDIT_TOOLS, needsVerification } = require('../src/services/agent-runner/verify');
  assert.equal(EDIT_TOOLS.has('append_text_slide'), true);
  assert.equal(EDIT_TOOLS.has('create_pptx'), true);
  const n = needsVerification([{ tool: 'append_text_slide', ok: true }]);
  assert.equal(n.needed, true);
});

test('3H2-BE-014 sandbox idle helper exported', () => {
  const sandbox = require('../src/services/doc-agent/sandbox');
  assert.equal(typeof sandbox.attachIdleTimeout, 'function');
  const destroyed = [];
  const fake = { destroy: async () => destroyed.push(1) };
  sandbox.attachIdleTimeout(fake, 5_000);
  assert.ok(fake._idleTimer);
  return fake.destroy().then(() => assert.equal(destroyed.length, 1));
});

test('3H2-BE-015 abortSession fail-closed rejects enqueue', async () => {
  const { createSessionQueue } = require('../src/services/agent-gateway/queue');
  const q = createSessionQueue();
  q.claimWriter('lane', 'run1');
  const out = q.abortSession('lane', 'user_abort');
  assert.equal(out.aborted, true);
  assert.equal(q.isSessionAborted('lane'), true);
  await assert.rejects(() => q.enqueue('lane', async () => 'nope'), /session_aborted/);
  q.claimWriter('lane', 'run2');
  assert.equal(q.isSessionAborted('lane'), false);
  const v = await q.enqueue('lane', async () => 'ok');
  assert.equal(v, 'ok');
});

test('3H2-BE-016/017 gateway abortSession + protocol method', () => {
  const { METHODS } = require('../src/services/agent-gateway/protocol');
  assert.equal(METHODS.AGENT_ABORT, 'agent.abort');
  const { createGateway } = require('../src/services/agent-gateway');
  const g = createGateway({ env: { SIRAGPT_GATEWAY_MODEL: 'deepseek-v4-flash' } });
  const started = g.startAgent({ sessionKey: 'k1', surface: 'chat', userId: 'u1', message: 'hi' });
  const aborted = g.abortSession('k1', 'stop');
  assert.equal(aborted.aborted, true);
  assert.equal(aborted.sessionKey, 'k1');
  assert.ok(started.runId);
});

test('3H2-BE-018 memory search leftover is user-scoped', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const mem = require('../src/services/memory-search-persist');
  const file = path.join(os.tmpdir(), `mem-3h2-${Date.now()}.json`);
  mem.persistEpisode({ userId: 'alice', text: 'contrato de alquiler 2026', file });
  mem.persistEpisode({ userId: 'bob', text: 'contrato de alquiler 2026', file });
  const hits = mem.searchUserEpisodes({ userId: 'alice', query: 'alquiler', file });
  assert.ok(hits.length >= 1);
  assert.ok(hits.every((h) => h.userId === 'alice'));
  try { fs.unlinkSync(file); } catch {}
});

test('3H2-BE-019 skills leftover delete + path escape', () => {
  const os = require('os');
  const path = require('path');
  const skills = require('../src/services/skills-persist');
  const root = path.join(os.tmpdir(), `skills-3h2-${Date.now()}`);
  skills.persistUserSkill({ userId: 'u1', name: 'resumir', body: 'resume', root });
  const listed = skills.listPersistedSkills({ userId: 'u1', root });
  assert.equal(listed.some((s) => s.name === 'resumir'), true);
  const del = skills.deletePersistedSkill({ userId: 'u1', name: 'resumir', root });
  assert.equal(del.ok, true);
  assert.throws(() => skills.assertSkillName('../etc'));
});

test('3H2-BE-020 cron leftover overlap + model lock', () => {
  const cron = require('../src/services/cron-as-turn');
  assert.equal(cron.assertCronModel('deepseek-v4-pro'), 'deepseek-v4-pro');
  assert.throws(() => cron.assertCronModel('openrouter/foo'));
  const args = cron.cronJobToAgentArgs({ id: 'j', prompt: 'x', surface: 'code' }, 1);
  assert.equal(args.model, 'deepseek-v4-flash');
  assert.equal(args.allowCronTools, false);
});

test('3H2-BE-021 event log leftover stamps seq and ttl-prunes', () => {
  const { createEventLog } = require('../src/services/agent-gateway/event-log');
  const log = createEventLog({ max: 3, ttlMs: 60_000 });
  log.remember('s', { event: 'a' });
  log.remember('s', { event: 'b' });
  log.remember('s', { event: 'c' });
  log.remember('s', { event: 'd' });
  assert.equal(log.size('s'), 3);
  const replay = log.replayFrom('s', 0);
  assert.equal(replay[0].seq > 0, true);
});

test('3H2-BE-022 remaining oauth codes', () => {
  const { extractProviderOAuthErrorCode } = require('../src/services/ProviderOAuthService');
  assert.equal(extractProviderOAuthErrorCode({ error: 'user_denied' }), 'user_denied');
  assert.equal(extractProviderOAuthErrorCode({ error: 'consent_required' }), 'consent_required');
  assert.equal(extractProviderOAuthErrorCode({ error: 'nope' }), 'auth_failed');
});

test('3H2-BE-023 logger leftover PII keys', () => {
  const { redactPiiFields } = require('../src/services/observability/structured-logger');
  const out = redactPiiFields({ prompt: 'secret', completion: 'x', mailto: 'a@b.c', ping: 1 });
  assert.equal(out.prompt, '[REDACTED]');
  assert.equal(out.completion, '[REDACTED]');
  assert.equal(out.mailto, '[REDACTED]');
  assert.equal(out.ping, 1);
});

test('3H2-BE-026 agent route no longer requires OPENAI_API_KEY', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../src/routes/agent.js'), 'utf8');
  assert.match(src, /DEEPSEEK_API_KEY/);
  assert.doesNotMatch(src, /if \(!process\.env\.OPENAI_API_KEY\)/);
});
