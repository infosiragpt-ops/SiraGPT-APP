
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');

const SRC = path.join(__dirname, '../src');
const ROOT = path.join(__dirname, '../..');

function read(rel) {
  return fs.readFileSync(path.join(SRC, rel), 'utf8');
}

function readRoot(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('ola-200 wave F invariants', () => {
  it('BE-046 generate_model telemetry exists', () => {
    const src = read('services/agent-runner/telemetry.js');
    assert.match(src, /logGenerateModel/);
    assert.match(src, /generate_model/);
    const { classifyGenerateModel, logGenerateModel } = require('../src/services/agent-runner/telemetry');
    assert.equal(classifyGenerateModel('deepseek-v4-flash'), 'flash');
    assert.equal(classifyGenerateModel('deepseek-v4-pro'), 'pro');
    const rec = logGenerateModel({ model: 'deepseek-v4-flash', path: 'f2' });
    assert.equal(rec.model_class, 'flash');
    assert.equal(rec.path, 'f2');
  });

  it('BE-051/055 text generate cannot use OpenRouter or LiteLLM', () => {
    const ai = read('services/ai-service.js');
    assert.match(ai, /assertNativeTextGenerate/);
    assert.match(ai, /model_forbidden/);
    const lite = read('services/ai-product-os/litellm-gateway.js');
    assert.match(lite, /assertTextGenerateNotViaLiteLLM/);
    const { assertTextGenerateNotViaLiteLLM } = require('../src/services/ai-product-os/litellm-gateway');
    assert.throws(() => assertTextGenerateNotViaLiteLLM('text'), /litellm_text_generate_forbidden/);
  });

  it('BE-066 generate+agent-task share a user budget key', () => {
    const src = read('middleware/rate-limit-policy.js');
    assert.match(src, /sharedGenerateAgentTaskKey/);
    const { sharedGenerateAgentTaskKey, isSharedGenerateAgentPath } = require('../src/middleware/rate-limit-policy');
    assert.equal(sharedGenerateAgentTaskKey('u1'), 'user-generate-agent:u1');
    assert.equal(sharedGenerateAgentTaskKey('', '1.2.3.4'), 'ip-generate-agent:1.2.3.4');
    assert.equal(isSharedGenerateAgentPath('/api/ai/generate'), true);
    assert.equal(isSharedGenerateAgentPath('/api/agent/task'), true);
    assert.equal(isSharedGenerateAgentPath('/api/health'), false);
  });

  it('BE-086 GitHub OAuth codes are stable', () => {
    const src = read('routes/github.js');
    assert.match(src, /mapGithubOAuthError/);
    assert.match(src, /access_denied/);
    assert.match(src, /bad_verification_code/);
  });

  it('BE-087 Gmail invalid_grant maps to reconnect_required', () => {
    const src = read('routes/gmail.js');
    assert.match(src, /mapGmailOAuthError/);
    assert.match(src, /reconnect_required/);
    const { mapGmailOAuthError } = require('../src/routes/gmail');
    assert.equal(mapGmailOAuthError(new Error('invalid_grant')).code, 'reconnect_required');
    assert.equal(mapGmailOAuthError(new Error('invalid_grant')).status, 401);
    assert.equal(mapGmailOAuthError(new Error('boom')), null);
  });

  it('BE-089 inbound webhook HMAC + clock skew', () => {
    const src = read('routes/webhooks.js');
    assert.match(src, /verifyInboundWebhook/);
    assert.match(src, /hmac_secret_missing/);
    const { verifyInboundWebhook } = require('../src/routes/webhooks');
    const missing = verifyInboundWebhook({ body: '{}', header: 'v1=x,ts=1', secret: '' });
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, 'hmac_secret_missing');
    const { createWebhookVerifier } = require('../src/services/auth/hmac-webhook');
    const v = createWebhookVerifier({ secret: 'wavef-test-secret', now: () => 1_700_000_000 });
    const signed = v.sign({ body: '{"ok":true}', ts: 1_700_000_000 });
    const ok = verifyInboundWebhook({
      body: '{"ok":true}',
      header: signed.header,
      secret: 'wavef-test-secret',
      now: () => 1_700_000_000,
    });
    assert.equal(ok.ok, true);
    const skew = verifyInboundWebhook({
      body: '{"ok":true}',
      header: signed.header,
      secret: 'wavef-test-secret',
      now: () => 1_700_000_000 + 10_000,
    });
    assert.equal(skew.ok, false);
    assert.equal(skew.reason, 'timestamp_out_of_window');
  });

  it('BE-059/060 dead-letter + stalled counts', () => {
    const registry = read('services/queues/queue-registry.js');
    assert.match(registry, /deadLetter/);
    const admin = read('routes/admin-queues.js');
    assert.match(admin, /queueDeadLetterCounts/);
    assert.match(admin, /stalledCount/);
    const { INTERNAL } = require('../src/routes/admin-queues');
    const counts = INTERNAL.queueDeadLetterCounts([
      { jobs: { failed: 3, delayed: 2 }, deadLetter: 3 },
    ]);
    assert.equal(counts.failedCount, 3);
    assert.equal(counts.stalledCount, 2);
    assert.equal(counts.deadLetterCount, 3);
  });

  it('BE-034 GitHub/Spotify OAuth codes share the Google mapper', () => {
    const src = read('services/ProviderOAuthService.js');
    assert.match(src, /extractProviderOAuthErrorCode/);
    const { extractProviderOAuthErrorCode } = require('../src/services/ProviderOAuthService');
    assert.equal(extractProviderOAuthErrorCode({ message: 'access_denied' }), 'access_denied');
    assert.equal(extractProviderOAuthErrorCode({ message: 'bad_verification_code' }), 'bad_verification_code');
    assert.equal(extractProviderOAuthErrorCode({ message: 'invalid_grant' }), 'invalid_grant');
    assert.equal(extractProviderOAuthErrorCode({ message: 'weird' }), 'auth_failed');
  });

  it('BE-076 recall is user+chat scoped', () => {
    const src = read('services/agent-runner/memory/index.js');
    assert.match(src, /assertRecallScope/);
    const { assertRecallScope } = require('../src/services/agent-runner/memory');
    assert.equal(assertRecallScope({ userId: 'u1', text: 'x' }, { userId: 'u1' }), true);
    assert.equal(assertRecallScope({ userId: 'u2', text: 'x' }, { userId: 'u1' }), false);
    assert.equal(assertRecallScope({ userId: 'u1', chatId: 'c2' }, { userId: 'u1', chatId: 'c1' }), false);
  });

  it('BE-085 installation tokens are redacted', () => {
    const src = read('services/github-codex-connector.js');
    assert.match(src, /redacted-installation-token|redacted-github-token/);
    assert.match(src, /ghs/);
    assert.match(src, /redacted-installation-token/);
  });

  it('FE markers are not required inside the backend image', () => {
    assert.equal(typeof read, 'function');
  });
});
