/**
 * enterprise — REST surface that makes the cognitive-agentic
 * infrastructure queryable / callable from the frontend and
 * external observers.
 *
 * Endpoints (all under /api/enterprise):
 *   GET  /components                   → component registry snapshot
 *   GET  /components/:id               → one component
 *   GET  /asvs                         → OWASP ASVS catalogue
 *   POST /asvs/evaluate                → run evaluator over a context
 *   GET  /tool-manifests               → list tool manifests
 *   POST /scraper-policy/review        → evaluate a scraper config
 *   POST /sql-safety/analyze           → analyse a SQL string
 *   POST /task-contract/validate       → validate a TaskContract
 *   POST /qa-board/review              → run the full QA Board
 *   GET  /spans/demo                   → emit a sample span chain (debug)
 *
 * None of these are destructive; every endpoint is authenticated
 * via the standard middleware so we don't leak registry / manifest
 * internals to anonymous callers.
 */

const express = require("express");
const { body, param, validationResult } = require("express-validator");

const { listComponents, getComponent, countByStatus } = require("../services/agents/component-registry");
const { listControls, evaluateAsvs } = require("../services/security/owasp-asvs");
const { listManifests } = require("../services/agents/tool-manifest");
const { reviewScraperPolicy } = require("../services/web/scraper-policy");
const { analyzeSql } = require("../services/db/sql-safety");
const { generateSbom } = require("../services/software-engineering/sbom");
const { auditSbom } = require("../services/software-engineering/dependency-audit");
const { reviewCode } = require("../services/software-engineering/code-review");
const { analyzeDocument } = require("../services/docintel/pdf-structure");
const { groundClaims } = require("../services/docintel/citation-grounding");
const { detectContradictions } = require("../services/docintel/contradiction-detector");
const { validateSeo } = require("../services/software-engineering/seo-validator");
const { checkWcag, contrastRatio } = require("../services/software-engineering/wcag-checker");
const { analyzeBudget } = require("../services/software-engineering/cwv-budget");
const productOs = require("../services/ai-product-os/product-os");
const { listLaws, enforceConstitution } = require("../services/ai-product-os/constitution");
const { listAgents: listProductOsAgents, computeHandoffGraph } = require("../services/ai-product-os/agentic-kernel");
const intentRouter = require("../services/ai-product-os/semantic-intent-router");
const toolRegistry = require("../services/ai-product-os/tool-registry");
const planner = require("../services/ai-product-os/planner-agent");
const modelRouter = require("../services/ai-product-os/model-router");
const skillSystem = require("../services/ai-product-os/skill-system");
const memoryLayer = require("../services/ai-product-os/memory-layer");
const orchestrator = require("../services/ai-product-os/orchestrator");

// Single in-memory facade for the local memory tier. Production binds
// a Qdrant / pgvector adapter via createMemory({ adapter }).
const sharedMemory = memoryLayer.createMemory();
const { validateContract } = require("../services/agents/task-contract-resolver");
const { runQaBoard } = require("../services/agents/qa-board");
const { createTracer } = require("../services/observability/spans");
const { authenticateToken } = require("../middleware/auth");

const router = express.Router();

function ok(res, payload) {
  res.json({ ok: true, ...payload });
}

function fail(res, status, error) {
  res.status(status).json({ ok: false, error });
}

// ─── Component registry ────────────────────────────────────────────────

router.get("/components", authenticateToken, (_req, res) => {
  ok(res, { counts: countByStatus(), components: listComponents() });
});

router.get(
  "/components/:id",
  authenticateToken,
  [param("id").isString().isLength({ min: 2, max: 80 })],
  (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return fail(res, 400, errs.array());
    const c = getComponent(req.params.id);
    if (!c) return fail(res, 404, `component "${req.params.id}" not found`);
    ok(res, { component: c });
  }
);

// ─── OWASP ASVS ────────────────────────────────────────────────────────

router.get("/asvs", authenticateToken, (_req, res) => {
  ok(res, { controls: listControls() });
});

router.post(
  "/asvs/evaluate",
  authenticateToken,
  [
    body("context").optional().isObject(),
    body("onlyControls").optional().isArray(),
    body("skipControls").optional().isArray(),
  ],
  (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return fail(res, 400, errs.array());
    const r = evaluateAsvs({
      context: req.body.context || {},
      onlyControls: req.body.onlyControls,
      skipControls: req.body.skipControls,
    });
    ok(res, r);
  }
);

// ─── Tool manifests ────────────────────────────────────────────────────

router.get("/tool-manifests", authenticateToken, (_req, res) => {
  ok(res, { manifests: listManifests() });
});

// ─── Scraper policy review ─────────────────────────────────────────────

router.post(
  "/scraper-policy/review",
  authenticateToken,
  [body("config").isObject().withMessage("config (object) required")],
  (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return fail(res, 400, errs.array());
    const r = reviewScraperPolicy(req.body.config);
    ok(res, r);
  }
);

// ─── SQL safety analyse ────────────────────────────────────────────────

router.post(
  "/sql-safety/analyze",
  authenticateToken,
  [
    body("sql").isString().isLength({ min: 1, max: 20000 }),
    body("allowWrites").optional().isBoolean(),
    body("allowDDL").optional().isBoolean(),
    body("allowMultiStatement").optional().isBoolean(),
  ],
  (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return fail(res, 400, errs.array());
    const r = analyzeSql(req.body.sql, {
      allowWrites: Boolean(req.body.allowWrites),
      allowDDL: Boolean(req.body.allowDDL),
      allowMultiStatement: Boolean(req.body.allowMultiStatement),
    });
    ok(res, r);
  }
);

// ─── TaskContract validate ─────────────────────────────────────────────

router.post(
  "/task-contract/validate",
  authenticateToken,
  [body("contract").isObject().withMessage("contract (object) required")],
  (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return fail(res, 400, errs.array());
    const r = validateContract(req.body.contract);
    ok(res, r);
  }
);

// ─── QA Board review ───────────────────────────────────────────────────

router.post(
  "/qa-board/review",
  authenticateToken,
  [
    body("contract").optional().isObject(),
    body("deliverable").optional(),
    body("sources").optional().isArray(),
    body("asvsContext").optional().isObject(),
    body("code").optional().isString(),
    body("language").optional().isString(),
    body("designSpec").optional().isObject(),
    body("budgets").optional().isObject(),
    body("onlyCritics").optional().isArray(),
  ],
  async (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return fail(res, 400, errs.array());
    try {
      const r = await runQaBoard(
        {
          contract: req.body.contract,
          deliverable: req.body.deliverable,
          sources: req.body.sources,
          asvsContext: req.body.asvsContext,
          code: req.body.code,
          language: req.body.language,
          designSpec: req.body.designSpec,
          budgets: req.body.budgets,
        },
        { onlyCritics: req.body.onlyCritics }
      );
      ok(res, r);
    } catch (err) {
      fail(res, 500, err.message || "qa-board review failed");
    }
  }
);

// ─── Software Engineering Pipeline ─────────────────────────────────────

router.post(
  "/sbom/generate",
  authenticateToken,
  [
    body("packageJson").optional().isString(),
    body("packageLock").optional().isString(),
    body("requirementsTxt").optional().isString(),
    body("pyprojectToml").optional().isString(),
    body("projectMeta").optional().isObject(),
  ],
  (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return fail(res, 400, errs.array());
    try {
      const r = generateSbom({
        packageJson: req.body.packageJson,
        packageLock: req.body.packageLock,
        requirementsTxt: req.body.requirementsTxt,
        pyprojectToml: req.body.pyprojectToml,
        projectMeta: req.body.projectMeta,
      });
      ok(res, r);
    } catch (err) {
      fail(res, 500, err.message || "sbom generation failed");
    }
  }
);

router.post(
  "/dependencies/audit",
  authenticateToken,
  [
    body("sbom").isObject().withMessage("sbom (object) required"),
    body("licenseMap").optional().isObject(),
    body("options").optional().isObject(),
  ],
  (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return fail(res, 400, errs.array());
    try {
      const r = auditSbom({ sbom: req.body.sbom, licenseMap: req.body.licenseMap, options: req.body.options });
      ok(res, r);
    } catch (err) {
      fail(res, 500, err.message || "audit failed");
    }
  }
);

router.post(
  "/code-review/analyze",
  authenticateToken,
  [
    body("source").isString().isLength({ min: 1, max: 500000 }),
    body("language").optional().isString().isLength({ min: 1, max: 40 }),
    body("filename").optional().isString().isLength({ min: 1, max: 200 }),
    body("thresholds").optional().isObject(),
  ],
  (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return fail(res, 400, errs.array());
    try {
      const r = reviewCode({
        source: req.body.source,
        language: req.body.language,
        filename: req.body.filename,
        thresholds: req.body.thresholds,
      });
      ok(res, r);
    } catch (err) {
      fail(res, 500, err.message || "code review failed");
    }
  }
);

// ─── Document Intelligence ─────────────────────────────────────────────

router.post(
  "/docintel/analyze",
  authenticateToken,
  [
    body("text").optional().isString().isLength({ min: 1, max: 1_000_000 }),
    body("pages").optional().isArray(),
    body("keepBullets").optional().isBoolean(),
  ],
  (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return fail(res, 400, errs.array());
    try {
      const input = req.body.pages || req.body.text || "";
      const r = analyzeDocument(input, { keepBullets: req.body.keepBullets !== false });
      ok(res, r);
    } catch (err) {
      fail(res, 500, err.message || "docintel analyze failed");
    }
  }
);

router.post(
  "/docintel/ground",
  authenticateToken,
  [
    body("answer").isString().isLength({ min: 1, max: 200_000 }),
    body("sources").isArray({ min: 1 }),
    body("thresholds").optional().isObject(),
  ],
  (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return fail(res, 400, errs.array());
    try {
      const r = groundClaims({
        answer: req.body.answer,
        sources: req.body.sources,
        thresholds: req.body.thresholds,
      });
      ok(res, r);
    } catch (err) {
      fail(res, 500, err.message || "docintel ground failed");
    }
  }
);

router.post(
  "/docintel/contradictions",
  authenticateToken,
  [
    body("claims").isArray({ min: 0 }),
    body("numeric_tolerance").optional().isFloat({ min: 0, max: 10 }),
  ],
  (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return fail(res, 400, errs.array());
    try {
      const r = detectContradictions(req.body.claims, {
        numeric_tolerance: req.body.numeric_tolerance,
      });
      ok(res, r);
    } catch (err) {
      fail(res, 500, err.message || "docintel contradictions failed");
    }
  }
);

// ─── Web Builder validators (SEO / WCAG / CWV) ─────────────────────────

router.post(
  "/web-builder/seo/validate",
  authenticateToken,
  [
    body("html").isString().isLength({ min: 1, max: 2_000_000 }),
    body("options").optional().isObject(),
  ],
  (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return fail(res, 400, errs.array());
    try {
      ok(res, validateSeo({ html: req.body.html, options: req.body.options }));
    } catch (err) {
      fail(res, 500, err.message || "seo validate failed");
    }
  }
);

router.post(
  "/web-builder/wcag/check",
  authenticateToken,
  [body("html").isString().isLength({ min: 1, max: 2_000_000 })],
  (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return fail(res, 400, errs.array());
    try {
      ok(res, checkWcag({ html: req.body.html }));
    } catch (err) {
      fail(res, 500, err.message || "wcag check failed");
    }
  }
);

router.post(
  "/web-builder/wcag/contrast",
  authenticateToken,
  [
    body("fg").isString().isLength({ min: 2, max: 40 }),
    body("bg").isString().isLength({ min: 2, max: 40 }),
  ],
  (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return fail(res, 400, errs.array());
    ok(res, contrastRatio(req.body.fg, req.body.bg));
  }
);

router.post(
  "/web-builder/cwv/analyze",
  authenticateToken,
  [
    body("html").isString().isLength({ min: 1, max: 2_000_000 }),
    body("siteOrigin").optional().isString().isLength({ min: 1, max: 200 }),
    body("assetSizes").optional().isObject(),
    body("budgets").optional().isObject(),
  ],
  (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return fail(res, 400, errs.array());
    try {
      ok(res, analyzeBudget({
        html: req.body.html,
        siteOrigin: req.body.siteOrigin,
        assetSizes: req.body.assetSizes,
        budgets: req.body.budgets,
      }));
    } catch (err) {
      fail(res, 500, err.message || "cwv analyze failed");
    }
  }
);

// ─── AI Product Operating System (runtime kernel) ──────────────────────

router.get("/product-os/status", authenticateToken, (_req, res) => {
  ok(res, productOs.status());
});

router.get("/product-os/laws", authenticateToken, (_req, res) => {
  ok(res, { laws: listLaws() });
});

router.get("/product-os/agents", authenticateToken, (_req, res) => {
  ok(res, { agents: listProductOsAgents(), handoff_graph: computeHandoffGraph() });
});

router.post(
  "/product-os/constitution/enforce",
  authenticateToken,
  [body("ctx").optional().isObject()],
  (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return fail(res, 400, errs.array());
    ok(res, enforceConstitution(req.body.ctx || {}));
  }
);

router.post(
  "/product-os/compile",
  authenticateToken,
  [
    body("objective").isString().isLength({ min: 4, max: 4000 }),
    body("deliverables").optional().isArray(),
    body("constraints").optional().isArray(),
    body("quality_bar").optional().isObject(),
    body("stakeholders").optional().isArray(),
    body("correlation_id").optional().isString(),
  ],
  (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return fail(res, 400, errs.array());
    try {
      ok(res, productOs.compile(req.body));
    } catch (err) {
      fail(res, 500, err.message || "compile failed");
    }
  }
);

router.post(
  "/product-os/execute/dry-run",
  authenticateToken,
  [
    body("contract").isObject().withMessage("contract (object) required"),
    body("graph").isObject().withMessage("graph (object) required"),
  ],
  async (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return fail(res, 400, errs.array());
    try {
      const r = await productOs.execute(
        { contract: req.body.contract, graph: req.body.graph },
        { activityRunner: async ({ activity, node_id }) => ({ activity, node_id, dry_run: true, ts: new Date().toISOString() }) }
      );
      ok(res, r);
    } catch (err) {
      fail(res, 500, err.message || "execute failed");
    }
  }
);

// ─── Semantic Intent Router + Planner ──────────────────────────────────

router.post(
  "/product-os/route",
  authenticateToken,
  [
    body("prompt").isString().isLength({ min: 1, max: 8000 }),
    body("history").optional().isArray(),
    body("context").optional().isObject(),
    body("preferRegex").optional().isBoolean(),
  ],
  async (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return fail(res, 400, errs.array());
    try {
      const decision = await intentRouter.classifyIntent({
        prompt: req.body.prompt,
        history: req.body.history,
        context: req.body.context,
        preferRegex: Boolean(req.body.preferRegex),
        // No LLM client wired here yet — until product binds an
        // OpenAI/Anthropic client, the route runs the deterministic
        // regex tier. Caller can pass `preferRegex: true` to lock that
        // explicitly.
      });
      const skillPlan = skillSystem.buildSkillExecutionPlan(decision, { userPlan: "ENTERPRISE" });
      const enrichedDecision = skillSystem.mergeDecisionWithSkillPlan(decision, skillPlan);
      const modelRequest = {
        ...modelRouter.reqFromDecision(enrichedDecision, {
          max_cost: skillPlan.model_profile.max_cost || "medium",
          latency: skillPlan.model_profile.latency || "normal",
          language: "es",
          user_plan: "ENTERPRISE",
        }),
        complexity: skillPlan.model_profile.complexity || "medium",
        requires_reasoning: Boolean(skillPlan.model_profile.requires_reasoning || enrichedDecision.intent_primary !== "small_talk"),
        requires_tools: Boolean(skillPlan.model_profile.requires_tools || enrichedDecision.required_tools.length > 0),
        requires_long_context: Boolean(skillPlan.model_profile.requires_long_context),
        requires_vision: Boolean(skillPlan.model_profile.requires_vision),
        requires_code: Boolean(skillPlan.model_profile.requires_code),
        requires_structured_outputs: true,
      };
      const modelRouting = modelRouter.select(modelRequest);
      const { plan, validation } = planner.buildAndValidate(enrichedDecision);
      ok(res, { decision: enrichedDecision, skillPlan, modelRouting, plan, validation });
    } catch (err) {
      fail(res, 500, err.message || "intent route failed");
    }
  }
);

router.get("/product-os/tool-registry", authenticateToken, (_req, res) => {
  ok(res, {
    integrity: toolRegistry.integrity(),
    tools: toolRegistry.listTools(),
  });
});

router.get(
  "/product-os/tool-registry/recommended/:intent",
  authenticateToken,
  [require("express-validator").param("intent").isString().isLength({ min: 2, max: 64 })],
  (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return fail(res, 400, errs.array());
    ok(res, { intent: req.params.intent, tools: toolRegistry.recommendedFor(req.params.intent) });
  }
);

router.get("/product-os/intent-schema", authenticateToken, (_req, res) => {
  ok(res, {
    schema: intentRouter.buildClassifierSchema(),
    primary_intents: intentRouter.PRIMARY_INTENTS,
    final_output_by_intent: intentRouter.FINAL_OUTPUT_BY_INTENT,
  });
});

// ─── Model Router (Capa 1) ─────────────────────────────────────────────

router.get("/product-os/models", authenticateToken, (req, res) => {
  const plan = typeof req.query.plan === "string" ? req.query.plan : null;
  ok(res, { integrity: modelRouter.integrity(), models: modelRouter.listModels(plan ? { plan } : {}) });
});

router.post(
  "/product-os/models/select",
  authenticateToken,
  [
    body("task").optional().isString(),
    body("complexity").optional().isString(),
    body("requires_reasoning").optional().isBoolean(),
    body("requires_tools").optional().isBoolean(),
    body("requires_long_context").optional().isBoolean(),
    body("requires_vision").optional().isBoolean(),
    body("requires_code").optional().isBoolean(),
    body("max_cost").optional().isString(),
    body("latency").optional().isString(),
    body("language").optional().isString(),
    body("user_plan").optional().isString(),
    body("prefer").optional().isString(),
  ],
  (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return fail(res, 400, errs.array());
    ok(res, modelRouter.select(req.body || {}));
  }
);

// ─── Skill System ──────────────────────────────────────────────────────

router.get("/product-os/skills", authenticateToken, (req, res) => {
  const minPlan = typeof req.query.plan === "string" ? req.query.plan : null;
  ok(res, { integrity: skillSystem.integrity(), skills: skillSystem.listSkills(minPlan ? { minPlan } : {}) });
});

router.post(
  "/product-os/skills/resolve",
  authenticateToken,
  [
    body("decision").isObject().withMessage("decision (object) required"),
    body("user_plan").optional().isString(),
  ],
  (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return fail(res, 400, errs.array());
    const skill = skillSystem.resolveSkillForIntent(req.body.decision, { userPlan: req.body.user_plan || "FREE" });
    const merged = skillSystem.mergeDecisionWithSkill(req.body.decision, skill);
    ok(res, { skill, merged_decision: merged });
  }
);

// ─── Memory Layer ──────────────────────────────────────────────────────

router.post(
  "/product-os/memory/turn",
  authenticateToken,
  [
    body("userId").isString().isLength({ min: 1, max: 200 }),
    body("role").isString().isIn(["user", "assistant", "system", "tool"]),
    body("content").isString().isLength({ min: 1, max: 50000 }),
  ],
  async (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return fail(res, 400, errs.array());
    try {
      await sharedMemory.pushTurn(req.body.userId, { role: req.body.role, content: req.body.content });
      const recent = await sharedMemory.recentTurns(req.body.userId, 12);
      ok(res, { recent });
    } catch (err) {
      fail(res, 500, err.message || "memory.turn failed");
    }
  }
);

router.post(
  "/product-os/memory/recall",
  authenticateToken,
  [
    body("userId").isString().isLength({ min: 1, max: 200 }),
    body("query").isString().isLength({ min: 1, max: 4000 }),
    body("topK").optional().isInt({ min: 1, max: 20 }),
  ],
  async (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return fail(res, 400, errs.array());
    const ctx = await sharedMemory.buildContextForTurn({
      userId: req.body.userId,
      query: req.body.query,
      topK: req.body.topK || 5,
    });
    ok(res, ctx);
  }
);

// ─── Orchestrator (end-to-end) ─────────────────────────────────────────

router.post(
  "/product-os/orchestrate",
  authenticateToken,
  [
    body("prompt").isString().isLength({ min: 1, max: 8000 }),
    body("history").optional().isArray(),
    body("context").optional().isObject(),
    body("user_plan").optional().isString(),
    body("dryRun").optional().isBoolean(),
  ],
  async (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return fail(res, 400, errs.array());
    try {
      const result = await orchestrator.runUserRequest({
        prompt: req.body.prompt,
        history: req.body.history,
        context: req.body.context,
        userId: req.user?.id || req.user?.userId || null,
        userPlan: req.body.user_plan || req.user?.plan || "FREE",
        memory: sharedMemory,
        dryRun: req.body.dryRun !== false,
      });
      ok(res, { ...result, summary: orchestrator.summarize(result) });
    } catch (err) {
      fail(res, 500, err.message || "orchestrate failed");
    }
  }
);

// ─── Observability demo (for wiring tests / debug) ─────────────────────

router.get("/spans/demo", authenticateToken, async (_req, res) => {
  const captured = [];
  const tracer = createTracer({ serviceName: "siragpt-backend", exporter: s => captured.push(s) });
  const root = tracer.startSpan({ name: "enterprise.spans.demo", kind: "internal", attributes: { demo: true } });
  root.addEvent("started");
  const child = tracer.startSpan({ name: "enterprise.spans.child", parent: root, attributes: { step: 1 } });
  child.setAttribute("pretend.cost.usd", 0.001);
  child.end({ status: "ok" });
  root.end({ status: "ok" });
  ok(res, { spansEmitted: captured.length, sample: captured });
});

module.exports = router;
