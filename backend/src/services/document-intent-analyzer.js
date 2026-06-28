/**
 * document-intent-analyzer.js
 *
 * Analyzes uploaded documents to infer user intent and relationships
 * between multiple documents. Provides structured context the chat
 * can reference to understand what the user wants to do.
 *
 * Key capabilities:
 * - Per-document intent classification
 * - Cross-document relationship detection
 * - LLM-powered analysis with keyword fallback
 * - Structured storage for chat reference
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ── Cached store ──────────────────────────────────────────────────────────
// Module-level Map keyed by batchId. Each entry stores the intent analysis
// for a group of uploaded documents.
const intentStore = new Map();

// ── Constants ─────────────────────────────────────────────────────────────
const MAX_PREVIEW_CHARS = 4000;  // chars sent to LLM per document
const MAX_BATCH_FILES = 200;     // max files in a single batch analysis
const MAX_STORE_ENTRIES = 50;    // cap total stored analyses
const INTENT_MODEL = process.env.SIRAGPT_INTENT_MODEL || 'gpt-4o-mini';

// ── Intent types ──────────────────────────────────────────────────────────
const INTENT_TYPES = Object.freeze({
  SUMMARIZE:    'summarize',
  ANALYZE:      'analyze',
  EXTRACT_DATA: 'extract_data',
  TRANSLATE:    'translate',
  RESEARCH:     'research',
  COMPARE:      'compare',
  GENERATE:     'generate',
  REVIEW:       'review',
  CLASSIFY:     'classify',
  ANSWERS:      'answers',
  CREATE_DOC:   'create_document',
  UNKNOWN:      'unknown',
});

// ── Intent keywords per type (fallback when no LLM) ───────────────────────
const INTENT_KEYWORDS = {
  [INTENT_TYPES.SUMMARIZE]:    ['resumen', 'síntesis', 'summary', 'synopsis', 'conclusion', 'synthesize', 'tl;dr'],
  [INTENT_TYPES.ANALYZE]:      ['analiza', 'analyze', 'examine', 'diagnosis', 'evaluate', 'review this'],
  [INTENT_TYPES.EXTRACT_DATA]: ['extrae', 'extract', 'parse', 'tabla', 'table', 'csv', 'json', 'datos'],
  [INTENT_TYPES.TRANSLATE]:    ['traduce', 'translate', 'idioma', 'language'],
  [INTENT_TYPES.RESEARCH]:     ['investiga', 'research', 'find', 'busca', 'comparece', 'findings'],
  [INTENT_TYPES.COMPARE]:      ['compara', 'compare', 'contrast', 'diferencia', 'vs', 'versus'],
  [INTENT_TYPES.GENERATE]:     ['genera', 'generate', 'create', 'write', 'redacta', 'produce'],
  [INTENT_TYPES.REVIEW]:       ['revisa', 'review', 'check', 'proofread', 'corrige', 'edita'],
  [INTENT_TYPES.CLASSIFY]:     ['clasifica', 'classify', 'categorize', 'organize', 'sort', 'tag'],
  [INTENT_TYPES.ANSWERS]:      ['pregunta', 'question', 'answer', 'respond', 'responde', 'faq'],
  [INTENT_TYPES.CREATE_DOC]:   ['documento', 'document', 'report', 'informe', 'carta', 'letter', 'memo'],
};

// ── Core analysis ─────────────────────────────────────────────────────────

/**
 * Analyze a single document to determine its type and likely user intent.
 *
 * @param {Object} doc - { id, name, text, mimeType, size }
 * @param {Object} [opts]
 * @param {Function} [opts.llm] - Optional LLM function(text, prompt) -> string
 * @returns {Promise<Object>} { intent, confidence, docType, summary, keywords }
 */
async function analyzeSingleDocument(doc, opts = {}) {
  const { llm = null } = opts;
  const text = String(doc.text || '');
  const name = String(doc.name || '');
  const mime = String(doc.mimeType || '');

  // Fallback: keyword + heuristic analysis
  const heuristics = analyzeHeuristics(text, name, mime);

  // If no LLM provided, return heuristic result
  if (typeof llm !== 'function') {
    return {
      ...heuristics,
      llmUsed: false,
    };
  }

  // LLM-enhanced analysis
  try {
    const preview = text.slice(0, MAX_PREVIEW_CHARS);
    const prompt = [
      `You are a document intent analyzer. Analyze this document and respond with ONLY valid JSON (no markdown, no backticks).`,
      ``,
      `Document name: ${JSON.stringify(name)}`,
      `MIME type: ${JSON.stringify(mime)}`,
      `Size: ${doc.size || 0} bytes`,
      `Preview (first ${preview.length} chars):`,
      ``,
      preview.slice(0, 2000),
      ``,
      `JSON fields:`,
      `- "intent": one of [${Object.values(INTENT_TYPES).join(', ')}] — what the user likely wants to do with this document`,
      `- "confidence": 0.0 to 1.0`,
      `- "docType": "report" | "spreadsheet" | "presentation" | "code" | "article" | "data" | "image" | "other"`,
      `- "summary": one-sentence summary of the document (max 30 words)`,
      `- "keywords": array of up to 8 key topics found in the document`,
      `- "language": detected language code ("es", "en", or null)`,
    ].join('\n');

    const llmResult = await llm(prompt);
    const parsed = parseLLMResponse(llmResult);

    if (parsed && parsed.intent) {
      return {
        intent: parsed.intent,
        // Nullish guard — a valid LLM confidence of 0 ("no idea") must not be
        // coerced to 0.5 by `|| 0.5`.
        confidence: Math.min(1, Math.max(0, Number.isFinite(parsed.confidence) ? parsed.confidence : 0.5)),
        docType: parsed.docType || heuristics.docType,
        summary: parsed.summary || heuristics.summary,
        keywords: Array.isArray(parsed.keywords) ? parsed.keywords.slice(0, 8) : heuristics.keywords,
        language: parsed.language || heuristics.language,
        llmUsed: true,
      };
    }
  } catch (err) {
    console.warn('[intent-analyzer] LLM analysis failed:', err.message);
  }

  // Fallback to heuristics
  return { ...heuristics, llmUsed: false };
}

/**
 * Analyze multiple documents together to determine overall user intent.
 *
 * @param {Object[]} docs - Array of document objects
 * @param {Object} [opts]
 * @param {Function} [opts.llm] - Optional LLM function
 * @returns {Promise<Object>} { primaryIntent, crossDocSummary, fileAnalyses, batchId }
 */
async function analyzeBatch(docs, opts = {}) {
  const { llm = null } = opts;
  const validDocs = (Array.isArray(docs) ? docs : []).slice(0, MAX_BATCH_FILES);

  if (validDocs.length === 0) {
    return { primaryIntent: INTENT_TYPES.UNKNOWN, crossDocSummary: '', fileAnalyses: [], batchId: null };
  }

  // Analyze each document individually
  const fileAnalyses = await Promise.all(
    validDocs.map(doc => analyzeSingleDocument(doc, opts).then(result => ({
      id: doc.id,
      name: doc.name,
      mimeType: doc.mimeType,
      size: doc.size,
      ...result,
    })).catch(() => ({
      id: doc.id,
      name: doc.name,
      intent: INTENT_TYPES.UNKNOWN,
      confidence: 0,
      docType: 'other',
      summary: '',
      keywords: [],
      llmUsed: false,
    })))
  );

  // Determine primary intent (most common). UNKNOWN is excluded from the tally
  // so a batch of mostly-unclassified docs doesn't let 'unknown' beat a real
  // intent; fall back to UNKNOWN only when nothing real was detected.
  const intentCounts = {};
  for (const fa of fileAnalyses) {
    if (fa.intent === INTENT_TYPES.UNKNOWN) continue;
    intentCounts[fa.intent] = (intentCounts[fa.intent] || 0) + 1;
  }
  const primaryIntent = Object.entries(intentCounts)
    .sort((a, b) => b[1] - a[1])[0]?.[0] || INTENT_TYPES.UNKNOWN;

  // Build cross-document analysis
  const crossDocSummary = buildCrossDocSummary(fileAnalyses);

  // Generate a batch id for storage
  const batchId = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // Store the analysis. Stamp the owner so getUserAnalyses can scope by user
  // (it previously returned every user's batches).
  const entry = {
    batchId,
    userId: opts.userId || null,
    createdAt: new Date().toISOString(),
    primaryIntent,
    crossDocSummary,
    fileCount: fileAnalyses.length,
    fileAnalyses,
  };
  intentStore.set(batchId, entry);

  // Cap store size
  if (intentStore.size > MAX_STORE_ENTRIES) {
    const oldest = [...intentStore.keys()].slice(0, intentStore.size - MAX_STORE_ENTRIES);
    for (const k of oldest) intentStore.delete(k);
  }

  return entry;
}

/**
 * Convenience: analyze documents from Prisma file records.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} userId
 * @param {string[]} fileIds - Array of file record ids
 * @param {Object} [opts]
 * @returns {Promise<Object>}
 */
async function analyzeFromPrisma(prisma, userId, fileIds, opts = {}) {
  if (!prisma || !userId || !Array.isArray(fileIds) || fileIds.length === 0) {
    return { primaryIntent: INTENT_TYPES.UNKNOWN, fileAnalyses: [] };
  }

  const records = await prisma.file.findMany({
    where: { id: { in: fileIds }, userId },
    select: { id: true, originalName: true, extractedText: true, mimeType: true, size: true },
  });

  if (records.length === 0) return { primaryIntent: INTENT_TYPES.UNKNOWN, fileAnalyses: [] };

  const docs = records.map(r => ({
    id: r.id,
    name: r.originalName,
    text: r.extractedText || '',
    mimeType: r.mimeType,
    size: r.size,
  }));

  return analyzeBatch(docs, { ...opts, userId });
}

// ── Getters ───────────────────────────────────────────────────────────────

/**
 * Retrieve a stored batch analysis by batchId.
 */
function getBatchAnalysis(batchId) {
  return intentStore.get(batchId) || null;
}

/**
 * Retrieve all stored batch analyses for a user (prefix match).
 */
function getUserAnalyses(userId) {
  if (!userId) return [];
  const results = [];
  for (const entry of intentStore.values()) {
    // Scope to the requesting user — returning every user's batches was a
    // cross-user data leak.
    if (entry.userId === userId && entry.fileAnalyses?.length > 0 && entry.createdAt) {
      results.push(entry);
    }
  }
  // Sort newest first, limit to 10
  return results.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 10);
}

/**
 * Get the latest batch analysis.
 */
function getLatestAnalysis() {
  let latest = null;
  let latestTime = 0;
  for (const entry of intentStore.values()) {
    const t = new Date(entry.createdAt || 0).getTime();
    if (t > latestTime) {
      latestTime = t;
      latest = entry;
    }
  }
  return latest;
}

// ── Internal helpers ──────────────────────────────────────────────────────

/**
 * Heuristic-only document analysis (no LLM).
 */
function analyzeHeuristics(text, name, mime) {
  const lower = text.toLowerCase();
  const nameLower = name.toLowerCase();

  // Detect doc type from MIME and name
  let docType = 'other';
  if (/pdf/.test(mime)) docType = 'report';
  else if (/spreadsheet|excel|xlsx|xls|csv/.test(mime)) docType = 'spreadsheet';
  else if (/presentation|powerpoint|pptx/.test(mime)) docType = 'presentation';
  else if (/word|document.*officedocument/.test(mime)) docType = 'report';
  else if (/text|markdown/.test(mime)) docType = 'article';
  else if (/image/.test(mime)) docType = 'image';
  else if (/json|xml|yaml|code|javascript|typescript|python/.test(mime) || /\.(js|ts|py|json|xml)$/.test(nameLower)) docType = 'code';

  // Detect language
  const sample = text.slice(0, 6000).toLowerCase();
  const spanishHits = (sample.match(/\b(el|la|los|las|de|del|que|para|con|por|una|un|como)\b/g) || []).length;
  const englishHits = (sample.match(/\b(the|and|that|for|with|from|this|these|their)\b/g) || []).length;
  const language = spanishHits >= Math.max(4, englishHits) ? 'es' : (englishHits >= 4 ? 'en' : null);

  // Detect intent from keywords
  let intent = INTENT_TYPES.UNKNOWN;
  let maxScore = 0;
  for (const [type, keywords] of Object.entries(INTENT_KEYWORDS)) {
    let score = 0;
    for (const kw of keywords) {
      // Substring match is intentional here: it catches inflected forms across
      // ES/EN (documento→document, conclusiones→conclusion) the heuristic relies
      // on (see the Spanish-summarize test). A word-boundary variant caused worse
      // false-negatives than the rare substring false-positive.
      if (lower.includes(kw) || nameLower.includes(kw)) score += 2;
    }
    if (score > maxScore) {
      maxScore = score;
      intent = type;
    }
  }

  // Extract keywords (top 8 frequent meaningful terms)
  const words = lower
    .replace(/[^a-záéíóúñ\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !['este','esta','esto','para','como','con','del','que','las','los','the','and','for','with','from','that','this'].includes(w));
  const freq = {};
  for (const w of words) { freq[w] = (freq[w] || 0) + 1; }
  const keywords = Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([w]) => w);

  // Summary from first meaningful sentence
  const firstSentences = text.replace(/\n+/g, ' ').split(/[.!?]/).filter(s => s.trim().length > 20);
  const summary = firstSentences.length > 0
    ? firstSentences[0].trim().slice(0, 120)
    : `${docType} document (${text.length} chars)`;

  return {
    intent,
    confidence: maxScore > 0 ? Math.min(0.8, 0.3 + maxScore * 0.1) : 0.2,
    docType,
    summary,
    keywords,
    language,
  };
}

/**
 * Build a cross-document summary.
 */
function buildCrossDocSummary(fileAnalyses) {
  const intents = fileAnalyses.map(f => f.intent).filter(Boolean);
  const types = fileAnalyses.map(f => f.docType).filter(Boolean);
  const keywords = [...new Set(fileAnalyses.flatMap(f => f.keywords || []))];
  const languages = [...new Set(fileAnalyses.map(f => f.language).filter(Boolean))];

  const intentCounts = {};
  for (const i of intents) intentCounts[i] = (intentCounts[i] || 0) + 1;
  const typeCounts = {};
  for (const t of types) typeCounts[t] = (typeCounts[t] || 0) + 1;

  const primaryIntent = Object.entries(intentCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown';
  const primaryType = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'various';

  return {
    fileCount: fileAnalyses.length,
    primaryIntent,
    primaryDocType: primaryType,
    topKeywords: keywords.slice(0, 10),
    languages,
    summary: `${fileAnalyses.length} file(s) uploaded — ` +
      `primary intent: ${primaryIntent}, predominant type: ${primaryType}` +
      (keywords.length > 0 ? `, topics: ${keywords.slice(0, 5).join(', ')}` : ''),
  };
}

/**
 * Parse LLM JSON response (handles markdown-wrapped JSON).
 */
function parseLLMResponse(text) {
  if (!text) return null;
  try {
    // Strip markdown fences if present
    let cleaned = text.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }
    return JSON.parse(cleaned);
  } catch {
    // Try to find JSON block
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { return null; }
    }
    return null;
  }
}

// ── Module exports ────────────────────────────────────────────────────────

module.exports = {
  INTENT_TYPES,
  analyzeSingleDocument,
  analyzeBatch,
  analyzeFromPrisma,
  getBatchAnalysis,
  getUserAnalyses,
  getLatestAnalysis,
  // For testing
  INTERNAL: {
    analyzeHeuristics,
    buildCrossDocSummary,
    parseLLMResponse,
    INTENT_KEYWORDS,
  },
};
