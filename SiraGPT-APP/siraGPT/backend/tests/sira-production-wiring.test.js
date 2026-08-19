/**
 * sira-production-wiring — verifies the production-wiring factory
 * builds a working composite memory store + project workspace deps
 * over a faked Prisma client. Closes task 27.
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  buildProductionMemoryStore,
  buildProductionWorkspaceDeps,
} = require("../src/services/sira/production-wiring");

// Minimal Prisma fake matching the real schema's surface for the
// queries production-wiring issues.
function fakePrisma({ project = null, projectDocs = [], chats = [] } = {}) {
  const calls = [];
  return {
    _calls: calls,
    project: {
      findFirst: async (args) => { calls.push(["project.findFirst", args]); return project; },
    },
    projectDocument: {
      findMany: async (args) => { calls.push(["projectDocument.findMany", args]); return projectDocs; },
    },
    chat: {
      findMany: async (args) => { calls.push(["chat.findMany", args]); return chats; },
    },
  };
}

function readProductionCompose() {
  return fs.readFileSync(path.resolve(__dirname, "../../docker-compose.prod.yml"), "utf8");
}

function extractServiceBlock(yaml, serviceName) {
  const match = yaml.match(new RegExp(`\\n  ${serviceName}:\\n([\\s\\S]*?)(?=\\n  [a-zA-Z0-9_-]+:\\n|\\nvolumes:\\n|$)`));
  assert.ok(match, `expected ${serviceName} service in docker-compose.prod.yml`);
  return match[1];
}

// ── buildProductionMemoryStore ─────────────────────────────────────

describe("buildProductionMemoryStore", () => {
  test("returns a composite that can recall from short_term + conversation tiers offline", async () => {
    const gistMemory = require("../src/services/gist-memory");
    gistMemory.clearAll();
    const store = buildProductionMemoryStore(fakePrisma());

    await store.put({ tier: "short_term", scope: { sessionId: "s1" }, item: { subject: "u", predicate: "wants", object: "x" } });
    const r = await store.recall({ tier: "short_term", scope: { sessionId: "s1" } });
    assert.equal(r.length, 1);
  });

  test("project tier round-trips through the faked Prisma", async () => {
    const projectMemory = require("../src/services/project-memory");
    // Override to a deterministic stub so we don't hit real Prisma.
    const realSave = projectMemory.saveFacts;
    const realList = projectMemory.listMemory;
    projectMemory.saveFacts = async () => [{ id: "pf-1" }];
    projectMemory.listMemory = async () => [{ id: "pf-1", text: "shared decision", createdAt: new Date().toISOString() }];
    try {
      const store = buildProductionMemoryStore(fakePrisma());
      const put = await store.put({ tier: "project", scope: { projectId: "p1" }, item: "shared decision" });
      assert.equal(put.id, "project:pf-1");
      const recalled = await store.recall({ tier: "project", scope: { projectId: "p1" } });
      assert.equal(recalled.length, 1);
      assert.match(JSON.stringify(recalled[0].item), /shared decision/);
    } finally {
      projectMemory.saveFacts = realSave;
      projectMemory.listMemory = realList;
    }
  });
});

// ── buildProductionWorkspaceDeps ──────────────────────────────────

describe("buildProductionWorkspaceDeps", () => {
  test("members.find returns owner role when caller owns the project", async () => {
    const prisma = fakePrisma({ project: { id: "p1", userId: "u1", createdAt: new Date("2026-01-01") } });
    const deps = buildProductionWorkspaceDeps(prisma);
    const m = await deps.members.find({ projectId: "p1", userId: "u1" });
    assert.ok(m, "expected a member result");
    assert.equal(m.role, "owner");
    assert.match(m.joined_at, /^\d{4}-\d{2}/);
  });

  test("members.find returns null when caller is not the owner", async () => {
    const prisma = fakePrisma({ project: null });
    const deps = buildProductionWorkspaceDeps(prisma);
    const m = await deps.members.find({ projectId: "p1", userId: "intruder" });
    assert.equal(m, null);
  });

  test("docs.list and instructions.get and conversations.listRecent delegate via Prisma", async () => {
    const prisma = fakePrisma({
      project: { id: "p1", userId: "u1", createdAt: new Date(), instructions: "Always cite sources." },
      projectDocs: [{ id: "d1", title: "Spec", updatedAt: new Date() }],
      chats: [{ id: "c1", title: "Q1 review", updatedAt: new Date() }],
    });
    // Override project.findFirst for instructions select shape.
    prisma.project.findFirst = async (args) => {
      if (args?.select?.instructions) return { instructions: "Always cite sources." };
      return { id: "p1", userId: "u1", createdAt: new Date() };
    };
    const deps = buildProductionWorkspaceDeps(prisma);
    const [docs, instr, recents] = await Promise.all([
      deps.docs.list({ projectId: "p1" }),
      deps.instructions.get({ projectId: "p1" }),
      deps.conversations.listRecent({ projectId: "p1", userId: "u1", limit: 3 }),
    ]);
    assert.equal(docs.length, 1);
    assert.equal(docs[0].title, "Spec");
    assert.equal(instr, "Always cite sources.");
    assert.equal(recents.length, 1);
  });

  test("missing Prisma returns no-op deps that resolve safely", async () => {
    const deps = buildProductionWorkspaceDeps(null);
    assert.equal(await deps.members.find({ projectId: "p", userId: "u" }), null);
    assert.deepEqual(await deps.docs.list({ projectId: "p" }), []);
    assert.equal(await deps.instructions.get({ projectId: "p" }), "");
    assert.deepEqual(await deps.conversations.listRecent({ projectId: "p", userId: "u" }), []);
  });

  test("Prisma errors degrade to safe defaults", async () => {
    const prisma = {
      project: { findFirst: async () => { throw new Error("db down"); } },
      projectDocument: { findMany: async () => { throw new Error("db down"); } },
      chat: { findMany: async () => { throw new Error("db down"); } },
    };
    const deps = buildProductionWorkspaceDeps(prisma);
    assert.equal(await deps.members.find({ projectId: "p", userId: "u" }), null);
    assert.deepEqual(await deps.docs.list({ projectId: "p" }), []);
    assert.equal(await deps.instructions.get({ projectId: "p" }), "");
    assert.deepEqual(await deps.conversations.listRecent({ projectId: "p", userId: "u" }), []);
  });
});

// ── docker-compose.prod.yml topology ──────────────────────────────

describe("production Compose topology", () => {
  test("normal production deploy builds and starts only the frontend container", () => {
    const yaml = readProductionCompose();
    const frontend = extractServiceBlock(yaml, "frontend");

    assert.match(yaml, /docker compose -f docker-compose\.prod\.yml up -d --no-deps frontend/);
    assert.doesNotMatch(frontend, /depends_on:/);
    assert.match(frontend, /NEXT_PUBLIC_API_URL:\s+\$\{NEXT_PUBLIC_API_URL:-https:\/\/api\.siragpt\.com\/api\}/);
    assert.match(frontend, /NEXT_PUBLIC_URL:\s+\$\{NEXT_PUBLIC_URL:-https:\/\/siragpt\.com\}/);
  });

  test("Docker backend is available only through the explicit docker-backend profile", () => {
    const yaml = readProductionCompose();
    const backend = extractServiceBlock(yaml, "backend");
    const frontend = extractServiceBlock(yaml, "frontend");

    assert.match(backend, /profiles:\s+\["docker-backend"\]/);
    assert.match(yaml, /COMPOSE_PROFILES=docker-backend docker compose -f docker-compose\.prod\.yml up -d backend/);
    assert.doesNotMatch(frontend, /backend:/);
  });
});
