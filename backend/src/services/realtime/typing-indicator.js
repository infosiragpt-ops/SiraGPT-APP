'use strict';

/**
 * Typing-indicator state machine.
 *
 * The server keeps a small `Map<chatId, Map<userId, {expiresAt, timer}>>`.
 * When a client sends `typing.start`, the server records the user and
 * broadcasts to other chat members.  After 5 s without a renewal (or
 * an explicit `typing.stop`) the entry is removed and a `typing.stop`
 * is broadcast.
 */

const { EventEmitter } = require('events');

const DEFAULT_TTL_MS = 5_000;

class TypingIndicator extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.ttlMs = Number.isFinite(opts.ttlMs) ? opts.ttlMs : DEFAULT_TTL_MS;
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    /** @type {Map<string, Map<string, {expiresAt:number,timer:NodeJS.Timeout|null}>>} */
    this._chats = new Map();
  }

  _bucket(chatId) {
    let m = this._chats.get(chatId);
    if (!m) {
      m = new Map();
      this._chats.set(chatId, m);
    }
    return m;
  }

  /**
   * Record that `userId` is typing in `chatId`.
   * Returns `{started:boolean}` — true when this is a fresh typing session
   * so callers know whether to re-broadcast.
   */
  start(chatId, userId) {
    if (!chatId || !userId) {
      throw new TypeError('typing.start requires chatId and userId');
    }
    const bucket = this._bucket(chatId);
    const prev = bucket.get(userId);
    const expiresAt = this.now() + this.ttlMs;

    if (prev?.timer) clearTimeout(prev.timer);

    const timer = setTimeout(() => this._autoStop(chatId, userId), this.ttlMs);
    if (typeof timer.unref === 'function') timer.unref();

    bucket.set(userId, { expiresAt, timer });
    const started = !prev;
    if (started) this.emit('start', { chatId, userId, expiresAt });
    return { started, expiresAt };
  }

  stop(chatId, userId, { reason = 'explicit' } = {}) {
    const bucket = this._chats.get(chatId);
    if (!bucket) return { stopped: false };
    const entry = bucket.get(userId);
    if (!entry) return { stopped: false };
    if (entry.timer) clearTimeout(entry.timer);
    bucket.delete(userId);
    if (bucket.size === 0) this._chats.delete(chatId);
    this.emit('stop', { chatId, userId, reason });
    return { stopped: true };
  }

  _autoStop(chatId, userId) {
    this.stop(chatId, userId, { reason: 'timeout' });
  }

  /** @returns {string[]} userIds currently typing in chatId */
  whoIsTyping(chatId) {
    const bucket = this._chats.get(chatId);
    if (!bucket) return [];
    const now = this.now();
    const out = [];
    for (const [uid, entry] of bucket.entries()) {
      if (entry.expiresAt > now) out.push(uid);
    }
    return out;
  }

  dispose() {
    for (const bucket of this._chats.values()) {
      for (const e of bucket.values()) {
        if (e.timer) clearTimeout(e.timer);
      }
    }
    this._chats.clear();
    this.removeAllListeners();
  }
}

let _singleton = null;
function getTypingIndicator(opts) {
  if (!_singleton) _singleton = new TypingIndicator(opts);
  return _singleton;
}
function _resetForTests() {
  if (_singleton) _singleton.dispose();
  _singleton = null;
}

module.exports = { TypingIndicator, getTypingIndicator, _resetForTests };
