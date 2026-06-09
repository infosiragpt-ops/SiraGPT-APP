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
const { authenticateToken } = require('../middleware/auth');
const prisma = require('../config/database');
const permissionManager = require('../services/agent-harness/permission-manager');

const router = express.Router();

function handleValidation(req, res) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return false;
  res.status(400).json({ error: 'validation_failed', details: errors.array().slice(0, 5) });
  return true;
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

function serializeServer(server) {
  return {
    id: server.id,
    name: server.name,
    url: server.url,
    transport: server.transport,
    enabled: server.enabled,
    hasHeaders: Boolean(server.headersEncrypted),
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
  };
}

router.get('/mcp-servers', authenticateToken, async (req, res) => {
  try {
    const servers = await prisma.mcpServer.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'asc' },
    });
    res.json({ servers: servers.map(serializeServer) });
  } catch (err) {
    console.error('[agent-harness] mcp-servers list failed:', err.message);
    res.status(500).json({ error: 'mcp_servers_list_failed' });
  }
});

router.post('/mcp-servers', authenticateToken, async (req, res) => {
  try {
    const mcpClient = require('../services/agent-harness/mcp-client');
    const validated = mcpClient.validateServerInput(req.body);
    if (!validated.ok) return res.status(400).json({ error: validated.error });
    const { name, url, transport, headers, enabled } = validated.data;
    const server = await prisma.mcpServer.create({
      data: {
        userId: req.user.id,
        name,
        url,
        transport,
        enabled,
        headersEncrypted: mcpClient.encryptHeaders(headers),
      },
    });
    res.status(201).json({ server: serializeServer(server) });
  } catch (err) {
    if (err && err.code === 'P2002') {
      return res.status(409).json({ error: 'a server with that name already exists' });
    }
    console.error('[agent-harness] mcp-server create failed:', err.message);
    res.status(500).json({ error: 'mcp_server_create_failed' });
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
      ...(req.body.headers ? { headers: req.body.headers } : {}),
    };
    const validated = mcpClient.validateServerInput(merged);
    if (!validated.ok) return res.status(400).json({ error: validated.error });
    const server = await prisma.mcpServer.update({
      where: { id: existing.id },
      data: {
        name: validated.data.name,
        url: validated.data.url,
        transport: validated.data.transport,
        enabled: validated.data.enabled,
        ...(req.body.headers !== undefined
          ? { headersEncrypted: mcpClient.encryptHeaders(validated.data.headers) }
          : {}),
      },
    });
    res.json({ server: serializeServer(server) });
  } catch (err) {
    if (err && err.code === 'P2002') {
      return res.status(409).json({ error: 'a server with that name already exists' });
    }
    console.error('[agent-harness] mcp-server update failed:', err.message);
    res.status(500).json({ error: 'mcp_server_update_failed' });
  }
});

router.delete('/mcp-servers/:id', authenticateToken, async (req, res) => {
  try {
    const existing = await prisma.mcpServer.findFirst({
      where: { id: String(req.params.id), userId: req.user.id },
    });
    if (!existing) return res.status(404).json({ error: 'mcp_server_not_found' });
    await prisma.mcpServer.delete({ where: { id: existing.id } });
    res.json({ ok: true });
  } catch (err) {
    console.error('[agent-harness] mcp-server delete failed:', err.message);
    res.status(500).json({ error: 'mcp_server_delete_failed' });
  }
});

module.exports = router;
