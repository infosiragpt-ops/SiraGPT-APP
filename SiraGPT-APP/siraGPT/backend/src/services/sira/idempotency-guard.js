"use strict";

const crypto = require("node:crypto");
const { HIGH_IMPACT_PERMISSIONS, normalizePermissions } = require("./tool-policy");

/**
 * Per-run idempotency guard for side-effecting Sira tools.
 *
 * The workflow graph already carries a stable idempotency_key. This guard
 * applies it at execution time so retries or duplicate graph nodes do not
 * create duplicate artifacts, publish previews twice, send duplicate messages,
 * or repeat database writes. Read-only tools are intentionally not cached here.
 */

function createRunIdempotencyGuard({ envelope = null } = {}) {
  const seen = new Map();
  return {
    check({ toolName, input = {}, tool = null } = {}) {
      const guarded = shouldGuardTool(tool);
      if (!guarded) {
        return { guarded: false, duplicate: false, key: null, previous: null };
      }
      const key = buildToolInvocationKey({ envelope, toolName, input });
      return {
        guarded: true,
        duplicate: seen.has(key),
        key,
        previous: seen.get(key) || null,
      };
    },
    remember(key, record) {
      if (key) seen.set(key, freezeResultRecord(record));
    },
    snapshot() {
      return {
        guarded_invocations: seen.size,
        keys: [...seen.keys()],
      };
    },
  };
}

function buildToolInvocationKey({ envelope = null, toolName, input = {} } = {}) {
  const graphKey = envelope?.workflow_graph?.idempotency_key || envelope?.request_id || "cira:runtime";
  return `${graphKey}:${hashPayload({ tool: toolName || "unknown_tool", input })}`;
}

function shouldGuardTool(tool = null) {
  if (!tool) return false;
  const permissions = normalizePermissions(
    tool.permissionsRequired ||
    tool.permissions_required ||
    tool.manifest?.scopes
  );
  const sideEffectLevel = tool.manifest?.sideEffectLevel || tool.sideEffectLevel || "none";
  return (
    permissions.includes("write_artifact") ||
    permissions.some((permission) => HIGH_IMPACT_PERMISSIONS.includes(permission)) ||
    sideEffectLevel === "writes_new_artifact" ||
    sideEffectLevel === "external_side_effect"
  );
}

function hashPayload(payload) {
  return crypto
    .createHash("sha256")
    .update(stableStringify(payload))
    .digest("hex")
    .slice(0, 24);
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function freezeResultRecord(record = {}) {
  return Object.freeze({
    node: record.node || null,
    tool: record.tool || null,
    status: record.status || "success",
    output: cloneJson(record.output || null),
    error: cloneJson(record.error || null),
    metadata: cloneJson(record.metadata || {}),
  });
}

function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

module.exports = {
  createRunIdempotencyGuard,
  buildToolInvocationKey,
  shouldGuardTool,
  stableStringify,
};
