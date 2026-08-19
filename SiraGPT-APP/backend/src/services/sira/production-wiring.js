/**
 * production-wiring — convenience factory that hands the route layer
 * a fully-assembled MemoryStore + projectWorkspaceDeps. Closes
 * task 27 from the integration backlog.
 *
 * Until this commit, the chat-controller accepted these deps but the
 * route layer (`routes/enterprise.js`) wasn't passing anything, so
 * the in-process defaults applied (no recall, no project context).
 * After this commit, production traffic exercises the real
 * gist-memory / long-term-memory / project-memory modules + Prisma
 * project queries through the unified contract.
 *
 * Why a separate module
 * ---------------------
 * - One place to wire all five memory tier adapters; the route
 *   stays uncluttered.
 * - One place to translate `Project` (single-owner today) into the
 *   `member` shape `loadProjectContext` expects.
 * - When the schema gains `ProjectMember` for multi-tenant projects
 *   in the future, the swap happens here without touching the
 *   route or the chat-controller.
 *
 * The factory is a function (not a singleton) because:
 *   - tests need a fresh wiring per case to assert calls,
 *   - `prisma` may be a fake in unit tests but the real client in
 *     production.
 */

const memoryStoreApi = require("./memory-store");
const adapters = require("./memory-store-adapters");

/**
 * Build the composite MemoryStore. The real modules are required
 * inline so this module can be loaded without Prisma being on the
 * classpath (tests pass fakes; production passes the real client).
 *
 * @param {object} prisma — PrismaClient (or a fake with the same
 *                          shape for tests).
 * @returns MemoryStore-shaped object: { put, recall, forget, stats }.
 */
function buildProductionMemoryStore(prisma) {
  const gistMemory = require("../gist-memory");
  const longTermMemory = require("../long-term-memory");
  const projectMemory = require("../project-memory");

  return memoryStoreApi.createCompositeStore({
    short_term: adapters.createShortTermAdapter({ gistMemory }),
    semantic: adapters.createSemanticAdapter({ longTermMemory }),
    project: adapters.createProjectAdapter({ projectMemory, prisma }),
    conversation: adapters.createConversationAdapter(),
    user: adapters.createUserAdapter(),
  });
}

/**
 * Build the project-workspace deps. The current Prisma schema is
 * single-owner (Project.userId), so membership is simply "is the
 * caller the owner?". When multi-tenant ProjectMember lands, this
 * adapter is the one place that needs to change — the contract
 * stays the same.
 *
 * @param {object} prisma — PrismaClient.
 * @returns deps shape: { members, docs, instructions, conversations, memory }.
 */
function buildProductionWorkspaceDeps(prisma) {
  if (!prisma || typeof prisma.project?.findFirst !== "function") {
    // Without Prisma we can't answer membership questions. Returning
    // an explicit no-op deps shape (every method present, every
    // method returning the empty result) lets `loadProjectContext`
    // run without throwing — the chat-controller will then degrade
    // to project_forbidden for any projectId because no member is
    // found.
    return {
      members: { find: async () => null },
      docs: { list: async () => [] },
      instructions: { get: async () => "" },
      conversations: { listRecent: async () => [] },
      memory: { scope: async ({ projectId, userId }) => ({ projectId, userId }) },
    };
  }

  return {
    members: {
      // Single-owner today: membership = ownership. A future
      // ProjectMember model swaps this query without changing the
      // returned shape.
      find: async ({ projectId, userId }) => {
        try {
          const p = await prisma.project.findFirst({
            where: { id: projectId, userId },
            select: { id: true, userId: true, createdAt: true },
          });
          if (!p) return null;
          return { role: "owner", joined_at: p.createdAt ? new Date(p.createdAt).toISOString() : null };
        } catch (_e) { return null; }
      },
    },
    docs: {
      list: async ({ projectId }) => {
        try {
          const rows = await prisma.projectDocument.findMany({
            where: { projectId },
            select: { id: true, title: true, updatedAt: true },
            orderBy: { updatedAt: "desc" },
            take: 50,
          });
          return rows || [];
        } catch (_e) { return []; }
      },
    },
    instructions: {
      get: async ({ projectId }) => {
        try {
          const p = await prisma.project.findFirst({
            where: { id: projectId },
            select: { instructions: true },
          });
          return p?.instructions || "";
        } catch (_e) { return ""; }
      },
    },
    conversations: {
      listRecent: async ({ projectId, userId, limit = 10 }) => {
        try {
          // Chat has an optional projectId field per the schema.
          if (typeof prisma.chat?.findMany !== "function") return [];
          const rows = await prisma.chat.findMany({
            where: { projectId, userId },
            select: { id: true, title: true, updatedAt: true },
            orderBy: { updatedAt: "desc" },
            take: Math.max(1, Number(limit) || 10),
          });
          return rows || [];
        } catch (_e) { return []; }
      },
    },
    memory: {
      scope: async ({ projectId, userId }) => ({ projectId, userId, tier: "project" }),
    },
  };
}

module.exports = {
  buildProductionMemoryStore,
  buildProductionWorkspaceDeps,
};
