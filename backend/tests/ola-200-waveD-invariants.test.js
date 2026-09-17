
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '../src');

function read(rel) {
  return fs.readFileSync(path.join(SRC, rel), 'utf8');
}

describe('ola-200 wave D invariants', () => {
  it('BE-021/022 chat-run queue is honest when worker is down', () => {
    assert.match(read('services/chat-run-queue.js'), /chat_run_worker_unavailable/);
    assert.match(read('services/chat-run-worker.js'), /isChatRunWorkerHealthy/);
    assert.match(read('services/chat-run-worker.js'), /noteChatRunHeartbeat/);
    assert.match(read('services/chat-run-worker.js'), /chat_run_worker_not_implemented/);
  });

  it('BE-026 sandbox destroy attaches to AbortSignal', () => {
    assert.match(read('services/doc-agent/sandbox.js'), /attachDestroyOnAbort/);
    assert.match(read('services/doc-agent/sandbox.js'), /docker', \['rm', '-f'/);
  });

  it('BE-027 runsc health never fakes healthy', () => {
    const src = read('services/observability/health-check.js');
    assert.match(src, /runsc_registered/);
    assert.match(src, /Never claim healthy/);
  });

  it('BE-039/040 upload sniff fail-closed', () => {
    assert.match(read('routes/files.js'), /sniff_failed/);
    assert.match(read('services/upload-security-policy.js'), /sniff_failed/);
  });

  it('BE-044 file tools resolveInWorkspace', () => {
    assert.match(read('services/agent-runner/tools.js'), /sandboxFilePath/);
    assert.match(read('services/agent-runner/tools.js'), /resolveInWorkspace/);
  });

  it('BE-065 production rate limiter forbids memory store', () => {
    assert.match(read('services/rate-limiter.js'), /memory store prohibited/);
    assert.match(read('services/rate-limiter.js'), /assertProductionRedisStore/);
  });

  it('BE-100 abort before first token does not capture', () => {
    assert.match(read('services/credit-ledger.js'), /shouldCaptureGenerateHold/);
    assert.match(read('services/credit-ledger.js'), /aborted_before_first_token/);
  });

  it('BE-035 SSO logs redact client_secret', () => {
    assert.match(read('services/SsoCallbackService.js'), /redactSsoLog/);
    assert.match(read('services/SsoCallbackService.js'), /client_secret=\[REDACTED\]/);
  });

  // BE-056 (agent model contract) moved to agent-model-contract.test.js —
  // the DeepSeek-locked assertion encoded the pre-#308 decision; see that
  // file for the reconciled contract.

  it('BE-074 skills executor has timeout and no host shell', () => {
    const src = read('services/skills-executor.js');
    assert.match(src, /SKILL_TIMEOUT_MS/);
    assert.match(src, /skill_timeout/);
    assert.match(src, /HOST_SHELL_FORBIDDEN/);
  });

  it('BE-091 webauthn rejects localhost in production', () => {
    assert.match(read('services/webauthn/webauthn-config.js'), /localhost\|127/);
  });

  it('gateway events carry id + memory search fail-closed', () => {
    assert.match(read('services/agent-gateway/protocol.js'), /id: n/);
    assert.match(read('services/agent-gateway/http.js'), /id: \$\{eventId\}/);
    assert.match(read('services/agent-gateway/index.js'), /memory_search_failed/);
  });
});

describe('ola-200 wave D unit', () => {
  it('BE-100 shouldCaptureGenerateHold', () => {
    const { shouldCaptureGenerateHold } = require('../src/services/credit-ledger');
    assert.equal(shouldCaptureGenerateHold({ firstTokenEmitted: false, aborted: true }), false);
    assert.equal(shouldCaptureGenerateHold({ firstTokenEmitted: true, aborted: true }), true);
    assert.equal(shouldCaptureGenerateHold({ firstTokenEmitted: true, aborted: false }), true);
    assert.equal(shouldCaptureGenerateHold({ firstTokenEmitted: false, aborted: false }), false);
  });

  it('BE-065 assertProductionRedisStore', () => {
    const { assertProductionRedisStore } = require('../src/services/rate-limiter');
    assert.deepEqual(assertProductionRedisStore({ NODE_ENV: 'test' }), { ok: true, store: 'memory' });
    assert.throws(
      () => assertProductionRedisStore({ NODE_ENV: 'production', RATE_LIMIT_STORE: 'memory', REDIS_URL: 'redis://x' }),
      /memory store prohibited/,
    );
    const ok = assertProductionRedisStore({ NODE_ENV: 'production', RATE_LIMIT_STORE: 'redis', REDIS_URL: 'redis://x' });
    assert.equal(ok.store, 'redis');
  });

  it('BE-022 worker starts unhealthy', () => {
    const { isChatRunWorkerHealthy } = require('../src/services/chat-run-worker');
    assert.equal(isChatRunWorkerHealthy(), false);
  });

  it('BE-044 sandboxFilePath rejects escape', () => {
    const { sandboxFilePath } = require('../src/services/agent-runner/tools');
    assert.throws(() => sandboxFilePath('../etc/passwd'));
    assert.equal(sandboxFilePath('outputs/deck.pptx'), 'outputs/deck.pptx');
  });

  it('BE-027 checkGvisorRuntime does not fake', () => {
    const { checkGvisorRuntime } = require('../src/services/observability/health-check');
    const r = checkGvisorRuntime({ SIRAGPT_SANDBOX_RUNTIME: 'runsc', SIRAGPT_SANDBOX_REQUIRE_GVISOR: '0' });
    assert.equal(r.name, 'gvisor_runsc');
    if (!r.details.runsc_present) assert.notEqual(r.status, 'healthy');
  });
});
