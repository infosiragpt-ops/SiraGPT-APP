'use strict';

/**
 * streaming-tool-call-assembler — reassembles tool_call invocations
 * that arrive as fragments during streaming (each chunk carries a
 * slice of the JSON arguments) into complete, ready-to-dispatch
 * calls. Pairs with the SSE reassembler (#17): that one frames the
 * wire bytes, this one reconstructs the semantic tool call from
 * provider-specific delta shapes.
 *
 * Provider deltas supported:
 *   - OpenAI / Anthropic-tool-use:
 *       { index, id?, function: { name?, arguments? } }
 *     `arguments` arrives as a JSON string in slices; we concatenate
 *     by index, then JSON.parse on completion.
 *   - Anthropic content_block_start / content_block_delta / _stop:
 *       { type: 'tool_use', id, name }
 *       { type: 'input_json_delta', partial_json: '...' }
 *
 * On a finalized call, the assembler emits a normalized event:
 *   { id, name, arguments: <parsed-object> | <raw-string-on-parse-fail>,
 *     parseOk: boolean, parseError?: string }
 *
 * Public API:
 *   const a = createToolCallAssembler({ onFinal, onError })
 *   a.applyDelta(delta)              // OpenAI/Anthropic-tool-use shape
 *   a.applyAnthropicEvent(eventName, data)  // Anthropic event shape
 *   a.finalizeAll()                  // flush every open call
 *   a.snapshot()                     // { open, finalized, errors }
 */

function createToolCallAssembler(opts = {}) {
  const onFinal = typeof opts.onFinal === 'function' ? opts.onFinal : null;
  const onError = typeof opts.onError === 'function' ? opts.onError : null;

  /** Map<string|number, { id, name, args, indexKey, finalized }> */
  const open = new Map();
  let finalizedCount = 0;
  let errorCount = 0;

  function fireError(err) {
    errorCount += 1;
    if (!onError) return;
    try { onError(err); } catch { /* swallow */ }
  }

  function emit(call) {
    finalizedCount += 1;
    if (!onFinal) return;
    try { onFinal(call); } catch (e) { fireError(e); }
  }

  function getOrCreate(key) {
    let row = open.get(key);
    if (!row) {
      row = { id: null, name: null, args: '', indexKey: key, finalized: false };
      open.set(key, row);
    }
    return row;
  }

  function finalize(key) {
    const row = open.get(key);
    if (!row || row.finalized) return null;
    row.finalized = true;
    open.delete(key);
    let parsed;
    let parseOk = true;
    let parseError;
    if (row.args === '') {
      parsed = {};
    } else {
      try { parsed = JSON.parse(row.args); }
      catch (e) {
        parseOk = false;
        parseError = e && e.message;
        parsed = row.args; // surface raw string so caller can debug
      }
    }
    const call = {
      id: row.id,
      name: row.name,
      arguments: parsed,
      parseOk,
      ...(parseError ? { parseError } : {}),
    };
    emit(call);
    return call;
  }

  /**
   * Generic OpenAI-style delta. Field shape:
   *   { index, id?, function: { name?, arguments? } }
   * `index` is the canonical key; if absent, we fall back to id.
   * A delta whose `function.arguments` ends with `}` does NOT auto-
   * finalize — providers always emit a separate end signal.
   */
  function applyDelta(delta) {
    if (!delta || typeof delta !== 'object') return;
    const key = delta.index !== undefined ? delta.index : delta.id;
    if (key === undefined) { fireError(new Error('tool-call delta missing index/id')); return; }
    const row = getOrCreate(key);
    if (delta.id && !row.id) row.id = delta.id;
    if (delta.function && typeof delta.function === 'object') {
      if (delta.function.name && !row.name) row.name = delta.function.name;
      if (typeof delta.function.arguments === 'string') row.args += delta.function.arguments;
    }
    if (delta.finished === true) finalize(key);
  }

  /**
   * Anthropic content_block_* event. eventName is the SSE `event:`
   * value; data is the parsed JSON payload of `data:`.
   */
  function applyAnthropicEvent(eventName, data) {
    if (!eventName || !data || typeof data !== 'object') return;
    const idx = data.index;
    if (idx === undefined) return;
    if (eventName === 'content_block_start') {
      const cb = data.content_block || {};
      if (cb.type !== 'tool_use') return;
      const row = getOrCreate(idx);
      row.id = cb.id || row.id;
      row.name = cb.name || row.name;
      return;
    }
    if (eventName === 'content_block_delta') {
      const d = data.delta || {};
      if (d.type !== 'input_json_delta') return;
      if (typeof d.partial_json !== 'string') return;
      const row = open.get(idx);
      if (!row) return; // delta before start — drop silently
      row.args += d.partial_json;
      return;
    }
    if (eventName === 'content_block_stop') {
      finalize(idx);
    }
  }

  function finalizeAll() {
    const out = [];
    for (const key of [...open.keys()]) {
      const r = finalize(key);
      if (r) out.push(r);
    }
    return out;
  }

  function snapshot() {
    return { open: open.size, finalized: finalizedCount, errors: errorCount };
  }

  return { applyDelta, applyAnthropicEvent, finalize, finalizeAll, snapshot };
}

module.exports = {
  createToolCallAssembler,
};
