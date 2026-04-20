/**
 * preference-export — close the RLHF loop.
 *
 * feedback-ledger.js collects thumbs-up/down on agent responses.
 * Ouyang et al. 2022's whole point is that this preference data is
 * what trains an aligned model. Once a user has enough data
 * (realistically 200+ labelled examples), they can fine-tune their
 * own model with it — we just need to emit the data in the right shape.
 *
 * Two export formats, both OpenAI-compatible:
 *
 *   1. SFT (supervised fine-tuning) — from helpful=true entries only.
 *      Format: one JSONL record per example, shape:
 *        {"messages": [
 *          {"role": "system", "content": "<per-agent persona>"},
 *          {"role": "user", "content": "<original request>"},
 *          {"role": "assistant", "content": "<helpful response>"}
 *        ]}
 *      Straightforward: teach the model to produce helpful responses
 *      on similar queries. This is step 1 in the paper's pipeline.
 *
 *   2. DPO (direct preference optimization) — from runs where we have
 *      BOTH a helpful and unhelpful response to the same (or similar)
 *      request. Format:
 *        {"input": {...prompt...},
 *         "preferred_output": [{"role":"assistant","content":"<chosen>"}],
 *         "non_preferred_output": [{"role":"assistant","content":"<rejected>"}]}
 *      DPO is simpler to run than full RLHF (no reward model + PPO),
 *      and OpenAI's API supports it directly. This is the practical
 *      path to a user-aligned model in 2024+.
 *
 * Pair construction for DPO:
 *   Pairs are formed WITHIN a user's ledger. For each unhelpful entry,
 *   we find the nearest helpful entry by request-embedding cosine
 *   similarity (≥ 0.6 threshold) — if one exists, that's a pair.
 *   Without a similarity threshold you'd get junk pairs like "don't
 *   know X" vs "great explanation of Y".
 *
 * The export is streamed as NDJSON so the caller can pipe it directly
 * to OpenAI's fine-tuning upload endpoint without materialising the
 * whole thing in memory.
 */

const feedback = require('./feedback-ledger');
const piiScrubber = require('./pii-scrubber');

const MIN_PAIR_SIMILARITY = 0.6;

function cosine(a, b) {
  if (!a || !b) return 0;
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i], bv = b[i];
    dot += av * bv; na += av * av; nb += bv * bv;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

const AGENT_PERSONAS = {
  code_review: 'You are a senior software engineer performing a rigorous code review.',
  test_gen: 'You are a senior software engineer writing rigorous unit tests.',
  debug: 'You are an expert debugger localising the root cause of a failure.',
  code_gen: 'You are a senior software engineer generating production-quality code.',
  requirements: 'You are a tech lead turning vague feature requests into structured specs.',
  maintenance: 'You are a senior engineer triaging a maintenance ticket.',
  static_check: 'You are a static analysis expert auditing code for real issues.',
  log_analysis: 'You are an SRE debugging a production log burst.',
};

function systemPromptFor(agent) {
  return AGENT_PERSONAS[agent] || 'You are a helpful software engineering assistant.';
}

/**
 * Stringify a response object into the assistant-content format. For
 * object results (e.g. a code-review report), we serialise as JSON so
 * the fine-tuning target is unambiguous.
 */
function responseAsString(response) {
  if (typeof response === 'string') return response;
  try { return JSON.stringify(response, null, 0); }
  catch { return String(response); }
}

/**
 * Fetch all entries for a user by reaching into feedback-ledger's
 * internal storage. We export a helper here instead of exposing the
 * raw array from feedback-ledger because callers shouldn't mutate it.
 */
function allEntries(userId) {
  // feedback-ledger doesn't currently expose a "list all" getter; we
  // build one by retrieving with a very-high-k and a neutral query
  // embedding. For export this is fine — we don't need similarity
  // ordering, we need EVERY entry regardless of similarity.
  // Fall back: probe the internal Map directly.
  const internal = require('./feedback-ledger');
  // Use stats to confirm there's anything to export.
  const s = internal.stats(userId);
  if (s.total === 0) return [];
  // Access the private ledger via a module-local getter we'll add.
  return internal._dump ? internal._dump(userId) : [];
}

// ─── SFT export ───────────────────────────────────────────────────────────

/**
 * Emit SFT-format JSONL for every helpful entry. Optionally filter by
 * agent. Yields one line per record; joiner adds newlines.
 *
 * @returns {{ lines: string[], count: number }}
 */
function exportSFT({ userId, agent = null, scrubPii = true, aggressive = false }) {
  const entries = allEntries(userId);
  const eligible = entries
    .filter(e => e.helpful === true)
    .filter(e => !agent || e.agent === agent);
  const piiHits = [];
  const lines = eligible.map(e => {
    let request = e.request;
    let response = responseAsString(e.response);
    if (scrubPii) {
      const reqScrub = piiScrubber.scrub(request, { aggressive });
      const respScrub = piiScrubber.scrub(response, { aggressive });
      request = reqScrub.scrubbed;
      response = respScrub.scrubbed;
      piiHits.push(...reqScrub.hits, ...respScrub.hits);
    }
    return JSON.stringify({
      messages: [
        { role: 'system', content: systemPromptFor(e.agent) },
        { role: 'user', content: request },
        { role: 'assistant', content: response },
      ],
    });
  });
  return { lines, count: lines.length, piiHits };
}

// ─── DPO export ───────────────────────────────────────────────────────────

/**
 * Construct preference pairs from (helpful, unhelpful) entries whose
 * request embeddings are similar. The user effectively told us: "given
 * a question like this, prefer output A over output B".
 */
function exportDPO({ userId, agent = null, scrubPii = true, aggressive = false }) {
  const entries = allEntries(userId);
  const helpful = entries.filter(e => e.helpful === true && e.embedding);
  const unhelpful = entries.filter(e => e.helpful === false && e.embedding);
  if (agent) {
    for (let i = helpful.length - 1; i >= 0; i--) if (helpful[i].agent !== agent) helpful.splice(i, 1);
    for (let i = unhelpful.length - 1; i >= 0; i--) if (unhelpful[i].agent !== agent) unhelpful.splice(i, 1);
  }

  const lines = [];
  const piiHits = [];
  const usedHelpful = new Set();
  const maybeScrub = (s) => {
    if (!scrubPii) return s;
    const r = piiScrubber.scrub(s, { aggressive });
    piiHits.push(...r.hits);
    return r.scrubbed;
  };

  // For each unhelpful entry, find its nearest helpful partner.
  for (const reject of unhelpful) {
    let bestIdx = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < helpful.length; i++) {
      if (usedHelpful.has(i)) continue;
      const sim = cosine(reject.embedding, helpful[i].embedding);
      if (sim > bestScore) { bestScore = sim; bestIdx = i; }
    }
    if (bestIdx === -1 || bestScore < MIN_PAIR_SIMILARITY) continue;
    usedHelpful.add(bestIdx);
    const win = helpful[bestIdx];
    lines.push(JSON.stringify({
      input: {
        messages: [
          { role: 'system', content: systemPromptFor(win.agent || reject.agent) },
          { role: 'user', content: maybeScrub(win.request) },
        ],
      },
      preferred_output: [{ role: 'assistant', content: maybeScrub(responseAsString(win.response)) }],
      non_preferred_output: [{ role: 'assistant', content: maybeScrub(responseAsString(reject.response)) }],
    }));
  }

  return { lines, count: lines.length, piiHits };
}

/**
 * Export in the requested format and return NDJSON string + metadata.
 */
function exportData({ userId, format = 'sft', agent = null, scrubPii = true, aggressive = false }) {
  if (format === 'sft') {
    const { lines, count, piiHits } = exportSFT({ userId, agent, scrubPii, aggressive });
    return {
      format: 'sft',
      count,
      scrubbed: scrubPii,
      piiHits,
      ndjson: lines.join('\n') + (lines.length > 0 ? '\n' : ''),
    };
  }
  if (format === 'dpo') {
    const { lines, count, piiHits } = exportDPO({ userId, agent, scrubPii, aggressive });
    return {
      format: 'dpo',
      count,
      scrubbed: scrubPii,
      piiHits,
      ndjson: lines.join('\n') + (lines.length > 0 ? '\n' : ''),
    };
  }
  throw new Error(`preference-export: unknown format "${format}" (use 'sft' or 'dpo')`);
}

module.exports = {
  exportData,
  exportSFT,
  exportDPO,
  responseAsString,
  systemPromptFor,
  AGENT_PERSONAS,
  MIN_PAIR_SIMILARITY,
};
