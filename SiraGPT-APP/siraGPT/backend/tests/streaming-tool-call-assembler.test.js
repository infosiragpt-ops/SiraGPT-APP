'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { createToolCallAssembler } = require('../src/services/ai-product-os/streaming-tool-call-assembler');

function collect() {
  const out = [];
  const errs = [];
  const a = createToolCallAssembler({ onFinal: (c) => out.push(c), onError: (e) => errs.push(e) });
  return { a, out, errs };
}

describe('applyDelta — OpenAI-style', () => {
  test('reassembles a single tool call from chunked args', () => {
    const { a, out } = collect();
    a.applyDelta({ index: 0, id: 'call_1', function: { name: 'search', arguments: '{"q":"hel' } });
    a.applyDelta({ index: 0, function: { arguments: 'lo wor' } });
    a.applyDelta({ index: 0, function: { arguments: 'ld"}' } });
    a.applyDelta({ index: 0, finished: true });
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'call_1');
    assert.equal(out[0].name, 'search');
    assert.deepEqual(out[0].arguments, { q: 'hello world' });
    assert.equal(out[0].parseOk, true);
  });

  test('parses two parallel tool calls indexed independently', () => {
    const { a, out } = collect();
    a.applyDelta({ index: 0, id: 'a', function: { name: 'tool_a', arguments: '{"x":1' } });
    a.applyDelta({ index: 1, id: 'b', function: { name: 'tool_b', arguments: '{"y":' } });
    a.applyDelta({ index: 0, function: { arguments: '}' } });
    a.applyDelta({ index: 1, function: { arguments: '2}' } });
    a.applyDelta({ index: 0, finished: true });
    a.applyDelta({ index: 1, finished: true });
    assert.equal(out.length, 2);
    const m = Object.fromEntries(out.map((c) => [c.name, c.arguments]));
    assert.deepEqual(m.tool_a, { x: 1 });
    assert.deepEqual(m.tool_b, { y: 2 });
  });

  test('arguments not finalized stay open', () => {
    const { a, out } = collect();
    a.applyDelta({ index: 0, id: 'i', function: { name: 'n', arguments: '{"a":1}' } });
    assert.equal(out.length, 0);
    assert.equal(a.snapshot().open, 1);
  });

  test('delta without index or id surfaces an error', () => {
    const { a, errs } = collect();
    a.applyDelta({ function: { arguments: 'x' } });
    assert.equal(errs.length, 1);
    assert.match(errs[0].message, /index\/id/);
  });

  test('non-object delta is silently ignored', () => {
    const { a, errs, out } = collect();
    a.applyDelta(null);
    a.applyDelta('nope');
    assert.equal(out.length, 0);
    assert.equal(errs.length, 0);
  });
});

describe('applyDelta — parse errors', () => {
  test('malformed JSON surfaces parseOk=false but still emits', () => {
    const { a, out } = collect();
    a.applyDelta({ index: 0, id: 'i', function: { name: 'n', arguments: 'not-json' } });
    a.applyDelta({ index: 0, finished: true });
    assert.equal(out.length, 1);
    assert.equal(out[0].parseOk, false);
    assert.equal(out[0].arguments, 'not-json');
    assert.ok(out[0].parseError);
  });

  test('empty arguments parse to {}', () => {
    const { a, out } = collect();
    a.applyDelta({ index: 0, id: 'i', function: { name: 'n' } });
    a.applyDelta({ index: 0, finished: true });
    assert.deepEqual(out[0].arguments, {});
  });
});

describe('applyAnthropicEvent', () => {
  test('content_block_start + input_json_delta + content_block_stop', () => {
    const { a, out } = collect();
    a.applyAnthropicEvent('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 't_1', name: 'fetch_url' } });
    a.applyAnthropicEvent('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"url":' } });
    a.applyAnthropicEvent('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '"https://x.com"}' } });
    a.applyAnthropicEvent('content_block_stop', { index: 0 });
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 't_1');
    assert.equal(out[0].name, 'fetch_url');
    assert.deepEqual(out[0].arguments, { url: 'https://x.com' });
  });

  test('non-tool_use content_block_start ignored', () => {
    const { a, out } = collect();
    a.applyAnthropicEvent('content_block_start', { index: 0, content_block: { type: 'text', text: 'hi' } });
    a.applyAnthropicEvent('content_block_stop', { index: 0 });
    assert.equal(out.length, 0);
  });

  test('delta arriving before start is silently dropped', () => {
    const { a, out } = collect();
    a.applyAnthropicEvent('content_block_delta', { index: 9, delta: { type: 'input_json_delta', partial_json: '{}' } });
    a.applyAnthropicEvent('content_block_stop', { index: 9 });
    // No call was started → no emit.
    assert.equal(out.length, 0);
  });

  test('non-input_json_delta type ignored', () => {
    const { a, out } = collect();
    a.applyAnthropicEvent('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'x', name: 'n' } });
    a.applyAnthropicEvent('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'hi' } });
    a.applyAnthropicEvent('content_block_stop', { index: 0 });
    assert.deepEqual(out[0].arguments, {});
  });
});

describe('finalizeAll', () => {
  test('flushes every open call', () => {
    const { a, out } = collect();
    a.applyDelta({ index: 0, id: 'a', function: { name: 'n1', arguments: '{}' } });
    a.applyDelta({ index: 1, id: 'b', function: { name: 'n2', arguments: '{}' } });
    const flushed = a.finalizeAll();
    assert.equal(flushed.length, 2);
    assert.equal(out.length, 2);
    assert.equal(a.snapshot().open, 0);
  });
});

describe('error sink resilience', () => {
  test('throwing onFinal is caught and reported via onError', () => {
    const errs = [];
    const a = createToolCallAssembler({
      onFinal: () => { throw new Error('boom'); },
      onError: (e) => errs.push(e.message),
    });
    a.applyDelta({ index: 0, id: 'i', function: { name: 'n', arguments: '{}' } });
    a.applyDelta({ index: 0, finished: true });
    assert.deepEqual(errs, ['boom']);
  });
});

describe('snapshot', () => {
  test('reports open / finalized / errors counts', () => {
    const { a } = collect();
    a.applyDelta({ index: 0, id: 'i', function: { name: 'n', arguments: '{}' } });
    let s = a.snapshot();
    assert.equal(s.open, 1);
    a.applyDelta({ index: 0, finished: true });
    s = a.snapshot();
    assert.equal(s.open, 0);
    assert.equal(s.finalized, 1);
  });
});
