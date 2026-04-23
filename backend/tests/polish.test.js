/**
 * Polish-round tests:
 *   - rag.listSources / rag.getBySource
 *   - agent-core: findBalancedJSON edge cases, retry on transient error,
 *     onStep streaming hook, approxTokens, tool-result cache
 *   - agent-tools: buildCommentCodeMask, comment-aware static checks,
 *     rewritten read_file / list_files / get_symbol
 *   - log-analysis: clusterLines, normaliseLogLine
 *   - requirements-agent: normalizeRequirements
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Stub openai BEFORE requires.
function fakeVectorFor(text) {
  const v = new Float32Array(8);
  const tokens = (text || '').toLowerCase().match(/[a-z0-9_]+/g) || [];
  for (const t of tokens) {
    let h = 0;
    for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) % 8;
    v[h] += 1;
  }
  let n = 0;
  for (let i = 0; i < 8; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < 8; i++) v[i] /= n;
  return v;
}
require.cache[require.resolve('openai')] = {
  exports: class FakeOpenAI {
    constructor() {
      this.embeddings = {
        create: async ({ input }) => ({
          data: input.map(text => ({ embedding: Array.from(fakeVectorFor(text)) })),
        }),
      };
    }
  },
};
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'fake-key';

const rag = require('../src/services/rag-service');
const core = require('../src/services/agents/agent-core');
const tools = require('../src/services/agents/agent-tools');
const requirements = require('../src/services/agents/requirements-agent');
const logAgent = require('../src/services/agents/log-analysis-agent');

// ─── rag.listSources / getBySource ─────────────────────────────────────────

test('rag.listSources: enumerates distinct sources deterministically', async () => {
  const uid = `p-${Math.random()}`;
  const col = 'p-list';
  await rag.clear(uid, col);
  await rag.ingest(uid, col, [
    { text: 'alpha 1', source: 'a.md' },
    { text: 'alpha 2', source: 'a.md' },
    { text: 'beta', source: 'b.md' },
  ]);
  const out = await rag.listSources(uid, col);
  assert.equal(out.length, 2);
  // Alphabetically sorted for stability.
  assert.equal(out[0].source, 'a.md');
  assert.equal(out[0].chunks, 2);
  assert.equal(out[1].source, 'b.md');
  assert.equal(out[1].chunks, 1);
});

test('rag.listSources: empty collection returns []', async () => {
  const uid = `p-${Math.random()}`;
  await rag.clear(uid, 'empty');
  assert.deepEqual(await rag.listSources(uid, 'empty'), []);
});

test('rag.getBySource: returns all chunks for one source, in ingest order', async () => {
  const uid = `p-${Math.random()}`;
  const col = 'p-get';
  await rag.clear(uid, col);
  await rag.ingest(uid, col, [
    { text: 'first chunk', source: 'x.md' },
    { text: 'second chunk', source: 'x.md' },
    { text: 'other', source: 'y.md' },
  ]);
  const chunks = await rag.getBySource(uid, col, 'x.md');
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].text, 'first chunk');
  assert.equal(chunks[1].text, 'second chunk');
  // Embedding should be stripped.
  assert.ok(!('embedding' in chunks[0]));
});

test('rag.getBySource: unknown source returns []', async () => {
  const uid = `p-${Math.random()}`;
  const col = 'p-get2';
  await rag.clear(uid, col);
  await rag.ingest(uid, col, [{ text: 't', source: 'a.md' }]);
  assert.deepEqual(await rag.getBySource(uid, col, 'nope'), []);
});

// ─── agent-core.findBalancedJSON ───────────────────────────────────────────

test('findBalancedJSON: handles braces inside string literals', () => {
  const raw = 'Prelude text {"code": "function f() { return { a: 1 }; }"}';
  const found = core.findBalancedJSON(raw);
  const parsed = JSON.parse(found);
  assert.equal(parsed.code, 'function f() { return { a: 1 }; }');
});

test('findBalancedJSON: handles escaped quotes inside strings', () => {
  const raw = '{"msg":"she said \\"hi\\" to { everyone }"}';
  const found = core.findBalancedJSON(raw);
  const parsed = JSON.parse(found);
  assert.ok(parsed.msg.includes('"hi"'));
});

test('findBalancedJSON: no braces → null', () => {
  assert.equal(core.findBalancedJSON('nothing here'), null);
});

test('findBalancedJSON: unclosed brace → null', () => {
  assert.equal(core.findBalancedJSON('{"a": 1'), null);
});

test('extractJSON: complex nested with escapes survives', () => {
  const raw = '```json\n{"a":"b \\"c\\" }","arr":[1,2,3]}\n```';
  const parsed = core.extractJSON(raw);
  assert.deepEqual(parsed.arr, [1, 2, 3]);
});

// ─── agent-core: retry ─────────────────────────────────────────────────────

test('isTransientLLMError: matches 429 + 5xx + network phrases', () => {
  assert.equal(core.isTransientLLMError({ status: 429 }), true);
  assert.equal(core.isTransientLLMError({ status: 503 }), true);
  assert.equal(core.isTransientLLMError({ status: 400 }), false);
  assert.equal(core.isTransientLLMError(new Error('rate limit exceeded')), true);
  assert.equal(core.isTransientLLMError(new Error('ECONNRESET')), true);
  assert.equal(core.isTransientLLMError(new Error('bad request')), false);
});

test('callLLMWithRetry: retries on 429, succeeds on 2nd attempt', async () => {
  let calls = 0;
  const openai = {
    chat: { completions: { create: async () => {
      calls++;
      if (calls === 1) {
        const err = new Error('rate limit'); err.status = 429; throw err;
      }
      return { choices: [{ message: { content: '{"ok":true}' } }] };
    }}},
  };
  const resp = await core.callLLMWithRetry(openai, { model: 'm', messages: [] });
  assert.equal(calls, 2);
  assert.equal(resp.choices[0].message.content, '{"ok":true}');
});

test('callLLMWithRetry: does NOT retry on 400 — throws immediately', async () => {
  let calls = 0;
  const openai = {
    chat: { completions: { create: async () => {
      calls++;
      const err = new Error('bad request'); err.status = 400; throw err;
    }}},
  };
  await assert.rejects(core.callLLMWithRetry(openai, { model: 'm', messages: [] }));
  assert.equal(calls, 1);
});

// ─── agent-core: onStep streaming + stats ──────────────────────────────────

test('run(): onStep fires for every trace step', async () => {
  const scripted = [
    JSON.stringify({ tool: 'noop', args: { x: 1 } }),
    JSON.stringify({ final: 'done' }),
  ];
  let i = 0;
  const openai = { chat: { completions: { create: async () => ({
    choices: [{ message: { content: scripted[Math.min(i++, scripted.length - 1)] } }],
  })}}};
  const noop = { name: 'noop', description: '', schema: {}, handler: async () => 'ok' };
  const steps = [];
  await core.run({ openai, goal: 'g', tools: [noop], onStep: s => steps.push(s) });
  assert.ok(steps.length >= 2);
  assert.equal(steps[steps.length - 1].final, 'done');
});

test('run(): stats contains toolCalls, token estimates, durationMs', async () => {
  const openai = { chat: { completions: { create: async () => ({
    choices: [{ message: { content: JSON.stringify({ final: 'ok' }) } }],
  })}}};
  const r = await core.run({ openai, goal: 'g', tools: [] });
  assert.equal(typeof r.stats.toolCalls, 'number');
  assert.equal(typeof r.stats.approxPromptTokens, 'number');
  assert.ok(r.stats.approxPromptTokens > 0);
  assert.ok(r.stats.durationMs >= 0);
});

// ─── agent-core: tool-result cache ─────────────────────────────────────────

test('run(): repeated tool call with identical args is served from cache', async () => {
  const scripted = [
    JSON.stringify({ tool: 'lookup', args: { id: 'x' } }),
    JSON.stringify({ tool: 'lookup', args: { id: 'x' } }), // same as prev
    JSON.stringify({ final: 'done' }),
  ];
  let i = 0;
  const openai = { chat: { completions: { create: async () => ({
    choices: [{ message: { content: scripted[Math.min(i++, scripted.length - 1)] } }],
  })}}};
  let handlerCalls = 0;
  const lookup = {
    name: 'lookup', description: '', schema: {},
    handler: async () => { handlerCalls++; return 'data'; },
  };
  const r = await core.run({ openai, goal: 'g', tools: [lookup] });
  assert.equal(r.stats.toolCalls, 1, 'real invocation runs once');
  assert.equal(r.stats.toolCacheHits, 1, 'second call is a cache hit');
  assert.equal(handlerCalls, 1);
});

// ─── agent-tools: buildCommentCodeMask ─────────────────────────────────────

test('buildCommentCodeMask: line with only // comment is NOT code', () => {
  const { codeMask } = tools.buildCommentCodeMask('// just a comment\nconst x = 1;', 'javascript');
  assert.equal(codeMask[0], false);
  assert.equal(codeMask[1], true);
});

test('buildCommentCodeMask: /* block */ spans multiple lines', () => {
  const src = 'const a = 1;\n/* block comment\n on two lines */\nconst b = 2;';
  const { codeMask } = tools.buildCommentCodeMask(src, 'javascript');
  assert.equal(codeMask[0], true);
  assert.equal(codeMask[1], false);
  assert.equal(codeMask[2], false);
  assert.equal(codeMask[3], true);
});

test('buildCommentCodeMask: python # comments', () => {
  const { codeMask } = tools.buildCommentCodeMask('# comment\nx = 1', 'python');
  assert.equal(codeMask[0], false);
  assert.equal(codeMask[1], true);
});

test('buildCommentCodeMask: pure string-literal line is NOT flagged as code', () => {
  // The mask's purpose is to answer "does this line contain executable
  // code OUTSIDE strings and comments?" so that checks like eval_usage
  // don't fire on `"example: eval(x)"`. A line that's nothing but a
  // string literal has no executable content — mask is false.
  const { codeMask } = tools.buildCommentCodeMask('"just a string"', 'javascript');
  assert.equal(codeMask[0], false);
});

test('buildCommentCodeMask: mixed line with code + string literal IS code', () => {
  const { codeMask } = tools.buildCommentCodeMask('const s = "hello";', 'javascript');
  assert.equal(codeMask[0], true);
});

test('stripStringLiterals: removes contents, keeps quotes', () => {
  assert.equal(tools.stripStringLiterals('const x = "dangerous eval(y)";'), 'const x = "";');
  assert.equal(tools.stripStringLiterals("msg('hi')"), "msg('')");
});

test('stripStringLiterals: escaped quotes inside string handled', () => {
  const out = tools.stripStringLiterals('const s = "a \\"b\\" c"; real code');
  assert.ok(out.includes('""'));
  assert.ok(out.includes('real code'));
});

// ─── agent-tools: static_checks comment-aware ──────────────────────────────

test('static_checks: console.log inside // comment is NOT flagged', async () => {
  const out = await tools.static_checks.handler(
    { source: 'x.js', content: '// TODO: remove console.log below\nconst a = 1;' },
    { userId: 'u', collection: 'c' },
  );
  // Only the TODO should fire (that check doesn't consult the mask —
  // TODOs in comments are what we want). console_log should NOT fire.
  const todos = out.findings.filter(f => f.rule === 'todo_fixme');
  const consoles = out.findings.filter(f => f.rule === 'console_log');
  assert.ok(todos.length >= 1);
  assert.equal(consoles.length, 0);
});

test('static_checks: eval inside a string literal is NOT flagged', async () => {
  const out = await tools.static_checks.handler(
    { source: 'x.js', content: 'const s = "example with eval(code) inside";' },
    { userId: 'u', collection: 'c' },
  );
  const evals = out.findings.filter(f => f.rule === 'eval_usage');
  assert.equal(evals.length, 0);
});

test('static_checks: AWS access key secret regex fires', async () => {
  const out = await tools.static_checks.handler(
    { source: 'cfg.js', content: 'const key = "AKIAIOSFODNN7EXAMPLE";' },
    { userId: 'u', collection: 'c' },
  );
  const hits = out.findings.filter(f => f.rule === 'hardcoded_secret');
  assert.ok(hits.length >= 1);
  assert.ok(hits[0].message.includes('AWS'));
});

test('static_checks: empty catch block flagged in JS', async () => {
  const out = await tools.static_checks.handler(
    { source: 'x.js', content: 'try { doIt(); } catch (e) {}\n' },
    { userId: 'u', collection: 'c' },
  );
  const hits = out.findings.filter(f => f.rule === 'empty_catch');
  assert.ok(hits.length >= 1);
});

// ─── agent-tools: rewritten read_file / list_files / get_symbol ───────────

test('read_file: returns full text for an ingested file', async () => {
  const uid = `p-${Math.random()}`;
  const col = 'p-rf';
  await rag.clear(uid, col);
  await rag.ingest(uid, col, [{ text: 'complete file content', source: 'only.md' }]);
  const out = await tools.read_file.handler({ source: 'only.md' }, { userId: uid, collection: col });
  assert.ok(out.text.includes('complete file content'));
  assert.equal(out.chunks, 1);
});

test('read_file: missing source returns error', async () => {
  const uid = `p-${Math.random()}`;
  const col = 'p-rf2';
  await rag.clear(uid, col);
  await rag.ingest(uid, col, [{ text: 'x', source: 'a.md' }]);
  const out = await tools.read_file.handler({ source: 'nope.md' }, { userId: uid, collection: col });
  assert.ok(out.error);
});

test('list_files: returns deterministic alphabetical list', async () => {
  const uid = `p-${Math.random()}`;
  const col = 'p-lf';
  await rag.clear(uid, col);
  await rag.ingest(uid, col, [
    { text: 'c', source: 'gamma.md' },
    { text: 'a', source: 'alpha.md' },
    { text: 'b', source: 'beta.md' },
  ]);
  const out = await tools.list_files.handler({}, { userId: uid, collection: col });
  assert.equal(out.count, 3);
  assert.deepEqual(out.files.map(f => f.source), ['alpha.md', 'beta.md', 'gamma.md']);
});

test('list_files: contains filter narrows results', async () => {
  const uid = `p-${Math.random()}`;
  const col = 'p-lf2';
  await rag.clear(uid, col);
  await rag.ingest(uid, col, [
    { text: 't', source: 'src/auth/login.ts' },
    { text: 't', source: 'src/auth/logout.ts' },
    { text: 't', source: 'src/util/date.ts' },
  ]);
  const out = await tools.list_files.handler({ contains: 'auth' }, { userId: uid, collection: col });
  assert.equal(out.count, 2);
});

test('get_symbol: fast path uses ingestCode metadata for correct line numbers', async () => {
  const uid = `p-${Math.random()}`;
  const col = 'p-gs';
  await rag.clear(uid, col);
  const src = `// some preamble
import { x } from 'y';

export function alpha() {
  return 1;
}

export function beta() {
  return 2;
}
`;
  await rag.ingestCode(uid, col, [{ filename: 'foo.ts', content: src }]);
  const out = await tools.get_symbol.handler(
    { source: 'foo.ts', symbol: 'beta' },
    { userId: uid, collection: col },
  );
  assert.equal(out.match, 'exact');
  assert.ok(out.chunks[0].text.includes('beta'));
  assert.ok(out.chunks[0].startLine > 0);
});

// ─── log-analysis-agent: clustering ───────────────────────────────────────

test('normaliseLogLine: timestamps/UUIDs/numbers/IPs replaced', () => {
  const raw = '2026-04-20T12:34:56.123Z ERROR user=abc-123 ip=192.168.1.1 status=500 msg="connection failed"';
  const norm = logAgent.normaliseLogLine(raw);
  assert.ok(norm.includes('<TS>'));
  assert.ok(norm.includes('<IP>'));
  assert.ok(norm.includes('<N>'));
  assert.ok(norm.includes('<STR>'));
});

test('clusterLines: groups identical-after-normalisation lines', () => {
  const lines = [
    '2026-04-20T10:00:00Z ERROR connection to 10.0.0.1 failed',
    '2026-04-20T10:00:01Z ERROR connection to 10.0.0.2 failed',
    '2026-04-20T10:00:02Z ERROR connection to 10.0.0.3 failed',
    'INFO startup ok',
  ];
  const clusters = logAgent.clusterLines(lines, { topK: 5 });
  // First 3 collapse to one cluster of count=3.
  const biggest = clusters[0];
  assert.equal(biggest.count, 3);
  assert.equal(clusters.length, 2);
});

test('clusterLines: empty input → []', () => {
  assert.deepEqual(logAgent.clusterLines([]), []);
});

test('clusterLines: minCount filters rare clusters', () => {
  const clusters = logAgent.clusterLines(
    ['err a', 'err a', 'err b'], // a appears twice, b once
    { topK: 5, minCount: 2 },
  );
  assert.equal(clusters.length, 1);
  assert.ok(clusters[0].signature.includes('a'));
});

// ─── requirements-agent: normalizer ───────────────────────────────────────

test('normalizeRequirements: shape-clamps and defaults missing fields', () => {
  const r = requirements.normalizeRequirements({
    final: {
      title: 'New Feature',
      user_stories: [
        { id: 'US1', role: 'admin', capability: 'revoke sessions', value: 'kick out bad actors' },
        { id: null, capability: 'x' }, // missing role/value OK
        null, // filtered
      ],
      open_questions: [
        { question: 'Do we support SSO?', why_it_matters: 'architecture choice' },
      ],
      estimated_complexity: 'galactic', // invalid
    },
    iterations: 3, terminatedBy: 'final',
    stats: { toolCalls: 2 },
  }, 'build auth thing');
  assert.equal(r.title, 'New Feature');
  assert.equal(r.user_stories.length, 2);
  assert.equal(r.estimated_complexity, 'medium'); // clamped
  assert.equal(r.original_request, 'build auth thing');
});

test('normalizeRequirements: empty input yields sane defaults', () => {
  const r = requirements.normalizeRequirements(
    { final: null, iterations: 0, terminatedBy: 'maxIters', stats: null },
    'a request',
  );
  assert.equal(r.user_stories.length, 0);
  assert.equal(r.estimated_complexity, 'medium');
});

// ─── Sanity: orchestrator intent router includes new intents ──────────────

test('orchestrator intents include requirements + log_analysis', () => {
  const orch = require('../src/services/agents/se-orchestrator');
  assert.ok(orch.VALID_INTENTS.has('requirements'));
  assert.ok(orch.VALID_INTENTS.has('log_analysis'));
});
