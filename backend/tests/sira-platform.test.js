/**
 * sira-platform — deterministic tests for the remaining MASTER_SPEC
 * pieces: model-adapter (§14), policies (§16-17), research-engine
 * (§19), storage-schema (§26), chat-controller (§27), plus
 * Promptfoo-shaped intent-detection evals (§34).
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const modelAdapter = require("../src/services/sira/model-adapter");
const policies = require("../src/services/sira/policies");
const research = require("../src/services/sira/research-engine");
const storage = require("../src/services/sira/storage-schema");
const chatController = require("../src/services/sira/chat-controller");
const { buildEnvelope } = require("../src/services/sira/task-envelope-builder");

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

// ── §14 Model Adapter ──────────────────────────────────────────────

describe("sira model-adapter", () => {
  test("rejects missing selectedModel", async () => {
    await assert.rejects(modelAdapter.callUserSelectedModel({ messages: [{ role: "user", content: "x" }] }), /selectedModel is required/);
  });

  test("rejects unsupported provider", async () => {
    await assert.rejects(
      modelAdapter.callUserSelectedModel({ selectedModel: { provider: "rocket", modelId: "x" }, messages: [{ role: "user", content: "x" }] }),
      /provider "rocket" not in/,
    );
  });

  test("rejects empty messages array", async () => {
    await assert.rejects(
      modelAdapter.callUserSelectedModel({ selectedModel: { provider: "openai", modelId: "gpt-x" }, messages: [] }),
      /non-empty array/,
    );
  });

  test("default stub dispatches by provider", async () => {
    // Phase 8F.2: pass createDefaultProviders() explicitly so this test
    // remains deterministic even when ANTHROPIC_API_KEY is set in the
    // surrounding environment. Without the override, resolveProviders()
    // would substitute the native Anthropic SDK and try a live call.
    const r = await modelAdapter.callUserSelectedModel({
      selectedModel: { provider: "anthropic", modelId: "claude-x", modality: "text" },
      systemPrompt: "you are sira",
      messages: [{ role: "user", content: "hola" }],
      responseFormat: "json",
    }, { providers: modelAdapter.createDefaultProviders() });
    expect(r.provider).toBe("anthropic");
    expect(r.text).toMatch(/anthropic:claude-x/);
    expect(r.parsed.echo).toBe("hola");
  });

  test("guardAgainstAutoRouting catches provider switch", () => {
    assert.throws(
      () => modelAdapter.guardAgainstAutoRouting(
        { provider: "openai", modelId: "gpt-5" },
        { provider: "anthropic", modelId: "gpt-5" },
      ),
      (err) => err.code === "auto_route_violation" && /provider switched/.test(err.message),
    );
  });

  test("guardAgainstAutoRouting catches modelId switch", () => {
    assert.throws(
      () => modelAdapter.guardAgainstAutoRouting(
        { provider: "openai", modelId: "gpt-5" },
        { provider: "openai", modelId: "gpt-5-mini" },
      ),
      (err) => err.code === "auto_route_violation" && /modelId switched/.test(err.message),
    );
  });

  test("guardAgainstAutoRouting passes when identical", () => {
    const r = modelAdapter.guardAgainstAutoRouting(
      { provider: "openai", modelId: "gpt-5" },
      { provider: "openai", modelId: "gpt-5" },
    );
    expect(r.ok).toBe(true);
  });
});

// ── §16-17 Policies ────────────────────────────────────────────────

describe("sira policies", () => {
  test("CLARIFICATION_POLICY exposes spec-mandated thresholds", () => {
    expect(policies.SIRA_CLARIFICATION_POLICY.max_questions).toBe(3);
    expect(policies.SIRA_CLARIFICATION_POLICY.act_without_clarification_if_confidence_above).toBe(0.82);
    expect(policies.SIRA_CLARIFICATION_POLICY.ask_if_confidence_below).toBe(0.55);
  });

  test("SAFETY_POLICY blocks the canonical destructive set", () => {
    expect(policies.SIRA_SAFETY_POLICY.blocked_actions.includes("delete_user_files_without_confirmation")).toBe(true);
    expect(policies.SIRA_SAFETY_POLICY.blocked_actions.includes("execute_unsandboxed_code")).toBe(true);
    expect(policies.SIRA_SAFETY_POLICY.always_sandbox.includes("generated_code")).toBe(true);
  });

  test("evaluateClarificationPolicy: high-confidence envelope acts without asking", async () => {
    const { envelope } = await buildEnvelope({ text: "Genera un word con un resumen profesional" });
    envelope.intent_analysis.primary_intent.confidence = 0.95;
    envelope.clarification_policy.needs_clarification = false;
    const r = policies.evaluateClarificationPolicy(envelope);
    expect(r.ask).toBe(false);
  });

  test("evaluateClarificationPolicy: requested attachment but none provided → ask", async () => {
    const { envelope } = await buildEnvelope({ text: "Analiza este excel y dame un resumen" });
    envelope.intent_analysis.primary_intent.confidence = 0.5;
    const r = policies.evaluateClarificationPolicy(envelope);
    expect(r.ask).toBe(true);
    expect(r.reasons.includes("user_referenced_attachment_but_none_provided")).toBe(true);
  });

  test("evaluateSafetyPolicy: destructive action without approval is blocked", () => {
    const r = policies.evaluateSafetyPolicy({ kind: "delete user accounts" });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/destructive_action_without_approval/);
  });

  test("evaluateSafetyPolicy: external action without approval is blocked", () => {
    const r = policies.evaluateSafetyPolicy({ kind: "send email" });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/external_action_without_approval/);
  });

  test("evaluateSafetyPolicy: sandboxed action requires inSandbox=true", () => {
    const r = policies.evaluateSafetyPolicy({ kind: "generated_code" }, { inSandbox: false });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/requires_sandbox/);
    const ok = policies.evaluateSafetyPolicy({ kind: "generated_code" }, { inSandbox: true });
    expect(ok.allowed).toBe(true);
  });

  test("evaluatePolicyForEnvelope returns proceed when clean", async () => {
    const { envelope } = await buildEnvelope({ text: "Genera un word con un resumen profesional" });
    envelope.intent_analysis.primary_intent.confidence = 0.95;
    envelope.clarification_policy.needs_clarification = false;
    const r = policies.evaluatePolicyForEnvelope(envelope);
    expect(r.summary).toBe("proceed_with_envelope_plan");
  });
});

// ── §19 Research Engine ────────────────────────────────────────────

describe("sira research-engine", () => {
  test("rejects missing query", async () => {
    await assert.rejects(research.runResearchPipeline({ query: "" }), /query/);
  });

  test("default pipeline produces sources, validation + APA7 citations", async () => {
    const r = await research.runResearchPipeline({
      query: "Validez de la escala BAI en adolescentes",
      citationStyle: "APA7",
    });
    expect(r.schema_version).toBe("sira.research_report.v1");
    expect(r.sources.length).toBeGreaterThan(0);
    expect(r.sources[0].formatted).toMatch(/\(\d{4}\)/);
    expect(r.stats.providers_queried).toBeGreaterThanOrEqual(2);
  });

  test("dedupe collapses same DOI across providers", () => {
    const raw = {
      crossref: [{ title: "Same", authors: ["A"], doi: "10.1234/x.y", year: 2024, source_quality_score: 0.8 }],
      openalex: [{ title: "Same (alt title)", authors: ["A"], doi: "10.1234/x.y", year: 2024, source_quality_score: 0.7 }],
    };
    const out = research.stageDedupe(raw);
    expect(out.length).toBe(1);
    expect(out[0].source_quality_score).toBe(0.8); // higher quality kept
  });

  test("validate rejects malformed DOI", () => {
    const out = research.stageValidateMetadata([{
      title: "T", authors: ["A"], year: 2024, doi: "garbage", source_id: "x", provider: "x",
      source_quality_score: 0.5, relevance_score: 0.5, validation_status: "unvalidated",
    }]);
    expect(out[0].validation_status).toBe("rejected");
    expect(out[0].rejection_reason).toBe("invalid_doi_shape");
  });

  test("validate rejects implausible year", () => {
    const out = research.stageValidateMetadata([{
      title: "T", authors: ["A"], year: 1500, source_id: "x", provider: "x",
      source_quality_score: 0.5, relevance_score: 0.5, validation_status: "unvalidated",
    }]);
    expect(out[0].validation_status).toBe("rejected");
    expect(out[0].rejection_reason).toBe("implausible_year");
  });

  test("formatCitation emits APA7 / Vancouver / IEEE / MLA", () => {
    const s = { authors: ["Pérez, J."], year: 2024, title: "Estudio", journal: "RJ", doi: "10.1/x" };
    expect(research.formatCitation(s, "APA7")).toMatch(/Pérez/);
    expect(research.formatCitation(s, "Vancouver")).toMatch(/Pérez/);
    expect(research.formatCitation(s, "IEEE")).toMatch(/"Estudio"/);
    expect(research.formatCitation(s, "MLA")).toMatch(/"Estudio\."/);
  });

  test("link claims grounds when title overlaps", () => {
    const r = research.stageLinkClaims(
      [{ id: "c1", text: "Validez de la escala BAI" }],
      [{ source_id: "s1", title: "Estudio sobre validez de la escala BAI en adolescentes" }],
    );
    expect(r[0].grounded).toBe(true);
  });

  test("limitations surface when no DOI is present", async () => {
    const r = await research.runResearchPipeline({
      query: "Test sin DOI",
      providers: { web: async () => [{ title: "Web only", authors: ["A"], year: 2024, url: "https://example.com/x", source_quality_score: 0.5, relevance_score: 0.5 }] },
    });
    expect(r.limitations.some(l => /DOI/.test(l))).toBe(true);
  });
});

// ── §26 Storage schema ─────────────────────────────────────────────

describe("sira storage-schema", () => {
  test("SCHEMA_DDL covers 7 spec-mandated tables", () => {
    expect(storage.TABLES.length).toBeGreaterThanOrEqual(7);
    for (const t of ["sira_conversations", "sira_messages", "sira_task_envelopes", "sira_tool_calls", "sira_artifacts", "sira_validation_reports", "sira_audit_logs"]) {
      expect(storage.TABLES.includes(t)).toBe(true);
      expect(storage.SCHEMA_DDL[t]).toMatch(/CREATE TABLE/);
    }
  });

  test("createSiraStorage validates adapter contract", () => {
    assert.throws(() => storage.createSiraStorage({ adapter: { foo: () => {} } }), /missing method/);
  });

  test("end-to-end persistence happy path", async () => {
    const s = storage.createSiraStorage();
    const conv = await s.startConversation({ userId: "u1", title: "T" });
    expect(conv).toMatch(/^conv_/);
    await s.addMessage({ conversationId: conv, role: "user", content: { text: "hola" } });
    const envId = await s.persistEnvelope({ envelope: { request_id: "req_1", schema_version: "sira.task_envelope.v1" }, conversationId: conv, userId: "u1" });
    expect(envId).toMatch(/^env_/);
    await s.recordToolCall({ requestId: "req_1", toolName: "create_docx", input: {}, status: "success" });
    await s.persistArtifact({ requestId: "req_1", userId: "u1", artifactType: "file", format: "docx", filename: "x.docx", storageUrl: "inline://x" });
    await s.persistValidation({ requestId: "req_1", overallScore: 0.95, readyToDeliver: true, checks: [] });
    await s.audit("test_event", { ok: true }, { userId: "u1", requestId: "req_1" });
    const status = await s.getRunStatus("req_1");
    expect(status.tool_calls).toBe(1);
    expect(status.artifacts).toBe(1);
    expect(status.validation_ready).toBe(true);
    expect(s.counts().audit_logs).toBe(1);
  });

  test("getEnvelope returns persisted envelope by request_id", async () => {
    const s = storage.createSiraStorage();
    await s.startConversation({ userId: "u2", title: "T2" });
    await s.persistEnvelope({ envelope: { request_id: "req_2", schema_version: "sira.task_envelope.v1" }, conversationId: "c2", userId: "u2" });
    const e = await s.getEnvelope("req_2");
    expect(e.envelope.request_id).toBe("req_2");
  });
});

// ── §27 Chat Controller ────────────────────────────────────────────

describe("sira chat-controller", () => {
  test("rejects missing selectedModel (no auto-routing)", async () => {
    await assert.rejects(
      chatController.handleChatTurn({ conversationId: "c", userId: "u", userMessage: "hi" }),
      /selectedModel/,
    );
  });

  test("delivers a thesis turn end-to-end and persists each layer", async () => {
    const s = storage.createSiraStorage();
    await s.startConversation({ userId: "u", title: "Thesis" });
    const r = await chatController.handleChatTurn({
      conversationId: "conv_x",
      userId: "u",
      userMessage: "Hazme un word con un resumen profesional",
      attachments: [],
      history: [],
      selectedModel: { provider: "openai", modelId: "gpt-5", modality: "text" },
      userPlan: "PRO",
      dryRun: true,
    }, { storage: s });
    expect(["delivered", "needs_repair"].includes(r.stage)).toBe(true);
    expect(r.envelope.schema_version).toBe("sira.task_envelope.v1");
    expect(r.persisted_ids.user_message_id).toBeTruthy();
    expect(r.persisted_ids.envelope_id).toBeTruthy();
    expect(r.persisted_ids.assistant_message_id).toBeTruthy();
  });

  test("returns needs_clarification without executing tools when attachment is missing", async () => {
    const s = storage.createSiraStorage();
    await s.startConversation({ userId: "u", title: "Test" });
    const r = await chatController.handleChatTurn({
      conversationId: "conv_y",
      userId: "u",
      userMessage: "ok",
      selectedModel: { provider: "openai", modelId: "gpt-5", modality: "text" },
    }, { storage: s });
    expect(r.stage).toBe("needs_clarification");
    expect(r.persisted_ids.assistant_message_id).toBeTruthy();
  });
});

// ── §34 Promptfoo-shaped intent-detection evals ────────────────────

describe("sira intent detection evals (promptfoo-shaped)", () => {
  // Each "case" mirrors the shape of a Promptfoo test: vars + assert[].
  // We run the deterministic envelope builder and check the assertions.
  const cases = [
    {
      vars: { userMessage: "Hazme un informe en Word con fuentes científicas y PDF" },
      assert: [
        (out) => out.intent_analysis.primary_intent.id.includes("document") || out.intent_analysis.task_family === "document_artifacts",
        (out) => out.task_classification.requires_external_research === true,
        (out) => ["docx", "pdf"].includes(out.output_contract.primary_output.format),
      ],
    },
    {
      vars: { userMessage: "Crea una landing moderna para mi clínica dental" },
      assert: [
        (out) => out.intent_analysis.task_family === "coding",
        (out) => out.task_classification.requires_code_execution === true || out.task_classification.requires_tool_use === true,
      ],
    },
    {
      vars: { userMessage: "Genera un excel con dashboard de ventas" },
      assert: [
        (out) => out.output_contract.primary_output.format === "xlsx",
        (out) => Array.isArray(out.tool_plan.required_tools),
      ],
    },
    {
      vars: { userMessage: "Genera una imagen realista de un atardecer" },
      assert: [
        (out) => out.intent_analysis.task_family === "image",
        (out) => out.output_contract.primary_output.type === "image",
      ],
    },
    {
      vars: { userMessage: "Busca artículos científicos sobre validación de la escala BAI" },
      assert: [
        (out) => out.intent_analysis.task_family === "research",
        (out) => out.context_requirements.citation_required === true,
      ],
    },
  ];

  for (const tc of cases) {
    test(`eval: "${tc.vars.userMessage.slice(0, 60)}…"`, async () => {
      const { envelope } = await buildEnvelope({ text: tc.vars.userMessage });
      for (let i = 0; i < tc.assert.length; i++) {
        const ok = tc.assert[i](envelope);
        assert.ok(ok, `assertion ${i + 1} failed for "${tc.vars.userMessage}"`);
      }
    });
  }
});
