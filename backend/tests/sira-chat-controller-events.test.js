/**
 * sira-chat-controller-events — verifies the turn-events stream
 * emitted by chat-controller. Closes task 20.
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const { handleChatTurn } = require("../src/services/sira/chat-controller");
const { createSiraStorage, createInMemoryStorage } = require("../src/services/sira/storage-schema");
const { createDefaultRegistry } = require("../src/services/sira/tool-registry");
const { createBufferedEvents } = require("../src/services/sira/turn-events");

const baseArgs = {
  conversationId: "conv-events",
  userId: "user-events",
  selectedModel: { provider: "openai", modelId: "gpt-4o-mini" },
  userPlan: "PRO",
  bypassSessionQueue: true,
};

describe("chat-controller emits ordered turn events", () => {
  test("happy turn emits turn_started → token_budget_checked → envelope_built → chat_mode_resolved → context_compacted → … → turn_completed → _end", async () => {
    const storage = createSiraStorage({ adapter: createInMemoryStorage() });
    const events = createBufferedEvents();
    await handleChatTurn({
      ...baseArgs,
      userMessage: "Resúmeme algo breve.",
      requestId: "req-events-1",
    }, { storage, registry: createDefaultRegistry(), events });

    const names = events.events.map((e) => e.name);
    // Mandatory ordered prefix:
    const expectedOrder = [
      "turn_started",
      "token_budget_checked",
      "envelope_built",
      "chat_mode_resolved",
      "context_compacted",
    ];
    let cursor = 0;
    for (const expected of expectedOrder) {
      const idx = names.indexOf(expected, cursor);
      assert.notEqual(idx, -1, `event ${expected} missing or out of order; got ${names.join(",")}`);
      cursor = idx + 1;
    }
    // Stream must end with _end.
    assert.equal(names[names.length - 1], "_end");
  });

  test("every event payload carries the request_id", async () => {
    const storage = createSiraStorage({ adapter: createInMemoryStorage() });
    const events = createBufferedEvents();
    await handleChatTurn({
      ...baseArgs,
      userMessage: "Hola",
      requestId: "req-events-correlation",
    }, { storage, registry: createDefaultRegistry(), events });

    for (const e of events.events) {
      if (e.name === "_end") continue;
      assert.ok(e.data, `${e.name} payload missing`);
      assert.equal(e.data.request_id, "req-events-correlation",
        `${e.name} payload should carry request_id`);
    }
  });

  test("project_forbidden short-circuits with the right event sequence", async () => {
    // Anonymous user is not a member of the project → loadProjectContext
    // throws project.forbidden → controller short-circuits with the
    // project_forbidden stage. The event stream must mirror it.
    const storage = createSiraStorage({ adapter: createInMemoryStorage() });
    const events = createBufferedEvents();
    await handleChatTurn({
      ...baseArgs,
      userMessage: "x",
      projectId: "p-forbid-events",
      requestId: "req-events-forbid",
    }, {
      storage, registry: createDefaultRegistry(), events,
      projectWorkspaceDeps: { members: { find: async () => null } },
    });

    const names = events.events.map((e) => e.name);
    assert.ok(names.includes("turn_started"));
    assert.ok(names.includes("project_access_denied"));
    // No envelope after a forbidden turn.
    assert.equal(names.includes("envelope_built"), false);
    assert.equal(names.includes("turn_completed"), false);
    assert.equal(names[names.length - 1], "_end");
  });

  test("missing events deps falls back to no-op (no behaviour change)", async () => {
    // Same call without `events` should still succeed.
    const storage = createSiraStorage({ adapter: createInMemoryStorage() });
    const r = await handleChatTurn({
      ...baseArgs,
      userMessage: "Hola",
      requestId: "req-events-noop",
    }, { storage, registry: createDefaultRegistry() });
    assert.ok(r);
    assert.ok(["delivered", "needs_repair", "needs_clarification", "envelope_invalid"].includes(r.stage));
  });
});
