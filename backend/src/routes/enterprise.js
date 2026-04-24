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
