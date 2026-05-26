'use strict';

/**
 * Real-time WebSocket scaffolding.
 *
 * Attaches a `ws` server to an existing HTTP server (it never creates its
 * own listener) and provides:
 *   - JWT bearer auth from the URL `?token=`
 *   - Channels: `user:<id>`, `chat:<id>`, `org:<id>`
 *   - 30 s heartbeat ping/pong with auto-close of dead sockets
 *   - Graceful close on auth failure with WS close-code 4401
 *   - Typing-indicator + cursor/selection broadcast helpers
 *
 * Helpers `broadcastToUser`, `broadcastToChat`, `broadcastToOrg` are
 * consumable by Express route handlers — they short-circuit when the
 * socket server is not initialised (e.g. in unit tests).
 */

const WebSocket = require('ws');
const jwt = require('jsonwebtoken');

const { getPresenceTracker } = require('./presence');
const { getTypingIndicator } = require('./typing-indicator');
const { CursorThrottler } = require('./cursor-sharing');

const HEARTBEAT_INTERVAL_MS = 30_000;
const WS_PATH = '/ws/realtime';

// WebSocket close codes are restricted to 1000–4999.  We use 4401/4403
// for auth failures and 4408 for stale (heartbeat) closures.
const CLOSE_CODE_AUTH_REQUIRED = 4401;
const CLOSE_CODE_AUTH_INVALID = 4403;
const CLOSE_CODE_HEARTBEAT = 4408;

let _state = null; // module singleton

/**
 * @typedef {object} SocketServerState
 * @property {WebSocket.Server} wss
 * @property {Map<string, Set<WebSocket>>} userIndex
 * @property {Map<string, Set<WebSocket>>} chatIndex
 * @property {Map<string, Set<WebSocket>>} orgIndex
 * @property {NodeJS.Timeout} heartbeatTimer
 * @property {(token:string)=>Promise<{userId:string,orgId?:string}>} verifyToken
 * @property {object} presence
 * @property {object} typing
 * @property {CursorThrottler} cursor
 */

/** Default verifier — uses JWT_SECRET. */
async function defaultVerifyToken(token) {
  if (!token) throw new Error('missing token');
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET not configured');
  const decoded = jwt.verify(token, secret);
  const userId = decoded?.userId || decoded?.id || decoded?.sub;
  if (!userId) throw new Error('token has no userId');
  return { userId: String(userId), orgId: decoded?.orgId ? String(decoded.orgId) : undefined };
}

function _addToIndex(index, key, ws) {
  let set = index.get(key);
  if (!set) { set = new Set(); index.set(key, set); }
  set.add(ws);
}
function _removeFromIndex(index, key, ws) {
  const set = index.get(key);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) index.delete(key);
}

function _send(ws, obj) {
  if (ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(obj));
    return true;
  } catch {
    return false;
  }
}

function _broadcast(set, obj, { excludeWs } = {}) {
  if (!set) return 0;
  let n = 0;
  for (const ws of set) {
    if (excludeWs && ws === excludeWs) continue;
    if (_send(ws, obj)) n += 1;
  }
  return n;
}

function _parseTokenFromReq(req) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const fromQuery = url.searchParams.get('token');
    if (fromQuery) return fromQuery;
  } catch { /* noop */ }
  const auth = req.headers?.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

/**
 * @param {import('http').Server} server
 * @param {object} [opts]
 * @param {(token:string)=>Promise<{userId:string,orgId?:string}>} [opts.verifyToken]
 * @param {string} [opts.path]
 * @param {object} [opts.presence]
 * @param {object} [opts.typing]
 * @param {object} [opts.logger]
 */
function initRealtimeServer(server, opts = {}) {
  if (_state) return _state; // idempotent

  const verifyToken = opts.verifyToken || defaultVerifyToken;
  const path = opts.path || WS_PATH;
  const logger = opts.logger || { info() {}, warn() {}, error() {} };

  const wss = new WebSocket.Server({ server, path });
  const userIndex = new Map();
  const chatIndex = new Map();
  const orgIndex = new Map();

  const presence = opts.presence || getPresenceTracker();
  const typing = opts.typing || getTypingIndicator();
  const cursor = new CursorThrottler({
    broadcast: (payload) => {
      const set = chatIndex.get(payload.chatId);
      _broadcast(set, { channel: `chat:${payload.chatId}`, ...payload });
    },
  });

  wss.on('connection', async (ws, req) => {
    ws.isAlive = true;
    ws.subscribedChats = new Set();
    ws.subscribedOrgs = new Set();

    const token = _parseTokenFromReq(req);
    if (!token) {
      _send(ws, { type: 'error', code: 'auth_required', message: 'token query param required' });
      try { ws.close(CLOSE_CODE_AUTH_REQUIRED, 'auth_required'); } catch {}
      return;
    }

    let auth;
    try {
      auth = await verifyToken(token);
    } catch (err) {
      _send(ws, { type: 'error', code: 'auth_invalid', message: err.message });
      try { ws.close(CLOSE_CODE_AUTH_INVALID, 'auth_invalid'); } catch {}
      return;
    }

    ws.userId = auth.userId;
    ws.orgId = auth.orgId;

    _addToIndex(userIndex, ws.userId, ws);
    if (ws.orgId) {
      _addToIndex(orgIndex, ws.orgId, ws);
      ws.subscribedOrgs.add(ws.orgId);
    }
    try { await presence.heartbeat(ws.userId); } catch (e) { logger.warn({ err: e.message }, 'presence_heartbeat_failed'); }

    _send(ws, {
      type: 'welcome',
      userId: ws.userId,
      orgId: ws.orgId || null,
      channels: ['user:' + ws.userId, ...(ws.orgId ? ['org:' + ws.orgId] : [])],
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    });

    ws.on('pong', () => {
      ws.isAlive = true;
      // Heartbeat refreshes presence TTL
      void presence.heartbeat(ws.userId).catch(() => {});
    });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); }
      catch { _send(ws, { type: 'error', code: 'invalid_json' }); return; }
      handleMessage(ws, msg).catch((err) => {
        logger.warn({ err: err.message }, 'realtime_message_error');
        _send(ws, { type: 'error', code: 'message_error', message: err.message });
      });
    });

    ws.on('close', () => {
      _removeFromIndex(userIndex, ws.userId, ws);
      for (const cid of ws.subscribedChats) {
        _removeFromIndex(chatIndex, cid, ws);
        typing.stop(cid, ws.userId, { reason: 'disconnect' });
        cursor.clear(cid, ws.userId);
      }
      for (const oid of ws.subscribedOrgs) _removeFromIndex(orgIndex, oid, ws);
      // If this was the user's last socket, mark offline.
      const remaining = userIndex.get(ws.userId);
      if (!remaining || remaining.size === 0) {
        void presence.goOffline(ws.userId).catch(() => {});
      }
    });
  });

  async function handleMessage(ws, msg) {
    if (!msg || typeof msg !== 'object') throw new Error('message must be an object');
    const type = String(msg.type || '');
    switch (type) {
      case 'ping':
        _send(ws, { type: 'pong', at: Date.now() });
        return;

      case 'subscribe.chat': {
        const chatId = String(msg.chatId || '');
        if (!chatId) throw new Error('chatId required');
        ws.subscribedChats.add(chatId);
        _addToIndex(chatIndex, chatId, ws);
        _send(ws, { type: 'subscribed', channel: `chat:${chatId}` });
        return;
      }
      case 'unsubscribe.chat': {
        const chatId = String(msg.chatId || '');
        if (!chatId) return;
        ws.subscribedChats.delete(chatId);
        _removeFromIndex(chatIndex, chatId, ws);
        typing.stop(chatId, ws.userId, { reason: 'unsubscribe' });
        cursor.clear(chatId, ws.userId);
        return;
      }

      case 'typing.start': {
        const chatId = String(msg.chatId || '');
        if (!chatId || !ws.subscribedChats.has(chatId)) throw new Error('not subscribed to chat');
        typing.start(chatId, ws.userId);
        const set = chatIndex.get(chatId);
        _broadcast(set, {
          channel: `chat:${chatId}`,
          type: 'typing.start',
          chatId,
          userId: ws.userId,
        }, { excludeWs: ws });
        return;
      }
      case 'typing.stop': {
        const chatId = String(msg.chatId || '');
        if (!chatId) return;
        typing.stop(chatId, ws.userId, { reason: 'explicit' });
        const set = chatIndex.get(chatId);
        _broadcast(set, {
          channel: `chat:${chatId}`,
          type: 'typing.stop',
          chatId,
          userId: ws.userId,
        }, { excludeWs: ws });
        return;
      }

      case 'cursor:update':
      case 'selection:update': {
        const chatId = String(msg.chatId || '');
        if (!chatId || !ws.subscribedChats.has(chatId)) throw new Error('not subscribed to chat');
        cursor.submit({ chatId, userId: ws.userId, type, data: msg.data });
        return;
      }

      default:
        throw new Error(`unknown message type: ${type}`);
    }
  }

  // Forward typing-indicator auto-stop events from the shared singleton.
  const onTypingStop = ({ chatId, userId, reason }) => {
    if (reason !== 'timeout') return; // explicit/unsubscribe already broadcast inline
    const set = chatIndex.get(chatId);
    _broadcast(set, { channel: `chat:${chatId}`, type: 'typing.stop', chatId, userId, reason });
  };
  typing.on('stop', onTypingStop);

  // Heartbeat loop — terminate sockets that didn't pong since last tick.
  const heartbeatTimer = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        try { ws.close(CLOSE_CODE_HEARTBEAT, 'heartbeat_timeout'); } catch {}
        try { ws.terminate(); } catch {}
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch {}
    }
  }, HEARTBEAT_INTERVAL_MS);
  if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();

  _state = {
    wss,
    userIndex,
    chatIndex,
    orgIndex,
    heartbeatTimer,
    verifyToken,
    presence,
    typing,
    cursor,
    _onTypingStop: onTypingStop,
  };
  return _state;
}

function _ensureState() { return _state; }

function broadcastToUser(userId, event) {
  const s = _ensureState();
  if (!s || !userId) return 0;
  const set = s.userIndex.get(String(userId));
  return _broadcast(set, { channel: `user:${userId}`, ...event });
}
function broadcastToChat(chatId, event) {
  const s = _ensureState();
  if (!s || !chatId) return 0;
  const set = s.chatIndex.get(String(chatId));
  return _broadcast(set, { channel: `chat:${chatId}`, ...event });
}
function broadcastToOrg(orgId, event) {
  const s = _ensureState();
  if (!s || !orgId) return 0;
  const set = s.orgIndex.get(String(orgId));
  return _broadcast(set, { channel: `org:${orgId}`, ...event });
}

function getRealtimeState() { return _state; }

function closeRealtimeServer() {
  if (!_state) return;
  clearInterval(_state.heartbeatTimer);
  try { _state.typing.off('stop', _state._onTypingStop); } catch {}
  try { _state.cursor.dispose(); } catch {}
  try { _state.wss.close(); } catch {}
  _state = null;
}

module.exports = {
  initRealtimeServer,
  broadcastToUser,
  broadcastToChat,
  broadcastToOrg,
  getRealtimeState,
  closeRealtimeServer,
  WS_PATH,
  HEARTBEAT_INTERVAL_MS,
  CLOSE_CODE_AUTH_REQUIRED,
  CLOSE_CODE_AUTH_INVALID,
  CLOSE_CODE_HEARTBEAT,
};
