/**
 * Unit tests for services/agents/agent-tools.js.
 *
 * Focus on deterministic tool handlers (static_checks, propose_patch)
 * and the stop-gap tests for RAG-backed tools using the stubbed
 * embedding/openai module.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Stub openai before requiring any service.
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

const tools = require('../src/services/agents/agent-tools');
const rag = require('../src/services/rag-service');

// ─── static_checks (deterministic) ─────────────────────────────────────────

test('static_checks: flags TODO comments', async () => {
  const out = await tools.static_checks.handler(
    { source: 'x.js', content: 'const a = 1;\n// TODO: refactor later\nconst b = 2;\n' },
    { userId: 'u', collection: 'c' },
  );
  const todoHits = out.findings.filter(f => f.rule === 'todo_fixme');
  assert.equal(todoHits.length, 1);
  assert.equal(todoHits[0].line, 2);
});

test('static_checks: flags eval() and new Function()', async () => {
  const out = await tools.static_checks.handler(
    { source: 'x.js', content: 'const r = eval(userInput);\nconst fn = new Function("x", "return x+1");\n' },
    { userId: 'u', collection: 'c' },
  );
  const hi = out.findings.filter(f => f.rule === 'eval_usage');
  assert.equal(hi.length, 2);
  assert.ok(hi.every(f => f.severity === 'high'));
});

test('static_checks: flags hard-coded credentials', async () => {
  const out = await tools.static_checks.handler(
    { source: 'cfg.js', content: 'const api_key = "sk-1234567890abcdefghij";\n' },
    { userId: 'u', collection: 'c' },
  );
  const hits = out.findings.filter(f => f.rule === 'hardcoded_secret');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].severity, 'high');
});

test('static_checks: flags console.log and debugger', async () => {
  const out = await tools.static_checks.handler(
    { source: 'x.js', content: 'function f() { console.log("x"); debugger; return 1; }' },
    { userId: 'u', collection: 'c' },
  );
  const hits = out.findings.filter(f => f.rule === 'console_log');
  assert.ok(hits.length >= 1);
});

test('static_checks: long function warns', async () => {
  const long = 'function f() {\n' + 'const x = 1;\n'.repeat(100) + '}';
  const out = await tools.static_checks.handler(
    { source: 'x.js', content: long },
    { userId: 'u', collection: 'c' },
  );
  const hits = out.findings.filter(f => f.rule === 'long_function');
  assert.equal(hits.length, 1);
});

test('static_checks: counts severity buckets', async () => {
  const content = '// TODO: x\nconst s = "pass";\neval("danger");\n';
  const out = await tools.static_checks.handler(
    { source: 'x.js', content }, { userId: 'u', collection: 'c' },
  );
  assert.ok(out.counts.high >= 1);
  assert.ok(out.counts.info >= 1);
});

test('static_checks: returns error when source missing', async () => {
  const out = await tools.static_checks.handler({}, { userId: 'u', collection: 'c' });
  assert.ok(out.error);
});

// ─── propose_patch ─────────────────────────────────────────────────────────

test('propose_patch: returns structured proposal', async () => {
  const out = await tools.propose_patch.handler({
    source: 'x.js', start_line: 10, end_line: 15,
    replacement: 'return x * 2;', rationale: 'fixes off-by-one',
  }, {});
  assert.equal(out.proposed, true);
  assert.equal(out.start_line, 10);
  assert.equal(out.replacement, 'return x * 2;');
});

test('propose_patch: rejects missing replacement', async () => {
  const out = await tools.propose_patch.handler({ source: 'x.js' }, {});
  assert.ok(out.error);
});

// ─── RAG-backed tools ──────────────────────────────────────────────────────

test('read_file: reads chunks of a source', async () => {
  const uid = `at-${Math.random()}`;
  const col = 'at-read';
  rag.clear(uid, col);
  await rag.ingest(uid, col, [
    { text: 'Chunk alpha about foo', source: 'foo.md' },
    { text: 'Chunk beta about foo', source: 'foo.md' },
    { text: 'About bar', source: 'bar.md' },
  ]);
  const out = await tools.read_file.handler({ source: 'foo.md' }, { userId: uid, collection: col });
  assert.ok(out.text.includes('alpha'));
  assert.ok(out.text.includes('beta'));
  assert.equal(out.source, 'foo.md');
});

test('read_file: unknown source returns error', async () => {
  const uid = `at-${Math.random()}`;
  const col = 'at-read2';
  rag.clear(uid, col);
  await rag.ingest(uid, col, [{ text: 'only this', source: 'a.md' }]);
  const out = await tools.read_file.handler({ source: 'b.md' }, { userId: uid, collection: col });
  assert.ok(out.error);
});

test('list_files: enumerates distinct sources', async () => {
  const uid = `at-${Math.random()}`;
  const col = 'at-list';
  rag.clear(uid, col);
  await rag.ingest(uid, col, [
    { text: 'chunk 1', source: 'alpha.md' },
    { text: 'chunk 2', source: 'beta.md' },
    { text: 'chunk 3', source: 'gamma.md' },
  ]);
  const out = await tools.list_files.handler({}, { userId: uid, collection: col });
  const names = out.files.map(f => f.source);
  assert.ok(names.includes('alpha.md'));
  assert.ok(names.includes('beta.md'));
  assert.ok(names.includes('gamma.md'));
});

test('search_docs: returns ranked snippets', async () => {
  const uid = `at-${Math.random()}`;
  const col = 'at-search';
  rag.clear(uid, col);
  await rag.ingest(uid, col, [
    { text: 'pricing plan details per month', source: 'pricing.md' },
    { text: 'refund policy for annual', source: 'refunds.md' },
  ]);
  const out = await tools.search_docs.handler({ query: 'pricing' }, { userId: uid, collection: col });
  assert.ok(out.hits.length >= 1);
  assert.ok(out.hits[0].snippet.includes('pricing'));
});

test('pick(): returns named tools in order', () => {
  const picked = tools.pick(['read_file', 'propose_patch']);
  assert.equal(picked.length, 2);
  assert.equal(picked[0].name, 'read_file');
  assert.equal(picked[1].name, 'propose_patch');
});

test('pick(): ignores unknown names', () => {
  const picked = tools.pick(['read_file', 'nonexistent']);
  assert.equal(picked.length, 1);
});

test('ensure ctx validation: missing userId fails loud', async () => {
  await assert.rejects(
    async () => tools.read_file.handler({ source: 'x' }, {}),
    /ctx\.userId/,
  );
});
