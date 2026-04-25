/**
 * Sira Response Builder
 *
 * Builds the user-facing final response required by MASTER_SPEC §25:
 * concise summary, artifact links/cards, validation state and warnings,
 * without leaking the internal envelope, DAG or model reasoning.
 */

function buildFinalResponse({ envelope, runtime = null, validation = null, warnings = [] } = {}) {
  if (!envelope) throw new Error("sira.response-builder: envelope required");
  const validationFrame = validation || runtime?.validation_frame || null;
  const artifacts = collectArtifacts(runtime);
  const ready = Boolean(validationFrame?.ready_to_deliver);
  const warningChecks = (validationFrame?.checks || []).filter(c => c.status === "warning");
  const failedChecks = (validationFrame?.checks || []).filter(c => c.status === "failed");

  return Object.freeze({
    type: "final_response",
    request_id: envelope.request_id,
    ready_to_deliver: ready,
    release_decision: ready ? "approved" : "blocked_for_repair",
    message: createHumanSummary({ envelope, artifacts, ready, failedChecks }),
    artifacts: artifacts.map(a => ({
      id: a.artifact_id || a.id || null,
      label: a.filename || a.name || `${a.type || "artifact"}${a.format ? `.${a.format}` : ""}`,
      type: a.type || "file",
      format: a.format || null,
      mime: a.mime || null,
      sizeBytes: a.size_bytes || a.sizeBytes || null,
      downloadUrl: a.download_url || a.downloadUrl || null,
      previewUrl: a.preview_url || a.previewUrl || null,
      validationStatus: a.validation_status || null,
    })),
    validation: validationFrame ? {
      ready,
      score: validationFrame.aggregate_score ?? validationFrame.overall_score ?? null,
      minimumAcceptanceScore: validationFrame.minimum_acceptance_score ?? null,
      warnings: warningChecks.map(toCheckSummary),
      failures: failedChecks.map(toCheckSummary),
      repairActions: validationFrame.repair_actions || [],
    } : null,
    must_not_include: envelope.final_answer_contract?.must_not_include || [],
    warnings: [
      ...warnings,
      ...warningChecks.map(c => c.detail || c.name),
    ].filter(Boolean).slice(0, 8),
  });
}

function collectArtifacts(runtime) {
  const fromFrame = runtime?.artifact_frame?.artifacts || [];
  return fromFrame.filter(a => a && (a.download_url || a.downloadUrl || a.status === "ready" || a.status === "planned"));
}

function createHumanSummary({ envelope, artifacts, ready, failedChecks }) {
  const label = envelope.intent_analysis?.primary_intent?.label || envelope.intent_analysis?.primary_intent?.id || "La tarea";
  if (!ready) {
    const firstFailure = failedChecks[0]?.detail || failedChecks[0]?.name || "validación pendiente";
    return `${label}: entrega bloqueada hasta reparar validaciones. Motivo principal: ${firstFailure}.`;
  }
  const downloadable = artifacts.filter(a => a.download_url || a.downloadUrl);
  if (downloadable.length > 0) {
    const formats = [...new Set(downloadable.map(a => a.format).filter(Boolean))].map(f => f.toUpperCase()).join(", ");
    return `${label}: se generó y validó ${downloadable.length} artefacto(s)${formats ? ` en ${formats}` : ""}.`;
  }
  return `${label}: respuesta validada según el contrato de usuario.`;
}

function toCheckSummary(check) {
  return {
    validator: check.validator || null,
    name: check.name,
    detail: check.detail || null,
  };
}

module.exports = {
  buildFinalResponse,
  collectArtifacts,
};
