'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('3H3-BE-001 createSSEWriter stamps id', () => {
  const src = read('src/utils/sse-writer.js');
  assert.match(src, /nextSseId|parseLastEventId/);
  assert.match(src, /formatEvent\(payload, nextSseId\(\)\)/);
});

test('3H3 remaining SSE routes attachSseIds', () => {
  for (const rel of [
    'src/routes/doc-agent.js',
    'src/routes/answer.js',
    'src/routes/math.js',
    'src/routes/research.js',
    'src/routes/research-agent.js',
    'src/routes/agent-batch.js',
    'src/routes/plan.js',
    'src/routes/apps-ai.js',
    'src/routes/goals.js',
    'src/routes/design.js',
    'src/routes/artifact.js',
    'src/routes/voice-grok.js',
  ]) {
    const src = read(rel);
    assert.match(src, /attachSseIds\(res, req\)/, rel);
  }
});

test('3H3-BE-007 turn-events stamps id', () => {
  const src = read('src/services/sira/turn-events.js');
  assert.match(src, /id: \$\{sseSeq\}/);
});

test('3H3-BE-008/009 rate-limit leftovers', () => {
  const src = read('src/middleware/rate-limit-policy.js');
  assert.match(src, /\/api\/doc-agent/);
  assert.match(src, /\/api\/research/);
  assert.match(src, /function isStopStreamPath/);
  const idx = read('index.js');
  assert.match(idx, /isStopStreamPath/);
});

test('3H3-BE-010 ai.js no longer logs raw prompt on leftover generate paths', () => {
  const src = read('src/routes/ai.js');
  assert.doesNotMatch(src, /PPT generation request:', \{ prompt,/);
  assert.doesNotMatch(src, /Gmail AI request:', \{ prompt,/);
  assert.match(src, /promptLen:/);
});

test('3H3-BE-011 auth impersonation no email', () => {
  const src = read('src/routes/auth.js');
  assert.doesNotMatch(src, /returning to super admin \$\{superAdmin\.email\}/);
  assert.match(src, /superAdmin\.id/);
});

test('3H3-BE-012/013 OAuth leftover maps', () => {
  const gh = read('src/routes/github.js');
  assert.match(gh, /consent_required/);
  assert.match(gh, /oauth_provider_unavailable/);
  const gm = read('src/routes/gmail.js');
  assert.match(gm, /consent_required/);
  assert.match(gm, /insufficient_scope/);
});

test('3H3-BE-014/015 queue honesty', () => {
  const q = read('src/services/agent-gateway/queue.js');
  assert.match(q, /function snapshot/);
  assert.match(q, /aborted: sessionAborted\.size/);
  const gw = read('src/services/agent-gateway/index.js');
  assert.match(gw, /queueHonesty/);
});

test('3H3-BE-016 sandbox idle reset + hard max', () => {
  const src = read('src/services/doc-agent/sandbox.js');
  assert.match(src, /bumpIdle/);
  assert.match(src, /SIRAGPT_DOC_SANDBOX_MAX_MS/);
  assert.match(src, /_hardTimer/);
});

test('3H3-BE-017 memory max items', () => {
  const src = read('src/services/memory-search-persist.js');
  assert.match(src, /MAX_ITEMS_PER_USER/);
});

test('3H3-BE-018 skills refuse empty userId', () => {
  const src = read('src/services/skills-persist.js');
  assert.match(src, /userId es obligatorio|user_required/);
});

test('3H3-BE-019 health strips secret-shaped strings', () => {
  const { stripHealthSecrets } = require('../src/services/observability/health-check');
  const out = stripHealthSecrets({ ok: true, note: 'Bearer abcdefghijklmnop', DEEPSEEK_API_KEY: 'x' });
  assert.equal(out.DEEPSEEK_API_KEY, '[REDACTED]');
  assert.equal(out.note, '[REDACTED]');
});

test('3H3-BE-020 computer-use remaining audit', () => {
  const src = read('src/routes/computer-use.js');
  assert.match(src, /action: 'chat-integration'/);
  assert.match(src, /action: 'acknowledge-safety'/);
  assert.match(src, /action: 'generate-html'/);
});

test('3H3-BE-021 verify leftover tools', () => {
  const { EDIT_TOOLS } = require('../src/services/agent-runner/verify');
  assert.equal(EDIT_TOOLS.has('delete_slide'), true);
  assert.equal(EDIT_TOOLS.has('patch_file'), true);
  assert.equal(EDIT_TOOLS.has('set_cell'), true);
});

test('3H3-BE-022 logger leftover keys', () => {
  const src = read('src/services/observability/structured-logger.js');
  assert.match(src, /id_token/);
  assert.match(src, /client_secret/);
});

test('3H3-BE-024 abort-hold on close', () => {
  const cc = require('../src/middleware/charge-credits');
  assert.equal(typeof cc.attachAbortHoldOnClose, 'function');
  assert.equal(typeof cc.completeGenerateHold, 'function');
});

test('3H3 no OpenRouter generate lock regression', () => {
  const gw = read('src/services/agent-gateway/index.js');
  assert.match(gw, /openrouter/i);
  assert.match(gw, /model_forbidden/);
});
