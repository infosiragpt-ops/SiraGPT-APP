'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { createSseReassembler, decodeChunk } = require('../src/services/ai-product-os/sse-reassembler');

function collect() {
  const out = [];
  const errs = [];
  const r = createSseReassembler({ onEvent: (e) => out.push(e), onError: (e) => errs.push(e) });
  return { r, out, errs };
}

describe('decodeChunk', () => {
  test('string passthrough', () => {
    assert.equal(decodeChunk('abc'), 'abc');
  });
  test('Buffer → utf8', () => {
    assert.equal(decodeChunk(Buffer.from('héllo', 'utf8')), 'héllo');
  });
  test('Uint8Array → utf8', () => {
    assert.equal(decodeChunk(new Uint8Array(Buffer.from('xyz'))), 'xyz');
  });
  test('null → empty string', () => {
    assert.equal(decodeChunk(null), '');
  });
});

describe('sse-reassembler — happy path framing', () => {
  test('parses a single complete event', () => {
    const { r, out } = collect();
    r.push('data: hello\n\n');
    assert.deepEqual(out, [{ event: null, data: 'hello', id: null, retry: null }]);
  });

  test('handles event + id + retry', () => {
    const { r, out } = collect();
    r.push('event: message\nid: 42\nretry: 1500\ndata: ok\n\n');
    assert.equal(out[0].event, 'message');
    assert.equal(out[0].id, '42');
    assert.equal(out[0].retry, 1500);
    assert.equal(out[0].data, 'ok');
  });

  test('joins multi-line data with \\n', () => {
    const { r, out } = collect();
    r.push('data: line1\ndata: line2\n\n');
    assert.equal(out[0].data, 'line1\nline2');
  });

  test('comment lines are ignored', () => {
    const { r, out } = collect();
    r.push(': this is a comment\ndata: real\n\n');
    assert.equal(out.length, 1);
    assert.equal(out[0].data, 'real');
  });

  test('handles \\r\\n\\r\\n separator', () => {
    const { r, out } = collect();
    r.push('data: crlf\r\n\r\n');
    assert.equal(out.length, 1);
    assert.equal(out[0].data, 'crlf');
  });
});

describe('sse-reassembler — partial chunks', () => {
  test('event split across multiple push() calls reassembles correctly', () => {
    const { r, out } = collect();
    r.push('data: he');
    r.push('llo wor');
    r.push('ld\n\n');
    assert.deepEqual(out.map((e) => e.data), ['hello world']);
  });

  test('two events delivered in one buffered chunk emit independently', () => {
    const { r, out } = collect();
    r.push('data: a\n\ndata: b\n\n');
    assert.deepEqual(out.map((e) => e.data), ['a', 'b']);
  });

  test('byte-by-byte feed still parses cleanly', () => {
    const { r, out } = collect();
    const wire = 'event: token\ndata: hi\n\nevent: token\ndata: ya\n\n';
    for (const ch of wire) r.push(ch);
    assert.equal(out.length, 2);
    assert.equal(out[0].data, 'hi');
    assert.equal(out[1].data, 'ya');
  });
});

describe('sse-reassembler — sentinels', () => {
  test('[DONE] payload normalized to event="done"', () => {
    const { r, out } = collect();
    r.push('data: [DONE]\n\n');
    assert.equal(out[0].event, 'done');
    assert.equal(out[0].data, '[DONE]');
  });
});

describe('sse-reassembler — end()', () => {
  test('end() flushes a trailing partial frame without separator', () => {
    const { r, out } = collect();
    r.push('data: trailing');
    r.end();
    assert.equal(out.length, 1);
    assert.equal(out[0].data, 'trailing');
  });

  test('end() with empty buffer is a no-op', () => {
    const { r, out } = collect();
    r.push('data: x\n\n');
    r.end();
    assert.equal(out.length, 1);
  });
});

describe('sse-reassembler — error isolation', () => {
  test('throwing onEvent reports to onError but keeps parsing', () => {
    const errs = [];
    const evs = [];
    const r = createSseReassembler({
      onEvent: (e) => { evs.push(e); if (e.data === 'bad') throw new Error('boom'); },
      onError: (err) => errs.push(err.message),
    });
    r.push('data: ok\n\ndata: bad\n\ndata: also-ok\n\n');
    assert.equal(evs.length, 3);
    assert.deepEqual(errs, ['boom']);
  });
});

describe('sse-reassembler — snapshot', () => {
  test('snapshot reports counters and partial buffer length', () => {
    const { r } = collect();
    r.push('data: a\n\ndata: par');
    const s = r.snapshot();
    assert.equal(s.framesEmitted, 1);
    assert.ok(s.partialBufferLen > 0);
    assert.ok(s.bytes > 0);
  });
});

describe('sse-reassembler — provider parity', () => {
  test('Anthropic-style event+data block', () => {
    const { r, out } = collect();
    r.push('event: content_block_delta\ndata: {"delta":{"text":"hi"}}\n\n');
    assert.equal(out[0].event, 'content_block_delta');
    assert.equal(JSON.parse(out[0].data).delta.text, 'hi');
  });

  test('OpenAI-style data-only delta', () => {
    const { r, out } = collect();
    r.push('data: {"choices":[{"delta":{"content":"yo"}}]}\n\n');
    assert.equal(out[0].event, null);
    assert.equal(JSON.parse(out[0].data).choices[0].delta.content, 'yo');
  });
});
