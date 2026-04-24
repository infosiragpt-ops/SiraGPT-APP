/**
 * operational-runtime — product wiring for the research RAG stack.
 *
 * The repo already exposes advanced RAG, GEAR/GraphRAG, Self-RAG and
 * RAGAS as individual modules/routes. This file makes those ideas part
 * of the normal product flow:
 *   - uploaded/project files are indexed into private RAG namespaces;
 *   - chat turns retrieve a compact evidence pack instead of dumping
 *     whole long PDFs into the model context;
 *   - generated answers are steered by a Self-RAG-style grounding
 *     contract: cite retrieved evidence, ignore irrelevant snippets,
 *     and admit insufficient support.
 */

const crypto = require('crypto');

const DEFAULT_COLLECTION = 'default';
const MAX_DOC_CHARS = Number.parseInt(process.env.SIRAGPT_RAG_MAX_DOC_CHARS || '300000', 10);
const MIN_DOC_CHARS = 80;
const DEFAULT_RETRIEVAL_K = 8;
const EVIDENCE_SNIPPET_CHARS = 1200;
const AUDIT_PASSAGE_LIMIT = Number.parseInt(process.env.SIRAGPT_RAG_AUDIT_PASSAGES || '6', 10);
const AUDIT_ANSWER_CHARS = Number.parseInt(process.env.SIRAGPT_RAG_AUDIT_ANSWER_CHARS || '6000', 10);
const GRAPHRAG_MAX_ENTITIES = Number.parseInt(process.env.SIRAGPT_GRAPHRAG_MAX_ENTITIES || '500', 10);
const LONG_DOC_CHAR_THRESHOLD = Number.parseInt(process.env.SIRAGPT_RAG_LONG_DOC_CHARS || '10000', 10);
const GRAPHRAG_ON_DEMAND_MAX_SOURCES = Number.parseInt(process.env.SIRAGPT_GRAPHRAG_ON_DEMAND_MAX_SOURCES || '8', 10);
const COMPACT_FILE_CONTEXT_TOKEN_THRESHOLD = Number.parseInt(
  process.env.SIRAGPT_RAG_COMPACT_FILE_TOKENS || '16000',
  10,
);

const GLOBAL_QUERY_RE = /\b(theme|themes|trend|trends|pattern|patterns|global|overview|sensemaking|main ideas|key ideas|across (the|all)|entire corpus|whole corpus|corpus-wide|summary of all|summari[sz]e all|mapa conceptual|resumen general|visión general|vision general|temas principales|ideas principales|hallazgos principales|patrones|tendencias|todo el corpus|todos los documentos|documentos largos|compar(a|ar) todos)\b/i;

function hashShort(value) {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex').slice(0, 12);
}

function isImageFile(file) {
  const mime = String(file?.mimeType || file?.type || '').toLowerCase();
  return mime.startsWith('image/');
}

function sourceIdForFile(file) {
  if (file?.id) return `file:${file.id}`;
  const name = file?.originalName || file?.name || file?.filename || 'file';
  const text = file?.extractedText || '';
  return `file:${hashShort(`${name}:${text.slice(0, 2000)}`)}`;
}

function titleForFile(file) {
  return file?.originalName || file?.name || file?.filename || 'Untitled file';
}

function collectionFor({ project, customGpt, chatId, fallbackSeed }) {
  if (project?.id) return `project:${project.id}`;
  if (customGpt?.id) return `gpt:${customGpt.id}`;
  if (chatId) return `chat:${chatId}`;
  if (fallbackSeed) return `turn:${hashShort(fallbackSeed)}`;
  return DEFAULT_COLLECTION;
}

function normaliseDocs(files = []) {
  return files
    .filter(file => file && !isImageFile(file))
    .map(file => {
      const raw = typeof file.extractedText === 'string' ? file.extractedText.trim() : '';
      if (raw.length < MIN_DOC_CHARS) return null;
      const truncated = raw.length > MAX_DOC_CHARS;
      return {
        text: truncated ? raw.slice(0, MAX_DOC_CHARS) : raw,
        source: sourceIdForFile(file),
        title: titleForFile(file),
        originalName: titleForFile(file),
        chars: raw.length,
        truncated,
      };
    })
    .filter(Boolean);
}

function dedupeDocs(docs) {
  const seen = new Set();
  const out = [];
  for (const doc of docs || []) {
    const key = doc.source || `${doc.title}:${doc.text.slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(doc);
  }
  return out;
}

async function ensureIndexed({ rag, userId, collection = DEFAULT_COLLECTION, docs = [], chunkOptions } = {}) {
  if (!rag || !userId) return { indexed: false, reason: 'missing rag/user', chunksAdded: 0, totalChunks: 0, skippedSources: [] };
  const cleanDocs = dedupeDocs(docs).filter(d => d && typeof d.text === 'string' && d.text.trim().length >= MIN_DOC_CHARS);
  if (cleanDocs.length === 0) return { indexed: false, reason: 'no text docs', chunksAdded: 0, totalChunks: 0, skippedSources: [] };

  let existingSources = new Set();
  try {
    const sources = await rag.listSources(userId, collection);
    existingSources = new Set((sources || []).map(s => s.source));
  } catch {
    existingSources = new Set();
  }

  const toIngest = cleanDocs.filter(doc => !existingSources.has(doc.source));
  const skippedSources = cleanDocs.filter(doc => existingSources.has(doc.source)).map(doc => doc.source);
  if (toIngest.length === 0) {
    const stats = await safeStats(rag, userId, collection);
    return { indexed: true, chunksAdded: 0, totalChunks: stats.chunks, skippedSources };
  }

  try {
    const result = await rag.ingest(userId, collection, toIngest.map(doc => ({
      text: doc.text,
      source: doc.source,
      title: doc.title,
    })), chunkOptions);
    return {
      indexed: true,
      chunksAdded: result.chunksAdded || 0,
      totalChunks: result.totalChunks || 0,
      ingestedSources: toIngest.map(doc => doc.source),
      skippedSources,
    };
  } catch (err) {
    return {
      indexed: false,
      reason: err.message || 'ingest failed',
      chunksAdded: 0,
      totalChunks: 0,
      ingestedSources: [],
      skippedSources,
    };
  }
}

async function safeStats(rag, userId, collection) {
  try {
    return await rag.stats(userId, collection);
  } catch {
    return { chunks: 0, sources: 0, dim: 0 };
  }
}

function shouldUseGraphBackfill(docs) {
  if (process.env.SIRAGPT_RAG_GRAPH_BACKFILL === '0') return false;
  return (docs || []).some(doc => (doc?.chars || doc?.text?.length || 0) >= LONG_DOC_CHAR_THRESHOLD);
}

async function maybeBuildGraphRagIndex({ openai, userId, collection, logger = console } = {}) {
  if (process.env.SIRAGPT_GRAPHRAG_AUTO_BUILD === '0') return { built: false, reason: 'disabled' };
  if (!openai || !userId || !collection) return { built: false, reason: 'missing openai/user/collection' };

  try {
    const graphrag = require('../agents/graphrag');
    const tripleGraph = require('../triple-graph');
    const existing = graphrag.getIndex(userId, collection);
    if (existing && process.env.SIRAGPT_GRAPHRAG_REBUILD !== '1') {
      return { built: false, reason: 'already built', stats: existing.stats || null };
    }

    const dump = graphrag.buildGraphFromTripleStore(tripleGraph, userId, collection);
    if (!Array.isArray(dump.entities) || dump.entities.length === 0) {
      return { built: false, reason: 'empty graph' };
    }

    const entities = dump.entities.slice(0, Math.max(1, GRAPHRAG_MAX_ENTITIES));
    const entitySet = new Set(entities);
    const edges = (dump.edges || []).filter(e => entitySet.has(e.a) && entitySet.has(e.b));
    const index = await graphrag.buildIndex({
      openai,
      userId,
      collection,
      entities,
      edges,
      getRelations: dump.getRelations,
    });
    return { built: true, stats: index.stats || null };
  } catch (err) {
    logger.warn?.('[operational-rag] GraphRAG index build failed:', err.message || err);
    return { built: false, reason: err.message || 'build failed' };
  }
}

function scheduleGraphBackfill({ rag, userId, collection, sources, openai, logger = console } = {}) {
  if (!rag || !userId || !collection || !Array.isArray(sources) || sources.length === 0) return false;
  if (process.env.SIRAGPT_RAG_GRAPH_BACKFILL === '0') return false;

  setImmediate(async () => {
    try {
      const openaiClient = openai || (typeof rag.getOpenAI === 'function' ? rag.getOpenAI() : null);
      const uniqueSources = [...new Set(sources.filter(Boolean))];
      const backfill = await rag.ingestTriples(userId, collection, {
        openai: openaiClient,
        sources: uniqueSources,
      });
      if ((backfill?.totalTriples || 0) > 0) {
        await maybeBuildGraphRagIndex({ openai: openaiClient, userId, collection, logger });
      }
    } catch (err) {
      logger.warn?.('[operational-rag] graph backfill failed:', err.message || err);
    }
  });
  return true;
}

function shouldUseGraphRagForPrompt(prompt, docs) {
  if (!isGlobalSensemakingQuery(prompt)) return false;
  const cleanDocs = Array.isArray(docs) ? docs : [];
  return cleanDocs.length > 1
    || cleanDocs.some(doc => (doc?.chars || doc?.text?.length || 0) >= LONG_DOC_CHAR_THRESHOLD);
}

function graphRagSourcesForDocs(docs, indexResult = {}) {
  const preferred = Array.isArray(indexResult.ingestedSources) && indexResult.ingestedSources.length > 0
    ? indexResult.ingestedSources
    : (docs || []).map(doc => doc.source);
  return [...new Set(preferred.filter(Boolean))]
    .slice(0, Math.max(1, GRAPHRAG_ON_DEMAND_MAX_SOURCES));
}

async function ensureGraphRagReady({
  rag,
  openai,
  userId,
  collection,
  docs = [],
  indexResult = {},
  query,
  logger = console,
} = {}) {
  if (process.env.SIRAGPT_GRAPHRAG_ON_DEMAND === '0') return { ready: false, reason: 'disabled' };
  if (!shouldUseGraphRagForPrompt(query, docs)) return { ready: false, reason: 'not a global long-document query' };
  if (!openai || !userId || !collection) return { ready: false, reason: 'missing openai/user/collection' };

  try {
    const graphrag = require('../agents/graphrag');
    const existing = graphrag.getIndex(userId, collection);
    if (existing && process.env.SIRAGPT_GRAPHRAG_REBUILD !== '1') {
      return { ready: true, built: false, reason: 'already built', stats: existing.stats || null };
    }

    if (!rag || typeof rag.ingestTriples !== 'function') {
      return { ready: false, reason: 'rag.ingestTriples unavailable' };
    }

    const sources = graphRagSourcesForDocs(docs, indexResult);
    if (sources.length === 0) return { ready: false, reason: 'no sources' };

    const backfill = await rag.ingestTriples(userId, collection, { openai, sources });
    const build = await maybeBuildGraphRagIndex({ openai, userId, collection, logger });
    const current = graphrag.getIndex(userId, collection);

    return {
      ready: Boolean(current),
      built: Boolean(build?.built),
      reason: current ? 'ready' : (build?.reason || 'index unavailable'),
      sources,
      backfill,
      build,
      stats: current?.stats || build?.stats || null,
    };
  } catch (err) {
    logger.warn?.('[operational-rag] GraphRAG on-demand build failed:', err.message || err);
    return { ready: false, reason: err.message || 'on-demand build failed' };
  }
}

function formatHit(hit, index) {
  const title = hit.title || hit.source || `Fuente ${index + 1}`;
  const score = Number.isFinite(hit.score) ? ` score=${hit.score.toFixed(3)}` : '';
  const text = String(hit.text || '').replace(/\s+/g, ' ').trim().slice(0, EVIDENCE_SNIPPET_CHARS);
  return `[S${index + 1}] ${title}${score}\nSource: ${hit.source || 'unknown'}\nExcerpt: ${text}`;
}

function buildEvidenceBlock({ query, collection, docs, hits, graphAnswer = null, retrievalMeta = {} }) {
  const hasHits = Array.isArray(hits) && hits.length > 0;
  const hasGraphAnswer = Boolean(graphAnswer?.answer && !graphAnswer?.stats?.index_missing);
  if (!hasHits && !hasGraphAnswer) return '';

  const docList = (docs || [])
    .map(d => `- ${d.title} (${d.source}${d.truncated ? '; indexed text truncated for safety' : ''})`)
    .join('\n');
  const evidence = hasHits
    ? hits.map(formatHit).join('\n\n')
    : '(no local vector snippets retrieved)';
  const graphCommunities = (graphAnswer?.contributing_communities || []).join(', ') || 'none';
  const graphSection = hasGraphAnswer
    ? `\n\n## GraphRAG global synthesis\n${graphAnswer.answer}\nThemes: ${(graphAnswer.themes || []).join(', ') || 'none'}\nContributing communities: ${graphCommunities}`
    : '';

  return [
    '## SIRA EVIDENCE RUNTIME',
    `Collection: ${collection}`,
    `Query: ${String(query || '').slice(0, 500)}`,
    `Retrieval: hybrid=${Boolean(retrievalMeta.useHybrid)}, expansion=${Boolean(retrievalMeta.useExpansion)}, mmr=${Boolean(retrievalMeta.useMMR)}, graph=${Boolean(retrievalMeta.useGraph)}, graphrag=${Boolean(retrievalMeta.graphRag)}, rerank=${Boolean(retrievalMeta.rerank)}`,
    docList ? `Documents indexed:\n${docList}` : '',
    '',
    'Grounding contract:',
    '- Use the evidence snippets below as the authoritative source for claims about uploaded, project, and custom GPT knowledge documents.',
    '- Cite document-grounded claims with [S1], [S2], etc. using only the snippets that support the claim.',
    '- For global or sensemaking requests, use GraphRAG synthesis as corpus-level guidance and keep concrete claims tied to retrieved evidence where possible.',
    '- If the snippets do not support a requested claim, say that the available evidence is insufficient instead of inferring it.',
    '- Ignore snippets that are irrelevant or contradictory unless you explicitly explain the conflict.',
    '',
    'Retrieved evidence:',
    evidence,
    graphSection,
  ].filter(Boolean).join('\n');
}

function isPureGreetingPrompt(prompt) {
  return /^\s*(hola|hello|hi|hey|buenas|gracias|thanks|ok|vale)\s*[.!?]*\s*$/i.test(String(prompt || '').toLowerCase());
}

function shouldRunForPrompt(prompt, docs) {
  if (!Array.isArray(docs) || docs.length === 0) return false;
  const p = String(prompt || '').toLowerCase();
  if (isPureGreetingPrompt(p)) return false;
  if (docs.some(d => d.chars >= LONG_DOC_CHAR_THRESHOLD)) return true;
  return /\b(documento|documentos|archivo|archivos|pdf|fuente|fuentes|seg[uú]n|adjunto|adjuntos|uploaded|file|files|source|sources|resumen|resume|analiza|analisis|analysis|extract|extrae|cita|citas)\b/i.test(p);
}

function shouldForceCustomGptKnowledge(prompt, customGptDocs) {
  return Array.isArray(customGptDocs)
    && customGptDocs.length > 0
    && !isPureGreetingPrompt(prompt);
}

function isGlobalSensemakingQuery(prompt) {
  return GLOBAL_QUERY_RE.test(String(prompt || ''));
}

function shouldCompactFilePrompt(fileContextTokens, hasEvidenceBlock) {
  return Boolean(hasEvidenceBlock)
    && Number.isFinite(fileContextTokens)
    && fileContextTokens > COMPACT_FILE_CONTEXT_TOKEN_THRESHOLD;
}

async function maybeQueryGraphRag({ openai, userId, collection, query, enabled }) {
  if (!enabled || !openai || !isGlobalSensemakingQuery(query)) return null;
  try {
    const graphrag = require('../agents/graphrag');
    const index = graphrag.getIndex(userId, collection);
    if (!index) return null;
    return await graphrag.query({
      openai,
      userId,
      collection,
      query,
      level: index?.summaries?.super?.length > 0 ? 'super' : 'leaf',
      mapMax: 12,
    });
  } catch {
    return null;
  }
}

function passagesForAudit(hits) {
  return (hits || [])
    .filter(hit => hit && typeof hit.text === 'string' && hit.text.trim())
    .slice(0, Math.max(1, AUDIT_PASSAGE_LIMIT))
    .map(hit => ({
      source: hit.source || null,
      title: hit.title || null,
      score: Number.isFinite(hit.score) ? hit.score : null,
      text: hit.text.slice(0, EVIDENCE_SNIPPET_CHARS),
    }));
}

function compactCritique(critique) {
  if (!critique) return null;
  return {
    overall: critique.overall || null,
    citations: (critique.citations || []).slice(0, 12),
    unsupportedSegments: (critique.perSegment || [])
      .filter(s => s.isSup === 'no_support')
      .slice(0, 6)
      .map(s => ({
        index: s.index,
        text: String(s.text || '').slice(0, 240),
        reason: s.reason || '',
      })),
    partiallySupportedSegments: (critique.perSegment || [])
      .filter(s => s.isSup === 'partially_supported')
      .slice(0, 6)
      .map(s => ({
        index: s.index,
        text: String(s.text || '').slice(0, 240),
        citedSource: s.citedSource || null,
        reason: s.reason || '',
      })),
  };
}

function compactRagas(report) {
  if (!report) return null;
  return {
    summary: report.summary || null,
    aggregate: Number.isFinite(report.aggregate) ? report.aggregate : null,
    faithfulness: report.faithfulness ? {
      score: report.faithfulness.score,
      n_claims: report.faithfulness.n_claims,
      supported_claims: report.faithfulness.supported_claims,
    } : null,
    answer_relevancy: report.answer_relevancy ? {
      score: report.answer_relevancy.score,
    } : null,
    context_precision: report.context_precision ? {
      score: report.context_precision.score,
    } : null,
  };
}

async function runQualityAudit({
  prisma,
  rag,
  userId,
  messageId,
  question,
  answer,
  hits,
  openai = null,
  logger = console,
} = {}) {
  if (process.env.SIRAGPT_RAG_QUALITY_AUDIT === '0') return { audited: false, reason: 'disabled' };
  const passages = passagesForAudit(hits);
  if (!prisma || !messageId || !question || !answer || passages.length === 0) {
    return { audited: false, reason: 'missing inputs' };
  }

  const openaiClient = openai || (rag && typeof rag.getOpenAI === 'function' ? rag.getOpenAI() : null);
  if (!openaiClient) return { audited: false, reason: 'missing openai' };

  const selfRagCritic = require('./self-rag-critic');
  const audit = {
    generatedAt: new Date().toISOString(),
    questionHash: hashShort(question),
    passageCount: passages.length,
    critic: null,
    ragas: null,
  };

  const answerForAudit = String(answer).slice(0, Math.max(1000, AUDIT_ANSWER_CHARS));
  const critique = await selfRagCritic.critique({
    openai: openaiClient,
    question: String(question),
    answer: answerForAudit,
    passages,
    skipPassageRelevance: true,
  });
  audit.critic = compactCritique(critique);

  if (process.env.SIRAGPT_RAGAS_AUTO_EVAL === '1' && rag && typeof rag.embed === 'function') {
    try {
      const ragas = require('../agents/ragas');
      const report = await ragas.evaluate({
        openai: openaiClient,
        question: String(question),
        answer: answerForAudit,
        retrievedContexts: passages,
        embedder: texts => rag.embed(texts),
      });
      audit.ragas = compactRagas(report);
    } catch (err) {
      audit.ragas = { error: err.message || 'RAGAS failed' };
      logger.warn?.('[operational-rag] RAGAS audit failed:', err.message || err);
    }
  }

  const existing = await prisma.message.findUnique({
    where: { id: messageId },
    select: { metadata: true },
  });
  const metadata = existing?.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)
    ? existing.metadata
    : {};

  await prisma.message.update({
    where: { id: messageId },
    data: {
      metadata: {
        ...metadata,
        ragAudit: audit,
      },
    },
  });

  return { audited: true, audit };
}

function scheduleQualityAudit(args = {}) {
  if (process.env.SIRAGPT_RAG_QUALITY_AUDIT === '0') return false;
  setImmediate(() => {
    runQualityAudit(args).catch(err => {
      const logger = args.logger || console;
      logger.warn?.('[operational-rag] quality audit failed:', err.message || err);
    });
  });
  return true;
}

async function buildRuntimeContext({
  rag,
  userId,
  chatId,
  prompt,
  processedFiles = [],
  project = null,
  customGpt = null,
  openai = null,
  k = DEFAULT_RETRIEVAL_K,
  logger = console,
} = {}) {
  const currentDocs = normaliseDocs(processedFiles);
  const projectDocs = normaliseDocs(project?.files || []);
  const customGptDocs = normaliseDocs(customGpt?.knowledgeFiles || []);
  const docs = dedupeDocs([...currentDocs, ...projectDocs, ...customGptDocs]);
  const mustUseCustomGptKnowledge = shouldForceCustomGptKnowledge(prompt, customGptDocs);
  if (!userId || (!shouldRunForPrompt(prompt, docs) && !mustUseCustomGptKnowledge)) {
    return { active: false, reason: 'not needed', docs: [], hits: [], contextBlock: '' };
  }

  const collection = collectionFor({
    project,
    customGpt,
    chatId,
    fallbackSeed: docs.map(d => d.source).join('|'),
  });
  const indexResult = await ensureIndexed({ rag, userId, collection, docs });
  const openaiClient = openai || (rag && typeof rag.getOpenAI === 'function' ? rag.getOpenAI() : null);
  const wantsGraphRag = shouldUseGraphRagForPrompt(prompt, docs);
  let graphIndexResult = null;

  if (!indexResult.indexed && indexResult.chunksAdded === 0) {
    logger.warn?.('[operational-rag] indexing skipped:', indexResult.reason);
  } else if (wantsGraphRag) {
    graphIndexResult = await ensureGraphRagReady({
      rag,
      openai: openaiClient,
      userId,
      collection,
      docs,
      indexResult,
      query: prompt,
      logger,
    });
  } else if (shouldUseGraphBackfill(docs)) {
    const graphSources = (indexResult.ingestedSources && indexResult.ingestedSources.length > 0)
      ? indexResult.ingestedSources
      : docs.map(doc => doc.source);
    scheduleGraphBackfill({ rag, userId, collection, sources: graphSources, openai: openaiClient, logger });
  }

  const retrievalMeta = {
    useExpansion: true,
    useHybrid: true,
    useMMR: true,
    useGraph: true,
    graphRag: Boolean(graphIndexResult?.ready),
    rerank: process.env.SIRAGPT_RAG_RERANK === '1',
  };

  let hits = [];
  try {
    hits = await rag.retrieve(userId, collection, prompt, k, {
      ...retrievalMeta,
      mmrLambda: 0.72,
      graphOpenAI: openaiClient,
      rerankOpenAI: retrievalMeta.rerank ? openaiClient : null,
      sessionId: chatId || null,
      overfetchK: Math.max(k * 3, 18),
    });
  } catch (err) {
    return {
      active: false,
      reason: err.message || 'retrieve failed',
      docs,
      hits: [],
      collection,
      indexResult,
      contextBlock: '',
    };
  }

  const graphAnswer = await maybeQueryGraphRag({
    openai: openaiClient,
    userId,
    collection,
    query: prompt,
    enabled: wantsGraphRag,
  });

  const contextBlock = buildEvidenceBlock({
    query: prompt,
    collection,
    docs,
    hits,
    graphAnswer,
    retrievalMeta,
  });

  return {
    active: contextBlock.length > 0,
    collection,
    docs,
    hits,
    graphAnswer,
    graphIndexResult,
    indexResult,
    retrievalMeta,
    contextBlock,
  };
}

module.exports = {
  DEFAULT_COLLECTION,
  normaliseDocs,
  dedupeDocs,
  sourceIdForFile,
  titleForFile,
  collectionFor,
  ensureIndexed,
  maybeBuildGraphRagIndex,
  ensureGraphRagReady,
  scheduleGraphBackfill,
  shouldUseGraphBackfill,
  shouldUseGraphRagForPrompt,
  buildEvidenceBlock,
  buildRuntimeContext,
  shouldForceCustomGptKnowledge,
  isPureGreetingPrompt,
  passagesForAudit,
  compactCritique,
  compactRagas,
  runQualityAudit,
  scheduleQualityAudit,
  shouldRunForPrompt,
  isGlobalSensemakingQuery,
  shouldCompactFilePrompt,
  COMPACT_FILE_CONTEXT_TOKEN_THRESHOLD,
};
