'use strict';

/**
 * Tool permission matrix for SiraCode agents.
 *
 * Inspired by OpenCode's permissioned tool loop (allow / ask / deny),
 * rewritten against this repo's agent-runner style. Write tools never
 * run when the verdict is deny; bash in plan mode emits a permission
 * event instead of executing.
 */

const { getAgent } = require('./agents');
const {
  authorizeComposerTool,
  resolveComposerPermission,
} = require('../composer-permission');

const TOOL_ALIASES = Object.freeze({
  read_file: 'read',
  read: 'read',
  write_file: 'write',
  write: 'write',
  edit_file: 'edit',
  edit: 'edit',
  str_replace: 'edit',
  execute_bash: 'bash',
  bash: 'bash',
  grep: 'grep',
  glob: 'glob',
  list_files: 'glob',
});

const WRITE_TOOLS = new Set(['write', 'edit']);

function canonicalTool(name) {
  const raw = String(name || '').trim();
  return TOOL_ALIASES[raw] || raw;
}

function permissionFor(agentId, toolName) {
  const agent = getAgent(agentId);
  const tool = canonicalTool(toolName);
  const verdict = agent.tools[tool];
  if (verdict === 'allow' || verdict === 'ask' || verdict === 'deny') return verdict;
  return 'deny';
}

function authorizeTool(agentId, toolName, opts = {}) {
  const tool = canonicalTool(toolName);
  const composer = authorizeComposerTool(
    opts.permission != null ? opts.permission : resolveComposerPermission(opts),
    toolName,
    opts,
  );
  if (composer.permission === 'full') {
    return {
      tool,
      verdict: 'allow',
      allowed: true,
      needsPermission: false,
      denied: false,
      writable: WRITE_TOOLS.has(tool) || composer.writable,
      composer: composer.permission,
    };
  }
  if (composer.denied || composer.needsPermission) {
    return {
      tool,
      verdict: composer.verdict,
      allowed: false,
      needsPermission: composer.needsPermission,
      denied: composer.denied,
      writable: WRITE_TOOLS.has(tool) || composer.writable,
      reason: composer.reason,
      composer: composer.permission,
    };
  }
  const verdict = permissionFor(agentId, toolName);
  const writable = WRITE_TOOLS.has(tool);
  return {
    tool,
    verdict,
    allowed: verdict === 'allow',
    needsPermission: verdict === 'ask',
    denied: verdict === 'deny',
    writable,
    composer: composer.permission,
  };
}

function canWrite(agentId) {
  return permissionFor(agentId, 'write') === 'allow';
}

module.exports = {
  TOOL_ALIASES,
  WRITE_TOOLS,
  canonicalTool,
  permissionFor,
  authorizeTool,
  canWrite,
};
