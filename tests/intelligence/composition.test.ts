import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createIntelligenceCore,
  hasAnyProviderKey,
} from '../../server/intelligence/index';
import { createBufferSink } from '../../server/intelligence/core/streamer';
import { createEchoLlmClient } from '../../server/intelligence/adapters/null-adapters';

describe('intelligence/composition root', () => {
  it('builds a fully-offline core with defaults and answers a turn', async () => {
    const core = createIntelligenceCore({ useDefaults: true, env: {} });
    assert.equal(core.enabled, false);
    const sink = createBufferSink();
    const result = await core.orchestrator.handle(
      { requestId: 'c1', userId: 'u1', prompt: 'Hola, ¿qué puedes hacer?', history: [] },
      { sink }
    );
    assert.equal(result.refused, false);
    assert.ok(result.output.length > 0);
  });

  it('exposes the feature flag (off by default)', () => {
    const off = createIntelligenceCore({ useDefaults: true, env: {} });
    assert.equal(off.enabled, false);
    const on = createIntelligenceCore({
      useDefaults: true,
      env: { SIRAGPT_INTELLIGENCE_CORE_ENABLED: '1' },
    });
    assert.equal(on.enabled, true);
  });

  it('detects provider keys', () => {
    assert.equal(hasAnyProviderKey({ OPENAI_API_KEY: 'sk-x' }), true);
    assert.equal(hasAnyProviderKey({ OPENROUTER_API_KEY: 'x' }), true);
    assert.equal(hasAnyProviderKey({}), false);
  });

  it('honors port overrides', async () => {
    const core = createIntelligenceCore({
      useDefaults: true,
      env: {},
      overrides: { llm: createEchoLlmClient({ responder: () => 'OVERRIDDEN' }) },
    });
    const result = await core.orchestrator.handle(
      { requestId: 'c2', userId: 'u2', prompt: 'hello there', history: [] },
      {}
    );
    assert.equal(result.output, 'OVERRIDDEN');
  });
});
