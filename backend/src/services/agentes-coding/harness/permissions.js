'use strict';

/**
 * HITL permission gate for the coding harness (Phase 4b).
 *
 * Pattern fusion only (~0 % copy). Decision set is the Cline ask / once /
 * always / reject contract (cline/cline Apache-2.0) rewritten against
 * this repo's in-process harness store + SiraCode permission-resume
 * shape. Not a VS Code extension, not a webview, not a Cline dump.
 *
 * Default policy (documented, injectable):
 *   read / list                         → allow
 *   write under SAFE_WRITE_*            → allow
 *   write anywhere else                 → ask
 *   exec                                → ask
 *
 * Session grants (`allow_always`) live on the harness store. Caps and
 * the AGENTES_CODING_V2 flag are unchanged.
 */

const crypto = require('node:crypto');
const { fail } = require('../coding-sandbox/errors');
const { jailRelPath } = require('../coding-sandbox/path-jail');
const { argsDigest, canonicalTool } = require('./tools');

const DECISIONS = Object.freeze(['allow_once', 'allow_always', 'reject']);

const DECISION_ALIASES = Object.freeze({
  allow_once: 'allow_once',
  once: 'allow_once',
  allow: 'allow_once',
  allow_always: 'allow_always',
  always: 'allow_always',
  always_allow: 'allow_always',
  always_allow_in_chat: 'allow_always',
  reject: 'reject',
  deny: 'reject',
});

const SAFE_WRITE_PREFIXES = Object.freeze(['src/', 'docs/', 'notes/', 'tests/', 'test/']);
const SAFE_WRITE_NAMES = Object.freeze([
  'README.md',
  'package.json',
  'tsconfig.json',
  'CHANGELOG.md',
]);

const REASON_MESSAGES = Object.freeze({
  exec_requires_approval: 'Este comando necesita tu permiso para ejecutarse.',
  write_outside_allowlist: 'Escribir fuera de las rutas seguras necesita tu permiso.',
  tool_requires_approval: 'Esta acción privilegiada necesita tu permiso.',
  policy_denied: 'La política denegó esta acción privilegiada.',
});

function normalizeDecision(decision) {
  const raw = String(decision || '').trim().toLowerCase();
  return DECISION_ALIASES[raw] || null;
}

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.?\//, '');
}

function isSafeWritePath(relPath) {
  const p = normalizePath(relPath);
  if (!p) return false;
  if (SAFE_WRITE_NAMES.includes(p)) return true;
  return SAFE_WRITE_PREFIXES.some((prefix) => p === prefix.slice(0, -1) || p.startsWith(prefix));
}

function reasonMessage(reason) {
  return REASON_MESSAGES[reason] || REASON_MESSAGES.tool_requires_approval;
}

function defaultPermissionPolicy(tool, args) {
  const name = canonicalTool(tool) || String(tool || '');
  if (name === 'read' || name === 'list') {
    return { verdict: 'allow' };
  }
  if (name === 'exec') {
    return { verdict: 'ask', reason: 'exec_requires_approval' };
  }
  if (name === 'write') {
    const rel = normalizePath(args && (args.path || args.file));
    if (isSafeWritePath(rel)) return { verdict: 'allow' };
    return { verdict: 'ask', reason: 'write_outside_allowlist' };
  }
  return { verdict: 'ask', reason: 'tool_requires_approval' };
}

function getGrants(raw) {
  if (!raw || typeof raw !== 'object') return new Set();
  if (!raw.harness) raw.harness = { items: [] };
  if (!(raw.harness.grants instanceof Set)) {
    const prev = raw.harness.grants;
    raw.harness.grants = new Set(Array.isArray(prev) ? prev : []);
  }
  return raw.harness.grants;
}

function hasGrant(raw, toolName) {
  const tool = canonicalTool(toolName) || String(toolName || '');
  return getGrants(raw).has(tool);
}

function grantTool(raw, toolName) {
  const tool = canonicalTool(toolName) || String(toolName || '');
  if (tool) getGrants(raw).add(tool);
}

function normalizeVerdict(raw) {
  if (raw == null) return { verdict: 'ask', reason: 'tool_requires_approval' };
  if (typeof raw === 'string') {
    const verdict = raw.trim().toLowerCase();
    if (verdict === 'allow' || verdict === 'ask' || verdict === 'deny') {
      return { verdict, reason: verdict === 'deny' ? 'policy_denied' : 'tool_requires_approval' };
    }
    return { verdict: 'ask', reason: 'tool_requires_approval' };
  }
  const verdict = String(raw.verdict || raw.permission || 'ask').trim().toLowerCase();
  if (verdict === 'allow' || verdict === 'ask' || verdict === 'deny') {
    return {
      verdict,
      reason: raw.reason || (verdict === 'deny' ? 'policy_denied' : 'tool_requires_approval'),
    };
  }
  return { verdict: 'ask', reason: raw.reason || 'tool_requires_approval' };
}

function resolvePolicy(policy) {
  return typeof policy === 'function' ? policy : defaultPermissionPolicy;
}

function jailArgsForPolicy(tool, args) {
  const input = args && typeof args === 'object' ? args : {};
  try {
    if (tool === 'write' || tool === 'read') {
      return { args: { ...input, path: jailRelPath(input.path || input.file) }, jailError: null };
    }
    if (tool === 'list') {
      return {
        args: { ...input, path: jailRelPath(input.path || input.dir || '.', { forList: true }) },
        jailError: null,
      };
    }
  } catch (err) {
    return { args: input, jailError: err };
  }
  return { args: input, jailError: null };
}

function authorizeAction(toolName, rawArgs, opts = {}) {
  const tool = canonicalTool(toolName) || String(toolName || '');
  const { args, jailError } = jailArgsForPolicy(tool, rawArgs);
  if (jailError) {
    return {
      tool,
      verdict: 'allow',
      allowed: true,
      needsPermission: false,
      denied: false,
      jailError,
      args,
    };
  }
  if (opts.approved === true || hasGrant(opts.raw, tool)) {
    return {
      tool,
      verdict: 'allow',
      allowed: true,
      needsPermission: false,
      denied: false,
      args,
    };
  }
  const decided = normalizeVerdict(resolvePolicy(opts.policy)(tool, args, opts));
  if (decided.verdict === 'deny') {
    return {
      tool,
      verdict: 'deny',
      allowed: false,
      needsPermission: false,
      denied: true,
      reason: decided.reason,
      message: reasonMessage(decided.reason),
      args,
    };
  }
  if (decided.verdict === 'ask') {
    return {
      tool,
      verdict: 'ask',
      allowed: false,
      needsPermission: true,
      denied: false,
      reason: decided.reason,
      message: reasonMessage(decided.reason),
      args,
    };
  }
  return {
    tool,
    verdict: 'allow',
    allowed: true,
    needsPermission: false,
    denied: false,
    args,
  };
}

function listPending(row) {
  if (!row || !Array.isArray(row.permissions)) return [];
  return row.permissions.filter((item) => item.status === 'pending').map(publicPermission);
}

function publicPermission(item) {
  return {
    id: item.id,
    tool: item.tool,
    args: item.args && typeof item.args === 'object' ? { ...item.args } : {},
    reason: item.reason,
    message: item.message,
    createdAt: item.createdAt,
    status: item.status,
  };
}

function findPending(row, permissionId) {
  const id = String(permissionId || '').trim();
  if (!id) fail('E_PARAMS', 'Falta el id de permiso.');
  const item = (row.permissions || []).find((entry) => entry.id === id);
  if (!item || item.status !== 'pending') fail('E_PERMISSION_NOT_FOUND');
  return item;
}

function createPermission(row, auth) {
  if (!row.permissions) row.permissions = [];
  const item = {
    id: `prm_${crypto.randomBytes(8).toString('hex')}`,
    tool: auth.tool,
    args: argsDigest(auth.tool, auth.args || {}),
    reason: auth.reason || 'tool_requires_approval',
    message: auth.message || reasonMessage(auth.reason),
    createdAt: Date.now(),
    status: 'pending',
  };
  row.permissions.push(item);
  return item;
}

function resolvePending(row, permissionId, decision) {
  const item = findPending(row, permissionId);
  item.status = 'resolved';
  item.decision = decision;
  item.resolvedAt = Date.now();
  return item;
}

function clearPending(row) {
  if (!Array.isArray(row.permissions)) return;
  for (const item of row.permissions) {
    if (item.status === 'pending') {
      item.status = 'resolved';
      item.decision = 'cancelled';
      item.resolvedAt = Date.now();
    }
  }
}

module.exports = {
  DECISIONS,
  DECISION_ALIASES,
  SAFE_WRITE_PREFIXES,
  SAFE_WRITE_NAMES,
  REASON_MESSAGES,
  normalizeDecision,
  isSafeWritePath,
  reasonMessage,
  defaultPermissionPolicy,
  getGrants,
  hasGrant,
  grantTool,
  authorizeAction,
  listPending,
  publicPermission,
  findPending,
  createPermission,
  resolvePending,
  clearPending,
};
