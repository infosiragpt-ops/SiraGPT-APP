/**
 * durable-execution-store
 *
 * File-backed durable ExecutionGraph state. This gives long-running
 * agentic tasks a replayable checkpoint ledger without requiring a
 * migration. It is intentionally narrow and can later be swapped for
 * Postgres/Redis/Temporal without changing callers.
 */

const fs = require('fs');
const path = require('path');

const STORE_VERSION = 'durable-execution-store-2026-04';
const DEFAULT_EVENT_LIMIT = 2000;
const TERMINAL_STATES = new Set(['succeeded', 'failed', 'blocked', 'skipped']);

function getExecutionStoreDir() {
  return process.env.ENTERPRISE_EXECUTION_STORE_DIR
    || path.join(process.cwd(), 'uploads', 'execution-graphs');
}

function ensureDir() {
  const dir = getExecutionStoreDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeGraphId(value) {
  return String(value || '').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 120);
}

function recordPathFor(graphId) {
  const clean = safeGraphId(graphId);
  if (!clean) throw new Error('durable-execution-store: graphId is required');
  return path.join(ensureDir(), `${clean}.json`);
}

function nowIso() {
  return new Date().toISOString();
}

function atomicWriteJson(filePath, payload) {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, filePath);
}

function trimEvents(events, limit = DEFAULT_EVENT_LIMIT) {
  const list = Array.isArray(events) ? events : [];
  if (list.length <= limit) return list;
  return list.slice(list.length - limit);
}

function summarizeNode(node = {}) {
  return {
    id: String(node.id || ''),
    layer: node.layer || null,
    agent_role: node.agent_role || null,
    state: node.state || 'planned',
    dependencies: Array.isArray(node.dependencies) ? node.dependencies : [],
    tools: Array.isArray(node.tools) ? node.tools : [],
    retry_policy: node.retry_policy || null,
    timeout_policy: node.timeout_policy || null,
    validation_gate: node.validation_gate || null,
    release_gate: node.release_gate || null,
    attempts: 0,
    lastCheckpointAt: null,
    outputs: null,
    error: null,
  };
}

function summarizeQa(qaBoardReview) {
  if (!qaBoardReview) return null;
  return {
    version: qaBoardReview.version || null,
    phase: qaBoardReview.phase || null,
    releaseDecision: qaBoardReview.releaseDecision || null,
    blockerCount: Array.isArray(qaBoardReview.blockers) ? qaBoardReview.blockers.length : 0,
    warningCount: Array.isArray(qaBoardReview.warnings) ? qaBoardReview.warnings.length : 0,
    failureReportCount: Array.isArray(qaBoardReview.failureReports) ? qaBoardReview.failureReports.length : 0,
  };
}

function sanitizeRecord(record = {}) {
  const graphId = safeGraphId(record.graphId || record.graph?.graph_id);
  if (!graphId) throw new Error('durable-execution-store: graphId is required');
  const graph = record.graph || null;
  const nodes = Array.isArray(record.nodes)
    ? record.nodes
    : (graph?.nodes || []).map(summarizeNode);
  const now = nowIso();
  return {
    version: STORE_VERSION,
    graphId,
    taskId: String(record.taskId || ''),
    userId: String(record.userId || ''),
    chatId: record.chatId || null,
    status: record.status || 'planned',
    createdAt: record.createdAt || now,
    updatedAt: record.updatedAt || now,
    completedAt: record.completedAt || null,
    contractFingerprint: graph?.root_contract_fingerprint || record.contractFingerprint || null,
    idempotencyKey: graph?.idempotency_key || record.idempotencyKey || null,
    pipeline: graph?.pipeline || record.pipeline || null,
    durableExecution: graph?.durable_execution || record.durableExecution || null,
    contract: record.contract || null,
    graph,
    toolRuntimePlan: record.toolRuntimePlan || null,
    qaBoardReview: summarizeQa(record.qaBoardReview) || record.qaBoardReview || null,
    nodes,
    events: trimEvents(record.events, record.eventLimit || DEFAULT_EVENT_LIMIT),
    checkpoints: trimEvents(record.checkpoints, 500),
    stats: record.stats || null,
  };
}

function createDurableExecutionRecord({
  graph,
  contract,
  taskId,
  userId,
  chatId,
  toolRuntimePlan,
  qaBoardReview,
} = {}) {
  if (!graph?.graph_id) throw new Error('durable-execution-store: graph.graph_id is required');
  const createdAt = nowIso();
  const record = sanitizeRecord({
    graphId: graph.graph_id,
    taskId,
    userId,
    chatId,
    status: 'planned',
    createdAt,
    updatedAt: createdAt,
    contract,
    graph,
    toolRuntimePlan: toolRuntimePlan?.summary || toolRuntimePlan || null,
    qaBoardReview,
    events: [
      {
        type: 'durable_execution_created',
        graphId: graph.graph_id,
        taskId: taskId || null,
        ts: createdAt,
      },
    ],
  });
  atomicWriteJson(recordPathFor(record.graphId), record);
  return record;
}

function readExecutionRecord(graphId) {
  try {
    const file = recordPathFor(graphId);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function getExecutionRecordForUser(graphId, userId) {
  const record = readExecutionRecord(graphId);
  if (!record || String(record.userId) !== String(userId || '')) return null;
  return record;
}

function writeExecutionRecord(record) {
  const sanitized = sanitizeRecord(record);
  atomicWriteJson(recordPathFor(sanitized.graphId), sanitized);
  return sanitized;
}

function appendExecutionEvent(graphId, userId, event = {}, options = {}) {
  const record = getExecutionRecordForUser(graphId, userId);
  if (!record) return null;
  const stamped = {
    ...event,
    ts: event.ts || nowIso(),
  };
  const events = trimEvents([...(record.events || []), stamped], options.eventLimit || DEFAULT_EVENT_LIMIT);
  const next = {
    ...record,
    events,
    updatedAt: stamped.ts,
  };
  return writeExecutionRecord(next);
}

function checkpointNode({
  graphId,
  userId,
  nodeId,
  state,
  outputs = null,
  error = null,
  event = null,
} = {}) {
  const record = getExecutionRecordForUser(graphId, userId);
  if (!record) return null;
  const now = nowIso();
  const nodes = (record.nodes || []).map((node) => {
    if (node.id !== nodeId) return node;
    const attempts = state === 'running' ? (node.attempts || 0) + 1 : (node.attempts || 0);
    return {
      ...node,
      state: state || node.state,
      attempts,
      lastCheckpointAt: now,
      outputs: outputs == null ? node.outputs : outputs,
      error: error == null ? node.error : error,
    };
  });
  const checkpoints = [
    ...(record.checkpoints || []),
    {
      ts: now,
      nodeId,
      state,
      terminal: TERMINAL_STATES.has(state),
      hasOutputs: outputs != null,
      hasError: error != null,
    },
  ];
  const events = event
    ? trimEvents([...(record.events || []), { ...event, ts: event.ts || now }])
    : record.events;
  const next = {
    ...record,
    status: computeRecordStatus(nodes, record.status),
    nodes,
    events,
    checkpoints: trimEvents(checkpoints, 500),
    updatedAt: now,
  };
  return writeExecutionRecord(next);
}

function markExecutionStatus(graphId, userId, status, patch = {}) {
  const record = getExecutionRecordForUser(graphId, userId);
  if (!record) return null;
  const now = nowIso();
  return writeExecutionRecord({
    ...record,
    ...patch,
    status,
    completedAt: status === 'completed' || status === 'failed' || status === 'cancelled'
      ? (patch.completedAt || now)
      : record.completedAt,
    updatedAt: now,
  });
}

function computeRecordStatus(nodes, fallback) {
  if (!Array.isArray(nodes) || nodes.length === 0) return fallback || 'planned';
  if (nodes.some((node) => node.state === 'failed')) return 'failed';
  if (nodes.some((node) => node.state === 'blocked')) return 'blocked';
  if (nodes.every((node) => TERMINAL_STATES.has(node.state))) return 'completed';
  if (nodes.some((node) => node.state === 'running')) return 'running';
  return fallback || 'planned';
}

function listExecutionRecordsForUser(userId, { limit = 50 } = {}) {
  const dir = ensureDir();
  const rows = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue;
    try {
      const record = JSON.parse(fs.readFileSync(path.join(dir, entry), 'utf8'));
      if (String(record.userId) === String(userId || '')) rows.push(record);
    } catch {
      // Ignore corrupt records on list.
    }
  }
  return rows
    .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0))
    .slice(0, limit);
}

module.exports = {
  STORE_VERSION,
  DEFAULT_EVENT_LIMIT,
  appendExecutionEvent,
  checkpointNode,
  createDurableExecutionRecord,
  getExecutionRecordForUser,
  getExecutionStoreDir,
  listExecutionRecordsForUser,
  markExecutionStatus,
  readExecutionRecord,
  recordPathFor,
  safeGraphId,
  sanitizeRecord,
  writeExecutionRecord,
};
