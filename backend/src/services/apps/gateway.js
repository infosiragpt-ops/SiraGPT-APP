'use strict';

const { toolByName, STATUSES } = require('./registry');
const { findByUserAndApp, publicConnection } = require('./store');
const { openSecret } = require('./vault');
const { EXECUTORS } = require('./executors');
const { redactSecrets, assertNoSecrets } = require('./redact');
const { auditAppEvent } = require('./audit');

// Per-call deadline for app tool executors. The provider fetches carried no
// signal, so a stalled GitHub/LinkedIn/X upstream pinned the request (and the
// socket) until undici's 300 s headers/body timeouts. One deadline covers every
// fetch the tool makes, including the body read. SIRAGPT_APPS_TOOL_TIMEOUT_MS
// tunes it (capped at 120 s, the harness default per-tool timeout).
const DEFAULT_APP_TOOL_TIMEOUT_MS = 30_000;
const MAX_APP_TOOL_TIMEOUT_MS = 120_000;

function appToolTimeoutMs(env = process.env) {
  const raw = Number(env?.SIRAGPT_APPS_TOOL_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_APP_TOOL_TIMEOUT_MS;
  return Math.min(Math.floor(raw), MAX_APP_TOOL_TIMEOUT_MS);
}

function fetchWithDeadline(fetchImpl, deadline) {
  return (url, init = {}) => fetchImpl(url, {
    ...init,
    signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
  });
}

function truthy(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

async function executeTool(prisma, {
  userId,
  toolName,
  args = {},
  approved = false,
  vault = null,
  fetchImpl = globalThis.fetch,
  env = process.env,
  req = null,
} = {}) {
  const mapped = toolByName(toolName);
  if (!mapped) {
    return { ok: false, error: 'unknown_tool', message: 'Herramienta de app desconocida.' };
  }
  const { app, tool } = mapped;
  const row = await findByUserAndApp(prisma, userId, app.id);
  if (!row) {
    return { ok: false, error: 'not_connected', app: app.id, message: `${app.name} no está conectada.` };
  }
  if (row.status === STATUSES.EXPIRED || row.status === STATUSES.REVOKED) {
    return {
      ok: false,
      error: row.status,
      app: app.id,
      connection_id: row.id,
      message: `${app.name} necesita reconectarse.`,
    };
  }

  const opened = await openSecret(prisma, row.secretRef, vault);
  if (!opened?.accessToken) {
    return { ok: false, error: 'secret_unreadable', app: app.id, connection_id: row.id };
  }

  const writeApproved = truthy(approved) || truthy(args?.approved);
  const executor = EXECUTORS[tool.name];
  if (!executor) {
    return { ok: false, error: 'executor_missing', app: app.id };
  }

  const deadline = AbortSignal.timeout(appToolTimeoutMs(env));
  let raw;
  try {
    raw = await executor({
      accessToken: opened.accessToken,
      args: args || {},
      approved: writeApproved,
      fetchImpl: fetchWithDeadline(fetchImpl, deadline),
      env,
      vault,
      prisma,
      connectionRow: opened._meta?.row || null,
    });
  } catch (error) {
    raw = deadline.aborted
      ? {
        error: 'tool_timeout',
        message: tool.kind === 'write'
          ? `${app.name} no respondió a tiempo; la acción pudo haberse completado. Verifícalo antes de reintentar.`
          : `${app.name} no respondió a tiempo.`,
      }
      : { error: 'tool_failed', message: String(error?.message || 'tool_failed').slice(0, 180) };
  }

  const safe = assertNoSecrets(redactSecrets(raw), tool.name);
  await auditAppEvent(prisma, {
    userId,
    action: 'app_tool_called',
    appId: app.id,
    connectionId: row.id,
    req,
    metadata: {
      tool: tool.name,
      kind: tool.kind,
      approved: writeApproved,
      ok: !safe?.error,
      error: safe?.error || null,
    },
  });

  return {
    ok: !safe?.error,
    app: app.id,
    connection_id: row.id,
    tool: tool.name,
    result: safe,
  };
}

function availableToolsForConnection(app, connection) {
  if (!app) return [];
  const connected = connection?.status === STATUSES.CONNECTED;
  return app.tools
    .filter((tool) => connected || tool.kind === 'read')
    .map((tool) => ({
      name: tool.name,
      kind: tool.kind,
      requiresApproval: Boolean(tool.requiresApproval),
    }));
}

function modelSafeSummary(app, connection) {
  return {
    app: app.id,
    connection_id: connection.id,
    status: connection.status,
    available_tools: availableToolsForConnection(app, connection).map((tool) => tool.name),
  };
}

module.exports = {
  executeTool,
  appToolTimeoutMs,
  availableToolsForConnection,
  modelSafeSummary,
  publicConnection,
};
