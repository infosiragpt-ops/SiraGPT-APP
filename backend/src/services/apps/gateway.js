'use strict';

const { toolByName, STATUSES } = require('./registry');
const { findByUserAndApp, publicConnection } = require('./store');
const { openSecret } = require('./vault');
const { EXECUTORS } = require('./executors');
const { redactSecrets, assertNoSecrets } = require('./redact');
const { auditAppEvent } = require('./audit');

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

  let raw;
  try {
    raw = await executor({
      accessToken: opened.accessToken,
      args: args || {},
      approved: writeApproved,
      fetchImpl,
      env,
      vault,
      prisma,
      connectionRow: opened._meta?.row || null,
    });
  } catch (error) {
    raw = { error: 'tool_failed', message: String(error?.message || 'tool_failed').slice(0, 180) };
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
  availableToolsForConnection,
  modelSafeSummary,
  publicConnection,
};
