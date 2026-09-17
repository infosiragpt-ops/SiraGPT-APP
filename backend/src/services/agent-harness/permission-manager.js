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
 *   5. No answer within the TTL (default 24 h) or an explicitly aborted run
 *      denies the action. Closing the browser does not abort detached chat
 *      execution, so approvals remain actionable from the global inbox.
 *
 * Runtime resolvers remain in memory because they pause a live Promise, while
 * the request and decision are mirrored to AgentApproval. After a restart the
 * durable row remains visible and an approval moves the run to `paused`, ready
 * for an explicit resume from its checkpoint.
 */

const crypto = require('node:crypto');

const PERMISSION_TTL_MS = Math.max(
  10_000,
  Number(process.env.SIRAGPT_AGENT_PERMISSION_TTL_MS) || 24 * 60 * 60 * 1000,
);
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

function persistOutcome(entry, outcome) {
  const prisma = entry?.prisma;
  if (!prisma?.agentApproval || !entry?.permissionId) return;
  const status = outcome?.decision === 'allow'
    ? 'approved'
    : (outcome?.reason === 'timeout' ? 'expired' : 'denied');
  Promise.resolve(prisma.agentApproval.updateMany({
    where: { id: entry.permissionId, status: 'pending' },
    data: {
      status,
      decision: outcome?.scope || outcome?.reason || outcome?.decision || status,
      resolvedAt: new Date(),
    },
  })).then(async () => {
    if (!entry.runId || !prisma.coworkRun) return;
    const nextStatus = status === 'approved' ? 'running' : 'running';
    await prisma.coworkRun.updateMany({
      where: { id: entry.runId, status: 'waiting_approval' },
      data: {
        status: nextStatus,
        lastEvent: status === 'approved'
          ? `Approval granted for ${entry.toolName}`
          : `Approval ${status} for ${entry.toolName}`,
      },
    });
  }).catch(() => {});
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
  persistOutcome(entry, outcome);
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
async function requestPermission(opts = {}) {
  const {
    chatId = null,
    userId = null,
    toolName,
    humanDescription = '',
    args = undefined,
    onRequest,
    signal = null,
    ttlMs = PERMISSION_TTL_MS,
    prisma = null,
    runId = null,
    workspaceId = null,
  } = opts;
  const durableApproval = Boolean(prisma?.agentApproval && userId && runId);

  if (!toolName) return { decision: 'deny', reason: 'missing_tool_name' };
  if (isAlwaysAllowed(chatId, toolName)) {
    return { decision: 'allow', cached: true };
  }
  if (signal && signal.aborted && !durableApproval) {
    return { decision: 'deny', reason: 'aborted' };
  }
  if (pending.size >= MAX_PENDING) {
    return { decision: 'deny', reason: 'too_many_pending_permissions' };
  }

  // After a process restart, a checkpointed run may call the same approved
  // tool again while reconstructing the interrupted step. Consume exactly one
  // matching durable grant; a different argument payload requires a new card.
  if (
    durableApproval
    && typeof prisma.agentApproval.findFirst === 'function'
    && typeof prisma.agentApproval.updateMany === 'function'
  ) {
    try {
      const grant = await prisma.agentApproval.findFirst({
        where: {
          userId: String(userId),
          runId: String(runId),
          tool: String(toolName),
          status: 'approved',
        },
        orderBy: { resolvedAt: 'desc' },
      });
      const sameArgs = grant
        && JSON.stringify(grant.args ?? null) === JSON.stringify(args ?? null);
      if (sameArgs) {
        const consumed = await prisma.agentApproval.updateMany({
          where: { id: grant.id, status: 'approved' },
          data: { status: 'consumed' },
        });
        if (consumed.count === 1) {
          return { decision: 'allow', cached: true, durableGrant: true };
        }
      }
    } catch (_) {
      // A grant lookup failure falls back to a new explicit approval request.
    }
  }

  const permissionId = crypto.randomUUID();
  const boundedTtlMs = Math.min(Math.max(Number(ttlMs) || PERMISSION_TTL_MS, 10), 24 * 60 * 60 * 1000);
  if (prisma?.agentApproval && userId) {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.agentApproval.create({
          data: {
            id: permissionId,
            userId: String(userId),
            chatId: chatId ? String(chatId) : null,
            runId: runId ? String(runId) : null,
            tool: String(toolName),
            args: args == null ? null : args,
            humanDescription: String(humanDescription || '').slice(0, 4000),
            expiresAt: new Date(Date.now() + boundedTtlMs),
          },
        });
        if (runId && tx.coworkRun) {
          await tx.coworkRun.updateMany({
            where: { id: String(runId), userId: String(userId), status: { in: ['queued', 'running', 'paused'] } },
            data: {
              status: 'waiting_approval',
              lastEvent: `Waiting for approval: ${String(humanDescription || toolName).slice(0, 500)}`,
            },
          });
        }
      });
      try {
        const { notifyRunState } = require('../cowork/notify');
        const run = runId && prisma.coworkRun
          ? await prisma.coworkRun.findUnique({ where: { id: String(runId) } })
          : null;
        if (run) {
          Promise.resolve(notifyRunState(
            prisma,
            run,
            'waiting_approval',
            String(humanDescription || `Approval required for ${toolName}`),
            {
              approvalId: permissionId,
              tool: String(toolName),
            },
          )).catch(() => {});
        }
      } catch (_) { /* notifications are best effort */ }
    } catch (error) {
      try { console.warn('[permission-manager] durable approval create failed:', error.message); } catch (_) { /* noop */ }
    }
  }
  return new Promise((resolve) => {
    const entry = {
      permissionId,
      resolve,
      chatId: chatId ? String(chatId) : null,
      userId: userId ? String(userId) : null,
      toolName: String(toolName),
      humanDescription: String(humanDescription || ''),
      createdAt: Date.now(),
      prisma,
      runId: runId ? String(runId) : null,
      workspaceId: workspaceId ? String(workspaceId) : null,
      signal: durableApproval ? null : signal,
      onAbort: null,
      timer: setTimeout(() => {
        settle(permissionId, { decision: 'deny', reason: 'timeout' });
      }, boundedTtlMs),
    };
    if (signal && !durableApproval) {
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
          expiresInMs: boundedTtlMs,
        });
      } catch (_) { /* the request event must never break the gate */ }
    }
  });
}

function cancelRun(runId, reason = 'run_cancelled') {
  const target = String(runId || '').trim();
  if (!target) return 0;
  let cancelled = 0;
  for (const [permissionId, entry] of pending) {
    if (entry.runId !== target) continue;
    if (settle(permissionId, { decision: 'deny', reason })) cancelled += 1;
  }
  return cancelled;
}

/**
 * Resolve a pending permission (called by POST /api/agent/permission).
 * Enforces that the resolver is the same user who owns the stream.
 */
async function resolveDurablePermission({
  id,
  verdict,
  userId,
  prisma,
}) {
  if (!prisma?.agentApproval || !userId) {
    return { ok: false, status: 404, error: 'permission request not found (answered, expired, or unknown)' };
  }
  const durable = await prisma.agentApproval.findFirst({
    where: { id, userId: String(userId) },
    include: { run: true },
  });
  if (!durable) return { ok: false, status: 404, error: 'permission request not found' };
  if (durable.status !== 'pending') {
    return { ok: false, status: 409, error: `permission is already ${durable.status}` };
  }
  if (durable.expiresAt <= new Date()) {
    await prisma.agentApproval.updateMany({
      where: { id, userId: String(userId), status: 'pending' },
      data: { status: 'expired', decision: 'timeout', resolvedAt: new Date() },
    });
    return { ok: false, status: 410, error: 'permission request expired' };
  }
  const normalized = verdict === 'deny' ? 'denied' : 'approved';
  const claimed = await prisma.$transaction(async (tx) => {
    const updated = await tx.agentApproval.updateMany({
      where: {
        id,
        userId: String(userId),
        status: 'pending',
        expiresAt: { gt: new Date() },
      },
      data: {
        status: normalized,
        decision: verdict,
        resolvedAt: new Date(),
      },
    });
    if (updated.count !== 1) return false;
    if (durable.runId && tx.coworkRun) {
      await tx.coworkRun.updateMany({
        where: {
          id: durable.runId,
          userId: String(userId),
          status: 'waiting_approval',
        },
        data: {
          status: verdict === 'deny' ? 'cancelled' : 'paused',
          lastEvent: verdict === 'deny'
            ? `Approval denied for ${durable.tool}`
            : `Approval granted for ${durable.tool}; resume to continue`,
          ...(verdict === 'deny' ? { finishedAt: new Date() } : {}),
        },
      });
    }
    return true;
  });
  if (!claimed) {
    return { ok: false, status: 409, error: 'permission is already resolved' };
  }
  return {
    ok: true,
    decision: verdict,
    durable: true,
    requiresResume: verdict !== 'deny' && Boolean(durable.runId),
    runId: durable.runId || null,
  };
}

function resolvePermission({
  permissionId,
  decision,
  userId = null,
  prisma = null,
} = {}) {
  const id = String(permissionId || '').trim();
  const verdict = String(decision || '').trim();
  if (!id) return { ok: false, status: 400, error: 'permissionId is required' };
  if (!DECISIONS.includes(verdict)) {
    return { ok: false, status: 400, error: `decision must be one of: ${DECISIONS.join(', ')}` };
  }
  const entry = pending.get(id);
  if (!entry) {
    if (!prisma?.agentApproval || !userId) {
      return { ok: false, status: 404, error: 'permission request not found (answered, expired, or unknown)' };
    }
    return resolveDurablePermission({
      id,
      verdict,
      userId,
      prisma,
    });
  }
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

async function listPendingDurable(prisma, userId, { limit = 100 } = {}) {
  if (!prisma?.agentApproval || !userId) return [];
  await prisma.agentApproval.updateMany({
    where: { userId: String(userId), status: 'pending', expiresAt: { lte: new Date() } },
    data: { status: 'expired', decision: 'timeout', resolvedAt: new Date() },
  }).catch(() => {});
  return prisma.agentApproval.findMany({
    where: { userId: String(userId), status: 'pending', expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(Number(limit) || 100, 1), 250),
    select: {
      id: true,
      chatId: true,
      runId: true,
      tool: true,
      args: true,
      humanDescription: true,
      status: true,
      expiresAt: true,
      createdAt: true,
    },
  });
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
  listPendingDurable,
  cancelRun,
  isAlwaysAllowed,
  allowAlwaysInChat,
  resetForTests,
  setPermissionAuditor,
  enablePermissionAudit,
};
