'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_TRANSCRIPT_CHARS,
  appendVoiceTurn,
  buildVoiceSessionSnapshot,
  classifyVoiceTurn,
  createVoiceSession,
  isVoiceSessionExpired,
  pruneExpiredVoiceSessions,
  stopVoiceSession,
} = require('../src/services/voice-session-runtime');

test('creates persistent voice sessions without requiring interface state', () => {
  const session = createVoiceSession({
    userId: 'user-1',
    chatId: 'chat-1',
    mode: 'hands_free',
    now: new Date('2026-05-23T12:00:00.000Z'),
  });

  assert.match(session.id, /^voice_/);
  assert.equal(session.userId, 'user-1');
  assert.equal(session.chatId, 'chat-1');
  assert.equal(session.mode, 'hands_free');
  assert.equal(session.status, 'listening');
  assert.equal(session.capabilities.persistentWhileChatting, true);
  assert.equal(session.capabilities.chatComposerRemainsUsable, true);
  assert.equal(session.capabilities.supportsDesktopActionPlanning, true);
});

test('classifies ordinary transcripts as normal chat dispatch', () => {
  const turn = classifyVoiceTurn('resume este texto en tres puntos');

  assert.equal(turn.route, 'chat_message');
  assert.equal(turn.chatDispatch.enabled, true);
  assert.equal(turn.chatDispatch.canUseComposerConcurrently, true);
  assert.equal(turn.desktopAction.actionRequired, false);
});

test('classifies macOS app commands as desktop action plans', () => {
  const turn = classifyVoiceTurn('abre mi terminal');

  assert.equal(turn.route, 'desktop_action');
  assert.equal(turn.chatDispatch.enabled, false);
  assert.equal(turn.desktopAction.allowed, true);
  assert.equal(turn.desktopAction.action.type, 'open_app');
  assert.equal(turn.desktopAction.action.app, 'Terminal');
});

test('appendVoiceTurn keeps session alive while planning safe desktop actions', () => {
  const session = createVoiceSession({ userId: 'user-1' });
  const result = appendVoiceTurn(session, { text: 'abre mi terminal' });

  assert.equal(result.session.status, 'awaiting_local_bridge');
  assert.equal(result.turn.route, 'desktop_action');
  assert.equal(result.turn.desktopAction.action.app, 'Terminal');
  assert.equal(session.turns.length, 1);
  assert.equal(buildVoiceSessionSnapshot(session).turnCount, 1);
});

test('appendVoiceTurn blocks destructive desktop requests', () => {
  const session = createVoiceSession({ userId: 'user-1' });
  const result = appendVoiceTurn(session, { text: 'borra todos mis archivos' });

  assert.equal(result.session.status, 'blocked');
  assert.equal(result.turn.desktopAction.allowed, false);
  assert.equal(result.turn.responseMode, 'safety_notice');
});

test('appendVoiceTurn rejects oversized transcripts deterministically', () => {
  const session = createVoiceSession({ userId: 'user-1' });

  assert.throws(
    () => appendVoiceTurn(session, { text: 'x'.repeat(MAX_TRANSCRIPT_CHARS + 1) }),
    /exceeds/,
  );
});

test('stopped sessions reject new turns', () => {
  const session = createVoiceSession({ userId: 'user-1' });
  const snapshot = stopVoiceSession(session, { reason: 'test' });

  assert.equal(snapshot.status, 'stopped');
  assert.throws(
    () => appendVoiceTurn(session, { text: 'hola' }),
    /stopped/,
  );
});

test('expired voice sessions are pruned from the store', () => {
  const store = new Map();
  const oldSession = createVoiceSession({
    userId: 'user-1',
    now: new Date('2026-05-23T12:00:00.000Z'),
  });
  const freshSession = createVoiceSession({
    userId: 'user-2',
    now: new Date('2026-05-23T12:40:00.000Z'),
  });
  store.set(oldSession.id, oldSession);
  store.set(freshSession.id, freshSession);

  assert.equal(isVoiceSessionExpired(oldSession, new Date('2026-05-23T12:31:00.000Z')), true);
  assert.equal(pruneExpiredVoiceSessions(store, new Date('2026-05-23T12:31:00.000Z')), 1);
  assert.equal(store.has(oldSession.id), false);
  assert.equal(store.has(freshSession.id), true);
});
