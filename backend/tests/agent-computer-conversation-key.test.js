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
} = require('../src/services/computer/conversation-isolation');

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
