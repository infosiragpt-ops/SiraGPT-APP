'use strict';

const {
  escapePrometheusLabelValue,
} = require('../utils/prometheus-labels');

/**
 * cognitive-metrics.js — Phase 6 observability for the cognitive core.
 * ───────────────────────────────────────────────────────────────────────────
 * Tiny in-memory, dependency-free counters that record what the reasoning
 * orchestrator decided and how the faithfulness gate graded each turn, so we
 * can answer questions a professional platform must answer:
 *   - How often does the router escalate, and from/to which models?
 *   - What's the difficulty/risk mix of real traffic?
 *   - What faithfulness grade do answers get, per model?
 *   - How much test-time compute are we spending?
 *
 * Mirrors the existing free-ia-metrics pattern: record* mutators, snapshot()
 * JSON, and a Prometheus text exposition. Bounded cardinality (model labels
 * are capped) so it can't blow up memory. Reset for tests.
 *
 * Public API:
 *   recordRoutingDecision(decision)   recordFaithfulness({grade,action,model})
 *   recordCompute({mode})             recordTurnPolicy(policy)
 *   snapshot()   toPrometheusText()   reset()
 */

const MAX_MODEL_LABELS = Number(process.env.SIRAGPT_COGNITIVE_METRICS_MAX_MODELS) || 40;

function freshState() {
  return {
    startedAt: Date.now(),
    routing: {
      total: 0,
      byAction: Object.create(null),       // keep | escalate | downgrade | auto_select
      byDifficulty: Object.create(null),   // trivial | simple | moderate | complex
      byRisk: Object.create(null),         // low | medium | high
      byMode: Object.create(null),         // off | escalate | auto
      changed: 0,                          // model actually re-routed
      escalations: Object.create(null),    // "from→to" → count
    },
    faithfulness: {
      total: 0,
      annotated: 0,                        // turns that got a fidelity footer
      byGrade: Object.create(null),        // A..F
      byModel: Object.create(null),        // model → { total, annotated }
    },
    compute: {
      total: 0,
      byMode: Object.create(null),         // direct | extended | self_consistency | best_of_n
    },
    turnPolicy: {
      total: 0,
      byMode: Object.create(null),         // observe | enforce
      agentic: 0,
      byToolCallMode: Object.create(null), // native | prompted | none
      shadowDiffs: 0,
    },
  };
}

let state = freshState();

function bump(obj, key, by = 1) {
  if (key == null || key === '') return;
  obj[key] = (obj[key] || 0) + by;
}

function capLabel(obj, key, by = 1, max = MAX_MODEL_LABELS) {
  if (key == null || key === '') return;
  if (!(key in obj) && Object.keys(obj).length >= max) {
    bump(obj, '__other__', by);
    return;
  }
  bump(obj, key, by);
}

function recordRoutingDecision(decision) {
  try {
    const r = decision && decision.routing;
    if (!r) return;
    state.routing.total += 1;
    bump(state.routing.byAction, r.action || 'keep');
    bump(state.routing.byDifficulty, (decision.difficulty && decision.difficulty.bucket) || 'unknown');
    bump(state.routing.byRisk, (decision.risk && decision.risk.level) || 'low');
    bump(state.routing.byMode, r.mode || 'off');
    if (r.changed) {
      state.routing.changed += 1;
      const from = (r.userModel || '?');
      const to = (r.selectedModel || '?');
      capLabel(state.routing.escalations, `${from}→${to}`);
    }
  } catch (_) { /* metrics must never throw */ }
}

function recordFaithfulness({ grade = null, action = null, model = null } = {}) {
  try {
    state.faithfulness.total += 1;
    if (grade) bump(state.faithfulness.byGrade, String(grade));
    if (action === 'annotate') state.faithfulness.annotated += 1;
    if (model) {
      const m = state.faithfulness.byModel;
      if (!(model in m) && Object.keys(m).length >= MAX_MODEL_LABELS) {
        // fold into __other__
        m.__other__ = m.__other__ || { total: 0, annotated: 0 };
        m.__other__.total += 1;
        if (action === 'annotate') m.__other__.annotated += 1;
      } else {
        m[model] = m[model] || { total: 0, annotated: 0 };
        m[model].total += 1;
        if (action === 'annotate') m[model].annotated += 1;
      }
    }
  } catch (_) { /* swallow */ }
}

function recordCompute({ mode = null } = {}) {
  try {
    state.compute.total += 1;
    bump(state.compute.byMode, mode || 'direct');
  } catch (_) { /* swallow */ }
}

function recordTurnPolicy(policy) {
  try {
    if (!policy || typeof policy !== 'object') return;
    state.turnPolicy.total += 1;
    bump(state.turnPolicy.byMode, policy.mode || 'observe');
    if (policy.routing && policy.routing.shouldRunAgentic) state.turnPolicy.agentic += 1;
    bump(
      state.turnPolicy.byToolCallMode,
      (policy.capabilities && policy.capabilities.toolCallMode) || 'native',
    );
    const diffs = policy.telemetry && Array.isArray(policy.telemetry.shadowDiffs)
      ? policy.telemetry.shadowDiffs.length
      : 0;
    if (diffs > 0) state.turnPolicy.shadowDiffs += diffs;
  } catch (_) { /* swallow */ }
}

function snapshot() {
  return {
    uptimeMs: Date.now() - state.startedAt,
    routing: {
      total: state.routing.total,
      changed: state.routing.changed,
      escalationRate: state.routing.total ? round(state.routing.changed / state.routing.total) : 0,
      byAction: { ...state.routing.byAction },
      byDifficulty: { ...state.routing.byDifficulty },
      byRisk: { ...state.routing.byRisk },
      byMode: { ...state.routing.byMode },
      topEscalations: topN(state.routing.escalations, 10),
    },
    faithfulness: {
      total: state.faithfulness.total,
      annotated: state.faithfulness.annotated,
      annotateRate: state.faithfulness.total ? round(state.faithfulness.annotated / state.faithfulness.total) : 0,
      byGrade: { ...state.faithfulness.byGrade },
      byModel: cloneModelMap(state.faithfulness.byModel),
    },
    compute: {
      total: state.compute.total,
      byMode: { ...state.compute.byMode },
    },
    turnPolicy: {
      total: state.turnPolicy.total,
      agentic: state.turnPolicy.agentic,
      agenticRate: state.turnPolicy.total
        ? round(state.turnPolicy.agentic / state.turnPolicy.total)
        : 0,
      shadowDiffs: state.turnPolicy.shadowDiffs,
      byMode: { ...state.turnPolicy.byMode },
      byToolCallMode: { ...state.turnPolicy.byToolCallMode },
    },
  };
}

function round(n) { return Math.round(n * 1000) / 1000; }

function topN(obj, n) {
  return Object.entries(obj)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([key, count]) => ({ key, count }));
}

function cloneModelMap(m) {
  const out = {};
  for (const [k, v] of Object.entries(m)) {
    out[k] = { total: v.total, annotated: v.annotated, annotateRate: v.total ? round(v.annotated / v.total) : 0 };
  }
  return out;
}

function toPrometheusText() {
  const s = snapshot();
  const lines = [];
  const push = (name, help, type, samples) => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} ${type}`);
    for (const [labels, val] of samples) lines.push(labels ? `${name}{${labels}} ${val}` : `${name} ${val}`);
  };
  push('sira_cognitive_routing_total', 'Total routing decisions', 'counter', [['', s.routing.total]]);
  push('sira_cognitive_routing_changed_total', 'Routing decisions that re-routed the model', 'counter', [['', s.routing.changed]]);
  push('sira_cognitive_routing_action', 'Routing decisions by action', 'counter',
    Object.entries(s.routing.byAction).map(([k, v]) => [`action="${esc(k)}"`, v]));
  push('sira_cognitive_difficulty', 'Turns by assessed difficulty', 'counter',
    Object.entries(s.routing.byDifficulty).map(([k, v]) => [`bucket="${esc(k)}"`, v]));
  push('sira_cognitive_risk', 'Turns by assessed risk level', 'counter',
    Object.entries(s.routing.byRisk).map(([k, v]) => [`level="${esc(k)}"`, v]));
  push('sira_cognitive_faithfulness_total', 'Faithfulness checks run', 'counter', [['', s.faithfulness.total]]);
  push('sira_cognitive_faithfulness_annotated_total', 'Answers annotated with a fidelity footer', 'counter', [['', s.faithfulness.annotated]]);
  push('sira_cognitive_faithfulness_grade', 'Faithfulness checks by grade', 'counter',
    Object.entries(s.faithfulness.byGrade).map(([k, v]) => [`grade="${esc(k)}"`, v]));
  push('sira_cognitive_compute_mode', 'Turns by test-time compute mode', 'counter',
    Object.entries(s.compute.byMode).map(([k, v]) => [`mode="${esc(k)}"`, v]));
  push('sira_cognitive_turn_policy_total', 'Turn policy snapshots recorded', 'counter', [['', s.turnPolicy.total]]);
  push('sira_cognitive_turn_policy_agentic_total', 'Turn policies that selected agentic loop', 'counter', [['', s.turnPolicy.agentic]]);
  push('sira_cognitive_turn_policy_shadow_diffs_total', 'Shadow mismatches vs runtime', 'counter', [['', s.turnPolicy.shadowDiffs]]);
  push('sira_cognitive_turn_policy_tool_call_mode', 'Turn policies by tool-call mode', 'counter',
    Object.entries(s.turnPolicy.byToolCallMode).map(([k, v]) => [`mode="${esc(k)}"`, v]));
  return `${lines.join('\n')}\n`;
}

function esc(value) { return escapePrometheusLabelValue(value); }

function reset() { state = freshState(); }

module.exports = {
  recordRoutingDecision,
  recordFaithfulness,
  recordCompute,
  recordTurnPolicy,
  snapshot,
  toPrometheusText,
  reset,
};
