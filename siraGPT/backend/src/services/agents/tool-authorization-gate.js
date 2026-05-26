'use strict';

/**
 * tool-authorization-gate — single chokepoint that every tool dispatch
 * (auto-reply, native commands, MCP, Tavily, etc.) routes through
 * before execution. Mirrors the openclaw v2026.5.7 hardening: tool
 * authorization decisions and runtime credential resolution must live
 * in one place so a missing key cannot reach execution.
 *
 * Pipeline (short-circuits on the first deny):
 *
 *   1. authorizeToolCall(toolName, callerCtx)        — manifest-based
 *   2. resolveCredential(name) for every entry in    — runtime creds
 *      manifest.requires_credentials                    must resolve
 *   3. hooks.forEach(hook(toolName, ctx))            — caller-supplied
 *      pre-dispatch checks (rate-limit, audit, etc.)
 *
 * Public API:
 *   const gate = createAuthorizationGate({
 *     resolveCredential,    // (name) => string | null
 *     hooks: [],            // [(toolName, ctx) => {ok:bool, reason?, ...}]
 *     getManifest,          // optional override (defaults to tool-manifest)
 *     authorize,            // optional override
 *   })
 *   gate.authorize('tavily_search', callerCtx)
 *     → { ok: true,  manifest, credentials }
 *     → { ok: false, reason, ... }
 */

let _toolManifest;
function loadToolManifest() {
  if (!_toolManifest) _toolManifest = require('./tool-manifest');
  return _toolManifest;
}

const TERMINAL_REASONS = new Set([
  'unknown_tool',
  'missing_scopes',
  'data_class_denied',
  'requires_confirmation',
  'destructive_requires_approval',
  'missing_credentials',
  'hook_denied',
]);

function isTerminalReason(reason) {
  return TERMINAL_REASONS.has(reason);
}

function createAuthorizationGate(opts = {}) {
  const resolveCredential = typeof opts.resolveCredential === 'function'
    ? opts.resolveCredential
    : null;
  const hooks = Array.isArray(opts.hooks)
    ? opts.hooks.filter((h) => typeof h === 'function')
    : [];
  const getManifestFn = typeof opts.getManifest === 'function'
    ? opts.getManifest
    : (name) => loadToolManifest().getManifest(name);
  const authorizeFn = typeof opts.authorize === 'function'
    ? opts.authorize
    : (name, ctx) => loadToolManifest().authorizeToolCall(name, ctx);

  function authorize(toolName, ctx = {}) {
    if (typeof toolName !== 'string' || !toolName) {
      return { ok: false, reason: 'invalid_tool_name' };
    }

    // 1. Manifest-based authorization (scopes, data classes, approval).
    let baseDecision;
    try {
      baseDecision = authorizeFn(toolName, ctx);
    } catch (err) {
      return { ok: false, reason: 'authorize_threw', error: err && err.message };
    }
    if (!baseDecision || baseDecision.ok !== true) {
      return baseDecision || { ok: false, reason: 'denied' };
    }

    // 2. Runtime credential resolution. The manifest declares the
    //    credential names a tool needs; we resolve each from the live
    //    runtime config (env, vault, etc.) right before dispatch so a
    //    rotated key takes effect on the next call.
    const manifest = getManifestFn(toolName);
    const required = Array.isArray(manifest && manifest.requires_credentials)
      ? manifest.requires_credentials
      : [];
    const credentials = {};
    const missing = [];
    for (const name of required) {
      let value = null;
      if (resolveCredential) {
        try { value = resolveCredential(name, { tool: toolName, ctx }); }
        catch { value = null; }
      }
      if (value == null || value === '') {
        missing.push(name);
      } else {
        credentials[name] = value;
      }
    }
    if (missing.length) {
      return { ok: false, reason: 'missing_credentials', missing };
    }

    // 3. Caller-supplied hooks (audit log, per-tenant rate limit, etc.).
    for (const hook of hooks) {
      let result;
      try {
        result = hook(toolName, { ...ctx, manifest, credentials });
      } catch (err) {
        return { ok: false, reason: 'hook_threw', error: err && err.message };
      }
      if (result && result.ok === false) {
        return {
          ok: false,
          reason: result.reason || 'hook_denied',
          hookName: hook.name || null,
          ...result,
        };
      }
    }

    return { ok: true, manifest, credentials };
  }

  return { authorize };
}

module.exports = {
  createAuthorizationGate,
  isTerminalReason,
  TERMINAL_REASONS,
};
