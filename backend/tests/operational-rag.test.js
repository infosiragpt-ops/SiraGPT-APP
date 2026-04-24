const { test } = require('node:test');
const assert = require('node:assert/strict');

const runtime = require('../src/services/rag/operational-runtime');

function fakeRag({ existingSources = [] } = {}) {
  const calls = { ingest: [], retrieve: [], listSources: 0 };
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
