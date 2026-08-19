/**
 * turn-events — typed event stream for a single chat turn.
 *
 * From the expanded vision, step #14-15: "El LLM genera respuesta con
 * streaming. Frontend muestra la respuesta progresivamente." Today the
 * chat-controller returns one big JSON object after every stage has
 * completed — the client cannot show "thinking…" / "validating…" /
 * "citation found" beats while the turn is in flight.
 *
 * What this module is
 * -------------------
 * A small, pluggable event sink the chat-controller emits into at
 * every meaningful boundary. Consumers translate the event stream into:
 *
 *   - SSE on the HTTP response  (createSSEEvents)
 *   - WebSocket frames           (caller-supplied wrapper)
 *   - In-memory buffer for tests (createBufferedEvents)
 *   - Discarded                  (createNoOpEvents — default)
 *
 * The chat-controller does not need to know which sink it is calling.
 * It just calls `events.emit(name, data)`.
 *
 * Event vocabulary
 * ----------------
 * Eight canonical events, mirrored 1:1 with the audit log so an SSE
 * consumer's view of a turn matches what compliance/replay sees later:
 *
 *   turn_started               — turn opened, request_id minted
 *   token_budget_checked       — preflight result; may carry violations
 *   turn_blocked_token_budget  — only fires when budget exceeded
 *   project_context_loaded     — projectId resolved, members + docs
 *   envelope_built             — engine returned ok bundle
 *   chat_mode_resolved         — mode decided, tool plan filtered
 *   context_compacted          — compaction summary
 *   clarification_requested    — policy asks user; turn ends early
 *   runtime_completed          — execution_trace + counters
 *   citation_frame_built       — coverage_ratio + sources_cited
 *   turn_completed             — terminal stage + token usage
 *
 * Each event has a `request_id` and a content-free payload (same
 * privacy posture as audit_log).
 *
 * Design properties
 * -----------------
 *   - Emit is sync (no awaiting) so chat-controller stages stay
 *     deterministic. Sinks that need async work (network writes)
 *     queue internally.
 *   - Errors thrown by a sink are swallowed at the boundary so a
 *     misbehaving consumer never poisons the turn — same posture as
 *     the metrics recorder.
 *   - The default `createNoOpEvents()` is the chat-controller's
 *     fallback so callers that don't ask for streaming pay no cost.
 */

const EVENT_NAMES = Object.freeze([
  "turn_started",
  "token_budget_checked",
  "turn_blocked_token_budget",
  "project_context_loaded",
  "project_access_denied",
  "memory_recalled",
  "envelope_built",
  "envelope_invalid",
  "chat_mode_resolved",
  "context_compacted",
  "clarification_requested",
  "runtime_completed",
  "citation_frame_built",
  "token_usage_recorded",
  "token_usage_ledger_error",
  "memory_persisted",
  "turn_completed",
]);

function _safeEmit(sink, name, data) {
  try {
    return sink(name, data);
  } catch (_e) {
    // Sinks must never poison the turn. Errors get dropped here; the
    // chat-controller continues.
    return undefined;
  }
}

/**
 * No-op default. Fastest possible: emit returns undefined.
 */
function createNoOpEvents() {
  return {
    emit() {},
    end() {},
    isLive() { return false; },
  };
}

/**
 * Buffer every emit into an in-memory list. Used in tests.
 *
 * Returned object:
 *   .emit(name, data)
 *   .end()             — appends a synthetic "_end" marker
 *   .events            — array of { name, data, ts }
 *   .isLive()          — false once .end() is called
 *   .by(name)          — events filtered by name
 */
function createBufferedEvents() {
  const events = [];
  let live = true;
  return {
    emit(name, data) {
      if (!live) return;
      events.push({ name, data: data || null, ts: Date.now() });
    },
    end() {
      live = false;
      events.push({ name: "_end", data: null, ts: Date.now() });
    },
    events,
    isLive() { return live; },
    by(name) { return events.filter((e) => e.name === name); },
  };
}

/**
 * SSE writer. Converts emits into `event:` + `data:` lines on a
 * Node http response. Compatible with the standard `EventSource`
 * client API in browsers.
 *
 * @param {object} res                   — Node http response
 * @param {object} [opts]
 * @param {string} [opts.requestId]      — pinned onto every emit
 * @param {Function} [opts.onEnd]        — called after end() completes
 * @param {Function} [opts.serialize]    — overrides JSON.stringify
 *                                          (e.g. to strip nulls)
 */
function createSSEEvents(res, { requestId = null, onEnd = null, serialize = null } = {}) {
  if (!res || typeof res.write !== "function") {
    throw new Error("turn-events: createSSEEvents requires a writable Node response");
  }
  const ser = typeof serialize === "function" ? serialize : (v) => JSON.stringify(v);
  let live = true;
  // Headers must be set before the first write.
  if (typeof res.setHeader === "function") {
    if (!res.headersSent) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      // Disable proxy buffering so events arrive promptly through
      // common reverse proxies (nginx, Cloudflare, etc.).
      res.setHeader("X-Accel-Buffering", "no");
    }
  }
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  function write(name, data) {
    if (!live) return;
    let payload;
    try {
      payload = ser({ ...data, request_id: data?.request_id || requestId });
    } catch {
      payload = ser({ error: "unserializable_payload" });
    }
    try {
      res.write(`event: ${name}\n`);
      res.write(`data: ${payload}\n\n`);
    } catch {
      live = false;
    }
  }
  return {
    emit(name, data) { _safeEmit(write, name, data); },
    end() {
      if (!live) return;
      try { res.write(`event: _end\ndata: {}\n\n`); } catch {}
      try { res.end(); } catch {}
      live = false;
      if (typeof onEnd === "function") {
        try { onEnd(); } catch {}
      }
    },
    isLive() { return live; },
  };
}

module.exports = {
  EVENT_NAMES,
  createNoOpEvents,
  createBufferedEvents,
  createSSEEvents,
};
