/**
 * Third audit round: regression tests for bugs fixed and new features.
 *
 * Bugs:
 *   - Python decorator capture in chunks
 *   - JSDoc capture in TS/JS chunks
 *   - onStep receives a clone, not a reference
 *   - {"final": null} no longer terminates
 *   - linkTriple rejects empty/whitespace triples
 *   - passageLink uses cosine-only (not hybrid)
 *
 * New:
 *   - maintenance-agent (ticket hint extraction + normalisation)
 *   - orchestrator.consensus (scoring + winner selection)
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

const codeChunker = require('../src/services/code-chunker');
const core = require('../src/services/agents/agent-core');
const tripleGraph = require('../src/services/triple-graph');
const rag = require('../src/services/rag-service');
const maintenance = require('../src/services/agents/maintenance-agent');
const orchestrator = require('../src/services/agents/se-orchestrator');

// ─── BUG: Python decorator capture ────────────────────────────────────────

test('code-chunker Python: @decorator lines above def get included in the chunk', () => {
  const src = [
    'import os',
    '',
    '@app.route("/users")',
    '@require_auth',
    'def list_users():',
    '    return {}',
    '',
    'def noop():',
    '    pass',
  ].join('\n');
  const chunks = codeChunker.chunkCode('api.py', src);
  const listUsers = chunks.find(c => c.name === 'list_users');
  assert.ok(listUsers, 'list_users extracted');
  assert.ok(listUsers.text.includes('@app.route'), 'decorator included');
  assert.ok(listUsers.text.includes('@require_auth'), 'stacked decorators included');
  assert.equal(listUsers.startLine, 3, 'startLine points at the top decorator');
});

test('code-chunker Python: decorator with args and newline between also included', () => {
  const src = [
    '@pytest.fixture(',
    '    scope="session",',
    ')',
    'def db():',
    '    yield _conn()',
  ].join('\n');
  const chunks = codeChunker.chunkCode('t.py', src, { includeImports: false });
  const db = chunks.find(c => c.name === 'db');
  assert.ok(db);
  assert.ok(db.text.startsWith('@pytest.fixture'));
  assert.equal(db.startLine, 1, 'startLine covers the multi-line decorator');
});

// ─── BUG: JSDoc capture for TS/JS ─────────────────────────────────────────

test('code-chunker TS/JS: JSDoc /** … */ above declaration is included', () => {
  const src = [
    'import x from "y";',
    '',
    '/**',
    ' * Computes the thing.',
    ' * @param n {number}',
    ' */',
    'export function computeThing(n) {',
    '  return n * 2;',
    '}',
  ].join('\n');
  // includeImports default prepends the import block to the chunk text,
  // so we disable it here to cleanly test "JSDoc is at the start".
  const chunks = codeChunker.chunkCode('c.ts', src, { includeImports: false });
  const fn = chunks.find(c => c.name === 'computeThing');
  assert.ok(fn);
  assert.ok(fn.text.includes('Computes the thing'), 'JSDoc body included');
  assert.ok(fn.text.startsWith('/**'), 'chunk starts at the JSDoc opener');
  assert.equal(fn.startLine, 3, 'startLine points at the JSDoc opener');
});

test('code-chunker TS/JS: decorator line above class is included (TS experimental)', () => {
  const src = [
    '@Injectable()',
    'export class UserService {',
    '  constructor() {}',
    '}',
  ].join('\n');
  // No imports in source → disabling includeImports is a no-op. We check
  // the chunk startLine metadata + inclusion.
  const chunks = codeChunker.chunkCode('s.ts', src, { includeImports: false });
  const cls = chunks.find(c => c.name === 'UserService');
  assert.ok(cls);
  assert.ok(cls.text.startsWith('@Injectable()'));
  assert.equal(cls.startLine, 1);
});

test('code-chunker TS/JS: declaration without preceding comment is unchanged', () => {
  const src = `export function plain() { return 1; }`;
  const chunks = codeChunker.chunkCode('p.ts', src);
  assert.equal(chunks[0].startLine, 1);
});

// ─── BUG: onStep clone ────────────────────────────────────────────────────

test('agent-core.run: onStep receives a clone — mutation does not pollute trace', async () => {
  const scripted = [
    JSON.stringify({ tool: 'noop', args: { x: 1 } }),
    JSON.stringify({ final: 'done' }),
  ];
  let i = 0;
  const openai = { chat: { completions: { create: async () => ({
    choices: [{ message: { content: scripted[Math.min(i++, scripted.length - 1)] } }],
  })}}};
  const noop = { name: 'noop', description: '', schema: {}, handler: async () => ({ data: 'x' }) };

  const r = await core.run({
    openai, goal: 'g', tools: [noop],
    onStep: (s) => {
      s.think = '<POLLUTED>';
      if (s.observation) s.observation = '<POLLUTED>';
    },
  });
  // None of the mutations should have leaked into the returned trace.
  for (const step of r.trace) {
    assert.notEqual(step.think, '<POLLUTED>');
    assert.notEqual(step.observation, '<POLLUTED>');
  }
});

// ─── BUG: final null rejection ────────────────────────────────────────────

test('agent-core.run: {"final": null} does NOT terminate the loop', async () => {
  const scripted = [
    JSON.stringify({ final: null }),                   // rejected
    JSON.stringify({ final: 'real answer' }),          // accepted
  ];
  let i = 0;
  const openai = { chat: { completions: { create: async () => ({
    choices: [{ message: { content: scripted[Math.min(i++, scripted.length - 1)] } }],
  })}}};
  const r = await core.run({ openai, goal: 'g', tools: [] });
  assert.equal(r.final, 'real answer');
  assert.equal(r.terminatedBy, 'final');
  assert.equal(r.iterations, 2);
  // The rejected step should have a "null final rejected" observation.
  const rejected = r.trace.find(s => s.think && s.think.includes('null final rejected'));
  assert.ok(rejected);
});

// ─── BUG: linkTriple empty-triple guard ──────────────────────────────────

test('tripleGraph.linkTriple: empty/whitespace triple returns null without embedding', async () => {
  const uid = `et-${Math.random()}`;
  const col = 'et';
  tripleGraph.clear(uid, col);
  // Seed one triple so the graph isn't empty.
  await tripleGraph.addTriples(uid, col, [
    { subject: 'X', predicate: 'is', object: 'Y' },
  ], { embedder: (t) => Promise.resolve(t.map(fakeVectorFor)) });

  let embedderCalls = 0;
  const embedder = (texts) => { embedderCalls++; return Promise.resolve(texts.map(fakeVectorFor)); };

  // Empty subject.
  const a = await tripleGraph.linkTriple(uid, col,
    { subject: '', predicate: 'is', object: 'Y' }, { embedder });
  assert.equal(a, null);

  // Whitespace predicate.
  const b = await tripleGraph.linkTriple(uid, col,
    { subject: 'X', predicate: '   ', object: 'Y' }, { embedder });
  assert.equal(b, null);

  // All whitespace.
  const c = await tripleGraph.linkTriple(uid, col,
    { subject: ' ', predicate: '\t', object: '\n' }, { embedder });
  assert.equal(c, null);

  assert.equal(embedderCalls, 0, 'embedder must not be invoked for invalid triples');
});

test('tripleGraph.linkTriple: valid triple still works', async () => {
  const uid = `et-${Math.random()}`;
  const col = 'et2';
  tripleGraph.clear(uid, col);
  const embedder = (t) => Promise.resolve(t.map(fakeVectorFor));
  await tripleGraph.addTriples(uid, col, [
    { subject: 'Curry', predicate: 'plays for', object: 'Warriors' },
  ], { embedder });
  const out = await tripleGraph.linkTriple(uid, col,
    { subject: 'Curry', predicate: 'plays for', object: 'Warriors' },
    { embedder },
  );
  assert.ok(out);
  assert.ok(out.score > 0.9);
});

// ─── BUG: passageLink cosine-only ─────────────────────────────────────────

test('rag.passageLink: retrieves without BM25 for short triple sentence', async () => {
  const uid = `pl-${Math.random()}`;
  const col = 'pl';
  await rag.clear(uid, col);
  await rag.ingest(uid, col, [
    { text: 'Stephen Curry is a point guard for the Golden State Warriors.', source: 'curry.md' },
    { text: 'The Warriors won the NBA championship in 2022.', source: 'title.md' },
    { text: 'Python is a programming language.', source: 'py.md' },
  ]);
  // Triple sentence is short ("Curry plays Warriors"). Hybrid would
  // penalise it via IDF for short query. Cosine-only finds the
  // semantically-closest chunk.
  const hits = await rag.passageLink(uid, col,
    { subject: 'Stephen Curry', predicate: 'plays for', object: 'Warriors' },
    { k: 2 },
  );
  assert.ok(hits.length > 0);
  // The top hit should be about Curry + Warriors, not about Python.
  assert.ok(/Curry|Warriors/.test(hits[0].text));
});

// ─── NEW: maintenance-agent tests ─────────────────────────────────────────

test('maintenance.extractTicketHints: pulls filenames, symbols, URLs, quoted strings', () => {
  const ticket = `When I call getUser() in src/api/users.ts the response is "undefined user" and the endpoint at https://api.example.com/v1/user returns 500.`;
  const h = maintenance.extractTicketHints(ticket);
  assert.ok(h.filePaths.includes('src/api/users.ts'));
  assert.ok(h.symbols.includes('getUser'));
  assert.ok(h.urls.some(u => u.includes('example.com')));
  assert.ok(h.quotedStrings.some(q => q.includes('undefined user')));
});

test('maintenance.extractTicketHints: empty / non-string input returns empty hints', () => {
  assert.deepEqual(maintenance.extractTicketHints(''), {});
  assert.deepEqual(maintenance.extractTicketHints(null), {});
});

test('maintenance.normalizeMaintenance: clamps invalid status to not_localised', () => {
  const r = maintenance.normalizeMaintenance(
    { final: { status: 'quantum_entangled', hypothesis: 'x' }, iterations: 2, terminatedBy: 'final' },
    { ticket: 't', hints: {} },
  );
  assert.equal(r.status, 'not_localised');
});

test('maintenance.normalizeMaintenance: patches missing source/replacement are dropped', () => {
  const r = maintenance.normalizeMaintenance(
    { final: { status: 'likely_fix', patches: [
      { source: 'a.ts', replacement: 'good' },
      { source: 'b.ts' }, // missing replacement
      { replacement: 'orphan' }, // missing source
    ] }, iterations: 3, terminatedBy: 'final' },
    { ticket: 't', hints: {} },
  );
  assert.equal(r.patches.length, 1);
});

test('maintenance.normalizeMaintenance: confidence clamped to [0,1]', () => {
  const r = maintenance.normalizeMaintenance(
    { final: { localisation: { confidence: 5 } }, iterations: 1, terminatedBy: 'final' },
    { ticket: 't', hints: {} },
  );
  assert.equal(r.localisation.confidence, 1);
});

// ─── NEW: orchestrator.consensus tests ────────────────────────────────────

test('orchestrator.scoreCandidate: 0 findings → score 0 (best)', () => {
  const s = orchestrator.scoreCandidate({ counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 } });
  assert.equal(s, 0);
});

test('orchestrator.scoreCandidate: critical penalty dominates info', () => {
  const withCritical = orchestrator.scoreCandidate({ counts: { critical: 1, high: 0, medium: 0, low: 0, info: 100 } });
  const onlyInfo = orchestrator.scoreCandidate({ counts: { critical: 0, high: 0, medium: 0, low: 0, info: 100 } });
  // A single critical bug should score worse than 100 info nits.
  assert.ok(withCritical < onlyInfo,
    `critical=${withCritical} must be worse than info=${onlyInfo}`);
});

test('orchestrator.scoreCandidate: missing review returns -Infinity', () => {
  assert.equal(orchestrator.scoreCandidate({}), -Infinity);
  assert.equal(orchestrator.scoreCandidate(null), -Infinity);
});

test('orchestrator.consensus: requires numAgents >= 2', async () => {
  await assert.rejects(
    orchestrator.consensus({
      openai: {}, userId: 'u', collection: 'c', spec: 's', numAgents: 1,
    }),
    /numAgents must be >= 2/,
  );
});

test('orchestrator.consensus: picks the candidate with fewest severe findings', async () => {
  const uid = `cons-${Math.random()}`;
  const col = 'cons';
  await rag.clear(uid, col);

  // Script each tool call path. We need code-gen to return 3 different
  // code drafts, then code-review to return different finding sets.
  // Route by prompt content: code-gen's role starts with "senior software",
  // review's role starts with "senior software engineer performing a thorough code review".
  let genCount = 0;
  const drafts = [
    { code: 'export function v1() { return 1; }', file_path: 'v1.ts', language: 'typescript' },
    { code: 'export function v2() { return 2; }', file_path: 'v2.ts', language: 'typescript' },
    { code: 'export function v3() { return 3; }', file_path: 'v3.ts', language: 'typescript' },
  ];
  // Reviews: v2 is the cleanest; v1 has a high; v3 has a critical.
  const reviews = {
    'v1.ts': { summary: 's', findings: [{ file: 'v1.ts', severity: 'high', category: 'correctness', issue: 'x', suggestion: 'y' }] },
    'v2.ts': { summary: 's', findings: [] },
    'v3.ts': { summary: 's', findings: [{ file: 'v3.ts', severity: 'critical', category: 'security', issue: 'x', suggestion: 'y' }] },
  };

  const openai = {
    embeddings: {
      create: async ({ input }) => ({
        data: input.map(text => ({ embedding: Array.from(fakeVectorFor(text)) })),
      }),
    },
    chat: {
      completions: {
        create: async ({ messages }) => {
          const sys = messages.find(m => m.role === 'system')?.content || '';
          const usr = messages.find(m => m.role === 'user')?.content || '';

          // Code-gen: role contains "senior software engineer generating production-quality code"
          if (sys.includes('generating production-quality code')) {
            const d = drafts[genCount++ % drafts.length];
            return { choices: [{ message: { content: JSON.stringify({ final: d }) } }] };
          }
          // Code-review: determine which file by looking at the goal/tool calls.
          if (sys.includes('thorough code review')) {
            // Look for the filename mentioned in the goal.
            for (const key of Object.keys(reviews)) {
              if (usr.includes(key)) {
                return { choices: [{ message: { content: JSON.stringify({ final: reviews[key] }) } }] };
              }
            }
            // Default empty review
            return { choices: [{ message: { content: JSON.stringify({ final: { summary: 's', findings: [] } }) } }] };
          }
          // Fallback
          return { choices: [{ message: { content: JSON.stringify({ final: 'ok' }) } }] };
        },
      },
    },
  };

  const result = await orchestrator.consensus({
    openai, userId: uid, collection: col,
    spec: 'Write a trivial function.', numAgents: 3, language: 'typescript',
  });

  assert.equal(result.num_agents, 3);
  assert.equal(result.candidates.length, 3);
  // v2 should win — it has 0 findings → score 0, while v1 has -15 and v3 has -50.
  assert.equal(result.winner.file_path, 'v2.ts');
});

// ─── Orchestrator intent covers maintenance ──────────────────────────────

test('orchestrator intents include maintenance', () => {
  assert.ok(orchestrator.VALID_INTENTS.has('maintenance'));
});
