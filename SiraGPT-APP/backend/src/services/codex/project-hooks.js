'use strict';

const crypto = require('node:crypto');

const MAX_HOOKS = 40;
const MAX_MATCHERS = 20;
const MAX_MESSAGE = 500;
const ALLOWED_ACTIONS = new Set(['allow', 'deny', 'transform']);

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function cleanMatcher(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 120 || !/^[a-zA-Z0-9_*?.:-]+$/.test(text)) return null;
  return text;
}

function normaliseHook(raw) {
  const row = asObject(raw);
  const values = Array.isArray(row.matcher) ? row.matcher : [row.matcher];
  const matchers = values.map(cleanMatcher).filter(Boolean).slice(0, MAX_MATCHERS);
  const action = String(row.action || '').trim().toLowerCase();
  if (!matchers.length || !ALLOWED_ACTIONS.has(action)) return null;
  const args = action === 'transform' ? asObject(row.args) : {};
  return {
    matchers,
    action,
    args: JSON.parse(JSON.stringify(args)),
    message: String(row.message || '').slice(0, MAX_MESSAGE),
  };
}

function normaliseList(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new Error('hooks must be arrays');
  if (raw.length > MAX_HOOKS) throw new Error(`hooks exceed ${MAX_HOOKS}`);
  const hooks = raw.map(normaliseHook);
  if (hooks.some((hook) => !hook)) throw new Error('invalid hook entry');
  return hooks;
}

function parseHooks(text) {
  if (!String(text || '').trim()) return {
    version: 1,
    preToolUse: [],
    postToolUse: [],
    stop: [],
  };
  const parsed = JSON.parse(String(text));
  const root = asObject(parsed);
  if (root.version != null && Number(root.version) !== 1) throw new Error('unsupported hooks version');
  return {
    version: 1,
    preToolUse: normaliseList(root.preToolUse),
    postToolUse: normaliseList(root.postToolUse),
    stop: normaliseList(root.stop),
  };
}

async function loadProjectHooks({ runner, projectId }) {
  try {
    const out = await runner.readFile(projectId, '.sira/hooks.json');
    return { hooks: parseHooks(out?.content), error: null };
  } catch (error) {
    if (/not[ _-]?found|enoent|missing|no existe/i.test(String(error?.message || ''))) {
      return { hooks: parseHooks(''), error: null };
    }
    return { hooks: parseHooks(''), error: String(error?.message || error) };
  }
}

function globMatch(pattern, name) {
  const escaped = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('**', '\u0000')
    .replaceAll('*', '.*')
    .replaceAll('?', '.')
    .replaceAll('\u0000', '.*');
  return new RegExp(`^${escaped}$`, 'i').test(String(name || ''));
}

function hookMatches(hook, toolName) {
  return hook.matchers.some((matcher) => globMatch(matcher, toolName));
}

function applyPreHooks(hooks, toolName, args) {
  let nextArgs = asObject(args);
  for (const hook of hooks?.preToolUse || []) {
    if (!hookMatches(hook, toolName)) continue;
    if (hook.action === 'deny') {
      return { allowed: false, args: nextArgs, message: hook.message || `tool ${toolName} denied by project hook` };
    }
    if (hook.action === 'transform') nextArgs = { ...nextArgs, ...hook.args };
  }
  return { allowed: true, args: nextArgs, message: '' };
}

function applyPostHooks(hooks, toolName, result) {
  let next = asObject(result);
  for (const hook of hooks?.postToolUse || []) {
    if (!hookMatches(hook, toolName)) continue;
    if (hook.action === 'deny') {
      next = {
        ...next,
        isError: true,
        summary: hook.message || `tool ${toolName} result denied by project hook`,
        observation: hook.message || `Tool result blocked by project policy.`,
      };
    } else if (hook.action === 'transform') {
      next = { ...next, ...hook.args };
    }
  }
  return next;
}

function applyStopHooks(hooks, outcome = {}) {
  let next = { ...asObject(outcome) };
  const status = String(next.status || 'done');
  for (const hook of hooks?.stop || []) {
    if (!hookMatches(hook, status)) continue;
    if (hook.action === 'deny') {
      return {
        allowed: false,
        outcome: next,
        message: hook.message || `stop denied for status ${status}`,
      };
    }
    if (hook.action === 'transform') next = { ...next, ...hook.args };
  }
  return { allowed: true, outcome: next, message: '' };
}

function permissionMatchers(project) {
  const permissions = asObject(project?.brief).permissions;
  if (Array.isArray(permissions)) return permissions.map(cleanMatcher).filter(Boolean);
  const root = asObject(permissions);
  const tools = Array.isArray(root.requireApproval) ? root.requireApproval : root.tools;
  return Array.isArray(tools) ? tools.map(cleanMatcher).filter(Boolean) : [];
}

function mcpToolName(toolName, args) {
  const name = String(toolName || '');
  if (/^mcp__[a-z0-9_]+__[A-Za-z0-9_]+$/.test(name)) return name;
  if (name === 'mcp_call') {
    const target = String(asObject(args).tool || '').trim();
    return /^mcp__[a-z0-9_]+__[A-Za-z0-9_]+$/.test(target) ? target : 'mcp__unknown__unknown';
  }
  return null;
}

function mcpAllowMatchers(project) {
  const permissions = asObject(asObject(project?.brief).permissions);
  const values = permissions.mcpAllowWithoutApproval;
  return Array.isArray(values) ? values.map(cleanMatcher).filter(Boolean) : [];
}

function requiresApproval(project, toolName, args = {}, settings = null) {
  const mcpName = mcpToolName(toolName, args);
  if (mcpName) {
    const settingsAllow = Array.isArray(settings?.tools?.mcpAllowWithoutApproval)
      ? settings.tools.mcpAllowWithoutApproval
      : [];
    const explicitlyAllowed = [...mcpAllowMatchers(project), ...settingsAllow]
      .some((matcher) => globMatch(matcher, mcpName));
    if (!explicitlyAllowed) return true;
  }
  if (permissionMatchers(project).some((matcher) => globMatch(matcher, toolName))) return true;
  if (settings) {
    // Lazy require avoids a module cycle while project-settings reuses globMatch.
    // eslint-disable-next-line global-require
    if (require('./project-settings').requiresApproval(settings, toolName)) return true;
  }
  return false;
}

function canonicalJson(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return JSON.stringify(null);
    return JSON.stringify(value);
  }
  if (seen.has(value)) throw new TypeError('permission arguments must not be circular');
  seen.add(value);
  let encoded;
  if (Array.isArray(value)) {
    encoded = `[${value.map((item) => canonicalJson(item, seen)).join(',')}]`;
  } else {
    const keys = Object.keys(value).sort();
    encoded = `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], seen)}`).join(',')}}`;
  }
  seen.delete(value);
  return encoded;
}

function permissionBindingHash({
  runId,
  projectId,
  toolName,
  args,
}) {
  const payload = {
    version: 1,
    runId: String(runId || ''),
    projectId: String(projectId || ''),
    toolName: String(toolName || ''),
    args: asObject(args),
  };
  return crypto.createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

module.exports = {
  MAX_HOOKS,
  parseHooks,
  loadProjectHooks,
  globMatch,
  applyPreHooks,
  applyPostHooks,
  applyStopHooks,
  permissionMatchers,
  mcpAllowMatchers,
  requiresApproval,
  permissionBindingHash,
  canonicalJson,
};
