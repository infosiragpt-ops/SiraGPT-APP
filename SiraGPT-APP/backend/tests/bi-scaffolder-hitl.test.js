/**
 * bi-scaffolder-hitl regression — deterministic tests for the BI
 * semantic model, project scaffolder, and HITL approval queue. No
 * network, no fs writes, no LLM.
 */

const { strict: assert } = require("assert");

const {
  validateSemanticModel,
  buildStarSchema,
  compileMeasure,
  compileMeasures,
  deriveKpiCards,
  compileSemanticModel,
} = require("../src/services/bi/semantic-model");

const { scaffoldProject, listStacks } = require("../src/services/software-engineering/project-scaffolder");
const { createApprovalQueue } = require("../src/services/hitl/approval-queue");
const { getComponent, assertRegistryIntegrity } = require("../src/services/agents/component-registry");

// A well-formed sample model reused across BI tests
function sampleModel() {
  return {
    facts: [{
      name: "sales",
      grain: "per-order-line",
      columns: [
        { name: "order_id", type: "int" },
        { name: "product_id", type: "int" },
        { name: "customer_id", type: "int" },
        { name: "date_id", type: "date" },
        { name: "amount", type: "numeric" },
        { name: "quantity", type: "int" },
      ],
      relationships: [
        { fact_column: "product_id",  dimension: "product",  dimension_column: "id" },
        { fact_column: "customer_id", dimension: "customer", dimension_column: "id" },
        { fact_column: "date_id",     dimension: "date",     dimension_column: "id" },
      ],
    }],
    dimensions: [
      { name: "product",  columns: [{ name: "id" }, { name: "name" }, { name: "category" }] },
      { name: "customer", columns: [{ name: "id" }, { name: "name" }, { name: "country" }] },
      { name: "date",     columns: [{ name: "id" }, { name: "year" }, { name: "month" }] },
    ],
    measures: [
      { name: "revenue", agg: "sum", columns: ["sales.amount"], format: "$0,0.00", kpi: true, target: 1000000 },
      { name: "orders", agg: "count_distinct", columns: ["sales.order_id"], kpi: true },
      { name: "avg_order_value", agg: "ratio", numerator: "revenue", denominator: "orders", format: "$0,0.00" },
    ],
  };
}

const cases = [
  // ── BI semantic-model ─────────────────────────────────────────────
  () => {
    const v = validateSemanticModel(sampleModel());
    assert.equal(v.ok, true, `expected valid, errors: ${JSON.stringify(v.errors)}`);
    assert.equal(v.relationships.length, 3);
  },

  () => {
    // Missing FK column on the fact is a hard error
    const spec = sampleModel();
    spec.facts[0].columns = spec.facts[0].columns.filter(c => c.name !== "product_id");
    const v = validateSemanticModel(spec);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some(e => e.code === "relationship_missing_fact_col"));
  },

  () => {
    // Unknown dimension referenced in relationship
    const spec = sampleModel();
    spec.facts[0].relationships.push({ fact_column: "order_id", dimension: "ghost", dimension_column: "id" });
    const v = validateSemanticModel(spec);
    assert.ok(v.errors.some(e => e.code === "relationship_missing_dimension"));
  },

  () => {
    // Orphan dimension is a warning, not an error
    const spec = sampleModel();
    spec.dimensions.push({ name: "unused", columns: [{ name: "id" }] });
    const v = validateSemanticModel(spec);
    assert.equal(v.ok, true, "orphan dim is a warning");
    assert.ok(v.warnings.some(w => w.code === "orphan_dimension"));
  },

  () => {
    // Dimension cycle is an error
    const spec = sampleModel();
    spec.dimensions[0].relationships = [{ dimension: "customer" }];
    spec.dimensions[1].relationships = [{ dimension: "product" }];
    const v = validateSemanticModel(spec);
    assert.ok(v.errors.some(e => e.code === "dimension_cycle"));
  },

  () => {
    // buildStarSchema forwards columns + foreign_keys
    const r = buildStarSchema(sampleModel());
    assert.equal(r.ok, true);
    assert.equal(r.schema.facts[0].foreign_keys.length, 3);
    assert.equal(r.schema.dimensions.length, 3);
  },

  () => {
    // compileMeasure produces a DAX-like expression
    const m = compileMeasure({ name: "revenue", agg: "sum", columns: ["sales.amount"], format: "$0,0.00" });
    assert.equal(m.expression, "SUM(sales.amount)");
    assert.equal(m.format, "$0,0.00");
  },

  () => {
    // Ratio measure compiles to DIVIDE(a,b)
    const m = compileMeasure({ name: "aov", agg: "ratio", numerator: "revenue", denominator: "orders" });
    assert.equal(m.expression, "DIVIDE(revenue, orders)");
  },

  () => {
    // Custom measure needs expression
    const spec = sampleModel();
    spec.measures.push({ name: "bad_custom", agg: "custom" });
    const v = validateSemanticModel(spec);
    assert.ok(v.errors.some(e => e.code === "measure_custom_no_expr"));
  },

  () => {
    // Unknown agg is rejected
    const spec = sampleModel();
    spec.measures.push({ name: "weird", agg: "teleport" });
    const v = validateSemanticModel(spec);
    assert.ok(v.errors.some(e => e.code === "measure_unknown_agg"));
  },

  () => {
    // Measure referencing a non-existent column is rejected
    const spec = sampleModel();
    spec.measures.push({ name: "ghost", agg: "sum", columns: ["sales.doesnt_exist"] });
    const v = validateSemanticModel(spec);
    assert.ok(v.errors.some(e => e.code === "measure_column_missing"));
  },

  () => {
    // KPI cards derived only from measures with kpi:true
    const kpis = deriveKpiCards(sampleModel());
    assert.equal(kpis.length, 2);
    assert.equal(kpis[0].id, "revenue");
    assert.equal(kpis[0].target, 1000000);
  },

  () => {
    // compileSemanticModel end-to-end
    const r = compileSemanticModel(sampleModel());
    assert.equal(r.ok, true);
    assert.ok(r.schema && r.measures.length >= 2 && r.kpis.length >= 1);
  },

  // ── Project Scaffolder ────────────────────────────────────────────
  () => {
    const r = scaffoldProject({ stack: "nextjs", projectName: "acme-site" });
    assert.equal(r.ok, true);
    const paths = r.files.map(f => f.path);
    assert.ok(paths.includes("package.json"));
    assert.ok(paths.includes("app/page.tsx"));
    assert.ok(paths.includes("app/api/health/route.ts"));
    assert.ok(paths.includes("playwright.config.ts"));
    assert.ok(paths.includes(".github/workflows/ci.yml"));
    assert.ok(paths.includes("Dockerfile"));
    const home = r.files.find(f => f.path === "app/page.tsx");
    assert.ok(home.content.includes("acme-site"), "project name should be substituted");
  },

  () => {
    const r = scaffoldProject({ stack: "fastapi", projectName: "BackOffice API" });
    assert.equal(r.ok, true);
    const paths = r.files.map(f => f.path);
    assert.ok(paths.includes("pyproject.toml"));
    assert.ok(paths.includes("app/main.py"));
    assert.ok(paths.includes("tests/test_health.py"));
    assert.ok(paths.includes("alembic.ini"));
    assert.equal(r.rootName, "BackOffice-API");
  },

  () => {
    // Unknown stack rejected
    const r = scaffoldProject({ stack: "cobol", projectName: "x" });
    assert.equal(r.ok, false);
    assert.ok(r.error.includes("Unknown stack"));
  },

  () => {
    const stacks = listStacks();
    assert.ok(stacks.some(s => s.id === "nextjs"));
    assert.ok(stacks.some(s => s.id === "fastapi"));
  },

  () => {
    // Commands include the expected trio per stack
    const nx = scaffoldProject({ stack: "nextjs", projectName: "p" });
    assert.ok(nx.commands.dev && nx.commands.build && nx.commands.test);
    const fa = scaffoldProject({ stack: "fastapi", projectName: "p" });
    assert.ok(fa.commands.dev && fa.commands.test);
  },

  () => {
    // Acceptance_tests describe the quality gate
    const r = scaffoldProject({ stack: "nextjs", projectName: "p" });
    assert.ok(r.acceptance_tests.some(t => t.includes("pnpm install")));
    assert.ok(r.acceptance_tests.some(t => t.toLowerCase().includes("playwright")));
  },

  // ── HITL approval queue ───────────────────────────────────────────
  () => {
    const q = createApprovalQueue();
    const req = q.enqueue({
      action: "send email",
      requested_by: "agent-42",
      approvers_allowed: ["user-1"],
      side_effect_level: "remote-write",
      payload: { to: "x@y.com", subject: "hi" },
      timeout_ms: 60000,
    });
    assert.equal(req.state, "pending");
    assert.equal(req.approvers_allowed[0], "user-1");
    assert.equal(q.stats().counts.pending, 1);
  },

  () => {
    const q = createApprovalQueue();
    assert.throws(() => q.enqueue({ action: "x", requested_by: "a", approvers_allowed: [] }), /approvers_allowed/);
    assert.throws(() => q.enqueue({ action: "", requested_by: "a", approvers_allowed: ["u"] }), /action/);
  },

  () => {
    const q = createApprovalQueue();
    const req = q.enqueue({ action: "run", requested_by: "agent", approvers_allowed: ["alice", "bob"] });
    // Only an allowed approver may approve
    assert.throws(() => q.approve(req.id, { actor: "eve" }), /approvers_allowed/);
    const approved = q.approve(req.id, { actor: "alice", note: "ok" });
    assert.equal(approved.state, "approved");
    assert.equal(approved.decided_by, "alice");
  },

  () => {
    const q = createApprovalQueue();
    const req = q.enqueue({ action: "run", requested_by: "agent", approvers_allowed: ["alice"] });
    q.reject(req.id, { actor: "alice", note: "no thanks" });
    // Can't transition again after a terminal state
    assert.throws(() => q.approve(req.id, { actor: "alice" }), /already rejected/);
  },

  () => {
    // Timeout reap
    let t = 1000;
    const q = createApprovalQueue({ clock: () => t });
    const req = q.enqueue({ action: "run", requested_by: "agent", approvers_allowed: ["alice"], timeout_ms: 60000 });
    t += 70000; // fast-forward past expiry
    const reaped = q.reapTimedOut();
    assert.equal(reaped.length, 1);
    assert.equal(reaped[0].id, req.id);
    assert.equal(reaped[0].state, "timed_out");
  },

  () => {
    // Listeners fire on state transitions
    const q = createApprovalQueue();
    const events = [];
    q.addListener(e => events.push(e.type));
    const r = q.enqueue({ action: "x", requested_by: "a", approvers_allowed: ["u"] });
    q.approve(r.id, { actor: "u" });
    assert.deepEqual(events, ["enqueued", "decided"]);
  },

  // ── registry reflects the new partial status ───────────────────────
  () => {
    assertRegistryIntegrity();
    const bi = getComponent("business-intelligence-studio");
    assert.equal(bi.status, "partial");
    assert.ok(bi.backing_modules.length >= 1);
    const web = getComponent("full-stack-web-builder");
    assert.equal(web.status, "partial");
    const hitl = getComponent("hitl-control-center");
    assert.equal(hitl.status, "partial");
  },
];

let passed = 0, failed = 0;
const failures = [];
cases.forEach((fn, i) => {
  try { fn(); passed++; }
  catch (err) { failed++; failures.push({ case: i + 1, message: err.message }); }
});

console.log(`bi-scaffolder-hitl regression: ${passed}/${cases.length} passed, ${failed} failed`);
if (failed) {
  for (const f of failures) console.log(`  FAIL ${f.case}: ${f.message}`);
  process.exit(1);
}
process.exit(0);
