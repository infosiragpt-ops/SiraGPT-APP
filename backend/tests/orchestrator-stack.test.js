/**
 * orchestrator-stack — deterministic tests for the four new layers
 * of the AI Product OS:
 *   - model-router
 *   - skill-system
 *   - memory-layer
 *   - browser-agent
 *   - end-to-end orchestrator
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const modelRouter = require("../src/services/ai-product-os/model-router");
const skillSystem = require("../src/services/ai-product-os/skill-system");
const memoryLayer = require("../src/services/ai-product-os/memory-layer");
const browser = require("../src/services/ai-product-os/browser-agent");
const orchestrator = require("../src/services/ai-product-os/orchestrator");
const intentRouter = require("../src/services/ai-product-os/semantic-intent-router");

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

// ── Model Router ────────────────────────────────────────────────────

describe("model-router", () => {
  test("integrity is clean", () => {
    const r = modelRouter.integrity();
    expect(r.ok).toBe(true);
    expect(r.total).toBeGreaterThanOrEqual(5);
  });

  test("high-complexity reasoning task picks a top reasoning model", () => {
    const r = modelRouter.select({
      task: "academic_document_generation",
      complexity: "high", requires_reasoning: true, requires_tools: true,
      max_cost: "high", latency: "normal",
    });
    expect(r.model).toBeTruthy();
    // Top-tier reasoning models — any of these is acceptable.
    expect(["gpt-5", "claude-opus-4.7", "gemini-2.5-pro"].includes(r.model.id)).toBe(true);
  });

  test("low-budget fast task prefers a cheap fast model", () => {
    const r = modelRouter.select({
      task: "small_talk", complexity: "low", requires_reasoning: false,
      max_cost: "low", latency: "fast",
    });
    expect(r.model).toBeTruthy();
    // The catalog may include any of these cheap-and-fast models.
    expect(["claude-haiku-4.5", "gpt-5-mini", "gpt-4o", "gemini-2.5-flash", "deepseek-v4-flash", "deepseek-v4-pro", "moonshotai/kimi-k2.6"].includes(r.model.id)).toBe(true);
  });

  test("FREE plan filters out PRO-only models", () => {
    const list = modelRouter.listModels({ plan: "FREE" });
    expect(list.every(m => m.plans.includes("FREE"))).toBe(true);
    // Top-tier reasoning models are PRO+ only.
    expect(list.some(m => m.id === "gpt-5" && !m.plans.includes("FREE"))).toBe(false);
  });

  test("user prefer is respected when eligible", () => {
    // Pick a model that IS guaranteed to be in the catalog.
    const eligibleId = modelRouter.listModels()[0]?.id;
    expect(eligibleId).toBeTruthy();
    const r = modelRouter.select({
      complexity: "medium", requires_tools: true,
      max_cost: "high", prefer: eligibleId,
    });
    expect(r.model.id).toBe(eligibleId);
  });

  test("vision requirement boosts vision-capable models", () => {
    const r = modelRouter.select({
      complexity: "medium", requires_vision: true,
      max_cost: "medium",
    });
    // gpt-4o, gemini-2.5-pro / flash and claude-haiku all have vision
    expect(["gpt-4o", "gemini-2.5-flash", "gemini-2.5-pro", "claude-haiku-4.5", "gpt-5-mini"].includes(r.model.id)).toBe(true);
  });

  test("reqFromDecision derives sensible request shape", () => {
    const decision = intentRouter.regexDecision("Genera una tesis APA 7 con citas reales");
    const req = modelRouter.reqFromDecision(decision, { user_plan: "PRO", language: "es" });
    expect(req.requires_reasoning).toBe(true);
    expect(req.requires_tools).toBe(true);
    expect(req.complexity).toBe("high");
    expect(req.user_plan).toBe("PRO");
  });
});

// ── Skill System ────────────────────────────────────────────────────

describe("skill-system", () => {
  test("integrity passes — every skill references real tools and agents", () => {
    const r = skillSystem.integrity();
    expect(r.ok).toBe(true);
    expect(r.total).toBeGreaterThanOrEqual(10);
  });

  test("FREE plan exposes only FREE-tier skills", () => {
    const free = skillSystem.listSkills({ minPlan: "FREE" });
    expect(free.every(s => s.min_plan === "FREE")).toBe(true);
    const enterprise = skillSystem.listSkills({ minPlan: "ENTERPRISE" });
    expect(enterprise.length).toBeGreaterThan(free.length);
  });

  test("resolveSkillForIntent picks academic_report for thesis prompt", () => {
    const decision = intentRouter.regexDecision("Necesito una tesis APA 7 con citas reales y DOI");
    const skill = skillSystem.resolveSkillForIntent(decision, { userPlan: "PRO" });
    expect(skill).toBeTruthy();
    expect(skill.id).toBe("academic_report");
  });

  test("resolveSkillForIntent honours plan ceiling", () => {
    const decision = intentRouter.regexDecision("Construye una landing en Next.js para mi portfolio");
    const skill = skillSystem.resolveSkillForIntent(decision, { userPlan: "FREE" });
    // app_builder is PRO+, so FREE plan must NOT pick it
    expect(skill === null || skill.id !== "app_builder").toBe(true);
  });

  test("mergeDecisionWithSkill unions agents and tools", () => {
    const decision = intentRouter.regexDecision("Genera un excel con datos de ventas");
    const skill = skillSystem.resolveSkillForIntent(decision, { userPlan: "FREE" });
    const merged = skillSystem.mergeDecisionWithSkill(decision, skill);
    expect(merged.skill_id).toBe("excel_dashboard");
    expect(merged.required_tools.includes("create_document")).toBe(true);
    expect(merged.required_agents.includes("bi-analyst")).toBe(true);
    expect(merged.quality_rules.includes("include_raw_data_sheet")).toBe(true);
  });

  test("getSkill returns deep-cloned record", () => {
    const a = skillSystem.getSkill("academic_report");
    a.required_tools.push("polluted");
    expect(skillSystem.getSkill("academic_report").required_tools.includes("polluted")).toBe(false);
  });
});

// ── Memory Layer ────────────────────────────────────────────────────

describe("memory-layer", () => {
  test("short-term: pushTurn + recentTurns rolls correctly", async () => {
    const m = memoryLayer.createMemory({ shortTermWindow: 3 });
    for (let i = 0; i < 6; i++) {
      await m.pushTurn("user-1", { role: "user", content: `t${i}` });
    }
    const recent = await m.recentTurns("user-1", 3);
    expect(recent.length).toBe(3);
    expect(recent[0].content).toBe("t3");
    expect(recent[2].content).toBe("t5");
  });

  test("long-term: rememberFact + recallFact + forget", async () => {
    const m = memoryLayer.createMemory();
    await m.rememberFact("u", "preferred_locale", "es");
    expect(await m.recallFact("u", "preferred_locale")).toBe("es");
    await m.forgetFact("u", "preferred_locale");
    expect(await m.recallFact("u", "preferred_locale")).toBe(undefined);
  });

  test("file memory: rememberFile + listUserFiles", async () => {
    const m = memoryLayer.createMemory();
    await m.rememberFile({ userId: "u", id: "f1", name: "a.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 1234, extractedText: "hola" });
    const list = await m.listUserFiles("u");
    expect(list.length).toBe(1);
    expect(list[0].name).toBe("a.docx");
  });

  test("semantic search falls back to token overlap when no embeddings", async () => {
    const m = memoryLayer.createMemory();
    await m.indexSnippet({ collection: "kb", id: "s1", text: "OpenAI fue fundada en 2015 por Sam Altman" });
    await m.indexSnippet({ collection: "kb", id: "s2", text: "Anthropic lanzó Claude en 2023 enfocada en seguridad" });
    const r = await m.searchSemantic({ collection: "kb", query: "fundada OpenAI", topK: 2 });
    expect(r.length).toBe(2);
    expect(r[0].id).toBe("s1");
    expect(r[0].score).toBeGreaterThan(0);
  });

  test("semantic search uses cosine when embeddings provided", async () => {
    const m = memoryLayer.createMemory();
    await m.indexSnippet({ collection: "kb", id: "a", text: "hola", embedding: [1, 0, 0] });
    await m.indexSnippet({ collection: "kb", id: "b", text: "mundo", embedding: [0, 1, 0] });
    const r = await m.searchSemantic({ collection: "kb", query: "x", queryEmbedding: [1, 0, 0], topK: 2 });
    expect(r[0].id).toBe("a");
    expect(r[0].score).toBeGreaterThan(0.9);
  });

  test("knowledge graph stores entities + relations", async () => {
    const m = memoryLayer.createMemory();
    await m.addEntity("u", { id: "openai", kind: "company", label: "OpenAI" });
    await m.addEntity("u", { id: "altman", kind: "person", label: "Sam Altman" });
    await m.addRelation("u", { from: "altman", to: "openai", kind: "founded" });
    const g = await m.userGraph("u");
    expect(g.nodes.length).toBe(2);
    expect(g.edges.length).toBe(1);
    expect(g.edges[0].kind).toBe("founded");
  });

  test("buildContextForTurn blends short-term, long-term and semantic", async () => {
    const m = memoryLayer.createMemory();
    await m.pushTurn("u", { role: "user", content: "hello" });
    await m.rememberFact("u", "name", "Luis");
    await m.indexSnippet({ collection: "kb", id: "s", text: "Datos del proyecto" });
    const ctx = await m.buildContextForTurn({ userId: "u", query: "datos" });
    expect(ctx.short_term.length).toBe(1);
    expect(ctx.long_term[0].key).toBe("name");
    expect(ctx.semantic.length).toBe(1);
  });

  test("rememberFact rejects missing args", async () => {
    const m = memoryLayer.createMemory();
    await assert.rejects(m.rememberFact(null, "k", "v"), /userId/);
  });
});

// ── Browser Agent ────────────────────────────────────────────────────

describe("browser-agent", () => {
  test("rejects driver without run()", () => {
    assert.throws(() => browser.createBrowserAgent({ driver: {} }), /driver/);
  });

  test("dispatches navigate and records the trail", async () => {
    const trail = [];
    const driver = {
      run: async (action, args) => {
        trail.push({ action, args });
        if (action === "navigate") return { url: args.url, status: 200 };
        return null;
      },
      screenshot: async () => ({ id: "shot_1" }),
    };
    const agent = browser.createBrowserAgent({ driver });
    const r = await agent.run("navigate", { url: "https://example.com" });
    expect(r.record.ok).toBe(true);
    expect(r.record.screenshot_id).toBe("shot_1");
    expect(trail[0].action).toBe("navigate");
  });

  test("rejects unknown action", async () => {
    const agent = browser.createBrowserAgent({ driver: { run: async () => null } });
    await assert.rejects(agent.run("teleport", {}), /unknown/);
  });

  test("rejects deny-listed domain", async () => {
    const agent = browser.createBrowserAgent({ driver: { run: async () => null } });
    await assert.rejects(agent.run("navigate", { url: "https://accounts.google.com/" }), /deny list/);
  });

  test("rejects forbidden patterns in text", async () => {
    const agent = browser.createBrowserAgent({ driver: { run: async () => null } });
    await assert.rejects(agent.run("type", { selector: "#x", text: "captcha-token-here" }), /forbidden/);
  });

  test("max_steps budget is enforced", async () => {
    const agent = browser.createBrowserAgent({
      driver: { run: async () => null, screenshot: async () => null },
      policy: { ...browser.DEFAULT_POLICY, max_steps: 2, require_screenshot_on: [] },
    });
    await agent.run("scroll", {});
    await agent.run("scroll", {});
    await assert.rejects(agent.run("scroll", {}), /step budget|exhausted/);
  });

  test("exportEvidence emits structured trail", async () => {
    const agent = browser.createBrowserAgent({
      driver: { run: async () => ({ url: "x" }) },
      policy: { ...browser.DEFAULT_POLICY, require_screenshot_on: [] },
    });
    await agent.run("scroll", {});
    const evidence = agent.exportEvidence();
    expect(evidence.step_count).toBe(1);
    expect(evidence.trail.length).toBe(1);
  });
});

// ── Orchestrator end-to-end ─────────────────────────────────────────

describe("orchestrator", () => {
  test("runs a thesis prompt through every layer", async () => {
    const result = await orchestrator.runUserRequest({
      prompt: "Necesito una tesis APA 7 con citas reales y DOI",
      userId: "u-1", userPlan: "PRO",
    });
    expect(result.decision.intent_primary).toBe("complex_academic_document_generation");
    expect(result.skill.id).toBe("academic_report");
    expect(result.model.model).toBeTruthy();
    expect(result.plan.nodes.length).toBeGreaterThan(5);
    expect(result.plan_validation.ok).toBe(true);
    expect(result.constitution_pre.ok).toBe(true);
    expect(result.execution.status).toBe("completed");
    expect(orchestrator.summarize(result)).toMatch(/skill=academic_report/);
  });

  test("simple text question keeps a minimal plan", async () => {
    const result = await orchestrator.runUserRequest({
      prompt: "¿Cuál es la primera palabra del word?",
      context: { has_attachments: true, attachment_kinds: ["docx"] },
      userId: "u-2", userPlan: "FREE",
    });
    expect(result.decision.intent_primary).toBe("text_answer");
    expect(result.plan.nodes.length).toBe(1);
    expect(result.constitution_pre.ok).toBe(true);
  });

  test("excel generation resolves to excel_dashboard skill", async () => {
    const result = await orchestrator.runUserRequest({
      prompt: "Crea un excel con un dashboard de ventas",
      userId: "u-3", userPlan: "FREE",
    });
    expect(result.skill.id).toBe("excel_dashboard");
    expect(result.decision.required_tools.includes("create_document")).toBe(true);
  });

  test("scraping prompt resolves to scraping_compliant only on PRO", async () => {
    const free = await orchestrator.runUserRequest({
      prompt: "Scrapea precios públicos respetando robots.txt",
      userId: "u-4", userPlan: "FREE",
    });
    expect(free.skill === null || free.skill.id !== "scraping_compliant").toBe(true);

    const pro = await orchestrator.runUserRequest({
      prompt: "Scrapea precios públicos respetando robots.txt",
      userId: "u-5", userPlan: "PRO",
    });
    expect(pro.skill.id).toBe("scraping_compliant");
  });

  test("missing prompt throws", async () => {
    await assert.rejects(orchestrator.runUserRequest({ prompt: "" }), /prompt/);
  });

  test("memory persists user turn", async () => {
    const m = memoryLayer.createMemory();
    await orchestrator.runUserRequest({
      prompt: "hola, ¿cómo estás?", userId: "u-6", userPlan: "FREE", memory: m,
    });
    const recent = await m.recentTurns("u-6", 5);
    expect(recent.length).toBe(1);
    expect(recent[0].content).toBe("hola, ¿cómo estás?");
  });
});
