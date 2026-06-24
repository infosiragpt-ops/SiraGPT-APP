'use strict';

/**
 * answer-metrics — tiny in-memory telemetry for the answer engine. Mirrors the
 * free-ia-metrics / x-search-metrics pattern: cheap counters + a rolling
 * latency aggregate, exposed as JSON and Prometheus text. No external deps.
 */

const state = {
  requests: 0,
  fast: 0,
  deep: 0,
  empty: 0,
  errors: 0,
  llmUsed: 0,
  totalCitations: 0,
  totalCandidates: 0,
  latencyMsSum: 0,
  latencyMsMax: 0,
  startedAt: Date.now(),
};

function record({ mode = 'fast', candidates = 0, citations = 0, llmUsed = false, latencyMs = 0, empty = false, error = false } = {}) {
  state.requests += 1;
  if (error) { state.errors += 1; return; }
  if (empty) { state.empty += 1; }
  if (mode === 'deep') state.deep += 1; else state.fast += 1;
  if (llmUsed) state.llmUsed += 1;
  state.totalCitations += Number(citations) || 0;
  state.totalCandidates += Number(candidates) || 0;
  const ms = Number(latencyMs) || 0;
  state.latencyMsSum += ms;
  if (ms > state.latencyMsMax) state.latencyMsMax = ms;
}

function snapshot() {
  const answered = state.fast + state.deep;
  return {
    ...state,
    avgLatencyMs: answered ? Math.round(state.latencyMsSum / answered) : 0,
    avgCitations: answered ? Math.round((state.totalCitations / answered) * 10) / 10 : 0,
    avgCandidates: answered ? Math.round(state.totalCandidates / answered) : 0,
    uptimeSec: Math.round((Date.now() - state.startedAt) / 1000),
  };
}

function toPrometheusText() {
  const s = snapshot();
  return [
    '# HELP sira_answer_requests_total Total answer-engine requests.',
    '# TYPE sira_answer_requests_total counter',
    `sira_answer_requests_total ${s.requests}`,
    `sira_answer_requests_total{mode="fast"} ${s.fast}`,
    `sira_answer_requests_total{mode="deep"} ${s.deep}`,
    '# HELP sira_answer_errors_total Total failed answer requests.',
    '# TYPE sira_answer_errors_total counter',
    `sira_answer_errors_total ${s.errors}`,
    '# HELP sira_answer_llm_used_total Answers finalized with an LLM rewrite.',
    '# TYPE sira_answer_llm_used_total counter',
    `sira_answer_llm_used_total ${s.llmUsed}`,
    '# HELP sira_answer_latency_ms_avg Average end-to-end answer latency.',
    '# TYPE sira_answer_latency_ms_avg gauge',
    `sira_answer_latency_ms_avg ${s.avgLatencyMs}`,
  ].join('\n') + '\n';
}

function reset() {
  Object.assign(state, {
    requests: 0, fast: 0, deep: 0, empty: 0, errors: 0, llmUsed: 0,
    totalCitations: 0, totalCandidates: 0, latencyMsSum: 0, latencyMsMax: 0,
    startedAt: Date.now(),
  });
}

module.exports = { record, snapshot, toPrometheusText, reset };
