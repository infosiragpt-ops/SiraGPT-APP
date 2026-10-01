'use strict';

const { createToolCallAssembler } = require('../ai-product-os/streaming-tool-call-assembler');
const { getProviderRuntimeProfile } = require('../ai-product-os/litellm-gateway');

const CODING_OUTPUT_TOKENS = 4096;
const MAX_STREAM_CHARS = 512 * 1024;

function codingOutputFields(provider, model) {
  const runtime = getProviderRuntimeProfile({ provider, modelId: model });
  return { [runtime.maxTokensField || 'max_tokens']: CODING_OUTPUT_TOKENS };
}

function abortIfNeeded(signal) {
  if (!signal?.aborted) return;
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  throw err;
}

// Observe a provider stream without dispatching any partial call or exposing
// its arguments/reasoning. The existing run deadline remains authoritative.
async function collectCodingResponse(response, { signal, onFirstDelta } = {}) {
  if (!response?.[Symbol.asyncIterator]) return response;
  const calls = [];
  let malformed = false;
  const assembler = createToolCallAssembler({ onFinal: (call) => calls.push(call), onError: () => { malformed = true; } });
  let content = '';
  let reasoning = '';
  let chars = 0;
  let finishReason = null;
  let first = true;
  let usage;
  let model;
  for await (const chunk of response) {
    abortIfNeeded(signal);
    if (chunk?.model) model = chunk.model;
    if (chunk?.usage) usage = chunk.usage;
    const choice = chunk?.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta || {};
    if (first && (delta.content || delta.reasoning_content || delta.reasoning || delta.tool_calls?.length)) {
      first = false;
      onFirstDelta?.();
    }
    content += typeof delta.content === 'string' ? delta.content : '';
    reasoning += typeof delta.reasoning_content === 'string' ? delta.reasoning_content : (typeof delta.reasoning === 'string' ? delta.reasoning : '');
    chars += JSON.stringify(delta).length;
    if (chars > MAX_STREAM_CHARS) throw new Error('coding_response_too_large');
    for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) assembler.applyDelta(call);
    if (choice.finish_reason != null) finishReason = choice.finish_reason;
  }
  abortIfNeeded(signal);
  // EOF alone is not proof that a generated mutation finished. Even a valid
  // JSON prefix is discarded when the stream ends without its terminal frame.
  if (!finishReason) throw new Error('coding_response_incomplete');
  if (!['stop', 'tool_calls', 'length'].includes(finishReason)) throw new Error('coding_response_not_completed');
  if (finishReason !== 'length') assembler.finalizeAll();
  if (malformed || calls.some((call) => !call.parseOk)) throw new Error('coding_response_invalid_tool_call');
  return {
    model,
    usage,
    choices: [{ finish_reason: finishReason, message: {
      role: 'assistant', content,
      ...(reasoning ? { reasoning_content: reasoning } : {}),
      ...(calls.length ? { tool_calls: calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : {}),
    } }],
  };
}

module.exports = { codingOutputFields, collectCodingResponse, CODING_OUTPUT_TOKENS };
