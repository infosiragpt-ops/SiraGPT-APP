'use strict';

/**
 * Cursor / selection sharing for collaborative Cowork documents.
 *
 * Lightweight protocol:
 *   - `cursor:update {x, y}`                   — pointer / caret position
 *   - `selection:update {anchor, head}`        — text-range selection
 *
 * Server-side throttling: per (chatId,userId) we only forward at most one
 * update every `THROTTLE_MS` (default 50 ms).  The most recent payload
 * always wins (last-write-wins), and a trailing flush is scheduled so we
 * don't drop the final stationary frame.
 */

const DEFAULT_THROTTLE_MS = 50;

function _validatePoint(p) {
  if (!p || typeof p !== 'object') return null;
  const x = Number(p.x);
  const y = Number(p.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function _validateSelection(sel) {
  if (!sel || typeof sel !== 'object') return null;
  const anchor = Number(sel.anchor);
  const head = Number(sel.head);
  if (!Number.isFinite(anchor) || !Number.isFinite(head)) return null;
  return { anchor, head };
}

class CursorThrottler {
  /**
   * @param {object} [opts]
   * @param {number} [opts.throttleMs=50]
   * @param {(payload:object)=>void} opts.broadcast — invoked with throttled payload
   * @param {()=>number} [opts.now]
   */
  constructor(opts = {}) {
    this.throttleMs = Number.isFinite(opts.throttleMs) ? opts.throttleMs : DEFAULT_THROTTLE_MS;
    if (typeof opts.broadcast !== 'function') {
      throw new TypeError('CursorThrottler requires { broadcast }');
    }
    this.broadcast = opts.broadcast;
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    /** @type {Map<string,{lastSent:number,timer:NodeJS.Timeout|null,pending:object|null}>} */
    this._state = new Map();
  }

  _key(chatId, userId) { return `${chatId}::${userId}`; }

  /**
   * Submit a cursor update. Returns the payload that will be (or was)
   * broadcast, or `null` if throttled and waiting for trailing flush.
   */
  submit({ chatId, userId, type, data }) {
    if (!chatId || !userId) throw new TypeError('cursor.submit requires chatId/userId');
    let normalized;
    if (type === 'cursor:update') normalized = _validatePoint(data);
    else if (type === 'selection:update') normalized = _validateSelection(data);
    else throw new TypeError(`unknown cursor event: ${type}`);
    if (!normalized) throw new TypeError(`invalid payload for ${type}`);

    const payload = { type, chatId, userId, data: normalized, at: this.now() };
    const key = this._key(chatId, userId);
    let st = this._state.get(key);
    if (!st) {
      st = { lastSent: 0, timer: null, pending: null };
      this._state.set(key, st);
    }
    const elapsed = this.now() - st.lastSent;
    if (elapsed >= this.throttleMs) {
      st.lastSent = this.now();
      st.pending = null;
      if (st.timer) { clearTimeout(st.timer); st.timer = null; }
      this.broadcast(payload);
      return payload;
    }
    // throttled — schedule trailing flush with most recent payload
    st.pending = payload;
    if (!st.timer) {
      const wait = Math.max(1, this.throttleMs - elapsed);
      const t = setTimeout(() => {
        st.timer = null;
        if (st.pending) {
          st.lastSent = this.now();
          const out = st.pending;
          st.pending = null;
          this.broadcast(out);
        }
      }, wait);
      if (typeof t.unref === 'function') t.unref();
      st.timer = t;
    }
    return null;
  }

  /** Drop in-flight state for a user (e.g. on disconnect). */
  clear(chatId, userId) {
    const key = this._key(chatId, userId);
    const st = this._state.get(key);
    if (!st) return;
    if (st.timer) clearTimeout(st.timer);
    this._state.delete(key);
  }

  dispose() {
    for (const st of this._state.values()) {
      if (st.timer) clearTimeout(st.timer);
    }
    this._state.clear();
  }
}

module.exports = { CursorThrottler, DEFAULT_THROTTLE_MS };
