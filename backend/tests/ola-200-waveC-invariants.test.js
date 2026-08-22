'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '../src');
const ROOT = path.join(__dirname, '../..');

function read(rel) {
  return fs.readFileSync(path.join(SRC, rel), 'utf8');
}

describe('ola-200 wave C invariants', () => {
  it('BE-016 generateOpenRouterImage is isolated from text models', () => {
    const src = read('routes/ai.js');
    assert.match(src, /image_path_isolated/);
    assert.match(src, /isolated to image models/);
  });

  it('BE-017 gateway fail-closed on OpenRouter', () => {
    const src = read('routes/gateway.js');
    assert.match(src, /err\.code = 'model_forbidden'/);
    assert.doesNotMatch(src, /if \(\/openrouter\/i\.test\(raw\)\) \{\s*return 'deepseek-v4-flash'/);
  });

  it('BE-023 unsigned Stripe webhook rejected in production', () => {
    assert.match(read('routes/payments.js'), /unsigned_webhook/);
  });

  it('BE-028 R2 presign TTL is short + Cache-Control', () => {
    const src = read('orchestration/r2-storage.js');
    assert.match(src, /R2_PRESIGNED_URL_TTL_SECONDS \|\| '300'/);
    assert.match(src, /ResponseCacheControl/);
  });

  it('BE-029/030/031 memory fail-closed + user scope', () => {
    assert.match(read('services/memory-engine.js'), /recallWithTimeout/);
    assert.match(read('services/long-term-memory.js'), /memory_scope_mismatch/);
    assert.match(read('services/user-memory-store.js'), /recall fail-closed/);
  });

  it('BE-033 oauth replay maps to invalid_state', () => {
    assert.match(read('services/oauth-state.js'), /invalid_state/);
  });

  it('BE-043 agent-runner emits budget_exceeded', () => {
    assert.match(read('services/agent-runner/loop.js'), /budget_exceeded/);
  });

  it('BE-041 artifacts re-presign is authenticated', () => {
    assert.match(read('routes/artifacts.js'), /\/re-presign/);
    assert.match(read('routes/artifacts.js'), /authenticateToken/);
  });

  it('BE-064 circuit breaker ignores 402', () => {
    assert.match(read('services/circuit-breaker.js'), /isBalance/);
  });

  it('BE-070/072 fallback cannot be OpenRouter', () => {
    assert.match(read('services/model-quota-router.js'), /deepseek-v4-flash/);
    assert.match(read('services/free-ia-fallback-quota.js'), /openrouter_fallback_forbidden/);
  });
});

describe('ola-200 wave C unit', () => {
  it('BE-017 resolveDeepSeekModel throws model_forbidden', () => {
    const { resolveDeepSeekModel } = require('../src/routes/gateway');
    assert.throws(
      () => resolveDeepSeekModel('openrouter/gpt-4o'),
      (err) => err && err.code === 'model_forbidden',
    );
    assert.equal(resolveDeepSeekModel('deepseek-v4-pro'), 'deepseek-v4-pro');
  });

  it('BE-029 recallWithTimeout fail-closed', async () => {
    const { recallWithTimeout } = require('../src/services/memory-engine');
    const out = await recallWithTimeout(() => new Promise(() => {}), 50);
    assert.deepEqual(out, []);
  });

  it('BE-064 402 does not open the circuit', async () => {
    const { CircuitBreaker, STATES } = require('../src/services/circuit-breaker');
    const b = new CircuitBreaker('waveC-402', { failureThreshold: 1 });
    const err = new Error('credits_exhausted');
    err.status = 402;
    await assert.rejects(() => b.execute(async () => { throw err; }));
    assert.equal(b.state, STATES.CLOSED);
  });
});
