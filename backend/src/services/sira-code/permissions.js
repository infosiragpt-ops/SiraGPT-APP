'use strict';

/**
 * Tool permission matrix for SiraCode agents.
 *
 * Inspired by OpenCode's permissioned tool loop (allow / ask / deny),
 * rewritten against this repo's agent-runner style. Write tools never
 * run when the verdict is deny; bash in plan mode emits a permission
 * event instead of executing. A later allow / always reply (see
 * permission-resume.js) sets `approved` or a session grant and the
 * same matrix then lets the tool run.
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
  shell: 'bash',
  execute_shell: 'bash',
  grep: 'grep',
  glob: 'glob',
  list_files: 'glob',
  ls: 'ls',
  list_dir: 'ls',
  apply_patch: 'apply_patch',
  webfetch: 'webfetch',
  web_fetch: 'webfetch',
  todo: 'todo',
  todowrite: 'todo',
});

const WRITE_TOOLS = new Set(['write', 'edit', 'apply_patch']);

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

function hasSessionGrant(grants, toolName) {
  if (!grants) return false;
  const tool = canonicalTool(toolName);
  if (grants instanceof Set) return grants.has(tool);
  if (Array.isArray(grants)) return grants.includes(tool);
  if (typeof grants.has === 'function') return grants.has(tool);
  return false;
}

function isApproved(opts = {}) {
  return opts.approved === true
    || opts.approvalGranted === true
    || hasSessionGrant(opts.grants, opts.tool || opts.toolName);
}

function authorizeTool(agentId, toolName, opts = {}) {
  const tool = canonicalTool(toolName);
  const approved = isApproved({ ...opts, tool });
  const composer = authorizeComposerTool(
    opts.permission != null ? opts.permission : resolveComposerPermission(opts),
    toolName,
    { ...opts, approved },
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
  if (composer.denied) {
    return {
      tool,
      verdict: composer.verdict,
      allowed: false,
      needsPermission: false,
      denied: true,
      writable: WRITE_TOOLS.has(tool) || composer.writable,
      reason: composer.reason,
      composer: composer.permission,
    };
  }
  if (composer.needsPermission && !approved) {
    return {
      tool,
      verdict: composer.verdict,
      allowed: false,
      needsPermission: true,
      denied: false,
      writable: WRITE_TOOLS.has(tool) || composer.writable,
      reason: composer.reason,
      composer: composer.permission,
    };
  }
  const verdict = permissionFor(agentId, toolName);
  const writable = WRITE_TOOLS.has(tool);
  if (verdict === 'ask' && approved) {
    return {
      tool,
      verdict: 'allow',
      allowed: true,
      needsPermission: false,
      denied: false,
      writable,
      composer: composer.permission,
    };
  }
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
  hasSessionGrant,
  isApproved,
};
