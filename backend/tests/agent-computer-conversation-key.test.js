'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  memberKey,
  conversationSessionKey,
  resolveSessionIdentity,
} = require('../src/services/computer/member-key');

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
});
