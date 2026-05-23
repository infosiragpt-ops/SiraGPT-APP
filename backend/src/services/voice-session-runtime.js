'use strict';

const crypto = require('crypto');
const { planDesktopAction, resolveDesktopBridgeCapabilities } = require('./desktop-action-policy');

const VOICE_SESSION_VERSION = 'voice-session-runtime-2026-05';
const VOICE_SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_TRANSCRIPT_CHARS = 4000;

function nowIso(now = new Date()) {
  return now instanceof Date ? now.toISOString() : new Date(now).toISOString();
}

function randomId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
}

function assertUserId(userId) {
  if (!userId || typeof userId !== 'string') {
    const error = new Error('userId is required for voice sessions');
    error.code = 'voice_session_user_required';
    throw error;
  }
}

function normalizeSessionMode(mode) {
  if (mode === 'dictation' || mode === 'hands_free') return mode;
  return 'advanced_voice';
}

function createVoiceSession({ userId, chatId = null, mode = 'advanced_voice', now = new Date() } = {}) {
  assertUserId(userId);
  const timestamp = nowIso(now);
  return {
    version: VOICE_SESSION_VERSION,
    id: randomId('voice'),
    userId,
    chatId: chatId || null,
    mode: normalizeSessionMode(mode),
    status: 'listening',
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt: nowIso(new Date(new Date(timestamp).getTime() + VOICE_SESSION_TTL_MS)),
    lastTurnId: null,
    turns: [],
    capabilities: {
      persistentWhileChatting: true,
      chatComposerRemainsUsable: true,
      supportsDesktopActionPlanning: true,
      desktopBridge: resolveDesktopBridgeCapabilities(),
    },
  };
}

function buildVoiceSessionSnapshot(session) {
  if (!session) return null;
  return {
    version: session.version,
    id: session.id,
    chatId: session.chatId || null,
    mode: session.mode,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    expiresAt: session.expiresAt,
    lastTurnId: session.lastTurnId,
    turnCount: Array.isArray(session.turns) ? session.turns.length : 0,
    capabilities: session.capabilities,
  };
}

function classifyVoiceTurn(text, options = {}) {
  const transcript = String(text || '').trim();
  if (!transcript) {
    return {
      route: 'empty',
      transcript,
      desktopAction: planDesktopAction(''),
      chatDispatch: { enabled: false, reason: 'empty_transcript' },
      responseMode: 'none',
    };
  }

  const desktopAction = planDesktopAction(transcript, options);
  if (desktopAction.actionRequired) {
    return {
      route: 'desktop_action',
      transcript,
      desktopAction,
      chatDispatch: {
        enabled: false,
        reason: desktopAction.status,
      },
      responseMode: desktopAction.status === 'blocked' ? 'safety_notice' : 'action_status',
    };
  }

  return {
    route: 'chat_message',
    transcript,
    desktopAction,
    chatDispatch: {
      enabled: true,
      text: transcript,
      mode: 'normal_chat',
      canUseComposerConcurrently: true,
    },
    responseMode: 'chat',
  };
}

function statusForTurn(route) {
  if (route.route === 'empty') return 'listening';
  if (route.desktopAction?.status === 'blocked') return 'blocked';
  if (route.desktopAction?.requiresConfirmation) return 'awaiting_confirmation';
  if (route.desktopAction?.actionRequired) return 'awaiting_local_bridge';
  return 'listening';
}

function appendVoiceTurn(session, { text, source = 'stt', now = new Date(), defaultWorkingDirectory = null } = {}) {
  if (!session) {
    const error = new Error('voice session is required');
    error.code = 'voice_session_required';
    throw error;
  }
  if (session.status === 'stopped') {
    const error = new Error('voice session is stopped');
    error.code = 'voice_session_stopped';
    throw error;
  }

  const rawText = String(text || '');
  if (rawText.length > MAX_TRANSCRIPT_CHARS) {
    const error = new Error(`voice transcript exceeds ${MAX_TRANSCRIPT_CHARS} characters`);
    error.code = 'voice_transcript_too_large';
    throw error;
  }

  const timestamp = nowIso(now);
  const route = classifyVoiceTurn(rawText, { defaultWorkingDirectory });
  const turn = {
    id: randomId('voice_turn'),
    sessionId: session.id,
    source,
    transcript: route.transcript,
    route: route.route,
    responseMode: route.responseMode,
    desktopAction: route.desktopAction,
    chatDispatch: route.chatDispatch,
    createdAt: timestamp,
  };

  session.turns.push(turn);
  session.lastTurnId = turn.id;
  session.updatedAt = timestamp;
  session.status = statusForTurn(route);
  return {
    session: buildVoiceSessionSnapshot(session),
    turn,
  };
}

function stopVoiceSession(session, { now = new Date(), reason = 'user_requested' } = {}) {
  if (!session) return null;
  session.status = 'stopped';
  session.updatedAt = nowIso(now);
  session.stopReason = reason;
  return buildVoiceSessionSnapshot(session);
}

function isVoiceSessionExpired(session, now = new Date()) {
  if (!session?.expiresAt) return true;
  return new Date(session.expiresAt).getTime() <= new Date(now).getTime();
}

function pruneExpiredVoiceSessions(store, now = new Date()) {
  if (!store || typeof store.entries !== 'function') return 0;
  let removed = 0;
  for (const [id, session] of store.entries()) {
    if (isVoiceSessionExpired(session, now)) {
      store.delete(id);
      removed += 1;
    }
  }
  return removed;
}

module.exports = {
  VOICE_SESSION_VERSION,
  VOICE_SESSION_TTL_MS,
  MAX_TRANSCRIPT_CHARS,
  createVoiceSession,
  buildVoiceSessionSnapshot,
  classifyVoiceTurn,
  appendVoiceTurn,
  stopVoiceSession,
  isVoiceSessionExpired,
  pruneExpiredVoiceSessions,
};
