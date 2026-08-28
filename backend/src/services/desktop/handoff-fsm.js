'use strict';

/**
 * F7.4 — Handoff / takeover FSM for SiraComputer.
 *
 *   AGENT_CONTROL → HANDOFF_REQUESTED → HUMAN_CONTROL → RESUMING → AGENT_CONTROL
 *
 * The member can force takeover (grant) without the agent asking.
 * Abort / timeout pause the task and never declare success.
 *
 * Screen / typed text are DATA. Events never carry password field
 * values. Does not talk to the live computer orchestrator.
 *
 * In-memory only (Prisma HandoffEvent is optional later). No Drizzle.
 */

const { EventEmitter } = require('events');

const STATES = Object.freeze({
  AGENT_CONTROL: 'AGENT_CONTROL',
  HANDOFF_REQUESTED: 'HANDOFF_REQUESTED',
  HUMAN_CONTROL: 'HUMAN_CONTROL',
  RESUMING: 'RESUMING',
});

const EVENT_TYPES = Object.freeze({
  REQUESTED: 'handoff_requested',
  GRANTED: 'handoff_granted',
  RETURNED: 'handoff_returned',
  TIMEOUT: 'handoff_timeout',
});

const ACTIONS = Object.freeze(['request', 'grant', 'return']);

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const HUMAN_LOCKED_ES = 'El escritorio está en control humano (423 Locked).';
const INVALID_ACTION_ES = 'Acción de handoff no válida. Usa request, grant o return.';
const INVALID_TRANSITION_ES = 'Transición de handoff no permitida.';

function clampTimeout(raw, fallback = DEFAULT_TIMEOUT_MS) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(15 * 60 * 1000, Math.max(50, n));
}

function sanitizeReason(reason) {
  const t = String(reason == null ? '' : reason).slice(0, 240);
  if (!t) return '';
  if (/\b(password|passwd|contrase[nñ]a|otp|2fa|totp|cvv|cvc|secret|token)\b\s*[:=]/i.test(t)) {
    return 'human_needed';
  }
  return t;
}

function makeEvent(type, extra = {}) {
  return {
    type,
    at: extra.at || Date.now(),
    reason: extra.reason ? sanitizeReason(extra.reason) : undefined,
    actor: extra.actor || undefined,
  };
}

class HandoffFsm extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {string} [opts.sessionId]
   * @param {function} [opts.now]
   * @param {number} [opts.timeoutMs]
   * @param {function} [opts.onEvent]  optional SSE / stage hook
   */
  constructor(opts = {}) {
    super();
    this.sessionId = String(opts.sessionId || '');
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    this.timeoutMs = clampTimeout(opts.timeoutMs, DEFAULT_TIMEOUT_MS);
    this._onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : null;
    this.state = STATES.AGENT_CONTROL;
    this.events = [];
    this._waiters = [];
    this._timer = null;
    this._aborted = false;
    this._timedOut = false;
    this._pendingResume = null;
  }

  snapshot() {
    return {
      sessionId: this.sessionId,
      state: this.state,
      inputMode: this.inputMode(),
      screenshotsPaused: this.screenshotsPaused(),
      timedOut: this._timedOut,
      aborted: this._aborted,
      events: this.events.map((e) => ({ ...e })),
    };
  }

  inputMode() {
    return this.state === STATES.HUMAN_CONTROL || this.state === STATES.HANDOFF_REQUESTED
      ? 'human'
      : 'agent';
  }

  screenshotsPaused() {
    return this.state === STATES.HUMAN_CONTROL || this.state === STATES.HANDOFF_REQUESTED;
  }

  isHumanControl() {
    return this.state === STATES.HUMAN_CONTROL;
  }

  isAgentControl() {
    return this.state === STATES.AGENT_CONTROL;
  }

  _push(type, extra) {
    const ev = makeEvent(type, { ...extra, at: this.now() });
    this.events.push(ev);
    this.emit(type, ev);
    this.emit('handoff', ev);
    if (this._onEvent) {
      try { this._onEvent(ev); } catch (_) { /* never break the FSM */ }
    }
    return ev;
  }

  _armTimeout() {
    this._clearTimeout();
    if (this.timeoutMs <= 0) return;
    this._timer = setTimeout(() => {
      this.timeout();
    }, this.timeoutMs);
    if (typeof this._timer.unref === 'function') this._timer.unref();
  }

  _clearTimeout() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  _settleWaiters(result) {
    const waiters = this._waiters.splice(0);
    for (const w of waiters) {
      try { w.resolve(result); } catch (_) { /* ignore */ }
    }
  }

  /**
   * Agent asks the member to take the desktop (login / captcha / payment).
   */
  request(opts = {}) {
    if (this.state === STATES.HANDOFF_REQUESTED) {
      return this.snapshot();
    }
    if (this.state === STATES.HUMAN_CONTROL) {
      return this.snapshot();
    }
    if (this.state !== STATES.AGENT_CONTROL && this.state !== STATES.RESUMING) {
      const err = new Error(INVALID_TRANSITION_ES);
      err.code = 'handoff_invalid_transition';
      err.status = 409;
      throw err;
    }
    this.state = STATES.HANDOFF_REQUESTED;
    this._push(EVENT_TYPES.REQUESTED, { reason: opts.reason || 'human_needed', actor: opts.actor || 'agent' });
    this._armTimeout();
    return this.snapshot();
  }

  /**
   * Member takes the desktop. Allowed from AGENT_CONTROL (force) or
   * HANDOFF_REQUESTED (agent asked).
   */
  grant(opts = {}) {
    if (this.state === STATES.HUMAN_CONTROL) {
      return this.snapshot();
    }
    if (this.state === STATES.RESUMING) {
      const err = new Error(INVALID_TRANSITION_ES);
      err.code = 'handoff_invalid_transition';
      err.status = 409;
      throw err;
    }
    this.state = STATES.HUMAN_CONTROL;
    this._push(EVENT_TYPES.GRANTED, { reason: opts.reason, actor: opts.actor || 'user' });
    this._armTimeout();
    return this.snapshot();
  }

  /**
   * Member returns the desktop. Loop may resume with a NEW screenshot.
   */
  returnControl(opts = {}) {
    if (this.state !== STATES.HUMAN_CONTROL && this.state !== STATES.HANDOFF_REQUESTED) {
      if (this.state === STATES.AGENT_CONTROL) return this.snapshot();
      const err = new Error(INVALID_TRANSITION_ES);
      err.code = 'handoff_invalid_transition';
      err.status = 409;
      throw err;
    }
    this._clearTimeout();
    this.state = STATES.RESUMING;
    this._push(EVENT_TYPES.RETURNED, { reason: opts.reason, actor: opts.actor || 'user' });
    const result = {
      resumed: true,
      status: EVENT_TYPES.RETURNED,
      ok: true,
    };
    if (this._waiters.length) this._settleWaiters(result);
    else this._pendingResume = result;
    this.state = STATES.AGENT_CONTROL;
    this._timedOut = false;
    this._aborted = false;
    return this.snapshot();
  }

  timeout() {
    if (this.state === STATES.AGENT_CONTROL) return this.snapshot();
    if (this._timedOut) {
      this._settleWaiters({
        resumed: false,
        status: EVENT_TYPES.TIMEOUT,
        ok: false,
      });
      return this.snapshot();
    }
    this._clearTimeout();
    this._timedOut = true;
    this._push(EVENT_TYPES.TIMEOUT, { actor: 'system' });
    this._settleWaiters({
      resumed: false,
      status: EVENT_TYPES.TIMEOUT,
      ok: false,
    });
    return this.snapshot();
  }

  abort(opts = {}) {
    this._aborted = true;
    this._clearTimeout();
    this._settleWaiters({
      resumed: false,
      status: 'cancelled',
      ok: false,
      reason: opts.reason || 'aborted',
    });
    return this.snapshot();
  }

  /**
   * CU-loop hook. Resolves when the member returns, or when abort/timeout
   * pauses the task (never as success). If the FSM is still AGENT_CONTROL
   * and nobody requested, returns immediately so F7.3 can exit.
   */
  waitForResume(opts = {}) {
    if (this._pendingResume) {
      const pending = this._pendingResume;
      this._pendingResume = null;
      return Promise.resolve(pending);
    }
    if (this._timedOut) {
      return Promise.resolve({ resumed: false, status: EVENT_TYPES.TIMEOUT, ok: false });
    }
    if (this._aborted || (opts.signal && opts.signal.aborted)) {
      return Promise.resolve({ resumed: false, status: 'cancelled', ok: false });
    }
    if (this.state === STATES.AGENT_CONTROL) {
      return Promise.resolve({ resumed: false, status: EVENT_TYPES.REQUESTED, ok: false, waited: false });
    }
    if (this.state === STATES.RESUMING) {
      return Promise.resolve({ resumed: true, status: EVENT_TYPES.RETURNED, ok: true });
    }
    return new Promise((resolve) => {
      let settled = false;
      let extraTimer = null;
      const settle = (result) => {
        if (settled) return;
        settled = true;
        if (extraTimer) {
          clearTimeout(extraTimer);
          extraTimer = null;
        }
        if (opts.signal) {
          try { opts.signal.removeEventListener('abort', onAbort); } catch (_) { /* ignore */ }
        }
        resolve(result);
      };
      const waiter = { resolve: settle };
      this._waiters.push(waiter);
      const onAbort = () => {
        this._waiters = this._waiters.filter((w) => w !== waiter);
        settle({ resumed: false, status: 'cancelled', ok: false });
      };
      if (opts.signal) {
        if (opts.signal.aborted) {
          onAbort();
          return;
        }
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
      const extraMs = Number(opts.timeoutMs);
      if (Number.isFinite(extraMs) && extraMs > 0) {
        extraTimer = setTimeout(() => {
          this.timeout();
        }, extraMs);
      }
    });
  }

  apply(action, opts = {}) {
    const verb = String(action || '').trim().toLowerCase();
    if (verb === 'request') return this.request(opts);
    if (verb === 'grant') return this.grant(opts);
    if (verb === 'return') return this.returnControl(opts);
    const err = new Error(INVALID_ACTION_ES);
    err.code = 'handoff_action_invalid';
    err.status = 400;
    throw err;
  }
}

function createHandoffFsm(opts) {
  return new HandoffFsm(opts);
}

module.exports = {
  HandoffFsm,
  createHandoffFsm,
  STATES,
  EVENT_TYPES,
  ACTIONS,
  DEFAULT_TIMEOUT_MS,
  HUMAN_LOCKED_ES,
  INVALID_ACTION_ES,
  INVALID_TRANSITION_ES,
  clampTimeout,
  sanitizeReason,
};
