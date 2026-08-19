'use strict';

/**
 * typed-event-bus — schema-validated pub/sub. Pairs with mini-schema
 * (#60) for payload validation, the structured logger (#43) for
 * traceability, and the skills snapshot cache (#5) which already
 * subscribes to event names: this is the typed version of that
 * pattern, where the caller declares { eventName: schema } at boot
 * and the bus rejects malformed payloads before fan-out.
 *
 * Schema enforcement is opt-in per event: if no schema was registered
 * for an event name the bus passes the payload through unchanged. So
 * legacy / dynamic event names still work; typed events get the
 * validation guard.
 *
 * Public API:
 *   const bus = createTypedEventBus({ onError })
 *   bus.register(eventName, schema)        — schema = mini-schema
 *   bus.on(eventName, handler)             → unsubscribe()
 *   bus.once(eventName, handler)           → unsubscribe()
 *   bus.emit(eventName, payload)
 *     → { ok, delivered }                  (synchronous fan-out)
 *     → { ok: false, reason, errors? }     when validation fails
 *   bus.snapshot()                         → counters
 */

class TypedBusError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'TypedBusError';
    this.code = code;
  }
}

function createTypedEventBus(opts = {}) {
  const onError = typeof opts.onError === 'function' ? opts.onError : null;
  const handlers = new Map();
  const schemas = new Map();
  const counters = { emitted: 0, delivered: 0, dropped: 0, schemaRejected: 0 };

  function register(eventName, schema) {
    if (typeof eventName !== 'string' || !eventName) throw new TypedBusError('register: eventName required', 'BAD_EVENT');
    if (!schema || typeof schema.safeParse !== 'function') {
      throw new TypedBusError('register: schema with .safeParse required', 'BAD_SCHEMA');
    }
    schemas.set(eventName, schema);
  }

  function _add(eventName, handler, once) {
    if (typeof eventName !== 'string' || !eventName) throw new TypedBusError('on: eventName required', 'BAD_EVENT');
    if (typeof handler !== 'function') throw new TypedBusError('on: handler required', 'BAD_HANDLER');
    let set = handlers.get(eventName);
    if (!set) { set = new Set(); handlers.set(eventName, set); }
    const entry = { fn: handler, once, removed: false };
    set.add(entry);
    return () => {
      entry.removed = true;
      set.delete(entry);
      if (set.size === 0) handlers.delete(eventName);
    };
  }

  function on(eventName, handler) { return _add(eventName, handler, false); }
  function once(eventName, handler) { return _add(eventName, handler, true); }

  function emit(eventName, payload) {
    counters.emitted += 1;
    if (typeof eventName !== 'string' || !eventName) {
      counters.dropped += 1;
      return { ok: false, reason: 'bad_event' };
    }
    const schema = schemas.get(eventName);
    let validated = payload;
    if (schema) {
      const r = schema.safeParse(payload);
      if (!r.ok) {
        counters.schemaRejected += 1;
        return { ok: false, reason: 'schema_invalid', errors: r.errors };
      }
      validated = r.value;
    }
    const set = handlers.get(eventName);
    if (!set || set.size === 0) {
      return { ok: true, delivered: 0 };
    }
    let delivered = 0;
    // Snapshot before iteration so once-handlers that unsubscribe
    // mid-fan-out don't disturb the walk.
    for (const entry of [...set]) {
      if (entry.removed) continue;
      try {
        entry.fn(validated, eventName);
        delivered += 1;
      } catch (err) {
        if (onError) {
          try { onError(err, eventName); } catch { /* swallow */ }
        }
      }
      if (entry.once) {
        entry.removed = true;
        set.delete(entry);
      }
    }
    if (set.size === 0) handlers.delete(eventName);
    counters.delivered += delivered;
    return { ok: true, delivered };
  }

  function snapshot() {
    return {
      ...counters,
      eventsRegistered: schemas.size,
      eventsWithSubscribers: handlers.size,
    };
  }

  return { register, on, once, emit, snapshot };
}

module.exports = {
  createTypedEventBus,
  TypedBusError,
};
