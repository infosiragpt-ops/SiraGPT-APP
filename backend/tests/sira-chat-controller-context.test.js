/**
 * sira-chat-controller-context — verifies the context-compactor
 * wiring inside chat-controller (task 15). Today the result is a
 * stats-only audit + summary on the envelope; consumers (runtime,
 * model-adapter) will read the actual compacted messages in a
 * follow-up commit.
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
  conversationId: "conv-ctx",
  userId: "user-ctx",
  selectedModel: { provider: "openai", modelId: "gpt-4o-mini" },
  userPlan: "PRO",
  bypassSessionQueue: true,
};

describe("chat-controller / context-compactor wiring", () => {
  test("emits a context_compacted audit with stats including the new user message", async () => {
    const { storage, audits } = instrumentedStorage();
    await handleChatTurn({
      ...baseArgs,
      userMessage: "Resume el contrato.",
      history: [
        { role: "user", content: "hola" },
        { role: "assistant", content: "hola, ¿en qué te ayudo?" },
      ],
      requestId: "req-ctx-1",
    }, { storage, registry: createDefaultRegistry() });

    const audit = audits.find((a) => a.event === "context_compacted");
    assert.ok(audit, "context_compacted audit must fire");
    // 2 history msgs + 1 current user msg = 3 input messages
    assert.equal(audit.payload.original_messages, 3);
    // Nothing duplicated → no collisions.
    assert.equal(audit.payload.dedup_collisions, 0);
    // Under the 80% safety budget for gpt-4o-mini → no drops.
    assert.equal(audit.payload.dropped_messages, 0);
    assert.equal(audit.meta.requestId, "req-ctx-1");
  });

  test("dedup_collisions is reported when history repeats the current message verbatim", async () => {
    const { storage, audits } = instrumentedStorage();
    await handleChatTurn({
      ...baseArgs,
      userMessage: "Hola",
      // Same content as the current message → one dedup collision.
      history: [{ role: "user", content: "Hola" }],
    }, { storage, registry: createDefaultRegistry() });
    const audit = audits.find((a) => a.event === "context_compacted");
    assert.equal(audit.payload.original_messages, 2);
    assert.equal(audit.payload.dedup_collisions, 1);
    assert.equal(audit.payload.deduped_messages, 1);
  });

  test("envelope carries context_compaction_summary for replay tools", async () => {
    const { storage } = instrumentedStorage();
    const r = await handleChatTurn({
      ...baseArgs,
      userMessage: "Necesito un resumen breve.",
      history: [],
    }, { storage, registry: createDefaultRegistry() });
    if (r.envelope) {
      assert.ok(r.envelope.context_compaction_summary, "summary must be on the envelope");
      assert.ok(typeof r.envelope.context_compaction_summary.kept_messages === "number");
    }
  });
});
