/**
 * qa-board + spans regression — deterministic tests for the
 * Agentic QA Board multi-critic orchestrator and the
 * OpenTelemetry-shaped span factory. No network, no LLM.
 */

const { strict: assert } = require("assert");

const {
  runQaBoard,
  BUILTIN_CRITICS,
  CRITIC_KINDS,
  intentCritic,
  formatCritic,
  factualityCritic,
  securityCritic,
  codeCritic,
  performanceCritic,
  uxCritic,
} = require("../src/services/agents/qa-board");

const { createTracer, toOtlpSpan, KIND, STATUS, newTraceId, newSpanId } = require("../src/services/observability/spans");

const cases = [
  // ── QA Board — basic ─────────────────────────────────────────────
  () => {
    assert.ok(Array.isArray(CRITIC_KINDS));
    assert.equal(CRITIC_KINDS.length, 8);
    for (const k of CRITIC_KINDS) assert.equal(typeof BUILTIN_CRITICS[k], "function");
  },

  async () => {
    const r = await runQaBoard({
      contract: { user_intent: "say hi" },
      deliverable: "Hola, esto es una respuesta.",
    });
    assert.equal(r.decision, "approve");
    assert.ok(r.reports.intent && r.reports.format && r.reports.factuality);
  },

  async () => {
    // Missing required keyword → intent critic flags it
    const r = await runQaBoard({
      contract: {
        user_intent: "Write an essay",
        content_requirements: [`Essay must include "Cronbach" somewhere`],
      },
      deliverable: "This is an essay without the magic word.",
    });
    assert.ok(r.findings.some(f => f.code === "intent_keyword_missing"));
  },

  async () => {
    // Forbidden keyword present → high-severity intent finding
    const r = await runQaBoard({
      contract: {
        user_intent: "Write a clean report",
        forbidden_outputs: [`Must not include "lorem ipsum"`],
      },
      deliverable: "Final report summary. lorem ipsum dolor sit amet.",
    });
    assert.ok(r.findings.some(f => f.code === "intent_forbidden_present"));
    // lorem ipsum is high severity → not approve
    assert.notEqual(r.decision, "approve");
  },

  async () => {
    // Format critic: wrong extension triggers critical
    const r = await runQaBoard({
      contract: {
        required_extension: "svg",
        mime_type: "image/svg+xml",
        success_tests: [],
      },
      artifact: { filename: "out.docx", buffer: Buffer.from("not a real docx") },
    });
    assert.equal(r.decision, "reject");
    assert.ok(r.findings.some(f => f.severity === "critical"));
  },

  async () => {
    // Factuality critic: out-of-range citation rejects
    const r = await runQaBoard({
      contract: { user_intent: "answer" },
      deliverable: "A claim [1] and another [3].",
      sources: [{ title: "Only source", doi: "10.1234/abc" }],
    });
    assert.ok(r.findings.some(f => f.code === "citation_out_of_range"));
  },

  async () => {
    // Security critic: secret in deliverable
    const r = await runQaBoard({
      contract: { user_intent: "x" },
      deliverable: "Here's my config: AWS_KEY=AKIAIOSFODNN7EXAMPLE",
    });
    assert.equal(r.decision, "reject", "critical secret must reject");
    assert.ok(r.findings.some(f => f.code === "aws_access_key"));
  },

  async () => {
    // Code critic catches eval()
    const r = await runQaBoard({
      contract: { user_intent: "write code" },
      code: "function run(s){ return eval(s); }",
      language: "javascript",
    });
    assert.ok(r.findings.some(f => f.code === "eval_usage"));
  },

  async () => {
    // Design critic fails on low-contrast palette
    const r = await runQaBoard({
      contract: { user_intent: "design" },
      designSpec: { palette: { brand: "#f5f5f5", surface: "#ffffff", text: "#dddddd", muted: "#eeeeee", accent: "#f0f0f0" } },
    });
    assert.ok(r.findings.some(f => f.code === "contrast_fail"));
  },

  async () => {
    // Performance critic flags exceeded USD budget
    const r = await runQaBoard({
      contract: { user_intent: "task" },
      budgets: { usd_spent: 5, usd_max: 1 },
    });
    assert.ok(r.findings.some(f => f.code === "budget_usd_exceeded"));
    assert.notEqual(r.decision, "approve");
  },

  async () => {
    // UX critic catches cop-outs when contract expects an answer
    const r = await runQaBoard({
      contract: { user_intent: "explain bayes" },
      deliverable: "As an AI language model, I can't help with that.",
    });
    assert.ok(r.findings.some(f => f.code === "cop_out_reply"));
  },

  async () => {
    // onlyCritics restricts which run
    const r = await runQaBoard(
      {
        contract: { user_intent: "x" },
        deliverable: "hello",
        code: "eval('x')",
      },
      { onlyCritics: ["intent", "ux"] }
    );
    assert.ok(r.reports.intent);
    assert.ok(r.reports.ux);
    assert.ok(!r.reports.code, "code critic must be skipped when not in onlyCritics");
  },

  async () => {
    // customCritics merges in user-defined reviewers
    const r = await runQaBoard(
      { contract: { user_intent: "x" }, deliverable: "hello" },
      {
        customCritics: {
          tone: () => ({ ok: false, findings: [{ severity: "medium", code: "tone_too_formal", detail: "Too stiff." }] }),
        },
        onlyCritics: ["tone"],
      }
    );
    assert.ok(r.reports.tone);
    assert.ok(r.reports.tone.findings.length >= 1);
  },

  async () => {
    // A throwing critic doesn't break the board
    const r = await runQaBoard(
      { contract: { user_intent: "x" } },
      {
        customCritics: { broken: () => { throw new Error("boom"); } },
        onlyCritics: ["broken"],
      }
    );
    assert.equal(r.reports.broken.ok, false);
    assert.ok(r.reports.broken.findings.some(f => f.code === "critic_threw"));
  },

  // ── Spans ────────────────────────────────────────────────────────
  () => {
    const tracer = createTracer({ serviceName: "svc" });
    const span = tracer.startSpan({ name: "op" });
    assert.equal(typeof span.trace_id, "string");
    assert.equal(span.trace_id.length, 32);
    assert.equal(typeof span.span_id, "string");
    assert.equal(span.span_id.length, 16);
    assert.equal(span.kind, KIND.INTERNAL);
    assert.equal(span.status.code, STATUS.UNSET);
  },

  () => {
    const tracer = createTracer({ serviceName: "svc" });
    const root = tracer.startSpan({ name: "root" });
    const child = tracer.startSpan({ name: "child", parent: root });
    assert.equal(child.trace_id, root.trace_id, "child inherits trace_id");
    assert.equal(child.parent_span_id, root.span_id, "parent is linked");
  },

  () => {
    const captured = [];
    const tracer = createTracer({ serviceName: "svc", exporter: s => captured.push(s) });
    const s = tracer.startSpan({ name: "op", attributes: { step: 1 } });
    s.setAttribute("cost.usd", 0.01);
    s.addEvent("checkpoint", { phase: "a" });
    s.end({ status: "ok" });
    assert.equal(captured.length, 1);
    const ex = captured[0];
    assert.equal(ex.name, "op");
    assert.equal(ex.status.code, "OK");
    assert.ok(ex.endTimeUnixNano);
    assert.ok(ex.attributes.some(a => a.key === "step" && a.value.intValue === 1));
    assert.ok(ex.events.some(e => e.name === "checkpoint"));
  },

  () => {
    const tracer = createTracer({ serviceName: "svc" });
    const s = tracer.startSpan({ name: "op" });
    s.setStatus("error", "boom");
    s.end();
    assert.equal(s.status.code, STATUS.ERROR);
    assert.equal(s.status.message, "boom");
  },

  () => {
    // end() is idempotent
    const captured = [];
    const tracer = createTracer({ serviceName: "svc", exporter: s => captured.push(s) });
    const s = tracer.startSpan({ name: "op" });
    s.end({ status: "ok" });
    s.end({ status: "ok" });
    assert.equal(captured.length, 1);
  },

  async () => {
    // withSpan captures exceptions
    const captured = [];
    const tracer = createTracer({ serviceName: "svc", exporter: s => captured.push(s) });
    await assert.rejects(
      tracer.withSpan({ name: "will-throw" }, async () => { throw new Error("nope"); }),
      /nope/
    );
    assert.equal(captured.length, 1);
    assert.equal(captured[0].status.code, STATUS.ERROR);
    assert.ok(captured[0].events.some(e => e.name === "exception"));
  },

  () => {
    // Span → OTLP shape serialises attribute types correctly
    const tracer = createTracer({ serviceName: "svc" });
    const s = tracer.startSpan({ name: "op", attributes: { s: "str", n: 1, f: 1.5, b: true, a: [1, 2] } });
    s.end({ status: "ok" });
    const json = s.toJSON();
    const attrMap = Object.fromEntries(json.attributes.map(a => [a.key, a.value]));
    assert.equal(attrMap.s.stringValue, "str");
    assert.equal(attrMap.n.intValue, 1);
    assert.equal(attrMap.f.doubleValue, 1.5);
    assert.equal(attrMap.b.boolValue, true);
    assert.ok(attrMap.a.arrayValue);
  },

  () => {
    assert.equal(newTraceId().length, 32);
    assert.equal(newSpanId().length, 16);
    assert.notEqual(newTraceId(), newTraceId(), "trace ids should be random");
  },
];

(async () => {
  let passed = 0, failed = 0;
  const failures = [];
  for (let i = 0; i < cases.length; i++) {
    try { await cases[i](); passed++; }
    catch (err) { failed++; failures.push({ case: i + 1, message: err.message }); }
  }
  console.log(`qa-board-spans regression: ${passed}/${cases.length} passed, ${failed} failed`);
  if (failed) {
    for (const f of failures) console.log(`  FAIL ${f.case}: ${f.message}`);
    process.exit(1);
  }
  process.exit(0);
})();
