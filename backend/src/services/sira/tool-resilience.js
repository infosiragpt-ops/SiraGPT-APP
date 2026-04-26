"use strict";

/**
 * Tool resilience controller for the concrete Sira workflow runtime.
 *
 * OpenClaw keeps retries/timeouts as runtime concerns, not model concerns. This
 * module applies the same separation for Cira: the envelope can request retry
 * policy, but the backend deterministically decides when a failed tool call is
 * safe to retry and records every attempt in the audit trace.
 */

const DEFAULT_RETRY_ON = Object.freeze([
  "tool_timeout",
  "invalid_json",
  "file_generation_error",
  "source_validation_failure",
]);

const NON_RETRYABLE_ERROR_CODES = Object.freeze([
  "permission_denied",
  "tool_policy_denied",
  "needs_human_approval",
  "tool_not_found",
  "tool_not_in_registry",
  "invalid_input",
  "invalid_tool_result",
  "invalid_tool_status",
]);

const DEFAULT_SLEEP = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createToolResilienceController({ envelope = null, sleep = DEFAULT_SLEEP } = {}) {
  const attempts = [];
  let retriesScheduled = 0;
  let retriesExhausted = 0;

  return {
    async invoke({ registry, toolName, input = {}, context = {}, tool = null, nodeId = null, auditTrace = [] } = {}) {
      if (!registry || typeof registry.invoke !== "function") {
        throw new Error("sira.tool-resilience: registry.invoke required");
      }
      const policy = resolveToolRetryPolicy({ envelope, tool });
      let attempt = 0;

      while (attempt <= policy.maxRetries) {
        attempt += 1;
        const startedAt = Date.now();
        const result = await safeInvokeRegistry({
          registry,
          toolName,
          input,
          context: {
            ...context,
            toolAttempt: attempt,
            toolRetryPolicy: {
              max_retries: policy.maxRetries,
              retry_on: policy.retryOn,
            },
          },
        });
        const durationMs = Date.now() - startedAt;
        const errorCode = normalizeErrorCode(getResultErrorCode(result));
        const status = result.status || "success";

        attempts.push({
          node_id: nodeId,
          tool: toolName,
          attempt,
          status,
          error_code: errorCode,
          duration_ms: durationMs,
        });

        const retryDecision = shouldRetryToolResult(result, {
          errorCode,
          attempt,
          policy,
          tool,
        });

        if (!retryDecision.retry) {
          if (retryDecision.exhausted) retriesExhausted += 1;
          return annotateResultWithResilience(result, {
            attempt,
            maxRetries: policy.maxRetries,
            retryable: policy.retryable,
            retryOn: policy.retryOn,
            finalErrorCode: errorCode,
            exhausted: retryDecision.exhausted,
          });
        }

        retriesScheduled += 1;
        const delayMs = resolveRetryDelayMs(policy, attempt);
        auditTrace.push({
          ts: new Date().toISOString(),
          event: "tool_retry_scheduled",
          node_id: nodeId,
          tool: toolName,
          attempt,
          next_attempt: attempt + 1,
          error_code: errorCode,
          delay_ms: delayMs,
        });
        if (delayMs > 0) {
          await sleep(delayMs);
        }
      }

      // The loop always returns. This is a defensive fallback for future edits.
      retriesExhausted += 1;
      return annotateResultWithResilience(
        mkErr("retry_exhausted", `tool "${toolName}" exhausted retry policy`),
        {
          attempt,
          maxRetries: policy.maxRetries,
          retryable: policy.retryable,
          retryOn: policy.retryOn,
          finalErrorCode: "retry_exhausted",
          exhausted: true,
        }
      );
    },
    snapshot() {
      return {
        attempts: attempts.length,
        retries_scheduled: retriesScheduled,
        retries_exhausted: retriesExhausted,
        attempt_log: attempts.slice(),
      };
    },
  };
}

function resolveToolRetryPolicy({ envelope = null, tool = null } = {}) {
  const policy = envelope?.workflow_graph?.retry_policy || {};
  const manifestLimits = tool?.manifest?.usageLimits || {};
  const retryable = tool?.retryable !== false && manifestLimits.retryable !== false;
  const maxRetries = retryable
    ? clampInteger(
        policy.max_retries_per_node ?? policy.maxRetriesPerNode ?? manifestLimits.maxRetries ?? 0,
        0,
        5,
        0
      )
    : 0;
  const retryOn = normalizeRetryOn(policy.retry_on || policy.retryOn || DEFAULT_RETRY_ON);
  const backoffMs = clampInteger(policy.backoff_ms ?? policy.backoffMs ?? 25, 0, 10_000, 25);
  const maxDelayMs = clampInteger(policy.max_delay_ms ?? policy.maxDelayMs ?? 2_000, 0, 30_000, 2_000);

  return {
    maxRetries,
    retryOn,
    backoffMs,
    maxDelayMs: Math.max(backoffMs, maxDelayMs),
    retryable,
  };
}

async function safeInvokeRegistry({ registry, toolName, input, context }) {
  try {
    return normalizeResult(await registry.invoke(toolName, input, context));
  } catch (err) {
    return mkErr(
      normalizeErrorCode(err?.code || "tool_execution_error"),
      err && err.message ? err.message : String(err)
    );
  }
}

function shouldRetryToolResult(result, { errorCode, attempt, policy, tool } = {}) {
  const status = result?.status || "success";
  if (status !== "error") return { retry: false, exhausted: false };
  if (!policy?.retryable || tool?.retryable === false) return { retry: false, exhausted: false };
  if (!errorCode || NON_RETRYABLE_ERROR_CODES.includes(errorCode)) {
    return { retry: false, exhausted: false };
  }
  const matchesPolicy = policy.retryOn.includes(errorCode);
  if (!matchesPolicy) return { retry: false, exhausted: false };
  if (attempt > policy.maxRetries) return { retry: false, exhausted: true };
  return { retry: true, exhausted: false };
}

function resolveRetryDelayMs(policy, attempt) {
  const base = policy.backoffMs * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(base, policy.maxDelayMs);
}

function annotateResultWithResilience(result, details) {
  const normalized = normalizeResult(result);
  normalized.metadata = {
    ...(normalized.metadata || {}),
    resilience: {
      attempts: details.attempt,
      retries: Math.max(0, details.attempt - 1),
      max_retries: details.maxRetries,
      retryable: details.retryable,
      retry_on: details.retryOn,
      final_error_code: details.finalErrorCode || null,
      exhausted: Boolean(details.exhausted),
    },
  };
  return normalized;
}

function normalizeResult(result) {
  if (!result || typeof result !== "object") {
    return mkErr("invalid_tool_result", "tool returned non-object");
  }
  return result;
}

function getResultErrorCode(result) {
  return result?.error?.code || result?.code || null;
}

function normalizeErrorCode(value) {
  if (!value) return null;
  const code = String(value).trim();
  if (code === "TIMEOUT") return "tool_timeout";
  return code;
}

function normalizeRetryOn(value) {
  const raw = Array.isArray(value) ? value : value ? [value] : DEFAULT_RETRY_ON;
  const normalized = raw
    .flatMap((entry) => String(entry || "").split(","))
    .map((entry) => normalizeErrorCode(entry))
    .filter(Boolean);
  return Array.from(new Set(normalized.length > 0 ? normalized : DEFAULT_RETRY_ON));
}

function clampInteger(value, min, max, fallback) {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.min(Math.max(Math.round(next), min), max);
}

function mkErr(code, message) {
  return { status: "error", error: { code, message } };
}

module.exports = {
  createToolResilienceController,
  resolveToolRetryPolicy,
  shouldRetryToolResult,
  normalizeRetryOn,
  INTERNAL: {
    resolveRetryDelayMs,
    normalizeErrorCode,
  },
};
