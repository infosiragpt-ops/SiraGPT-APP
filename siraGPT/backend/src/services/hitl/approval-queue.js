/**
 * approval-queue — in-memory Human-in-the-Loop approval queue.
 *
 * Any agent action whose manifest declares `requires_confirmation`
 * or whose ExecutionGraph node sets `release_gate.requires_human`
 * lands here as an ApprovalRequest. A human reviewer reads the
 * request, inspects the staged payload, and either approves,
 * rejects, or lets it time out.
 *
 * The queue is intentionally a pure data structure: a persistence
 * adapter (DB, Redis) wraps this for production; tests feed it
 * synchronously. State transitions are explicit so crash recovery
 * can replay the event log.
 *
 * Request lifecycle:
 *   pending → approved | rejected | timed_out | cancelled
 *
 * Every transition is final; callers never mutate a closed request.
 */

const crypto = require("crypto");

const REQUEST_STATES = Object.freeze(["pending", "approved", "rejected", "timed_out", "cancelled"]);

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours
const MIN_TIMEOUT_MS = 30 * 1000;

function newId() {
  return `apr_${crypto.randomBytes(8).toString("hex")}`;
}

/**
 * Create a queue instance. Tests instantiate their own; production
 * wraps this in a persistence adapter.
 */
function createApprovalQueue({ clock } = {}) {
  const now = () => (clock ? clock() : Date.now());
  const requests = new Map();
  const listeners = new Set();

  function emit(event) {
    for (const fn of listeners) {
      try { fn(event); } catch { /* listeners must not throw */ }
    }
  }

  function validateRequest(req) {
    const errors = [];
    if (!req || typeof req !== "object") errors.push("request must be an object");
    if (!req?.action || typeof req.action !== "string") errors.push("action (string) required");
    if (!req?.requested_by || typeof req.requested_by !== "string") errors.push("requested_by (userId) required");
    if (!Array.isArray(req?.approvers_allowed)) errors.push("approvers_allowed must be an array of userIds");
    if (!req?.approvers_allowed?.length) errors.push("approvers_allowed must not be empty");
    if (req?.side_effect_level && !["none", "local-fs", "remote-read", "remote-write", "destructive"].includes(req.side_effect_level)) {
      errors.push("side_effect_level is not a known category");
    }
    const t = Number(req?.timeout_ms ?? DEFAULT_TIMEOUT_MS);
    if (!Number.isFinite(t) || t < MIN_TIMEOUT_MS || t > MAX_TIMEOUT_MS) {
      errors.push(`timeout_ms must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`);
    }
    return errors;
  }

  function enqueue(partial) {
    const errors = validateRequest(partial);
    if (errors.length) {
      const e = new Error(`approval-queue: invalid request — ${errors.join("; ")}`);
      e.errors = errors;
      throw e;
    }
    const id = partial.id || newId();
    if (requests.has(id)) throw new Error(`approval-queue: duplicate id "${id}"`);
    const createdAt = now();
    const timeout_ms = Number(partial.timeout_ms ?? DEFAULT_TIMEOUT_MS);
    const record = {
      id,
      action: partial.action,
      requested_by: partial.requested_by,
      approvers_allowed: [...partial.approvers_allowed],
      side_effect_level: partial.side_effect_level || "remote-write",
      payload: partial.payload ?? null,
      context: partial.context ?? null,
      state: "pending",
      createdAt,
      expiresAt: createdAt + timeout_ms,
      timeout_ms,
      decidedAt: null,
      decided_by: null,
      decision_note: null,
      history: [{ state: "pending", at: createdAt, actor: partial.requested_by }],
    };
    requests.set(id, record);
    emit({ type: "enqueued", request: { ...record } });
    return { ...record };
  }

  function list({ state } = {}) {
    const all = Array.from(requests.values());
    if (!state) return all.map(r => ({ ...r }));
    return all.filter(r => r.state === state).map(r => ({ ...r }));
  }

  function get(id) {
    const r = requests.get(id);
    return r ? { ...r } : null;
  }

  function transition(id, nextState, { actor, note } = {}) {
    const r = requests.get(id);
    if (!r) throw new Error(`approval-queue: request "${id}" not found`);
    if (r.state !== "pending") throw new Error(`approval-queue: request "${id}" is already ${r.state}`);
    if (!REQUEST_STATES.includes(nextState)) throw new Error(`approval-queue: unknown state "${nextState}"`);
    if (nextState === "pending") throw new Error("approval-queue: cannot transition back to pending");
    if ((nextState === "approved" || nextState === "rejected") && actor) {
      if (!r.approvers_allowed.includes(actor)) {
        throw new Error(`approval-queue: actor "${actor}" is not in approvers_allowed`);
      }
    }
    const at = now();
    r.state = nextState;
    r.decidedAt = at;
    r.decided_by = actor || null;
    r.decision_note = note || null;
    r.history.push({ state: nextState, at, actor: actor || "system", note: note || null });
    emit({ type: "decided", request: { ...r } });
    return { ...r };
  }

  function approve(id, { actor, note } = {}) { return transition(id, "approved", { actor, note }); }
  function reject(id, { actor, note } = {}) { return transition(id, "rejected", { actor, note }); }
  function cancel(id, { actor, note } = {}) { return transition(id, "cancelled", { actor, note }); }

  function reapTimedOut() {
    const n = now();
    const reaped = [];
    for (const r of requests.values()) {
      if (r.state === "pending" && n >= r.expiresAt) {
        r.state = "timed_out";
        r.decidedAt = n;
        r.decided_by = "system";
        r.history.push({ state: "timed_out", at: n, actor: "system" });
        reaped.push({ ...r });
        emit({ type: "timed_out", request: { ...r } });
      }
    }
    return reaped;
  }

  function stats() {
    const counts = { pending: 0, approved: 0, rejected: 0, timed_out: 0, cancelled: 0 };
    for (const r of requests.values()) counts[r.state] = (counts[r.state] || 0) + 1;
    return { total: requests.size, counts };
  }

  function addListener(fn) {
    if (typeof fn !== "function") throw new Error("approval-queue: listener must be a function");
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return {
    enqueue,
    list,
    get,
    approve,
    reject,
    cancel,
    transition,
    reapTimedOut,
    stats,
    addListener,
  };
}

module.exports = {
  createApprovalQueue,
  REQUEST_STATES,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
};
