"use strict";

const { applyToolRuntimePolicy } = require("../sira/tool-policy");

const PRIORITY_WEIGHT = Object.freeze({
  critical: 100,
  high: 80,
  normal: 60,
  medium: 60,
  low: 40,
  optional: 20,
});

const MIME_BY_FORMAT = Object.freeze({
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pdf: "application/pdf",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  csv: "text/csv",
  md: "text/markdown",
  markdown: "text/markdown",
  zip: "application/zip",
});

async function runMiddleware(stage, middlewares = [], state, context = {}) {
  let nextState = state;
  for (const middleware of middlewares.map(normalizeMiddleware).filter(Boolean)) {
    if (!middleware.stages.includes(stage)) continue;
    context.trace?.emit?.("middleware.start", { name: middleware.name, stage });
    nextState = await middleware.run(nextState, { ...context, stage });
    context.trace?.emit?.("middleware.end", { name: middleware.name, stage });
  }
  return nextState;
}

function createDefaultRuntimeMiddleware(options = {}) {
  return [
    createToolSelectionMiddleware(options),
    createToolRuntimePolicyMiddleware(options),
    createToolCallLimitMiddleware(options),
    createDagIntegrityMiddleware(options),
    createFormatSovereigntyMiddleware(options),
    createReleaseGateMiddleware(options),
  ];
}

function createToolSelectionMiddleware({ maxTools = 16 } = {}) {
  return {
    name: "tool_selection_policy",
    stages: ["after_tools"],
    run(state, context) {
      const selected = Array.isArray(state.selected_tools) ? state.selected_tools : [];
      const deduped = dedupeTools(selected)
        .filter((tool) => tool.required || tool.registered !== false)
        .sort(compareTools);
      const required = deduped.filter((tool) => tool.required);
      const optionalBudget = Math.max(0, maxTools - required.length);
      const optional = deduped.filter((tool) => !tool.required).slice(0, optionalBudget);
      const nextSelected = [...required, ...optional].map((tool, index) => ({
        ...tool,
        selection_rank: index + 1,
        selection_score: scoreTool(tool),
      }));

      let next = {
        ...state,
        selected_tools: nextSelected,
        missing_tools: required.filter((tool) => tool.registered === false).map((tool) => tool.name),
      };

      const droppedOptional = deduped.length - nextSelected.length;
      const status = required.length > maxTools ? "failed" : droppedOptional > 0 ? "passed_with_warning" : "passed";
      next = addRuntimeReport(next, {
        name: "tool_selection_policy",
        stage: context.stage,
        status,
        severity: required.length > maxTools ? "error" : droppedOptional > 0 ? "warning" : "info",
        code: required.length > maxTools ? "required_tools_exceed_budget" : "tool_selection_budget_applied",
        message: required.length > maxTools
          ? `Required tools (${required.length}) exceed maxTools (${maxTools}).`
          : `Selected ${nextSelected.length} tools from ${deduped.length} requested tools.`,
        details: {
          max_tools: maxTools,
          required_tools: required.length,
          optional_tools_dropped: Math.max(0, droppedOptional),
        },
      });
      context.trace?.emit?.("middleware.report", latestReport(next));
      return next;
    },
  };
}

function createToolRuntimePolicyMiddleware(options = {}) {
  return {
    name: "tool_runtime_policy",
    stages: ["after_tools"],
    run(state, context) {
      const policy = applyToolRuntimePolicy(state.selected_tools || [], {
        envelope: state.envelope,
        runtimeOptions: options,
        humanApproved: Boolean(options.humanApproved),
        allowExternalSideEffects: Boolean(options.allowExternalSideEffects),
      });
      const blockedRequired = policy.blocked.filter((tool) => tool.required !== false);
      const blockedOptional = policy.blocked.filter((tool) => tool.required === false);
      const status = blockedRequired.length > 0
        ? "failed"
        : blockedOptional.length > 0 || policy.warnings.length > 0
          ? "passed_with_warning"
          : "passed";
      const next = addRuntimeReport({
        ...state,
        selected_tools: policy.tools,
        policy_blocked_tools: policy.blocked.map((tool) => ({
          name: tool.name || tool.tool_name,
          required: tool.required !== false,
          reason: tool.policy?.reason || "tool blocked by runtime policy",
          code: tool.policy?.code || "tool_policy_denied",
          permissions_required: tool.policy?.permissions_required || [],
        })),
        tool_policy: policy.summary,
      }, {
        name: "tool_runtime_policy",
        stage: context.stage,
        status,
        severity: blockedRequired.length > 0 ? "error" : blockedOptional.length > 0 ? "warning" : "info",
        code: blockedRequired.length > 0
          ? "tool_runtime_policy_blocked"
          : blockedOptional.length > 0
            ? "tool_runtime_policy_blocked_optional"
            : "tool_runtime_policy_ok",
        message: blockedRequired.length > 0
          ? `Runtime policy blocked ${blockedRequired.length} required tool(s).`
          : `Runtime policy profile "${policy.profile}" authorized ${policy.allowed.length}/${policy.tools.length} tool(s).`,
        details: {
          profile: policy.profile,
          blocked_required_tools: blockedRequired.map((tool) => tool.name || tool.tool_name),
          blocked_optional_tools: blockedOptional.map((tool) => tool.name || tool.tool_name),
          warnings: policy.warnings,
          model_trust_boundary: policy.summary.model_trust_boundary,
        },
      });
      context.trace?.emit?.("middleware.report", latestReport(next));
      return next;
    },
  };
}

function createToolCallLimitMiddleware({ maxToolCalls = null } = {}) {
  return {
    name: "tool_call_limit_policy",
    stages: ["after_graph"],
    run(state, context) {
      const graphLimit = Number(state.envelope?.cost_latency_policy?.max_tool_calls || 0);
      const limit = Number(maxToolCalls || graphLimit || 25);
      const graphCalls = Array.isArray(state.envelope?.workflow_graph?.tool_calls)
        ? state.envelope.workflow_graph.tool_calls
        : [];
      const selectedCount = Array.isArray(state.selected_tools) ? state.selected_tools.length : 0;
      const count = Math.max(graphCalls.length, selectedCount);
      const passed = count <= limit;
      const next = addRuntimeReport(state, {
        name: "tool_call_limit_policy",
        stage: context.stage,
        status: passed ? "passed" : "failed",
        severity: passed ? "info" : "error",
        code: passed ? "tool_call_budget_ok" : "tool_call_budget_exceeded",
        message: passed
          ? `Tool call budget ok (${count}/${limit}).`
          : `Tool call budget exceeded (${count}/${limit}).`,
        details: { count, limit, graph_tool_calls: graphCalls.length, selected_tools: selectedCount },
      });
      context.trace?.emit?.("middleware.report", latestReport(next));
      return next;
    },
  };
}

function createDagIntegrityMiddleware() {
  return {
    name: "dag_integrity_policy",
    stages: ["after_graph"],
    run(state, context) {
      const report = validateDag(state.runtime_graph);
      const next = addRuntimeReport(state, {
        name: "dag_integrity_policy",
        stage: context.stage,
        status: report.ok ? "passed" : "failed",
        severity: report.ok ? "info" : "error",
        code: report.ok ? "dag_integrity_ok" : "dag_integrity_failed",
        message: report.ok ? "Execution graph is acyclic and dependency-complete." : "Execution graph failed DAG integrity checks.",
        details: report,
      });
      context.trace?.emit?.("middleware.report", latestReport(next));
      return next;
    },
  };
}

function createFormatSovereigntyMiddleware() {
  return {
    name: "format_sovereignty_policy",
    stages: ["before_release"],
    run(state, context) {
      const report = validateFormatSovereignty(state.envelope);
      const next = addRuntimeReport({
        ...state,
        format_sovereignty: report,
      }, {
        name: "format_sovereignty_policy",
        stage: context.stage,
        status: report.ok ? "passed" : "failed",
        severity: report.ok ? "info" : "error",
        code: report.ok ? "format_sovereignty_ok" : "format_sovereignty_failed",
        message: report.ok ? "Output contract respects requested format sovereignty." : "Output contract violates requested format sovereignty.",
        details: report,
      });
      context.trace?.emit?.("middleware.report", latestReport(next));
      return next;
    },
  };
}

function createReleaseGateMiddleware() {
  return {
    name: "release_gate_policy",
    stages: ["before_release"],
    run(state, context) {
      const blockingReports = (state.runtime_validation_reports || [])
        .filter((report) => report.status === "failed" && report.severity === "error");
      const next = addRuntimeReport(state, {
        name: "release_gate_policy",
        stage: context.stage,
        status: blockingReports.length === 0 ? "passed" : "failed",
        severity: blockingReports.length === 0 ? "info" : "error",
        code: blockingReports.length === 0 ? "release_gate_open" : "release_gate_blocked",
        message: blockingReports.length === 0
          ? "Release gate open."
          : `Release gate blocked by ${blockingReports.length} validation report(s).`,
        details: {
          blocking_report_codes: blockingReports.map((report) => report.code),
        },
      });
      context.trace?.emit?.("middleware.report", latestReport(next));
      return next;
    },
  };
}

function addRuntimeReport(state, report) {
  const normalized = {
    ...report,
    status: report.status || "passed",
    severity: report.severity || "info",
    at_stage: report.stage || null,
  };
  return {
    ...state,
    runtime_validation_reports: [
      ...(state.runtime_validation_reports || []),
      normalized,
    ],
  };
}

function latestReport(state) {
  const reports = state.runtime_validation_reports || [];
  return reports[reports.length - 1] || null;
}

function normalizeMiddleware(middleware) {
  if (!middleware) return null;
  if (typeof middleware === "function") {
    return {
      name: middleware.name || "anonymous_middleware",
      stages: ["after_content", "after_tools", "after_graph", "before_release"],
      run: middleware,
    };
  }
  if (typeof middleware.run !== "function") return null;
  return {
    name: middleware.name || "anonymous_middleware",
    stages: Array.isArray(middleware.stages) ? middleware.stages : ["before_release"],
    run: middleware.run,
  };
}

function dedupeTools(tools) {
  const byName = new Map();
  for (const raw of tools) {
    const name = raw?.name || raw?.tool_name;
    if (!name) continue;
    const previous = byName.get(name);
    const next = {
      ...(previous || {}),
      ...raw,
      name,
      reason: raw.reason || previous?.reason || null,
      priority: raw.priority || previous?.priority || "normal",
      required: Boolean(raw.required || previous?.required),
      registered: raw.registered !== false && previous?.registered !== false,
    };
    if (!previous || scoreTool(next) > scoreTool(previous)) byName.set(name, next);
  }
  return [...byName.values()];
}

function compareTools(a, b) {
  if (a.required !== b.required) return a.required ? -1 : 1;
  return scoreTool(b) - scoreTool(a) || String(a.name).localeCompare(String(b.name));
}

function scoreTool(tool) {
  const base = PRIORITY_WEIGHT[tool.priority] || PRIORITY_WEIGHT.normal;
  return base + (tool.required ? 100 : 0) + (tool.registered === false ? -100 : 0);
}

function validateDag(runtimeGraph = {}) {
  const nodes = Array.isArray(runtimeGraph.nodes) ? runtimeGraph.nodes : [];
  const ids = new Set();
  const duplicate_node_ids = [];
  for (const node of nodes) {
    if (!node?.id) continue;
    if (ids.has(node.id)) duplicate_node_ids.push(node.id);
    ids.add(node.id);
  }

  const missing_dependencies = [];
  const adjacency = new Map();
  for (const node of nodes) {
    if (!node?.id) continue;
    adjacency.set(node.id, []);
  }
  for (const node of nodes) {
    if (!node?.id) continue;
    for (const dep of node.depends_on || []) {
      if (!ids.has(dep)) missing_dependencies.push({ node_id: node.id, missing_dependency: dep });
      else adjacency.get(dep).push(node.id);
    }
  }

  const cycles = detectCycles(adjacency);
  return {
    ok: duplicate_node_ids.length === 0 && missing_dependencies.length === 0 && cycles.length === 0,
    node_count: nodes.length,
    edge_count: Array.isArray(runtimeGraph.edges) ? runtimeGraph.edges.length : 0,
    duplicate_node_ids,
    missing_dependencies,
    cycles,
  };
}

function detectCycles(adjacency) {
  const cycles = [];
  const visiting = new Set();
  const visited = new Set();
  const stack = [];

  function dfs(id) {
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      cycles.push(stack.slice(start).concat(id));
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    stack.push(id);
    for (const next of adjacency.get(id) || []) dfs(next);
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  }

  for (const id of adjacency.keys()) dfs(id);
  return cycles;
}

function validateFormatSovereignty(envelope = {}) {
  const primary = envelope.output_contract?.primary_output || {};
  const secondary = Array.isArray(envelope.output_contract?.secondary_outputs)
    ? envelope.output_contract.secondary_outputs
    : [];
  const requested = normalizeFormats(envelope.entities?.requested_formats || []);
  const delivered = normalizeFormats([primary.format, ...secondary.map((out) => out.format)]);
  const violations = [];
  const expectedMime = MIME_BY_FORMAT[normalizeFormat(primary.format)] || null;

  if (!primary.type || !primary.format) {
    violations.push({
      code: "primary_output_incomplete",
      expected: "primary_output.type and primary_output.format",
      actual: primary,
    });
  }

  if (requested.length > 0) {
    for (const format of requested) {
      if (!delivered.includes(format)) {
        violations.push({
          code: "requested_format_not_delivered",
          expected: format,
          actual: delivered,
        });
      }
    }
    if (requested[0] && normalizeFormat(primary.format) !== requested[0]) {
      violations.push({
        code: "primary_format_mismatch",
        expected: requested[0],
        actual: normalizeFormat(primary.format),
      });
    }
  }

  if (primary.format === "svg" && !["file", "image"].includes(primary.type)) {
    violations.push({
      code: "svg_requires_file_or_image_output",
      expected: "file|image",
      actual: primary.type,
    });
  }

  return {
    ok: violations.length === 0,
    requested_formats: requested,
    delivered_formats: delivered,
    primary_output: primary,
    expected_mime_type: expectedMime,
    violations,
  };
}

function normalizeFormats(formats) {
  return [...new Set((formats || []).map(normalizeFormat).filter(Boolean))];
}

function normalizeFormat(format) {
  if (!format) return null;
  return String(format).trim().toLowerCase().replace(/^\./, "");
}

module.exports = {
  runMiddleware,
  createDefaultRuntimeMiddleware,
  createToolSelectionMiddleware,
  createToolRuntimePolicyMiddleware,
  createToolCallLimitMiddleware,
  createDagIntegrityMiddleware,
  createFormatSovereigntyMiddleware,
  createReleaseGateMiddleware,
  validateDag,
  validateFormatSovereignty,
};
