/**
 * project-workspace — typed contract for "Cada proyecto tendría sus
 * propios documentos, instrucciones, memoria, permisos y
 * conversaciones."  Closes the project-workspace item from the
 * expanded vision (task 12).
 *
 * Why this exists
 * ---------------
 * `services/projects-service.ts` and `services/project-memory.js`
 * already exist and own the persistence side. What was missing was
 * the *load-once-per-turn* contract that the chat-controller can
 * call to get a fully-resolved workspace for a user, with all five
 * facets (docs, instructions, memory_scope, permissions,
 * conversations) shaped the same way every time.
 *
 *   loadProjectContext({ projectId, userId, deps })
 *      → ProjectWorkspaceContext
 *
 * Same pattern as task 7/9/10/11: contract first, integration into
 * task-envelope-builder / chat-controller in a follow-up. This commit
 * defines the shape, the loader signature, and the access-control
 * decision (`canAccess`) — nothing more.
 *
 * Permission model
 * ----------------
 * Three roles, each strictly more permissive than the previous:
 *   - viewer     — read docs, conversations; no writes; no tool actions
 *   - editor     — viewer + edit docs + start conversations + run
 *                  read-only tools (RAG, web_search)
 *   - owner      — editor + manage members + change instructions +
 *                  run side-effecting tools (publish, send_message)
 *
 * Permissions are a *set* of capability strings; roles are a
 * convenience name for a canonical set. Callers compose by either
 * ("role:editor") or by capability ("docs:write", "tools:run_external").
 */

const VALID_ROLES = Object.freeze(["viewer", "editor", "owner"]);

const ROLE_CAPABILITIES = Object.freeze({
  viewer: Object.freeze([
    "docs:read",
    "conversations:read",
    "memory:read",
  ]),
  editor: Object.freeze([
    "docs:read", "docs:write",
    "conversations:read", "conversations:write",
    "memory:read", "memory:write",
    "tools:run_readonly",
  ]),
  owner: Object.freeze([
    "docs:read", "docs:write", "docs:delete",
    "conversations:read", "conversations:write", "conversations:delete",
    "memory:read", "memory:write", "memory:delete",
    "tools:run_readonly", "tools:run_external",
    "instructions:write",
    "members:manage",
  ]),
});

class ProjectAccessError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProjectAccessError";
    this.code = code;
  }
}

function validateProjectId(id) {
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new ProjectAccessError("project.invalid_id", "projectId must be a non-empty string");
  }
}

function validateUserId(id) {
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new ProjectAccessError("project.invalid_user", "userId must be a non-empty string");
  }
}

function capabilitiesForRole(role) {
  if (!VALID_ROLES.includes(role)) return [];
  return [...ROLE_CAPABILITIES[role]];
}

/**
 * Decide if a member with the given role/capabilities can perform
 * `capability` (e.g. "docs:write", "tools:run_external"). Honors
 * either explicit capability list or role expansion.
 *
 * @param {{ role?: string, capabilities?: string[] }} member
 * @param {string} capability
 * @returns {boolean}
 */
function canAccess(member, capability) {
  if (!member || typeof capability !== "string") return false;
  if (Array.isArray(member.capabilities) && member.capabilities.includes(capability)) return true;
  if (member.role && ROLE_CAPABILITIES[member.role]?.includes(capability)) return true;
  return false;
}

/**
 * Resolve the per-turn workspace context for a member. Throws
 * `ProjectAccessError("project.forbidden")` when the user is not
 * a member of the project.
 *
 * Adapters can be passed as `deps`; each one returns plain JSON.
 * Defaults are no-ops returning empty data so this loader runs
 * offline. Production wires:
 *
 *   deps.docs.list({ projectId })
 *   deps.instructions.get({ projectId })
 *   deps.members.find({ projectId, userId })
 *   deps.conversations.listRecent({ projectId, userId, limit })
 *   deps.memory.scope({ projectId, userId })  // returns memory-store scope
 *
 * @param {object} args
 * @param {string} args.projectId
 * @param {string} args.userId
 * @param {object} [args.deps]
 * @param {number} [args.recentConversationLimit=10]
 * @returns {Promise<{
 *   project_id, user_id, member, capabilities, instructions,
 *   docs, recent_conversations, memory_scope, schema_version
 * }>}
 */
async function loadProjectContext({
  projectId,
  userId,
  deps = {},
  recentConversationLimit = 10,
} = {}) {
  validateProjectId(projectId);
  validateUserId(userId);

  const member = deps.members && typeof deps.members.find === "function"
    ? await deps.members.find({ projectId, userId })
    : null;

  if (!member) {
    throw new ProjectAccessError(
      "project.forbidden",
      `user ${userId} is not a member of project ${projectId}`,
    );
  }

  const capabilities = Array.isArray(member.capabilities) && member.capabilities.length > 0
    ? [...member.capabilities]
    : capabilitiesForRole(member.role);

  const [instructions, docs, recentConversations, memoryScope] = await Promise.all([
    deps.instructions && typeof deps.instructions.get === "function"
      ? deps.instructions.get({ projectId })
      : Promise.resolve(""),
    deps.docs && typeof deps.docs.list === "function"
      ? deps.docs.list({ projectId })
      : Promise.resolve([]),
    deps.conversations && typeof deps.conversations.listRecent === "function"
      ? deps.conversations.listRecent({ projectId, userId, limit: recentConversationLimit })
      : Promise.resolve([]),
    deps.memory && typeof deps.memory.scope === "function"
      ? deps.memory.scope({ projectId, userId })
      : Promise.resolve({ projectId }),
  ]);

  return {
    schema_version: "sira.project_workspace_context.v1",
    project_id: projectId,
    user_id: userId,
    member: {
      role: member.role || null,
      joined_at: member.joined_at || null,
    },
    capabilities,
    instructions: typeof instructions === "string" ? instructions : "",
    docs: Array.isArray(docs) ? docs : [],
    recent_conversations: Array.isArray(recentConversations) ? recentConversations : [],
    memory_scope: memoryScope || { projectId },
  };
}

/**
 * Validate a `ProjectWorkspaceContext` produced elsewhere (cached,
 * persisted, or hand-built). Returns `{ ok, errors[] }`.
 */
function validateProjectContext(ctx) {
  const errors = [];
  if (!ctx || typeof ctx !== "object") return { ok: false, errors: ["context must be an object"] };
  if (ctx.schema_version !== "sira.project_workspace_context.v1") errors.push("schema_version must be sira.project_workspace_context.v1");
  if (typeof ctx.project_id !== "string" || !ctx.project_id) errors.push("project_id required");
  if (typeof ctx.user_id !== "string" || !ctx.user_id) errors.push("user_id required");
  if (!Array.isArray(ctx.capabilities)) errors.push("capabilities must be an array");
  if (!Array.isArray(ctx.docs)) errors.push("docs must be an array");
  if (!Array.isArray(ctx.recent_conversations)) errors.push("recent_conversations must be an array");
  if (typeof ctx.instructions !== "string") errors.push("instructions must be a string");
  return { ok: errors.length === 0, errors };
}

module.exports = {
  VALID_ROLES,
  ROLE_CAPABILITIES,
  ProjectAccessError,
  capabilitiesForRole,
  canAccess,
  loadProjectContext,
  validateProjectContext,
};
