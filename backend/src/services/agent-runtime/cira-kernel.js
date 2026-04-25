"use strict";

const { createTrace } = require("./tracing");
const { runnable, sequence } = require("./runnable");
const { buildContentBlocks, summarizeContentBlocks } = require("./content-blocks");
const { validateJsonSchema } = require("./parsers");

function createCiraKernel({ validateEnvelope, registry = null } = {}) {
  const contentStep = runnable("content_blocks.normalize", async (state, context) => {
    const contentBlocks = buildContentBlocks({
      text: state.text,
      attachments: state.attachments,
      history: state.history,
    });
    context.trace.emit("content_blocks.ready", summarizeContentBlocks(contentBlocks));
    return { ...state, content_blocks: contentBlocks, content_summary: summarizeContentBlocks(contentBlocks) };
  });

  const contractStep = runnable("contract.validate", async (state, context) => {
    if (!state.envelope || typeof state.envelope !== "object") {
      throw new Error("Cira kernel requires a Universal/Cira task envelope");
    }
    const validation = typeof validateEnvelope === "function"
      ? validateEnvelope(state.envelope)
      : { ok: true, errors: [] };
    context.trace.emit("contract.validated", {
      ok: validation.ok,
      errors: validation.errors || [],
      request_id: state.envelope.request_id,
    });
    if (!validation.ok) {
      const err = new Error("Task envelope failed validation");
      err.code = "contract_validation_failed";
      err.validation = validation;
      throw err;
    }
    return { ...state, contract_validation: validation };
  });

  const toolSelectionStep = runnable("tools.select_from_registry", async (state, context) => {
    const requested = requestedTools(state.envelope);
    const available = registry && typeof registry.list === "function"
      ? new Set(registry.list().map((tool) => tool.name))
      : null;
    const selected = requested.map((tool) => ({
      name: tool.tool_name || tool.name,
      reason: tool.reason || null,
      priority: tool.priority || "normal",
      required: tool.required !== false,
      registered: available ? available.has(tool.tool_name || tool.name) : true,
    }));
    const missing = selected.filter((tool) => tool.required && !tool.registered).map((tool) => tool.name);
    context.trace.emit("tools.selected", { count: selected.length, missing });
    return { ...state, selected_tools: selected, missing_tools: missing };
  });

  const graphStep = runnable("execution_graph.materialize", async (state, context) => {
    const graph = state.envelope.workflow_graph || {};
    const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
    const edges = nodes.flatMap((node) => (node.depends_on || []).map((source) => ({ source, target: node.id })));
    context.trace.emit("execution_graph.ready", {
      node_count: nodes.length,
      edge_count: edges.length,
      execution_mode: graph.execution_mode || "unknown",
    });
    return {
      ...state,
      runtime_graph: {
        graph_id: graph.graph_id || `${state.envelope.request_id}.graph`,
        nodes,
        edges,
        execution_mode: graph.execution_mode || "durable_multi_step",
        release_gate: graph.release_gate || state.envelope.final_answer_contract?.delivery_mode || null,
      },
    };
  });

  const releaseStep = runnable("release.preflight", async (state, context) => {
    const output = state.envelope.output_contract?.primary_output || {};
    const schemaValidation = validateJsonSchema(output, {
      type: "object",
      required: ["type", "format"],
      properties: {
        type: { type: "string" },
        format: { type: "string" },
      },
    });
    const violations = [];
    if (!schemaValidation.ok) violations.push(...schemaValidation.errors);
    if (state.missing_tools.length > 0) {
      violations.push({ code: "tool_missing_from_registry", tools: state.missing_tools });
    }
    const ready = violations.length === 0;
    context.trace.emit("release.preflight", {
      ready,
      violations,
      primary_output: output.format || null,
    });
    return {
      ...state,
      release_preflight: {
        ready,
        violations,
        primary_output: output,
      },
    };
  });

  return sequence("cira.agentic_kernel", [
    contentStep,
    contractStep,
    toolSelectionStep,
    graphStep,
    releaseStep,
  ]);
}

async function runCiraAgentRuntime({
  text,
  attachments = [],
  history = [],
  envelope,
  validateEnvelope,
  registry = null,
  metadata = {},
} = {}) {
  const trace = createTrace({
    correlationId: envelope?.conversation_id || null,
    metadata: {
      request_id: envelope?.request_id || null,
      ...metadata,
    },
  });
  const kernel = createCiraKernel({ validateEnvelope, registry });
  try {
    const state = await kernel.invoke({ text, attachments, history, envelope }, { trace });
    const finished = trace.finish(state.release_preflight.ready ? "completed" : "blocked", {
      request_id: envelope.request_id,
      ready: state.release_preflight.ready,
    });
    return shapeRuntimeResult(state, finished);
  } catch (err) {
    const finished = trace.finish("failed", {
      request_id: envelope?.request_id || null,
      error: err && err.message ? err.message : String(err),
      code: err && err.code ? err.code : "agent_runtime_error",
    });
    return {
      ok: false,
      status: "failed",
      error: {
        code: err && err.code ? err.code : "agent_runtime_error",
        message: err && err.message ? err.message : String(err),
      },
      trace: finished,
      trace_events: finished.events,
    };
  }
}

function shapeRuntimeResult(state, trace) {
  return Object.freeze({
    ok: true,
    status: state.release_preflight.ready ? "ready" : "blocked",
    run_id: trace.run_id,
    content_blocks: state.content_blocks,
    content_summary: state.content_summary,
    selected_tools: state.selected_tools,
    runtime_graph: state.runtime_graph,
    release_preflight: state.release_preflight,
    trace,
    trace_events: trace.events,
  });
}

function requestedTools(envelope) {
  const plan = envelope?.tool_plan || {};
  const required = Array.isArray(plan.required_tools) ? plan.required_tools : [];
  const optional = Array.isArray(plan.optional_tools) ? plan.optional_tools : [];
  return [
    ...required.map((tool) => normalizeToolRequest(tool, true)),
    ...optional.map((tool) => normalizeToolRequest(tool, false)),
  ].filter(Boolean);
}

function normalizeToolRequest(tool, required) {
  if (!tool) return null;
  if (typeof tool === "string") return { tool_name: tool, required };
  return { ...tool, required };
}

module.exports = {
  createCiraKernel,
  runCiraAgentRuntime,
};
