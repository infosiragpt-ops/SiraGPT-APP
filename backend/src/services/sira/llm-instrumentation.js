/**
 * llm-instrumentation — observability + circuit-breaker layer that
 * wraps the existing LLM gateway. Closes the LLM-Gateway-hardening
 * gap from the expanded vision (task 8).
 *
 * Why this exists
 * ---------------
 * `callUserSelectedModel` already delegates to `litellm-gateway`,
 * which returns `gateway_cost_usd` and `gateway_trace`. What was
 * missing was the cross-cutting *recording* layer:
 *
 *   - aggregated Prometheus metrics per provider/model
 *   - a per-provider circuit breaker that prevents a thundering herd
 *     against an upstream that has already started failing
 *   - an in-process cost ledger callers can query for budgets and
 *     dashboards without spinning up persistent storage
 *
 * Design
 * ------
 * Pure functions + a single-process state map. No DB, no Redis. If
 * you want durable cost tracking persist the records that
 * `getCostLedger()` returns; the in-process layer is the source of
 * truth for the *current* process lifetime, no more.
 *
 * The circuit breaker is the standard three-state machine:
 *
 *     closed ── N consecutive failures ──▶ open
 *        ▲                                   │
 *        │                                   │ cooldown elapsed
 *        │                                   ▼
 *        │              half_open ──── any failure ──▶ open
 *        │                  │
 *        │                  └────── any success ────▶ closed
 *        │
 *        └──────────────── success ─────────────────── (closed stays closed)
 *
 * In `half_open`, callers should still try the provider once — if
 * they call `isProviderAvailable` and it returns true, the breaker
 * has unlocked one trial call. Closed always returns true; open
 * always returns false.
 *
 * Wiring (intentionally not done in this commit so the diff stays
 * focused): `model-adapter.callUserSelectedModel` can call
 * `recordLlmCall(...)` after the gateway returns and short-circuit
 * with a `ToolError({code:"tool.circuit_open"})` if
 * `isProviderAvailable(provider)` is false. Until then, the
 * recorder is a stand-alone utility every call site can opt into.
 */

const {
  registerCounter,
  registerHistogram,
  registerGauge,
  counter,
  observe,
  gauge,
} = require("../agents/metrics");

// ── Metric registration ────────────────────────────────────────────

const LLM_DURATION_BUCKETS_MS = [
  100, 250, 500, 1000, 2500, 5000, 10000, 20000, 30000, 60000, 120000, 240000,
];

registerCounter("sira_llm_calls_total", {
  help: "LLM dispatch outcomes by provider, model, and terminal status",
  labels: ["provider", "model", "status"],
});
registerHistogram("sira_llm_call_duration_ms", {
  help: "Wall-clock duration of an LLM call",
  labels: ["provider", "model"],
  buckets: LLM_DURATION_BUCKETS_MS,
});
registerCounter("sira_llm_tokens_total", {
  help: "Approximate token volume by provider, model, and direction (input/output)",
  labels: ["provider", "model", "direction"],
});
registerCounter("sira_llm_cost_micro_usd_total", {
  help: "Cumulative LLM cost in micro-USD (1 unit = 0.000001 USD); scrape-side divide by 1e6",
  labels: ["provider", "model"],
});
registerGauge("sira_llm_circuit_state", {
  help: "Per-provider circuit breaker state: 0=closed, 1=half_open, 2=open",
  labels: ["provider"],
});

// ── Circuit breaker state ──────────────────────────────────────────

const CIRCUIT_DEFAULTS = Object.freeze({
  failuresToOpen: 5,        // consecutive failures that flip closed → open
  cooldownMs: 60_000,        // open → half_open after this much idle time
  successesToClose: 1,       // half_open successes needed to close
});

const STATE = {
  CLOSED: "closed",
  HALF_OPEN: "half_open",
  OPEN: "open",
};

function stateToGauge(s) {
  if (s === STATE.OPEN) return 2;
  if (s === STATE.HALF_OPEN) return 1;
  return 0;
}

function _emptyCircuit() {
  return {
    state: STATE.CLOSED,
    consecutiveFailures: 0,
    consecutiveHalfOpenSuccesses: 0,
    openedAt: 0,
  };
}

// Module-level state. Tests reset via `_resetForTests()`.
let _circuits = new Map();   // provider → circuit
let _ledger = [];             // append-only ring of recent calls
let _ledgerCap = 1000;
let _config = { ...CIRCUIT_DEFAULTS };
let _now = () => Date.now();  // injectable for deterministic tests

function _getCircuit(provider) {
  if (!_circuits.has(provider)) _circuits.set(provider, _emptyCircuit());
  return _circuits.get(provider);
}

function _setStateGauge(provider, state) {
  gauge("sira_llm_circuit_state", { provider }, stateToGauge(state));
}

// ── Public: configuration / test hooks ─────────────────────────────

function configure({ failuresToOpen, cooldownMs, successesToClose, ledgerCap, now } = {}) {
  if (Number.isFinite(failuresToOpen) && failuresToOpen >= 1) _config.failuresToOpen = failuresToOpen;
  if (Number.isFinite(cooldownMs) && cooldownMs >= 0) _config.cooldownMs = cooldownMs;
  if (Number.isFinite(successesToClose) && successesToClose >= 1) _config.successesToClose = successesToClose;
  if (Number.isFinite(ledgerCap) && ledgerCap > 0) _ledgerCap = ledgerCap;
  if (typeof now === "function") _now = now;
}

function _resetForTests() {
  _circuits = new Map();
  _ledger = [];
  _config = { ...CIRCUIT_DEFAULTS };
  _ledgerCap = 1000;
  _now = () => Date.now();
}

// ── Public: circuit queries ────────────────────────────────────────

function getCircuitState(provider) {
  if (!provider) return STATE.CLOSED;
  const c = _getCircuit(provider);
  if (c.state === STATE.OPEN && _now() - c.openedAt >= _config.cooldownMs) {
    // Cool-down elapsed → unlock one trial.
    c.state = STATE.HALF_OPEN;
    c.consecutiveHalfOpenSuccesses = 0;
    _setStateGauge(provider, c.state);
  }
  return c.state;
}

/**
 * Return false only when the circuit is fully open. half_open allows
 * one trial call; closed always allows.
 */
function isProviderAvailable(provider) {
  return getCircuitState(provider) !== STATE.OPEN;
}

// ── Public: recording ──────────────────────────────────────────────

/**
 * Append one record of an LLM call.
 *
 * @param {object} args
 * @param {{provider:string, modelId:string}} args.selectedModel
 * @param {number} [args.durationMs]
 * @param {{input_tokens?:number, output_tokens?:number}} [args.usage]
 * @param {number|null} [args.costUsd]
 * @param {"success"|"error"|"timeout"} [args.status="success"]
 * @param {string} [args.errorCode]   — populated when status !== "success"
 * @param {string} [args.userPlan]
 * @param {string} [args.userId]      — kept for caller-side aggregation; not labeled into metrics (cardinality)
 * @returns {object} the appended record
 */
function recordLlmCall(args = {}) {
  const selectedModel = args.selectedModel || {};
  const provider = String(selectedModel.provider || "unknown");
  const model = String(selectedModel.modelId || "unknown");
  const status = args.status || "success";

  // Metrics
  counter("sira_llm_calls_total", { provider, model, status });
  if (Number.isFinite(args.durationMs)) {
    observe("sira_llm_call_duration_ms", { provider, model }, args.durationMs);
  }
  const usage = args.usage || {};
  if (Number.isFinite(usage.input_tokens) && usage.input_tokens > 0) {
    counter("sira_llm_tokens_total", { provider, model, direction: "input" }, usage.input_tokens);
  }
  if (Number.isFinite(usage.output_tokens) && usage.output_tokens > 0) {
    counter("sira_llm_tokens_total", { provider, model, direction: "output" }, usage.output_tokens);
  }
  if (Number.isFinite(args.costUsd) && args.costUsd > 0) {
    // Prometheus counters are float64 so we *could* write fractional
    // dollars, but micro-USD keeps integers across thousands of calls
    // and avoids the small-number rounding that bites cost dashboards.
    counter("sira_llm_cost_micro_usd_total", { provider, model }, Math.round(args.costUsd * 1_000_000));
  }

  // Circuit breaker transitions
  const c = _getCircuit(provider);
  if (status === "success") {
    if (c.state === STATE.HALF_OPEN) {
      c.consecutiveHalfOpenSuccesses += 1;
      if (c.consecutiveHalfOpenSuccesses >= _config.successesToClose) {
        c.state = STATE.CLOSED;
        c.consecutiveFailures = 0;
        c.consecutiveHalfOpenSuccesses = 0;
        c.openedAt = 0;
      }
    } else {
      // closed stays closed; reset failure counter
      c.consecutiveFailures = 0;
    }
  } else {
    c.consecutiveFailures += 1;
    if (c.state === STATE.HALF_OPEN) {
      // any failure during the trial flips back to open
      c.state = STATE.OPEN;
      c.openedAt = _now();
      c.consecutiveHalfOpenSuccesses = 0;
    } else if (c.consecutiveFailures >= _config.failuresToOpen) {
      c.state = STATE.OPEN;
      c.openedAt = _now();
    }
  }
  _setStateGauge(provider, c.state);

  // Ledger
  const record = {
    ts: _now(),
    provider, model, status,
    error_code: args.errorCode || null,
    duration_ms: Number.isFinite(args.durationMs) ? args.durationMs : null,
    input_tokens: Number.isFinite(usage.input_tokens) ? usage.input_tokens : null,
    output_tokens: Number.isFinite(usage.output_tokens) ? usage.output_tokens : null,
    cost_usd: Number.isFinite(args.costUsd) ? args.costUsd : null,
    user_plan: args.userPlan || null,
    user_id: args.userId || null,
    circuit_state_after: c.state,
  };
  _ledger.push(record);
  if (_ledger.length > _ledgerCap) _ledger.splice(0, _ledger.length - _ledgerCap);
  return record;
}

// ── Public: ledger queries ─────────────────────────────────────────

/**
 * Return a copy of the recorded calls. Caller may filter by time
 * window. Mainly for tests, dashboards, and the `getCostSummary`
 * aggregation below.
 */
function getCostLedger({ since = 0, until = Infinity } = {}) {
  return _ledger.filter((r) => r.ts >= since && r.ts <= until).map((r) => ({ ...r }));
}

/**
 * Aggregate cost across the ledger. `dimensions` is a list of label
 * names whose combined key indexes the result. Defaults to per
 * provider+model.
 *
 * @returns {Object<key, { calls, cost_usd, input_tokens, output_tokens, failures }>}
 */
function getCostSummary({ since = 0, until = Infinity, dimensions = ["provider", "model"] } = {}) {
  const out = {};
  for (const r of _ledger) {
    if (r.ts < since || r.ts > until) continue;
    const key = dimensions.map((d) => `${d}=${r[d] != null ? r[d] : ""}`).join("|");
    if (!out[key]) out[key] = { calls: 0, cost_usd: 0, input_tokens: 0, output_tokens: 0, failures: 0 };
    out[key].calls += 1;
    if (Number.isFinite(r.cost_usd)) out[key].cost_usd += r.cost_usd;
    if (Number.isFinite(r.input_tokens)) out[key].input_tokens += r.input_tokens;
    if (Number.isFinite(r.output_tokens)) out[key].output_tokens += r.output_tokens;
    if (r.status !== "success") out[key].failures += 1;
  }
  // Round cost to 6 decimals to keep aggregations sane.
  for (const v of Object.values(out)) v.cost_usd = Math.round(v.cost_usd * 1e6) / 1e6;
  return out;
}

module.exports = {
  // Recording
  recordLlmCall,
  // Circuit
  getCircuitState,
  isProviderAvailable,
  STATE,
  // Ledger
  getCostLedger,
  getCostSummary,
  // Configuration / test hooks
  configure,
  _resetForTests,
  CIRCUIT_DEFAULTS,
};
