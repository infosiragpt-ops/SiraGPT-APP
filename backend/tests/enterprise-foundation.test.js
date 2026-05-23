/**
 * enterprise-foundation regression suite — deterministic checks for
 * the cognitive-agentic enterprise layer (ExecutionGraph,
 * ValidationFabric, ComponentRegistry, extended ToolManifest,
 * design-tokens). No network, no LLM.
 */

const { strict: assert } = require("assert");

const {
  makeNode,
  validateGraph,
  topoSort,
  buildExecutionGraph,
  readyNodes,
  transitionNode,
  overallOutcome,
} = require("../src/services/agents/execution-graph");

const { aggregate, emptyReports } = require("../src/services/agents/validation-fabric");
const { COMPONENTS, assertRegistryIntegrity, countByStatus, listComponents } = require("../src/services/agents/component-registry");
const { validateManifest, BUILTIN_MANIFESTS } = require("../src/services/agents/tool-manifest");
const { buildTokens, INTERNAL } = require("../src/services/design/design-tokens");

const cases = [
  // ── ExecutionGraph ─────────────────────────────────────────────────
  () => {
    const g = buildExecutionGraph({
      nodes: [
        { id: "a", tool: "python_exec" },
        { id: "b", tool: "run_tests", depends_on: ["a"] },
        { id: "c", tool: "create_document", depends_on: ["a"] },
        { id: "d", tool: "verify_artifact", depends_on: ["c"] },
      ],
    });
    assert.equal(g.nodes.length, 4);
    assert.deepEqual(g.order, ["a", "b", "c", "d"]);
    assert.deepEqual(readyNodes(g), ["a"]);
  },

  () => {
    assert.throws(() => buildExecutionGraph({
      nodes: [
        { id: "a", tool: "x", depends_on: ["b"] },
        { id: "b", tool: "x", depends_on: ["a"] },
      ],
    }), /cycle/);
  },

  () => {
    assert.throws(() => buildExecutionGraph({
      nodes: [
        { id: "a", tool: "x", depends_on: ["does-not-exist"] },
      ],
    }), /depends on missing/);
  },

  () => {
    assert.throws(() => buildExecutionGraph({
      nodes: [
        { id: "a", tool: "x", depends_on: ["a"] },
      ],
    }), /depends on itself/);
  },

  () => {
    const g = buildExecutionGraph({
      nodes: [
        { id: "a", tool: "python_exec" },
        { id: "b", tool: "run_tests", depends_on: ["a"] },
      ],
    });
    transitionNode(g, "a", "running");
    transitionNode(g, "a", "done", { result: { ok: true } });
    assert.equal(g.counts.done, 1);
    assert.deepEqual(readyNodes(g), ["b"]);
  },

  () => {
    const g = buildExecutionGraph({
      nodes: [{ id: "x", tool: "y" }],
    });
    transitionNode(g, "x", "running");
    assert.throws(() => transitionNode(g, "x", "pending"), /illegal transition/);
  },

  () => {
    const g = buildExecutionGraph({
      nodes: [{ id: "x", tool: "y" }],
    });
    transitionNode(g, "x", "running");
    transitionNode(g, "x", "done");
    assert.equal(overallOutcome(g), "done");
  },

  () => {
    const n = makeNode({ id: "z", tool: "foo", inputs: { a: 1 }, depends_on: [] });
    assert.equal(typeof n.idempotency_key, "string");
    assert.ok(n.idempotency_key.length > 0, "idempotency_key should be computed");
    const n2 = makeNode({ id: "z", tool: "foo", inputs: { a: 1 }, depends_on: [] });
    assert.equal(n.idempotency_key, n2.idempotency_key, "same inputs → same idempotency key");
  },

  // ── ValidationFabric ───────────────────────────────────────────────
  () => {
    const d = aggregate(emptyReports());
    assert.equal(d.decision, "approve");
    assert.equal(d.findings.length, 0);
  },

  () => {
    const d = aggregate({
      security: { ok: false, findings: [{ severity: "critical", code: "secret_exposed", detail: "AWS key in source" }] },
    });
    assert.equal(d.decision, "reject", "critical finding must reject");
  },

  () => {
    const d = aggregate({
      codeReview: { ok: true, findings: [
        { severity: "high", code: "lint", detail: "..." },
        { severity: "high", code: "typecheck", detail: "..." },
        { severity: "high", code: "complexity", detail: "..." },
      ] },
    });
    assert.equal(d.decision, "reject", "3 high findings must reject");
  },

  () => {
    const d = aggregate({
      designReview: { ok: true, findings: [{ severity: "high", code: "contrast", detail: "low" }] },
    });
    assert.equal(d.decision, "manual-review", "1 high finding → manual review");
  },

  () => {
    const d = aggregate({}, );
    assert.equal(d.decision, "approve");
    const budgetHold = aggregate({}, );
    // direct budget call
    const withBudget = aggregate({
      performance: { ok: true, findings: [] },
      budgets: { usd_spent: 2, usd_max: 1 },
    });
    // budgets go as parameter
  },

  () => {
    const d = aggregate({
      validation: { ok: true, findings: [] },
      budgets: { usd_spent: 5, usd_max: 1 },
    });
    assert.equal(d.decision, "hold");
    assert.ok(d.budgetBreach && /usd/.test(d.budgetBreach));
  },

  // ── ComponentRegistry ──────────────────────────────────────────────
  () => {
    assertRegistryIntegrity();
    const counts = countByStatus();
    assert.ok(counts.implemented + counts.partial + counts.planned === COMPONENTS.length);
    assert.ok(counts.implemented >= 4, "at least 4 components should be actually implemented");
  },

  () => {
    const list = listComponents();
    assert.ok(list.every(c => c.id && c.name && c.status));
    // Anti-vaporware contract: at least one component should be
    // honestly marked as "not yet implemented" (partial OR planned).
    // Once the registry reaches all-implemented we'll retire this
    // gate, but today the Workflow Orchestrator + Document
    // Intelligence Engine are partial by design.
    const notImplemented = list.filter(c => c.status !== "implemented");
    assert.ok(notImplemented.length >= 1, "at least one component should honestly not claim fully implemented");
  },

  // ── ToolManifest v1.1 ──────────────────────────────────────────────
  () => {
    // The 8 built-ins must still validate after the schema extension
    for (const [name, m] of Object.entries(BUILTIN_MANIFESTS)) {
      const v = validateManifest(m);
      assert.equal(v.ok, true, `${name} manifest should validate, got: ${JSON.stringify(v.errors).slice(0, 200)}`);
    }
  },

  () => {
    // Verify the new governance fields are accepted when provided
    const base = { ...BUILTIN_MANIFESTS.create_document };
    const extended = { ...base, side_effect_level: "local-fs", requires_confirmation: false, sandbox_required: true, audit_policy: "every-call", scopes: ["files.write", "artifacts.create"], data_classes: ["internal"] };
    const v = validateManifest(extended);
    assert.equal(v.ok, true, `extended manifest should validate: ${JSON.stringify(v.errors).slice(0, 300)}`);
  },

  () => {
    // Rejects unknown side_effect_level
    const bad = { ...BUILTIN_MANIFESTS.create_document, side_effect_level: "mystery" };
    const v = validateManifest(bad);
    assert.equal(v.ok, false, "unknown side_effect_level should be rejected");
  },

  // ── DesignTokens ───────────────────────────────────────────────────
  () => {
    const out = buildTokens();
    assert.ok(out.tokens["color-brand"], "should produce color-brand token");
    assert.ok(out.css.includes(":root"), "should produce :root CSS block");
    assert.ok(Array.isArray(out.checks.contrast));
    assert.ok(out.checks.contrast.length >= 4);
  },

  () => {
    // Contrast check rejects a low-contrast palette
    const out = buildTokens({ palette: { brand: "#f5f5f5", surface: "#ffffff", text: "#dddddd", muted: "#eeeeee", accent: "#f0f0f0" } });
    assert.equal(out.passed, false, "low-contrast palette should fail");
    const failing = out.checks.contrast.filter(c => !c.ok);
    assert.ok(failing.length > 0);
  },

  () => {
    // Type scale has expected shape (9 entries: t-n2..t-p6)
    const spec = { palette: { brand: "#2563eb", accent: "#10b981", surface: "#ffffff", text: "#0f172a", muted: "#64748b" } };
    const out = buildTokens(spec);
    const typeKeys = Object.keys(out.tokens).filter(k => k.startsWith("t-"));
    assert.equal(typeKeys.length, 9, "should produce 9 type-scale tokens");
  },

  () => {
    // Palette with non-hex colour throws
    assert.throws(() => buildTokens({ palette: { brand: "not-a-color", accent: "#10b981", surface: "#fff", text: "#000", muted: "#777" } }), /hex color/);
  },

  () => {
    // Contrast ratio is correct for pure black on pure white (21:1)
    const r = INTERNAL.contrastRatio("#000000", "#ffffff");
    assert.ok(r >= 20.9 && r <= 21.1, `black-on-white contrast ≈ 21, got ${r}`);
  },
];

let passed = 0;
let failed = 0;
const failures = [];
cases.forEach((fn, i) => {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    failures.push({ case: i + 1, message: err.message });
  }
});

console.log(`enterprise-foundation regression: ${passed}/${cases.length} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.log(`  FAIL ${f.case}: ${f.message}`);
  process.exit(1);
}
process.exit(0);
