/**
 * context-curation — post-retrieval techniques from Gao et al. 2024
 * §V.A (Context Curation). Two methods that both reduce the token
 * footprint of retrieved context before it reaches the generator:
 *
 *   - chainOfNote (Yu et al., arXiv:2311.09210): for EACH retrieved
 *     passage, ask the LLM to produce a SHORT note on how (or whether)
 *     it helps answer the question. Then filter by relevance score
 *     and pass only the surviving passages + their notes forward.
 *     Reported effect: higher faithfulness + better rejection of
 *     irrelevant retrievals.
 *
 *   - compress (LLMLingua-style, Jiang et al., arXiv:2310.05736): per
 *     passage, keep only the sentences that share query tokens or
 *     carry enough lexical signal to plausibly answer. We use a
 *     lightweight, LLM-free variant: query-term overlap + inverse
 *     passage-length weighting. Optionally the LLM can replace the
 *     heuristic for higher precision.
 *
 * Neither technique calls the retriever — they operate on the passage
 * list the retriever already returned.
 */

const DEFAULT_NOTE_MODEL = 'gpt-4o-mini';

const CHAIN_OF_NOTE_SYSTEM = `You are a relevance assessor and note-taker for retrieval-augmented generation.

Given a USER QUESTION and ONE retrieved PASSAGE, produce a short note on whether (and how) the passage helps answer the question.

Output format — STRICT JSON:
{
  "relevant": true|false,
  "score": <0..1, how useful is this passage for answering>,
  "note": "<one sentence summarising what the passage contributes, or why it doesn't>"
}

Rules:
- relevant=true only if the passage contributes a FACT or REASONING step the answer would actually use.
- A passage about the same topic but not answering the specific question is relevant=false.
- Note is 1-2 sentences max.`;

function parseJSON(text) {
  if (typeof text !== 'string') return {};
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(cleaned); } catch { return {}; }
}

async function callLLM({ openai, model, system, user, temperature = 0, maxTokens = 200 }) {
  const resp = await openai.chat.completions.create({
    model, temperature, max_tokens: maxTokens,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user',   content: user },
    ],
  });
  return parseJSON(resp.choices?.[0]?.message?.content || '{}');
}

/**
 * Chain-of-Note over a list of retrieved passages.
 *
 * @param {object} args
 * @param {object} args.openai
 * @param {string} args.query
 * @param {Array<{source:string, text:string, score?:number}>} args.passages
 * @param {number} [args.keepThreshold=0.4]  — drop passages below this score
 * @param {string} [args.model]
 * @returns {Promise<{
 *   kept: Array<{source:string, text:string, note:string, score:number}>,
 *   dropped: Array<{source:string, reason:string, score:number}>,
 *   notes: Array<{source:string, note:string, score:number, relevant:boolean}>,
 * }>}
 */
async function chainOfNote({
  openai,
  query,
  passages,
  keepThreshold = 0.4,
  model = DEFAULT_NOTE_MODEL,
}) {
  if (!openai) throw new Error('chain-of-note: openai client required');
  if (!Array.isArray(passages)) return { kept: [], dropped: [], notes: [] };
  if (typeof query !== 'string' || query.trim().length === 0) {
    return { kept: [], dropped: passages.map(p => ({ source: p.source, reason: 'empty query', score: 0 })), notes: [] };
  }

  const notes = [];
  const kept = [];
  const dropped = [];

  for (const p of passages) {
    try {
      const out = await callLLM({
        openai, model,
        system: CHAIN_OF_NOTE_SYSTEM,
        user: `QUESTION:\n${query.slice(0, 1000)}\n\nPASSAGE:\n${String(p.text || '').slice(0, 2500)}`,
      });
      const score = typeof out.score === 'number'
        ? Math.max(0, Math.min(1, out.score))
        : (out.relevant === true ? 0.6 : 0.1);
      const relevant = score >= keepThreshold;
      const note = typeof out.note === 'string' ? out.note.slice(0, 400) : '';
      notes.push({ source: p.source, note, score, relevant });
      if (relevant) {
        kept.push({ source: p.source, text: p.text, note, score });
      } else {
        dropped.push({ source: p.source, reason: note || 'below threshold', score });
      }
    } catch (err) {
      // Soft-fail: keep the passage, mark the note error. The point of
      // the filter is to improve context; a broken filter shouldn't
      // discard otherwise-valid retrievals.
      notes.push({ source: p.source, note: `[note error: ${err.message}]`, score: 0.5, relevant: true });
      kept.push({ source: p.source, text: p.text, note: '', score: 0.5 });
    }
  }
  return { kept, dropped, notes };
}

// ─── Context compression (LLMLingua-style, LLM-free variant) ─────────────

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'so', 'is', 'are',
  'was', 'were', 'be', 'been', 'being', 'of', 'in', 'on', 'at', 'to',
  'for', 'with', 'by', 'from', 'as', 'that', 'this', 'these', 'those',
  'it', 'its', 'we', 'you', 'they', 'he', 'she', 'i', 'my', 'our',
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'de', 'del',
  'y', 'o', 'que', 'es', 'son', 'en', 'con', 'por', 'para', 'se', 'lo',
]);

function tokenizeLower(text) {
  if (typeof text !== 'string') return [];
  return (text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []);
}

function querySignalTerms(query) {
  return new Set(tokenizeLower(query).filter(t => t.length > 2 && !STOPWORDS.has(t)));
}

function sentenceRelevance(sentence, signalTerms) {
  if (signalTerms.size === 0) return 0;
  const tokens = tokenizeLower(sentence);
  const unique = new Set(tokens);
  let hits = 0;
  for (const t of unique) if (signalTerms.has(t)) hits++;
  // Normalise by signal set size (query coverage) + small
  // inverse-length term so 1-term hits in long sentences don't dominate.
  const coverage = hits / signalTerms.size;
  const lengthPenalty = Math.min(1, 20 / Math.max(5, tokens.length));
  return 0.8 * coverage + 0.2 * lengthPenalty;
}

/**
 * compress — keep only the top-N sentences per passage whose
 * sentence-relevance to the query exceeds `minScore`. Optionally, keep
 * ≥1 sentence always (neverEmpty) so the passage is never fully dropped
 * unless it scored zero everywhere.
 *
 * LLM-free by design: runs offline at microsecond latency and uses no
 * API tokens. For higher precision on ambiguous queries, callers can
 * pass through chainOfNote() first.
 *
 * @param {object} args
 * @param {string} args.query
 * @param {Array<{source:string, text:string, score?:number}>} args.passages
 * @param {number} [args.minScore=0.15]
 * @param {number} [args.topSentences=5]  — per passage
 * @param {boolean} [args.neverEmpty=true]
 * @returns {{
 *   compressed: Array<{source:string, text:string, originalLen:number, compressedLen:number, ratio:number}>,
 *   totals: { originalLen:number, compressedLen:number, ratio:number },
 * }}
 */
function compress({
  query,
  passages,
  minScore = 0.15,
  topSentences = 5,
  neverEmpty = true,
}) {
  if (!Array.isArray(passages) || passages.length === 0) {
    return { compressed: [], totals: { originalLen: 0, compressedLen: 0, ratio: 1 } };
  }
  const signals = querySignalTerms(query);
  const splitSentences = require('./advanced-chunking').splitSentences;

  const compressed = [];
  let totalOriginal = 0;
  let totalCompressed = 0;

  for (const p of passages) {
    const body = String(p.text || '');
    totalOriginal += body.length;
    const sents = splitSentences(body);
    if (sents.length === 0) {
      // totalOriginal already counted body.length above; report the same here so
      // the per-record originalLen sum reconciles with the total.
      compressed.push({ source: p.source, text: '', originalLen: body.length, compressedLen: 0, ratio: 1 });
      continue;
    }
    const scored = sents.map((s, i) => ({
      index: i,
      text: s,
      score: sentenceRelevance(s, signals),
    }));
    // Sort by score desc, then take the top-N that pass minScore.
    const picked = [...scored]
      .sort((a, b) => b.score - a.score)
      .filter(s => s.score >= minScore)
      .slice(0, topSentences);

    let chosen = picked;
    if (chosen.length === 0 && neverEmpty) {
      // Fallback: keep the highest-scoring sentence, even below threshold.
      const top = [...scored].sort((a, b) => b.score - a.score)[0];
      if (top) chosen = [top];
    }
    // Restore original document order for readability.
    chosen.sort((a, b) => a.index - b.index);
    const text = chosen.map(c => c.text).join(' ');
    totalCompressed += text.length;
    compressed.push({
      source: p.source,
      text,
      originalLen: body.length,
      compressedLen: text.length,
      ratio: body.length === 0 ? 1 : text.length / body.length,
    });
  }

  return {
    compressed,
    totals: {
      originalLen: totalOriginal,
      compressedLen: totalCompressed,
      ratio: totalOriginal === 0 ? 1 : totalCompressed / totalOriginal,
    },
  };
}

module.exports = {
  chainOfNote,
  compress,
  sentenceRelevance,
  querySignalTerms,
  CHAIN_OF_NOTE_SYSTEM,
  STOPWORDS,
};
