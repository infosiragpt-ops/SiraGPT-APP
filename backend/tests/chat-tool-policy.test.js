/**
 * Tests for chat-tool-policy — the interactive-chat authorization chokepoint.
 *
 * Run: node --test backend/tests/chat-tool-policy.test.js
 */

const assert = require('node:assert');
const { describe, it } = require('node:test');

const {
  createChatToolGate,
  isHighRiskTool,
  resolvePolicy,
  HIGH_RISK_TOOLS,
} = require('../src/services/agents/chat-tool-policy');

describe('chat-tool-policy', () => {
  it('classifies host tools as high-risk and the rest as low-risk', () => {
    for (const t of ['host_bash', 'host_file', 'clone_project']) {
      assert.strictEqual(isHighRiskTool(t), true, `${t} should be high-risk`);
      assert.ok(HIGH_RISK_TOOLS.has(t));
    }
    for (const t of ['web_search', 'read_url', 'create_chart', 'rag_retrieve', 'session_search', 'finalize']) {
      assert.strictEqual(isHighRiskTool(t), false, `${t} should be low-risk`);
    }
  });

  it('allows low-risk tools unconditionally', () => {
    const gate = createChatToolGate({ env: { SIRAGPT_HOST_TOOLS_DISABLED: '1' } });
    assert.deepStrictEqual(gate.authorize('web_search', {}), { ok: true });
    assert.deepStrictEqual(gate.authorize('create_chart', {}), { ok: true });
  });

  it('allows high-risk tools by default (no env policy set)', () => {
    const gate = createChatToolGate({ env: {} });
    assert.strictEqual(gate.authorize('host_bash', {}).ok, true);
    assert.strictEqual(gate.authorize('host_file', {}).ok, true);
    assert.strictEqual(gate.authorize('clone_project', {}).ok, true);
  });

  it('kill switch denies high-risk tools but never low-risk ones', () => {
    for (const flag of ['1', 'true', 'yes', 'on']) {
      const gate = createChatToolGate({ env: { SIRAGPT_HOST_TOOLS_DISABLED: flag } });
      const denied = gate.authorize('host_bash', {});
      assert.strictEqual(denied.ok, false);
      assert.strictEqual(denied.reason, 'host_tools_disabled');
      assert.strictEqual(gate.authorize('web_search', {}).ok, true);
    }
  });

  it('clearance gate restricts high-risk tools to listed clearances', () => {
    const gate = createChatToolGate({ env: { SIRAGPT_HOST_TOOLS_REQUIRE_CLEARANCE: 'admin, owner' } });
    assert.strictEqual(gate.authorize('host_bash', { clearance: 'admin' }).ok, true);
    assert.strictEqual(gate.authorize('host_bash', { clearance: 'OWNER' }).ok, true); // case-insensitive
    const denied = gate.authorize('host_bash', { clearance: 'authenticated' });
    assert.strictEqual(denied.ok, false);
    assert.strictEqual(denied.reason, 'insufficient_clearance');
    // No clearance at all → denied.
    assert.strictEqual(gate.authorize('host_bash', {}).ok, false);
    // Low-risk still fine without clearance.
    assert.strictEqual(gate.authorize('read_url', {}).ok, true);
  });

  it('rejects an invalid tool name', () => {
    const gate = createChatToolGate({ env: {} });
    assert.strictEqual(gate.authorize('', {}).ok, false);
    assert.strictEqual(gate.authorize(null, {}).ok, false);
  });

  it('invokes the audit hook only for authorized high-risk tools', () => {
    const audited = [];
    const gate = createChatToolGate({ env: {}, onAudit: (info) => audited.push(info) });
    gate.authorize('web_search', { userId: 'u1' });   // low-risk → no audit
    gate.authorize('host_bash', { userId: 'u1' });    // high-risk → audit
    assert.strictEqual(audited.length, 1);
    assert.strictEqual(audited[0].tool, 'host_bash');
    assert.strictEqual(audited[0].userId, 'u1');
  });

  it('audit hook errors never break authorization', () => {
    const gate = createChatToolGate({ env: {}, onAudit: () => { throw new Error('boom'); } });
    assert.strictEqual(gate.authorize('host_bash', {}).ok, true);
  });

  it('resolvePolicy reads env flags', () => {
    assert.deepStrictEqual(resolvePolicy({}), { disabled: false, requiredClearances: [], productionDefaultDeny: false });
    assert.deepStrictEqual(
      resolvePolicy({ SIRAGPT_HOST_TOOLS_DISABLED: 'true', SIRAGPT_HOST_TOOLS_REQUIRE_CLEARANCE: 'admin,owner' }),
      { disabled: true, requiredClearances: ['admin', 'owner'], productionDefaultDeny: false },
    );
  });

  it('denies high-risk tools in production when no explicit policy is set (fail-closed)', () => {
    const gate = createChatToolGate({ env: { NODE_ENV: 'production' } });
    const denied = gate.authorize('host_bash', {});
    assert.strictEqual(denied.ok, false);
    assert.strictEqual(denied.reason, 'host_tools_production_denied');
    assert.strictEqual(gate.authorize('host_file', {}).ok, false);
    assert.strictEqual(gate.authorize('clone_project', {}).ok, false);
    // Low-risk tools keep working in production.
    assert.strictEqual(gate.authorize('web_search', {}).ok, true);
  });

  it('explicit production policy overrides the fail-closed default', () => {
    const clearanceGate = createChatToolGate({
      env: { NODE_ENV: 'production', SIRAGPT_HOST_TOOLS_REQUIRE_CLEARANCE: 'ops' },
    });
    assert.strictEqual(clearanceGate.policy.productionDefaultDeny, false);
    assert.strictEqual(clearanceGate.authorize('host_bash', { clearance: 'ops' }).ok, true);
    assert.strictEqual(clearanceGate.authorize('host_bash', { clearance: 'user' }).ok, false);

    const disabledGate = createChatToolGate({ env: { NODE_ENV: 'production', SIRAGPT_HOST_TOOLS_DISABLED: '1' } });
    assert.strictEqual(disabledGate.authorize('host_bash', {}).reason, 'host_tools_disabled');

    // An explicitly empty-ish DISABLED=0 keeps production open on purpose.
    const optOutGate = createChatToolGate({ env: { NODE_ENV: 'production', SIRAGPT_HOST_TOOLS_DISABLED: '0' } });
    assert.strictEqual(optOutGate.authorize('host_bash', {}).ok, true);
  });

  it('development without policy stays permissive', () => {
    for (const env of [{}, { NODE_ENV: 'development' }, { NODE_ENV: 'test' }]) {
      const gate = createChatToolGate({ env });
      assert.strictEqual(gate.authorize('host_bash', {}).ok, true);
      assert.strictEqual(gate.policy.productionDefaultDeny, false);
    }
  });
});
