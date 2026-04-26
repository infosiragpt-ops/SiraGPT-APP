"use strict";

/**
 * execution-trace-frame - privacy-safe runtime timeline for Sira workflows.
 *
 * The concrete runtime already produces audit events and tool results. This
 * module turns those raw runtime facts into a stable frame that can be stored,
 * rendered in an admin timeline, or exported to observability sinks without
 * leaking prompts, attachment contents, tool inputs, or tool outputs.
 */

const SCHEMA_VERSION = "sira.execution_trace.v1";

function buildExecutionTraceFrame({
  envelope,
  log = [],
  auditTrace = [],
  toolResults = [],
  artifactFrame = null,
  validationFrame = null,
  startedAt = null,
  finishedAt = null,
  toolResilience = null,
} = {}) {
  if (!envelope || !envelope.request_id) {
    throw new Error("sira.execution-trace-frame: envelope.request_id required");
  }

  const normalizedLog = normalizeRuntimeLog(log);
  const normalizedAudit = normalizeAuditTrace(auditTrace);
  const timeline = buildTimeline({ log: normalizedLog, auditTrace: normalizedAudit });
  const nodes = summarizeNodes({ envelope, log: normalizedLog, toolResults });
  const tools = summarizeTools({ toolResults, toolResilience });
  const counters = summarizeCounters({ nodes, tools, timeline, artifactFrame, validationFrame });

  return Object.freeze({
    schema_version: SCHEMA_VERSION,
    frame_type: "execution_trace_frame",
    request_id: envelope.request_id,
    conversation_id: envelope.conversation_id || null,
    user_id: envelope.user_id || null,
    generated_at: finishedAt || new Date().toISOString(),
    started_at: startedAt || firstTimestamp(timeline),
    finished_at: finishedAt || lastTimestamp(timeline),
    duration_ms: durationBetween(startedAt || firstTimestamp(timeline), finishedAt || lastTimestamp(timeline)),
    status: validationFrame?.ready_to_deliver ? "ready_to_deliver" : "needs_repair_or_review",
    counters: Object.freeze(counters),
    nodes: Object.freeze(nodes),
    tools: Object.freeze(tools),
    timeline: Object.freeze(timeline),
    privacy: Object.freeze({
      raw_user_text_logged: false,
      raw_attachment_content_logged: false,
      raw_tool_input_logged: false,
      raw_tool_output_logged: false,
    }),
  });
}

function normalizeRuntimeLog(log) {
  return (Array.isArray(log) ? log : [])
    .filter(Boolean)
    .map((event, index) => ({
      index,
      ts: safeIso(event.ts),
      type: String(event.type || "runtime.event"),
      node_id: event.node_id || null,
      duration_ms: finiteOrNull(event.duration_ms),
    }));
}

function normalizeAuditTrace(auditTrace) {
  return (Array.isArray(auditTrace) ? auditTrace : [])
    .filter(Boolean)
    .map((event, index) => ({
      index,
      ts: safeIso(event.ts),
      event: String(event.event || "audit_event"),
      node_id: event.node_id || null,
      tool: event.tool || null,
      status: event.status || null,
      attempt: finiteOrNull(event.attempt),
      next_attempt: finiteOrNull(event.next_attempt),
      delay_ms: finiteOrNull(event.delay_ms),
      error_code: event.error_code || null,
      idempotency_key: event.idempotency_key || null,
      deduped_from_node: event.deduped_from_node || null,
    }));
}

function buildTimeline({ log, auditTrace }) {
  const runtimeEvents = log.map((event) => ({
    ts: event.ts,
    type: event.type,
    source: "runtime",
    node_id: event.node_id,
    duration_ms: event.duration_ms,
  }));
  const auditEvents = auditTrace.map((event) => ({
    ts: event.ts,
    type: event.event,
    source: "audit",
    node_id: event.node_id,
    tool: event.tool,
    status: event.status,
    attempt: event.attempt,
    next_attempt: event.next_attempt,
    delay_ms: event.delay_ms,
    error_code: event.error_code,
    deduped_from_node: event.deduped_from_node,
  }));

  return runtimeEvents
    .concat(auditEvents)
    .filter(event => event.ts)
    .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime())
    .map((event, index) => Object.freeze({
      event_index: index,
      ...dropNulls(event),
    }));
}

function summarizeNodes({ envelope, log, toolResults }) {
  const nodes = Array.isArray(envelope.workflow_graph?.nodes) ? envelope.workflow_graph.nodes : [];
  return nodes.map((node) => {
    const started = log.find(event => event.type === "node.started" && event.node_id === node.id);
    const completed = [...log].reverse().find(event => event.type === "node.completed" && event.node_id === node.id);
    const results = toolResults.filter(result => result.node === node.id);
    const statusCounts = countBy(results, result => result.status || "unknown");
    const hasErrors = results.some(result => result.status === "error");
    return Object.freeze({
      node_id: node.id,
      label: node.label || node.id,
      agent: node.agent || null,
      status: completed ? (hasErrors ? "completed_with_errors" : "completed") : "not_executed",
      started_at: started?.ts || null,
      completed_at: completed?.ts || null,
      duration_ms: durationBetween(started?.ts, completed?.ts),
      dependency_count: Array.isArray(node.depends_on) ? node.depends_on.length : 0,
      planned_tool_count: Array.isArray(node.tools) ? node.tools.length : 0,
      executed_tool_count: results.length,
      tool_status_counts: Object.freeze(statusCounts),
    });
  });
}

function summarizeTools({ toolResults, toolResilience }) {
  const attempts = Array.isArray(toolResilience?.attempt_log) ? toolResilience.attempt_log : [];
  return (Array.isArray(toolResults) ? toolResults : []).map((result) => {
    const attemptLog = attempts.filter(entry => entry.node_id === result.node && entry.tool === result.tool);
    const resilience = result.metadata?.resilience || {};
    const idempotency = result.metadata?.idempotency || {};
    return Object.freeze({
      node_id: result.node || null,
      tool_name: result.tool || null,
      status: result.status || "unknown",
      error_code: result.error?.code || result.code || null,
      attempts: finiteOrNull(resilience.attempts) || attemptLog.length || null,
      retries: finiteOrNull(resilience.retries) || null,
      duration_ms: sumDurations(attemptLog),
      idempotency_cache_hit: typeof idempotency.cache_hit === "boolean" ? idempotency.cache_hit : null,
      idempotency_key_present: Boolean(idempotency.key),
      retry_exhausted: typeof resilience.exhausted === "boolean" ? resilience.exhausted : null,
    });
  });
}

function summarizeCounters({ nodes, tools, timeline, artifactFrame, validationFrame }) {
  return {
    timeline_events: timeline.length,
    nodes_total: nodes.length,
    nodes_completed: nodes.filter(node => node.status === "completed" || node.status === "completed_with_errors").length,
    tools_total: tools.length,
    tools_by_status: countBy(tools, tool => tool.status || "unknown"),
    tools_with_errors: tools.filter(tool => tool.status === "error").length,
    retries_total: tools.reduce((sum, tool) => sum + (Number(tool.retries) || 0), 0),
    idempotency_cache_hits: tools.filter(tool => tool.idempotency_cache_hit === true).length,
    artifacts_total: Array.isArray(artifactFrame?.artifacts) ? artifactFrame.artifacts.length : 0,
    validation_ready: Boolean(validationFrame?.ready_to_deliver),
    validation_score: finiteOrNull(validationFrame?.aggregate_score),
  };
}

function firstTimestamp(events) {
  return events.length > 0 ? events[0].ts : null;
}

function lastTimestamp(events) {
  return events.length > 0 ? events[events.length - 1].ts : null;
}

function durationBetween(start, end) {
  if (!start || !end) return null;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

function sumDurations(entries) {
  if (!entries.length) return null;
  const total = entries.reduce((sum, entry) => sum + (Number(entry.duration_ms) || 0), 0);
  return Number.isFinite(total) ? total : null;
}

function countBy(items, selector) {
  return (Array.isArray(items) ? items : []).reduce((acc, item) => {
    const key = String(selector(item) || "unknown");
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function safeIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function finiteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function dropNulls(value) {
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== null && item !== undefined) out[key] = item;
  }
  return out;
}

module.exports = {
  SCHEMA_VERSION,
  buildExecutionTraceFrame,
};
