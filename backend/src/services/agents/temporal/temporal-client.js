'use strict';

/**
 * temporal-client — thin wrapper around `@temporalio/client` for starting
 * agent-task workflows on Temporal Cloud.
 *
 * Why this module exists
 * ----------------------
 * `agent-task-worker.js` hand-rolls locks (`AGENT_WORKER_LOCK_DURATION_MS`,
 * `AGENT_WORKER_STALLED_INTERVAL_MS`), retries with backoff
 * (`AGENT_TASK_MAX_RETRIES` + `classifyTaskError`), idempotency, and a
 * throttled error funnel for transient Redis flaps. Temporal Cloud
 * provides all of that as built-in primitives (heartbeats, retry
 * policies, search attributes, workflow IDs). Migrating one task type at
 * a time behind a flag lets us A/B against the BullMQ path before
 * ripping the old code out.
 *
 * The actual worker process that hosts workflow + activity code lives in
 * `infra/temporal/worker.js` and is deployed to a separate Replit
 * Autoscale Repl. This module only contains the *client* (the side that
 * calls `client.workflow.start(...)` from the main backend).
 *
 * Disabled mode
 * -------------
 * If `TEMPORAL_ADDRESS` is unset, `isTemporalEnabled()` returns false and
 * `getTemporalClient()` resolves to null. Callers MUST fall back to the
 * existing BullMQ path when the client is null. Per-task-type rollout is
 * controlled by `shouldUseTemporalForTaskType(taskType)` (env flags
 * `USE_TEMPORAL_FOR_<TASK_TYPE>=1`), so we can flip one task type to
 * Temporal while leaving the rest on BullMQ.
 *
 * The SDK packages (`@temporalio/client`, `@temporalio/common`) are loaded
 * lazily inside `getTemporalClient()` so unit tests can stub them without
 * a real install and so the main backend boot doesn't pay the cost when
 * the flag is off.
 *
 * Public API
 * ----------
 *   getTemporalConfig({ env })                    → resolved config or { enabled:false, reason }
 *   isTemporalEnabled({ env })                    → boolean
 *   shouldUseTemporalForTaskType(taskType, {env}) → boolean
 *   getTemporalClient({ env, sdk })               → Promise<Client | null>
 *   startAgentTaskWorkflow({ taskType, jobData, ... }) → Promise<{ workflowId, runId } | null>
 *   closeTemporalClient()                         → Promise<void>
 *
 * The module never throws on bad config — a missing address or
 * malformed cert returns `{ enabled:false, reason }` so a misconfigured
 * prod boot never crashes the chat route.
 */

const DEFAULT_NAMESPACE = 'sira-prod';
const DEFAULT_TASK_QUEUE = 'sira-agent-tasks';
const DEFAULT_WORKFLOW_RUN_TIMEOUT = '1 hour';
const DEFAULT_WORKFLOW_TASK_TIMEOUT = '30 seconds';

let _sdk = null;
function loadSdk() {
  if (_sdk) return _sdk;
  // eslint-disable-next-line global-require
  const client = require('@temporalio/client');
  _sdk = { client };
  return _sdk;
}

function readNonEmpty(raw) {
  if (raw === undefined || raw === null) return '';
  return String(raw).trim();
}

function decodeMaybeBase64Pem(raw) {
  const value = readNonEmpty(raw);
  if (!value) return '';
  // Temporal Cloud certs are PEM strings. Operators often paste them
  // base64-encoded into Replit Secrets (the editor strips line breaks).
  // Accept both shapes so we don't blow up on a perfectly valid secret
  // just because of newline handling in the secrets UI.
  if (/-----BEGIN [A-Z ]+-----/.test(value)) return value;
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    if (/-----BEGIN [A-Z ]+-----/.test(decoded)) return decoded;
  } catch (_err) { /* fall through */ }
  return value;
}

/**
 * Resolve Temporal config from env. Pure — safe to call repeatedly.
 * Returns `{ enabled:false, reason }` when Temporal shouldn't be used.
 */
function getTemporalConfig({ env = process.env } = {}) {
  const address = readNonEmpty(env.TEMPORAL_ADDRESS);
  if (!address) return { enabled: false, reason: 'no_address' };

  const namespace = readNonEmpty(env.TEMPORAL_NAMESPACE) || DEFAULT_NAMESPACE;
  const taskQueue = readNonEmpty(env.TEMPORAL_TASK_QUEUE) || DEFAULT_TASK_QUEUE;
  const apiKey = readNonEmpty(env.TEMPORAL_API_KEY);
  const clientCert = decodeMaybeBase64Pem(env.TEMPORAL_CLIENT_CERT);
  const clientKey = decodeMaybeBase64Pem(env.TEMPORAL_CLIENT_KEY);

  // Temporal Cloud accepts either mTLS (cert + key) or API key auth.
  // We require one of the two — anything else is a config bug.
  const hasMtls = Boolean(clientCert && clientKey);
  const hasApiKey = Boolean(apiKey);
  if (!hasMtls && !hasApiKey) return { enabled: false, reason: 'no_auth' };

  return {
    enabled: true,
    address,
    namespace,
    taskQueue,
    apiKey: hasApiKey ? apiKey : null,
    clientCert: hasMtls ? clientCert : null,
    clientKey: hasMtls ? clientKey : null,
    workflowRunTimeout: readNonEmpty(env.TEMPORAL_WORKFLOW_RUN_TIMEOUT) || DEFAULT_WORKFLOW_RUN_TIMEOUT,
    workflowTaskTimeout: readNonEmpty(env.TEMPORAL_WORKFLOW_TASK_TIMEOUT) || DEFAULT_WORKFLOW_TASK_TIMEOUT,
    reason: 'ok',
  };
}

function isTemporalEnabled({ env = process.env } = {}) {
  return getTemporalConfig({ env }).enabled === true;
}

/**
 * Per-task-type opt-in. Returns true when this task type should be
 * dispatched to a Temporal workflow instead of the legacy BullMQ worker.
 *
 * Order of precedence:
 *   1. Temporal disabled (no address/auth) → false.
 *   2. `USE_TEMPORAL_FOR_ALL=1`            → true.
 *   3. `USE_TEMPORAL_FOR_<TASK>=1` (case-insensitive, normalized) → true.
 *   4. Otherwise                            → false.
 *
 * `taskType` is normalized to UPPER_SNAKE_CASE so callers can pass
 * `'research'`, `'deep-research'`, or `'deep_research'` interchangeably.
 */
function shouldUseTemporalForTaskType(taskType, { env = process.env } = {}) {
  if (!isTemporalEnabled({ env })) return false;
  if (readBoolEnv(env.USE_TEMPORAL_FOR_ALL)) return true;
  const key = normalizeTaskTypeKey(taskType);
  if (!key) return false;
  return readBoolEnv(env[`USE_TEMPORAL_FOR_${key}`]);
}

function normalizeTaskTypeKey(taskType) {
  // Insert separators at camelCase boundaries BEFORE uppercasing so
  // `DeepResearch` → `DEEP_RESEARCH` (matches `USE_TEMPORAL_FOR_DEEP_RESEARCH`),
  // not `DEEPRESEARCH`.
  return String(taskType || '')
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function readBoolEnv(raw) {
  const v = String(raw || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

let _connectionPromise = null;
let _client = null;

/**
 * Lazily connect to Temporal Cloud and return a singleton Client.
 * Returns null when disabled — callers MUST handle that.
 *
 * `sdk` is injectable for tests so we can exercise the connection path
 * without installing `@temporalio/client`.
 */
async function getTemporalClient({ env = process.env, sdk } = {}) {
  const cfg = getTemporalConfig({ env });
  if (!cfg.enabled) return null;
  if (_client) return _client;
  if (_connectionPromise) return _connectionPromise;

  _connectionPromise = (async () => {
    const { client: ClientSdk } = sdk || loadSdk();
    const tlsOpts = cfg.clientCert
      ? { clientCertPair: { crt: Buffer.from(cfg.clientCert), key: Buffer.from(cfg.clientKey) } }
      : true;
    const connection = await ClientSdk.Connection.connect({
      address: cfg.address,
      tls: tlsOpts,
      apiKey: cfg.apiKey || undefined,
    });
    _client = new ClientSdk.Client({ connection, namespace: cfg.namespace });
    return _client;
  })().catch((err) => {
    // Never poison the singleton on a transient connect failure — the
    // next call will retry. We surface the reason once via a warn so
    // operators see the boot-time issue without a stack-trace flood.
    console.warn(`[temporal-client] connect failed: ${err && err.message ? err.message : err}`);
    _connectionPromise = null;
    return null;
  });

  return _connectionPromise;
}

/**
 * Start an agent-task workflow for `taskType` with `jobData`. Resolves
 * to `{ workflowId, runId }` on success, or `null` when Temporal is
 * disabled (callers fall back to BullMQ).
 *
 * `workflowId` is derived from `jobData.taskId` (or an explicit
 * `idempotencyKey`) so re-enqueueing the same job is a no-op rather
 * than a duplicate run — Temporal enforces uniqueness at the namespace.
 */
async function startAgentTaskWorkflow({
  taskType,
  jobData,
  idempotencyKey,
  env = process.env,
  sdk,
  workflowType,
} = {}) {
  if (!taskType) throw new TypeError('startAgentTaskWorkflow: taskType is required');
  const client = await getTemporalClient({ env, sdk });
  if (!client) return null;

  const cfg = getTemporalConfig({ env });
  const wfId = String(
    idempotencyKey
      || (jobData && (jobData.taskId || jobData.id))
      || `${normalizeTaskTypeKey(taskType).toLowerCase() || 'agent-task'}-${Date.now()}`
  );
  // Workflow type MUST match a function exported by the worker bundle
  // (`agent-task.workflow.js → runAgentTaskWorkflow`). The discriminating
  // `taskType` flows through `jobData` and is read by the activity, not
  // by Temporal's workflow registry. Override `workflowType` only when
  // a future split (e.g. a separate streaming workflow) registers a new
  // named function in the same bundle.
  const wfType = workflowType || 'runAgentTaskWorkflow';

  const handle = await client.workflow.start(wfType, {
    args: [jobData || {}],
    taskQueue: cfg.taskQueue,
    workflowId: wfId,
    workflowIdReusePolicy: 'REJECT_DUPLICATE',
    workflowRunTimeout: cfg.workflowRunTimeout,
    workflowTaskTimeout: cfg.workflowTaskTimeout,
    searchAttributes: {
      taskType: [String(taskType)],
      userId: jobData && jobData.userId ? [String(jobData.userId)] : [],
    },
  });
  return { workflowId: handle.workflowId, runId: handle.firstExecutionRunId };
}

/**
 * Close the singleton client connection (graceful shutdown). Safe to
 * call even when no client was ever created.
 */
async function closeTemporalClient() {
  if (!_client) {
    _connectionPromise = null;
    return;
  }
  try {
    if (_client.connection && typeof _client.connection.close === 'function') {
      await _client.connection.close();
    }
  } catch (_err) { /* swallow — shutdown path */ }
  _client = null;
  _connectionPromise = null;
}

// Test seam: reset module state between cases without monkeypatching
// internals. Not part of the public contract.
function _resetForTests() {
  _client = null;
  _connectionPromise = null;
  _sdk = null;
}

module.exports = {
  getTemporalConfig,
  isTemporalEnabled,
  shouldUseTemporalForTaskType,
  getTemporalClient,
  startAgentTaskWorkflow,
  closeTemporalClient,
  _internal: { normalizeTaskTypeKey, readBoolEnv, decodeMaybeBase64Pem, _resetForTests },
};
