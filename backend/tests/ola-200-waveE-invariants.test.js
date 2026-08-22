
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');

const SRC = path.join(__dirname, '../src');

function read(rel) {
  return fs.readFileSync(path.join(SRC, rel), 'utf8');
}

describe('ola-200 wave E invariants', () => {
  it('BE-049 doc.js does not reopen pipeline on no_llm', () => {
    const src = read('routes/doc.js');
    assert.match(src, /no_llm/);
    assert.doesNotMatch(src, /Recarga OpenRouter/);
  });

  // BE-050 (generate-document model contract) moved to agent-model-contract.test.js —
  // the DeepSeek-locked assertion encoded the pre-#308 decision; see that
  // file for the reconciled contract.

  it('BE-068 dummy DeepSeek key is fail-closed in prod', () => {
    const src = read('services/observability/health-check.js');
    assert.match(src, /isDummyDeepSeekKey/);
    assert.match(src, /failClosed/);
  });

  it('BE-069 R2 init fail is critical in prod readiness', () => {
    const src = read('services/observability/health-check.js');
    assert.match(src, /r2_init_failed/);
    assert.match(src, /checks\.push\(checkR2Storage\(env\)\)/);
  });

  it('BE-090 HMAC compare is constant-time', () => {
    const src = read('services/auth/hmac-webhook.js');
    assert.match(src, /constantTimeEqual/);
    assert.match(src, /timingSafeEqual/);
    assert.match(src, /siragpt-hmac-ct/);
  });

  it('BE-045 lastArtifactId persist helper exists', () => {
    const src = read('services/agent-runner/artifacts.js');
    assert.match(src, /persistLastArtifactId/);
    assert.match(src, /sira:chat:lastArtifactId/);
  });

  // BE-057 (agent-batch model contract) moved to agent-model-contract.test.js —
  // the DeepSeek-locked assertion encoded the pre-#308 decision; see that
  // file for the reconciled contract.

  it('BE-058 agent-runs cancel AbortSignal', () => {
    const src = read('routes/agent-runs.js');
    assert.match(src, /cancelRun/);
    assert.match(src, /registerRunAbort/);
    assert.match(src, /\/:traceId\/cancel/);
  });

  it('BE-075 MCP OAuth is user-level', () => {
    const src = read('services/agent-runner/mcp/index.js');
    assert.match(src, /assertUserLevelOAuth/);
    assert.match(src, /mcp_oauth_service_account_forbidden/);
  });

  it('BE-036 TokenVault never returns ciphertext', () => {
    const src = read('services/TokenVault.js');
    assert.match(src, /ciphertext: undefined/);
    assert.match(src, /failed to decrypt stored tokens/);
  });

  it('unit: dummy key detector', () => {
    const { isDummyDeepSeekKey } = require('../src/services/observability/health-check');
    assert.equal(isDummyDeepSeekKey(''), true);
    assert.equal(isDummyDeepSeekKey('dummy'), true);
    assert.equal(isDummyDeepSeekKey('sk-placeholder-key'), true);
    assert.equal(isDummyDeepSeekKey('sk-' + 'a'.repeat(40)), false);
  });

  it('unit: HMAC constant-time equal', () => {
    const { safeEqualHex, constantTimeEqual } = require('../src/services/auth/hmac-webhook');
    assert.equal(safeEqualHex('abc', 'abc'), true);
    assert.equal(safeEqualHex('abc', 'abd'), false);
    assert.equal(constantTimeEqual('short', 'longer-value'), false);
  });

  it('unit: MCP user-level oauth', () => {
    const { assertUserLevelOAuth } = require('../src/services/agent-runner/mcp');
    assert.throws(() => assertUserLevelOAuth({}), /mcp_oauth_user_required/);
    assert.throws(
      () => assertUserLevelOAuth({ userId: 'u1', server: { authMode: 'service_account' } }),
      /mcp_oauth_service_account_forbidden/,
    );
    assert.equal(assertUserLevelOAuth({ userId: 'u1', server: { userId: 'u1' } }), 'u1');
  });
});
