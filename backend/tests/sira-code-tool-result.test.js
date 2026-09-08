'use strict';

/**
 * SiraCode tool-result truncation + transcript compaction.
 * OpenCode Truncate / prune idea; deterministic SiraGPT rewrite.
 */

const { test, beforeEach, afterEach, describe } = require('node:test');
const assert = require('node:assert/strict');

const siraCode = require('../src/services/sira-code');
const {
  TOOL_RESULT_MAX_LINES,
  TOOL_RESULT_MAX_BYTES,
  STALE_TOOL_MAX_LINES,
  TRUNCATION_MARKER,
  COMPACT_LABEL,
  truncateToolResult,
  compactTranscript,
} = require('../src/services/sira-code/tool-result');

beforeEach(() => {
  siraCode._resetForTests();
});

afterEach(() => {
  siraCode._resetForTests();
});

function lines(n, prefix = 'linea') {
  return Array.from({ length: n }, (_, i) => `${prefix}-${i} ${'x'.repeat(24)}`).join('\n');
}

describe('truncateToolResult', () => {
  test('leaves short output unchanged', () => {
    const out = truncateToolResult('hola\nmundo');
    assert.equal(out.truncated, false);
    assert.equal(out.content, 'hola\nmundo');
    assert.equal(out.omittedLines, 0);
  });

  test('caps by lines and uses the Spanish marker', () => {
    const raw = lines(TOOL_RESULT_MAX_LINES + 40);
    const out = truncateToolResult(raw);
    assert.equal(out.truncated, true);
    assert.match(out.content, new RegExp(TRUNCATION_MARKER.replace(/[…[\]]/g, '\\$&')));
    assert.ok(out.content.includes('líneas omitidas'));
    assert.ok(out.content.includes('read/grep'));
    assert.ok(out.content.length < raw.length);
    assert.ok(!out.content.includes('openrouter'), 'no vendor leak');
    assert.ok(out.omittedLines >= 40);
  });

  test('caps by bytes on a single long line', () => {
    const raw = `inicio ${'ñ'.repeat(TOOL_RESULT_MAX_BYTES)} final`;
    const out = truncateToolResult(raw, { maxLines: 50, maxBytes: 800 });
    assert.equal(out.truncated, true);
    assert.ok(out.content.includes(TRUNCATION_MARKER));
    assert.ok(out.content.includes('bytes omitidas'));
    assert.ok(Buffer.byteLength(out.content, 'utf8') < Buffer.byteLength(raw, 'utf8'));
    assert.ok(!out.content.includes('final'));
  });

  test('does not stack the marker when re-truncating', () => {
    const first = truncateToolResult(lines(80), { maxLines: 20, maxBytes: 50_000 });
    const second = truncateToolResult(first.content, { maxLines: 6, maxBytes: 50_000 });
    const hits = second.content.split(TRUNCATION_MARKER).length - 1;
    assert.equal(hits, 1);
    assert.equal(second.truncated, true);
  });
});

describe('compactTranscript', () => {
  test('is a no-op when every tool result fits', () => {
    const messages = [
      { role: 'system', content: 'sistema' },
      { role: 'user', content: 'lista' },
      { role: 'tool', content: 'ok' },
    ];
    const out = compactTranscript(messages);
    assert.equal(out.compacted, false);
    assert.equal(out.messages[0].content, 'sistema');
    assert.equal(out.messages[2].content, 'ok');
  });

  test('shrinks older tool results and keeps the tail fuller', () => {
    const bulky = lines(60);
    const messages = [
      { role: 'system', content: 'sistema-sira' },
      { role: 'user', content: 'construye' },
      { role: 'tool', content: bulky },
      { role: 'tool', content: bulky },
      { role: 'tool', content: bulky },
    ];
    const out = compactTranscript(messages, {
      maxLines: TOOL_RESULT_MAX_LINES,
      maxBytes: TOOL_RESULT_MAX_BYTES,
      staleMaxLines: STALE_TOOL_MAX_LINES,
      staleMaxBytes: 1024,
      protectTail: 2,
    });
    assert.equal(out.compacted, true);
    assert.equal(out.messages[0].content, 'sistema-sira');
    assert.equal(out.messages[1].content, 'construye');
    assert.ok(out.messages[2].content.includes(TRUNCATION_MARKER));
    assert.ok(out.messages[2].content.split('\n').length < out.messages[4].content.split('\n').length);
    assert.ok(out.messages[4].content.includes('linea-0'));
    assert.ok(!JSON.stringify(out.messages).includes('openrouter'));
  });
});

describe('loop wiring', () => {
  test('a huge read is truncated before the next LLM turn and labeled in Spanish', async () => {
    const session = await siraCode.create({ userId: 'u-trunc', agent: 'construir' });
    const huge = lines(TOOL_RESULT_MAX_LINES + 80, 'dump');
    await siraCode.getSession(session.id).workspace.writeFile('dump.txt', huge);

    let seen = [];
    let calls = 0;
    const result = await siraCode.prompt(session.id, 'lee dump.txt', {
      userId: 'u-trunc',
      llmTurn: async ({ messages }) => {
        calls += 1;
        seen = messages;
        if (calls === 1) {
          return { text: '', toolCalls: [{ name: 'read', arguments: { path: 'dump.txt' } }] };
        }
        return { text: 'Leí el archivo.', toolCalls: [] };
      },
    });

    assert.equal(result.status, 'idle');
    assert.equal(calls, 2);
    const toolMsg = seen.find((m) => m.role === 'tool');
    assert.ok(toolMsg, 'second LLM turn must see the tool result');
    assert.ok(toolMsg.content.includes(TRUNCATION_MARKER));
    assert.ok(toolMsg.content.length < huge.length);
    const stored = siraCode.getSession(session.id);
    assert.ok(stored.events.some((ev) => ev.label === COMPACT_LABEL || ev.step === 'compacting'));
    assert.equal(result.toolResults[0].content.includes(TRUNCATION_MARKER), true);
  });

  test('three bulky tools compact the oldest before the next LLM turn', async () => {
    const session = await siraCode.create({ userId: 'u-pack', agent: 'construir' });
    const ws = siraCode.getSession(session.id).workspace;
    await ws.writeFile('a.txt', lines(50, 'aaa'));
    await ws.writeFile('b.txt', lines(50, 'bbb'));
    await ws.writeFile('c.txt', lines(50, 'ccc'));

    let lastMessages = [];
    let calls = 0;
    await siraCode.prompt(session.id, 'lee los tres', {
      userId: 'u-pack',
      maxSteps: 5,
      llmTurn: async ({ messages }) => {
        calls += 1;
        lastMessages = messages;
        if (calls === 1) return { text: '', toolCalls: [{ name: 'read', arguments: { path: 'a.txt' } }] };
        if (calls === 2) return { text: '', toolCalls: [{ name: 'read', arguments: { path: 'b.txt' } }] };
        if (calls === 3) return { text: '', toolCalls: [{ name: 'read', arguments: { path: 'c.txt' } }] };
        return { text: 'Listo.', toolCalls: [] };
      },
    });

    assert.equal(calls, 4);
    const tools = lastMessages.filter((m) => m.role === 'tool');
    assert.equal(tools.length, 3);
    assert.ok(tools[0].content.includes(TRUNCATION_MARKER), 'oldest tool should be compacted');
    assert.ok(tools[2].content.includes('ccc-0'), 'newest tool keeps its head');
    const stored = siraCode.getSession(session.id);
    const compactEvents = stored.events.filter((ev) => ev.label === COMPACT_LABEL || ev.step === 'compacting');
    assert.equal(compactEvents.length, 1, 'Spanish compact label fires once per prompt');
  });
});
