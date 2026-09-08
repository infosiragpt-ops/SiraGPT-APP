'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('3H12-BE-001 cron leftover user required fail-closed', async () => {
  const cron = require('../src/services/cron-as-turn');
  const r = await cron.dispatchCronJobAsAgentTurn({}, { id: 'j1', prompt: 'hello' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'cron_user_required');
  assert.equal(r.code, 'user_required');
});

test('3H12-BE-002 cron leftover timeout helper exported', () => {
  const cron = require('../src/services/cron-as-turn');
  assert.equal(typeof cron.cronTurnTimeoutMs, 'function');
  assert.equal(cron.DEFAULT_CRON_TURN_TIMEOUT_MS, 180000);
  const src = read('src/services/cron-as-turn.js');
  assert.match(src, /Promise\.race/);
  assert.match(src, /SIRAGPT_CRON_TURN_TIMEOUT_MS/);
});

test('3H12-BE-003 cron leftover DLQ on timeout/error', async () => {
  const cron = require('../src/services/cron-as-turn');
  const letters = [];
  const gw = {
    startAgent() { throw Object.assign(new Error('boom'), { code: 'cron_error' }); },
    pushDeadLetter(row) { letters.push(row); },
  };
  const r = await cron.dispatchCronJobAsAgentTurn(gw, { id: 'j2', userId: 'u1', prompt: 'hello' });
  assert.equal(r.ok, false);
  assert.equal(r.deadLettered, true);
  assert.equal(letters.length, 1);
  assert.equal(letters[0].sessionKey.startsWith('cron-run:j2:'), true);
});

test('3H12-BE-004 cron leftover prompt cap', async () => {
  const cron = require('../src/services/cron-as-turn');
  const r = await cron.dispatchCronJobAsAgentTurn({}, {
    id: 'j3', userId: 'u1', prompt: 'x'.repeat(cron.MAX_CRON_PROMPT_CHARS + 1),
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'prompt_too_long');
});

test('3H12-BE-005 skills-registry leftover search', () => {
  const reg = require('../src/services/skills-registry');
  assert.equal(typeof reg.searchSkills, 'function');
  assert.deepEqual(reg.searchSkills(''), []);
  try { reg.registerSkill({ id: 'ola3h12-search-demo', label: 'search demo skill', description: 'find invoices', tags: ['billing'] }); } catch (_) {}
  const hits = reg.searchSkills('invoices');
  assert.equal(hits.some((s) => s.id === 'ola3h12-search-demo'), true);
});

test('3H12-BE-019 skills-registry leftover admin clearance hidden', () => {
  const reg = require('../src/services/skills-registry');
  try {
    reg.registerSkill({ id: 'ola3h12-admin-only', label: 'wipe all', description: 'danger', clearance: 'admin', overwrite: true });
  } catch (_) {}
  const hidden = reg.searchSkills('wipe');
  assert.equal(hidden.some((s) => s.id === 'ola3h12-admin-only'), false);
  const shown = reg.searchSkills('wipe', { clearance: 'admin' });
  assert.equal(shown.some((s) => s.id === 'ola3h12-admin-only'), true);
});

test('3H12-BE-006 skills-persist leftover search never cross-user', () => {
  const persist = require('../src/services/skills-persist');
  assert.equal(typeof persist.searchPersistedSkills, 'function');
  assert.deepEqual(persist.searchPersistedSkills({ query: 'hello' }), []);
  assert.deepEqual(persist.searchPersistedSkills({ userId: '', query: 'hello' }), []);
});

test('3H12-BE-007 memory-search leftover persist fail-closed', () => {
  const mem = require('../src/services/memory-search-persist');
  const r = mem.persistEpisode({ text: 'hello world' });
  assert.equal(r.indexed, 0);
  assert.equal(r.error, 'user_required');
});

test('3H12-BE-008 memory-search leftover term-frequency scoring', () => {
  const src = read('src/services/memory-search-persist.js');
  assert.match(src, /hay\.indexOf\(t, idx\)/);
  assert.equal(src.includes('for (const t of terms) if (hay.includes(t)) score += 1'), false);
});

test('3H12-BE-009 rate-limit leftover generate paths', () => {
  const { isSharedGenerateAgentPath } = require('../src/middleware/rate-limit-policy');
  assert.equal(isSharedGenerateAgentPath('/api/github-codex/run'), true);
  assert.equal(isSharedGenerateAgentPath('/api/github-search/q'), true);
  assert.equal(isSharedGenerateAgentPath('/api/thesis-engine/write'), true);
  assert.equal(isSharedGenerateAgentPath('/api/search-brain-universal/ask'), true);
  assert.equal(isSharedGenerateAgentPath('/api/research-agent/run'), true);
  assert.equal(isSharedGenerateAgentPath('/api/research-library/ask'), true);
  assert.equal(isSharedGenerateAgentPath('/api/cowork-platform/turn'), true);
  assert.equal(isSharedGenerateAgentPath('/api/publishing/generate'), true);
  assert.equal(isSharedGenerateAgentPath('/api/voice-grok/chat'), true);
  assert.equal(isSharedGenerateAgentPath('/api/integrations/run'), true);
  assert.equal(isSharedGenerateAgentPath('/api/hooks/run'), true);
  assert.equal(isSharedGenerateAgentPath('/api/ai/generate'), true);
});

test('3H12-BE-010 rate-limit leftover stop skips', () => {
  const { isStopStreamPath } = require('../src/middleware/rate-limit-policy');
  assert.equal(isStopStreamPath('/api/scheduler/tick/abort'), true);
  assert.equal(isStopStreamPath('/api/attribution/x/abort'), true);
  assert.equal(isStopStreamPath('/api/document-collections/1/stop'), true);
  assert.equal(isStopStreamPath('/api/project-documents/1/abort'), true);
  assert.equal(isStopStreamPath('/api/cowork-ai/stop'), true);
  assert.equal(isStopStreamPath('/api/deployments/1/cancel'), true);
  assert.equal(isStopStreamPath('/api/video/1/abort'), true);
  assert.equal(isStopStreamPath('/api/voice/1/abort'), true);
  assert.equal(isStopStreamPath('/api/github-codex/1/abort'), true);
  assert.equal(isStopStreamPath('/api/research-agent/1/cancel'), true);
  assert.equal(isStopStreamPath('/api/thesis-engine/1/abort'), true);
  assert.equal(isStopStreamPath('/api/publishing/1/stop'), true);
  assert.equal(isStopStreamPath('/api/integrations/1/abort'), true);
  assert.equal(isStopStreamPath('/api/voice-grok/stop'), true);
  assert.equal(isStopStreamPath('/api/search-brain/1/abort'), true);
  assert.equal(isStopStreamPath('/api/agent-batch/1/cancel'), true);
  assert.equal(isStopStreamPath('/api/hooks/1/abort'), true);
  assert.equal(isStopStreamPath('/api/ai/generate'), false);
});

test('3H12-BE-011 PII leftover aadhaar / pkce / bot_token', () => {
  const src = read('src/services/observability/structured-logger.js');
  assert.match(src, /aadhaar/);
  assert.match(src, /pkce/);
  assert.match(src, /bot\[_-]\?token/);
  assert.match(src, /3H12 leftover PII/);
  const { PII_KEY_RE } = require('../src/services/observability/structured-logger');
  assert.equal(PII_KEY_RE.test('aadhaar'), true);
  assert.equal(PII_KEY_RE.test('code_verifier'), true);
  assert.equal(PII_KEY_RE.test('bot_token'), true);
  assert.equal(PII_KEY_RE.test('jwt_secret'), true);
});

test('3H12-BE-012 health secrets leftover aadhaar / smtp / vault', () => {
  const src = read('src/services/observability/health-check.js');
  assert.match(src, /3H12 leftover/);
  assert.match(src, /aadhaar/);
  assert.match(src, /smtp\[_-]\?pass/);
  assert.match(src, /vault\[_-]\?token/);
});

test('3H12-BE-013 log-redaction leftover keys', () => {
  const { isSensitiveKey } = require('../src/utils/log-redaction');
  assert.equal(isSensitiveKey('aadhaar'), true);
  assert.equal(isSensitiveKey('bot_token'), true);
  assert.equal(isSensitiveKey('code_verifier'), true);
  assert.equal(isSensitiveKey('jwt_secret'), true);
  assert.equal(isSensitiveKey('cookie_secret'), true);
  assert.equal(isSensitiveKey('prompt'), false);
});

test('3H12-BE-014 pii-mask leftover aadhaar / nino / passport', () => {
  const mask = require('../src/utils/pii-mask');
  assert.equal(mask.ALL_TYPES.includes('aadhaar'), true);
  assert.equal(mask.ALL_TYPES.includes('nino'), true);
  assert.equal(mask.ALL_TYPES.includes('passport'), true);
  const labeled = mask.mask('passport: A1234567 next');
  assert.match(labeled, /<PASSPORT>/);
  const nino = mask.mask('NI QQ123456C done');
  // QQ is invalid prefix (not in A-CEGHJ-PR-TW-Z wait Q is allowed except BG GB KN NK NT TN ZZ)
  // Use a known-valid NINO: AB123456C
  const nino2 = mask.mask('id AB123456C here');
  assert.match(nino2, /<NINO>/);
});

test('3H12-BE-015 oauth-state leftover missing state fail-closed', async () => {
  const oauth = require('../src/services/oauth-state');
  await assert.rejects(() => oauth.verifyOAuthState('', { provider: 'google' }), (err) => {
    assert.equal(err.code, 'invalid_state');
    assert.equal(err.statusCode, 401);
    assert.equal(err.reason, 'missing_state');
    return true;
  });
  await assert.rejects(() => oauth.verifyOAuthState(null, { provider: 'google' }), (err) => {
    assert.equal(err.reason, 'missing_state');
    return true;
  });
});

test('3H12-BE-016 webhooks leftover inbound HMAC fail-closed', () => {
  const src = read('src/routes/webhooks.js');
  assert.match(src, /router\.post\('\/inbound'/);
  assert.match(src, /webhook_hmac_failed|hmac_invalid/);
  assert.match(src, /verifyInboundWebhook/);
});

test('3H12-BE-017 webhooks leftover delivery idempotency', () => {
  const src = read('src/routes/webhooks.js');
  assert.match(src, /rememberInboundDelivery/);
  assert.match(src, /x-siragpt-delivery-id/);
  assert.match(src, /replay: true/);
});

test('3H12-BE-018 memory route leftover search query cap', () => {
  const src = read('src/routes/memory.js');
  assert.match(src, /slice\(0, 200\)/);
  assert.match(src, /results: \[\]/);
});

test('3H12-BE-020 cron leftover empty prompt still fail-closed', async () => {
  const cron = require('../src/services/cron-as-turn');
  const r = await cron.dispatchCronJobAsAgentTurn({}, { id: 'j4', userId: 'u1', prompt: '   ' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'empty_prompt');
});

test('3H12-BE native-llm still remaps leftover gpt-4o', () => {
  const native = require('../src/services/agent-runner/native-llm');
  assert.equal(native.resolveNativeDeepSeekModel('gpt-4o'), 'deepseek-v4-flash');
  assert.equal(native.FLASH, 'deepseek-v4-flash');
});
