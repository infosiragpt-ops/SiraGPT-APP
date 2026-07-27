/**
 * Agent harness HTTP surface (Phase 1).
 *
 * POST /api/agent/permission
 *   body: { permissionId: string, decision: 'allow'|'always_allow_in_chat'|'deny' }
 *   Resolves a pending interactive permission request emitted by the agent
 *   loop (`permission_request` SSE frame). The paused tool call resumes on
 *   allow; deny feeds a permission-denied is_error tool result back to the
 *   model and the loop continues. Only the user who owns the stream may
 *   answer.
 *
 * MCP servers (external, user-registered — tools join the chat agent as
 * mcp__<server>__<tool> with permission tier 'confirm'):
 *   GET    /api/agent/mcp-servers          — list (headers NEVER returned)
 *   POST   /api/agent/mcp-servers          — register { name, url, transport?, headers?, enabled? }
 *   PATCH  /api/agent/mcp-servers/:id      — update (same fields; headers replaced when provided)
 *   DELETE /api/agent/mcp-servers/:id      — remove
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken: defaultAuthenticateToken } = require('../middleware/auth');
const defaultPrisma = require('../config/database');
const defaultPermissionManager = require('../services/agent-harness/permission-manager');
const { writeAuditLog: defaultWriteAuditLog } = require('../utils/audit-log');

function handleValidation(req, res) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return false;
  res.status(400).json({ error: 'validation_failed', details: errors.array().slice(0, 5) });
  return true;
}

function serializeServer(server, policyDiagnostic = null) {
  const serialized = {
    id: server.id,
    name: server.name,
    url: server.url,
    transport: server.transport,
    enabled: server.enabled,
    hasHeaders: Boolean(server.headersEncrypted),
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
  };
  if (policyDiagnostic) {
    serialized.policyStatus = policyDiagnostic.status;
    serialized.policyReason = policyDiagnostic.reason;
  }
  return serialized;
}

function createAgentHarnessRouter({
  prisma = defaultPrisma,
  authenticateToken = defaultAuthenticateToken,
  permissionManager = defaultPermissionManager,
  writeAuditLog = defaultWriteAuditLog,
  invalidateMcpConnections = null,
  env = process.env,
} = {}) {
  const router = express.Router();

  async function audit(req, action, resourceId = null, metadata = null) {
    try {
      await writeAuditLog(prisma, {
        action,
        userId: req.user?.id || req.user?.userId || null,
        resource: 'mcp_server',
        resourceId,
        metadata,
        tags: ['security', 'mcp'],
        req,
      });
    } catch (_error) {
      // The shared audit writer is best-effort; injected writers follow the
      // same non-disruptive contract.
    }
  }

  async function denyPolicy(req, res, error, resourceId, phase) {
    const code = error && (error.code || error.error)
      ? (error.code || error.error)
      : 'MCP_POLICY_DENIED';
    await audit(req, 'mcp_server_policy_denied', resourceId, {
      phase,
      reason: code,
    });
    return res.status(error && error.status ? error.status : 403).json({ error: code });
  }

  async function authorizeMutation(req, url) {
    const { authorizeMcpServerUrl } = require('../services/agent-harness/mcp-policy');
    return authorizeMcpServerUrl({
      prisma,
      userId: req.user.id,
      url,
      env,
    });
  }

  async function invalidateConnections(serverId) {
    try {
      const invalidate = invalidateMcpConnections
        || require('../services/agent-harness/mcp-client').invalidateServerConnections;
      if (typeof invalidate === 'function') {
        await Promise.resolve(invalidate(serverId));
      }
    } catch (_error) {
      // Per-call DB refresh still fails closed if cleanup is unavailable.
    }
  }

  router.post(
    '/permission',
    authenticateToken,
    [
      body('permissionId').isString().trim().isLength({ min: 8, max: 64 }),
      body('decision').isString().trim().isIn(permissionManager.DECISIONS),
    ],
    (req, res) => {
      if (handleValidation(req, res)) return;
      const result = permissionManager.resolvePermission({
        permissionId: req.body.permissionId,
        decision: req.body.decision,
        userId: req.user?.id || req.user?.userId || null,
      });
      if (!result.ok) {
        return res.status(result.status || 400).json({ error: result.error });
      }
      return res.json({ ok: true, decision: result.decision });
    },
  );

  router.get('/mcp-servers', authenticateToken, async (req, res) => {
    try {
      const servers = await prisma.mcpServer.findMany({
        where: { userId: req.user.id },
        orderBy: { createdAt: 'asc' },
      });
      const {
        resolveUserMcpPolicy,
        validateMcpServerUrl,
      } = require('../services/agent-harness/mcp-policy');
      let resolvedPolicy = null;
      let policyError = null;
      try {
        resolvedPolicy = await resolveUserMcpPolicy({
          prisma,
          userId: req.user.id,
          env,
        });
      } catch (error) {
        policyError = error;
      }
      const diagnosticFor = (server) => {
        let error = policyError;
        if (!error) {
          try {
            validateMcpServerUrl(server.url, {
              env,
              policy: resolvedPolicy,
            });
            return { status: 'allowed', reason: null };
          } catch (validationError) {
            error = validationError;
          }
        }
        const reason = typeof error?.code === 'string' && /^MCP_[A-Z0-9_]+$/.test(error.code)
          ? error.code
          : 'MCP_POLICY_STATUS_UNAVAILABLE';
        return {
          status: reason === 'MCP_POLICY_LOOKUP_FAILED' || reason === 'MCP_POLICY_STATUS_UNAVAILABLE'
            ? 'unavailable'
            : 'denied',
          reason,
        };
      };
      res.json({
        servers: servers.map((server) => serializeServer(server, diagnosticFor(server))),
      });
    } catch (_err) {
      console.error('[agent-harness] mcp-servers list failed');
      res.status(500).json({ error: 'mcp_servers_list_failed' });
    }
  });

  router.post('/mcp-servers', authenticateToken, async (req, res) => {
    try {
      const mcpClient = require('../services/agent-harness/mcp-client');
      const validated = mcpClient.validateServerInput(req.body, { env });
      if (!validated.ok) {
        if (String(validated.error || '').startsWith('MCP_')) {
          return denyPolicy(req, res, validated, null, 'create');
        }
        return res.status(400).json({ error: validated.error });
      }
      let authorized;
      try {
        authorized = await authorizeMutation(req, validated.data.url);
      } catch (error) {
        return denyPolicy(req, res, error, null, 'create');
      }
      const {
        name,
        transport,
        headers,
        enabled,
      } = validated.data;
      const server = await prisma.mcpServer.create({
        data: {
          userId: req.user.id,
          name,
          url: authorized.url,
          transport,
          enabled,
          headersEncrypted: mcpClient.encryptHeaders(headers),
        },
      });
      await audit(req, 'mcp_server_created', server.id);
      return res.status(201).json({ server: serializeServer(server) });
    } catch (err) {
      if (err && err.code === 'P2002') {
        return res.status(409).json({ error: 'a server with that name already exists' });
      }
      console.error('[agent-harness] mcp-server create failed');
      return res.status(500).json({ error: 'mcp_server_create_failed' });
    }
  });

  router.patch('/mcp-servers/:id', authenticateToken, async (req, res) => {
    try {
      const existing = await prisma.mcpServer.findFirst({
        where: { id: String(req.params.id), userId: req.user.id },
      });
      if (!existing) return res.status(404).json({ error: 'mcp_server_not_found' });
      const mcpClient = require('../services/agent-harness/mcp-client');
      const merged = {
        name: req.body.name ?? existing.name,
        url: req.body.url ?? existing.url,
        transport: req.body.transport ?? existing.transport,
        enabled: typeof req.body.enabled === 'boolean' ? req.body.enabled : existing.enabled,
        ...(req.body.headers !== undefined ? { headers: req.body.headers } : {}),
      };
      const validated = mcpClient.validateServerInput(merged, { env });
      if (!validated.ok) {
        if (String(validated.error || '').startsWith('MCP_')) {
          return denyPolicy(req, res, validated, existing.id, 'update');
        }
        return res.status(400).json({ error: validated.error });
      }
      let authorized;
      try {
        authorized = await authorizeMutation(req, validated.data.url);
      } catch (error) {
        return denyPolicy(req, res, error, existing.id, 'update');
      }
      const server = await prisma.mcpServer.update({
        where: { id: existing.id },
        data: {
          name: validated.data.name,
          url: authorized.url,
          transport: validated.data.transport,
          enabled: validated.data.enabled,
          ...(req.body.headers !== undefined
            ? { headersEncrypted: mcpClient.encryptHeaders(validated.data.headers) }
            : {}),
        },
      });
      await invalidateConnections(existing.id);
      await audit(req, 'mcp_server_updated', server.id);
      return res.json({ server: serializeServer(server) });
    } catch (err) {
      if (err && err.code === 'P2002') {
        return res.status(409).json({ error: 'a server with that name already exists' });
      }
      console.error('[agent-harness] mcp-server update failed');
      return res.status(500).json({ error: 'mcp_server_update_failed' });
    }
  });

  router.delete('/mcp-servers/:id', authenticateToken, async (req, res) => {
    try {
      const existing = await prisma.mcpServer.findFirst({
        where: { id: String(req.params.id), userId: req.user.id },
      });
      if (!existing) return res.status(404).json({ error: 'mcp_server_not_found' });
      await prisma.mcpServer.delete({ where: { id: existing.id } });
      await invalidateConnections(existing.id);
      await audit(req, 'mcp_server_deleted', existing.id);
      return res.json({ ok: true });
    } catch (_err) {
      console.error('[agent-harness] mcp-server delete failed');
      return res.status(500).json({ error: 'mcp_server_delete_failed' });
    }
  });

  return router;
}

const router = createAgentHarnessRouter();

module.exports = router;
module.exports.createAgentHarnessRouter = createAgentHarnessRouter;
module.exports.serializeServer = serializeServer;
