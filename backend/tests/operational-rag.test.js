const { test } = require('node:test');
const assert = require('node:assert/strict');

const runtime = require('../src/services/rag/operational-runtime');
const graphrag = require('../src/services/agents/graphrag');
const tripleGraph = require('../src/services/triple-graph');

function fakeRag({ existingSources = [], triples = [] } = {}) {
  const calls = { ingest: [], ingestTriples: [], retrieve: [], listSources: 0 };
  return {
    calls,
    async listSources() {
      calls.listSources += 1;
      return existingSources.map(source => ({ source, title: source, chunks: 1 }));
    },
    async ingest(userId, collection, docs, opts) {
      calls.ingest.push({ userId, collection, docs, opts });
      existingSources.push(...docs.map(d => d.source));
      return { chunksAdded: docs.length, totalChunks: existingSources.length };
    },
    async retrieve(userId, collection, query, k, opts) {
      calls.retrieve.push({ userId, collection, query, k, opts });
      return [
        {
          source: 'file:doc1',
          title: 'Doc One',
          text: 'Alpha evidence supports the user question with a grounded fact.',
          score: 0.91,
        },
      ];
    },
    async stats() {
      return { chunks: existingSources.length, sources: existingSources.length, dim: 1536 };
    },
    async ingestTriples(userId, collection, opts = {}) {
      calls.ingestTriples.push({ userId, collection, opts });
      const sourceFilter = Array.isArray(opts.sources) && opts.sources.length > 0
        ? new Set(opts.sources)
        : null;
      const selected = sourceFilter
        ? triples.filter(t => sourceFilter.has(t.source))
        : triples;
      const result = await tripleGraph.addTriples(userId, collection, selected, { embedder: null });
      return {
        chunksScanned: selected.length,
        triplesAdded: result.added,
        totalTriples: tripleGraph.stats(userId, collection).triples,
      };
    },
    getOpenAI() {
      return null;
    },
  };
}

test('normaliseDocs keeps text documents and skips images / tiny text', () => {
  const docs = runtime.normaliseDocs([
    { id: 'a', originalName: 'a.pdf', mimeType: 'application/pdf', extractedText: 'Useful text '.repeat(20) },
    { id: 'b', originalName: 'b.png', mimeType: 'image/png', extractedText: 'OCR text '.repeat(20) },
    { id: 'c', originalName: 'c.txt', mimeType: 'text/plain', extractedText: 'too short' },
  ]);

  assert.equal(docs.length, 1);
  assert.equal(docs[0].source, 'file:a');
  assert.equal(docs[0].title, 'a.pdf');
});

test('ensureIndexed skips sources already present in the collection', async () => {
  const rag = fakeRag({ existingSources: ['file:already'] });
  const out = await runtime.ensureIndexed({
    rag,
    userId: 'u1',
    collection: 'default',
    docs: [
      { source: 'file:already', title: 'Already', text: 'Existing content '.repeat(20) },
      { source: 'file:new', title: 'New', text: 'New content '.repeat(20) },
    ],
  });

  assert.equal(out.indexed, true);
  assert.equal(out.chunksAdded, 1);
  assert.deepEqual(out.skippedSources, ['file:already']);
  assert.equal(rag.calls.ingest.length, 1);
  assert.equal(rag.calls.ingest[0].docs[0].source, 'file:new');
});

test('buildRuntimeContext indexes docs and builds a cited evidence block', async () => {
  const rag = fakeRag();
  const out = await runtime.buildRuntimeContext({
    rag,
    userId: 'u1',
    chatId: 'chat1',
    prompt: 'Resume el documento adjunto con citas.',
    processedFiles: [
      { id: 'doc1', originalName: 'Doc One', mimeType: 'application/pdf', extractedText: 'Alpha evidence '.repeat(80) },
    ],
  });

  assert.equal(out.active, true);
  assert.equal(out.collection, 'chat:chat1');
  assert.match(out.contextBlock, /SIRA EVIDENCE RUNTIME/);
  assert.match(out.contextBlock, /\[S1\] Doc One/);
  assert.equal(rag.calls.ingest.length, 1);
  assert.equal(rag.calls.retrieve.length, 1);
  assert.equal(rag.calls.retrieve[0].opts.useHybrid, true);
  assert.equal(rag.calls.retrieve[0].opts.useExpansion, true);
  assert.equal(rag.calls.retrieve[0].opts.useMMR, true);
  assert.equal(rag.calls.retrieve[0].opts.useGraph, true);
});

test('buildRuntimeContext stays inactive for prompts unrelated to files when docs are small', async () => {
  const rag = fakeRag();
  const out = await runtime.buildRuntimeContext({
    rag,
    userId: 'u1',
    chatId: 'chat1',
    prompt: 'Hola, escribe una frase creativa.',
    processedFiles: [
      { id: 'doc1', originalName: 'Doc One', mimeType: 'application/pdf', extractedText: 'Small but valid text '.repeat(10) },
    ],
  });

  assert.equal(out.active, false);
  assert.equal(rag.calls.ingest.length, 0);
});

test('buildRuntimeContext ignores pure greetings even with a long project document', async () => {
  const rag = fakeRag();
  const out = await runtime.buildRuntimeContext({
    rag,
    userId: 'u1',
    chatId: 'chat1',
    prompt: 'hola',
    processedFiles: [
      { id: 'doc1', originalName: 'Long Doc', mimeType: 'application/pdf', extractedText: 'Long evidence '.repeat(1200) },
    ],
  });

  assert.equal(out.active, false);
  assert.equal(rag.calls.ingest.length, 0);
});

test('shouldCompactFilePrompt only compacts when evidence exists and token budget is high', () => {
  assert.equal(runtime.shouldCompactFilePrompt(20000, true), true);
  assert.equal(runtime.shouldCompactFilePrompt(20000, false), false);
  assert.equal(runtime.shouldCompactFilePrompt(1000, true), false);
});

function scriptedGraphRagOpenAI() {
  return {
    chat: {
      completions: {
        create: async ({ messages }) => {
          const sys = messages.find(m => m.role === 'system')?.content || '';
          if (sys.startsWith('Summarise a COMMUNITY')) {
            return { choices: [{ message: { content: JSON.stringify({
              topic: 'Long-document themes',
              summary: 'The community links policy, retrieval, and evaluation signals across the long corpus.',
              key_entities: ['policy', 'retrieval', 'evaluation'],
              themes: ['retrieval quality', 'grounded synthesis'],
            }) } }] };
          }
          if (sys.startsWith('Summarise a SUPER-COMMUNITY')) {
            return { choices: [{ message: { content: JSON.stringify({
              topic: 'Corpus-level synthesis',
              summary: 'The corpus combines retrieval quality with grounded evaluation.',
              cross_cutting_themes: ['long-context grounding'],
            }) } }] };
          }
          if (sys.startsWith('You are helping answer a GLOBAL')) {
            return { choices: [{ message: { content: JSON.stringify({
              partial_answer: 'The long documents emphasize retrieval quality, grounded synthesis, and evaluation feedback.',
              helpfulness: 88,
              reasoning: 'directly answers themes',
            }) } }] };
          }
          if (sys.startsWith('Synthesise a single GLOBAL')) {
            return { choices: [{ message: { content: JSON.stringify({
              answer: 'Sintesis global: los documentos largos giran alrededor de recuperacion selectiva, sintesis fundamentada y evaluacion continua.',
              themes: ['recuperacion selectiva', 'sintesis fundamentada', 'evaluacion continua'],
              contributing_communities: ['c0'],
            }) } }] };
          }
          return { choices: [{ message: { content: '{}' } }] };
        },
      },
    },
  };
}

test('buildRuntimeContext builds GraphRAG on demand for first global long-document query', async () => {
  const uid = `og-${Math.random()}`;
  const chatId = 'graph-chat';
  const collection = `chat:${chatId}`;
  tripleGraph.clear(uid, collection);
  graphrag.clearIndex(uid, collection);

  const rag = fakeRag({
    triples: [
      { subject: 'policy', predicate: 'uses', object: 'retrieval', source: 'file:long1' },
      { subject: 'retrieval', predicate: 'supports', object: 'evaluation', source: 'file:long1' },
      { subject: 'evaluation', predicate: 'improves', object: 'grounding', source: 'file:long1' },
    ],
  });

  const out = await runtime.buildRuntimeContext({
    rag,
    userId: uid,
    chatId,
    prompt: 'Dame los temas principales de todos los documentos largos.',
    processedFiles: [
      { id: 'long1', originalName: 'Long Corpus.pdf', mimeType: 'application/pdf', extractedText: 'GraphRAG evidence '.repeat(900) },
    ],
    openai: scriptedGraphRagOpenAI(),
  });

  assert.equal(out.active, true);
  assert.equal(out.graphIndexResult.ready, true);
  assert.equal(out.graphIndexResult.built, true);
  assert.equal(rag.calls.ingestTriples.length, 1);
  assert.equal(out.graphAnswer.themes.length, 3);
  assert.match(out.contextBlock, /GraphRAG global synthesis/);
  assert.match(out.contextBlock, /graphrag=true/);
  assert.match(out.contextBlock, /Sintesis global/);
});

test('buildEvidenceBlock can carry a GraphRAG synthesis even when vector hits are empty', () => {
  const block = runtime.buildEvidenceBlock({
    query: 'What themes appear across all documents?',
    collection: 'default',
    docs: [{ title: 'Corpus', source: 'file:x' }],
    hits: [],
    graphAnswer: {
      answer: 'The corpus has three major themes.',
      themes: ['a', 'b', 'c'],
      contributing_communities: ['c0'],
      stats: { n_communities: 1 },
    },
    retrievalMeta: { graphRag: true },
  });

  assert.match(block, /SIRA EVIDENCE RUNTIME/);
  assert.match(block, /no local vector snippets retrieved/);
  assert.match(block, /GraphRAG global synthesis/);
});

test('runQualityAudit stores compact Self-RAG metadata on the assistant message', async () => {
  const oldRagas = process.env.SIRAGPT_RAGAS_AUTO_EVAL;
  process.env.SIRAGPT_RAGAS_AUTO_EVAL = '0';

  const scripted = [
    { isSup: 'fully_supported', cited: 1, reason: 'The passage directly supports it.' },
    { isUse: 5, reason: 'It answers the question.' },
  ];
  const openai = {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: JSON.stringify(scripted.shift() || {}) } }],
        }),
      },
    },
  };
  const updates = [];
  const prisma = {
    message: {
      findUnique: async () => ({ metadata: { existing: true } }),
      update: async (args) => {
        updates.push(args);
        return { id: args.where.id, ...args.data };
      },
    },
  };

  try {
    const out = await runtime.runQualityAudit({
      prisma,
      rag: fakeRag(),
      userId: 'u1',
      messageId: 'm1',
      question: 'What does the document say?',
      answer: 'Alpha evidence supports the answer.',
      hits: [{ source: 'file:doc1', title: 'Doc One', text: 'Alpha evidence supports the answer.' }],
      openai,
    });

    assert.equal(out.audited, true);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].where.id, 'm1');
    assert.equal(updates[0].data.metadata.existing, true);
    assert.equal(updates[0].data.metadata.ragAudit.critic.overall.isUse, 5);
    assert.equal(updates[0].data.metadata.ragAudit.critic.overall.fullySupported, 1);
  } finally {
    if (oldRagas === undefined) delete process.env.SIRAGPT_RAGAS_AUTO_EVAL;
    else process.env.SIRAGPT_RAGAS_AUTO_EVAL = oldRagas;
  }
});
