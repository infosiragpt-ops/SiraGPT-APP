'use strict';

/**
 * tool-registry — declarative tool registry for the agent harness.
 *
 * Each tool is registered ONCE with:
 *   - name              — snake_case, unique.
 *   - description       — model-facing. Includes explicit WHEN-TO-USE and
 *                         WHEN-NOT-TO-USE criteria (ACI guidance: the
 *                         description is the interface contract the model
 *                         programs against).
 *   - inputSchema       — a Zod schema. Converted to JSON Schema for the
 *                         OpenAI tools payload / AJV validation, used
 *                         directly (safeParse) for typed validation+coercion.
 *   - permissionTier    — 'auto' (runs immediately) | 'confirm' (the loop
 *                         pauses and asks the user via permission_request).
 *   - humanDescription  — (args) => short human string for the UI timeline
 *                         ("Buscando «tarifas 2026»", "Ejecutando JavaScript").
 *   - execute           — async (args, ctx) => result. Errors thrown here are
 *                         fed back to the model as is_error tool results by
 *                         the loop — never thrown out of the turn.
 *
 * The registry ALSO carries a metadata overlay (`setToolMeta`) for tools
 * that are defined elsewhere (the ~80 existing chat tools, MCP tools), so
 * the event stream and the permission gate can resolve tier/description for
 * EVERY tool in the turn without rewriting their definitions.
 */

const { z } = require('zod');
const { zodToJsonSchema } = require('zod-to-json-schema');

const VALID_TIERS = new Set(['auto', 'confirm']);

/**
 * Tools defined OUTSIDE the harness that must pause for user confirmation
 * when the interactive permission gate is active. Host-level tools remain
 * additionally guarded by chat-tool-policy clearances — this tier only adds
 * the in-chat confirmation card on top.
 */
const DEFAULT_TIER_OVERRIDES = Object.freeze({
  host_bash: 'confirm',
  host_file: 'confirm',
  clone_project: 'confirm',
  git_commit_push: 'confirm',
  git_workflow: 'confirm',
});

function jsonSchemaFromZod(schema, name) {
  const json = zodToJsonSchema(schema, { $refStrategy: 'none', name: undefined });
  // AJV (react-agent arg validation) compiles tool.parameters directly; the
  // $schema meta key is noise there and in the OpenAI payload.
  if (json && typeof json === 'object') delete json.$schema;
  if (!json || json.type !== 'object') {
    throw new Error(`tool ${name}: inputSchema must be a Zod object schema`);
  }
  return json;
}

function formatZodIssues(issues = []) {
  return issues
    .slice(0, 6)
    .map((issue) => `${issue.path && issue.path.length ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('; ');
}

function createToolRegistry() {
  const tools = new Map(); // name → normalized def
  const metaOverlay = new Map(); // name → { permissionTier?, humanDescription? }
  for (const [name, tier] of Object.entries(DEFAULT_TIER_OVERRIDES)) {
    metaOverlay.set(name, { permissionTier: tier });
  }

  function register(def = {}) {
    const name = String(def.name || '').trim();
    if (!name) throw new Error('tool-registry: name is required');
    if (!/^[a-z][a-z0-9_]*$/.test(name)) {
      throw new Error(`tool-registry: invalid tool name "${name}" (snake_case required)`);
    }
    if (tools.has(name)) throw new Error(`tool-registry: duplicate tool "${name}"`);
    if (typeof def.execute !== 'function') throw new Error(`tool ${name}: execute() is required`);
    if (!def.inputSchema || typeof def.inputSchema.safeParse !== 'function') {
      throw new Error(`tool ${name}: inputSchema must be a Zod schema`);
    }
    const permissionTier = def.permissionTier || 'auto';
    if (!VALID_TIERS.has(permissionTier)) {
      throw new Error(`tool ${name}: permissionTier must be 'auto' or 'confirm'`);
    }
    const normalized = {
      name,
      description: String(def.description || ''),
      inputSchema: def.inputSchema,
      parameters: jsonSchemaFromZod(def.inputSchema, name),
      permissionTier,
      humanDescription: typeof def.humanDescription === 'function'
        ? def.humanDescription
        : () => `Usando ${name}`,
      execute: def.execute,
      source: def.source || 'builtin',
      timeoutMs: Number(def.timeoutMs) > 0 ? Number(def.timeoutMs) : null,
    };
    tools.set(name, normalized);
    return normalized;
  }

  function get(name) {
    return tools.get(String(name || '')) || null;
  }

  function list() {
    return Array.from(tools.values());
  }

  /** Validate+coerce args through the tool's Zod schema. */
  function validateArgs(name, args) {
    const tool = get(name);
    if (!tool) return { ok: false, error: `unknown_tool: ${name}` };
    const parsed = tool.inputSchema.safeParse(args ?? {});
    if (!parsed.success) {
      return { ok: false, error: `invalid_tool_args: ${formatZodIssues(parsed.error.issues)}` };
    }
    return { ok: true, args: parsed.data };
  }

  /**
   * Project a registry tool into the shape react-agent consumes
   * ({name, description, parameters, execute}). Zod validation runs INSIDE
   * execute so prompted-mode JSON (already string-parsed upstream) gets the
   * same typed errors as native calls.
   */
  function toAgentTool(name) {
    const tool = get(name);
    if (!tool) return null;
    return {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      execute: async (args, ctx) => {
        const validation = validateArgs(tool.name, args);
        if (!validation.ok) throw new Error(validation.error);
        return tool.execute(validation.args, ctx);
      },
    };
  }

  function toAgentTools() {
    return Array.from(tools.keys()).map((name) => toAgentTool(name));
  }

  /** OpenAI `tools` payload entries for every registered tool. */
  function toOpenAITools() {
    return list().map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  /** Attach harness metadata to a tool defined elsewhere. */
  function setToolMeta(name, meta = {}) {
    const key = String(name || '').trim();
    if (!key) return;
    const existing = metaOverlay.get(key) || {};
    metaOverlay.set(key, { ...existing, ...meta });
  }

  /**
   * Resolve harness metadata (tier + human description) for ANY tool name —
   * registry tools, overlay-annotated existing tools, or MCP tools (which
   * default to 'confirm': they execute on third-party servers).
   */
  function metaFor(name, args = {}) {
    const key = String(name || '');
    const tool = tools.get(key);
    const overlay = metaOverlay.get(key) || {};
    const isMcp = key.startsWith('mcp__');
    const permissionTier = overlay.permissionTier
      || (tool && tool.permissionTier)
      || (isMcp ? 'confirm' : 'auto');
    let humanDescription = null;
    const describe = overlay.humanDescription
      || (tool && tool.humanDescription)
      || null;
    if (typeof describe === 'function') {
      try { humanDescription = describe(args); } catch (_) { humanDescription = null; }
    } else if (typeof describe === 'string') {
      humanDescription = describe;
    }
    if (!humanDescription) {
      humanDescription = isMcp
        ? `Usando herramienta externa ${key.replace(/^mcp__/, '').replace(/__/g, ' · ')}`
        : `Usando ${key}`;
    }
    return { permissionTier, humanDescription, source: tool ? tool.source : (isMcp ? 'mcp' : 'external') };
  }

  return {
    register,
    get,
    list,
    validateArgs,
    toAgentTool,
    toAgentTools,
    toOpenAITools,
    setToolMeta,
    metaFor,
  };
}

module.exports = {
  createToolRegistry,
  DEFAULT_TIER_OVERRIDES,
  z,
};
