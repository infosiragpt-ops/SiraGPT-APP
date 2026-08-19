'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { initAgentSystem } = require('../src/services/agents/agent-system');

/**
 * _agentPool.info() derived `active` from a non-existent `stats().availableSlots`
 * field, so it always reported the pool as fully saturated
 * (active === maxConcurrent) regardless of real load. The fix reads the real
 * `stats().active`. We assert info() and stats() agree, and that a lightly
 * loaded pool is not reported as saturated.
 */

test('agentPool.info().active reflects the real active slot count', async () => {
  const svc = initAgentSystem();
  assert.ok(svc.agentPool, 'agentPool should be initialised');

  const release = await svc.agentPool.acquire();
  try {
    const info = svc.agentPool.info();
    const stats = svc.agentPool.stats();

    assert.equal(info.active, stats.active, 'info().active must equal stats().active');
    assert.ok(stats.active >= 1, 'the slot we just acquired must count as active');
    // Pre-fix this was always maxConcurrent — a lightly loaded pool must not
    // claim to be fully saturated.
    assert.ok(
      info.active < info.maxConcurrent,
      `lightly-loaded pool reported saturated: active=${info.active} max=${info.maxConcurrent}`,
    );
  } finally {
    release();
  }
});

test('agentPool.info().active returns to baseline after release', async () => {
  const svc = initAgentSystem();
  const baseline = svc.agentPool.stats().active;
  const release = await svc.agentPool.acquire();
  assert.equal(svc.agentPool.info().active, baseline + 1);
  release();
  assert.equal(svc.agentPool.info().active, baseline);
});
