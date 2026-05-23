/**
 * self-rag-engine — faithful implementation of Algorithm 1 from
 * Asai et al. 2024 "Self-RAG: Learning to Retrieve, Generate, and
 * Critique through Self-Reflection" (ICLR 2024, arXiv:2310.11511).
 *
 * Difference vs. the simpler `selfRag` in advanced-patterns.js:
 *   - That one is ONE-SHOT: retrieve once, filter, generate one answer.
 *   - This one is SEGMENT-LEVEL: at each step decides retrieve/skip,
 *     generates K parallel candidates (one per retrieved passage),
 *     and picks the winner via the paper's weighted reflection-token
 *     score S(Critique) (Eq. 3-4).
 *
 * Four reflection tokens (Table 1):
 *   - Retrieve ∈ {yes, no, continue}
 *   - ISREL  ∈ {relevant, irrelevant}
 *   - ISSUP  ∈ {fully_supported, partially_supported, no_support}
 *   - ISUSE  ∈ {5, 4, 3, 2, 1}  (higher is better)
 *
 * Segment score (paper Eq. 3-4 with normalised probability proxy):
 *   f(y_t, d) = p(y_t | x, d, y<t) + S(Critique)
 *   S = w_rel * s_rel + w_sup * s_sup + w_use * s_use
 *
 * We don't have token-level logprobs over a trained reflection vocab
 * (the paper's version fine-tunes an LM with the reflection tokens
 * added). We approximate by asking the LLM for explicit reflection
 * labels per candidate, mapping them to normalised scores. That
 * matches the paper's API (same labels, same weights) while running
 * on an off-the-shelf LLM.
 *
 * Inference-time hyperparameters exposed to the caller:
 *   - weights   : { wRel, wSup, wUse } — bias between relevance,
 *                  support, and utility
 *   - hardConstraints : drop candidates with ISSUP=no_support (§3.3)
 *   - retrieveMode   : 'adaptive' (paper), 'always', or 'never'
 *   - maxSegments    : safety cap on the generation loop
 */

// ─── Reflection-token value spaces ───────────────────────────────────────

const RETRIEVE_VALUES = ['yes', 'no', 'continue'];
const ISREL_VALUES    = ['relevant', 'irrelevant'];
const ISSUP_VALUES    = ['fully_supported', 'partially_supported', 'no_support'];
const ISUSE_VALUES    = [5, 4, 3, 2, 1];

// Map a raw label onto its normalised score (paper's s_G_t proxy).
// The mapping is ordinal: the most-desirable label gets 1.0, others
// degrade proportionally.
const ISREL_SCORE = {
  relevant: 1.0,
  irrelevant: 0.0,
};
const ISSUP_SCORE = {
  fully_supported: 1.0,
  partially_supported: 0.5,
  no_support: 0.0,
};
const ISUSE_SCORE = {
  5: 1.0, 4: 0.75, 3: 0.5, 2: 0.25, 1: 0.0,
};

const DEFAULT_WEIGHTS = { wRel: 1.0, wSup: 1.0, wUse: 0.5 };

// ─── LLM bridges ─────────────────────────────────────────────────────────

function parseJSON(text) {
  if (typeof text !== 'string') return {};
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(cleaned); } catch { return {}; }
}

async function callJSON({ openai, model = 'gpt-4o-mini', system, user, temperature = 0, maxTokens = 400 }) {
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

// ─── Token 1: Retrieve gate (x, y<t) → {yes, no, continue} ──────────────

const RETRIEVE_GATE_SYSTEM = `You emit the "Retrieve" reflection token for Self-RAG. Given a user input and any answer text already generated, decide whether retrieving additional passages would HELP produce the NEXT segment.

Output format — STRICT JSON:
{
  "retrieve": "yes" | "no" | "continue",
  "confidence": <0..1 — probability that retrieving would HELP>,
  "reason": "<one sentence>"
}

Use:
- "yes"      — the next segment needs a specific fact that retrieval could supply.
- "no"       — the next segment can be produced safely from general knowledge or reasoning alone.
- "continue" — the current context still has the relevant passages loaded; reuse them (don't re-retrieve).
- confidence should be close to 1.0 when retrieval is clearly needed and close to 0.0 when clearly not.`;

/**
 * predictRetrieve returns both the categorical token and a probability.
 * Paper §3.3 ("Adaptive retrieval with threshold") lets callers pass
 * `retrieveThreshold` so retrieval fires only when P(retrieve=yes) >
 * threshold — flexible tradeoff between recall and latency.
 */
async function predictRetrieve({ openai, model, input, partial, context, retrieveThreshold }) {
  const out = await callJSON({
    openai, model,
    system: RETRIEVE_GATE_SYSTEM,
    user: [
      `USER INPUT:\n${input}`,
      `ANSWER SO FAR:\n${partial || '(none)'}`,
      `CURRENT CONTEXT:\n${context.length ? context.slice(0, 3).map((p, i) => `[${i + 1}] ${(p.text || '').slice(0, 200)}`).join('\n') : '(none)'}`,
    ].join('\n\n'),
    maxTokens: 150,
  });
  const raw = typeof out.retrieve === 'string' ? out.retrieve.toLowerCase() : '';
  let retrieve = RETRIEVE_VALUES.includes(raw) ? raw : 'no';
  const confidence = typeof out.confidence === 'number'
    ? Math.max(0, Math.min(1, out.confidence))
    : (retrieve === 'yes' ? 0.8 : retrieve === 'no' ? 0.2 : 0.5);
  // Threshold override (paper §3.3). When caller sets retrieveThreshold,
  // the binary decision is derived from confidence, overriding the
  // LLM's own categorical vote — useful when you want stricter
  // factuality (lower threshold → retrieve more often) or lower
  // latency (higher threshold → retrieve less).
  if (typeof retrieveThreshold === 'number') {
    if (confidence >= retrieveThreshold && retrieve !== 'continue') retrieve = 'yes';
    else if (confidence < retrieveThreshold && retrieve !== 'continue') retrieve = 'no';
  }
  return {
    retrieve,
    confidence,
    reason: typeof out.reason === 'string' ? out.reason.slice(0, 200) : '',
  };
}

// ─── Per-passage: ISREL + generate segment + ISSUP + ISUSE ───────────────

const CANDIDATE_SYSTEM = `You are generating the NEXT segment of an answer using Self-RAG with one specific retrieved passage. Return both the segment and the three reflection tokens the paper defines.

Output format — STRICT JSON:
{
  "isRel": "relevant" | "irrelevant",
  "segment": "<one sentence continuation of the answer using ONLY this passage's information>",
  "isSup": "fully_supported" | "partially_supported" | "no_support",
  "isUse": 1 | 2 | 3 | 4 | 5,
  "reason": "<one sentence>"
}

Rules:
- Set isRel=irrelevant when the passage does not address the question; in that case "segment" may be empty and isSup=no_support.
- segment must be ONE sentence, ≤ 40 words, that extends the prior answer naturally.
- isSup rates whether every claim in your segment is directly supported by the passage (fully), partially true but adds unsupported detail (partially_supported), or not supported (no_support).
- isUse 1-5 is the perceived usefulness of the segment as part of an answer to the question.
- Do NOT invent facts not present in the passage. If you must speculate, mark isSup=no_support.`;

async function generateCandidateFromPassage({ openai, model, input, partial, passage }) {
  const out = await callJSON({
    openai, model,
    system: CANDIDATE_SYSTEM,
    user: [
      `USER INPUT:\n${input}`,
      `ANSWER SO FAR:\n${partial || '(none)'}`,
      `RETRIEVED PASSAGE:\n${(passage.text || '').slice(0, 2000)}`,
    ].join('\n\n'),
    maxTokens: 350,
  });
  const isRel = ISREL_VALUES.includes(out.isRel) ? out.isRel : 'irrelevant';
  const isSup = ISSUP_VALUES.includes(out.isSup) ? out.isSup : 'no_support';
  const isUseRaw = typeof out.isUse === 'number' ? out.isUse : parseInt(out.isUse, 10);
  const isUse = ISUSE_VALUES.includes(isUseRaw) ? isUseRaw : 1;
  return {
    source: passage.source,
    passage,
    segment: typeof out.segment === 'string' ? out.segment.trim() : '',
    isRel, isSup, isUse,
    reason: typeof out.reason === 'string' ? out.reason.slice(0, 300) : '',
  };
}

// ─── No-retrieval branch: generate segment + ISUSE only ──────────────────

const NO_RETRIEVE_SYSTEM = `You are generating the NEXT segment of an answer using Self-RAG WITHOUT retrieval. The LM decided it can answer this step from general knowledge alone.

Output format — STRICT JSON:
{
  "segment": "<one sentence continuation>",
  "isUse": 1 | 2 | 3 | 4 | 5,
  "done": <bool — true if the answer is now complete>,
  "reason": "<one sentence>"
}

Rules:
- One sentence, ≤ 40 words.
- Set done=true if the answer is complete. Otherwise false (another segment will follow).
- isUse 1-5 is your self-assessment of how useful this segment is toward answering the question.`;

async function generateNoRetrieve({ openai, model, input, partial }) {
  const out = await callJSON({
    openai, model,
    system: NO_RETRIEVE_SYSTEM,
    user: [
      `USER INPUT:\n${input}`,
      `ANSWER SO FAR:\n${partial || '(none)'}`,
    ].join('\n\n'),
    maxTokens: 250,
  });
  const isUseRaw = typeof out.isUse === 'number' ? out.isUse : parseInt(out.isUse, 10);
  const isUse = ISUSE_VALUES.includes(isUseRaw) ? isUseRaw : 3;
  return {
    source: null,
    passage: null,
    segment: typeof out.segment === 'string' ? out.segment.trim() : '',
    isRel: null,
    isSup: null,
    isUse,
    done: out.done === true,
    reason: typeof out.reason === 'string' ? out.reason.slice(0, 300) : '',
  };
}

// ─── Segment scoring (paper Eq. 3-4) ─────────────────────────────────────

/**
 * Compute S(Critique) for a single candidate. When a reflection token
 * isn't applicable (e.g. ISREL for the no-retrieve branch) we treat
 * its weighted contribution as zero.
 */
function critiqueScore(candidate, weights = DEFAULT_WEIGHTS) {
  const { wRel = 1.0, wSup = 1.0, wUse = 0.5 } = weights;
  const sRel = candidate.isRel ? (ISREL_SCORE[candidate.isRel] ?? 0) : 0;
  const sSup = candidate.isSup ? (ISSUP_SCORE[candidate.isSup] ?? 0) : 0;
  const sUse = candidate.isUse != null ? (ISUSE_SCORE[candidate.isUse] ?? 0) : 0;
  return (candidate.isRel ? wRel * sRel : 0)
       + (candidate.isSup ? wSup * sSup : 0)
       + (candidate.isUse != null ? wUse * sUse : 0);
}

/**
 * Pick the best segment candidate for one timestep.
 *
 * @param {Array} candidates  — per-passage candidates from generateCandidateFromPassage
 * @param {object} [weights]
 * @param {boolean} [hardConstraints=false] — if true, drop ISSUP=no_support
 * @returns {{ best: object|null, ranked: Array<{candidate, score}>, filtered: Array }}
 */
function rankCandidates(candidates, { weights, hardConstraints = false } = {}) {
  const filtered = [];
  const allowed = [];
  for (const c of candidates) {
    if (!c || typeof c.segment !== 'string' || c.segment.length === 0) {
      filtered.push({ candidate: c, reason: 'empty segment' });
      continue;
    }
    if (hardConstraints && c.isSup === 'no_support') {
      filtered.push({ candidate: c, reason: 'hard-constraint: ISSUP=no_support' });
      continue;
    }
    if (c.isRel === 'irrelevant' && hardConstraints) {
      filtered.push({ candidate: c, reason: 'hard-constraint: ISREL=irrelevant' });
      continue;
    }
    allowed.push(c);
  }
  const ranked = allowed
    .map(c => ({ candidate: c, score: critiqueScore(c, weights) }))
    .sort((a, b) => b.score - a.score);
  return { best: ranked[0]?.candidate || null, ranked, filtered };
}

// ─── Main inference loop (Algorithm 1) ───────────────────────────────────

/**
 * Run Self-RAG inference.
 *
 * @param {object} args
 * @param {object} args.openai
 * @param {string} args.input               — the user's prompt
 * @param {(query:string, k:number) => Promise<Array>} args.retrieve
 * @param {number} [args.k=4]               — passages per retrieve call
 * @param {string} [args.model='gpt-4o-mini']
 * @param {object} [args.weights]           — { wRel, wSup, wUse }
 * @param {'adaptive'|'always'|'never'} [args.retrieveMode='adaptive']
 * @param {boolean} [args.hardConstraints=false]
 * @param {number} [args.maxSegments=6]
 *
 * @returns {Promise<{
 *   answer: string,
 *   segments: Array<{ index, text, source, isRel, isSup, isUse, score, retrieveDecision, alternatives }>,
 *   passagesSeen: Array,
 *   terminatedBy: 'done'|'max-segments',
 * }>}
 */
async function infer({
  openai,
  input,
  retrieve,
  k = 4,
  model = 'gpt-4o-mini',
  weights = DEFAULT_WEIGHTS,
  retrieveMode = 'adaptive',
  retrieveThreshold,       // optional [0..1] — see predictRetrieve
  hardConstraints = false,
  maxSegments = 6,
  beamSize = 1,            // 1 = greedy (paper's default mode), >1 = tree-decoding beam search
}) {
  if (!openai) throw new Error('self-rag-engine: openai required');
  if (typeof retrieve !== 'function') throw new Error('self-rag-engine: retrieve(fn) required');

  const segments = [];
  let passagesSeen = [];
  let partial = '';
  let terminatedBy = 'max-segments';

  for (let step = 0; step < maxSegments; step++) {
    // Step 1 — Retrieve decision.
    let retrieveToken;
    if (retrieveMode === 'always') {
      retrieveToken = { retrieve: 'yes', confidence: 1.0, reason: 'forced by retrieveMode=always' };
    } else if (retrieveMode === 'never') {
      retrieveToken = { retrieve: 'no', confidence: 0.0, reason: 'forced by retrieveMode=never' };
    } else {
      retrieveToken = await predictRetrieve({
        openai, model, input, partial, context: passagesSeen,
        retrieveThreshold,
      });
    }

    let segmentRecord;
    if (retrieveToken.retrieve === 'no') {
      const cand = await generateNoRetrieve({ openai, model, input, partial });
      const score = critiqueScore(cand, weights);
      segmentRecord = {
        index: step,
        text: cand.segment,
        source: null,
        isRel: null,
        isSup: null,
        isUse: cand.isUse,
        score,
        retrieveDecision: retrieveToken.retrieve,
        retrieveReason: retrieveToken.reason,
        alternatives: [],
        reason: cand.reason,
      };
      segments.push(segmentRecord);
      if (cand.segment) partial = (partial ? partial + ' ' : '') + cand.segment;
      if (cand.done) {
        terminatedBy = 'done';
        break;
      }
      continue;
    }

    // Step 2 — Retrieve (unless "continue", which reuses passagesSeen).
    if (retrieveToken.retrieve === 'yes') {
      const hits = await retrieve(partial ? `${input}\n${partial}` : input, k);
      passagesSeen = [...passagesSeen, ...hits];
    }
    const poolForThisStep = retrieveToken.retrieve === 'yes'
      ? passagesSeen.slice(-k)          // just the fresh batch
      : passagesSeen.slice(0, k);       // reuse earliest top-K

    if (poolForThisStep.length === 0) {
      // Fell through to retrieve-mode=yes but got nothing back. Fall
      // back to the no-retrieve branch so we still advance.
      const cand = await generateNoRetrieve({ openai, model, input, partial });
      segmentRecord = {
        index: step,
        text: cand.segment,
        source: null,
        isRel: null, isSup: null,
        isUse: cand.isUse,
        score: critiqueScore(cand, weights),
        retrieveDecision: 'yes-empty',
        retrieveReason: 'retriever returned no hits; fell back to no-retrieve',
        alternatives: [],
      };
      segments.push(segmentRecord);
      if (cand.segment) partial = (partial ? partial + ' ' : '') + cand.segment;
      if (cand.done) { terminatedBy = 'done'; break; }
      continue;
    }

    // Step 3 — Parallel per-passage candidate generation.
    const candidates = await Promise.all(
      poolForThisStep.map(p => generateCandidateFromPassage({
        openai, model, input, partial, passage: p,
      })),
    );

    // Step 4 — Rank by weighted S(Critique); apply hard constraints.
    const ranking = rankCandidates(candidates, { weights, hardConstraints });
    const best = ranking.best;

    if (!best) {
      // All candidates filtered (no_support / empty). Fall back to a
      // short abstention segment and continue.
      segmentRecord = {
        index: step,
        text: '',
        source: null,
        isRel: null, isSup: null, isUse: 1,
        score: 0,
        retrieveDecision: retrieveToken.retrieve,
        retrieveReason: retrieveToken.reason,
        alternatives: ranking.ranked.map(({ candidate, score }) => ({
          source: candidate?.source,
          isRel: candidate?.isRel,
          isSup: candidate?.isSup,
          isUse: candidate?.isUse,
          score,
        })),
        reason: 'all candidates filtered by hard constraints or were empty',
      };
      segments.push(segmentRecord);
      // Without movement, abort rather than loop forever.
      terminatedBy = 'done';
      break;
    }

    const bestScore = ranking.ranked[0].score;
    segmentRecord = {
      index: step,
      text: best.segment,
      source: best.source,
      isRel: best.isRel,
      isSup: best.isSup,
      isUse: best.isUse,
      score: bestScore,
      retrieveDecision: retrieveToken.retrieve,
      retrieveReason: retrieveToken.reason,
      alternatives: ranking.ranked.slice(1).map(({ candidate, score }) => ({
        source: candidate.source,
        isRel: candidate.isRel,
        isSup: candidate.isSup,
        isUse: candidate.isUse,
        score,
      })),
      filteredCount: ranking.filtered.length,
    };
    segments.push(segmentRecord);
    partial = (partial ? partial + ' ' : '') + best.segment;

    // Completion heuristic: if the ISUSE drops AND the last segment
    // reads like a concluding statement, stop.
    if (best.isUse <= 2 && /[.!?]$/.test(best.segment)) {
      terminatedBy = 'done';
      break;
    }
  }

  const answer = segments.map(s => s.text).filter(Boolean).join(' ');
  return {
    answer,
    segments,
    passagesSeen,
    terminatedBy,
    weights,
    hardConstraints,
    retrieveMode,
  };
}

// ─── Tree-decoding beam search (paper §3.3) ─────────────────────────────

/**
 * Keep top-B hypothesis sequences alive. At each step, for each alive
 * hypothesis:
 *   - Decide Retrieve (adaptive | always | never | threshold)
 *   - Generate K per-passage candidates OR a single no-retrieve cand
 *   - Score each via critiqueScore, append to the hypothesis to form
 *     a new beam entry, accumulate the score
 * Then prune globally to top-B by cumulative score.
 *
 * When beamSize=1 this reduces to greedy `infer`. When beamSize>1 the
 * search actually explores divergent continuations. Useful when one
 * passage is great for the first half of the answer but another is
 * needed for the second half — greedy-top-1 would lock in the first
 * choice prematurely.
 *
 * Caller gets the highest-score final hypothesis AS the answer, plus
 * the full beam trace for audit.
 */
async function inferBeam({
  openai,
  input,
  retrieve,
  k = 4,
  model = 'gpt-4o-mini',
  weights = DEFAULT_WEIGHTS,
  retrieveMode = 'adaptive',
  retrieveThreshold,
  hardConstraints = false,
  maxSegments = 6,
  beamSize = 3,
}) {
  if (!openai) throw new Error('self-rag-engine: openai required');
  if (typeof retrieve !== 'function') throw new Error('self-rag-engine: retrieve(fn) required');
  if (beamSize < 1) beamSize = 1;

  // A "hypothesis" is one partial answer + its segments + a running score.
  let beams = [{
    partial: '',
    segments: [],
    passagesSeen: [],
    cumulativeScore: 0,
    finished: false,
  }];

  for (let step = 0; step < maxSegments; step++) {
    const expansions = [];
    for (const beam of beams) {
      if (beam.finished) {
        expansions.push(beam);
        continue;
      }

      let retrieveToken;
      if (retrieveMode === 'always') {
        retrieveToken = { retrieve: 'yes', confidence: 1.0, reason: 'forced' };
      } else if (retrieveMode === 'never') {
        retrieveToken = { retrieve: 'no', confidence: 0.0, reason: 'forced' };
      } else {
        retrieveToken = await predictRetrieve({
          openai, model, input, partial: beam.partial, context: beam.passagesSeen,
          retrieveThreshold,
        });
      }

      if (retrieveToken.retrieve === 'no') {
        const cand = await generateNoRetrieve({ openai, model, input, partial: beam.partial });
        const score = critiqueScore(cand, weights);
        const segmentRecord = {
          index: step,
          text: cand.segment,
          source: null,
          isRel: null, isSup: null,
          isUse: cand.isUse,
          score,
          retrieveDecision: retrieveToken.retrieve,
          retrieveConfidence: retrieveToken.confidence,
        };
        expansions.push({
          partial: cand.segment ? (beam.partial ? beam.partial + ' ' + cand.segment : cand.segment) : beam.partial,
          segments: [...beam.segments, segmentRecord],
          passagesSeen: beam.passagesSeen,
          cumulativeScore: beam.cumulativeScore + score,
          finished: cand.done,
        });
        continue;
      }

      // retrieve=yes: pull K passages (or reuse on "continue").
      let passagesSeen = beam.passagesSeen;
      if (retrieveToken.retrieve === 'yes') {
        const hits = await retrieve(
          beam.partial ? `${input}\n${beam.partial}` : input, k,
        );
        passagesSeen = [...beam.passagesSeen, ...hits];
      }
      const pool = retrieveToken.retrieve === 'yes'
        ? passagesSeen.slice(-k)
        : passagesSeen.slice(0, k);

      if (pool.length === 0) {
        // No hits → fall back to no-retrieve for this beam this step.
        const cand = await generateNoRetrieve({ openai, model, input, partial: beam.partial });
        const score = critiqueScore(cand, weights);
        expansions.push({
          partial: cand.segment ? (beam.partial ? beam.partial + ' ' + cand.segment : cand.segment) : beam.partial,
          segments: [...beam.segments, {
            index: step, text: cand.segment, source: null,
            isRel: null, isSup: null, isUse: cand.isUse, score,
            retrieveDecision: 'yes-empty', retrieveConfidence: retrieveToken.confidence,
          }],
          passagesSeen,
          cumulativeScore: beam.cumulativeScore + score,
          finished: cand.done,
        });
        continue;
      }

      const cands = await Promise.all(
        pool.map(p => generateCandidateFromPassage({ openai, model, input, partial: beam.partial, passage: p })),
      );
      const { ranked, filtered } = rankCandidates(cands, { weights, hardConstraints });
      // Take the top-beamSize expansions from THIS beam (each becomes a
      // separate hypothesis). Global prune happens once all beams
      // have expanded.
      const survivors = ranked.slice(0, beamSize);
      if (survivors.length === 0) {
        // All filtered — this beam is dead.
        expansions.push({
          ...beam,
          finished: true,
          segments: [...beam.segments, {
            index: step, text: '', source: null,
            isRel: null, isSup: null, isUse: 1, score: 0,
            retrieveDecision: retrieveToken.retrieve,
            retrieveConfidence: retrieveToken.confidence,
            reason: `all ${filtered.length} candidates filtered`,
          }],
        });
        continue;
      }
      for (const { candidate, score } of survivors) {
        expansions.push({
          partial: beam.partial ? beam.partial + ' ' + candidate.segment : candidate.segment,
          segments: [...beam.segments, {
            index: step,
            text: candidate.segment,
            source: candidate.source,
            isRel: candidate.isRel,
            isSup: candidate.isSup,
            isUse: candidate.isUse,
            score,
            retrieveDecision: retrieveToken.retrieve,
            retrieveConfidence: retrieveToken.confidence,
          }],
          passagesSeen,
          cumulativeScore: beam.cumulativeScore + score,
          finished: candidate.isUse <= 2 && /[.!?]$/.test(candidate.segment),
        });
      }
    }
    // Global prune to top-beamSize by cumulative score.
    expansions.sort((a, b) => b.cumulativeScore - a.cumulativeScore);
    beams = expansions.slice(0, beamSize);
    if (beams.every(b => b.finished)) break;
  }

  // Return the highest-cumulative-score beam.
  beams.sort((a, b) => b.cumulativeScore - a.cumulativeScore);
  const winner = beams[0];
  return {
    answer: winner.partial,
    segments: winner.segments,
    passagesSeen: winner.passagesSeen,
    cumulativeScore: winner.cumulativeScore,
    alternatives: beams.slice(1).map(b => ({
      answer: b.partial,
      cumulativeScore: b.cumulativeScore,
      segmentCount: b.segments.length,
    })),
    beamSize,
    terminatedBy: winner.finished ? 'done' : 'max-segments',
  };
}

module.exports = {
  infer,
  inferBeam,
  predictRetrieve,
  generateCandidateFromPassage,
  generateNoRetrieve,
  critiqueScore,
  rankCandidates,
  DEFAULT_WEIGHTS,
  ISREL_SCORE, ISSUP_SCORE, ISUSE_SCORE,
  RETRIEVE_VALUES, ISREL_VALUES, ISSUP_VALUES, ISUSE_VALUES,
  RETRIEVE_GATE_SYSTEM,
  CANDIDATE_SYSTEM,
  NO_RETRIEVE_SYSTEM,
};
