'use strict';

/**
 * codex/event-types — single source of truth for the typed SSE protocol
 * (spec docs/codex-agent-ux.md §5). Every run event travels in a common
 * envelope `{ runId, seq, ts, type, data }`, is persisted append-only in
 * `codex_events` (feature 04 event-store) and published on Redis
 * `codex:run:<runId>`. The timeline reducer (feature 10) is the consumer.
 *
 * `heartbeat` is wire-only (keep-alive) and is NEVER persisted.
 */

const RUN_STATUSES = ['queued', 'running', 'waiting_approval', 'done', 'error', 'cancelled'];
const ACTION_KINDS = ['terminal', 'file_read', 'file_write', 'reasoning', 'web'];
const ACTION_END_STATUSES = ['done', 'error'];
const COST_SOURCES = ['provider_exact', 'openrouter_generation', 'estimated'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string';
const nonEmptyStr = (v) => typeof v === 'string' && v.length > 0;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isArr = (v) => Array.isArray(v);
const optStr = (v) => v === undefined || v === null || typeof v === 'string';
const optNum = (v) => v === undefined || v === null || (typeof v === 'number' && Number.isFinite(v));

/**
 * Per-type validators of the `data` payload. Each returns boolean.
 * Kept declarative so adding an event = one entry + one test (feature 09 style).
 */
const VALIDATORS = {
  run_status: (d) => isObj(d) && RUN_STATUSES.includes(d.status),

  plan_proposed: (d) =>
    isObj(d) &&
    nonEmptyStr(d.architecture) &&
    isArr(d.pages) &&
    isArr(d.components) &&
    isArr(d.tasks),

  reasoning_start: (d) => isObj(d) && nonEmptyStr(d.blockId) && isStr(d.label),
  reasoning_delta: (d) => isObj(d) && nonEmptyStr(d.blockId) && isStr(d.text),
  reasoning_end: (d) => isObj(d) && nonEmptyStr(d.blockId) && isNum(d.durationMs),

  action_start: (d) =>
    isObj(d) &&
    nonEmptyStr(d.actionId) &&
    ACTION_KINDS.includes(d.kind) &&
    nonEmptyStr(d.groupId) &&
    optStr(d.command) &&
    optStr(d.path),

  action_end: (d) =>
    isObj(d) &&
    nonEmptyStr(d.actionId) &&
    ACTION_END_STATUSES.includes(d.status) &&
    optStr(d.outputSummary) &&
    optNum(d.durationMs) &&
    optNum(d.linesRead),

  narrative_delta: (d) => isObj(d) && isStr(d.text),

  checkpoint_created: (d) =>
    isObj(d) &&
    nonEmptyStr(d.checkpointId) &&
    nonEmptyStr(d.commitSha) &&
    isStr(d.title),

  run_summary: (d) => isObj(d) && isObj(d.metrics) && validateMetricsShape(d.metrics),

  action_required: (d) =>
    isObj(d) &&
    nonEmptyStr(d.patternId) &&
    nonEmptyStr(d.title) &&
    isStr(d.rawError) &&
    isArr(d.blockedCapabilities) &&
    optStr(d.remediationUrl),

  heartbeat: (d) => d === undefined || d === null || isObj(d),
};

/** Public projection shape of CodexRunMetric carried by `run_summary`. */
function validateMetricsShape(m) {
  return (
    isObj(m) &&
    optNum(m.timeWorkedMs) &&
    optNum(m.actionsCount) &&
    optNum(m.itemsReadLines) &&
    optNum(m.additions) &&
    optNum(m.deletions) &&
    (m.costSource === undefined || m.costSource === null || COST_SOURCES.includes(m.costSource))
  );
}

const EVENT_TYPES = Object.freeze(Object.keys(VALIDATORS));

/** Events that travel on the wire but are never written to codex_events. */
const WIRE_ONLY_TYPES = Object.freeze(['heartbeat']);

function isKnownEventType(type) {
  return Object.prototype.hasOwnProperty.call(VALIDATORS, type);
}

/** True when `type` is a known event and `data` satisfies its validator. */
function isValidEvent(type, data) {
  if (!isKnownEventType(type)) return false;
  return VALIDATORS[type](data);
}

/** True when the event must be persisted (everything except wire-only). */
function isPersistedEventType(type) {
  return isKnownEventType(type) && !WIRE_ONLY_TYPES.includes(type);
}

/** Build the common envelope. `ts` is injectable for deterministic tests. */
function buildEnvelope({ runId, seq, type, data, ts }) {
  return { runId, seq, ts: ts ?? new Date().toISOString(), type, data: data ?? {} };
}

module.exports = {
  EVENT_TYPES,
  WIRE_ONLY_TYPES,
  RUN_STATUSES,
  ACTION_KINDS,
  ACTION_END_STATUSES,
  COST_SOURCES,
  VALIDATORS,
  isKnownEventType,
  isValidEvent,
  isPersistedEventType,
  validateMetricsShape,
  buildEnvelope,
};
