/**
 * storage-schema — Sira's persistence layer (MASTER_SPEC §26).
 *
 * 7 tables capture every step of an agentic run for replay,
 * compliance and observability:
 *
 *   sira_conversations       — top-level conversation
 *   sira_messages            — per-turn role + content + selected_model
 *   sira_task_envelopes      — full Sira Cognitive Task Envelope per request
 *   sira_tool_calls          — every tool invocation with input/output/status
 *   sira_artifacts           — every file/preview rendered
 *   sira_validation_reports  — overall_score + ready_to_deliver + checks
 *   sira_audit_logs          — append-only event stream
 *
 * Two surfaces ship out of the box:
 *
 *   1. SCHEMA_DDL — Postgres-shaped CREATE TABLE statements ready
 *      to feed Prisma migrate / sqlx / a hand-rolled migrator.
 *
 *   2. createInMemoryStorage() — a deterministic adapter implementing
 *      the StorageAdapter contract so the platform works zero-deps.
 *
 * The contract is identical regardless of backend; production swaps
 * the adapter via createSiraStorage({ adapter }).
 *
 * Pure JS, deterministic, zero deps.
 */

const SCHEMA_DDL = Object.freeze({
  sira_conversations: `
    CREATE TABLE IF NOT EXISTS sira_conversations (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      title       TEXT,
      created_at  TIMESTAMP DEFAULT NOW(),
      updated_at  TIMESTAMP DEFAULT NOW()
    );
  `,
  sira_messages: `
    CREATE TABLE IF NOT EXISTS sira_messages (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role            TEXT NOT NULL CHECK (role IN ('system','user','assistant','tool')),
      content         JSONB NOT NULL,
      selected_model  JSONB,
      created_at      TIMESTAMP DEFAULT NOW(),
      FOREIGN KEY (conversation_id) REFERENCES sira_conversations(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_sira_messages_conv ON sira_messages(conversation_id);
  `,
  sira_task_envelopes: `
    CREATE TABLE IF NOT EXISTS sira_task_envelopes (
      id              TEXT PRIMARY KEY,
      request_id      TEXT NOT NULL UNIQUE,
      conversation_id TEXT,
      user_id         TEXT,
      envelope        JSONB NOT NULL,
      created_at      TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_sira_envelopes_user ON sira_task_envelopes(user_id);
    CREATE INDEX IF NOT EXISTS idx_sira_envelopes_conv ON sira_task_envelopes(conversation_id);
  `,
  sira_tool_calls: `
    CREATE TABLE IF NOT EXISTS sira_tool_calls (
      id          TEXT PRIMARY KEY,
      request_id  TEXT NOT NULL,
      tool_name   TEXT NOT NULL,
      input       JSONB NOT NULL,
      output      JSONB,
      status      TEXT NOT NULL CHECK (status IN ('success','error','requires_confirmation','skipped_dry_run')),
      error       JSONB,
      started_at  TIMESTAMP,
      finished_at TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_sira_tool_calls_req ON sira_tool_calls(request_id);
  `,
  sira_artifacts: `
    CREATE TABLE IF NOT EXISTS sira_artifacts (
      id                TEXT PRIMARY KEY,
      request_id        TEXT NOT NULL,
      user_id           TEXT,
      artifact_type     TEXT NOT NULL,
      format            TEXT NOT NULL,
      filename          TEXT NOT NULL,
      storage_url       TEXT NOT NULL,
      preview_url       TEXT,
      validation_status TEXT,
      metadata          JSONB,
      created_at        TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_sira_artifacts_req ON sira_artifacts(request_id);
    CREATE INDEX IF NOT EXISTS idx_sira_artifacts_user ON sira_artifacts(user_id);
  `,
  sira_validation_reports: `
    CREATE TABLE IF NOT EXISTS sira_validation_reports (
      id                TEXT PRIMARY KEY,
      request_id        TEXT NOT NULL,
      overall_score     NUMERIC,
      ready_to_deliver  BOOLEAN,
      checks            JSONB NOT NULL,
      created_at        TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_sira_validation_req ON sira_validation_reports(request_id);
  `,
  sira_audit_logs: `
    CREATE TABLE IF NOT EXISTS sira_audit_logs (
      id          TEXT PRIMARY KEY,
      request_id  TEXT,
      user_id     TEXT,
      event_type  TEXT NOT NULL,
      payload     JSONB,
      created_at  TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_sira_audit_req ON sira_audit_logs(request_id);
    CREATE INDEX IF NOT EXISTS idx_sira_audit_user_event ON sira_audit_logs(user_id, event_type);
  `,
});

const TABLES = Object.freeze(Object.keys(SCHEMA_DDL));

/**
 * StorageAdapter contract — a backend that implements these methods
 * can be plugged into createSiraStorage().
 */
const STORAGE_METHODS = Object.freeze([
  "createConversation", "appendMessage", "saveEnvelope",
  "recordToolCall", "saveArtifact", "saveValidationReport",
  "appendAudit", "getEnvelope", "getRunStatus",
  "listConversationMessages", "listArtifactsForRequest",
]);

function createInMemoryStorage() {
  const conversations = new Map();
  const messages = [];
  const envelopes = new Map();           // request_id → envelope
  const toolCalls = [];
  const artifacts = [];
  const reports = [];
  const audit = [];

  return {
    async createConversation({ id, userId, title }) {
      if (!id || !userId) throw err("missing_args", "id+userId required");
      conversations.set(id, { id, user_id: userId, title: title || null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      return { id };
    },
    async appendMessage({ id, conversationId, role, content, selectedModel = null }) {
      if (!id || !conversationId || !role) throw err("missing_args", "id+conversationId+role required");
      messages.push({ id, conversation_id: conversationId, role, content, selected_model: selectedModel, created_at: new Date().toISOString() });
      return { id };
    },
    async saveEnvelope({ id, requestId, conversationId, userId, envelope }) {
      if (!id || !requestId || !envelope) throw err("missing_args", "id+requestId+envelope required");
      envelopes.set(requestId, { id, request_id: requestId, conversation_id: conversationId, user_id: userId, envelope, created_at: new Date().toISOString() });
      return { id, requestId };
    },
    async recordToolCall({ id, requestId, toolName, input, output = null, status, error = null, startedAt = null, finishedAt = null }) {
      if (!id || !requestId || !toolName || !status) throw err("missing_args", "id+requestId+toolName+status required");
      toolCalls.push({ id, request_id: requestId, tool_name: toolName, input, output, status, error, started_at: startedAt, finished_at: finishedAt });
      return { id };
    },
    async saveArtifact({ id, requestId, userId, artifactType, format, filename, storageUrl, previewUrl = null, validationStatus = "pending", metadata = {} }) {
      if (!id || !requestId || !filename || !storageUrl) throw err("missing_args", "id+requestId+filename+storageUrl required");
      artifacts.push({ id, request_id: requestId, user_id: userId, artifact_type: artifactType, format, filename, storage_url: storageUrl, preview_url: previewUrl, validation_status: validationStatus, metadata, created_at: new Date().toISOString() });
      return { id };
    },
    async saveValidationReport({ id, requestId, overallScore, readyToDeliver, checks }) {
      if (!id || !requestId) throw err("missing_args", "id+requestId required");
      reports.push({ id, request_id: requestId, overall_score: overallScore, ready_to_deliver: Boolean(readyToDeliver), checks, created_at: new Date().toISOString() });
      return { id };
    },
    async appendAudit({ id, requestId = null, userId = null, eventType, payload = null }) {
      if (!id || !eventType) throw err("missing_args", "id+eventType required");
      audit.push({ id, request_id: requestId, user_id: userId, event_type: eventType, payload, created_at: new Date().toISOString() });
      return { id };
    },
    async getEnvelope(requestId) {
      const r = envelopes.get(requestId);
      return r ? { ...r } : null;
    },
    async getRunStatus(requestId) {
      const tools = toolCalls.filter(t => t.request_id === requestId);
      const artifactsForRun = artifacts.filter(a => a.request_id === requestId);
      const report = reports.filter(r => r.request_id === requestId).slice(-1)[0] || null;
      return {
        request_id: requestId,
        tool_calls: tools.length,
        artifacts: artifactsForRun.length,
        validation_ready: Boolean(report?.ready_to_deliver),
        validation_score: report?.overall_score ?? null,
        last_updated: tools.concat(artifactsForRun).map(x => x.created_at || x.finished_at || x.started_at).filter(Boolean).sort().slice(-1)[0] || null,
      };
    },
    async listConversationMessages(conversationId, { limit = 50 } = {}) {
      return messages.filter(m => m.conversation_id === conversationId).slice(-limit);
    },
    async listArtifactsForRequest(requestId) {
      return artifacts.filter(a => a.request_id === requestId);
    },

    /** test/debug counters */
    counts() {
      return {
        conversations: conversations.size,
        messages: messages.length,
        envelopes: envelopes.size,
        tool_calls: toolCalls.length,
        artifacts: artifacts.length,
        validation_reports: reports.length,
        audit_logs: audit.length,
      };
    },
  };
}

/**
 * Public façade — wraps any adapter that implements STORAGE_METHODS
 * and adds id-generation + clock injection.
 */
function createSiraStorage({ adapter = createInMemoryStorage(), idFactory = defaultIdFactory } = {}) {
  validateAdapter(adapter);
  return {
    adapter,
    async startConversation({ userId, title }) {
      const id = idFactory("conv");
      await adapter.createConversation({ id, userId, title });
      return id;
    },
    async addMessage({ conversationId, role, content, selectedModel }) {
      const id = idFactory("msg");
      await adapter.appendMessage({ id, conversationId, role, content, selectedModel });
      return id;
    },
    async persistEnvelope({ envelope, conversationId, userId }) {
      const id = idFactory("env");
      await adapter.saveEnvelope({ id, requestId: envelope.request_id, conversationId, userId, envelope });
      return id;
    },
    async recordToolCall(args) {
      const id = idFactory("tool");
      await adapter.recordToolCall({ id, ...args });
      return id;
    },
    async persistArtifact(args) {
      const id = idFactory("art");
      await adapter.saveArtifact({ id, ...args });
      return id;
    },
    async persistValidation(args) {
      const id = idFactory("val");
      await adapter.saveValidationReport({ id, ...args });
      return id;
    },
    async audit(eventType, payload, ctx = {}) {
      const id = idFactory("audit");
      await adapter.appendAudit({ id, requestId: ctx.requestId, userId: ctx.userId, eventType, payload });
      return id;
    },
    getEnvelope: (id) => adapter.getEnvelope(id),
    getRunStatus: (id) => adapter.getRunStatus(id),
    listConversationMessages: (id, opts) => adapter.listConversationMessages(id, opts),
    listArtifactsForRequest: (id) => adapter.listArtifactsForRequest(id),
    counts: typeof adapter.counts === "function" ? () => adapter.counts() : null,
  };
}

function validateAdapter(adapter) {
  for (const m of STORAGE_METHODS) {
    if (typeof adapter[m] !== "function") {
      throw err("invalid_adapter", `storage adapter is missing method ${m}()`);
    }
  }
}

function defaultIdFactory(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`;
}

// Codes preserved verbatim (e.g. "missing_args", "invalid_adapter")
// so tests and log queries that index on `err.code` continue to work.
// The class hop (Error → StorageError) lights up the audit log + the
// route's error handler with a structured payload.
function err(code, message) {
  const { StorageError } = require("./pipeline-errors");
  return new StorageError({ code, message });
}

module.exports = {
  SCHEMA_DDL,
  TABLES,
  STORAGE_METHODS,
  createInMemoryStorage,
  createSiraStorage,
};
