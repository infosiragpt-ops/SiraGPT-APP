'use strict';

/**
 * Chat-path document retrieval: what it searches with and what it pays for.
 *
 *  - Graph expansion opens with an LLM call and only helps when a stored
 *    triple carries an embedding (linkTriple needs one). The chat backfill
 *    never embeds triples, so expansion used to pay that call on every
 *    follow-up and return nothing.
 *  - The long-document triple backfill re-extracted every chunk with an LLM
 *    on every follow-up; it now runs when the turn ingested new text.
 *  - A follow-up such as «¿y el tercero?» has no searchable content. When the
 *    coreference resolver pinned the referent to concrete text, retrieval
 *    searches with it too, while the evidence block still shows the user's
 *    own words.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const runtime = require('../src/services/rag/operational-runtime');
const tripleGraph = require('../src/services/triple-graph');

function fakeRag({ hitText = 'El presupuesto asignado fue de 120 000 soles.' } = {}) {
  const existing = [];
  const calls = { ingest: [], ingestTriples: [], retrieve: [] };
  return {
    calls,
    async listSources() { return existing.map((source) => ({ source, title: source, chunks: 1 })); },
    async ingest(userId, collection, docs) {
      calls.ingest.push(docs.map((doc) => doc.source));
      existing.push(...docs.map((doc) => doc.source));
      return { chunksAdded: docs.length, totalChunks: existing.length };
    },
    async retrieve(userId, collection, query, k, opts) {
      calls.retrieve.push({ collection, query, opts });
      return [{ source: 'file:doc', title: 'Informe.pdf', text: hitText, score: 0.9 }];
    },
    async stats() { return { chunks: existing.length, sources: existing.length, dim: 1536 }; },
    async ingestTriples(userId, collection, opts = {}) {
      calls.ingestTriples.push(opts.sources);
      return { chunksScanned: 0, triplesAdded: 0, totalTriples: 0 };
    },
    getOpenAI() { return null; },
  };
}

const SHORT_FILE = { id: 'doc', originalName: 'Informe.pdf', mimeType: 'application/pdf', extractedText: 'Presupuesto y plazos del proyecto. '.repeat(20) };
const LONG_FILE = { id: 'doc', originalName: 'Informe.pdf', mimeType: 'application/pdf', extractedText: 'Presupuesto y plazos del proyecto. '.repeat(400) };
const tick = () => new Promise((resolve) => setImmediate(resolve));
const embedAll = async (sentences) => sentences.map(() => [0.2, 0.8]);

test('triple-graph stats count the triples that graph expansion can link to', async () => {
  const uid = `gate-stats-${Math.random()}`;
  assert.deepEqual(tripleGraph.stats(uid, 'c'), { triples: 0, entities: 0, sources: 0, embedded: 0 });
  await tripleGraph.addTriples(uid, 'c', [{ subject: 'plan', predicate: 'reduce', object: 'costos', source: 's1' }], { embedder: null });
  assert.equal(tripleGraph.stats(uid, 'c').triples, 1);
  assert.equal(tripleGraph.stats(uid, 'c').embedded, 0);
  await tripleGraph.addTriples(uid, 'c', [{ subject: 'plan', predicate: 'mejora', object: 'calidad', source: 's1' }], { embedder: embedAll });
  assert.equal(tripleGraph.stats(uid, 'c').triples, 2);
  assert.equal(tripleGraph.stats(uid, 'c').embedded, 1);
});

test('chat retrieval expands the graph only when a stored triple can be linked', async () => {
  const uid = `gate-graph-${Math.random()}`;
  const rag = fakeRag();
  const ask = () => runtime.buildRuntimeContext({
    rag, userId: uid, chatId: 'g', prompt: '¿Qué dice sobre el presupuesto?', processedFiles: [SHORT_FILE],
  });

  await ask();
  assert.equal(rag.calls.retrieve.at(-1).opts.useGraph, false, 'empty graph');

  await tripleGraph.addTriples(uid, 'chat:g', [{ subject: 'proyecto', predicate: 'tiene', object: 'presupuesto', source: 'file:doc' }], { embedder: null });
  await ask();
  assert.equal(rag.calls.retrieve.at(-1).opts.useGraph, false, 'triples without embeddings cannot be linked');

  await tripleGraph.addTriples(uid, 'chat:g', [{ subject: 'presupuesto', predicate: 'cubre', object: 'plazos', source: 'file:doc' }], { embedder: embedAll });
  await ask();
  assert.equal(rag.calls.retrieve.at(-1).opts.useGraph, true);
});

test('long-document triple backfill runs once at ingestion, not on every follow-up', async () => {
  const uid = `gate-backfill-${Math.random()}`;
  const rag = fakeRag();
  const ask = (prompt) => runtime.buildRuntimeContext({ rag, userId: uid, chatId: 'b', prompt, processedFiles: [LONG_FILE] });

  await ask('¿Qué dice sobre el presupuesto?');
  await tick();
  assert.deepEqual(rag.calls.ingestTriples, [['file:doc']]);

  await ask('¿Y sobre los plazos?');
  await ask('Explícame la sección de riesgos del informe.');
  await tick();
  assert.equal(rag.calls.ingest.length, 1, 'the document was indexed once');
  assert.equal(rag.calls.ingestTriples.length, 1, 'follow-ups must not re-extract triples for an indexed document');
  assert.equal(rag.calls.retrieve.length, 3, 'every turn still retrieves');
});

test('retrievalQueryFor adds only confident, content-bearing referents', () => {
  const prompt = '¿y el tercero?';
  const ref = (source, resolvesTo, confidence = 0.75) => ({ span: 'el tercero', anaphor: 'el tercero', source, resolvesTo, confidence });

  assert.equal(runtime.retrievalQueryFor(prompt, null), prompt);
  assert.equal(runtime.retrievalQueryFor(prompt, { references: [] }), prompt);
  assert.equal(
    runtime.retrievalQueryFor(prompt, { references: [ref('ordinal_list', 'Deserción   escolar\nrural')] }),
    `${prompt}\nDeserción escolar rural`,
  );
  assert.equal(
    runtime.retrievalQueryFor(prompt, { references: [ref('judge', 'la metodología del estudio', 0.8)] }),
    `${prompt}\nla metodología del estudio`,
  );

  // File names, code snippets, low-confidence guesses and unresolved
  // secondary anaphors are not what the passages talk about.
  for (const weak of [
    ref('single_attachment', 'el adjunto informe.pdf', 0.7),
    ref('attachment_ext_match', 'el adjunto datos.xlsx', 0.65),
    ref('code_block', 'el bloque de código: const x = 1', 0.75),
    ref('cosine_fallback', 'texto de la respuesta anterior', 0.4),
    ref('judge', 'una suposición', 0.5),
    ref('secondary', null, 0),
  ]) {
    assert.equal(runtime.retrievalQueryFor(prompt, { references: [weak] }), prompt, weak.source);
  }

  // Already present in the prompt, repeated, or very long.
  assert.equal(
    runtime.retrievalQueryFor('el tercero: Deserción escolar', { references: [ref('ordinal_list', 'Deserción escolar')] }),
    'el tercero: Deserción escolar',
  );
  assert.equal(
    runtime.retrievalQueryFor(prompt, { references: [ref('ordinal_list', 'Plazos'), ref('judge', 'Plazos', 0.9)] }),
    `${prompt}\nPlazos`,
  );
  assert.equal(
    runtime.retrievalQueryFor(prompt, { references: [ref('ordinal_list', 'x'.repeat(500))] }).length,
    prompt.length + 1 + 200,
  );
});

test('a resolved follow-up searches and focuses excerpts with the referent, but the block shows the user prompt', async () => {
  const uid = `gate-coref-${Math.random()}`;
  const filler = 'Marco general del informe sin cifras concretas. ';
  const hitText = `${filler.repeat(30)}La deserción escolar rural alcanzó 18 % en 2026 según el padrón.${filler.repeat(10)}`;
  const rag = fakeRag({ hitText });
  const prompt = '¿y el tercero?';
  const coreference = {
    references: [{ span: 'el tercero', source: 'ordinal_list', resolvesTo: 'Deserción escolar rural', confidence: 0.75 }],
  };
  const retrievalQuery = runtime.retrievalQueryFor(prompt, coreference);

  const out = await runtime.buildRuntimeContext({
    rag, userId: uid, chatId: 'c', prompt, retrievalQuery, processedFiles: [SHORT_FILE],
  });

  assert.equal(out.active, true);
  assert.equal(rag.calls.retrieve[0].query, `${prompt}\nDeserción escolar rural`);
  assert.equal(out.retrievalQuery, retrievalQuery);
  assert.match(out.contextBlock, /Query: ¿y el tercero\?\nRetrieval:/);
  assert.match(out.contextBlock, /deserción escolar rural alcanzó 18 %/);

  // Without the referent the same hit is cut from its start: the excerpt
  // never reaches the passage the user asked about.
  const plain = await runtime.buildRuntimeContext({
    rag: fakeRag({ hitText }), userId: `${uid}-plain`, chatId: 'c', prompt, processedFiles: [SHORT_FILE],
  });
  assert.equal(plain.retrievalQuery, prompt);
  assert.doesNotMatch(plain.contextBlock, /deserción escolar rural alcanzó/);
});
