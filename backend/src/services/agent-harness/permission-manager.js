'use strict';

/**
 * permission-manager — interactive permission gate for 'confirm'-tier tools.
 *
 * Flow:
 *   1. The wrapped tool execute calls `requestPermission(...)` BEFORE running.
 *   2. The event stream emits `permission_request` (id + tool + human text).
 *   3. The agent loop is naturally paused: it is awaiting the tool's promise.
 *   4. The user answers via POST /api/agent/permission → `resolvePermission`.
 *      - allow                 → the tool runs.
 *      - always_allow_in_chat  → the tool runs AND the (chatId, tool) pair is
 *                                allowlisted for the rest of the chat.
 *      - deny                  → the tool does NOT run; the caller feeds a
 *                                permission-denied error back to the model as
 *                                an is_error tool result and the loop
 *                                continues (the model adapts its plan).
 *   5. No answer within the TTL (default 2 min) or an aborted stream → deny.
 *
 * State is in-memory: a pending permission only makes sense while its SSE
 * stream is alive (the same process), so cross-process persistence buys
 * nothing — on restart the stream is gone and the deny-by-timeout result is
 * recorded in the agent trace. The per-chat allowlist is also process-local
 * by design (it mirrors "Allow always in this chat" session semantics).
 */

const crypto = require('node:crypto');

const PERMISSION_TTL_MS = Math.max(10_000, Number(process.env.SIRAGPT_AGENT_PERMISSION_TTL_MS) || 120_000);
const MAX_PENDING = 500; // hard cap: runaway loops must not leak memory
const MAX_CHAT_ALLOWLISTS = 2_000;

const DECISIONS = Object.freeze(['allow', 'always_allow_in_chat', 'deny']);

/** permissionId → { resolve, chatId, userId, toolName, humanDescription, timer, createdAt } */
const pending = new Map();
/** chatId → Set<toolName> ("always allow in this chat") */
const chatAllowlists = new Map();

// ── Permission decision audit (forensic trail) ──────────────────────
// Injectable sink, default OFF so unit tests stay DB-free. The app
// enables the durable audit at boot via enablePermissionAudit(); every
// decision (allow / deny / always-allow / timeout / abort) then lands in
// the audit log, so "who approved which tool, when" is answerable after
// an incident. Fail-open: a sink error never affects the permission flow.
let auditor = null;

function setPermissionAuditor(fn) {
  auditor = typeof fn === 'function' ? fn : null;
}

function defaultPermissionAuditor(entry, outcome) {
  try {
    // eslint-disable-next-line global-require
    const prisma = require('../../config/database');
    // eslint-disable-next-line global-require
    const { writeAuditLog } = require('../../utils/audit-log');
    const userDriven = outcome && outcome.decision === 'allow' && !outcome.reason;
    Promise.resolve(
      writeAuditLog(prisma, {
        action: 'agent.permission_decision',
        actorType: userDriven ? 'user' : 'system',
        userId: entry.userId || null,
        resource: 'agent_tool',
        resourceId: entry.toolName,
        tags: ['permission', outcome.decision, outcome.scope || outcome.reason || 'once'],
        metadata: {
          chatId: entry.chatId || null,
          tool: entry.toolName,
          decision: outcome.decision,
          scope: outcome.scope || null,
          reason: outcome.reason || null,
          humanDescription: entry.humanDescription || null,
          elapsedMs: entry.createdAt ? Date.now() - entry.createdAt : null,
        },
      }),
    ).catch(() => {});
  } catch (_) {
    // never throw from the audit path
  }
}

function enablePermissionAudit() {
  setPermissionAuditor(defaultPermissionAuditor);
}

function isAlwaysAllowed(chatId, toolName) {
  if (!chatId) return false;
  const set = chatAllowlists.get(String(chatId));
  return Boolean(set && set.has(String(toolName)));
}

function allowAlwaysInChat(chatId, toolName) {
  if (!chatId || !toolName) return;
  const key = String(chatId);
  let set = chatAllowlists.get(key);
  if (!set) {
    // FIFO eviction keeps the map bounded across very long uptimes.
    if (chatAllowlists.size >= MAX_CHAT_ALLOWLISTS) {
      const oldest = chatAllowlists.keys().next().value;
      if (oldest !== undefined) chatAllowlists.delete(oldest);
    }
    set = new Set();
    chatAllowlists.set(key, set);
  }
  set.add(String(toolName));
}

function settle(permissionId, outcome) {
  const entry = pending.get(permissionId);
  if (!entry) return false;
  pending.delete(permissionId);
  clearTimeout(entry.timer);
  if (entry.signal && entry.onAbort) {
    try { entry.signal.removeEventListener('abort', entry.onAbort); } catch (_) { /* noop */ }
  }
  if (auditor) {
    try { auditor(entry, outcome); } catch (_) { /* audit must never break the flow */ }
  }
  try { entry.resolve(outcome); } catch (_) { /* resolver must never throw */ }
  return true;
}

/**
 * Ask the user for permission to run `toolName`. Resolves (never rejects)
 * with `{ decision, reason?, cached? }`.
 *
 * @param {object} opts
 * @param {string|null} opts.chatId
 * @param {string|null} opts.userId   — owner of the stream; the resolve
 *                                      endpoint enforces the same user.
 * @param {string}  opts.toolName
 * @param {string}  opts.humanDescription
 * @param {object}  [opts.args]       — echoed to the UI card (preview).
 * @param {function} opts.onRequest   — emit permission_request to the stream.
 * @param {AbortSignal} [opts.signal] — stream abort → deny immediately.
 * @param {number}  [opts.ttlMs]
 */
function requestPermission(opts = {}) {
  const {
    chatId = null,
    userId = null,
    toolName,
    humanDescription = '',
    args = undefined,
    onRequest,
    signal = null,
    ttlMs = PERMISSION_TTL_MS,
  } = opts;

  if (!toolName) return Promise.resolve({ decision: 'deny', reason: 'missing_tool_name' });
  if (isAlwaysAllowed(chatId, toolName)) {
    return Promise.resolve({ decision: 'allow', cached: true });
  }
  if (signal && signal.aborted) {
    return Promise.resolve({ decision: 'deny', reason: 'aborted' });
  }
  if (pending.size >= MAX_PENDING) {
    return Promise.resolve({ decision: 'deny', reason: 'too_many_pending_permissions' });
  }

  const permissionId = crypto.randomUUID();
  return new Promise((resolve) => {
    const entry = {
      resolve,
      chatId: chatId ? String(chatId) : null,
      userId: userId ? String(userId) : null,
      toolName: String(toolName),
      humanDescription: String(humanDescription || ''),
      createdAt: Date.now(),
      signal,
      onAbort: null,
      timer: setTimeout(() => {
        settle(permissionId, { decision: 'deny', reason: 'timeout' });
      }, ttlMs),
    };
    if (signal) {
      entry.onAbort = () => settle(permissionId, { decision: 'deny', reason: 'aborted' });
      try { signal.addEventListener('abort', entry.onAbort, { once: true }); } catch (_) { /* noop */ }
    }
    pending.set(permissionId, entry);
    if (typeof onRequest === 'function') {
      try {
        onRequest({
          permissionId,
          toolName: entry.toolName,
          humanDescription: entry.humanDescription,
          args,
          expiresInMs: ttlMs,
        });
      } catch (_) { /* the request event must never break the gate */ }
    }
  });
}

/**
 * Resolve a pending permission (called by POST /api/agent/permission).
 * Enforces that the resolver is the same user who owns the stream.
 */
function resolvePermission({ permissionId, decision, userId = null } = {}) {
  const id = String(permissionId || '').trim();
  const verdict = String(decision || '').trim();
  if (!id) return { ok: false, status: 400, error: 'permissionId is required' };
  if (!DECISIONS.includes(verdict)) {
    return { ok: false, status: 400, error: `decision must be one of: ${DECISIONS.join(', ')}` };
  }
  const entry = pending.get(id);
  if (!entry) return { ok: false, status: 404, error: 'permission request not found (answered, expired, or unknown)' };
  if (entry.userId && userId && String(userId) !== entry.userId) {
    return { ok: false, status: 403, error: 'permission belongs to another user' };
  }
  if (verdict === 'always_allow_in_chat') {
    allowAlwaysInChat(entry.chatId, entry.toolName);
  }
  const normalized = verdict === 'deny' ? 'deny' : 'allow';
  settle(id, {
    decision: normalized,
    scope: verdict === 'always_allow_in_chat' ? 'chat' : 'once',
    ...(normalized === 'deny' ? { reason: 'user_denied' } : {}),
  });
  return { ok: true, decision: verdict };
}

function listPending(chatId = null) {
  const out = [];
  for (const [permissionId, entry] of pending) {
    if (chatId && entry.chatId !== String(chatId)) continue;
    out.push({
      permissionId,
      chatId: entry.chatId,
      toolName: entry.toolName,
      humanDescription: entry.humanDescription,
      createdAt: entry.createdAt,
    });
  }
  return out;
}

/** Tests only: wipe all state. */
function resetForTests() {
  for (const id of Array.from(pending.keys())) {
    settle(id, { decision: 'deny', reason: 'reset' });
  }
  pending.clear();
  chatAllowlists.clear();
}

module.exports = {
  DECISIONS,
  PERMISSION_TTL_MS,
  requestPermission,
  resolvePermission,
  listPending,
  isAlwaysAllowed,
  allowAlwaysInChat,
  resetForTests,
  setPermissionAuditor,
  enablePermissionAudit,
};
