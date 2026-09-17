'use strict';

// Strict OpenAI-compatible providers (DeepSeek native, OpenAI, Gemini, xAI)
// reject a transcript whose tool messages do not answer a preceding
// assistant tool_calls turn. The runner's compaction hooks can produce that
// shape; the normaliser must always hand the provider a legal sequence.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { normalizeToolTranscript, isToolTranscriptError, OMITTED_RESULT } = require('../src/services/agent-runner/tool-transcript');
const { callModel } = require('../src/services/agent-runner/loop');

const call = (id, name = 'write_file') => ({ id, type: 'function', function: { name, arguments: '{}' } });

/** The invariant every strict provider enforces. */
function assertLegal(messages) {
  let open = null; // Set of pending ids for the current assistant tool_calls group
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (m.role === 'tool') {
      assert.ok(open && open.has(m.tool_call_id), `tool message at ${i} (${m.tool_call_id}) must answer an open tool call`);
      open.delete(m.tool_call_id);
      continue;
    }
    if (open && open.size) assert.fail(`assistant tool_calls at group before ${i} left ${[...open].join(',')} unanswered`);
    open = m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length ? new Set(m.tool_calls.map((c) => c.id)) : null;
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) assert.ok(m.tool_calls.length > 0, 'no empty tool_calls arrays');
  }
  if (open && open.size) assert.fail('trailing unanswered tool calls');
}

describe('normalizeToolTranscript', () => {
  test('a legal transcript passes through untouched', () => {
    const messages = [
      { role: 'system', content: 's' },
      { role: 'user', content: 'crea una ppt' },
      { role: 'assistant', content: null, tool_calls: [call('c1')] },
      { role: 'tool', tool_call_id: 'c1', content: 'ok' },
      { role: 'assistant', content: 'Listo.' },
    ];
    const r = normalizeToolTranscript(messages);
    assert.equal(r.repaired, 0);
    assert.deepEqual(r.messages, messages);
    assertLegal(r.messages);
  });

  test('an orphan tool result (its assistant turn was compacted away) becomes a user message', () => {
    const r = normalizeToolTranscript([
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
      { role: 'tool', tool_call_id: 'c1', name: 'run_command', content: 'stdout here' },
      { role: 'assistant', content: 'sigo' },
    ]);
    assert.equal(r.repaired, 1);
    assert.equal(r.messages[2].role, 'user');
    assert.match(r.messages[2].content, /^\[TOOL_RESULT run_command\]\nstdout here/);
    assertLegal(r.messages);
  });

  test('a tool_calls turn whose result was dropped gets a synthetic result', () => {
    const r = normalizeToolTranscript([
      { role: 'user', content: 'u' },
      { role: 'assistant', content: null, tool_calls: [call('c1', 'read_file')] },
      { role: 'user', content: 'sigue' },
    ]);
    assert.equal(r.repaired, 1);
    assert.equal(r.messages[2].role, 'tool');
    assert.equal(r.messages[2].tool_call_id, 'c1');
    assert.match(r.messages[2].content, new RegExp(`^\\[read_file\\] ${OMITTED_RESULT.replace(/[()]/g, '\\$&')}`));
    assert.equal(r.messages[3].role, 'user');
    assertLegal(r.messages);
  });

  test('parallel tool calls keep their results together and in call order; interleaved image messages are deferred', () => {
    const image = { role: 'user', content: [{ type: 'text', text: 'imagen' }] };
    const r = normalizeToolTranscript([
      { role: 'user', content: 'u' },
      { role: 'assistant', content: null, tool_calls: [call('a'), call('b')] },
      { role: 'tool', tool_call_id: 'b', content: 'B' },
      image,
      { role: 'tool', tool_call_id: 'a', content: 'A' },
      { role: 'assistant', content: 'fin' },
    ]);
    assert.deepEqual(r.messages.map((m) => m.role), ['user', 'assistant', 'tool', 'tool', 'user', 'assistant']);
    assert.deepEqual(r.messages.slice(2, 4).map((m) => m.tool_call_id), ['a', 'b']);
    assert.equal(r.messages[4], image);
    assertLegal(r.messages);
  });

  test('an id-less tool message binds to the only open call; an empty tool_calls array is dropped', () => {
    const r = normalizeToolTranscript([
      { role: 'assistant', content: 'x', tool_calls: [] },
      { role: 'assistant', content: null, tool_calls: [call('c9')] },
      { role: 'tool', content: 'done' },
    ]);
    assert.equal(r.messages[0].tool_calls, undefined);
    assert.equal(r.messages[2].tool_call_id, 'c9');
    assert.equal(r.repaired, 2);
    assertLegal(r.messages);
  });

  test('the compaction shape seen in production (results kept, calls dropped, then new calls) is repaired end to end', () => {
    const r = normalizeToolTranscript([
      { role: 'system', content: 's' },
      { role: 'tool', tool_call_id: 'old1', content: 'r1' },
      { role: 'tool', tool_call_id: 'old2', content: 'r2' },
      { role: 'user', content: 'último usuario' },
      { role: 'assistant', content: null, tool_calls: [call('n1'), call('n2')] },
      { role: 'tool', tool_call_id: 'n1', content: 'ok1' },
    ]);
    assertLegal(r.messages);
    assert.equal(r.repaired, 3);
    assert.equal(r.messages[r.messages.length - 1].tool_call_id, 'n2');
  });

  test('isToolTranscriptError recognises the strict-provider messages only', () => {
    assert.equal(isToolTranscriptError(new Error("400 Messages with role 'tool' must be a response to a preceding message with 'tool_calls'")), true);
    assert.equal(isToolTranscriptError(new Error("An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'")), true);
    assert.equal(isToolTranscriptError(new Error('tools are not supported by this model')), false);
    assert.equal(isToolTranscriptError(new Error('402 Insufficient credits')), false);
  });
});

describe('callModel', () => {
  test('sends the normalised copy and leaves the runner state untouched; transcript 400s are not retried without tools', async () => {
    const seen = [];
    const client = {
      chat: {
        completions: {
          create: async (payload) => {
            seen.push(payload);
            if (seen.length === 1) return { choices: [{ message: { content: 'ok' } }] };
            const err = new Error("400 Messages with role 'tool' must be a response to a preceding message with 'tool_calls'");
            err.status = 400;
            throw err;
          },
        },
      },
    };
    const messages = [
      { role: 'user', content: 'u' },
      { role: 'tool', tool_call_id: 'zz', content: 'orphan' },
    ];
    const snapshot = JSON.stringify(messages);
    const out = await callModel({ client, model: 'm', messages, tools: [], maxTokens: 64 });
    assert.equal(out.choices[0].message.content, 'ok');
    assertLegal(seen[0].messages);
    assert.equal(seen[0].messages[1].role, 'user');
    assert.equal(JSON.stringify(messages), snapshot, 'runner state is not mutated');
    assert.equal(seen[0].tool_choice, 'auto');

    await assert.rejects(() => callModel({ client, model: 'm', messages, tools: [], maxTokens: 64 }), /must be a response/);
    assert.equal(seen.length, 2, 'no second attempt without tools for a transcript-shape error');
  });
});
