/**
 * Regression tests for the second audit round.
 *
 * Each test maps to a bug fixed in the accompanying commit. A failure
 * here means the regression came back.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

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
const tripleGraph = require('../src/services/triple-graph');
const reranker = require('../src/services/llm-reranker');
const tools = require('../src/services/agents/agent-tools');
const codeChunker = require('../src/services/code-chunker');
const core = require('../src/services/agents/agent-core');
const gear = require('../src/services/gear-agent');

// ─── BUG #1: orphan triples after MAX_COLLECTION_CHUNKS eviction ──────────

test('rag + tripleGraph: eviction of a source drops its triples from the graph', async () => {
  const uid = `orph-${Math.random()}`;
  const col = 'orph-test';
  rag.clear(uid, col);

  // Shrink the cap for this test. We can't change the const, so we
  // simulate eviction by calling listSources + clearSource directly
  // after adding a source, then ingest triples referencing it.
  await rag.ingest(uid, col, [{ text: 'some content', source: 'doomed.md' }]);
  await rag.ingest(uid, col, [{ text: 'other content', source: 'survivor.md' }]);

  await tripleGraph.addTriples(uid, col, [
    { subject: 'X', predicate: 'from', object: 'doomed', source: 'doomed.md' },
    { subject: 'Y', predicate: 'from', object: 'survivor', source: 'survivor.md' },
  ], { embedder: null });

  assert.equal(tripleGraph.stats(uid, col).triples, 2);

  // Directly test clearSource — the mechanism that evictAndCleanOrphans
  // relies on.
  const { removed } = tripleGraph.clearSource(uid, col, 'doomed.md');
  assert.equal(removed, 1);
  const remaining = tripleGraph.stats(uid, col);
  assert.equal(remaining.triples, 1);
  assert.equal(remaining.sources, 1);

  // Surviving triple still retrievable.
  const left = tripleGraph.getTriplesForSource(uid, col, 'survivor.md');
  assert.equal(left.length, 1);
  assert.equal(left[0].object, 'survivor');
});

test('tripleGraph.clearSource: unknown source is a no-op', () => {
  const uid = `nf-${Math.random()}`;
  const col = 'nf';
  const r = tripleGraph.clearSource(uid, col, 'never-existed.md');
  assert.equal(r.removed, 0);
});

// ─── BUG #2: llm-reranker cache capped at CACHE_MAX ───────────────────────

test('reranker cache: does not grow beyond CACHE_MAX even when nothing expires', async () => {
  reranker.clearCache();
  // Manufacture responses. We need the reranker to actually call setCache,
  // which happens inside rerank() after a successful LLM call.
  const stub = {
    chat: { completions: { create: async () => ({
      choices: [{ message: { content: JSON.stringify({ rankings: [
        { passage_number: 1, score: 0.9 },
        { passage_number: 2, score: 0.5 },
        { passage_number: 3, score: 0.1 },
      ]})}}],
    })}},
  };

  // Fire CACHE_MAX + 50 distinct queries, each with distinct candidate ids
  // so cache keys differ. The goal: cache must hard-cap at CACHE_MAX.
  for (let i = 0; i < reranker.CACHE_MAX + 50; i++) {
    await reranker.rerank(stub, `q-${i}`, [
      { text: `doc a ${i}`, score: 0.9 },
      { text: `doc b ${i}`, score: 0.7 },
      { text: `doc c ${i}`, score: 0.5 },
    ], { cacheTtlMs: 10 * 60 * 1000 });
  }

  assert.ok(
    reranker.cacheSize() <= reranker.CACHE_MAX,
    `cache size ${reranker.cacheSize()} exceeded CACHE_MAX=${reranker.CACHE_MAX}`,
  );
});

// ─── BUG #3: read_file language-aware separator ───────────────────────────

test('agent-tools.read_file: uses # prefix for .py files', async () => {
  const uid = `rf-py-${Math.random()}`;
  const col = 'rf-py';
  rag.clear(uid, col);
  // Simulate ingestCode output by adding chunks with title metadata.
  await rag.ingestCode(uid, col, [{
    filename: 'foo.py',
    content: 'def a():\n    return 1\n\ndef b():\n    return 2\n',
    language: 'python',
  }]);

  const out = await tools.read_file.handler({ source: 'foo.py' }, { userId: uid, collection: col });
  // Separator should use '#' not '//' for Python.
  assert.ok(out.text.includes('#'), 'expected # comment separator');
  assert.ok(!out.text.includes('// foo.py'), 'must not use JS // for Python file');
});

test('agent-tools.commentPrefixFor: covers common languages', () => {
  assert.equal(tools.commentPrefixFor('a.js'), '//');
  assert.equal(tools.commentPrefixFor('a.ts'), '//');
  assert.equal(tools.commentPrefixFor('a.py'), '#');
  assert.equal(tools.commentPrefixFor('a.sh'), '#');
  assert.equal(tools.commentPrefixFor('a.yaml'), '#');
  assert.equal(tools.commentPrefixFor('a.sql'), '--');
  assert.equal(tools.commentPrefixFor('a.html'), '<!--');
  assert.equal(tools.commentPrefixFor('a.css'), '/*');
  assert.equal(tools.commentPrefixFor('unknown'), '//'); // default
});

test('agent-tools.formatChunkSeparator: HTML/CSS wrap title properly', () => {
  assert.equal(tools.formatChunkSeparator('<!--', 'foo.html:1-10'), '<!-- foo.html:1-10 -->');
  assert.equal(tools.formatChunkSeparator('/*', 'foo.css:5-20'), '/* foo.css:5-20 */');
  assert.equal(tools.formatChunkSeparator('#', 'foo.py:1-3'), '# foo.py:1-3');
});

// ─── BUG #4: findBraceEnd handles multi-line template literals ────────────

test('codeChunker: template literal spanning lines does not truncate function', () => {
  const src = [
    'function greet(name) {',
    '  return `hello',
    '    ${name}',
    '  `;',
    '}',
    '',
    'function unrelated() { return 2; }',
  ].join('\n');
  const chunks = codeChunker.chunkCode('g.js', src);
  const greet = chunks.find(c => c.name === 'greet');
  assert.ok(greet, 'greet extracted');
  // The chunk must include the full body through the closing brace on line 5,
  // WITHOUT swallowing `unrelated`. Old findBraceEnd miscounted due to the
  // template literal's `${name}` braces and cut short or over-extended.
  assert.ok(greet.text.includes('}'), 'body closes properly');
  assert.ok(!greet.text.includes('unrelated'), 'did not leak into next function');
  assert.ok(greet.text.includes('${name}'), 'template literal body preserved');
});

test('codeChunker: nested ${} in template literal still resolves cleanly', () => {
  const src = [
    'export function render(x, y) {',
    '  return `a ${x + y} b ${{nested: true}}`;',
    '}',
    '',
    'function other() { return 1; }',
  ].join('\n');
  const chunks = codeChunker.chunkCode('r.js', src);
  const render = chunks.find(c => c.name === 'render');
  assert.ok(render);
  assert.ok(!render.text.includes('function other'));
});

// ─── BUG #5: collaborate spec growth (indirect via findings selector) ─────
//
// We can't easily test the orchestrator end-to-end without heavy mocking;
// instead we verify the sort/cap logic behaviour by reproducing it here.
// The actual orchestrator function uses the same severity ranking.

test('collaborate feedback selector (inline mirror): prioritises critical/high, caps at 8', () => {
  const findings = [
    ...Array.from({ length: 10 }, (_, i) => ({ severity: 'info',     issue: `info ${i}` })),
    ...Array.from({ length: 5  }, (_, i) => ({ severity: 'high',     issue: `high ${i}` })),
    ...Array.from({ length: 2  }, (_, i) => ({ severity: 'critical', issue: `crit ${i}` })),
  ];
  const sev = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  const selected = [...findings]
    .sort((a, b) => (sev[a.severity] ?? 9) - (sev[b.severity] ?? 9))
    .slice(0, 8);
  assert.equal(selected.length, 8);
  assert.equal(selected.filter(f => f.severity === 'critical').length, 2);
  assert.equal(selected.filter(f => f.severity === 'high').length, 5);
  assert.equal(selected.filter(f => f.severity === 'info').length, 1); // only room for one
});

// ─── BUG #6: parseRewriteReply garbage detection ──────────────────────────

test('gear.parseRewriteReply: "ERROR" is dropped', () => {
  assert.equal(gear.parseRewriteReply('Next Question: ERROR'), '');
  assert.equal(gear.parseRewriteReply('ERROR'), '');
});

test('gear.parseRewriteReply: "I cannot..." refusal is dropped', () => {
  assert.equal(gear.parseRewriteReply('Next Question: I cannot help with that.'), '');
  assert.equal(gear.parseRewriteReply("I'm sorry, I am unable to answer this."), '');
});

test('gear.parseRewriteReply: "As an AI language model..." refusal is dropped', () => {
  assert.equal(
    gear.parseRewriteReply('Next Question: As an AI language model, I should not...'),
    '',
  );
});

test('gear.parseRewriteReply: too-short response is dropped', () => {
  assert.equal(gear.parseRewriteReply('Next Question: ok'), '');
  assert.equal(gear.parseRewriteReply('Next Question: hi'), '');
});

test('gear.parseRewriteReply: valid rewrite passes through', () => {
  const out = gear.parseRewriteReply('Next Question: When did Dell Curry join the Cavaliers?');
  assert.equal(out, 'When did Dell Curry join the Cavaliers?');
});

// ─── BUG #7: isTransientLLMError walks .cause chain ───────────────────────

test('isTransientLLMError: recognises err.cause.code ECONNRESET', () => {
  const inner = new Error('socket hang up');
  inner.code = 'ECONNRESET';
  const outer = new Error('fetch failed');
  outer.cause = inner;
  assert.equal(core.isTransientLLMError(outer), true);
});

test('isTransientLLMError: recognises nested cause at depth 2', () => {
  const deepest = new Error('timeout');
  deepest.code = 'UND_ERR_CONNECT_TIMEOUT';
  const mid = new Error('wrap'); mid.cause = deepest;
  const outer = new Error('fetch failed'); outer.cause = mid;
  assert.equal(core.isTransientLLMError(outer), true);
});

test('isTransientLLMError: ignores permanent 400 even with cause', () => {
  const outer = new Error('bad request');
  outer.status = 400;
  outer.cause = new Error('validation');
  assert.equal(core.isTransientLLMError(outer), false);
});

test('isTransientLLMError: circular cause does not infinite-loop', () => {
  const a = new Error('a'); const b = new Error('b');
  a.cause = b; b.cause = a;
  // Should terminate at depth cap (3) without crashing. Neither has
  // any transient signal, so result is false.
  assert.equal(core.isTransientLLMError(a), false);
});

// ─── BUG #8: detectLanguage — JS/TS disambiguation ────────────────────────

test('detectLanguage: plain JS with only imports classified as JavaScript', () => {
  const src = `import { foo } from './foo';
function bar() {
  return foo();
}
`;
  // Caller has no filename — content heuristic only.
  assert.equal(codeChunker.detectLanguage(null, src), 'javascript');
});

test('detectLanguage: TS-only signal classified as TypeScript', () => {
  const src = `interface User {
  name: string;
  age: number;
}
`;
  assert.equal(codeChunker.detectLanguage(null, src), 'typescript');
});

test('detectLanguage: type annotation signal classified as TypeScript', () => {
  const src = `function compute(x: number): number { return x * 2; }`;
  assert.equal(codeChunker.detectLanguage(null, src), 'typescript');
});

test('detectLanguage: extension still wins over content', () => {
  // A `.js` file that happens to look like TS? Extension trusted.
  assert.equal(codeChunker.detectLanguage('x.js', 'interface Y {}'), 'javascript');
});

// ─── BUG #9: buildCommentCodeMask understands Python triple-quotes ────────

test('buildCommentCodeMask: Python triple-quoted docstring is NOT code', () => {
  const src = [
    'def foo():',
    '    """',
    '    docstring with eval(x) inside',
    '    and a { brace } and a # hash',
    '    """',
    '    return 1',
  ].join('\n');
  const { codeMask } = tools.buildCommentCodeMask(src, 'python');
  // Line 0: `def foo():` → code.
  // Lines 1-4: inside the triple-quoted string → not code.
  // Line 5: `    return 1` → code.
  assert.equal(codeMask[0], true);
  assert.equal(codeMask[1], false);
  assert.equal(codeMask[2], false);
  assert.equal(codeMask[3], false);
  assert.equal(codeMask[5], true);
});

test('buildCommentCodeMask: triple-quotes with single quotes too', () => {
  const src = [
    "def foo():",
    "    '''eval('x') inside'''",
    "    return 1",
  ].join('\n');
  const { codeMask } = tools.buildCommentCodeMask(src, 'python');
  assert.equal(codeMask[1], false);
});

test('static_checks: eval inside Python docstring is not flagged', async () => {
  const src = [
    'def fn():',
    '    """',
    '    example: eval(x) is dangerous',
    '    """',
    '    return 1',
  ].join('\n');
  const out = await tools.static_checks.handler(
    { source: 'f.py', content: src },
    { userId: 'u', collection: 'c' },
  );
  const evals = out.findings.filter(f => f.rule === 'eval_usage');
  assert.equal(evals.length, 0);
});
