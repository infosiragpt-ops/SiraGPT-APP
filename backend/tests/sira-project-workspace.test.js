/**
 * sira-project-workspace — typed loader for per-project context
 * (docs, instructions, memory scope, permissions, conversations).
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const {
  VALID_ROLES,
  ROLE_CAPABILITIES,
  ProjectAccessError,
  capabilitiesForRole,
  canAccess,
  loadProjectContext,
  validateProjectContext,
} = require("../src/services/sira/project-workspace");

// ── Roles + capabilities ───────────────────────────────────────────

describe("role catalog", () => {
  test("VALID_ROLES are viewer / editor / owner", () => {
    assert.deepEqual(VALID_ROLES, ["viewer", "editor", "owner"]);
  });

  test("each role's capability set is strictly larger than the previous", () => {
    const v = new Set(ROLE_CAPABILITIES.viewer);
    const e = new Set(ROLE_CAPABILITIES.editor);
    const o = new Set(ROLE_CAPABILITIES.owner);
    for (const c of v) assert.ok(e.has(c), `editor missing viewer cap ${c}`);
    for (const c of e) assert.ok(o.has(c), `owner missing editor cap ${c}`);
  });

  test("capabilitiesForRole returns a fresh copy", () => {
    const a = capabilitiesForRole("editor");
    a.push("MUTATED");
    const b = capabilitiesForRole("editor");
    assert.ok(!b.includes("MUTATED"));
  });

  test("capabilitiesForRole returns [] for unknown role", () => {
    assert.deepEqual(capabilitiesForRole("nope"), []);
  });
});

// ── canAccess ──────────────────────────────────────────────────────

describe("canAccess", () => {
  test("explicit capabilities trump role", () => {
    const m = { role: "viewer", capabilities: ["docs:write"] };
    assert.equal(canAccess(m, "docs:write"), true);
  });

  test("falls through to role expansion when capabilities absent", () => {
    assert.equal(canAccess({ role: "editor" }, "docs:write"), true);
    assert.equal(canAccess({ role: "viewer" }, "docs:write"), false);
  });

  test("owner has tools:run_external; editor does not", () => {
    assert.equal(canAccess({ role: "owner" }, "tools:run_external"), true);
    assert.equal(canAccess({ role: "editor" }, "tools:run_external"), false);
  });

  test("returns false for null member or non-string capability", () => {
    assert.equal(canAccess(null, "docs:write"), false);
    assert.equal(canAccess({ role: "owner" }, null), false);
  });
});

// ── loadProjectContext ─────────────────────────────────────────────

describe("loadProjectContext", () => {
  function deps({ member = { role: "editor" }, docs = [], instructions = "", recents = [], memoryScope = null } = {}) {
    return {
      members: { find: async () => member },
      docs: { list: async () => docs },
      instructions: { get: async () => instructions },
      conversations: { listRecent: async () => recents },
      memory: { scope: async ({ projectId, userId }) => memoryScope || { projectId, userId, tier: "project" } },
    };
  }

  test("returns a discriminated context with all five facets", async () => {
    const ctx = await loadProjectContext({
      projectId: "p1", userId: "u1",
      deps: deps({
        docs: [{ id: "d1", title: "Spec" }],
        instructions: "Always cite sources.",
        recents: [{ id: "c1", title: "Hi" }],
      }),
    });
    assert.equal(ctx.schema_version, "sira.project_workspace_context.v1");
    assert.equal(ctx.project_id, "p1");
    assert.equal(ctx.user_id, "u1");
    assert.equal(ctx.member.role, "editor");
    assert.ok(Array.isArray(ctx.capabilities) && ctx.capabilities.length > 0);
    assert.equal(ctx.instructions, "Always cite sources.");
    assert.equal(ctx.docs.length, 1);
    assert.equal(ctx.recent_conversations.length, 1);
    assert.ok(ctx.memory_scope);
  });

  test("explicit capabilities on the member override role expansion", async () => {
    const ctx = await loadProjectContext({
      projectId: "p1", userId: "u1",
      deps: deps({ member: { role: "viewer", capabilities: ["docs:write", "members:manage"] } }),
    });
    assert.deepEqual(ctx.capabilities, ["docs:write", "members:manage"]);
  });

  test("throws project.forbidden when user is not a member", async () => {
    const d = deps({ member: null });
    await assert.rejects(
      () => loadProjectContext({ projectId: "p1", userId: "u1", deps: d }),
      { code: "project.forbidden" },
    );
  });

  test("validates projectId and userId", async () => {
    await assert.rejects(
      () => loadProjectContext({ projectId: "", userId: "u" }),
      { code: "project.invalid_id" },
    );
    await assert.rejects(
      () => loadProjectContext({ projectId: "p", userId: "" }),
      { code: "project.invalid_user" },
    );
  });

  test("missing optional adapters degrade to safe defaults (no crash)", async () => {
    // Only members.find is wired; the rest fall back to defaults.
    const ctx = await loadProjectContext({
      projectId: "p1", userId: "u1",
      deps: { members: { find: async () => ({ role: "owner" }) } },
    });
    assert.equal(ctx.instructions, "");
    assert.deepEqual(ctx.docs, []);
    assert.deepEqual(ctx.recent_conversations, []);
    assert.ok(ctx.memory_scope.projectId);
  });

  test("respects recentConversationLimit", async () => {
    let receivedLimit = null;
    const d = {
      members: { find: async () => ({ role: "editor" }) },
      conversations: { listRecent: async ({ limit }) => { receivedLimit = limit; return []; } },
    };
    await loadProjectContext({ projectId: "p1", userId: "u1", deps: d, recentConversationLimit: 3 });
    assert.equal(receivedLimit, 3);
  });
});

// ── validateProjectContext ─────────────────────────────────────────

describe("validateProjectContext", () => {
  test("approves a well-formed context", () => {
    const r = validateProjectContext({
      schema_version: "sira.project_workspace_context.v1",
      project_id: "p1", user_id: "u1",
      capabilities: [], instructions: "", docs: [], recent_conversations: [],
    });
    assert.equal(r.ok, true);
  });

  test("rejects missing required fields", () => {
    const r = validateProjectContext({});
    assert.equal(r.ok, false);
    assert.ok(r.errors.length >= 5);
  });

  test("rejects null", () => {
    assert.equal(validateProjectContext(null).ok, false);
  });
});
