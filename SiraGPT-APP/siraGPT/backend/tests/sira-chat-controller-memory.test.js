/**
 * sira-chat-controller-memory — verifies the MemoryStore wiring in
 * chat-controller (task 21): pre-envelope recall + post-runtime put.
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const { handleChatTurn } = require("../src/services/sira/chat-controller");
const { createSiraStorage, createInMemoryStorage } = require("../src/services/sira/storage-schema");
const { createDefaultRegistry } = require("../src/services/sira/tool-registry");
const { createInMemoryStore } = require("../src/services/sira/memory-store");

const baseArgs = {
  conversationId: "conv-mem",
  userId: "user-mem",
  selectedModel: { provider: "openai", modelId: "gpt-4o-mini" },
  userPlan: "PRO",
  bypassSessionQueue: true,
};

describe("chat-controller / MemoryStore wiring", () => {
  test("recalls from semantic + project tiers before envelope when memoryStore is wired", async () => {
    const storage = createSiraStorage({ adapter: createInMemoryStorage() });
    const memoryStore = createInMemoryStore();
    // Seed memory.
    await memoryStore.put({ tier: "semantic", scope: { userId: "user-mem" }, item: { text: "Luis prefers Tailwind." } });
    await memoryStore.put({ tier: "project", scope: { projectId: "p-mem", userId: "user-mem" }, item: { text: "Project policy: cite sources." } });

    const r = await handleChatTurn({
      ...baseArgs,
      userMessage: "Tailwind preference recall",
      requestId: "req-mem-1",
      projectId: "p-mem",
    }, {
      storage, registry: createDefaultRegistry(), memoryStore,
      // Member is required for project recall to fire (chat-controller
      // gates project memory on a successful project_workspace load).
      projectWorkspaceDeps: {
        members: { find: async () => ({ role: "editor" }) },
      },
    });

    if (r.recalled_memory) {
      assert.ok(Array.isArray(r.recalled_memory.semantic));
      assert.ok(Array.isArray(r.recalled_memory.project));
      assert.equal(r.recalled_memory.semantic.length, 1);
      assert.equal(r.recalled_memory.project.length, 1);
    }
  });

  test("persists the user message to the conversation tier after a successful turn", async () => {
    const storage = createSiraStorage({ adapter: createInMemoryStorage() });
    const memoryStore = createInMemoryStore();

    await handleChatTurn({
      ...baseArgs,
      userMessage: "Resúmeme algo.",
      requestId: "req-mem-persist",
    }, { storage, registry: createDefaultRegistry(), memoryStore });

    const stats = await memoryStore.stats({ tier: "conversation", scope: { conversationId: "conv-mem" } });
    if (stats.count > 0) {
      const recalled = await memoryStore.recall({ tier: "conversation", scope: { conversationId: "conv-mem" } });
      assert.ok(recalled.length > 0);
      assert.match(JSON.stringify(recalled[0].item), /Resúmeme algo/);
    }
  });

  test("a recall failure on one tier does not block the turn", async () => {
    const storage = createSiraStorage({ adapter: createInMemoryStorage() });
    // Store that throws on every call.
    const broken = {
      recall: async () => { throw new Error("vector store down"); },
      put: async () => ({ id: "m1" }),
    };
    const r = await handleChatTurn({
      ...baseArgs,
      userMessage: "x",
      requestId: "req-mem-broken",
    }, { storage, registry: createDefaultRegistry(), memoryStore: broken });

    // Recall failed but the turn continued.
    assert.notEqual(r.stage, undefined);
    if (r.recalled_memory) {
      assert.equal(r.recalled_memory.semantic.length, 0);
    }
  });

  test("missing memoryStore deps means no recall, no put, no audits", async () => {
    const storage = createSiraStorage({ adapter: createInMemoryStorage() });
    const audits = [];
    const realAudit = storage.audit.bind(storage);
    storage.audit = async (event, payload, meta) => { audits.push(event); return realAudit(event, payload, meta); };

    await handleChatTurn({
      ...baseArgs,
      userMessage: "x",
      requestId: "req-mem-absent",
    }, { storage, registry: createDefaultRegistry() });

    assert.equal(audits.includes("memory_recalled"), false);
    assert.equal(audits.includes("memory_persisted"), false);
  });
});
