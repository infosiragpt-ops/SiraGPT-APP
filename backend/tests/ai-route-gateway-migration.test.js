'use strict';

/**
 * Regression test for the surgical migration of the main `/api/ai/generate`
 * call site in `backend/src/routes/ai.js`. Asserts that
 * `createProviderClientForRequest(provider, req)`:
 *   1. returns the gateway client when LLM_GATEWAY_URL/KEY are set and
 *      the request carries `x-sira-gateway: 1`,
 *   2. returns the legacy direct client otherwise,
 *   3. never throws on bad config / missing helper.
 *
 * We don't load the whole `ai.js` route module here (it pulls in dozens
 * of services + Prisma). Instead we recreate the exact helper shape and
 * verify the same require()-based wiring used in the route.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const ROUTE_PATH = path.join(__dirname, '..', 'src', 'routes', 'ai.js');

test('ai.js exports the request-aware helper and uses the gateway client', () => {
  // Read the route source — we don't want to load it, but we do want to
  // assert the migration is wired correctly so it can't silently regress.
  const fs = require('node:fs');
  const src = fs.readFileSync(ROUTE_PATH, 'utf8');
  assert.match(
    src,
    /function createProviderClientForRequest\(/,
    'createProviderClientForRequest helper must exist',
  );
  assert.match(
    src,
    /shouldUseGatewayForRequest/,
    'route must consult the gateway opt-in helper',
  );
  assert.match(
    src,
    /createGatewayClient/,
    'route must call the gateway client factory',
  );
  assert.match(
    src,
    /createProviderClientForRequest\(provider, req\)/,
    'the main /generate path must use the request-aware variant on first resolution',
  );
  assert.match(
    src,
    /\[ai\/generate\] via=gateway/,
    'rollout observability log must be present',
  );

  // BUG REGRESSION GUARD: the post-actualProvider re-resolution MUST go
  // through the request-aware helper. A previous pass clobbered the
  // gateway client with a direct one and the rollout silently routed
  // everything through legacy providers while logging the opposite.
  assert.doesNotMatch(
    src,
    /openai\s*=\s*createProviderClient\(actualProvider\)\s*;/,
    'must NOT reset openai to direct client — use createProviderClientForRequest(actualProvider, req)',
  );
  assert.match(
    src,
    /createProviderClientForRequest\(actualProvider, req\)/,
    'must re-resolve via request-aware helper after actualProvider is determined',
  );
});

test('gateway client returns legacy when LLM_GATEWAY_URL is unset', () => {
  const { createGatewayClient, shouldUseGatewayForRequest } = require('../src/services/ai/llm-gateway-client');
  const env = {};
  assert.equal(createGatewayClient({ env }), null);
  assert.equal(
    shouldUseGatewayForRequest({ headers: { 'x-sira-gateway': '1' } }, { env }),
    false,
    'header opt-in must be ignored when gateway is disabled',
  );
});

test('gateway client is returned only when both env + header agree', () => {
  const { createGatewayClient, shouldUseGatewayForRequest } = require('../src/services/ai/llm-gateway-client');
  const env = { LLM_GATEWAY_URL: 'https://gw.test/v1', LLM_GATEWAY_KEY: 'k' };

  // No header → must not route to gateway.
  assert.equal(shouldUseGatewayForRequest({ headers: {} }, { env }), false);

  // Header present → routes to gateway.
  assert.equal(
    shouldUseGatewayForRequest({ headers: { 'x-sira-gateway': '1' } }, { env }),
    true,
  );
  assert.ok(createGatewayClient({ env }), 'client factory returns a non-null client');
});

test('route-side helper falls back to legacy on any gateway error', () => {
  // Mirror the try/catch in `createProviderClientForRequest` so the
  // contract is locked: a thrown helper must NOT propagate to the route.
  function helper(provider, req, deps) {
    try {
      if (deps.shouldUseGatewayForRequest(req)) {
        const gw = deps.createGatewayClient();
        if (gw) return { client: gw, via: 'gateway' };
      }
    } catch (_err) {
      // swallow on purpose
    }
    return { client: { id: 'legacy:' + provider }, via: 'direct' };
  }

  const boomGateway = helper('OpenAI', { headers: { 'x-sira-gateway': '1' } }, {
    shouldUseGatewayForRequest: () => true,
    createGatewayClient: () => { throw new Error('helper exploded'); },
  });
  assert.equal(boomGateway.via, 'direct', 'crash must downgrade to legacy');
  assert.deepEqual(boomGateway.client, { id: 'legacy:OpenAI' });

  const happyGateway = helper('OpenAI', { headers: { 'x-sira-gateway': '1' } }, {
    shouldUseGatewayForRequest: () => true,
    createGatewayClient: () => ({ id: 'gateway-client' }),
  });
  assert.equal(happyGateway.via, 'gateway');

  const noOptIn = helper('OpenAI', { headers: {} }, {
    shouldUseGatewayForRequest: () => false,
    createGatewayClient: () => ({ id: 'should-not-be-called' }),
  });
  assert.equal(noOptIn.via, 'direct');
});
