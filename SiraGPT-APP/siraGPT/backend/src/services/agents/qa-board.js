/**
 * qa-board — multi-critic review orchestrator. Runs N independent
 * critic agents in parallel, collects their typed Reports, and
 * hands the bundle to the ValidationFabric for a single
 * deterministic ReleaseDecision.
 *
 * This file is the structural bones of the "Agentic QA Board" the
 * spec calls for — varios agentes críticos revisan intención,
 * formato, fuentes, código, seguridad, diseño, datos, UX y
 * entregables. Each critic implements a tiny contract:
 *
 *   async critic(context) → { ok, findings: [...], score?, raw? }
 *
 * where `context` is the same bundle every critic sees (the
 * UniversalTaskContract, the produced artifact, any sources, etc.)
 * and the report uses the same schema the ValidationFabric already
 * understands. That means adding or removing a critic is one import
 * + one registration, and the aggregator is untouched.
 *
 * Built-in critics provided here are all synchronous and pure so
 * they unit-test without a network. An LLM-backed judge can be
 * registered later with the same interface; this file just ships
 * the ones that can run offline today.
 */

const { aggregate } = require("./validation-fabric");
const { enforceSovereignty } = require("./format-sovereignty");
const { reviewArtifact } = require("./artifact-reviewer");
const { scanJson, scanBuffer } = require("../security/secret-scanner");
const { evaluateAsvs } = require("../security/owasp-asvs");

// ─── Canonical critic identifiers ──────────────────────────────────────

const CRITIC_KINDS = Object.freeze([
  "intent",
  "format",
  "factuality",
  "security",
  "code",
  "design",
  "performance",
  "ux",
]);

// ─── Built-in critics ──────────────────────────────────────────────────

/**
 * intentCritic — compares the produced artifact against the
 * UniversalTaskContract's content_requirements and forbidden_outputs
 * (in prose). Emits a finding when any required phrase is absent or
 * any forbidden phrase is present in the deliverable.
 */
function intentCritic({ contract, deliverable }) {
  const findings = [];
  if (!contract || !deliverable) return { ok: true, findings };
  const text = typeof deliverable === "string" ? deliverable : JSON.stringify(deliverable);

  // We only run keyword-level checks here — semantic alignment is
  // the job of an LLM judge. This keeps intentCritic testable.
  for (const req of contract.content_requirements || []) {
    const keyword = extractFirstKeyword(req);
    if (keyword && !new RegExp(`\\b${escapeRegex(keyword)}\\b`, "i").test(text)) {
      findings.push({
        severity: "medium",
        code: "intent_keyword_missing",
        detail: `Content requirement "${req.slice(0, 80)}": keyword "${keyword}" not found in deliverable.`,
      });
    }
  }
  for (const forb of contract.forbidden_outputs || []) {
    const keyword = extractFirstKeyword(forb);
    if (keyword && new RegExp(`\\b${escapeRegex(keyword)}\\b`, "i").test(text)) {
      findings.push({
        severity: "high",
        code: "intent_forbidden_present",
        detail: `Forbidden term "${keyword}" appears in deliverable (rule: ${forb.slice(0, 80)}).`,
      });
    }
  }
  return { ok: findings.every(f => f.severity !== "high" && f.severity !== "critical"), findings };
}

function extractFirstKeyword(sentence) {
  // Grab the first capitalised or quoted word; fall back to first
  // non-trivial token. Deliberately simple — this is a keyword gate,
  // not NLP.
  const s = String(sentence || "");
  const quoted = s.match(/["']([^"']{3,40})["']/);
  if (quoted) return quoted[1];
  const cap = s.match(/\b([A-Z][A-Za-z0-9_-]{3,})\b/);
  if (cap) return cap[1];
  const tokens = s.split(/\s+/).filter(t => t.length >= 4);
  return tokens[0] || null;
}

function escapeRegex(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * formatCritic — runs the ArtifactReviewer + FormatSovereigntyEngine
 * over a produced file. Feeds the combined violations back as
 * findings with the right severity.
 */
function formatCritic({ contract, artifact }) {
  if (!artifact || !contract) return { ok: true, findings: [] };
  const findings = [];
  const sov = enforceSovereignty({ contract, artifact });
  for (const v of sov.violations || []) {
    findings.push({ severity: "critical", code: v.id, detail: v.detail });
  }
  if (Array.isArray(contract.success_tests) && contract.success_tests.length > 0) {
    try {
      const review = reviewArtifact({ contract, artifact });
      for (const t of review.failedTests || []) {
        findings.push({ severity: "high", code: `format_${t.id}`, detail: t.detail });
      }
    } catch (err) {
      findings.push({ severity: "medium", code: "format_reviewer_threw", detail: err.message });
    }
  }
  return { ok: findings.every(f => f.severity !== "critical" && f.severity !== "high"), findings };
}

/**
 * factualityCritic — demands that every citation placeholder [N]
 * has a corresponding source in the provided `sources` array, and
 * that no source is trivially suspicious (DOI that doesn't start
 * with 10., URL without a scheme, etc.).
 */
function factualityCritic({ deliverable, sources }) {
  const findings = [];
  if (!deliverable) return { ok: true, findings };
  const text = typeof deliverable === "string" ? deliverable : JSON.stringify(deliverable);
  const cites = [...text.matchAll(/\[(\d+)\]/g)].map(m => Number(m[1]));
  const uniqueCites = new Set(cites);
  const srcArr = Array.isArray(sources) ? sources : [];
  for (const n of uniqueCites) {
    if (n < 1 || n > srcArr.length) {
      findings.push({
        severity: "high",
        code: "citation_out_of_range",
        detail: `Deliverable cites [${n}] but only ${srcArr.length} sources were supplied.`,
      });
    }
  }
  for (let i = 0; i < srcArr.length; i++) {
    const s = srcArr[i] || {};
    if (s.doi && !/^10\.\d{4,}\//.test(String(s.doi))) {
      findings.push({ severity: "high", code: "suspicious_doi", detail: `Source #${i + 1}: DOI "${s.doi}" does not look valid.` });
    }
    if (s.url && !/^https?:\/\//i.test(String(s.url))) {
      findings.push({ severity: "medium", code: "suspicious_url", detail: `Source #${i + 1}: URL "${s.url}" missing scheme.` });
    }
    if (!s.title && !s.name && !s.doi && !s.url) {
      findings.push({ severity: "medium", code: "empty_source", detail: `Source #${i + 1}: no identifiable fields.` });
    }
  }
  return { ok: findings.every(f => f.severity !== "critical" && f.severity !== "high"), findings };
}

/**
 * securityCritic — runs secret-scanner over the deliverable +
 * artifact buffer and evaluates the ASVS Level-1 controls the
 * caller supplies context for.
 */
function securityCritic({ deliverable, artifact, asvsContext }) {
  const findings = [];
  if (deliverable) {
    const scan = typeof deliverable === "string"
      ? scanBuffer(deliverable, {})
      : scanJson(deliverable, {});
    for (const f of scan.findings || []) findings.push(f);
  }
  if (artifact?.buffer) {
    const scan = scanBuffer(artifact.buffer, {});
    for (const f of scan.findings || []) findings.push(f);
  }
  if (asvsContext && typeof asvsContext === "object") {
    const r = evaluateAsvs({ context: asvsContext });
    for (const f of r.findings || []) findings.push(f);
  }
  return { ok: findings.every(f => f.severity !== "critical"), findings };
}

/**
 * codeCritic — runs over a generated code snippet when
 * context.code is supplied. Today it checks for obvious red flags
 * (eval, exec, os.system, console.log in production, TODO/FIXME
 * count). Not a replacement for lint/type-check.
 */
function codeCritic({ code, language }) {
  const findings = [];
  if (typeof code !== "string" || !code.trim()) return { ok: true, findings };
  const red = [
    { rx: /\beval\s*\(/, sev: "high", code_id: "eval_usage", detail: "eval() is a code-injection risk." },
    { rx: /\bexec\s*\(/, sev: "high", code_id: "exec_usage", detail: "exec() executes arbitrary code." },
    { rx: /os\.system\s*\(/, sev: "high", code_id: "os_system_usage", detail: "os.system() runs shell; prefer subprocess with argv list." },
    { rx: /child_process\.exec\s*\(/, sev: "high", code_id: "child_process_exec", detail: "child_process.exec is shell-interpolated; prefer execFile." },
    { rx: /dangerouslySetInnerHTML/, sev: "high", code_id: "dangerous_inner_html", detail: "dangerouslySetInnerHTML bypasses React XSS defences." },
    { rx: /TODO|FIXME|XXX/, sev: "low", code_id: "todo_present", detail: "Unresolved TODO/FIXME in production code." },
  ];
  for (const r of red) {
    if (r.rx.test(code)) findings.push({ severity: r.sev, code: r.code_id, detail: r.detail });
  }
  if (language === "python" && !/^\s*from\s+__future__\s+/.test(code) && /print\(/.test(code) && /^\s*def\s+main/.test(code)) {
    findings.push({ severity: "low", code: "print_in_main", detail: "Raw print() in main() — use structured logging in production." });
  }
  return { ok: findings.every(f => f.severity !== "critical" && f.severity !== "high"), findings };
}

/**
 * designCritic — runs the design-tokens contrast checks when the
 * caller supplies a palette/typography spec. Soft checks only.
 */
function designCritic({ designSpec }) {
  if (!designSpec) return { ok: true, findings: [] };
  try {
    const { buildTokens } = require("../design/design-tokens");
    const out = buildTokens(designSpec);
    const findings = [];
    for (const c of out.checks?.contrast || []) {
      if (!c.ok) findings.push({ severity: "high", code: "contrast_fail", detail: `${c.pair}: ${c.detail}` });
    }
    return { ok: findings.length === 0, findings };
  } catch (err) {
    return { ok: false, findings: [{ severity: "medium", code: "design_tokens_failed", detail: err.message }] };
  }
}

/**
 * performanceCritic — checks budgets (tokens, USD, latency) when
 * the caller records them.
 */
function performanceCritic({ budgets }) {
  if (!budgets || typeof budgets !== "object") return { ok: true, findings: [] };
  const findings = [];
  if (typeof budgets.usd_spent === "number" && typeof budgets.usd_max === "number" && budgets.usd_spent > budgets.usd_max) {
    findings.push({ severity: "high", code: "budget_usd_exceeded", detail: `USD ${budgets.usd_spent.toFixed(4)} > max ${budgets.usd_max.toFixed(4)}.` });
  }
  if (typeof budgets.tokens_used === "number" && typeof budgets.tokens_max === "number" && budgets.tokens_used > budgets.tokens_max) {
    findings.push({ severity: "medium", code: "budget_tokens_exceeded", detail: `${budgets.tokens_used} tokens > max ${budgets.tokens_max}.` });
  }
  if (typeof budgets.latency_ms === "number" && typeof budgets.latency_ms_hard === "number" && budgets.latency_ms > budgets.latency_ms_hard) {
    findings.push({ severity: "high", code: "latency_hard_exceeded", detail: `${budgets.latency_ms}ms > hard ${budgets.latency_ms_hard}ms.` });
  } else if (typeof budgets.latency_ms === "number" && typeof budgets.latency_ms_soft === "number" && budgets.latency_ms > budgets.latency_ms_soft) {
    findings.push({ severity: "low", code: "latency_soft_exceeded", detail: `${budgets.latency_ms}ms > soft ${budgets.latency_ms_soft}ms.` });
  }
  return { ok: findings.every(f => f.severity !== "critical" && f.severity !== "high"), findings };
}

/**
 * uxCritic — inline-answer sanity: not empty, not abusive wall of
 * code, no "I can't help with that" cop-outs when the contract
 * required a concrete deliverable.
 */
function uxCritic({ contract, deliverable }) {
  const findings = [];
  if (!deliverable) return { ok: true, findings };
  const text = typeof deliverable === "string" ? deliverable : "";
  if (!text.trim()) {
    findings.push({ severity: "high", code: "empty_answer", detail: "Final deliverable is empty." });
    return { ok: false, findings };
  }
  if (text.length > 80000) {
    findings.push({ severity: "medium", code: "answer_too_long", detail: `Answer is ${text.length} chars — consider trimming.` });
  }
  const copouts = [
    /\bi can't help with that\b/i,
    /\bno puedo ayudarte con eso\b/i,
    /\bas an ai( language)? model\b/i,
  ];
  const contractRequiresAnswer = Boolean(contract?.user_intent);
  if (contractRequiresAnswer) {
    for (const rx of copouts) {
      if (rx.test(text)) {
        findings.push({ severity: "high", code: "cop_out_reply", detail: `Cop-out phrase detected: ${rx.source}` });
      }
    }
  }
  return { ok: findings.every(f => f.severity !== "critical" && f.severity !== "high"), findings };
}

// ─── Registry ──────────────────────────────────────────────────────────

const BUILTIN_CRITICS = {
  intent: intentCritic,
  format: formatCritic,
  factuality: factualityCritic,
  security: securityCritic,
  code: codeCritic,
  design: designCritic,
  performance: performanceCritic,
  ux: uxCritic,
};

/**
 * Run the QA Board over a review `context`. Each critic must be a
 * function matching the critic contract; `customCritics` adds new
 * ones without forking this file.
 *
 * @param {object} ctx — { contract, deliverable, artifact, sources, asvsContext, code, language, designSpec, budgets, ... }
 * @param {object} [opts]
 * @param {string[]} [opts.onlyCritics] — restrict to these kinds
 * @param {Record<string, Function>} [opts.customCritics]
 *
 * @returns {{
 *   decision: "approve"|"hold"|"reject"|"manual-review",
 *   reports: Record<string, Report>,
 *   findings: Array<{source, severity, code, detail}>,
 *   counts: Record<string, number>,
 *   elapsedMs: number,
 * }}
 */
async function runQaBoard(ctx, opts = {}) {
  const start = Date.now();
  const critics = { ...BUILTIN_CRITICS, ...(opts.customCritics || {}) };
  const keys = Array.isArray(opts.onlyCritics) && opts.onlyCritics.length > 0
    ? opts.onlyCritics.filter(k => critics[k])
    : Object.keys(critics);
  const reports = {};
  await Promise.all(keys.map(async (k) => {
    try {
      const r = critics[k](ctx || {}, opts);
      reports[k] = await Promise.resolve(r);
    } catch (err) {
      reports[k] = { ok: false, findings: [{ severity: "medium", code: "critic_threw", detail: `${k}: ${err.message}` }] };
    }
  }));

  // Feed the reports into the existing ValidationFabric aggregator.
  // Map critic kinds onto the fabric's report slots.
  const aggregated = aggregate({
    validation: reports.format || { ok: true, findings: [] },
    security: reports.security || { ok: true, findings: [] },
    factuality: reports.factuality || { ok: true, findings: [] },
    designReview: reports.design || { ok: true, findings: [] },
    codeReview: reports.code || { ok: true, findings: [] },
    performance: reports.performance || { ok: true, findings: [] },
    budgets: ctx?.budgets,
  });

  // Intent + UX aren't slots in the fabric yet — surface them as
  // additional findings prefixed by their source.
  const extraFindings = [];
  for (const k of ["intent", "ux"]) {
    const r = reports[k];
    if (!r) continue;
    for (const f of r.findings || []) {
      extraFindings.push({ source: k, severity: f.severity, code: f.code, detail: f.detail });
    }
  }
  const allFindings = [...aggregated.findings, ...extraFindings];

  // Recompute decision accounting for the extra findings so intent
  // / ux can actually influence the outcome.
  const severeExtras = extraFindings.filter(f => f.severity === "critical" || f.severity === "high");
  let decision = aggregated.decision;
  let reason = aggregated.reason;
  if (severeExtras.length > 0) {
    if (decision === "approve") {
      decision = severeExtras.some(f => f.severity === "critical") ? "reject" : "manual-review";
      reason = `${severeExtras.length} severe finding(s) from intent/UX critics`;
    }
  }

  return {
    decision,
    reason,
    reports,
    findings: allFindings,
    counts: aggregated.counts,
    budgetBreach: aggregated.budgetBreach,
    decidedAt: new Date().toISOString(),
    elapsedMs: Date.now() - start,
  };
}

module.exports = {
  runQaBoard,
  BUILTIN_CRITICS,
  CRITIC_KINDS,
  intentCritic,
  formatCritic,
  factualityCritic,
  securityCritic,
  codeCritic,
  designCritic,
  performanceCritic,
  uxCritic,
};
