/**
 * auth/hooks — pre-execution authorization hook for every tool call.
 *
 * The agent runtime MUST invoke `beforeToolCall(ctx, tool, args)` before
 * dispatching to a tool handler. The hook returns one of three outcomes:
 *
 *   { decision: 'allow',     tool, args }
 *   { decision: 'transform', tool, args, transforms[] }
 *   { decision: 'deny',      tool, code, reason }
 *
 * Decisions are based on:
 *   1. Authentication           — ctx.userId must be present.
 *   2. Scope hierarchy          — admin > owner > member. Tools declare a
 *                                 minimum required scope via
 *                                 `tool.metadata.scope` (or the static
 *                                 fallback in DEFAULT_TOOL_SCOPES).
 *   3. Per-tool allowlists      — `tool.metadata.allow` may declare per-arg
 *                                 allowlists (exact strings, or RegExps in
 *                                 source form prefixed with `re:`).
 *   4. SecretRef resolution     — args may carry `{ $secret: 'NAME' }`
 *                                 placeholders. The hook never lets the
 *                                 plain value through; it strips the ref
 *                                 from the visible args and records it for
 *                                 late binding by the runtime via
 *                                 `resolveSecrets(args, store)`.
 *
 * All denials are emitted to the structured audit log for forensic review.
 *
 * No openclaw code was used; the design is intentionally smaller and more
 * declarative.
 */

const { audit } = require('../services/agents/audit-log');

const SCOPE_HIERARCHY = ['member', 'owner', 'admin'];

// Conservative defaults for the tools currently wired into the runtime.
// Any tool not listed here defaults to 'member' (lowest privilege bar).
const DEFAULT_TOOL_SCOPES = Object.freeze({
  bash_exec: 'admin',
  python_exec: 'owner',
  run_tests: 'owner',
  create_document: 'member',
  web_search: 'member',
  rag_retrieve: 'member',
  self_rag_answer: 'member',
  verify_artifact: 'member',
  read_file: 'member',
  list_files: 'member',
  search_docs: 'member',
  search_code: 'member',
  search_graph: 'member',
  get_symbol: 'member',
  static_checks: 'member',
  propose_patch: 'owner',
});

function scopeRank(scope) {
  const idx = SCOPE_HIERARCHY.indexOf(scope);
  return idx < 0 ? -1 : idx;
}

function maxScopeRank(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0) return -1;
  let max = -1;
  for (const s of scopes) {
    const r = scopeRank(s);
    if (r > max) max = r;
  }
  return max;
}

function normalizeScopes(ctx) {
  if (!ctx) return [];
  if (Array.isArray(ctx.scopes)) return ctx.scopes;
  if (typeof ctx.scope === 'string') return [ctx.scope];
  if (ctx.isSuperAdmin) return ['admin'];
  if (ctx.isAdmin) return ['admin'];
  return ['member'];
}

function getToolName(tool) {
  if (!tool) return null;
  if (typeof tool === 'string') return tool;
  return tool.name || tool.id || null;
}

function getToolMetadata(tool) {
  if (!tool || typeof tool !== 'object') return {};
  return tool.metadata || tool.meta || {};
}

function getRequiredScope(tool) {
  const meta = getToolMetadata(tool);
  if (typeof meta.scope === 'string' && scopeRank(meta.scope) >= 0) return meta.scope;
  const name = getToolName(tool);
  if (name && DEFAULT_TOOL_SCOPES[name]) return DEFAULT_TOOL_SCOPES[name];
  return 'member';
}

function matchAllowlistEntry(entry, value) {
  if (typeof entry !== 'string' || typeof value !== 'string') return false;
  if (entry.startsWith('re:')) {
    try {
      return new RegExp(entry.slice(3)).test(value);
    } catch {
      return false;
    }
  }
  return entry === value;
}

function checkAllowlists(allow, args) {
  if (!allow || typeof allow !== 'object') return { ok: true };
  for (const [key, list] of Object.entries(allow)) {
    if (!Array.isArray(list)) continue;
    const value = args ? args[key] : undefined;
    if (value === undefined || value === null) continue;
    const matched = list.some((entry) => matchAllowlistEntry(entry, String(value)));
    if (!matched) {
      return { ok: false, key, value };
    }
  }
  return { ok: true };
}

const SECRET_REF_KEY = '$secret';

function isSecretRef(node) {
  return (
    node &&
    typeof node === 'object' &&
    !Array.isArray(node) &&
    typeof node[SECRET_REF_KEY] === 'string' &&
    node[SECRET_REF_KEY].length > 0
  );
}

/**
 * Walk args, replacing `{ $secret: 'NAME' }` nodes with a sentinel
 * placeholder string. Returns a sanitized copy plus the discovered refs
 * with their JSON pointers, so the runtime can re-bind the actual value
 * after the auth decision but before the tool executes.
 */
function stripSecretRefs(input) {
  const refs = [];
  function walk(node, pointer) {
    if (isSecretRef(node)) {
      refs.push({ pointer, name: node[SECRET_REF_KEY] });
      return { __secret_ref__: node[SECRET_REF_KEY] };
    }
    if (Array.isArray(node)) {
      return node.map((child, i) => walk(child, `${pointer}/${i}`));
    }
    if (node && typeof node === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        out[k] = walk(v, `${pointer}/${escapeJsonPointer(k)}`);
      }
      return out;
    }
    return node;
  }
  const sanitized = walk(input, '');
  return { args: sanitized, refs };
}

function escapeJsonPointer(segment) {
  return String(segment).replace(/~/g, '~0').replace(/\//g, '~1');
}

function unescapeJsonPointer(segment) {
  return String(segment).replace(/~1/g, '/').replace(/~0/g, '~');
}

function setByPointer(root, pointer, value) {
  if (!pointer) return value;
  const parts = pointer.split('/').slice(1).map(unescapeJsonPointer);
  let node = root;
  for (let i = 0; i < parts.length - 1; i++) {
    node = node[parts[i]];
  }
  node[parts[parts.length - 1]] = value;
  return root;
}

/**
 * Late-bind secrets resolved via the hook's transform. `store` may be
 * either a function `(name) => string|undefined` or an object with a
 * `.get(name)` method.
 *
 * Throws when a referenced secret cannot be resolved — failing closed is
 * always preferable to leaking a partial credential.
 */
function resolveSecrets(args, refs, store) {
  if (!Array.isArray(refs) || refs.length === 0) return args;
  const get = typeof store === 'function'
    ? store
    : (name) => (store && typeof store.get === 'function' ? store.get(name) : undefined);

  const cloned = args === undefined ? args : JSON.parse(JSON.stringify(args));
  for (const ref of refs) {
    const value = get(ref.name);
    if (value === undefined || value === null) {
      throw new Error(`secret "${ref.name}" not found in store`);
    }
    setByPointer(cloned, ref.pointer, value);
  }
  return cloned;
}

function deny({ tool, code, reason, ctx, args }) {
  audit({
    event: 'tool_call_denied',
    tool,
    code,
    reason,
    userId: ctx?.userId || null,
    scopes: normalizeScopes(ctx),
    // args are redacted by audit-log; still avoid sending raw secrets
    argsKeys: args && typeof args === 'object' ? Object.keys(args) : null,
  });
  return { decision: 'deny', tool, code, reason };
}

/**
 * Pre-execution authorization hook.
 *
 * @param {object} ctx   { userId, scopes?: string[], orgId?, ... }
 * @param {object|string} tool  Tool object (with .name + .metadata) or name.
 * @param {object} args  Raw args from the model.
 * @returns {{ decision: 'allow'|'deny'|'transform', tool: string, args?: any, refs?: any[], code?: string, reason?: string }}
 */
function beforeToolCall(ctx, tool, args) {
  const toolName = getToolName(tool);
  if (!toolName) {
    return deny({ tool: '<unknown>', code: 'UNKNOWN_TOOL', reason: 'no tool name', ctx, args });
  }

  if (!ctx || !ctx.userId) {
    return deny({ tool: toolName, code: 'UNAUTHENTICATED', reason: 'missing ctx.userId', ctx, args });
  }

  const requiredScope = getRequiredScope(tool);
  const scopes = normalizeScopes(ctx);
  if (maxScopeRank(scopes) < scopeRank(requiredScope)) {
    return deny({
      tool: toolName,
      code: 'SCOPE_DENIED',
      reason: `requires "${requiredScope}", have [${scopes.join(',')}]`,
      ctx,
      args,
    });
  }

  const meta = getToolMetadata(tool);
  const allowResult = checkAllowlists(meta.allow, args);
  if (!allowResult.ok) {
    return deny({
      tool: toolName,
      code: 'ALLOWLIST_DENIED',
      reason: `argument "${allowResult.key}" value not in allowlist`,
      ctx,
      args,
    });
  }

  const { args: sanitized, refs } = stripSecretRefs(args);
  if (refs.length > 0) {
    return { decision: 'transform', tool: toolName, args: sanitized, refs };
  }

  return { decision: 'allow', tool: toolName, args };
}

module.exports = {
  beforeToolCall,
  resolveSecrets,
  stripSecretRefs,
  // exported for tests / advanced wiring
  SCOPE_HIERARCHY,
  DEFAULT_TOOL_SCOPES,
  scopeRank,
  maxScopeRank,
};
