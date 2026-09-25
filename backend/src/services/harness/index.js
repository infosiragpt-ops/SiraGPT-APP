'use strict';

/**
 * Harness v2 — provider-agnostic agent loop (Phase 1a).
 *
 * Gated by SIRAGPT_HARNESS_V2 (default OFF). Nothing in the chat routes
 * calls this module yet; Phase 1b wires it into /agentes behind the flag.
 */

const { runAgentLoop } = require('./loop');
const { createAdapter, harnessCapabilities } = require('./adapters');
const { createToolRegistry } = require('./tool-registry');
const { fitToContext, estimateRequestTokens } = require('./token-budget');
const { createHarnessEventBridge } = require('./event-bridge');
const { HarnessProviderError } = require('./errors');

function isHarnessV2Enabled(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String((env && env.SIRAGPT_HARNESS_V2) || '').trim());
}

/**
 * Convenience: resolve the adapter for (provider, model) and run the loop.
 * `opts` is forwarded to runAgentLoop; context window / output cap default
 * to the model's capability profile.
 */
async function runHarness({ provider, model, toolMode, fetchImpl, env, ...opts }) {
  const { adapter, caps, toolMode: mode, endpoint } = createAdapter({ provider, model, toolMode, fetchImpl, env });
  const result = await runAgentLoop({
    adapter,
    model,
    contextWindow: opts.contextWindow || caps.contextWindow,
    maxTokens: opts.maxTokens || Math.min(caps.maxOutputTokens || 8192, 32_000),
    ...opts,
  });
  return { ...result, toolMode: mode, provider: endpoint.provider };
}

module.exports = {
  isHarnessV2Enabled,
  runHarness,
  runAgentLoop,
  createAdapter,
  harnessCapabilities,
  createToolRegistry,
  fitToContext,
  estimateRequestTokens,
  createHarnessEventBridge,
  HarnessProviderError,
};
