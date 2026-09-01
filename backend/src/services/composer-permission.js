'use strict';

/**
 * Composer permission levels from /agentes (#513 / #519).
 *
 * Stable ids: default | read | protected | workspace | full
 * Payload field: `permission` (aliases: toolPermission, composerPermission).
 * Unknown / missing values fall back to `default` (agent policy) — never
 * silently remap `full` to a more restrictive level.
 */

const COMPOSER_PERMISSIONS = Object.freeze([
  'default',
  'read',
  'protected',
  'workspace',
  'full',
]);

const WRITE_TOOLS = new Set([
  'write',
  'edit',
  'write_file',
  'edit_file',
  'str_replace',
  'host_file',
  'computer_write_file',
  'computer_edit_file',
  'clone_project',
]);

const COMMAND_TOOLS = new Set([
  'bash',
  'execute_bash',
  'host_bash',
]);

const HOST_ESCAPE_TOOLS = new Set([
  'host_bash',
  'host_file',
  'clone_project',
]);

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
  host_bash: 'host_bash',
  host_file: 'host_file',
  computer_write_file: 'computer_write_file',
  computer_edit_file: 'computer_edit_file',
  clone_project: 'clone_project',
});

function canonicalTool(name) {
  const raw = String(name || '').trim();
  return TOOL_ALIASES[raw] || raw;
}

function isComposerPermissionId(value) {
  return COMPOSER_PERMISSIONS.includes(String(value || '').trim());
}

function normalizeComposerPermission(value) {
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  if (isComposerPermissionId(raw)) return raw;
  return 'default';
}

function resolveComposerPermission(source = {}) {
  if (source == null || typeof source !== 'object') return 'default';
  const raw = source.permission != null
    ? source.permission
    : (source.toolPermission != null ? source.toolPermission : source.composerPermission);
  return normalizeComposerPermission(raw);
}

function classifiesAsWrite(toolName) {
  const tool = canonicalTool(toolName);
  return WRITE_TOOLS.has(tool);
}

function classifiesAsCommand(toolName) {
  const tool = canonicalTool(toolName);
  return COMMAND_TOOLS.has(tool);
}

function classifiesAsHostEscape(toolName) {
  const tool = canonicalTool(toolName);
  return HOST_ESCAPE_TOOLS.has(tool);
}

/**
 * Composer-layer verdict. Agent policy still applies when this returns allow
 * on `default`. `full` never adds a reviewer and never remaps to read.
 *
 * @returns {{
 *   permission: string,
 *   tool: string,
 *   verdict: 'allow'|'ask'|'deny',
 *   allowed: boolean,
 *   needsPermission: boolean,
 *   denied: boolean,
 *   reason: string|null,
 *   writable: boolean,
 *   command: boolean,
 * }}
 */
function authorizeComposerTool(permission, toolName, opts = {}) {
  const level = normalizeComposerPermission(permission);
  const tool = canonicalTool(toolName);
  const writable = classifiesAsWrite(toolName);
  const command = classifiesAsCommand(toolName);
  const approved = opts.approved === true || opts.approvalGranted === true;

  const base = {
    permission: level,
    tool,
    writable,
    command,
  };

  if (level === 'full') {
    return {
      ...base,
      verdict: 'allow',
      allowed: true,
      needsPermission: false,
      denied: false,
      reason: null,
    };
  }

  if (level === 'read' && (writable || command)) {
    return {
      ...base,
      verdict: 'deny',
      allowed: false,
      needsPermission: false,
      denied: true,
      reason: 'composer_read_only',
    };
  }

  if (level === 'protected' && writable && !approved) {
    return {
      ...base,
      verdict: 'ask',
      allowed: false,
      needsPermission: true,
      denied: false,
      reason: 'composer_approval_required',
    };
  }

  if (level === 'workspace' && classifiesAsHostEscape(toolName)) {
    return {
      ...base,
      verdict: 'deny',
      allowed: false,
      needsPermission: false,
      denied: true,
      reason: 'composer_workspace_scope',
    };
  }

  return {
    ...base,
    verdict: 'allow',
    allowed: true,
    needsPermission: false,
    denied: false,
    reason: null,
  };
}

function composerDeniedResult(auth, extra = {}) {
  return {
    ok: false,
    error: auth.reason || 'composer_permission_denied',
    code: auth.reason || 'composer_permission_denied',
    message: auth.permission === 'read'
      ? 'Solo lectura: se bloquean las escrituras y los comandos.'
      : auth.permission === 'protected'
        ? 'Protegido: las escrituras requieren un revisor de aprobación.'
        : auth.permission === 'workspace'
          ? 'Workspace: la computadora sigue acotada a /workspace de esta conversación.'
          : 'Permiso denegado.',
    permission: auth.permission,
    tool: auth.tool,
    ...extra,
  };
}

module.exports = {
  COMPOSER_PERMISSIONS,
  WRITE_TOOLS,
  COMMAND_TOOLS,
  canonicalTool,
  isComposerPermissionId,
  normalizeComposerPermission,
  resolveComposerPermission,
  classifiesAsWrite,
  classifiesAsCommand,
  authorizeComposerTool,
  composerDeniedResult,
};
