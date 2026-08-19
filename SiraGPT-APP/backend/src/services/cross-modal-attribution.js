'use strict';

/**
 * cross-modal-attribution.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Attributes a generated response back to specific regions of attached
 * files (paragraphs, chunks, page numbers, sheet ranges) so the UI can
 * render "this sentence cites this part of doc.pdf p.4". Complements
 * `token-attribution-tracer.js`: where that module operates at the
 * token level over flat input buckets, this one operates at the
 * *region* level over typed file segments and emits per-sentence
 * citation candidates with confidence.
 *
 * Region taxonomy (chosen because they're cheap to surface from existing
 * extractor outputs — `fileProcessor`, `document-pipeline-registry`,
 * `rag-service`):
 *
 *   • pdf:      page number      → "p.4"
 *   • docx:     section / heading → "§ Introduction"
 *   • xlsx:     sheet + cell range → "Sheet1!A1:C12"
 *   • code:     file path + line range → "src/auth.js:42-50"
 *   • md/text:  byte offset      → "L40-58"
 *
 * Algorithm:
 *   1. Split the response into sentences (cheap regex; handles ES/EN).
 *   2. For each sentence, score it against every region by Jaccard
 *      similarity on stop-word-stripped tokens + a quoted-phrase bonus
 *      when long verbatim substrings (≥ 8 chars) appear in the region.
 *   3. Keep only sentences whose top region passes a threshold
 *      (default 0.20 Jaccard or any quoted-phrase hit).
 *   4. Emit a structured Citation[] plus a textual prompt block that
 *      lists "[sentence] ← [file region]" pairs.
 *
 * Pure JS, no I/O. Hot path < 50 ms for ~30 sentences × 50 regions.
 *
 * Public API:
 *   attribute({ regions, response, opts? })   → AttributionReport
 *   buildCitationBlock(report, opts?)         → string (prompt block)
 *   sentenceSplit(text)                       → string[]
 *
 * Inputs:
 *   regions: { id, fileId, fileName, label, kind, text, location }[]
 *     where location is a small JSON describing the region origin
 *     (page, sheet+range, line span, byte span).
 *   response: string
 *
 * Output:
 *   {
 *     citations: [
 *       {
 *         sentence: string,
 *         sentenceIdx: number,
 *         region: { id, fileId, fileName, label, kind, location },
 *         score: number,           // [0, 1]
 *         confidence: 'high' | 'medium' | 'low',
 *         matchedPhrase?: string,  // verbatim substring trigger when any
 *       }, …
 *     ],
 *     coverage: number,            // sentences with ≥ 1 citation / total
 *     unsupported: number,         // sentences with no citation above threshold
 *     stats: { sentences, regions, durationMs }
 *   }
 */

const STOP = new Set([
  'a','an','the','of','to','in','for','on','with','and','or','that','this','it','is',
  'are','was','were','as','at','by','from','de','la','el','los','las','un','una','y',
  'o','que','en','para','por','con','sin','sobre','del','al','mi','tu','su','sus','me',
  'te','se','lo','le','sea','sean','si','no','pero',
]);

const TOKEN_RE = /[a-záéíóúñü0-9_-]+/giu;
const SENTENCE_RE = /[^.!?¡¿\n]+[.!?¡¿]?|\S+$/g;

const PHRASE_MIN_LEN = 8;
const DEFAULT_THRESHOLD = 0.20;
const HIGH_CONFIDENCE = 0.55;
const MEDIUM_CONFIDENCE = 0.30;

function tokenize(text) {
  if (!text) return [];
  const out = [];
  const matches = String(text).toLowerCase().match(TOKEN_RE);
  if (!matches) return out;
  for (const t of matches) {
    if (t.length < 2 || STOP.has(t)) continue;
    out.push(t);
  }
  return out;
}

const tokenSet = (text) => new Set(tokenize(text));

function jaccard(setA, setB) {
  if (!setA || !setB || setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  const [s, l] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  for (const v of s) if (l.has(v)) inter += 1;
  if (inter === 0) return 0;
  return inter / (setA.size + setB.size - inter);
}

function sentenceSplit(text) {
  if (!text) return [];
  const matches = String(text).match(SENTENCE_RE);
  if (!matches) return [];
  return matches
    .map((s) => s.trim())
    .filter((s) => s.length >= 4);
}

function findVerbatimPhrase(sentence, region) {
  if (!sentence || !region) return null;
  const lowS = sentence.toLowerCase();
  const lowR = region.toLowerCase();
  // try contiguous substrings of decreasing length
  for (let len = Math.min(80, lowS.length); len >= PHRASE_MIN_LEN; len -= 1) {
    for (let i = 0; i <= lowS.length - len; i += Math.max(1, Math.floor(len / 4))) {
      const sub = lowS.slice(i, i + len);
      if (sub.includes(' ') && lowR.includes(sub)) {
        return sentence.slice(i, i + len);
      }
    }
  }
  return null;
}

function classifyConfidence(score) {
  if (score >= HIGH_CONFIDENCE) return 'high';
  if (score >= MEDIUM_CONFIDENCE) return 'medium';
  return 'low';
}

function normalizeRegion(raw, idx) {
  if (!raw) return null;
  const text = String(raw.text || raw.content || raw.snippet || '');
  if (!text || text.length < 8) return null;
  return {
    id: raw.id ? String(raw.id).slice(0, 96) : `region_${idx}`,
    fileId: raw.fileId || raw.file_id || null,
    fileName: raw.fileName || raw.file_name || raw.name || 'attachment',
    label: raw.label || raw.title || raw.section || raw.name || `region_${idx}`,
    kind: String(raw.kind || raw.type || 'text').toLowerCase(),
    text,
    location: raw.location || raw.loc || null,
    tokens: tokenSet(text),
  };
}

function attribute({ regions = [], response = '', opts = {} } = {}) {
  const t0 = Date.now();
  const threshold = Number(opts.threshold) > 0 ? Number(opts.threshold) : DEFAULT_THRESHOLD;
  const maxSentences = Math.max(1, Number(opts.maxSentences) || 64);
  const maxRegions = Math.max(1, Number(opts.maxRegions) || 96);

  const normRegions = (Array.isArray(regions) ? regions : [])
    .slice(0, maxRegions)
    .map(normalizeRegion)
    .filter(Boolean);

  const sentences = sentenceSplit(String(response || '')).slice(0, maxSentences);

  const citations = [];
  let supported = 0;
  let unsupported = 0;

  for (let i = 0; i < sentences.length; i += 1) {
    const sentence = sentences[i];
    const sentenceTokens = tokenSet(sentence);
    let best = { score: 0, region: null, matchedPhrase: null };
    for (const r of normRegions) {
      const lex = jaccard(sentenceTokens, r.tokens);
      const phrase = lex >= 0.10 ? findVerbatimPhrase(sentence, r.text) : null;
      const score = phrase ? Math.max(lex, 0.65) : lex;
      if (score > best.score) {
        best = { score, region: r, matchedPhrase: phrase };
      }
    }
    if (best.score >= threshold && best.region) {
      supported += 1;
      citations.push({
        sentence,
        sentenceIdx: i,
        region: {
          id: best.region.id,
          fileId: best.region.fileId,
          fileName: best.region.fileName,
          label: best.region.label,
          kind: best.region.kind,
          location: best.region.location,
        },
        score: Number(best.score.toFixed(3)),
        confidence: classifyConfidence(best.score),
        matchedPhrase: best.matchedPhrase || undefined,
      });
    } else {
      unsupported += 1;
    }
  }

  return {
    citations,
    coverage: sentences.length === 0 ? 0 : Number((supported / sentences.length).toFixed(3)),
    unsupported,
    supported,
    stats: {
      sentences: sentences.length,
      regions: normRegions.length,
      durationMs: Date.now() - t0,
    },
  };
}

function formatLocation(loc) {
  if (!loc || typeof loc !== 'object') return '';
  if (loc.page) return `p.${loc.page}`;
  if (loc.section) return `§ ${loc.section}`;
  if (loc.sheet) return `${loc.sheet}${loc.range ? `!${loc.range}` : ''}`;
  if (loc.line || loc.lineStart) {
    const start = loc.line || loc.lineStart;
    const end = loc.lineEnd || loc.line;
    return end && end !== start ? `L${start}-${end}` : `L${start}`;
  }
  if (loc.byteStart != null) {
    const end = loc.byteEnd || loc.byteStart;
    return `[${loc.byteStart}-${end}]`;
  }
  return '';
}

function buildCitationBlock(report, opts = {}) {
  if (!report || !Array.isArray(report.citations) || report.citations.length === 0) return '';
  const maxCitations = Number(opts.maxCitations) || 8;
  const lines = ['\n\n<cross_modal_citations>'];
  lines.push(`Cobertura del response: ${Math.round((report.coverage || 0) * 100)}% (${report.supported}/${report.supported + report.unsupported} oraciones citadas).`);
  for (const c of report.citations.slice(0, maxCitations)) {
    const loc = formatLocation(c.region.location);
    const tail = loc ? ` ${loc}` : '';
    const phraseHint = c.matchedPhrase ? ` · phrase="${c.matchedPhrase.slice(0, 40)}"` : '';
    lines.push(`  • "${c.sentence.slice(0, 100)}" ← ${c.region.fileName}${tail} (${c.confidence}, ${c.score})${phraseHint}`);
  }
  if (report.unsupported > 0) {
    lines.push(`(${report.unsupported} oraciones sin cita clara — revisa si requieren respaldo.)`);
  }
  lines.push('</cross_modal_citations>');
  const text = lines.join('\n');
  const max = Number(opts.maxChars) || 1600;
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

module.exports = {
  attribute,
  buildCitationBlock,
  sentenceSplit,
  tokenize,
  jaccard,
  findVerbatimPhrase,
  formatLocation,
  classifyConfidence,
  DEFAULT_THRESHOLD,
  HIGH_CONFIDENCE,
  MEDIUM_CONFIDENCE,
};
