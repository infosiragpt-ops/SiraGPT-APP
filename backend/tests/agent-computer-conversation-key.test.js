'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  memberKey,
  conversationSessionKey,
  resolveSessionIdentity,
} = require('../src/services/computer/member-key');
const {
  ISOLATION_REFUSED_ES,
  publicComputerError,
  sessionMatchesConversation,
  readIsolationKey,
  requireProvenIsolation,
  attachIsolationOrRefuse,
} = require('../src/services/computer/conversation-isolation');
const guard = require('../src/services/computer/computer-code-guard');
const ad = require('../src/services/agent-runner/engine-adapter');

describe('agent-computer conversation session key', () => {
  test('chat A and chat B get different session keys', () => {
    const user = { id: 'user_alpha_123' };
    const a = resolveSessionIdentity(user, 'chat-aaa');
    const b = resolveSessionIdentity(user, 'chat-bbb');
    assert.equal(a.conversationBound, true);
    assert.equal(b.conversationBound, true);
    assert.equal(a.conversationId, 'chat-aaa');
    assert.notEqual(a.userId, b.userId);
    assert.notEqual(a.sessionKey, b.sessionKey);
    assert.match(a.sessionKey, /_c_/);
  });

  test('missing conversation id is labeled unbound', () => {
    const identity = resolveSessionIdentity({ id: 'user_alpha_123' }, '');
    assert.equal(identity.conversationBound, false);
    assert.equal(identity.conversationId, null);
    assert.equal(identity.userId, memberKey({ id: 'user_alpha_123' }));
  });

  test('conversationSessionKey stays within docker slug length', () => {
    const long = conversationSessionKey('x'.repeat(40), 'y'.repeat(40));
    assert.ok(long.length <= 48);
    assert.equal(conversationSessionKey('luis', ''), 'luis');
  });

  test('fail-closed isolation refuses another chat or member-only desktop', () => {
    const identity = resolveSessionIdentity({ id: 'user_alpha_123' }, 'chat-aaa');
    assert.equal(sessionMatchesConversation({ userId: identity.userId }, identity), true);
    assert.equal(sessionMatchesConversation({ userId: identity.memberKey }, identity), false);
    assert.equal(sessionMatchesConversation({ userId: 'other-chat-key' }, identity), false);
    assert.match(ISOLATION_REFUSED_ES, /aislar/);
    assert.doesNotMatch(ISOLATION_REFUSED_ES, /sk-/);
  });

  test('unbound identity cannot attach — fail-closed for /code', () => {
    const unbound = resolveSessionIdentity({ id: 'user_alpha_123' }, '');
    assert.equal(unbound.conversationBound, false);
    assert.equal(sessionMatchesConversation({ userId: unbound.userId }, unbound), false);
    assert.throws(() => requireProvenIsolation(unbound), (err) => {
      assert.equal(err.code, 'isolation_required');
      assert.match(err.publicMessage, /aislar/);
      assert.doesNotMatch(String(err.publicMessage), /sk-/);
      return true;
    });
  });

  test('workspaceId is an isolation key and chat A ≠ chat B', () => {
    assert.equal(readIsolationKey({ body: { workspaceId: 'project:acme' } }), 'project:acme');
    assert.equal(readIsolationKey({ query: { conversationId: 'chat-1' } }), 'chat-1');
    const a = resolveSessionIdentity({ id: 'user_alpha_123' }, 'ws-aaa');
    const b = resolveSessionIdentity({ id: 'user_alpha_123' }, 'ws-bbb');
    requireProvenIsolation(a);
    assert.notEqual(a.sessionKey, b.sessionKey);
    assert.throws(
      () => attachIsolationOrRefuse({ userId: a.memberKey }, a),
      (err) => err.code === 'isolation_required',
    );
    assert.equal(attachIsolationOrRefuse({ userId: a.userId }, a).sessionKey, a.sessionKey);
  });

  test('screenshot-only turns do not charge and refuse if no session', () => {
    const shot = guard.applyScreenshotNoChargeClosed({
      tools: [{ name: 'computer_screenshot' }],
      screenshotOnlyNoCharge: ad.screenshotOnlyNoCharge,
      observeOnlyNoCharge: ad.observeOnlyNoCharge,
    });
    assert.equal(shot.charge, false);
    assert.equal(shot.code, 'credit_screenshot');
    const mix = guard.applyScreenshotNoChargeClosed({
      tools: [{ name: 'computer_screenshot' }, { name: 'computer_click' }],
      screenshotOnlyNoCharge: ad.screenshotOnlyNoCharge,
    });
    assert.equal(mix.charge, true);
    const noSess = guard.applyRefuseComputerToolsClosed({
      toolName: 'computer_click',
      userId: 'u1',
      sessionId: '',
      computerEnabled: true,
      refuseComputerToolsIfFlagOff: ad.refuseComputerToolsIfFlagOff,
      refuseComputerToolsIfNoUserId: ad.refuseComputerToolsIfNoUserId,
      refuseComputerToolsIfSessionMissing: ad.refuseComputerToolsIfSessionMissing,
    });
    assert.equal(noSess.ok, false);
    assert.equal(noSess.code, 'computer_no_session');
    assert.match(noSess.message, /sesión/);
    assert.doesNotMatch(noSess.message, /sk-/);
    const ok = guard.applyRefuseComputerToolsClosed({
      toolName: 'computer_click',
      userId: 'u1',
      sessionId: 's1',
      computerEnabled: true,
      refuseComputerToolsIfFlagOff: ad.refuseComputerToolsIfFlagOff,
      refuseComputerToolsIfNoUserId: ad.refuseComputerToolsIfNoUserId,
      refuseComputerToolsIfSessionMissing: ad.refuseComputerToolsIfSessionMissing,
    });
    assert.equal(ok.ok, true);
  });

  test('abort cleanup reaps via 3H59/3H60 sandbox helpers', () => {
    const seen = [];
    const out = guard.applySandboxAbortCleanupClosed({
      aborted: true,
      timedOut: true,
      elapsedMs: 25_000,
      timeoutMs: 20_000,
      workdir: 'sira-ac-user-luis_c_chat',
      pid: 4242,
      kill: (pid, sig) => seen.push(`${pid}:${sig}`),
      sandboxTimeoutThenCleanup: ad.sandboxTimeoutThenCleanup || ((args) => ({
        timeout: args.elapsedMs >= args.timeoutMs,
        cleanup: args.elapsedMs >= args.timeoutMs,
        code: 'sandbox_timeout_cleanup',
      })),
      sandboxFinallyCleanupOnAbort: require('../src/services/agent-runner/engine-3h60').sandboxFinallyCleanupOnAbort,
      sandboxTmpCleanupOnTimeout: ad.sandboxTmpCleanupOnTimeout,
    });
    assert.equal(out.cleaned, true);
    assert.equal(out.aborted, true);
    assert.ok(seen.includes('4242:SIGTERM') || seen.includes('4242:SIGKILL') || out.code);
    assert.doesNotMatch(String(out.code || ''), /sk-/);
  });

  test('OpenRouter computer model is refused; DeepSeek Flash wins', () => {
    const denied = guard.refuseOpenRouterComputerModel('openrouter/gpt-4o');
    assert.equal(denied.ok, false);
    assert.equal(denied.code, 'openrouter_denied');
    assert.doesNotMatch(denied.message, /sk-/);
    const ok = guard.refuseOpenRouterComputerModel('deepseek-v4-pro');
    assert.equal(ok.ok, true);
    assert.match(ok.model, /deepseek/);
  });

  test('publicComputerError never leaks stacks or sk- secrets', () => {
    assert.equal(
      publicComputerError({ message: 'sk-abcdefghijklmnopqrstuvwxyz' }),
      'No se pudo abrir la computadora de esta conversación.',
    );
    assert.equal(
      publicComputerError({ message: 'Error: boom\n    at foo (node_modules/x.js:1:1)' }),
      'No se pudo abrir la computadora de esta conversación.',
    );
    assert.equal(
      publicComputerError({ publicMessage: ISOLATION_REFUSED_ES, message: 'sk-hidden' }),
      ISOLATION_REFUSED_ES,
    );
  });
});
