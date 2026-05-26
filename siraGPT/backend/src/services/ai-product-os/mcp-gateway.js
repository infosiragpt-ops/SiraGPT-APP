/**
 * mcp-gateway — Model Context Protocol-shaped surface.
 *
 * The Model Context Protocol (MCP) defines three kinds of "resources"
 * a host can expose to a model runtime:
 *
 *   - tools:    invocable functions with a JSON-Schema input + output
 *   - resources: read-only addressable URIs (data the agent can read)
 *   - prompts:  parameterised prompt templates
 *
 * This gateway is a registry + a JSON-RPC-shaped `call()` dispatcher.
 * It lets the Product OS expose its internal capabilities to any
 * MCP-compatible client (Claude / OpenAI Agents / LangGraph / custom)
 * without coupling to a specific transport.
 *
 * The gateway enforces:
 *   - explicit registration (no silent tool discovery)
 *   - scope-based authorization (per call)
 *   - audit record of every invocation (event envelope)
 *
 * Transport-agnostic: the caller supplies a JSON-RPC 2.0 message or
 * a normalized object; we don't bind to stdio / HTTP / SSE here.
 */

const { createEnvelope } = require("./event-envelope");

const RESOURCE_KINDS = Object.freeze(["tool", "resource", "prompt"]);

function createMcpGateway({ auditor = null } = {}) {
  const tools = new Map();       // name → { input_schema, output_schema, scopes, handler, description }
  const resources = new Map();   // uri  → { mime_type, scopes, read, description }
  const prompts = new Map();     // name → { arguments, render, description }
  const audit = [];

  function registerTool({ name, description, input_schema, output_schema, scopes = [], handler }) {
    mustString(name, "tool.name");
    mustFunction(handler, `tool.${name}.handler`);
    if (tools.has(name)) throw new Error(`mcp-gateway: tool "${name}" already registered`);
    tools.set(name, {
      name, description: description || "", input_schema, output_schema, scopes: [...scopes], handler,
    });
    return name;
  }

  function registerResource({ uri, description, mime_type = "application/json", scopes = [], read }) {
    mustString(uri, "resource.uri");
    mustFunction(read, `resource.${uri}.read`);
    if (resources.has(uri)) throw new Error(`mcp-gateway: resource "${uri}" already registered`);
    resources.set(uri, { uri, description: description || "", mime_type, scopes: [...scopes], read });
    return uri;
  }

  function registerPrompt({ name, description, arguments: args = [], render }) {
    mustString(name, "prompt.name");
    mustFunction(render, `prompt.${name}.render`);
    if (prompts.has(name)) throw new Error(`mcp-gateway: prompt "${name}" already registered`);
    prompts.set(name, { name, description: description || "", arguments: [...args], render });
    return name;
  }

  function listTools() {
    return [...tools.values()].map(t => ({
      name: t.name, description: t.description,
      input_schema: t.input_schema, output_schema: t.output_schema,
      scopes: [...t.scopes],
    }));
  }
  function listResources() {
    return [...resources.values()].map(r => ({
      uri: r.uri, description: r.description, mime_type: r.mime_type, scopes: [...r.scopes],
    }));
  }
  function listPrompts() {
    return [...prompts.values()].map(p => ({
      name: p.name, description: p.description, arguments: [...p.arguments],
    }));
  }

  /**
   * JSON-RPC 2.0-shaped dispatch.
   * Accepted methods:
   *   - tools/list
   *   - tools/call    { name, arguments, scopes }
   *   - resources/list
   *   - resources/read { uri, scopes }
   *   - prompts/list
   *   - prompts/get   { name, arguments }
   */
  async function call(message, { grantedScopes = [], trace = {} } = {}) {
    const envelope = createEnvelope({ type: `mcp.${message?.method || "unknown"}`, payload: message, trace });
    let result;
    let error = null;
    try {
      result = await dispatch(message, grantedScopes);
    } catch (err) {
      error = { code: err.code || "mcp_error", message: err.message };
    }
    const record = {
      id: message?.id ?? null,
      method: message?.method || null,
      envelope_id: envelope.id,
      correlation_id: envelope.correlation_id,
      error,
      ok: error === null,
      ts: new Date().toISOString(),
    };
    audit.push(record);
    if (auditor) { try { auditor(record, envelope, message); } catch (_e) { /* swallow */ } }
    if (error) return { jsonrpc: "2.0", id: message?.id ?? null, error };
    return { jsonrpc: "2.0", id: message?.id ?? null, result };
  }

  async function dispatch(message, grantedScopes) {
    const method = String(message?.method || "");
    const params = message?.params || {};
    switch (method) {
      case "tools/list": return { tools: listTools() };
      case "tools/call": {
        const { name, arguments: args = {}, scopes: requestedScopes = [] } = params;
        const tool = tools.get(name);
        if (!tool) throw mkErr("tool_not_found", `tool "${name}" is not registered`);
        requireScopes(tool.scopes, grantedScopes, requestedScopes, `tool:${name}`);
        const out = await tool.handler(args);
        return { content: out };
      }
      case "resources/list": return { resources: listResources() };
      case "resources/read": {
        const { uri, scopes: requestedScopes = [] } = params;
        const r = resources.get(uri);
        if (!r) throw mkErr("resource_not_found", `resource "${uri}" is not registered`);
        requireScopes(r.scopes, grantedScopes, requestedScopes, `resource:${uri}`);
        const data = await r.read(params);
        return { uri, mime_type: r.mime_type, contents: data };
      }
      case "prompts/list": return { prompts: listPrompts() };
      case "prompts/get": {
        const { name, arguments: args = {} } = params;
        const p = prompts.get(name);
        if (!p) throw mkErr("prompt_not_found", `prompt "${name}" is not registered`);
        const rendered = await p.render(args);
        return { name, content: rendered };
      }
      default:
        throw mkErr("method_not_supported", `unsupported method "${method}"`);
    }
  }

  function auditSnapshot({ limit = 200 } = {}) {
    return audit.slice(-limit);
  }

  function counts() {
    return { tools: tools.size, resources: resources.size, prompts: prompts.size, audit_records: audit.length };
  }

  return {
    registerTool,
    registerResource,
    registerPrompt,
    listTools,
    listResources,
    listPrompts,
    call,
    auditSnapshot,
    counts,
    RESOURCE_KINDS,
  };
}

function mustString(v, label) {
  if (typeof v !== "string" || v.trim().length === 0) throw new Error(`mcp-gateway: ${label} must be a non-empty string`);
}
function mustFunction(v, label) {
  if (typeof v !== "function") throw new Error(`mcp-gateway: ${label} must be a function`);
}

function requireScopes(required, granted, requested, subject) {
  const need = new Set(required || []);
  const have = new Set([...(granted || []), ...(requested || [])]);
  for (const s of need) {
    if (!have.has(s)) throw mkErr("permission_denied", `${subject} requires scope "${s}" which is not granted`);
  }
}

function mkErr(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

module.exports = {
  createMcpGateway,
  RESOURCE_KINDS,
};
