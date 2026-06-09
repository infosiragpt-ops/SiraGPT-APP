/**
 * react-agent — ACI observation hygiene (SWE-agent, arXiv:2405.15793).
 *
 * Pins the three Agent-Computer-Interface behaviours added to the loop:
 *   1. formatObservation — no silent truncation: over-cap tool output becomes
 *      an explicit envelope (total size, head/tail, refine instruction);
 *      empty output becomes an explicit "ran successfully" note.
 *   2. elideStaleObservations — always-on aging: tool observations older than
 *      the last OBS_KEEP_ROUNDS rounds collapse to a one-line gist while the
 *      thoughts/actions (the plan) stay verbatim, pairing-safe and idempotent.
 *   3. Duplicate-call cache — an identical read-only call short-circuits to
 *      the cached result with a do-not-repeat warning instead of re-executing,
 *      and persistent repeats trip the forced-finalize escape hatch.
 */

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const reactAgent = require('../src/services/react-agent');
const {
  run,
  formatObservation,
  elideStaleObservations,
  toolCallSignature,
  ELIDED_OBS_PREFIX,
  OBS_KEEP_ROUNDS,
  EXHAUSTED_REPOLL_LIMIT,
} = reactAgent;

// ── helpers ──────────────────────────────────────────────────────────────

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
    { role: 'system', content: 'SYSTEM PROMPT.' },
    { role: 'user', content: 'ORIGINAL QUERY.' },
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

/** Scripted OpenAI client (same shape as react-agent-compaction.test.js). */
function makeRecordingOpenAI(script) {
  let i = 0;
  let callId = 0;
  const sentMessages = [];
  return {
    sentMessages,
    chat: {
      completions: {
        create: async (params) => {
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

// ── formatObservation ─────────────────────────────────────────────────────

test('formatObservation: small observation passes through as plain JSON', () => {
  const out = formatObservation({ result: { hits: 3 } });
  assert.equal(out, JSON.stringify({ result: { hits: 3 } }));
});

test('formatObservation: empty output becomes an explicit success note', () => {
  for (const empty of [null, {}, '', [], { result: null }, { result: '' }]) {
    const out = JSON.parse(formatObservation(empty));
    assert.equal(out.ok, true);
    assert.match(out.note, /no output/i);
  }
});

test('formatObservation: over-cap output is an explicit envelope, never a silent prefix', () => {
  const big = { result: 'A'.repeat(50_000) };
  const out = formatObservation(big, 8000);
  const parsed = JSON.parse(out); // must always be valid JSON
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.total_chars, JSON.stringify(big).length);
  assert.match(parsed.note, /truncated/i);
  assert.match(parsed.note, /refine/i);
  assert.ok(parsed.head.length > 0 && parsed.tail.length > 0, 'shows head AND tail');
  assert.ok(out.length < 12_000, `envelope stays near the cap (got ${out.length})`);
});

test('formatObservation: non-serializable input degrades to a structured error', () => {
  const cyclic = {};
  cyclic.self = cyclic;
  const parsed = JSON.parse(formatObservation(cyclic));
  assert.equal(parsed.error, 'non_serializable_tool_output');
});

// ── elideStaleObservations ───────────────────────────────────────────────

test('elideStaleObservations: collapses observations older than the keep window', () => {
  const messages = buildTrace(8);
  const elided = elideStaleObservations(messages, 5);
  assert.equal(elided, 3, 'first 3 of 8 rounds are stale');
  const toolMsgs = messages.filter((m) => m.role === 'tool');
  for (let r = 0; r < 8; r += 1) {
    const isStale = r < 3;
    assert.equal(
      toolMsgs[r].content.startsWith(ELIDED_OBS_PREFIX),
      isStale,
      `round ${r} ${isStale ? 'should' : 'should NOT'} be elided`
    );
  }
  // Thoughts (the plan) survive verbatim.
  const thoughts = messages.filter((m) => m.role === 'assistant').map((m) => m.content);
  assert.deepEqual(thoughts, Array.from({ length: 8 }, (_, r) => `thought for round ${r}`));
  assert.equal(pairingViolation(messages), null);
});

test('elideStaleObservations: idempotent and no-op when within the window', () => {
  const small = buildTrace(4);
  assert.equal(elideStaleObservations(small, 5), 0, 'within window → untouched');

  const messages = buildTrace(8);
  elideStaleObservations(messages, 5);
  const snapshot = JSON.stringify(messages);
  assert.equal(elideStaleObservations(messages, 5), 0, 'second pass elides nothing');
  assert.equal(JSON.stringify(messages), snapshot);
});

test('elideStaleObservations: tiny old observations are kept verbatim', () => {
  const messages = buildTrace(8, { bytesPerObs: 10 });
  assert.equal(elideStaleObservations(messages, 5), 0);
});

test('toolCallSignature: stable across key order, distinct across args', () => {
  assert.equal(
    toolCallSignature('web_search', JSON.stringify({ a: 1, b: 2 })),
    toolCallSignature('web_search', JSON.stringify({ b: 2, a: 1 }))
  );
  assert.notEqual(
    toolCallSignature('web_search', JSON.stringify({ q: 'x' })),
    toolCallSignature('web_search', JSON.stringify({ q: 'y' }))
  );
});

// ── end-to-end loop behaviour ────────────────────────────────────────────

function countingSearchTool(result = { hits: ['r1', 'r2'] }) {
  const tool = {
    name: 'web_search',
    description: 'search',
    parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    executions: 0,
    execute: async () => { tool.executions += 1; return result; },
  };
  return tool;
}

test('loop: identical read-only call is served from cache, not re-executed', async () => {
  const tool = countingSearchTool();
  const openai = makeRecordingOpenAI([
    { tool: 'web_search', args: { q: 'same' } },
    { tool: 'web_search', args: { q: 'same' } }, // exact duplicate
    { finalize: 'done' },
  ]);
  const res = await run(openai, { query: 'q', tools: [tool], maxSteps: 6 });
  assert.equal(res.stoppedReason, 'finalized');
  assert.equal(tool.executions, 1, 'duplicate must not re-execute the tool');

  const dupObservation = res.steps[1].actions[0].observation;
  assert.equal(dupObservation.warning, 'duplicate_tool_call');
  assert.match(dupObservation.message, /do not repeat/i);
  assert.ok(
    String(dupObservation.cached_result).includes('r1'),
    'the cached result is handed back so the model is never starved of data'
  );
  for (const sent of openai.sentMessages) assert.equal(pairingViolation(sent), null);
});

test('loop: different args re-execute normally (no false duplicate)', async () => {
  const tool = countingSearchTool();
  const openai = makeRecordingOpenAI([
    { tool: 'web_search', args: { q: 'one' } },
    { tool: 'web_search', args: { q: 'two' } },
    { finalize: 'done' },
  ]);
  await run(openai, { query: 'q', tools: [tool], maxSteps: 6 });
  assert.equal(tool.executions, 2);
});

test(`loop: ${EXHAUSTED_REPOLL_LIMIT} consecutive duplicates force finalize`, async () => {
  const tool = countingSearchTool();
  const script = [{ tool: 'web_search', args: { q: 'loop' } }];
  for (let i = 0; i < EXHAUSTED_REPOLL_LIMIT + 2; i += 1) {
    script.push({ tool: 'web_search', args: { q: 'loop' } });
  }
  const openai = makeRecordingOpenAI(script);
  const res = await run(openai, { query: 'q', tools: [tool], maxSteps: 20 });
  assert.equal(res.stoppedReason, 'finalized');
  assert.equal(res.finalAnswer, 'Forced final answer.');
  assert.equal(tool.executions, 1);
  // The run must have ended well before the step budget.
  assert.ok(res.steps.length <= 2 + EXHAUSTED_REPOLL_LIMIT, `looped run ended early (${res.steps.length} steps)`);
});

test('loop: empty tool output reaches the model as an explicit success note', async () => {
  const tool = {
    name: 'web_search',
    description: 'search',
    parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    execute: async () => null,
  };
  const openai = makeRecordingOpenAI([
    { tool: 'web_search', args: { q: 'void' } },
    { finalize: 'done' },
  ]);
  await run(openai, { query: 'q', tools: [tool], maxSteps: 4 });
  const lastSent = openai.sentMessages[openai.sentMessages.length - 1];
  const toolMsg = lastSent.find((m) => m.role === 'tool');
  assert.match(toolMsg.content, /no output/i);
});

test('loop: oversized tool output reaches the model as an explicit truncation envelope', async () => {
  const tool = {
    name: 'web_search',
    description: 'search',
    parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    execute: async () => ({ page: 'B'.repeat(40_000) }),
  };
  const openai = makeRecordingOpenAI([
    { tool: 'web_search', args: { q: 'big' } },
    { finalize: 'done' },
  ]);
  await run(openai, { query: 'q', tools: [tool], maxSteps: 4 });
  const lastSent = openai.sentMessages[openai.sentMessages.length - 1];
  const toolMsg = lastSent.find((m) => m.role === 'tool');
  const parsed = JSON.parse(toolMsg.content);
  assert.equal(parsed.truncated, true);
  assert.match(parsed.note, /refine/i);
});

test('loop: observations age out of the trace while recent rounds stay verbatim', async () => {
  const rounds = OBS_KEEP_ROUNDS + 3;
  const tool = {
    name: 'web_search',
    description: 'search',
    parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    execute: async (args) => ({ q: args.q, body: 'C'.repeat(3000) }),
  };
  const script = [];
  for (let i = 0; i < rounds; i += 1) script.push({ tool: 'web_search', args: { q: `q${i}` } });
  script.push({ finalize: 'done' });
  const openai = makeRecordingOpenAI(script);
  const res = await run(openai, { query: 'q', tools: [tool], maxSteps: rounds + 2 });
  assert.equal(res.stoppedReason, 'finalized');

  const lastSent = openai.sentMessages[openai.sentMessages.length - 1];
  const toolMsgs = lastSent.filter((m) => m.role === 'tool');
  const elided = toolMsgs.filter((m) => m.content.startsWith(ELIDED_OBS_PREFIX));
  const verbatim = toolMsgs.filter((m) => !m.content.startsWith(ELIDED_OBS_PREFIX));
  assert.ok(elided.length >= 1, 'old observations were elided');
  assert.ok(verbatim.length >= 1, 'recent observations stay verbatim');
  // The most recent tool message must never be elided.
  assert.ok(!toolMsgs[toolMsgs.length - 1].content.startsWith(ELIDED_OBS_PREFIX));
  assert.equal(pairingViolation(lastSent), null);
});
