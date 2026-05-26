/**
 * pipeline-errors — stage-aware error taxonomy for the Sira chat
 * pipeline. Closes gap §14.2 in docs/architecture/PIPELINE.md.
 *
 * Why this exists
 * ---------------
 * Every thrown Error in the pipeline today is a plain `Error` with a
 * string message. That is fine for crashes but hostile for observability:
 *   - support cannot tell from a log whether the failure was the
 *     envelope, a tool, the validator, or the stream.
 *   - the audit log cannot attach a structured error payload to an
 *     event because there is no schema.
 *   - the route handler cannot pick an HTTP status without parsing
 *     the message string.
 *
 * What this module provides
 * -------------------------
 *   - `SiraPipelineError` — base class. Every pipeline error must be
 *     an instance of (or wrappable into) this class.
 *   - one subclass per pipeline stage (`IngressError`, `BudgetError`,
 *     `EnvelopeError`, `PolicyError`, `ContextError`, `RAGError`,
 *     `ToolError`, `ValidatorError`, `StreamError`, `StorageError`)
 *     with a fixed `stage`, default `httpStatus`, and `code` namespace.
 *   - `wrapAsSiraError(err, defaults)` — promote any thrown value into
 *     a SiraPipelineError without losing the original cause. Idempotent.
 *   - `toHttpResponse(err)` — `{ status, body: { ... } }` for routes.
 *   - `toAuditPayload(err)` — content-free payload for `sira_audit_logs`.
 *   - `redactDetails(obj)` — strips fields that may carry PII or raw
 *     prompts before they leave the process.
 *   - `STAGES` — canonical list of pipeline stages, kept in sync with
 *     PIPELINE.md §3.
 *
 * Migration note
 * --------------
 * This module is purely additive. Existing `throw new Error(...)` sites
 * keep working; routes can opt-in stage by stage. The first migrated
 * site is `chat-controller` input validation (see chat-controller.js).
 */

const STAGES = Object.freeze([
  "ingress",            // HTTP boundary: auth, request validation, deserialization
  "token_budget",       // assessTokenBudget preflight
  "envelope",           // task-envelope-builder + schema validation
  "policy",             // clarification + safety policy evaluation
  "context",            // context window, memory, compaction
  "rag",                // hybrid retrieval, reranker
  "tool",               // tool registry, policy, resilience, dispatch
  "validator",          // validator-engine
  "stream",             // SSE / response delivery
  "storage",            // sira_messages / sira_audit_logs / sira_artifacts
  "pre_pipeline",       // anything that fires before stages above (server boot, config)
]);

// Fields that must never appear in HTTP bodies, audit payloads, or logs
// emitted by `toAuditPayload` / `toHttpResponse`. Caller can extend this
// per route via `redactDetails(obj, { extraKeys: [...] })`.
const SENSITIVE_KEY_PATTERNS = [
  /^prompt$/i,
  /^user_message$/i,
  /^message$/i,
  /^content$/i,
  /^attachments?$/i,
  /^history$/i,
  /^token$/i,
  /^secret$/i,
  /^password$/i,
  /^authorization$/i,
  /^api[_-]?key$/i,
  /^cookie$/i,
  /^email$/i,
  /^phone$/i,
];

class SiraPipelineError extends Error {
  /**
   * @param {object} args
   * @param {string} args.code        — dot-namespaced (e.g. "ingress.invalid_request").
   * @param {string} args.message     — human-readable, safe to log.
   * @param {object} [args.details]   — structured context. Sensitive keys are
   *                                    stripped by toAuditPayload / toHttpResponse.
   * @param {Error}  [args.cause]     — original error, if wrapping.
   * @param {string} [args.requestId] — HTTP `X-Request-Id`, threaded from middleware.
   * @param {number} [args.httpStatus] — overrides the subclass default.
   * @param {boolean} [args.retryable] — informational; `tool-resilience` reads this.
   */
  constructor({ code, message, details = null, cause = null, requestId = null, httpStatus = null, retryable = false } = {}) {
    super(message || code || "sira.pipeline_error");
    this.name = this.constructor.name;
    this.code = code || "sira.unknown";
    this.stage = this.constructor.STAGE || "pre_pipeline";
    this.details = details && typeof details === "object" ? details : null;
    this.cause = cause || null;
    this.requestId = requestId;
    this.httpStatus = Number.isFinite(httpStatus) ? httpStatus : (this.constructor.DEFAULT_HTTP_STATUS || 500);
    this.retryable = Boolean(retryable);
    // Capture stack from the throw site; fall back gracefully if V8 isn't around.
    if (typeof Error.captureStackTrace === "function") {
      Error.captureStackTrace(this, this.constructor);
    }
  }
  /** Plain-object form, safe to JSON.stringify. */
  toJSON() {
    return {
      name: this.name,
      code: this.code,
      stage: this.stage,
      message: this.message,
      request_id: this.requestId || null,
      http_status: this.httpStatus,
      retryable: this.retryable,
      details: redactDetails(this.details),
      cause: this.cause && this.cause.message ? { message: this.cause.message, name: this.cause.name } : null,
    };
  }
}

// ── One subclass per stage. STAGE + DEFAULT_HTTP_STATUS are static fields
//    consumed by the base constructor; subclasses do not override behavior.

class IngressError extends SiraPipelineError {}
IngressError.STAGE = "ingress";
IngressError.DEFAULT_HTTP_STATUS = 400;

class BudgetError extends SiraPipelineError {}
BudgetError.STAGE = "token_budget";
BudgetError.DEFAULT_HTTP_STATUS = 429;

class EnvelopeError extends SiraPipelineError {}
EnvelopeError.STAGE = "envelope";
EnvelopeError.DEFAULT_HTTP_STATUS = 422;

class PolicyError extends SiraPipelineError {}
PolicyError.STAGE = "policy";
PolicyError.DEFAULT_HTTP_STATUS = 451;

class ContextError extends SiraPipelineError {}
ContextError.STAGE = "context";
ContextError.DEFAULT_HTTP_STATUS = 500;

class RAGError extends SiraPipelineError {}
RAGError.STAGE = "rag";
RAGError.DEFAULT_HTTP_STATUS = 502;

class ToolError extends SiraPipelineError {}
ToolError.STAGE = "tool";
ToolError.DEFAULT_HTTP_STATUS = 502;

class ValidatorError extends SiraPipelineError {}
ValidatorError.STAGE = "validator";
ValidatorError.DEFAULT_HTTP_STATUS = 422;

class StreamError extends SiraPipelineError {}
StreamError.STAGE = "stream";
StreamError.DEFAULT_HTTP_STATUS = 500;

class StorageError extends SiraPipelineError {}
StorageError.STAGE = "storage";
StorageError.DEFAULT_HTTP_STATUS = 500;

const STAGE_TO_CLASS = Object.freeze({
  ingress: IngressError,
  token_budget: BudgetError,
  envelope: EnvelopeError,
  policy: PolicyError,
  context: ContextError,
  rag: RAGError,
  tool: ToolError,
  validator: ValidatorError,
  stream: StreamError,
  storage: StorageError,
});

/**
 * Promote any thrown value into a SiraPipelineError. Already-tagged
 * errors are returned untouched (so `requestId` and `cause` aren't
 * wrapped twice). Anything else is wrapped at the supplied stage.
 *
 * @param {*} err
 * @param {object} [defaults]
 * @param {string} [defaults.stage="pre_pipeline"]
 * @param {string} [defaults.code]
 * @param {string} [defaults.requestId]
 * @returns {SiraPipelineError}
 */
function wrapAsSiraError(err, defaults = {}) {
  if (err instanceof SiraPipelineError) {
    if (defaults.requestId && !err.requestId) err.requestId = defaults.requestId;
    return err;
  }
  const Cls = STAGE_TO_CLASS[defaults.stage] || SiraPipelineError;
  return new Cls({
    code: defaults.code || `${defaults.stage || "pre_pipeline"}.unhandled`,
    message: (err && err.message) ? String(err.message) : "unhandled pipeline error",
    cause: err instanceof Error ? err : null,
    requestId: defaults.requestId || null,
    httpStatus: defaults.httpStatus || null,
  });
}

/**
 * Strip keys that may carry PII / raw prompts / credentials. Returns a
 * new object; the input is left untouched. Arrays preserve order; nested
 * objects are recursed.
 */
function redactDetails(details, { extraKeys = [] } = {}) {
  if (details == null) return null;
  const extras = extraKeys.map((k) => new RegExp(`^${k}$`, "i"));
  return _redact(details, [...SENSITIVE_KEY_PATTERNS, ...extras]);
}

function _redact(value, patterns) {
  if (Array.isArray(value)) return value.map((v) => _redact(v, patterns));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (patterns.some((rx) => rx.test(k))) {
        out[k] = "[redacted]";
      } else {
        out[k] = _redact(v, patterns);
      }
    }
    return out;
  }
  return value;
}

/**
 * Map a SiraPipelineError (or anything wrappable) to an HTTP response.
 * The body never includes the original cause's message — only the
 * pipeline-error message — so internal error strings cannot leak.
 */
function toHttpResponse(err) {
  const tagged = wrapAsSiraError(err);
  return {
    status: tagged.httpStatus,
    body: {
      error: {
        code: tagged.code,
        stage: tagged.stage,
        message: tagged.message,
        request_id: tagged.requestId || null,
        retryable: tagged.retryable,
        // Details are already passed through redactDetails by toJSON.
        details: redactDetails(tagged.details),
      },
    },
  };
}

/**
 * Audit-safe payload. Same contract as toHttpResponse but without the
 * `error.message` key (audit log stores the code/stage/details combo;
 * the raw message can carry PII smuggled in via wrapped errors).
 */
function toAuditPayload(err) {
  const tagged = wrapAsSiraError(err);
  return {
    code: tagged.code,
    stage: tagged.stage,
    request_id: tagged.requestId || null,
    retryable: tagged.retryable,
    http_status: tagged.httpStatus,
    details: redactDetails(tagged.details),
  };
}

/**
 * Express error handler. Mount LAST in the middleware chain. Reads the
 * pipeline-error contract, sets `X-Request-Id` if not already present,
 * and writes `{ error: ... }` JSON. Falls back to 500 for non-Sira
 * errors so the route's behaviour is the same as before.
 *
 *   app.use(siraErrorHandler);
 */
function siraErrorHandler(err, req, res, _next) {
  const requestId = (req && (req.requestId || req.id)) || null;
  const tagged = wrapAsSiraError(err, { requestId });
  const { status, body } = toHttpResponse(tagged);
  if (requestId && !res.getHeader("X-Request-Id")) {
    res.setHeader("X-Request-Id", requestId);
  }
  // Best-effort log: keep it short; the audit log holds the rich payload.
  if (req && req.log && typeof req.log.error === "function") {
    req.log.error({ err: tagged.toJSON() }, "sira.pipeline_error");
  }
  res.status(status).json(body);
}

module.exports = {
  STAGES,
  SiraPipelineError,
  IngressError,
  BudgetError,
  EnvelopeError,
  PolicyError,
  ContextError,
  RAGError,
  ToolError,
  ValidatorError,
  StreamError,
  StorageError,
  STAGE_TO_CLASS,
  wrapAsSiraError,
  redactDetails,
  toHttpResponse,
  toAuditPayload,
  siraErrorHandler,
};
