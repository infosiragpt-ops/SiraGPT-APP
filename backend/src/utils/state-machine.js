'use strict';

/**
 * state-machine — small declarative finite-state machine. Pairs with
 * the lease-mutex (#26, exactly-once jobs), the retry budget (#39),
 * and the bandit (#22) — when a flow has a finite number of states
 * with guarded transitions, an FSM is the right control structure
 * instead of a pile of booleans.
 *
 * The machine is value-semantics: `send(event)` returns a NEW
 * machine snapshot rather than mutating in place, so callers can
 * keep prior states for undo / time-travel debugging.
 *
 * Definition shape:
 *   {
 *     initial: 'idle',
 *     context: {},
 *     states: {
 *       idle:     { on: { START: 'running' } },
 *       running:  { on: {
 *                    STOP:  'idle',
 *                    FAIL:  { target: 'errored', guard, actions, assign }
 *                  } },
 *       errored:  { on: { RETRY: 'running' } },
 *     },
 *   }
 *
 * Transition entry can be a string (target only) or an object with:
 *   target   — next state name (required)
 *   guard    — (ctx, event) => bool; transition denied if false
 *   assign   — (ctx, event) => partialCtx (merged into context)
 *   actions  — [(ctx, event) => void] side-effect callbacks (caller's
 *              responsibility to keep them pure-ish; thrown errors
 *              surface via .send().errors[])
 *
 * Public API:
 *   const m = createMachine(definition)
 *   m.value                          → current state name
 *   m.context                        → current context
 *   m.can(event)                     → boolean
 *   m.send(event, payload?)          → new machine | { same machine, errors }
 *   m.matches(stateName)
 */

class MachineError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'MachineError';
    this.code = code;
  }
}

function normalizeTransition(t) {
  if (typeof t === 'string') return { target: t };
  if (t && typeof t === 'object' && typeof t.target === 'string') return t;
  throw new MachineError(`bad transition: ${JSON.stringify(t)}`, 'BAD_TRANSITION');
}

function createMachine(def) {
  if (!def || typeof def !== 'object') throw new MachineError('createMachine: definition required', 'BAD_DEF');
  if (typeof def.initial !== 'string' || !def.initial) throw new MachineError('initial state required', 'BAD_INITIAL');
  if (!def.states || typeof def.states !== 'object') throw new MachineError('states map required', 'BAD_STATES');
  if (!Object.prototype.hasOwnProperty.call(def.states, def.initial)) {
    throw new MachineError(`initial "${def.initial}" not in states`, 'BAD_INITIAL');
  }

  const states = def.states;

  function snapshot(value, context) {
    const ctxFrozen = context && typeof context === 'object' ? Object.freeze({ ...context }) : context;
    const m = {
      value,
      context: ctxFrozen,
      matches: (s) => value === s,
      can: (event) => Boolean(resolveTransition(value, event)),
      send: (event, payload) => stepFrom(value, ctxFrozen, event, payload),
    };
    return Object.freeze(m);
  }

  function resolveTransition(stateName, event) {
    const s = states[stateName];
    if (!s || !s.on || !Object.prototype.hasOwnProperty.call(s.on, event)) return null;
    return normalizeTransition(s.on[event]);
  }

  function stepFrom(stateName, context, event, payload) {
    const t = resolveTransition(stateName, event);
    const errors = [];
    if (!t) {
      // No transition — return same snapshot with errors hint.
      const same = snapshot(stateName, context);
      return Object.assign(Object.create(null), same, { errors: [{ code: 'NO_TRANSITION', event }] });
    }
    const evObj = { type: event, payload };
    if (typeof t.guard === 'function') {
      let ok;
      try { ok = Boolean(t.guard(context, evObj)); }
      catch (err) {
        errors.push({ code: 'GUARD_THREW', error: err.message });
        ok = false;
      }
      if (!ok) {
        const same = snapshot(stateName, context);
        return Object.assign(Object.create(null), same, { errors: [{ code: 'GUARD_DENIED', event }, ...errors] });
      }
    }
    let nextContext = context;
    if (typeof t.assign === 'function') {
      try {
        const partial = t.assign(context, evObj);
        if (partial && typeof partial === 'object') {
          nextContext = { ...(context || {}), ...partial };
        }
      } catch (err) {
        errors.push({ code: 'ASSIGN_THREW', error: err.message });
      }
    }
    if (Array.isArray(t.actions)) {
      for (const fn of t.actions) {
        if (typeof fn !== 'function') continue;
        try { fn(nextContext, evObj); }
        catch (err) { errors.push({ code: 'ACTION_THREW', error: err.message }); }
      }
    }
    if (!Object.prototype.hasOwnProperty.call(states, t.target)) {
      throw new MachineError(`transition target "${t.target}" not in states`, 'BAD_TARGET');
    }
    const next = snapshot(t.target, nextContext);
    return errors.length ? Object.assign(Object.create(null), next, { errors }) : next;
  }

  return snapshot(def.initial, def.context || {});
}

module.exports = {
  createMachine,
  MachineError,
};
