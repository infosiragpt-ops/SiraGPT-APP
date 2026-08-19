/**
 * react-agent — trace compaction.
 *
 * The running message trace grows by one assistant message + one tool
 * message per tool call, every step. On long autonomous runs this overflows
 * the model context window and the run dies with a `model_error` abort
 * before it can finalize. Compaction folds OLDER complete rounds into a
 * single summary while preserving the head (system + query) and the most
 * recent rounds verbatim — so the OpenAI assistant→tool pairing invariant
 * is never broken.
 *
 * These tests pin:
 *   - the pure `compactMessages` helper (no-op below budget, shrink above,
 *     head/tail preservation, pairing safety, too-few-rounds no-op),
 *   - and the end-to-end loop (compaction fires mid-run, every payload sent
 *     to the model is API-valid, the query survives, the run still
 *     finalizes).
 */

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const reactAgent = require('../src/services/react-agent');
const { compactMessages, estimateMessagesChars } = reactAgent;

// ── helpers ──────────────────────────────────────────────────────────────

/**
 * Validate the invariant the OpenAI chat-completions API enforces: every
 * assistant `tool_call.id` must have a matching `role:'tool'` message, and
 * every tool message must reference a known assistant tool_call id.
 * Returns null when valid, or a string describing the first violation.
 */
function pairingViolation(messages) {
  const assistantCallIds = new Set();
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const c of m.tool_calls) assistantCallIds.add(c.id);
    }
  }
  const toolIds = new Set(
    messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)
  );
  for (const id of assistantCallIds) {
    if (!toolIds.has(id)) return `assistant tool_call ${id} has no tool reply`;
  }
  for (const m of messages) {
    if (m.role === 'tool' && !assistantCallIds.has(m.tool_call_id)) {
      return `tool message ${m.tool_call_id} has no originating assistant`;
    }
  }
  return null;
}

function buildTrace(rounds, { bytesPerObs = 4000 } = {}) {
  const messages = [
    { role: 'system', content: 'You are a rigorous agent. SYSTEM PROMPT.' },
    { role: 'user', content: 'ORIGINAL QUERY: complete a long multi-step task.' },
  ];
  for (let r = 0; r < rounds; r += 1) {
    const id = `call_${r}`;
    messages.push({
      role: 'assistant',
      content: `thought for round ${r}`,
      tool_calls: [
        { id, type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ q: `query ${r}` }) } },
      ],
    });
    messages.push({
      role: 'tool',
      tool_call_id: id,
      content: JSON.stringify({ ok: true, results: 'X'.repeat(bytesPerObs) }),
    });
  }
  return messages;
}

/**
 * Scripted OpenAI client that records every `messages` array it is asked to
 * complete, so a test can assert on what the model actually saw.
 */
function makeRecordingOpenAI(script) {
  let i = 0;
  let callId = 0;
  const sentMessages = [];
  return {
    sentMessages,
    chat: {
      completions: {
        create: async (params) => {
          // Deep-ish snapshot of what was sent this turn.
          sentMessages.push(params.messages.map((m) => ({ ...m })));
          const forcedFinalize =
            params.tool_choice
            && typeof params.tool_choice === 'object'
            && params.tool_choice.function?.name === 'finalize';
          const entry = forcedFinalize
            ? { finalize: 'Forced final answer.' }
            : (script[i] || { finalize: 'Default final answer.' });
          i += 1;
          callId += 1;
          const toolCall = entry.finalize != null
            ? { id: `call_${callId}`, type: 'function', function: { name: 'finalize', arguments: JSON.stringify({ answer: entry.finalize }) } }
            : { id: `call_${callId}`, type: 'function', function: { name: entry.tool, arguments: JSON.stringify(entry.args || {}) } };
          return { choices: [{ message: { role: 'assistant', content: entry.thought || 'thinking', tool_calls: [toolCall] } }] };
        },
      },
    },
  };
}

// ── pure helper: compactMessages ─────────────────────────────────────────

test('compactMessages: no-op (same reference) when under the char budget', () => {
  const messages = buildTrace(3, { bytesPerObs: 100 });
  const out = compactMessages(messages, { maxChars: 1_000_000, tailRounds: 3 });
  assert.equal(out, messages, 'should return the very same array reference');
});

test('compactMessages: no-op when there are not more rounds than tailRounds', () => {
  // 3 rounds, tailRounds 3 → nothing in the middle to fold, even if oversized.
  const messages = buildTrace(3, { bytesPerObs: 50_000 });
  const out = compactMessages(messages, { maxChars: 1000, tailRounds: 3 });
  assert.equal(out, messages);
});

test('compactMessages: shrinks an oversized trace and preserves pairing', () => {
  const messages = buildTrace(12, { bytesPerObs: 4000 });
  const before = estimateMessagesChars(messages);
  const out = compactMessages(messages, { maxChars: 20_000, tailRounds: 3 });
  assert.notEqual(out, messages, 'should return a new compacted array');
  assert.ok(estimateMessagesChars(out) < before, 'compacted trace must be smaller');
  assert.equal(pairingViolation(out), null, 'pairing invariant must hold after compaction');
});

test('compactMessages: preserves head, inserts one summary, keeps tailRounds verbatim', () => {
  const messages = buildTrace(10, { bytesPerObs: 4000 });
  const out = compactMessages(messages, { maxChars: 15_000, tailRounds: 3 });

  // Head: system + original user query survive byte-for-byte.
  assert.equal(out[0].role, 'system');
  assert.equal(out[1].role, 'user');
  assert.match(out[1].content, /ORIGINAL QUERY/);

  // The summary is a single user message right after the head.
  assert.equal(out[2].role, 'user');
  assert.match(out[2].content, /CONTEXTO COMPACTADO/);
  // …and it is immediately followed by an assistant turn (start of the tail).
  assert.equal(out[3].role, 'assistant');

  // Tail: exactly tailRounds assistant turns remain.
  const assistantTurns = out.filter((m) => m.role === 'assistant').length;
  assert.equal(assistantTurns, 3);

  // The most recent round is kept verbatim (last tool obs is the big payload,
  // not a summary gist).
  const lastTool = [...out].reverse().find((m) => m.role === 'tool');
  assert.ok(lastTool.content.length > 3000, 'recent observation must be kept full, not summarized');
});

test('compactMessages: summary captures tool names and error gists', () => {
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'ORIGINAL QUERY' },
  ];
  // Round 1: a healthy web_search.
  messages.push({ role: 'assistant', content: 't1', tool_calls: [{ id: 'a', type: 'function', function: { name: 'web_search', arguments: '{}' } }] });
  messages.push({ role: 'tool', tool_call_id: 'a', content: JSON.stringify({ ok: true, hits: 'Z'.repeat(20000) }) });
  // Round 2: a failing docintel_retrieve.
  messages.push({ role: 'assistant', content: 't2', tool_calls: [{ id: 'b', type: 'function', function: { name: 'docintel_retrieve', arguments: '{}' } }] });
  messages.push({ role: 'tool', tool_call_id: 'b', content: JSON.stringify({ error: 'no_analysis' }) });
  // Tail rounds we keep.
  for (let r = 0; r < 3; r += 1) {
    const id = `c${r}`;
    messages.push({ role: 'assistant', content: `tail${r}`, tool_calls: [{ id, type: 'function', function: { name: 'rag_retrieve', arguments: '{}' } }] });
    messages.push({ role: 'tool', tool_call_id: id, content: JSON.stringify({ ok: true }) });
  }

  const out = compactMessages(messages, { maxChars: 10_000, tailRounds: 3 });
  const summary = out.find((m) => m.role === 'user' && /CONTEXTO COMPACTADO/.test(m.content));
  assert.ok(summary, 'summary message must exist');
  assert.match(summary.content, /web_search/);
  assert.match(summary.content, /docintel_retrieve/);
  assert.match(summary.content, /error=no_analysis/);
});

test('estimateMessagesChars: monotonic and non-zero for non-empty traces', () => {
  const small = buildTrace(1, { bytesPerObs: 100 });
  const big = buildTrace(5, { bytesPerObs: 100 });
  assert.ok(estimateMessagesChars(small) > 0);
  assert.ok(estimateMessagesChars(big) > estimateMessagesChars(small));
  assert.equal(estimateMessagesChars([]), 0);
  assert.equal(estimateMessagesChars(null), 0);
});

// ── integration: the loop compacts mid-run and still finalizes ───────────

test('react-agent.run: compaction fires on a long run; every model payload stays API-valid', async () => {
  // A tool that returns a large observation each call, to force the trace to
  // grow past the budget within a handful of steps.
  const bigTool = {
    name: 'web_search',
    description: 'Returns a large canned result to grow the trace.',
    parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false },
    execute: async () => ({ ok: true, results: 'DATA '.repeat(1200) }), // ~6KB
  };

  // 14 tool calls, then a finalize the model would emit on its own.
  const script = Array.from({ length: 14 }, (_, r) => ({ tool: 'web_search', args: { q: `q${r}` } }));
  script.push({ finalize: 'Done after a long run.' });
  const openai = makeRecordingOpenAI(script);

  const compactEvents = [];
  const result = await reactAgent.run(openai, {
    query: 'PERSISTENT QUERY: do a long multi-step research task',
    tools: [bigTool],
    maxSteps: 20,
    model: 'test-model',
    compactMaxChars: 8000,
    compactTailRounds: 2,
    onCompact: (e) => compactEvents.push(e),
  });

  // The run completed normally despite the growth.
  assert.equal(result.stoppedReason, 'finalized');
  assert.match(String(result.finalAnswer), /Done after a long run\./);

  // Compaction actually fired at least once.
  assert.ok(compactEvents.length >= 1, 'expected at least one compaction event');
  assert.ok(compactEvents.every((e) => e.removedMessages > 0));

  // CRITICAL: every payload the model was asked to complete must be API-valid
  // (no orphaned tool calls / tool messages) AND must still carry the query.
  for (const sent of openai.sentMessages) {
    assert.equal(pairingViolation(sent), null, 'every model payload must preserve assistant→tool pairing');
    assert.ok(
      sent.some((m) => m.role === 'user' && /PERSISTENT QUERY/.test(m.content || '')),
      'the original query must survive every compaction'
    );
  }

  // The later payloads must be bounded — compaction kept the trace from
  // growing monotonically to the end.
  const lastPayloadChars = estimateMessagesChars(openai.sentMessages[openai.sentMessages.length - 1]);
  assert.ok(lastPayloadChars < 60_000, `final payload should be bounded, got ${lastPayloadChars}`);
});

test('react-agent.run: a high char budget disables compaction (no events, trace grows)', async () => {
  const bigTool = {
    name: 'web_search',
    description: 'Returns a large canned result.',
    parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false },
    execute: async () => ({ ok: true, results: 'DATA '.repeat(1200) }),
  };
  const script = Array.from({ length: 6 }, (_, r) => ({ tool: 'web_search', args: { q: `q${r}` } }));
  script.push({ finalize: 'ok' });
  const openai = makeRecordingOpenAI(script);

  const compactEvents = [];
  const result = await reactAgent.run(openai, {
    query: 'short',
    tools: [bigTool],
    maxSteps: 12,
    model: 'test-model',
    compactMaxChars: 10_000_000, // effectively never compact
    compactTailRounds: 2,
    onCompact: (e) => compactEvents.push(e),
  });

  assert.equal(result.stoppedReason, 'finalized');
  assert.equal(compactEvents.length, 0, 'no compaction expected under a huge budget');
});
