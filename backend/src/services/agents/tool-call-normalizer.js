'use strict';

const INVALID_TOOL_CALLS = 'E_MODEL_TOOL_CALLS';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function usableId(value) {
  return typeof value === 'string' && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value);
}

function invalidCalls(reason, index) {
  // Report only a stable reason/index, never provider arguments or raw output.
  const error = new Error(`Invalid model tool calls: ${reason}`);
  error.code = INVALID_TOOL_CALLS;
  error.reason = reason;
  if (index !== undefined) error.index = index;
  return error;
}

/**
 * Reserve identities already present in a resumed/compacted transcript.
 * Include both sides of the pair: even an orphaned historical result must not
 * accidentally answer a newly generated call with the same provider ID.
 */
function collectToolCallIds(messages) {
  const ids = new Set();
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!isRecord(message)) continue;
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (isRecord(call) && usableId(call.id)) ids.add(call.id);
      }
    }
    if (message.role === 'tool' && usableId(message.tool_call_id)) ids.add(message.tool_call_id);
  }
  return ids;
}

/**
 * Normalize a NEW model call batch before any tool is dispatched. The caller
 * owns one usedIds Set per run, seeded from resumed history and retained across
 * compaction. All control shapes are validated before that Set is modified.
 *
 * Unlike agent-runner/tool-transcript, this does not repair historical results,
 * synthesize observations or guess calls. Names and arguments remain unchanged;
 * JSON parsing, argument schemas, authorization and budgets stay in dispatchTool.
 * Legacy omitted `type` remains a function call, as in the existing dispatcher.
 */
function normalizeToolCalls(rawCalls, { usedIds = new Set() } = {}) {
  if (!(usedIds instanceof Set)) throw new TypeError('usedIds must be a Set');
  if (rawCalls == null) return [];
  if (!Array.isArray(rawCalls)) throw invalidCalls('tool_calls_not_array');

  const reserved = new Set(usedIds);
  for (let index = 0; index < rawCalls.length; index += 1) {
    const call = rawCalls[index];
    if (!isRecord(call)) throw invalidCalls('call_not_object', index);
    if (call.type !== undefined && call.type !== 'function') throw invalidCalls('unsupported_call_type', index);
    if (!isRecord(call.function)) throw invalidCalls('function_not_object', index);
    if (typeof call.function.name !== 'string' || !call.function.name.trim()) {
      throw invalidCalls('function_name_missing', index);
    }
    // Reserve ALL incoming IDs before generating a replacement: a repaired
    // early call may not steal an otherwise valid ID appearing later.
    if (usableId(call.id)) reserved.add(call.id);
  }

  const assigned = new Set(usedIds);
  const normalized = [];
  let sequence = 0;
  for (const call of rawCalls) {
    let id = call.id;
    if (!usableId(id) || assigned.has(id)) {
      do { id = `call_sira_${++sequence}`; } while (reserved.has(id));
      reserved.add(id);
    }
    assigned.add(id);
    normalized.push({ ...call, id, type: 'function', function: { ...call.function } });
  }

  for (const call of normalized) usedIds.add(call.id);
  return normalized;
}

module.exports = { normalizeToolCalls, collectToolCallIds, INVALID_TOOL_CALLS };
