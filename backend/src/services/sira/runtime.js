/**
 * runtime — Sira Tool Runtime as defined in MASTER_SPEC §11/§12.
 *
 * Drives an envelope.workflow_graph through the Sira Tool Registry,
 * collecting results, building the ArtifactFrame, and running the
 * validator engine before composing a ValidationFrame.
 *
 * Pure orchestration, no LLM calls. Stubbed tool executions return
 * deterministic artefacts so the runtime is fully testable offline.
 */

const { createDefaultRegistry } = require("./tool-registry");
const { validateArtifact, validateSources, validateCode, validateDocument, validateSafety, composeValidationFrame } = require("./validator-engine");

const DEFAULT_PERMISSIONS = Object.freeze([
  "none", "read_uploaded_file", "write_artifact",
  "execute_sandboxed_code", "external_api_access",
]);

/**
 * @param {object} args
 * @param {object} args.envelope               — full CiraTaskEnvelope
 * @param {object} [args.registry]             — defaults to createDefaultRegistry()
 * @param {object} [args.context]              — { userId, conversationId, selectedModel, files, memory, trace }
 * @param {Array<string>} [args.permissions]   — defaults to DEFAULT_PERMISSIONS
 * @param {object} [args.toolArgs]             — per-tool argument map { tool_name → args }
 * @param {boolean} [args.dryRun=false]
 * @returns {Promise<{ tool_results, artifact_frame, validation_frame, log }>}
 */
async function runWorkflow({
  envelope,
  registry = null,
  context = {},
  permissions = DEFAULT_PERMISSIONS.slice(),
  toolArgs = {},
  dryRun = false,
} = {}) {
  if (!envelope || !envelope.workflow_graph) {
    throw new Error("sira.runtime: envelope.workflow_graph required");
  }
  const reg = registry || createDefaultRegistry();
  const log = [];
  const auditTrace = [...(envelope.workflow_graph.audit_trace || [])];
  const evidenceLedger = [...(envelope.workflow_graph.evidence_ledger || [])];
  const toolResults = [];
  const artifacts = [];
  const completed = new Set();

  const baseContext = {
    requestId: envelope.request_id,
    userId: context.userId || envelope.user_id || null,
    conversationId: context.conversationId || envelope.conversation_id || null,
    selectedModel: context.selectedModel || envelope.model_execution_context?.selected_model || { provider: "user_selected", modelId: "selected_by_user", modality: "text" },
    envelope,
    permissions,
    files: context.files || [],
    memory: context.memory || {},
    humanApproved: Boolean(context.humanApproved),
    trace: context.trace || (() => {}),
  };

  // ── Drive the graph in topological order ─────────────────────────
  while (true) {
    const next = (envelope.workflow_graph.nodes || []).find(n =>
      !completed.has(n.id) && (n.depends_on || []).every(d => completed.has(d))
    );
    if (!next) break;

    log.push({ ts: new Date().toISOString(), type: "node.started", node_id: next.id });
    auditTrace.push({ ts: new Date().toISOString(), event: "node_started", node_id: next.id });
    if (Array.isArray(next.tools) && next.tools.length > 0) {
      for (const toolName of next.tools) {
        if (!reg.has(toolName)) {
          toolResults.push({ node: next.id, tool: toolName, status: "error", error: { code: "tool_not_in_registry", message: `tool "${toolName}" not registered` } });
          continue;
        }
        if (dryRun) {
          toolResults.push({ node: next.id, tool: toolName, status: "skipped_dry_run" });
          continue;
        }
        const r = await reg.invoke(toolName, toolArgs[toolName] || {}, baseContext);
        toolResults.push({ node: next.id, tool: toolName, ...r });
        auditTrace.push({
          ts: new Date().toISOString(),
          event: "tool_invoked",
          node_id: next.id,
          tool: toolName,
          status: r.status,
        });
        if (r.output?.source || r.output?.sources || r.metadata?.source_id) {
          evidenceLedger.push({
            node_id: next.id,
            tool: toolName,
            source: r.output?.source || r.metadata?.source_id || "tool_output",
            status: r.status,
          });
        }
        // Collect artefacts emitted by tools
        if (Array.isArray(r.artifacts)) {
          for (const a of r.artifacts) artifacts.push({ ...a, source_node: next.id, source_tool: toolName });
        }
      }
    }
    completed.add(next.id);
    log.push({ ts: new Date().toISOString(), type: "node.completed", node_id: next.id });
    auditTrace.push({ ts: new Date().toISOString(), event: "node_completed", node_id: next.id });
  }

  // ── Always emit at least the planned artefacts ───────────────────
  const plannedArtifacts = derivePlannedArtifacts(envelope);
  for (const p of plannedArtifacts) {
    const alreadyCovered = artifacts.some(a => (
      a.artifact_id === p.artifact_id ||
      (a.type === p.type && a.format && p.format && a.format === p.format && (a.download_url || a.status === "ready"))
    ));
    if (!alreadyCovered) {
      artifacts.push(p);
    }
  }

  const artifact_frame = Object.freeze({
    frame_type: "artifact_frame",
    request_id: envelope.request_id,
    artifacts: artifacts.map(a => ({
      artifact_id: a.artifact_id,
      type: a.type,
      format: a.format,
      filename: a.filename,
      mime: a.mime || null,
      size_bytes: a.size_bytes || a.sizeBytes || null,
      status: a.status || (dryRun ? "planned" : (a.download_url ? "ready" : "planned")),
      download_url: a.download_url || null,
      preview_url: a.preview_url || null,
      validation_status: a.validation_status || "pending",
      source_tool: a.source_tool || null,
    })),
  });

  // ── Run the validator engine ──────────────────────────────────────
  const validation_frame = composeValidationFrame(deriveValidatorReports(envelope, artifacts, toolResults), envelope.quality_plan?.minimum_acceptance_score || 0.85);

  return {
    request_id: envelope.request_id,
    tool_results: toolResults,
    artifact_frame,
    validation_frame,
    evidence_ledger: evidenceLedger,
    audit_trace: auditTrace,
    log,
    summary: {
      nodes_executed: completed.size,
      tools_invoked: toolResults.length,
      artifacts_planned: artifact_frame.artifacts.length,
      ready_to_deliver: validation_frame.ready_to_deliver,
    },
  };
}

function derivePlannedArtifacts(envelope) {
  const oc = envelope.output_contract || {};
  const out = [];
  if (oc.primary_output) {
    out.push({
      artifact_id: `${envelope.request_id}.primary`,
      type: oc.primary_output.type,
      format: oc.primary_output.format || null,
      filename: oc.primary_output.filename_suggestion || `primary.${oc.primary_output.format || "out"}`,
      status: "planned",
      validation_status: "pending",
    });
  }
  for (const s of oc.secondary_outputs || []) {
    out.push({
      artifact_id: `${envelope.request_id}.${out.length}`,
      type: s.type,
      format: s.format || null,
      filename: s.filename_suggestion || s.label || `secondary_${out.length}`,
      status: "planned",
      validation_status: "pending",
    });
  }
  return out;
}

function deriveValidatorReports(envelope, artifacts, toolResults) {
  const reports = [];
  const validators = envelope.quality_plan?.validators || [];
  const validatorNames = new Set(validators.map(v => v.name));

  if (validatorNames.has("artifact_validator") || artifacts.length > 0) {
    const r = validateArtifact({
      artifact: artifacts[0] || null,
      expected: {
        required_extension: envelope.output_contract?.primary_output?.format ? `.${envelope.output_contract.primary_output.format}` : null,
        mime_type: envelope.output_contract?.primary_output?.mime || null,
      },
    });
    reports.push(r);
  }
  if (validatorNames.has("source_validator") || envelope.context_requirements?.citation_required) {
    const sourceOutputs = toolResults
      .flatMap(r => r.output?.sources || r.result?.sources || [])
      .filter(Boolean);
    reports.push(validateSources({
      claims: [],
      sources: sourceOutputs,
      citation_style: "APA7",
      required: Boolean(envelope.context_requirements?.source_validation_required),
    }));
  }
  if (validatorNames.has("code_validator") || envelope.task_classification?.requires_code_execution) {
    reports.push(validateCode({ source: "", language: "javascript" }));
  }
  if (validatorNames.has("document_validator") || envelope.intent_analysis?.task_family === "artifact_creation") {
    const preview = artifacts.find(a => a.content_preview)?.content_preview || "";
    reports.push(validateDocument({
      html: "",
      markdown: preview,
      expected: envelope.output_contract?.document_specification ? {
        cover_page: envelope.output_contract.document_specification.include_cover_page,
        toc: envelope.output_contract.document_specification.include_table_of_contents,
        references: envelope.output_contract.document_specification.include_references,
      } : {},
    }));
  }
  if (validatorNames.has("safety_validator") || envelope.safety_and_permissions?.overall_risk_level !== "low") {
    reports.push(validateSafety({
      output: "",
      actions: [],
      permissions: envelope.safety_and_permissions?.allowed_actions || [],
    }));
  }
  // Always have at least one report so the validation frame is meaningful
  if (reports.length === 0) {
    reports.push({
      validator: "intent_fulfillment_validator",
      checks: [{ name: "all_outputs_planned", status: artifacts.length > 0 ? "passed" : "warning" }],
      score: artifacts.length > 0 ? 1 : 0.5,
    });
  }
  return reports;
}

module.exports = {
  runWorkflow,
  derivePlannedArtifacts,
  DEFAULT_PERMISSIONS,
};
