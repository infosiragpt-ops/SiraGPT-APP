/**
 * skill-system — first-class "Skill" registry for the AI Product OS.
 *
 * A Skill is a named, modular capability with:
 *
 *   {
 *     id, name, description,
 *     intents,            // intent_primary values that resolve to this skill
 *     required_tools,     // tool ids from tool-registry
 *     required_agents,    // agent ids from agentic-kernel
 *     output_formats,     // ["docx", "pdf", ...]
 *     quality_rules,      // ["no_fake_sources", "apa7_required", ...]
 *     model_profile,      // hint to the model-router
 *     min_plan,           // "FREE" | "PRO" | "ENTERPRISE"
 *     risk_level,
 *     budget,             // soft hint: { max_cost, latency }
 *   }
 *
 * Built-in skills cover the catalog the user described:
 *   academic_report · legal_analysis · market_research · excel_dashboard
 *   · code_review · app_builder · web_research · citation_checker
 *   · powerpoint_designer · image_prompt_engineer · database_query
 *   · scraping_compliant · data_analysis · math_solver
 *
 * The skill registry plus the agent kernel plus the tool registry give
 * us a 3-layer composition: Skill chooses Agents and Tools; Agents
 * carry guardrails; Tools carry permissions.
 *
 * Pure JS, deterministic, zero deps.
 */

const { byId: getTool } = require("./tool-registry");
const { getAgent } = require("./agentic-kernel");

const SKILLS = [
  {
    id: "academic_report",
    name: "Academic Report",
    description: "Genera informes académicos profesionales con fuentes verificables, citas APA 7, tablas y referencias.",
    intents: ["complex_academic_document_generation"],
    required_tools: ["research.agenticBatch", "docintel.ground", "docintel.contradictions", "create_document", "verify_artifact"],
    required_agents: ["intent-compiler", "constraint-extractor", "planner", "research-verifier", "document-analyst", "qa-regression", "release-manager", "telemetry"],
    output_formats: ["docx", "pdf"],
    quality_rules: [
      "no_fake_sources",
      "apa7_required",
      "include_references",
      "validate_sections",
      "evidence_required",
      "format_sovereignty",
    ],
    model_profile: { complexity: "high", requires_reasoning: true, requires_tools: true, requires_long_context: true, max_cost: "high" },
    min_plan: "FREE",
    risk_level: "medium",
  },
  {
    id: "legal_analysis",
    name: "Legal Analysis",
    description: "Análisis legal con jurisprudencia citada, distinciones doctrinales y tabla de fuentes verificables.",
    intents: ["complex_academic_document_generation", "research_question"],
    required_tools: ["research.agenticBatch", "docintel.ground", "create_document"],
    required_agents: ["intent-compiler", "planner", "research-verifier", "document-analyst", "qa-regression", "release-manager", "telemetry"],
    output_formats: ["docx", "pdf"],
    quality_rules: [
      "no_fake_jurisprudence",
      "cite_court_and_year",
      "distinguish_holding_vs_dicta",
      "evidence_required",
    ],
    model_profile: { complexity: "high", requires_reasoning: true, requires_tools: true, max_cost: "high" },
    min_plan: "PRO",
    risk_level: "high",
  },
  {
    id: "market_research",
    name: "Market Research",
    description: "Estudio de mercado con TAM/SAM/SOM, Porter, SWOT, PESTEL, competidores, KPIs y dashboards.",
    intents: ["data_analysis", "research_question", "complex_academic_document_generation"],
    required_tools: ["research.agenticBatch", "bi.market.framework", "bi.semanticModel.compile", "create_document"],
    required_agents: ["intent-compiler", "planner", "research-verifier", "bi-analyst", "design-director", "qa-regression", "release-manager", "telemetry"],
    output_formats: ["docx", "pdf", "xlsx"],
    quality_rules: [
      "no_fake_market_size",
      "cite_industry_reports",
      "include_assumptions",
      "evidence_required",
    ],
    model_profile: { complexity: "high", requires_reasoning: true, requires_tools: true, requires_long_context: true, max_cost: "high" },
    min_plan: "PRO",
    risk_level: "medium",
  },
  {
    id: "excel_dashboard",
    name: "Excel Dashboard",
    description: "Hoja de cálculo profesional con datos, fórmulas, KPIs, condicionales y hoja de interpretación.",
    intents: ["spreadsheet_generation", "data_analysis"],
    required_tools: ["bi.semanticModel.compile", "create_document", "verify_artifact"],
    required_agents: ["intent-compiler", "constraint-extractor", "planner", "bi-analyst", "qa-regression", "release-manager", "telemetry"],
    output_formats: ["xlsx"],
    quality_rules: [
      "include_raw_data_sheet",
      "include_formulas_sheet",
      "include_interpretation_sheet",
      "no_lorem_ipsum",
      "format_sovereignty",
    ],
    model_profile: { complexity: "medium", requires_code: true, requires_tools: true, max_cost: "medium" },
    min_plan: "FREE",
    risk_level: "low",
  },
  {
    id: "code_review",
    name: "Code Review",
    description: "Revisión profesional de código con cyclomatic complexity, secret scan, dependency audit y SAST.",
    intents: ["code_generation"],
    required_tools: ["code-review.analyze", "secret-scanner.scan", "sbom.generate", "dependency-audit.run"],
    required_agents: ["intent-compiler", "code-architect", "security-reviewer", "qa-regression", "telemetry"],
    output_formats: ["text", "markdown_report"],
    quality_rules: [
      "no_dangerous_calls",
      "no_secrets_committed",
      "no_critical_cves",
      "complexity_under_threshold",
    ],
    model_profile: { complexity: "high", requires_code: true, requires_reasoning: true, max_cost: "medium" },
    min_plan: "FREE",
    risk_level: "low",
  },
  {
    id: "app_builder",
    name: "App Builder (full-stack)",
    description: "Genera repos Next.js + FastAPI/NestJS con auth, RBAC, tests, Docker y CI/CD.",
    intents: ["web_app_build"],
    required_tools: ["scaffolder.nextjs", "scaffolder.fastapi", "code-review.analyze", "sbom.generate", "dependency-audit.run", "seo.validate", "wcag.check", "cwv.analyze"],
    required_agents: ["intent-compiler", "constraint-extractor", "planner", "code-architect", "design-director", "frontend-engineer", "backend-engineer", "security-reviewer", "qa-regression", "release-manager", "telemetry"],
    output_formats: ["repo_tree", "code_artifact"],
    quality_rules: [
      "no_lorem_ipsum",
      "wcag_aa_pass",
      "cwv_under_budget",
      "seo_passes",
      "asvs_l1_pass",
      "evidence_required_for_claims",
    ],
    model_profile: { complexity: "high", requires_code: true, requires_reasoning: true, requires_tools: true, max_cost: "high" },
    min_plan: "PRO",
    risk_level: "high",
  },
  {
    id: "web_research",
    name: "Web Research",
    description: "Búsqueda multi-proveedor (Scopus / OpenAlex / SciELO / Crossref / PubMed / DOAJ / Semantic Scholar) con dedupe y rerank.",
    intents: ["research_question"],
    required_tools: ["research.agenticBatch", "self_rag.answer", "docintel.ground"],
    required_agents: ["intent-compiler", "planner", "research-verifier", "qa-regression", "telemetry"],
    output_formats: ["text", "citation_block"],
    quality_rules: [
      "no_fake_doi",
      "include_year_and_venue",
      "evidence_required",
    ],
    model_profile: { complexity: "medium", requires_reasoning: true, requires_tools: true, max_cost: "medium" },
    min_plan: "FREE",
    risk_level: "low",
  },
  {
    id: "citation_checker",
    name: "Citation Checker",
    description: "Verifica que cada cita exista realmente y emite verdicts (supported / unsupported / disputed) con quote spans.",
    intents: ["research_question"],
    required_tools: ["docintel.ground", "research.agenticBatch", "docintel.contradictions"],
    required_agents: ["intent-compiler", "research-verifier", "document-analyst", "qa-regression", "telemetry"],
    output_formats: ["text", "json_report"],
    quality_rules: [
      "every_claim_has_source",
      "no_hallucinated_quotes",
      "evidence_required",
    ],
    model_profile: { complexity: "medium", requires_tools: true, max_cost: "medium" },
    min_plan: "FREE",
    risk_level: "low",
  },
  {
    id: "powerpoint_designer",
    name: "PowerPoint Designer",
    description: "Presentaciones profesionales con paleta coherente, agenda, dividers, títulos, viñetas concisas y notas del orador.",
    intents: ["presentation_generation"],
    required_tools: ["create_document", "verify_artifact"],
    required_agents: ["intent-compiler", "constraint-extractor", "planner", "design-director", "qa-regression", "release-manager", "telemetry"],
    output_formats: ["pptx"],
    quality_rules: [
      "agenda_present",
      "section_dividers_present",
      "no_text_heavy_slides",
      "speaker_notes_when_useful",
      "format_sovereignty",
    ],
    model_profile: { complexity: "medium", requires_tools: true, max_cost: "medium" },
    min_plan: "FREE",
    risk_level: "low",
  },
  {
    id: "visual_artifact",
    name: "Visual Artifact Builder",
    description: "Genera SVG/HTML visuales renderizables con soberanía estricta de formato y validación de accesibilidad.",
    intents: ["design_system"],
    required_tools: ["design.tokens.build", "wcag.contrast.check", "create_document", "verify_artifact"],
    required_agents: ["intent-compiler", "constraint-extractor", "planner", "design-director", "qa-regression", "release-manager", "telemetry"],
    output_formats: ["svg", "html", "image"],
    quality_rules: [
      "format_sovereignty",
      "svg_parseable",
      "renderable_visual",
      "wcag_aa_pass",
      "preserve_user_intent",
      "no_wrong_format",
    ],
    model_profile: { complexity: "medium", requires_tools: true, requires_vision: true, max_cost: "medium" },
    min_plan: "FREE",
    risk_level: "low",
  },
  {
    id: "image_prompt_engineer",
    name: "Image Prompt Engineer",
    description: "Convierte la idea del usuario en un prompt de imagen óptimo y dispara la generación.",
    intents: ["image_generation"],
    required_tools: [],
    required_agents: ["intent-compiler", "design-director", "telemetry"],
    output_formats: ["image"],
    quality_rules: ["preserve_user_intent", "no_invented_text"],
    model_profile: { complexity: "low", requires_vision: true, requires_tools: false, max_cost: "medium" },
    min_plan: "FREE",
    risk_level: "low",
  },
  {
    id: "database_query",
    name: "Database Query",
    description: "Introspección de schemas + SQL parametrizado + EXPLAIN; read-only por defecto, writes requieren approval HITL.",
    intents: ["database_query", "data_analysis"],
    required_tools: ["sql.safety.analyze", "hitl.request"],
    required_agents: ["intent-compiler", "database", "qa-regression", "telemetry"],
    output_formats: ["query_result", "json_report"],
    quality_rules: [
      "read_only_default",
      "no_ddl_without_approval",
      "no_sql_injection_patterns",
      "prepared_statements_only",
    ],
    model_profile: { complexity: "medium", requires_tools: true, requires_reasoning: true, max_cost: "medium" },
    min_plan: "PRO",
    risk_level: "high",
  },
  {
    id: "scraping_compliant",
    name: "Compliant Web Scraping",
    description: "Crawl con respeto a robots.txt, rate limit, transparencia de UA y prohibición de bypass de captchas/paywalls.",
    intents: ["web_scraping"],
    required_tools: ["web.url.canonical", "web.robots.parse", "web.scraper.policy", "web.rate.limit", "web.html.extract"],
    required_agents: ["intent-compiler", "planner", "scraping", "document-analyst", "qa-regression", "telemetry"],
    output_formats: ["json_corpus", "csv"],
    quality_rules: [
      "robots_respected",
      "no_captcha_bypass",
      "no_paywall_bypass",
      "rate_limit_ok",
      "user_agent_transparent",
    ],
    model_profile: { complexity: "medium", requires_tools: true, max_cost: "medium" },
    min_plan: "PRO",
    risk_level: "high",
  },
  {
    id: "data_analysis",
    name: "Data Analysis",
    description: "Pipeline reproducible: lectura → limpieza → transformación → análisis → visualización → interpretación.",
    intents: ["data_analysis"],
    required_tools: ["bi.semanticModel.compile", "bi.market.framework"],
    required_agents: ["intent-compiler", "planner", "database", "bi-analyst", "qa-regression", "telemetry"],
    output_formats: ["xlsx", "json_report", "chart"],
    quality_rules: [
      "no_made_up_metrics",
      "include_assumptions",
      "show_methodology",
      "evidence_required",
    ],
    model_profile: { complexity: "high", requires_code: true, requires_reasoning: true, requires_tools: true, max_cost: "medium" },
    min_plan: "FREE",
    risk_level: "medium",
  },
  {
    id: "math_solver",
    name: "Math / Stats Solver",
    description: "Resolución verificable: muestra fórmula, asunciones, unidades, paso a paso y validación numérica.",
    intents: ["math_solving"],
    required_tools: [],
    required_agents: ["intent-compiler", "telemetry"],
    output_formats: ["text", "latex"],
    quality_rules: [
      "show_formula",
      "show_units",
      "show_assumptions",
      "no_made_up_values",
    ],
    model_profile: { complexity: "high", requires_reasoning: true, requires_code: true, max_cost: "medium" },
    min_plan: "FREE",
    risk_level: "low",
  },
];

const SKILLS_BY_ID = Object.freeze(
  SKILLS.reduce((m, s) => { m[s.id] = s; return m; }, {})
);
const GENERIC_ARTIFACT_TOOLS = new Set(["create_document", "verify_artifact"]);

function listSkills({ minPlan } = {}) {
  if (!minPlan) return SKILLS.map(s => deepClone(s));
  const order = { FREE: 0, PRO: 1, ENTERPRISE: 2 };
  const have = order[minPlan] ?? 0;
  return SKILLS.filter(s => (order[s.min_plan] ?? 0) <= have).map(s => deepClone(s));
}

function getSkill(id) {
  return SKILLS_BY_ID[id] ? deepClone(SKILLS_BY_ID[id]) : null;
}

/**
 * Resolve a RouterDecision (intent + tools) to the best Skill.
 * Picks the skill whose `intents` includes intent_primary AND whose
 * required_tools overlap most with the router's required_tools. Ties
 * break on min_plan eligibility, then on alphabetical id.
 */
function resolveSkillForIntent(decision, { userPlan = "FREE" } = {}) {
  if (!decision || !decision.intent_primary) return null;
  const order = { FREE: 0, PRO: 1, ENTERPRISE: 2 };
  const planRank = order[userPlan] ?? 0;

  const candidates = SKILLS
    .filter(s => s.intents.includes(decision.intent_primary))
    .filter(s => (order[s.min_plan] ?? 0) <= planRank);

  if (candidates.length === 0) return null;

  const requestTools = new Set(decision.required_tools || []);
  const ranked = candidates.map(s => {
    const overlap = s.required_tools.filter(t => requestTools.has(t)).length;
    return { skill: s, overlap };
  }).sort((a, b) => b.overlap - a.overlap || a.skill.id.localeCompare(b.skill.id));

  return deepClone(ranked[0].skill);
}

/**
 * Resolve all relevant skills for a decision, not just the single best
 * match. This is the internal "AI Skill System" used by the chat
 * runtime: complex prompts often require a primary skill plus support
 * skills (e.g. academic_report + web_research + citation_checker).
 */
function resolveSkillsForDecision(decision, { userPlan = "ENTERPRISE", maxSkills = 6 } = {}) {
  if (!decision || !decision.intent_primary) return [];
  const order = { FREE: 0, PRO: 1, ENTERPRISE: 2 };
  const planRank = order[userPlan] ?? order.ENTERPRISE;
  const requestTools = new Set(decision.required_tools || []);
  const secondary = new Set(decision.intent_secondary || []);
  const finalOutput = String(decision.final_output || '').toLowerCase();

  const scored = SKILLS
    .filter(s => (order[s.min_plan] ?? 0) <= planRank)
    .map(skill => {
      let score = 0;
      const reasons = [];
      let hasPrimaryFit = false;
      let hasOutputFit = false;

      if (skill.intents.includes(decision.intent_primary)) {
        score += 12;
        reasons.push('primary_intent');
        hasPrimaryFit = true;
      }

      const significantOverlap = skill.required_tools
        .filter(t => requestTools.has(t) && !GENERIC_ARTIFACT_TOOLS.has(t)).length;
      if (significantOverlap > 0) {
        score += significantOverlap * 3;
        reasons.push(`tool_overlap:${significantOverlap}`);
      }

      if (matchesOutputFormat(skill, finalOutput)) {
        score += 4;
        reasons.push('output_format');
        hasOutputFit = true;
      }

      const secondaryScore = scoreSecondaryFit(skill, secondary);
      if (secondaryScore > 0) {
        score += secondaryScore;
        reasons.push(`secondary_fit:${secondaryScore}`);
      }

      const genericOverlap = skill.required_tools
        .filter(t => requestTools.has(t) && GENERIC_ARTIFACT_TOOLS.has(t)).length;
      if (genericOverlap > 0 && (hasPrimaryFit || hasOutputFit || secondaryScore > 0)) {
        score += genericOverlap;
        reasons.push(`generic_artifact_tool_overlap:${genericOverlap}`);
      }

      return { skill, score, reasons };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id))
    .slice(0, maxSkills);

  return scored.map(x => ({
    ...deepClone(x.skill),
    match_score: x.score,
    match_reasons: x.reasons,
  }));
}

function buildSkillExecutionPlan(decision, options = {}) {
  const selectedSkills = resolveSkillsForDecision(decision, options);
  const primarySkill = selectedSkills[0] || resolveSkillForIntent(decision, { userPlan: options.userPlan || "ENTERPRISE" });
  const skills = selectedSkills.length > 0 ? selectedSkills : (primarySkill ? [primarySkill] : []);
  const requiredAgents = uniq([
    ...(decision?.required_agents || []),
    ...skills.flatMap(skill => skill.required_agents || []),
  ]);
  const requiredTools = uniq([
    ...(decision?.required_tools || []),
    ...skills.flatMap(skill => skill.required_tools || []),
  ]);
  const qualityRules = uniq(skills.flatMap(skill => skill.quality_rules || []));
  const outputFormats = uniq(skills.flatMap(skill => skill.output_formats || []));

  return {
    version: "skill-execution-plan-2026-04",
    ok: true,
    primary_skill_id: skills[0]?.id || null,
    selected_skills: skills.map(skill => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      output_formats: skill.output_formats,
      quality_rules: skill.quality_rules,
      match_score: skill.match_score || null,
      match_reasons: skill.match_reasons || [],
    })),
    required_agents: requiredAgents,
    required_tools: requiredTools,
    output_formats: outputFormats,
    quality_rules: qualityRules,
    model_profile: mergeModelProfiles(skills.map(skill => skill.model_profile || {})),
    release_policy: {
      requires_validation_report: true,
      requires_format_sovereignty: qualityRules.includes("format_sovereignty") || Boolean(decision?.final_output),
      requires_evidence: qualityRules.includes("evidence_required") || qualityRules.includes("no_fake_sources"),
      block_on_failed_skill_gate: true,
    },
  };
}

/**
 * Combine a RouterDecision with a resolved Skill into an upgraded
 * decision: union(agents, tools), keep skill identity, preserve
 * the original confidence and intent_secondary.
 */
function mergeDecisionWithSkill(decision, skill) {
  if (!skill) return { ...decision, skill_id: null };
  const agents = uniq([...(decision.required_agents || []), ...(skill.required_agents || [])]);
  const tools = uniq([...(decision.required_tools || []), ...(skill.required_tools || [])]);
  return {
    ...decision,
    skill_id: skill.id,
    skill_name: skill.name,
    required_agents: agents,
    required_tools: tools,
    quality_rules: [...(skill.quality_rules || [])],
    output_formats: [...(skill.output_formats || [])],
  };
}

function mergeDecisionWithSkillPlan(decision, skillPlan) {
  if (!skillPlan || !Array.isArray(skillPlan.selected_skills)) {
    return { ...decision, skill_id: null, skill_ids: [] };
  }
  return {
    ...decision,
    skill_id: skillPlan.primary_skill_id,
    skill_ids: skillPlan.selected_skills.map(skill => skill.id),
    required_agents: uniq([...(decision.required_agents || []), ...(skillPlan.required_agents || [])]),
    required_tools: uniq([...(decision.required_tools || []), ...(skillPlan.required_tools || [])]),
    quality_rules: [...(skillPlan.quality_rules || [])],
    output_formats: [...(skillPlan.output_formats || [])],
  };
}

function integrity() {
  const seen = new Set();
  const issues = [];
  for (const s of SKILLS) {
    if (seen.has(s.id)) issues.push(`duplicate skill id "${s.id}"`);
    seen.add(s.id);
    for (const t of s.required_tools) {
      if (!getTool(t)) issues.push(`${s.id} → unknown tool "${t}"`);
    }
    for (const a of s.required_agents) {
      if (!getAgent(a)) issues.push(`${s.id} → unknown agent "${a}"`);
    }
    if (!Array.isArray(s.intents) || s.intents.length === 0) issues.push(`${s.id} has no intents`);
    if (!Array.isArray(s.output_formats)) issues.push(`${s.id} has no output_formats`);
  }
  return { ok: issues.length === 0, issues, total: SKILLS.length };
}

function uniq(arr) {
  return [...new Set(arr)];
}

function deepClone(s) {
  return JSON.parse(JSON.stringify(s));
}

function matchesOutputFormat(skill, finalOutput) {
  if (!finalOutput) return false;
  return (skill.output_formats || []).some(format => {
    const f = String(format).toLowerCase();
    return finalOutput.includes(f) || (f === "docx" && finalOutput.includes("word"))
      || (f === "xlsx" && finalOutput.includes("excel"))
      || (f === "pptx" && finalOutput.includes("presentation"));
  });
}

function scoreSecondaryFit(skill, secondary) {
  if (!secondary || secondary.size === 0) return 0;
  let score = 0;
  const id = skill.id;
  if (id === "citation_checker" && hasAny(secondary, ["citation_grounding", "apa7_citation", "doi_validation", "scientific_research"])) score += 8;
  if (id === "web_research" && hasAny(secondary, ["multi_provider_search", "scientific_research", "doi_validation", "web_research"])) score += 7;
  if (id === "academic_report" && hasAny(secondary, ["apa7_citation", "docx_export", "scientific_research"])) score += 6;
  if (id === "excel_dashboard" && hasAny(secondary, ["tabular_data", "excel_analysis", "spreadsheet_export"])) score += 6;
  if (id === "market_research" && hasAny(secondary, ["market_research", "competitor_analysis", "benchmarking"])) score += 6;
  return score;
}

function hasAny(set, values) {
  return values.some(v => set.has(v));
}

function mergeModelProfiles(profiles) {
  const rank = { low: 1, medium: 2, high: 3 };
  const merged = {
    complexity: "low",
    requires_reasoning: false,
    requires_tools: false,
    requires_long_context: false,
    requires_vision: false,
    requires_code: false,
    max_cost: "low",
    latency: "normal",
  };
  for (const profile of profiles) {
    if (!profile || typeof profile !== "object") continue;
    if ((rank[profile.complexity] || 0) > (rank[merged.complexity] || 0)) merged.complexity = profile.complexity;
    if ((rank[profile.max_cost] || 0) > (rank[merged.max_cost] || 0)) merged.max_cost = profile.max_cost;
    merged.requires_reasoning ||= Boolean(profile.requires_reasoning);
    merged.requires_tools ||= Boolean(profile.requires_tools);
    merged.requires_long_context ||= Boolean(profile.requires_long_context);
    merged.requires_vision ||= Boolean(profile.requires_vision);
    merged.requires_code ||= Boolean(profile.requires_code);
    if (profile.latency === "fast") merged.latency = "fast";
  }
  return merged;
}

module.exports = {
  SKILLS,
  SKILLS_BY_ID,
  listSkills,
  getSkill,
  resolveSkillForIntent,
  resolveSkillsForDecision,
  buildSkillExecutionPlan,
  mergeDecisionWithSkill,
  mergeDecisionWithSkillPlan,
  integrity,
};
