/**
 * model-router — Capa 1 (AI Gateway / Model Router) of the AI Product
 * Operating System.
 *
 * Public API:
 *
 *   select({
 *     task,                   // semantic task name (e.g. "academic_document_generation")
 *     complexity,             // "low" | "medium" | "high"
 *     requires_reasoning,     // boolean
 *     requires_tools,         // boolean
 *     requires_long_context,  // boolean
 *     requires_vision,        // boolean
 *     requires_code,          // boolean
 *     max_cost,               // "low" | "medium" | "high"
 *     latency,                // "fast" | "normal" | "slow_ok"
 *     language,               // ISO code, default "es"
 *     user_plan,              // "FREE" | "PRO" | "ENTERPRISE"
 *     prefer,                 // optional model id to prefer if eligible
 *   }) → { model, score, alternatives, rationale }
 *
 * The catalog stores a deterministic profile of each available model
 * (capabilities + cost + latency tier + provider). Selection is a
 * pure scoring function — no LLM call. Tests are reproducible.
 *
 * Pure JS, deterministic, zero deps.
 */

const COST_RANK = Object.freeze({ low: 1, medium: 2, high: 3 });
const LATENCY_RANK = Object.freeze({ fast: 1, normal: 2, slow_ok: 3 });

/**
 * Deterministic capability/cost/latency profile per model. We do not
 * call the model APIs to discover this — the profile is what the
 * selector scores against.
 */
const CATALOG = [
  {
    id: "gpt-5", provider: "openai", family: "gpt-5",
    capabilities: { reasoning: 0.96, code: 0.94, tools: 0.95, vision: 0.94, long_context: 0.92 },
    cost_tier: "high", latency_tier: "normal",
    context_window: 400_000, max_output: 32_000,
    supports_structured_outputs: true, supports_streaming: true,
    supports_caching: true,
    languages: ["en", "es", "fr", "de", "pt", "it", "ja", "zh", "ko", "ar"],
    plans: ["PRO", "ENTERPRISE"],
  },
  {
    id: "gpt-5-mini", provider: "openai", family: "gpt-5",
    capabilities: { reasoning: 0.86, code: 0.88, tools: 0.9, vision: 0.88, long_context: 0.85 },
    cost_tier: "medium", latency_tier: "fast",
    context_window: 200_000, max_output: 16_000,
    supports_structured_outputs: true, supports_streaming: true,
    supports_caching: true,
    languages: ["en", "es", "fr", "de", "pt", "it", "ja", "zh"],
    plans: ["FREE", "PRO", "ENTERPRISE"],
  },
  {
    id: "gpt-4o", provider: "openai", family: "gpt-4",
    capabilities: { reasoning: 0.84, code: 0.86, tools: 0.88, vision: 0.92, long_context: 0.78 },
    cost_tier: "medium", latency_tier: "fast",
    context_window: 128_000, max_output: 16_000,
    supports_structured_outputs: true, supports_streaming: true,
    supports_caching: false,
    languages: ["en", "es", "fr", "de", "pt", "it", "ja", "zh"],
    plans: ["FREE", "PRO", "ENTERPRISE"],
  },
  {
    id: "gemini-2.5-pro", provider: "google", family: "gemini-2.5",
    capabilities: { reasoning: 0.9, code: 0.88, tools: 0.86, vision: 0.94, long_context: 0.96 },
    cost_tier: "medium", latency_tier: "normal",
    context_window: 2_000_000, max_output: 16_000,
    supports_structured_outputs: true, supports_streaming: true,
    supports_caching: true,
    languages: ["en", "es", "fr", "de", "pt", "it", "ja", "zh", "ko", "ar"],
    plans: ["PRO", "ENTERPRISE"],
  },
  {
    id: "gemini-2.5-flash", provider: "google", family: "gemini-2.5",
    capabilities: { reasoning: 0.78, code: 0.78, tools: 0.82, vision: 0.88, long_context: 0.94 },
    cost_tier: "low", latency_tier: "fast",
    context_window: 1_000_000, max_output: 16_000,
    supports_structured_outputs: true, supports_streaming: true,
    supports_caching: true,
    languages: ["en", "es", "fr", "de", "pt", "it"],
    plans: ["FREE", "PRO", "ENTERPRISE"],
  },
  {
    id: "deepseek-v4-pro", provider: "deepseek", family: "deepseek-v4",
    capabilities: { reasoning: 0.85, code: 0.92, tools: 0.84, vision: 0.6, long_context: 0.85 },
    cost_tier: "low", latency_tier: "normal",
    context_window: 256_000, max_output: 16_000,
    supports_structured_outputs: true, supports_streaming: true,
    supports_caching: false,
    languages: ["en", "zh", "es"],
    plans: ["FREE", "PRO", "ENTERPRISE"],
  },
  {
    id: "moonshotai/kimi-k2.6", provider: "openrouter", family: "kimi",
    capabilities: { reasoning: 0.86, code: 0.88, tools: 0.86, vision: 0.86, long_context: 0.92 },
    cost_tier: "low", latency_tier: "normal",
    context_window: 200_000, max_output: 16_000,
    supports_structured_outputs: true, supports_streaming: true,
    supports_caching: false,
    languages: ["en", "zh", "es"],
    plans: ["FREE", "PRO", "ENTERPRISE"],
  },
];

const CATALOG_BY_ID = Object.freeze(
  CATALOG.reduce((m, x) => { m[x.id] = x; return m; }, {})
);

function listModels({ plan } = {}) {
  if (!plan) return CATALOG.map(m => ({ ...m }));
  return CATALOG.filter(m => m.plans.includes(plan)).map(m => ({ ...m }));
}

function getModel(id) {
  return CATALOG_BY_ID[id] ? { ...CATALOG_BY_ID[id] } : null;
}

/**
 * Score a single model against a request. The scorer is deterministic
 * and uses additive penalties / bonuses that map to clearly-named
 * components (capability, cost, latency, language, prefer).
 */
function scoreModel(model, req) {
  const caps = model.capabilities;
  let score = 0;
  const reasons = [];

  // ── Capability terms ─────────────────────────────────────────────
  if (req.requires_reasoning) {
    score += caps.reasoning * 30;
    reasons.push(`reasoning ${caps.reasoning} → +${(caps.reasoning * 30).toFixed(1)}`);
  } else {
    score += caps.reasoning * 8;
  }
  if (req.requires_code) {
    score += caps.code * 25;
    reasons.push(`code ${caps.code} → +${(caps.code * 25).toFixed(1)}`);
  }
  if (req.requires_tools) {
    score += caps.tools * 20;
    reasons.push(`tools ${caps.tools} → +${(caps.tools * 20).toFixed(1)}`);
  } else {
    score += caps.tools * 5;
  }
  if (req.requires_vision) {
    score += caps.vision * 25;
    reasons.push(`vision ${caps.vision} → +${(caps.vision * 25).toFixed(1)}`);
  }
  if (req.requires_long_context) {
    score += caps.long_context * 25;
    reasons.push(`long_context ${caps.long_context} → +${(caps.long_context * 25).toFixed(1)}`);
  }

  // Complexity scaling
  const complexityBonus = ({ low: 0, medium: 5, high: 12 })[req.complexity || "medium"] || 0;
  score += complexityBonus * caps.reasoning;
  if (complexityBonus) reasons.push(`complexity ${req.complexity} × reasoning ${caps.reasoning} → +${(complexityBonus * caps.reasoning).toFixed(1)}`);

  // ── Cost / latency penalties ─────────────────────────────────────
  // Under-budget bonus is intentionally tiny so it acts ONLY as a
  // tie-breaker, not as something that overpowers a 30-point capability
  // term. Scaled inversely to complexity so high-complexity tasks don't
  // get pushed to a cheaper-but-weaker model.
  const costBudget = COST_RANK[req.max_cost || "high"];
  const modelCost = COST_RANK[model.cost_tier];
  if (modelCost > costBudget) {
    score -= (modelCost - costBudget) * 25;
    reasons.push(`over_cost_budget (${model.cost_tier} > ${req.max_cost}) → -${((modelCost - costBudget) * 25).toFixed(1)}`);
  } else if (modelCost < costBudget) {
    const complexity = req.complexity || "medium";
    const factor = complexity === "high" ? 0.2 : complexity === "low" ? 1.5 : 0.7;
    score += (costBudget - modelCost) * factor;
  }

  const latencyBudget = LATENCY_RANK[req.latency || "normal"];
  const modelLatency = LATENCY_RANK[model.latency_tier];
  if (modelLatency > latencyBudget) {
    score -= (modelLatency - latencyBudget) * 12;
    reasons.push(`over_latency_budget (${model.latency_tier} > ${req.latency}) → -${((modelLatency - latencyBudget) * 12).toFixed(1)}`);
  }

  // ── Language ─────────────────────────────────────────────────────
  const lang = String(req.language || "es").toLowerCase();
  if (!model.languages.includes(lang)) {
    score -= 10;
    reasons.push(`language_${lang}_unsupported → -10`);
  }

  // ── Plan eligibility (HARD filter is applied earlier; this is the
  //    soft fallback for partial matches) ──────────────────────────
  if (req.user_plan && !model.plans.includes(req.user_plan)) {
    score -= 1000; // hard reject
    reasons.push(`plan_${req.user_plan}_not_eligible → -1000`);
  }

  // ── User preference / structured outputs ─────────────────────────
  if (req.prefer && model.id === req.prefer) {
    score += 8;
    reasons.push("user_prefer → +8");
  }
  if (req.requires_structured_outputs && !model.supports_structured_outputs) {
    score -= 50;
    reasons.push("structured_outputs_required_but_unsupported → -50");
  }

  return { score: Math.round(score * 10) / 10, reasons };
}

/**
 * Pick the best model for a request. Returns the chosen model + the
 * top-3 alternatives + a rationale string.
 *
 * @param {object} req
 * @returns {{ model, score, alternatives, rationale }}
 */
function select(req = {}) {
  const eligible = listModels({ plan: req.user_plan });
  if (eligible.length === 0) {
    return { model: null, score: 0, alternatives: [], rationale: "no_eligible_models_for_plan" };
  }

  const scored = eligible.map(m => ({
    model: m,
    ...scoreModel(m, req),
  })).sort((a, b) => b.score - a.score);

  const winner = scored[0];
  const top3 = scored.slice(0, 3).map(s => ({ id: s.model.id, score: s.score }));
  const rationale = `Picked ${winner.model.id} (score ${winner.score}). Reasons: ${winner.reasons.join(", ")}`;

  return {
    model: winner.model,
    score: winner.score,
    alternatives: top3.slice(1),
    rationale,
  };
}

/**
 * Convenience: derive a request shape from a RouterDecision (intent +
 * tools + final_output) so callers don't have to translate twice.
 */
function reqFromDecision(decision, extra = {}) {
  const intent = decision?.intent_primary || "text_answer";
  const tools = decision?.required_tools || [];
  const out = decision?.final_output || "text";

  return {
    task: intent,
    complexity: inferComplexity(intent),
    requires_reasoning: ["complex_academic_document_generation", "research_question", "data_analysis", "code_generation", "web_app_build", "math_solving", "agent_long_running_task"].includes(intent),
    requires_tools: tools.length > 0,
    requires_long_context: tools.includes("docintel.analyze") || tools.includes("rag.retrieve"),
    requires_vision: out === "image" || out === "video",
    requires_code: ["code_generation", "web_app_build", "data_analysis"].includes(intent),
    requires_structured_outputs: ["spreadsheet_generation", "complex_academic_document_generation", "pdf_report_generation", "data_analysis", "research_question"].includes(intent),
    max_cost: extra.max_cost || (intent === "small_talk" ? "low" : "high"),
    latency: extra.latency || (intent === "small_talk" ? "fast" : "normal"),
    language: extra.language || "es",
    user_plan: extra.user_plan,
    prefer: extra.prefer,
  };
}

function inferComplexity(intent) {
  if (["complex_academic_document_generation", "web_app_build", "agent_long_running_task"].includes(intent)) return "high";
  if (["small_talk", "text_answer"].includes(intent)) return "low";
  return "medium";
}

function integrity() {
  const seen = new Set();
  const issues = [];
  for (const m of CATALOG) {
    if (seen.has(m.id)) issues.push(`duplicate id "${m.id}"`);
    seen.add(m.id);
    for (const k of ["reasoning", "code", "tools", "vision", "long_context"]) {
      if (typeof m.capabilities[k] !== "number") issues.push(`${m.id} missing capability ${k}`);
    }
    if (!COST_RANK[m.cost_tier]) issues.push(`${m.id} bad cost_tier`);
    if (!LATENCY_RANK[m.latency_tier]) issues.push(`${m.id} bad latency_tier`);
  }
  return { ok: issues.length === 0, issues, total: CATALOG.length };
}

module.exports = {
  CATALOG,
  CATALOG_BY_ID,
  listModels,
  getModel,
  scoreModel,
  select,
  reqFromDecision,
  integrity,
};
