/**
 * sira-chat-modes — mode-aware orchestration scaffolding.
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const {
  MODES,
  DEFAULT_MODE,
  listModes,
  getModeConfig,
  resolveMode,
  isToolAllowedInMode,
  applyModeToToolPlan,
  applyModePrompt,
} = require("../src/services/sira/chat-modes");

// ── Catalog ────────────────────────────────────────────────────────

describe("MODES catalog", () => {
  test("defines the 5 canonical modes", () => {
    assert.deepEqual(listModes().sort(), ["chat", "code", "document", "presentation", "research"]);
  });

  test("DEFAULT_MODE is 'chat'", () => {
    assert.equal(DEFAULT_MODE, "chat");
  });

  test("each mode declares the required fields", () => {
    for (const name of listModes()) {
      const cfg = MODES[name];
      assert.equal(typeof cfg.label, "string");
      assert.equal(typeof cfg.description, "string");
      // tool_whitelist may be null (chat) or array (others)
      assert.ok(cfg.tool_whitelist === null || Array.isArray(cfg.tool_whitelist), `${name}.tool_whitelist`);
      assert.ok(Array.isArray(cfg.tool_blocklist), `${name}.tool_blocklist`);
      assert.equal(typeof cfg.system_prompt_addendum, "string");
      assert.equal(typeof cfg.validator_profile, "string");
      assert.ok(Array.isArray(cfg.intent_families), `${name}.intent_families`);
      assert.ok(["text", "json", "json_schema"].includes(cfg.default_response_format));
      assert.ok(Array.isArray(cfg.requires_human_approval_for), `${name}.requires_human_approval_for`);
    }
  });

  test("getModeConfig returns a defensive copy", () => {
    const a = getModeConfig("research");
    a.tool_whitelist.push("MUTATED");
    const b = getModeConfig("research");
    assert.ok(!b.tool_whitelist.includes("MUTATED"), "catalog must not be mutable through getModeConfig");
  });

  test("getModeConfig returns null for unknown mode", () => {
    assert.equal(getModeConfig("nope"), null);
    assert.equal(getModeConfig(null), null);
  });
});

// ── resolveMode ────────────────────────────────────────────────────

describe("resolveMode", () => {
  test("caller-supplied mode wins", () => {
    const r = resolveMode({ callerMode: "research", envelope: { mode_hint: "code" } });
    assert.equal(r.mode, "research");
    assert.equal(r.source, "caller");
  });

  test("envelope mode_hint used when caller absent", () => {
    const r = resolveMode({ envelope: { mode_hint: "document" } });
    assert.equal(r.mode, "document");
    assert.equal(r.source, "envelope_hint");
  });

  test("family fallback maps coding → code", () => {
    const r = resolveMode({
      envelope: { intent_analysis: { primary_intent: { task_family: "coding" } } },
    });
    assert.equal(r.mode, "code");
    assert.equal(r.source, "family_fallback");
  });

  test("family fallback maps research → research", () => {
    const r = resolveMode({ envelope: { intent_analysis: { primary_intent: { task_family: "research" } } } });
    assert.equal(r.mode, "research");
  });

  test("falls back to DEFAULT_MODE when nothing matches", () => {
    const r = resolveMode({});
    assert.equal(r.mode, "chat");
    assert.equal(r.source, "default");
  });

  test("ignores unknown caller mode and falls back", () => {
    const r = resolveMode({ callerMode: "nope" });
    assert.equal(r.mode, "chat");
    assert.equal(r.source, "default");
  });
});

// ── isToolAllowedInMode ────────────────────────────────────────────

describe("isToolAllowedInMode", () => {
  test("chat allows any tool (no whitelist)", () => {
    assert.equal(isToolAllowedInMode("chat", "anything"), true);
  });

  test("research blocks code execution", () => {
    assert.equal(isToolAllowedInMode("research", "execute_sandboxed_code"), false);
  });

  test("code allows code generation but blocks web_search", () => {
    assert.equal(isToolAllowedInMode("code", "code_generation"), true);
    assert.equal(isToolAllowedInMode("code", "web_search"), false);
  });

  test("document allows docx_generation and rag_retrieve", () => {
    assert.equal(isToolAllowedInMode("document", "docx_generation"), true);
    assert.equal(isToolAllowedInMode("document", "rag_retrieve"), true);
  });

  test("blocklist wins over whitelist (defensive)", () => {
    // If a tool somehow appears in both the whitelist and blocklist,
    // the safer interpretation is to block it.
    const original = MODES.research.tool_whitelist;
    try {
      MODES.research.tool_whitelist = [...original, "execute_sandboxed_code"];
      assert.equal(isToolAllowedInMode("research", "execute_sandboxed_code"), false);
    } finally {
      // restore via defensive copy semantics — MODES is frozen at the
      // top level but the whitelist array isn't, so we replace it.
      MODES.research.tool_whitelist = original;
    }
  });

  test("unknown mode does not gate", () => {
    assert.equal(isToolAllowedInMode("nope", "anything"), true);
  });
});

// ── applyModeToToolPlan ────────────────────────────────────────────

describe("applyModeToToolPlan", () => {
  function envelopeWithTools(required, optional = []) {
    return {
      tool_plan: {
        required_tools: required.map((name) => ({ tool_name: name })),
        optional_tools: optional.map((name) => ({ tool_name: name })),
      },
    };
  }

  test("filters out required tools blocked in mode and reports them", () => {
    const env = envelopeWithTools(["rag_retrieve", "execute_sandboxed_code", "web_search"]);
    const r = applyModeToToolPlan(env, "research");
    const names = r.tool_plan.required_tools.map((t) => t.tool_name);
    assert.deepEqual(names.sort(), ["rag_retrieve", "web_search"]);
    assert.deepEqual(r.dropped_required.sort(), ["execute_sandboxed_code"]);
  });

  test("filters optional tools too but does not report them as dropped_required", () => {
    const env = envelopeWithTools(["rag_retrieve"], ["execute_sandboxed_code"]);
    const r = applyModeToToolPlan(env, "research");
    assert.equal(r.tool_plan.optional_tools.length, 0);
    assert.deepEqual(r.dropped_required, []);
  });

  test("returns null tool_plan when envelope has none", () => {
    const r = applyModeToToolPlan({}, "research");
    assert.equal(r.tool_plan, null);
    assert.deepEqual(r.dropped_required, []);
  });

  test("does not mutate the input envelope", () => {
    const env = envelopeWithTools(["rag_retrieve", "execute_sandboxed_code"]);
    const before = JSON.stringify(env);
    applyModeToToolPlan(env, "research");
    assert.equal(JSON.stringify(env), before);
  });
});

// ── applyModePrompt ────────────────────────────────────────────────

describe("applyModePrompt", () => {
  test("appends the mode addendum on a base prompt", () => {
    const out = applyModePrompt("You are siraGPT.", "research");
    assert.match(out, /You are siraGPT\./);
    assert.match(out, /RESEARCH mode/);
  });

  test("returns the addendum alone when base is empty", () => {
    const out = applyModePrompt("", "code");
    assert.match(out, /CODE mode/);
  });

  test("returns the base unchanged for chat (no addendum)", () => {
    const out = applyModePrompt("base prompt", "chat");
    assert.equal(out, "base prompt");
  });

  test("safe for unknown mode", () => {
    const out = applyModePrompt("base", "nope");
    assert.equal(out, "base");
  });
});
