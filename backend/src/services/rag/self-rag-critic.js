/**
 * self-rag-critic — standalone critic from Asai et al. 2024 Self-RAG,
 * decoupled from the generation engine.
 *
 * The engine in self-rag-engine.js WRITES the answer while labeling it.
 * This file is a post-hoc critic: you already have an answer (from
 * siraGPT's main chat, from another model, from a human), and you want
 * to know what the reflection tokens WOULD say about it. That gives
 * you:
 *   - ISREL per passage: which of the retrieved passages is actually
 *     addressing the question.
 *   - ISSUP per segment: for each sentence of the answer, is it fully
 *     supported / partially supported / unsupported by the passages.
 *   - ISUSE overall: perceived utility of the whole answer (1-5).
 *   - citation assignments: for each supported segment, which passage
 *     actually grounds it.
 *
 * Uses: (a) A/B quality gate on chat replies, (b) flag hallucinations
 * before shipping long-form generations, (c) regression harness —
 * run the critic on historical answers to detect drift.
 *
 * This is STILL a paper-faithful ISxx taxonomy — same token values,
 * same ordinal scoring — so critiques from engine and critic are
 * directly comparable.
 */

const sre = require('./self-rag-engine');

const ISSUP_VALUES = sre.ISSUP_VALUES;      // {fully_supported, partially_supported, no_support}
const ISREL_VALUES = sre.ISREL_VALUES;      // {relevant, irrelevant}
const ISUSE_VALUES = sre.ISUSE_VALUES;      // {5..1}
const critiqueScore = sre.critiqueScore;    // paper Eq. 3-4

// ─── JSON helpers ────────────────────────────────────────────────────────

function parseJSON(text) {
  if (typeof text !== 'string') return {};
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(cleaned); } catch { return {}; }
}

async function callJSON({ openai, model = 'gpt-4o-mini', system, user, temperature = 0, maxTokens = 600 }) {
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

// ─── Split answer into segments (sentences) ──────────────────────────────

const SENT_SPLIT = /(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÑ¿¡"'])/g;

function splitAnswerIntoSegments(answer) {
  if (typeof answer !== 'string') return [];
  const normalised = answer.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
  if (!normalised) return [];
  const sents = normalised.split(SENT_SPLIT).map(s => s.trim()).filter(Boolean);
  return sents.length ? sents : [normalised];
}

// ─── ISREL per-passage pass ──────────────────────────────────────────────

const REL_SYSTEM = `You emit the ISREL reflection token for Self-RAG. Given a question and one passage, decide if the passage provides useful information for answering the question.

Output format — STRICT JSON:
{ "isRel": "relevant" | "irrelevant", "reason": "<one sentence>" }`;

async function rateRelevance({ openai, model, question, passage }) {
  const out = await callJSON({
    openai, model,
    system: REL_SYSTEM,
    user: `QUESTION:\n${String(question).slice(0, 1000)}\n\nPASSAGE:\n${String(passage.text || '').slice(0, 1500)}`,
    maxTokens: 150,
  });
  const isRel = ISREL_VALUES.includes(out.isRel) ? out.isRel : 'irrelevant';
  return { isRel, reason: typeof out.reason === 'string' ? out.reason.slice(0, 200) : '' };
}

// ─── ISSUP per-segment pass + citation assignment ────────────────────────

const SUP_SYSTEM = `You emit the ISSUP reflection token for Self-RAG and assign a citation.

Given a user QUESTION, one SEGMENT of an answer, and a NUMBERED LIST of retrieved passages, decide:
- Which passage (if any) supports the segment — cite by 1-indexed number.
- How strongly the passage supports the specific factual claims in the segment.

Output format — STRICT JSON:
{
  "isSup": "fully_supported" | "partially_supported" | "no_support",
  "cited": <1-indexed passage number, or 0 if none supports>,
  "reason": "<one sentence>"
}

Rules:
- fully_supported: every verification-worthy claim in the segment is stated in the cited passage.
- partially_supported: some claims are supported, others go beyond what the passages actually state.
- no_support: the passages do not support the segment's claims, or the segment is off-topic.
- If multiple passages support the segment, cite the one most directly supporting it.
- A segment that contains NO verification-worthy claims (e.g., an opinion, a hedge like "it depends") is fully_supported with cited=0.`;

async function rateSupport({ openai, model, question, segment, passages }) {
  const ctx = passages.map((p, i) => `[${i + 1}] ${String(p.text || '').slice(0, 1200)}`).join('\n\n');
  const out = await callJSON({
    openai, model,
    system: SUP_SYSTEM,
    user: [
      `QUESTION:\n${String(question).slice(0, 1000)}`,
      `SEGMENT:\n${String(segment).slice(0, 800)}`,
      `PASSAGES:\n${ctx}`,
    ].join('\n\n'),
    maxTokens: 200,
  });
  const isSup = ISSUP_VALUES.includes(out.isSup) ? out.isSup : 'no_support';
  const citedRaw = typeof out.cited === 'number' ? out.cited : parseInt(out.cited, 10);
  const cited = Number.isFinite(citedRaw) && citedRaw >= 0 && citedRaw <= passages.length
    ? citedRaw
    : 0;
  return {
    isSup,
    cited,
    citedSource: cited > 0 ? passages[cited - 1]?.source : null,
    reason: typeof out.reason === 'string' ? out.reason.slice(0, 200) : '',
  };
}

// ─── ISUSE on the whole answer ───────────────────────────────────────────

const USE_SYSTEM = `You emit the ISUSE reflection token for Self-RAG. Given a question and a complete answer, rate perceived utility 1-5 (independent of whether it's factually correct — that's ISSUP's job).

Output format — STRICT JSON:
{ "isUse": 1|2|3|4|5, "reason": "<one sentence>" }

- 5: directly answers the question, complete and coherent.
- 4: answers the question with minor gaps.
- 3: partially answers; notable omissions.
- 2: tangential; addresses the topic but not the question.
- 1: off-topic, empty, or nonsensical.`;

async function rateUtility({ openai, model, question, answer }) {
  const out = await callJSON({
    openai, model,
    system: USE_SYSTEM,
    user: `QUESTION:\n${String(question).slice(0, 1000)}\n\nANSWER:\n${String(answer).slice(0, 4000)}`,
    maxTokens: 120,
  });
  const n = typeof out.isUse === 'number' ? out.isUse : parseInt(out.isUse, 10);
  const isUse = ISUSE_VALUES.includes(n) ? n : 3;
  return { isUse, reason: typeof out.reason === 'string' ? out.reason.slice(0, 200) : '' };
}

// ─── Full critique: orchestrate the 3 axes ───────────────────────────────

/**
 * Critique an (question, answer, passages) triple against the four
 * Self-RAG reflection tokens.
 *
 * @param {object} args
 * @param {object} args.openai
 * @param {string} args.question
 * @param {string} args.answer
 * @param {Array<{source:string, text:string}>} args.passages
 * @param {string} [args.model]
 * @param {object} [args.weights]  — same as engine; used for overallScore
 * @param {boolean} [args.skipPassageRelevance=false] — pass true to
 *   skip the per-passage ISREL pass (saves N LLM calls when you
 *   only care about segment-level support).
 *
 * @returns {Promise<{
 *   perPassage: Array<{ source, isRel, reason }>,
 *   perSegment: Array<{ index, text, isSup, cited, citedSource, reason }>,
 *   overall: { isUse:number, fullySupported:number, partiallySupported:number, unsupported:number, overallScore:number },
 *   citations: Array<{ segmentIndex, citedPassage, citedSource, isSup }>,
 * }>}
 */
async function critique({
  openai,
  question,
  answer,
  passages,
  model = 'gpt-4o-mini',
  weights,
  skipPassageRelevance = false,
}) {
  if (!openai) throw new Error('self-rag-critic: openai required');
  if (typeof question !== 'string' || question.trim().length === 0) {
    throw new Error('self-rag-critic: question required');
  }
  if (typeof answer !== 'string' || answer.trim().length === 0) {
    return {
      perPassage: [],
      perSegment: [],
      overall: { isUse: 1, fullySupported: 0, partiallySupported: 0, unsupported: 0, overallScore: 0 },
      citations: [],
    };
  }
  const cleanPassages = Array.isArray(passages) ? passages.filter(p => p && typeof p.text === 'string') : [];

  // ISREL per passage (parallel)
  const perPassage = skipPassageRelevance
    ? cleanPassages.map(p => ({ source: p.source, isRel: 'relevant', reason: 'skipped' }))
    : await Promise.all(cleanPassages.map(async p => {
        const r = await rateRelevance({ openai, model, question, passage: p });
        return { source: p.source, isRel: r.isRel, reason: r.reason };
      }));

  // ISSUP per segment (sequential so errors on one don't block the batch;
  // we keep it simple — for big answers you'd want Promise.all with
  // backoff, but this is a critic not a real-time path).
  const segments = splitAnswerIntoSegments(answer);
  const perSegment = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const r = await rateSupport({ openai, model, question, segment: seg, passages: cleanPassages });
    perSegment.push({
      index: i,
      text: seg,
      isSup: r.isSup,
      cited: r.cited,
      citedSource: r.citedSource,
      reason: r.reason,
    });
  }

  // ISUSE on the whole answer (once)
  const utility = await rateUtility({ openai, model, question, answer });

  const fullySupported = perSegment.filter(s => s.isSup === 'fully_supported').length;
  const partiallySupported = perSegment.filter(s => s.isSup === 'partially_supported').length;
  const unsupported = perSegment.filter(s => s.isSup === 'no_support').length;

  // Aggregate score: average critiqueScore across segments (relevance
  // uses the majority relevance of its cited passage when available).
  const sumSegmentScores = perSegment.reduce((acc, s) => {
    const citedRel = s.cited > 0 && perPassage[s.cited - 1]
      ? perPassage[s.cited - 1].isRel
      : 'irrelevant';
    return acc + critiqueScore({
      isRel: citedRel,
      isSup: s.isSup,
      isUse: null,  // ISUSE is on the whole answer, not per segment
    }, weights);
  }, 0);
  const perSegmentAvg = perSegment.length ? sumSegmentScores / perSegment.length : 0;
  // Normalise against max possible (wRel + wSup with isRel=relevant, isSup=fully_supported)
  const { wRel = 1.0, wSup = 1.0, wUse = 0.5 } = (weights || {});
  const maxSegmentScore = wRel + wSup;
  const segmentTermNormalised = maxSegmentScore === 0 ? 0 : perSegmentAvg / maxSegmentScore;

  // Utility term
  const utilityScoreNormalised = sre.ISUSE_SCORE[utility.isUse] ?? 0;
  // Final overall: weighted mix of normalised segment-support + utility.
  // Guard the denominator: if a caller zeroes all weights, the division would
  // produce NaN/Infinity and poison every downstream score.
  const overallDenom = (wRel + wSup) + wUse;
  const overallScore = overallDenom === 0
    ? 0
    : ((wRel + wSup) * segmentTermNormalised + wUse * utilityScoreNormalised) / overallDenom;

  const citations = perSegment
    .filter(s => s.cited > 0)
    .map(s => ({
      segmentIndex: s.index,
      citedPassage: s.cited,
      citedSource: s.citedSource,
      isSup: s.isSup,
    }));

  return {
    perPassage,
    perSegment,
    overall: {
      isUse: utility.isUse,
      utilityReason: utility.reason,
      fullySupported,
      partiallySupported,
      unsupported,
      overallScore,
    },
    citations,
  };
}

module.exports = {
  critique,
  splitAnswerIntoSegments,
  rateRelevance,
  rateSupport,
  rateUtility,
  REL_SYSTEM,
  SUP_SYSTEM,
  USE_SYSTEM,
};
