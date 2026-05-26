/**
 * policies — Sira's canonical policy constants from MASTER_SPEC §16-17.
 *
 *   SIRA_CLARIFICATION_POLICY  — when to ask, when to act with assumptions
 *   SIRA_SAFETY_POLICY         — what is always blocked / always sandboxed /
 *                                always validated
 *
 * Plus deterministic evaluators that use these constants to decide:
 *   evaluateClarificationPolicy(envelope) → { ask, questions[] }
 *   evaluateSafetyPolicy(action, context) → { allowed, reason }
 *
 * Pure JS, deterministic, zero deps.
 */

const SIRA_CLARIFICATION_POLICY = Object.freeze({
  ask_only_when_critical: true,
  max_questions: 3,
  act_without_clarification_if_confidence_above: 0.82,
  ask_if_confidence_below: 0.55,
  never_ask_for_obvious_defaults: Object.freeze([
    "idioma si el usuario escribe claramente en español",
    "APA 7 para documentos académicos si no se especifica otra norma",
    "formato profesional si el usuario pide algo profesional",
    "responsive true para landings",
    "crear archivo nuevo en vez de modificar original",
    "tono formal para informes empresariales",
    "Tailwind para landings cuando no se especifica framework de estilos",
  ]),
  critical_missing_info_examples: Object.freeze([
    "tema inexistente para un documento académico que no puede inferirse",
    "no hay archivo adjunto cuando el usuario pide analizar un archivo específico",
    "acción externa irreversible como publicar, enviar email, borrar o pagar",
    "credenciales o permisos externos faltantes",
    "destino de envío sin destinatario",
    "presupuesto / cantidad sin especificar para un cálculo financiero",
  ]),
});

const SIRA_SAFETY_POLICY = Object.freeze({
  blocked_actions: Object.freeze([
    "delete_user_files_without_confirmation",
    "overwrite_original_files_without_confirmation",
    "send_email_without_confirmation",
    "publish_online_without_confirmation",
    "make_payments",
    "access_private_accounts_without_permission",
    "execute_unsandboxed_code",
    "store_sensitive_raw_data_without_consent",
    "scrape_paywalled_content",
    "bypass_captcha",
    "scrape_authenticated_pages_without_consent",
  ]),
  always_sandbox: Object.freeze([
    "generated_code",
    "user_uploaded_code",
    "npm_install",
    "python_execution",
    "shell_commands",
    "web_scraping_scripts",
    "untrusted_html_render",
  ]),
  require_validation: Object.freeze([
    "scientific_sources",
    "doi_references",
    "docx_files",
    "xlsx_files",
    "pptx_files",
    "pdf_files",
    "generated_code_projects",
    "landing_previews",
    "charts_from_data",
    "factual_claims_in_responses",
  ]),
  privacy_defaults: Object.freeze({
    mask_sensitive_data_in_logs: true,
    do_not_store_raw_private_files_by_default: true,
    store_only_summaries_unless_user_allows: true,
    redact_pii_in_traces: true,
  }),
  destructive_action_keywords: Object.freeze([
    "delete", "drop", "rm -rf", "truncate", "destroy",
    "unlink", "wipe", "purge", "format", "shred",
  ]),
  external_action_keywords: Object.freeze([
    "send", "publish", "post", "deploy", "tweet",
    "transfer", "pay", "charge", "subscribe",
  ]),
});

/**
 * @param {object} envelope    full Sira Cognitive Task Envelope
 * @returns {{ ask:boolean, questions:string[], reasons:string[] }}
 */
function evaluateClarificationPolicy(envelope) {
  if (!envelope || !envelope.intent_analysis) return { ask: false, questions: [], reasons: ["no_envelope"] };
  const reasons = [];
  const confidence = Number(envelope.intent_analysis.primary_intent?.confidence) || 0;

  if (confidence >= SIRA_CLARIFICATION_POLICY.act_without_clarification_if_confidence_above) {
    return { ask: false, questions: [], reasons: ["confidence_above_threshold"] };
  }

  let mustAsk = false;
  if (envelope.clarification_policy?.needs_clarification === true) {
    mustAsk = true;
    reasons.push("envelope_marks_needs_clarification");
  }
  if (confidence < SIRA_CLARIFICATION_POLICY.ask_if_confidence_below) {
    mustAsk = true;
    reasons.push("confidence_below_lower_threshold");
  }

  // Critical missing-info heuristics
  const text = String(envelope.raw_input?.text || "").toLowerCase();
  const hasAttachments = (envelope.raw_input?.attachments || []).length > 0;
  if (/(?:analiza|analizar|procesa|procesar|extrae|leer)\s+(?:el|este|esta)?\s*(archivo|excel|pdf|word|csv|imagen)/i.test(text) && !hasAttachments) {
    mustAsk = true;
    reasons.push("user_referenced_attachment_but_none_provided");
  }
  if (envelope.task_classification?.requires_human_approval) {
    mustAsk = true;
    reasons.push("destructive_or_external_action_pending_approval");
  }

  const questions = mustAsk
    ? (envelope.clarification_policy?.questions || []).slice(0, SIRA_CLARIFICATION_POLICY.max_questions)
    : [];
  return { ask: mustAsk, questions, reasons };
}

/**
 * @param {object} action   { kind, target?, payload?, approved? }
 * @param {object} [context] { permissions[], inSandbox?, hasConsent? }
 * @returns {{ allowed: boolean, reason?: string, mitigation?: string }}
 */
function evaluateSafetyPolicy(action, context = {}) {
  if (!action || typeof action !== "object") return { allowed: false, reason: "missing_action" };
  const kind = String(action.kind || "").toLowerCase();
  const text = `${kind} ${String(action.payload || "")}`.toLowerCase();

  // Hard blocks
  for (const blocked of SIRA_SAFETY_POLICY.blocked_actions) {
    if (text.includes(blocked.replace(/_/g, " "))) {
      if (action.approved !== true) {
        return { allowed: false, reason: `blocked:${blocked}`, mitigation: "request_explicit_user_confirmation" };
      }
    }
  }
  // Destructive keyword check
  for (const k of SIRA_SAFETY_POLICY.destructive_action_keywords) {
    if (kind.includes(k) && action.approved !== true) {
      return { allowed: false, reason: `destructive_action_without_approval:${k}`, mitigation: "ask_for_human_approval_before_execution" };
    }
  }
  // External-action keyword check
  for (const k of SIRA_SAFETY_POLICY.external_action_keywords) {
    if (kind.includes(k) && action.approved !== true) {
      return { allowed: false, reason: `external_action_without_approval:${k}`, mitigation: "ask_for_human_approval_before_external_dispatch" };
    }
  }
  // Sandbox enforcement
  for (const sandboxed of SIRA_SAFETY_POLICY.always_sandbox) {
    if (kind === sandboxed && context.inSandbox !== true) {
      return { allowed: false, reason: `requires_sandbox:${sandboxed}`, mitigation: "execute_in_isolated_sandbox" };
    }
  }
  return { allowed: true };
}

/**
 * Aggregate policy-driven verdict for an envelope: returns the
 * combined recommendation Sira's runtime should follow.
 */
function evaluatePolicyForEnvelope(envelope) {
  const clar = evaluateClarificationPolicy(envelope);
  // The envelope's `safety_and_permissions.blocked_actions` list is
  // DECLARATIVE — it tells the runtime which actions to forbid. It
  // does NOT mean "this envelope tried to do them". So we surface the
  // list for downstream enforcement, but do NOT treat its presence as
  // a current violation.
  const declaredBlocked = (envelope.safety_and_permissions?.blocked_actions || []).slice(0, 30);
  return {
    clarification: clar,
    declared_blocked_actions: declaredBlocked,
    summary: clar.ask ? "ask_user_clarification" : "proceed_with_envelope_plan",
  };
}

module.exports = {
  SIRA_CLARIFICATION_POLICY,
  SIRA_SAFETY_POLICY,
  evaluateClarificationPolicy,
  evaluateSafetyPolicy,
  evaluatePolicyForEnvelope,
};
