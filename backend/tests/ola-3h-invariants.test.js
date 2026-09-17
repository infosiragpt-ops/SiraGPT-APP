'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('3H-BE-001 sse-event-id writes id: N', () => {
  const { createSseEventCounter, parseLastEventId, formatSseFrame } = require('../src/services/observability/sse-event-id');
  const chunks = [];
  const res = { writableEnded: false, write: (s) => chunks.push(s) };
  const c = createSseEventCounter(parseLastEventId({ headers: { 'last-event-id': '4' } }));
  c.write(res, { type: 'hello' });
  assert.match(chunks.join(''), /id: 5/);
  assert.match(formatSseFrame({ id: 3, data: { a: 1 } }), /id: 3/);
});

test('3H-BE-004 shouldCaptureGenerateHold abort before token', () => {
  const { shouldCaptureGenerateHold } = require('../src/services/credit-ledger');
  assert.equal(shouldCaptureGenerateHold({ firstTokenEmitted: false, aborted: true }), false);
  assert.equal(shouldCaptureGenerateHold({ firstTokenEmitted: true, aborted: false }), true);
  assert.equal(shouldCaptureGenerateHold({ firstTokenEmitted: false, aborted: false }), false);
});

test('3H-BE-005 isDocSandboxContainerName', () => {
  const { isDocSandboxContainerName } = require('../src/services/doc-agent/sandbox');
  assert.equal(isDocSandboxContainerName('sira-doc-abc-1234'), true);
  assert.equal(isDocSandboxContainerName('sira-dpc-cms-ceo-office'), false);
});

test('3H-BE-006 mapSpotifyOAuthError', () => {
  const { mapSpotifyOAuthError } = require('../src/routes/spotify');
  assert.equal(mapSpotifyOAuthError('access_denied').code, 'access_denied');
  assert.equal(mapSpotifyOAuthError('invalid_grant').code, 'reconnect_required');
});

test('3H-BE-008 summarizeQueueDeadLetters', () => {
  const { summarizeQueueDeadLetters } = require('../src/services/observability/health-check');
  const s = summarizeQueueDeadLetters({ queues: [{ name: 'a', deadLetter: 3 }, { name: 'b', jobs: { failed: 2 } }] });
  assert.equal(s.deadLetterTotal, 5);
});

test('3H-BE-009 event log replay', () => {
  const { createEventLog } = require('../src/services/agent-gateway/event-log');
  const log = createEventLog();
  log.remember('s1', { seq: 1, event: 'a' });
  log.remember('s1', { seq: 2, event: 'b' });
  assert.equal(log.replayFrom('s1', 1).length, 1);
  assert.equal(log.replayFrom('s1', 1)[0].seq, 2);
});

test('3H-BE-010 session DLQ', () => {
  const { createSessionDlq } = require('../src/services/agent-gateway/session-dlq');
  const dlq = createSessionDlq();
  dlq.push({ sessionKey: 'k', runId: 'r', error: 'boom' });
  assert.equal(dlq.snapshot().deadLetterCount, 1);
});

test('3H-BE-011 claimWriter aborts previous', () => {
  const { createSessionQueue } = require('../src/services/agent-gateway/queue');
  const q = createSessionQueue();
  q.claimWriter('lane', 'run1');
  q.claimWriter('lane', 'run2');
  assert.equal(q.isAborted('lane', 'run1'), true);
  assert.equal(q.isAborted('lane', 'run2'), false);
  assert.equal(q.canCommit('lane', 'run2'), true);
});

test('3H-BE-012/013 persist helpers reject bad names', () => {
  const skills = require('../src/services/skills-persist');
  assert.throws(() => skills.assertSkillName('../etc'));
  const mem = require('../src/services/memory-search-persist');
  assert.equal(mem.persistEpisode({ userId: '', text: 'x' }).indexed, 0);
});

test('3H-BE-014 cron as agent turn', () => {
  const { cronJobToAgentArgs } = require('../src/services/cron-as-turn');
  const args = cronJobToAgentArgs({ id: 'j1', prompt: 'hello', surface: 'chat', userId: 'u' }, 1);
  assert.equal(args.model, 'deepseek-v4-flash');
  assert.equal(args.allowCronTools, false);
  assert.match(args.sessionKey, /^cron-run:/);
  assert.doesNotMatch(JSON.stringify(args), /openrouter/i);
});

test('3H-BE-015 redactPiiFields', () => {
  const { redactPiiFields } = require('../src/services/observability/structured-logger');
  const out = redactPiiFields({ email: 'a@b.c', prompt: 'secret hi', ok: 1 });
  assert.equal(out.email, '[REDACTED]');
  assert.equal(out.prompt, '[REDACTED]');
  assert.equal(out.ok, 1);
});

test('3H-BE-018 escapeToolText', () => {
  const { escapeToolText, assertNoRawScript } = require('../src/services/agent-runner/tools');
  assert.match(escapeToolText('<script>x</script>'), /&lt;script/);
  assert.equal(assertNoRawScript('<script>x</script>'), false);
});

test('3H-BE-020 stripHealthSecrets', () => {
  const { stripHealthSecrets } = require('../src/services/observability/health-check');
  const out = stripHealthSecrets({ env: { DEEPSEEK_API_KEY: 'sk-x' }, details: { api_key: 'nope', dummy: false } });
  assert.equal(out.env, undefined);
  assert.equal(out.details.api_key, undefined);
  assert.equal(out.details.dummy, false);
});

test('3H-BE-021 fetch header redact', () => {
  const { shouldRedactFetchHeader } = require('../src/utils/fetch-instrument');
  assert.equal(shouldRedactFetchHeader('Authorization'), true);
  assert.equal(shouldRedactFetchHeader('x-api-key'), true);
  assert.equal(shouldRedactFetchHeader('accept'), false);
});

test('3H-BE-022 rejectPromptText', () => {
  const { rejectPromptText } = require('../src/routes/telemetry');
  const out = rejectPromptText({ prompt: 'hi', message: 'err', extra: { email: 'a@b.c' } });
  assert.equal(out.prompt, undefined);
  assert.equal(out.message, 'err');
  assert.equal(out.extra.email, undefined);
});

test('3H no OpenRouter leftovers in new helpers', () => {
  const fs = require('fs');
  const files = [
    'src/services/observability/sse-event-id.js',
    'src/services/agent-gateway/event-log.js',
    'src/services/cron-as-turn.js',
    'src/services/skills-persist.js',
  ];
  for (const f of files) {
    const t = fs.readFileSync(require('path').join(__dirname, '..', f), 'utf8');
    assert.doesNotMatch(t, /openrouter\.ai/i);
  }
});
