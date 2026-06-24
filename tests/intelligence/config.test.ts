import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  loadIntelligenceConfig,
  isIntelligenceCoreEnabled,
} from '../../server/intelligence/config';

describe('intelligence/config', () => {
  it('is disabled by default', () => {
    const cfg = loadIntelligenceConfig({});
    assert.equal(cfg.enabled, false);
    assert.equal(isIntelligenceCoreEnabled({}), false);
  });

  it('reads the feature flag', () => {
    assert.equal(isIntelligenceCoreEnabled({ SIRAGPT_INTELLIGENCE_CORE_ENABLED: '1' }), true);
    assert.equal(isIntelligenceCoreEnabled({ SIRAGPT_INTELLIGENCE_CORE_ENABLED: 'true' }), true);
    assert.equal(isIntelligenceCoreEnabled({ SIRAGPT_INTELLIGENCE_CORE_ENABLED: 'off' }), false);
  });

  it('applies sensible defaults', () => {
    const cfg = loadIntelligenceConfig({});
    assert.ok(cfg.maxContextTokens > 0);
    assert.ok(cfg.reserveOutputTokens > 0);
    assert.equal(cfg.allowEscalation, true);
    assert.ok(cfg.escalationConfidenceThreshold > 0 && cfg.escalationConfidenceThreshold < 1);
  });

  it('overrides numeric settings from the environment', () => {
    const cfg = loadIntelligenceConfig({
      SIRAGPT_INTELLIGENCE_MAX_CONTEXT_TOKENS: '8000',
      SIRAGPT_INTELLIGENCE_MAX_RETRIES: '0',
      SIRAGPT_INTELLIGENCE_DEFAULT_COST_TIER: 'low',
    });
    assert.equal(cfg.maxContextTokens, 8000);
    assert.equal(cfg.maxRetries, 0);
    assert.equal(cfg.defaultMaxCostTier, 'low');
  });
});
