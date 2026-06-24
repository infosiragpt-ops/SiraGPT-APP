'use strict';

/**
 * run-agent-turn — Phase-1 agent harness assembly for a chat turn.
 *
 * `agentic-chat-stream.runAgenticChat` (the production agent-turn runner —
 * history packing, capability-gated tool-call mode, react-agent loop,
 * degraded-run fallback) calls `attachHarness` right after building its
 * toolset. The harness then:
 *
 *   1. registers the harness-native tools (web_fetch, run_javascript,
 *      create_artifact — plus web_search when the toolset lacks one),
 *   2. discovers the user's external MCP servers and merges their tools
 *      (namespaced mcp__<server>__<tool>, permission tier 'confirm'),
 *   3. wraps EVERY tool's execute with the typed SSE event stream
 *      (tool_call_start / tool_executing / tool_result, blockIndex+seq) and
 *      the interactive permission gate ('confirm' tier pauses the loop until
 *      POST /api/agent/permission answers; deny becomes an is_error tool
 *      result and the loop continues),
 *   4. records every step for post-stream persistence into `agent_steps` +
 *      `messages.agent_metadata` (see agent-steps-store.js).
 *
 * Everything here is fail-open: any harness problem logs and returns the
 * original toolset untouched — the chat must never lose a turn to its own
 * observability layer. Kill switch: SIRAGPT_AGENT_HARNESS=0.
 */

const { createToolRegistry } = require('./tool-registry');
const { createAgentEventStream } = require('./event-stream');
const permissionManager = require('./permission-manager');

function harnessEnabled(env = process.env) {
  const raw = env.SIRAGPT_AGENT_HARNESS;
  if (raw == null || String(raw).trim() === '') return true;
  return !['0', 'false', 'off', 'no'].includes(String(raw).trim().toLowerCase());
}

function buildHarnessTools(existingNames, opts = {}) {
  const defs = [];
  const { buildWebFetchTool } = require('./tools/web-fetch-tool');
  const { buildRunJavascriptTool } = require('./tools/run-javascript-tool');
  const { buildCreateArtifactTool } = require('./tools/create-artifact-tool');
  const { buildWebSearchTool } = require('./tools/web-search-tool');
  for (const build of [buildWebFetchTool, buildRunJavascriptTool, buildCreateArtifactTool, buildWebSearchTool]) {
    try {
      const def = build();
      if (!existingNames.has(def.name)) defs.push(def);
    } catch (err) {
      try { console.warn('[agent-harness] tool registration failed:', err && err.message); } catch (_) { /* noop */ }
    }
  }

  // Sandbox document-editing tools — only when a session is active.
  if (opts.sandboxSessionId) {
    try {
      const { buildSandboxDocTools } = require('./tools/sandbox-doc-tools');
      const sandboxDefs = buildSandboxDocTools(opts.sandboxSessionId);
      for (const def of sandboxDefs) {
        if (!existingNames.has(def.name)) defs.push(def);
      }
    } catch (err) {
      try { console.warn('[agent-harness] sandbox tools registration failed:', err && err.message); } catch (_) { /* noop */ }
    }
  }

  // Cowork-style document editing — only when the turn has attached files.
  // The tool itself re-verifies ownership and confines edits to ctx.fileIds.
  if (opts.hasAttachments) {
    try {
      const { buildDocumentEditTool } = require('./tools/document-edit-tool');
      const def = buildDocumentEditTool();
      if (!existingNames.has(def.name)) defs.push(def);
    } catch (err) {
      try { console.warn('[agent-harness] document_edit registration failed:', err && err.message); } catch (_) { /* noop */ }
    }
  }

  return defs;
}

/**
 * @param {object} opts
 * @param {Array}    opts.tools        — the turn's toolset (react-agent shape).
 * @param {function} opts.write        — async (payload) => SSE frame writer.
 * @param {string|null} [opts.chatId]
 * @param {string|null} [opts.userId]
 * @param {object|null} [opts.prisma]  — for MCP server discovery.
 * @param {AbortSignal} [opts.signal]
 * @param {function} [opts.describeTool] — (name, args) => human label for
 *                   tools defined outside the harness (the chat's stage
 *                   labels), reused so the UI shows ONE consistent voice.
 * @param {boolean} [opts.mcpEnabled=true]
 * @returns {Promise<object|null>} harness context or null when disabled.
 */
async function attachHarness(opts = {}) {
  if (!harnessEnabled()) return null;
  const {
    tools = [],
    write = async () => {},
    chatId = null,
    userId = null,
    prisma = null,
    signal = null,
    describeTool = null,
    mcpEnabled = true,
    provider = null,
    sandboxSessionId = null,
    fileIds = [],
  } = opts;

  const registry = createToolRegistry();
  const existingNames = new Set(tools.map((t) => t && t.name).filter(Boolean));

  // Human labels for the ~80 tools defined outside the harness.
  if (typeof describeTool === 'function') {
    for (const name of existingNames) {
      registry.setToolMeta(name, {
        humanDescription: (args) => {
          try { return describeTool(name, args); } catch (_) { return `Usando ${name}`; }
        },
      });
    }
  }

  // Harness-native tools (registry-defined: Zod validation + tiers).
  // When sandboxSessionId is present the 4 sandbox_* document tools are added;
  // when the turn carries attachments, document_edit (Cowork editing) is too.
  const harnessDefs = buildHarnessTools(existingNames, {
    sandboxSessionId,
    hasAttachments: Array.isArray(fileIds) && fileIds.filter(Boolean).length > 0,
  });
  for (const def of harnessDefs) registry.register(def);
  const harnessTools = harnessDefs.map((def) => registry.toAgentTool(def.name));

  // External MCP servers — never allowed to break the turn.
  let mcpTools = [];
  let mcpErrors = [];
  if (mcpEnabled && userId && prisma) {
    try {
      const { loadUserMcpTools } = require('./mcp-client');
      const loaded = await loadUserMcpTools({ userId, prisma });
      mcpTools = loaded.tools.filter((t) => t && !existingNames.has(t.name));
      mcpErrors = loaded.errors;
      for (const tool of mcpTools) {
        registry.setToolMeta(tool.name, { permissionTier: 'confirm' });
      }
    } catch (err) {
      try { console.warn('[agent-harness] MCP discovery failed:', err && err.message); } catch (_) { /* noop */ }
    }
  }

  const events = createAgentEventStream({
    write,
    registry,
    permission: permissionManager,
    ctxInfo: { chatId, userId },
    provider,
    signal,
  });

  const merged = tools.concat(harnessTools, mcpTools);
  const wrappedTools = events.wrapTools(merged);

  return {
    tools: wrappedTools,
    registry,
    events,
    mcpErrors,
    addedToolNames: harnessTools.map((t) => t.name).concat(mcpTools.map((t) => t.name)),
    onStepStart: (stepRec) => events.onStepStart(stepRec),
    onStepDone: (stepRec) => events.onStepDone(stepRec),
    /**
     * Close the run and return the persistence-ready record
     * ({steps, toolCallCount, durationMs, tokensEstimate, …}).
     */
    finish: ({ stoppedReason = null, interrupted = false, finalAnswer = '' } = {}) =>
      events.finish({ stoppedReason, interrupted, finalAnswer }),
  };
}

module.exports = {
  attachHarness,
  harnessEnabled,
  buildHarnessTools,
};
