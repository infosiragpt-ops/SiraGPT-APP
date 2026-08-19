/**
 * semantic-router + tool-registry + planner-agent — deterministic
 * tests for the upgraded comprehension layer of the AI Product OS.
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const router = require("../src/services/ai-product-os/semantic-intent-router");
const reg = require("../src/services/ai-product-os/tool-registry");
const planner = require("../src/services/ai-product-os/planner-agent");

function expect(actual) {
  return {
    toEqual(e) { assert.deepEqual(actual, e); },
    toBe(e) { assert.equal(actual, e); },
    toBeGreaterThan(e) { assert.ok(actual > e, `${actual} not > ${e}`); },
    toBeGreaterThanOrEqual(e) { assert.ok(actual >= e, `${actual} not >= ${e}`); },
    toBeLessThan(e) { assert.ok(actual < e, `${actual} not < ${e}`); },
    toContain(e) { assert.ok(Array.isArray(actual) ? actual.includes(e) : String(actual).includes(e), `not contained: ${e}`); },
    toBeTruthy() { assert.ok(actual); },
    toBeFalsy() { assert.ok(!actual); },
    toMatch(p) { assert.match(String(actual), p); },
  };
}

// ── SemanticIntentRouter ────────────────────────────────────────────

describe("router / regex fallback", () => {
  test("question about an attached document → text_answer (not doc gen)", async () => {
    const d = await router.classifyIntent({
      prompt: "¿Cuál es la primera palabra del word?",
      context: { has_attachments: true, attachment_kinds: ["docx"] },
    });
    expect(d.intent_primary).toBe("text_answer");
    expect(d.tier).toBe("regex");
    expect(d.intent_secondary.includes("answer_against_attachment")).toBe(true);
  });

  test("explicit generation verb + word → complex_academic_document_generation", async () => {
    const d = await router.classifyIntent({
      prompt: "Genera un Word con un resumen estructurado",
    });
    expect(d.intent_primary).toBe("complex_academic_document_generation");
    expect(d.required_agents.includes("planner")).toBe(true);
    expect(d.final_output).toBe("word_document");
  });

  test("apa 7 cue routes to academic doc generation with secondary intents", async () => {
    const d = await router.classifyIntent({
      prompt: "Necesito una tesis en formato apa 7 sobre depresión adolescente",
    });
    expect(d.intent_primary).toBe("complex_academic_document_generation");
    expect(d.intent_secondary.includes("apa7_citation")).toBe(true);
    expect(d.intent_secondary.includes("scientific_research")).toBe(true);
  });

  test("research-style question → research_question", async () => {
    const d = await router.classifyIntent({
      prompt: "Busca artículos científicos sobre validación de la escala BAI",
    });
    expect(d.intent_primary).toBe("research_question");
    expect(d.required_tools.includes("research.agenticBatch")).toBe(true);
  });

  test("web app build → web_app_build with frontend+backend agents", async () => {
    const d = await router.classifyIntent({
      prompt: "Construye una landing en Next.js para mi portfolio",
    });
    expect(d.intent_primary).toBe("web_app_build");
    expect(d.required_agents.includes("frontend-engineer")).toBe(true);
    expect(d.required_agents.includes("backend-engineer")).toBe(true);
  });

  test("image generation cue → image_generation", async () => {
    const d = await router.classifyIntent({ prompt: "Genera una imagen de un atardecer en la sierra" });
    expect(d.intent_primary).toBe("image_generation");
    expect(d.final_output).toBe("image");
  });

  test("scraping cue → web_scraping with compliance tools", async () => {
    const d = await router.classifyIntent({ prompt: "Scrapea precios públicos de los competidores" });
    expect(d.intent_primary).toBe("web_scraping");
    expect(d.required_tools.includes("web.robots.parse")).toBe(true);
    expect(d.required_tools.includes("web.scraper.policy")).toBe(true);
  });

  test("database cue → database_query with sql safety tool", async () => {
    const d = await router.classifyIntent({ prompt: "Consulta la base de datos postgres con un select join" });
    expect(d.intent_primary).toBe("database_query");
    expect(d.required_tools.includes("sql.safety.analyze")).toBe(true);
  });

  test("under-specified prompt → needs_clarification true", async () => {
    const d = await router.classifyIntent({ prompt: "ok" });
    expect(d.needs_clarification).toBe(true);
  });

  test("empty prompt → deterministic unknown decision", async () => {
    const d = await router.classifyIntent({ prompt: "" });
    expect(d.intent_primary).toBe("unknown");
    expect(d.tier).toBe("deterministic");
  });
});

describe("router / LLM tier", () => {
  const llmClient = {
    classify: async () => ({
      intent_primary: "complex_academic_document_generation",
      intent_secondary: ["scientific_research", "doi_validation", "apa7_citation"],
      required_agents: ["planner", "research-verifier", "document-analyst", "frontend-engineer", "qa-regression", "release-manager"],
      required_tools: ["research.agenticBatch", "docintel.ground", "create_document", "verify_artifact"],
      confidence: 0.94,
      needs_clarification: false,
      final_output: "word_document",
    }),
  };

  test("LLM-tier decision is honoured when client provided", async () => {
    const d = await router.classifyIntent({
      prompt: "Genera una tesis APA con DOI verificables",
      llmClient,
    });
    expect(d.tier).toBe("llm");
    expect(d.intent_primary).toBe("complex_academic_document_generation");
    expect(d.confidence).toBeGreaterThanOrEqual(0.9);
    expect(d.required_tools.includes("create_document")).toBe(true);
  });

  test("LLM error falls back to regex tier and records llm_error", async () => {
    const failing = { classify: async () => { const e = new Error("boom"); throw e; } };
    const d = await router.classifyIntent({
      prompt: "Crea un excel con datos de ventas",
      llmClient: failing,
    });
    expect(d.tier).toBe("regex");
    expect(d.trace.llm_error).toBe("boom");
    expect(d.intent_primary).toBe("spreadsheet_generation");
  });

  test("LLM with unknown intent_primary is rejected (falls back to regex)", async () => {
    const bad = { classify: async () => ({ intent_primary: "rocket_launch", confidence: 1, needs_clarification: false }) };
    const d = await router.classifyIntent({ prompt: "Crea un word", llmClient: bad });
    expect(d.tier).toBe("regex");
  });

  test("sanitizeLlmDecision strips unknown agents and tools", () => {
    const sanitized = router.sanitizeLlmDecision({
      intent_primary: "research_question",
      intent_secondary: ["x"],
      required_agents: ["intent-compiler", "ghost-agent", "research-verifier"],
      required_tools: ["research.agenticBatch", "ghost.tool"],
      confidence: 0.7,
      needs_clarification: false,
      final_output: "text_with_citations",
    }, { prompt: "test", context: {} });
    expect(sanitized.required_agents.includes("ghost-agent")).toBe(false);
    expect(sanitized.required_agents.includes("research-verifier")).toBe(true);
    expect(sanitized.required_tools.includes("ghost.tool")).toBe(true); // tools allowlist is the planner's job
  });

  test("LLM decision missing agents falls back to default bundle", () => {
    const sanitized = router.sanitizeLlmDecision({
      intent_primary: "spreadsheet_generation",
      intent_secondary: [],
      required_agents: [],
      required_tools: [],
      confidence: 0.6,
      needs_clarification: false,
      final_output: "xlsx_document",
    }, { prompt: "test", context: {} });
    expect(sanitized.required_agents.includes("planner")).toBe(true);
    expect(sanitized.required_agents.includes("bi-analyst")).toBe(true);
  });

  test("schema is well-formed for OpenAI structured outputs", () => {
    const schema = router.buildClassifierSchema();
    expect(schema.type).toBe("object");
    expect(schema.required.includes("intent_primary")).toBe(true);
    expect(schema.properties.intent_primary.enum.includes("text_answer")).toBe(true);
  });
});

// ── Tool Registry ────────────────────────────────────────────────────

describe("tool-registry", () => {
  test("integrity passes", () => {
    const r = reg.integrity();
    expect(r.ok).toBe(true);
    expect(r.total).toBeGreaterThanOrEqual(20);
  });

  test("byId / byCategory / search work", () => {
    expect(reg.byId("create_document").category).toBe("document");
    expect(reg.byCategory("document").length).toBeGreaterThan(0);
    expect(reg.search("audit").length).toBeGreaterThan(0);
  });

  test("recommendedFor returns tools tagged with that intent", () => {
    const docs = reg.recommendedFor("complex_academic_document_generation");
    expect(docs.some(t => t.id === "create_document")).toBe(true);
    expect(docs.some(t => t.id === "research.agenticBatch")).toBe(true);
  });

  test("bindToMcpGateway only registers tools the caller knows how to run", () => {
    const calls = [];
    const gateway = { registerTool: (t) => calls.push(t.name) };
    const r = reg.bindToMcpGateway(gateway, {
      handlerFor: (t) => (t.id === "verify_artifact" ? async () => ({ ok: true }) : null),
    });
    expect(r.bound).toBe(1);
    expect(calls[0]).toBe("verify_artifact");
  });

  test("bindToMcpGateway throws if gateway is invalid", () => {
    assert.throws(() => reg.bindToMcpGateway({}, { handlerFor: () => null }), /registerTool/);
  });
});

// ── Planner Agent ────────────────────────────────────────────────────

describe("planner-agent", () => {
  test("complex academic doc plan has the expected phase shape", () => {
    const decision = router.regexDecision("Necesito una tesis APA 7 sobre embarazo adolescente con DOI verificables");
    const { plan, validation } = planner.buildAndValidate(decision);
    expect(validation.ok).toBe(true);
    const ids = plan.nodes.map(n => n.id);
    expect(ids[0]).toBe("intent.compile");
    expect(ids.includes("research.collect")).toBe(true);
    expect(ids.includes("qa.regression")).toBe(true);
    expect(ids.includes("release.decide")).toBe(true);
    expect(ids[ids.length - 1]).toBe("telemetry.emit");
  });

  test("text_answer plan is short (no build phase)", () => {
    const decision = router.regexDecision("¿Cuál es la primera palabra del word?", { has_attachments: true });
    const { plan, validation } = planner.buildAndValidate(decision);
    expect(validation.ok).toBe(true);
    const ids = plan.nodes.map(n => n.id);
    expect(ids).toEqual(["intent.compile"]);
  });

  test("web_app_build plan includes design + code-architect + frontend + backend + security + qa + release", () => {
    const decision = router.regexDecision("Construye una landing en Next.js para mi portfolio");
    const { plan, validation } = planner.buildAndValidate(decision);
    expect(validation.ok).toBe(true);
    const ids = plan.nodes.map(n => n.id);
    expect(ids.includes("code.architect")).toBe(true);
    expect(ids.includes("frontend.build")).toBe(true);
    expect(ids.includes("backend.build")).toBe(true);
    expect(ids.includes("security.review")).toBe(true);
    expect(ids.includes("qa.regression")).toBe(true);
    expect(ids.includes("release.decide")).toBe(true);
  });

  test("scraping plan attaches compliance validation_gate", () => {
    const decision = router.regexDecision("Scrapea precios públicos respetando robots.txt");
    const { plan } = planner.buildAndValidate(decision);
    const node = plan.nodes.find(n => n.id === "web.scrape");
    expect(node).toBeTruthy();
    expect(node.validation_gate.deterministic_checks.includes("robots_respected")).toBe(true);
    expect(node.validation_gate.deterministic_checks.includes("no_captcha_paywall_bypass")).toBe(true);
  });

  test("database plan attaches sql safety + read-only validation", () => {
    const decision = router.regexDecision("Consulta postgres con un select join");
    const { plan } = planner.buildAndValidate(decision);
    const node = plan.nodes.find(n => n.id === "db.introspect");
    expect(node).toBeTruthy();
    expect(node.validation_gate.deterministic_checks.includes("read_only_default")).toBe(true);
  });

  test("validatePlan flags forward dependencies", () => {
    const broken = {
      nodes: [
        { id: "a", depends_on: [] },
        { id: "b", depends_on: ["c"] },
        { id: "c", depends_on: [] },
      ],
    };
    const r = planner.validatePlan(broken);
    expect(r.ok).toBe(false);
    expect(r.issues.some(i => i.includes("forward_dependency"))).toBe(true);
  });

  test("validatePlan flags duplicate node ids", () => {
    const broken = {
      nodes: [
        { id: "intent.compile", depends_on: [] },
        { id: "intent.compile", depends_on: [] },
      ],
    };
    const r = planner.validatePlan(broken);
    expect(r.ok).toBe(false);
    expect(r.issues.some(i => i.includes("duplicate_node_id"))).toBe(true);
  });

  test("planFromDecision throws on missing decision", () => {
    assert.throws(() => planner.planFromDecision(null), /RouterDecision required/);
  });

  test("plan release_gate.requires references real validate phase nodes", () => {
    const decision = router.regexDecision("Crea un excel con datos de ventas");
    const { plan } = planner.buildAndValidate(decision);
    expect(plan.release_gate.requires.length).toBeGreaterThanOrEqual(1);
    for (const req of plan.release_gate.requires) {
      expect(plan.nodes.some(n => n.id === req)).toBe(true);
    }
  });
});

// ── End-to-end integration ──────────────────────────────────────────

describe("end-to-end / router → planner", () => {
  test("a thesis prompt produces a graph that matches the desired JSON shape", async () => {
    const decision = await router.classifyIntent({
      prompt: "Necesito una tesis APA 7 sobre depresión con citas reales y DOI",
    });
    const { plan } = planner.buildAndValidate(decision);
    expect(decision.intent_primary).toBe("complex_academic_document_generation");
    expect(decision.confidence).toBeGreaterThan(0.7);
    expect(plan.intent_primary).toBe("complex_academic_document_generation");
    expect(plan.final_output).toBe("word_document");
    // Graph must have a deterministic 1st node
    expect(plan.nodes[0].id).toBe("intent.compile");
    // Telemetry must be terminal
    expect(plan.nodes[plan.nodes.length - 1].id).toBe("telemetry.emit");
  });

  test("end-to-end small_talk path is minimal", async () => {
    const decision = await router.classifyIntent({ prompt: "Hola, gracias!" });
    const { plan } = planner.buildAndValidate(decision);
    expect(decision.intent_primary).toBe("small_talk");
    expect(plan.nodes.length).toBe(1);
    expect(plan.nodes[0].id).toBe("intent.compile");
  });
});
