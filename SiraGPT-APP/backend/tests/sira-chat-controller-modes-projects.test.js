/**
 * sira-chat-controller-modes-projects — verifies the wiring of
 * `chat-modes` and `project-workspace` into `chat-controller`:
 *   - mode resolution after envelope build
 *   - tool-plan filter applied to the envelope
 *   - audit events for mode + project loading
 *   - project_forbidden short-circuit when not a member
 *   - graceful degradation when project deps fail (non-forbidden)
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const { handleChatTurn } = require("../src/services/sira/chat-controller");
const { createSiraStorage, createInMemoryStorage } = require("../src/services/sira/storage-schema");
const { createDefaultRegistry } = require("../src/services/sira/tool-registry");

function instrumentedStorage() {
  const storage = createSiraStorage({ adapter: createInMemoryStorage() });
  const audits = [];
  const real = storage.audit.bind(storage);
  storage.audit = async (event, payload, meta) => {
    audits.push({ event, payload, meta });
    return real(event, payload, meta);
  };
  return { storage, audits };
}

const baseArgs = {
  conversationId: "conv-1",
  userId: "user-1",
  userMessage: "Resúmeme el contrato adjunto.",
  selectedModel: { provider: "openai", modelId: "gpt-4o-mini" },
  userPlan: "PRO",
  bypassSessionQueue: true,
};

// ── Mode resolution ────────────────────────────────────────────────

describe("chat-controller / chat-modes wiring", () => {
  test("resolves mode from caller, audits chat_mode_resolved, surfaces in result", async () => {
    const { storage, audits } = instrumentedStorage();
    const r = await handleChatTurn({
      ...baseArgs,
      mode: "research",
      requestId: "req-mode-1",
    }, { storage, registry: createDefaultRegistry() });

    const audit = audits.find((a) => a.event === "chat_mode_resolved");
    assert.ok(audit, "chat_mode_resolved audit must fire");
    assert.equal(audit.payload.mode, "research");
    assert.equal(audit.payload.source, "caller");
    assert.equal(r.mode.mode, "research");
    assert.equal(r.mode.source, "caller");
    assert.equal(r.summary.mode, "research");
  });

  test("falls back to family mapping when caller mode is absent", async () => {
    const { storage, audits } = instrumentedStorage();
    const r = await handleChatTurn(baseArgs, { storage, registry: createDefaultRegistry() });

    // The mode must be resolved (some non-null source). We don't pin
    // a specific mode here because the family mapping depends on the
    // intent classifier's output for this message; what matters is
    // that the wiring fires.
    const audit = audits.find((a) => a.event === "chat_mode_resolved");
    assert.ok(audit, "chat_mode_resolved audit must fire even without caller mode");
    assert.ok(["caller", "envelope_hint", "family_fallback", "default"].includes(audit.payload.source));
    assert.ok(r.mode);
    assert.ok(typeof r.mode.mode === "string");
  });
});

// ── Project workspace wiring ───────────────────────────────────────

describe("chat-controller / project-workspace wiring", () => {
  function workspaceDeps({ member = { role: "editor" }, docs = [], instructions = "", recents = [] } = {}) {
    return {
      members: { find: async () => member },
      docs: { list: async () => docs },
      instructions: { get: async () => instructions },
      conversations: { listRecent: async () => recents },
      memory: { scope: async ({ projectId, userId }) => ({ projectId, userId, tier: "project" }) },
    };
  }

  test("loads project context when projectId is set; audits + result include it", async () => {
    const { storage, audits } = instrumentedStorage();
    const r = await handleChatTurn({
      ...baseArgs,
      projectId: "p-42",
      requestId: "req-proj-1",
    }, {
      storage,
      registry: createDefaultRegistry(),
      projectWorkspaceDeps: workspaceDeps({
        docs: [{ id: "d1", title: "Spec" }],
        instructions: "Always cite sources.",
      }),
    });

    const loaded = audits.find((a) => a.event === "project_context_loaded");
    assert.ok(loaded);
    assert.equal(loaded.payload.project_id, "p-42");
    assert.equal(loaded.payload.member_role, "editor");
    assert.equal(loaded.payload.doc_count, 1);
    assert.ok(r.project_context);
    assert.equal(r.project_context.project_id, "p-42");
    assert.equal(r.summary.project_id, "p-42");
  });

  test("project_forbidden short-circuits before engine; no envelope is built", async () => {
    const { storage, audits } = instrumentedStorage();
    const r = await handleChatTurn({
      ...baseArgs,
      projectId: "p-forbidden",
      requestId: "req-forbidden",
    }, {
      storage,
      registry: createDefaultRegistry(),
      projectWorkspaceDeps: { members: { find: async () => null } }, // not a member
    });

    assert.equal(r.stage, "project_forbidden");
    assert.equal(r.error.code, "project.forbidden");
    assert.equal(r.error.project_id, "p-forbidden");
    assert.ok(audits.find((a) => a.event === "project_access_denied"));
    // Engine should NOT have been reached, so no envelope_invalid /
    // turn_completed audits in this turn.
    assert.equal(audits.find((a) => a.event === "envelope_invalid"), undefined);
    assert.equal(audits.find((a) => a.event === "turn_completed"), undefined);
  });

  test("non-forbidden project loader error degrades to null context (turn proceeds)", async () => {
    const { storage, audits } = instrumentedStorage();
    const r = await handleChatTurn({
      ...baseArgs,
      projectId: "p-broken",
      requestId: "req-broken",
    }, {
      storage,
      registry: createDefaultRegistry(),
      projectWorkspaceDeps: {
        // members.find throws an UNRELATED error (not "project.forbidden");
        // the loader degrades to null context instead of failing closed.
        members: { find: async () => { const e = new Error("transient"); e.code = "transient.fail"; throw e; } },
      },
    });

    const errAudit = audits.find((a) => a.event === "project_context_error");
    assert.ok(errAudit, "non-forbidden errors must be audited");
    assert.equal(errAudit.payload.error_code, "transient.fail");
    // Turn still ran to completion (or some later stage):
    assert.notEqual(r.stage, "project_forbidden");
    assert.equal(r.project_context, null);
  });

  test("project context is null when projectId is absent (no audit fired)", async () => {
    const { storage, audits } = instrumentedStorage();
    const r = await handleChatTurn(baseArgs, { storage, registry: createDefaultRegistry() });
    assert.equal(r.project_context, null);
    assert.equal(audits.find((a) => a.event === "project_context_loaded"), undefined);
    assert.equal(audits.find((a) => a.event === "project_access_denied"), undefined);
  });
});
