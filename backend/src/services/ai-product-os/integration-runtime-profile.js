"use strict";

const { createIntegrationStack } = require("./integration-stack");

const sharedIntegrationStack = createIntegrationStack();

function buildIntegrationRuntimeProfile({
  contract = null,
  semanticIntentAnalysis = null,
  ciraRuntimeBundle = null,
  attachments = [],
  fileIds = [],
  requiredTools = [],
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  const input = buildIntegrationInput({
    contract,
    semanticIntentAnalysis,
    ciraRuntimeBundle,
    attachments,
    fileIds,
    requiredTools,
  });

  const executionPlan = sharedIntegrationStack.resolveExecutionStack(input);
  const readiness = sharedIntegrationStack.dependencyReadiness(input, { cwd, env });
  const promptProfile = compactIntegrationProfile({ executionPlan, readiness });

  return {
    schema_version: "sira.integration_runtime_profile.v1",
    input,
    executionPlan,
    readiness,
    promptProfile,
  };
}

function buildIntegrationInput({
  contract = null,
  semanticIntentAnalysis = null,
  ciraRuntimeBundle = null,
  attachments = [],
  fileIds = [],
  requiredTools = [],
} = {}) {
  const structuredIntent = semanticIntentAnalysis?.structured_intent || {};
  const skillPlan = semanticIntentAnalysis?.skill_plan || {};
  const ciraEnvelope = ciraRuntimeBundle?.envelope || null;

  const primaryIntent =
    contract?.primary_intent ||
    structuredIntent.intent_primary ||
    ciraEnvelope?.intent_analysis?.primary_intent?.id ||
    null;

  const secondaryIntents = unique([
    ...(contract?.secondary_intents || []),
    ...(structuredIntent.intent_secondary || []),
    ...(ciraEnvelope?.intent_analysis?.secondary_intents || []).map((item) => item?.id || item),
  ]);

  const outputFormats = unique([
    contract?.output_format,
    extensionToFormat(contract?.required_extension),
    extensionToFormat(contract?.mime_type),
    ...(skillPlan.output_formats || []),
    ciraEnvelope?.output_contract?.primary_output?.format,
    ...(ciraEnvelope?.output_contract?.secondary_outputs || []).map((item) => item?.format),
  ].filter(Boolean));

  const tools = unique([
    ...(contract?.required_tools || []),
    ...(structuredIntent.required_tools || []),
    ...(skillPlan.selected_skills || []),
    ...(requiredTools || []),
    ...(ciraEnvelope?.tool_plan?.required_tools || []).map((item) => item?.tool_name || item),
  ].filter(Boolean));

  const normalizedAttachments = normalizeAttachments(attachments, fileIds);

  return {
    primaryIntent,
    secondaryIntents,
    taskFamily: contract?.artifact_type || ciraEnvelope?.task_classification?.output_category || null,
    taskType: contract?.pipeline || ciraEnvelope?.task_classification?.task_type || null,
    taskDomain: structuredIntent.final_output || null,
    outputFormats,
    requiredTools: tools,
    attachments: normalizedAttachments,
    requiresResearch: Boolean(contract?.source_requirements?.required || contract?.grounding_required),
    requiresFileProcessing: normalizedAttachments.length > 0 || Boolean(contract?.artifact_required),
    requiresCode: /code|sandbox|app|web/i.test(`${contract?.pipeline || ""} ${tools.join(" ")}`),
    requiresVisual: /image|video|svg|diagram|chart|presentation/i.test(`${contract?.artifact_type || ""} ${tools.join(" ")} ${outputFormats.join(" ")}`),
    highRisk: ["high", "critical"].includes(String(contract?.risk_level || "").toLowerCase()),
  };
}

function compactIntegrationProfile({ executionPlan, readiness }) {
  const selectedLayers = executionPlan.layers || [];
  const blockers = readiness.blockers || [];
  const packageInventory = readiness.package_inventory || {};

  return {
    schema_version: "sira.integration_prompt_profile.v1",
    selected_layers: selectedLayers.map((layer) => layer.id),
    required_libraries: executionPlan.required_libraries || [],
    validation_gates: (executionPlan.validation_gates || []).slice(0, 24),
    security_gates: (executionPlan.security_gates || []).slice(0, 24),
    readiness_summary: readiness.summary || {},
    package_inventory: {
      package_count: packageInventory.package_count || 0,
      lock_package_count: packageInventory.lock_package_count || 0,
      expanded_library_catalog_count: packageInventory.expanded_library_catalog_count || 0,
      high_impact_family_count: packageInventory.high_impact_family_count || 0,
      math_typesetting_ready: packageInventory.math_typesetting_ready || [],
    },
    blockers: blockers.slice(0, 8),
    layer_readiness: (readiness.layers || []).map((layer) => ({
      id: layer.id,
      operational_status: layer.operational_status,
      readiness_score: layer.readiness_score,
      ready_libraries: layer.ready_libraries,
      missing_libraries: layer.missing_libraries,
      external_required: layer.external_required,
      wet_run_blocked: layer.wet_run_blocked,
    })),
    release_gate: readiness.release_gate,
  };
}

function normalizeAttachments(attachments, fileIds) {
  const out = [];
  for (const item of attachments || []) {
    if (!item) continue;
    if (typeof item === "string") {
      out.push({ name: item });
      continue;
    }
    out.push({
      name: item.filename || item.originalName || item.name || item.id || item.fileId || null,
      format: extensionToFormat(item.format || item.ext || item.extension || item.mime || item.mime_type || item.mimeType),
      mime_type: item.mime || item.mime_type || item.mimeType || null,
    });
  }
  for (const id of fileIds || []) {
    if (id && !out.some((item) => item.name === id)) out.push({ name: String(id) });
  }
  return out.filter((item) => item.name || item.format || item.mime_type);
}

function extensionToFormat(value) {
  if (!value) return null;
  const raw = String(value).toLowerCase().trim();
  if (!raw) return null;
  if (raw.includes("wordprocessingml") || raw === "word") return "docx";
  if (raw.includes("presentationml") || raw === "powerpoint") return "pptx";
  if (raw.includes("spreadsheetml") || raw === "excel") return "xlsx";
  if (raw.includes("markdown")) return "md";
  if (raw.includes("pdf")) return "pdf";
  if (raw.includes("latex") || raw.includes("x-tex")) return "tex";
  const ext = raw.replace(/^\./, "").split(/[;?\s]/)[0];
  if (ext === "markdown" || ext === "mdown" || ext === "mkd") return "md";
  if (ext === "latex" || ext === "ltx") return "tex";
  return ext || null;
}

function unique(values) {
  return Array.from(new Set((values || []).filter((value) => value !== null && value !== undefined && value !== "")));
}

module.exports = {
  buildIntegrationRuntimeProfile,
  buildIntegrationInput,
  compactIntegrationProfile,
  extensionToFormat,
};
