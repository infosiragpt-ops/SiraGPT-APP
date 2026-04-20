/**
 * feedback-ledger — RLHF-lite via retrieval.
 *
 * InstructGPT's reward model learns from human rankings of outputs. We
 * can't train an RM, but we can capture the SIGNAL — user thumbs-up/
 * thumbs-down on past responses — and use it at inference time to:
 *   1. steer future similar queries with a few-shot "helpful example"
 *      block,
 *   2. warn when a new response looks similar to a past down-voted one,
 *   3. surface quality telemetry so ops can see where the model is
 *      consistently failing real users.
 *
 * Storage is in-memory per user. For real multi-instance deploys this
 * belongs in Postgres — the interface is small enough that the switch
 * is a single file. Current shape is good enough for validating the
 * retrieval-steering hypothesis in a single-instance dev/staging box.
 *
 * Schema per entry:
 *   {
 *     runId:    string,        // caller-supplied unique id
 *     userId:   string,
 *     agent:    string,        // which specialist produced this
 *     request:  string,        // the user ask that led to this
 *     response: any,           // the model output
 *     helpful:  boolean,       // up / down
 *     notes:    string,
 *     embedding: Float32Array, // of `request` (for similarity search)
 *     at:       number,
 *   }
 *
 * Retrieval: findExemplars(userId, request, { k, onlyHelpful, embedder })
 *   Returns top-K past entries by cosine similarity of their request
 *   embedding to the new request. When onlyHelpful=true (the usual
 *   case for few-shot steering), filters to helpful=true entries.
 */

const MAX_ENTRIES_PER_USER = 500;

// userId → Array<Entry>
const ledger = new Map();

function nowMs() { return Date.now(); }

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

/**
 * Record a piece of user feedback.
 *
 * @param {object} args
 * @param {string} args.userId
 * @param {string} args.runId
 * @param {string} args.agent
 * @param {string} args.request   — original user ask
 * @param {any}    args.response  — what the agent produced
 * @param {boolean} args.helpful
 * @param {string} [args.notes]
 * @param {function} [args.embedder]  — async (texts[]) => Float32Array[]
 *   Pass the shared rag.embed() here. When null, the entry is stored
 *   without an embedding and later findExemplars calls will skip it.
 */
async function record({ userId, runId, agent, request, response, helpful, notes, embedder }) {
  if (!userId || !runId) throw new Error('feedback-ledger.record: userId and runId required');
  if (typeof helpful !== 'boolean') throw new Error('feedback-ledger.record: helpful must be boolean');

  let embedding = null;
  if (typeof embedder === 'function' && request) {
    try {
      const vectors = await embedder([String(request).slice(0, 4000)]);
      embedding = vectors?.[0] || null;
    } catch (err) {
      // Non-fatal: store without embedding.
      console.warn('[feedback-ledger] embed failed:', err.message);
    }
  }

  const entry = {
    runId,
    userId,
    agent: agent || null,
    request: String(request || '').slice(0, 4000),
    response,
    helpful,
    notes: typeof notes === 'string' ? notes.slice(0, 500) : null,
    embedding,
    at: nowMs(),
  };

  let list = ledger.get(userId);
  if (!list) { list = []; ledger.set(userId, list); }

  // Dedup by runId — the second feedback for the same run replaces the first.
  const existingIdx = list.findIndex(e => e.runId === runId);
  if (existingIdx >= 0) list[existingIdx] = entry;
  else list.push(entry);

  // Oldest-wins eviction keeps the ledger bounded.
  if (list.length > MAX_ENTRIES_PER_USER) {
    list.splice(0, list.length - MAX_ENTRIES_PER_USER);
  }

  return { stored: true, total: list.length };
}

/**
 * Find top-K past feedback entries most similar to the current request.
 *
 * @param {object} args
 * @param {string} args.userId
 * @param {string} args.request  — the new ask
 * @param {function} args.embedder  — async (texts[]) => Float32Array[]
 * @param {number} [args.k=3]
 * @param {boolean} [args.onlyHelpful=true]
 * @param {string} [args.agent]  — filter to entries from the same specialist
 *
 * @returns {Promise<Array<{ runId, request, response, helpful, notes, score }>>}
 *   Sorted descending by similarity.
 */
async function findExemplars({ userId, request, embedder, k = 3, onlyHelpful = true, agent }) {
  const list = ledger.get(userId);
  if (!list || list.length === 0) return [];
  if (!request || typeof embedder !== 'function') return [];

  let queryVec;
  try {
    const vectors = await embedder([String(request).slice(0, 4000)]);
    queryVec = vectors?.[0];
  } catch (err) {
    console.warn('[feedback-ledger] query embed failed:', err.message);
    return [];
  }
  if (!queryVec) return [];

  const pool = list
    .filter(e => e.embedding)
    .filter(e => !onlyHelpful || e.helpful)
    .filter(e => !agent || e.agent === agent);
  if (pool.length === 0) return [];

  const scored = pool.map(e => ({
    runId: e.runId, agent: e.agent, request: e.request, response: e.response,
    helpful: e.helpful, notes: e.notes,
    score: cosine(queryVec, e.embedding),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, k));
}

/**
 * Build a few-shot context string from found exemplars, suitable for
 * prepending to an agent's goal or system prompt.
 */
function formatExemplarsBlock(exemplars) {
  if (!Array.isArray(exemplars) || exemplars.length === 0) return '';
  const lines = ['# EXAMPLES from past sessions the user marked HELPFUL:'];
  exemplars.forEach((e, i) => {
    lines.push(`\n## Example ${i + 1} (agent: ${e.agent || 'unknown'}):`);
    lines.push(`Q: ${e.request}`);
    const out = typeof e.response === 'string' ? e.response : JSON.stringify(e.response);
    lines.push(`A (helpful): ${out.slice(0, 600)}`);
    if (e.notes) lines.push(`User notes: ${e.notes}`);
  });
  return lines.join('\n');
}

/** Diagnostic: how many entries per user. */
function stats(userId) {
  const list = ledger.get(userId);
  if (!list) return { total: 0, helpful: 0, unhelpful: 0 };
  return {
    total: list.length,
    helpful: list.filter(e => e.helpful).length,
    unhelpful: list.filter(e => !e.helpful).length,
  };
}

function clearUser(userId) { ledger.delete(userId); }
function _reset() { ledger.clear(); }

/**
 * Return a shallow copy of every entry for this user. Used by the
 * preference-export module to iterate the whole ledger for JSONL
 * export. We deliberately copy so callers can't mutate internal state,
 * but we share the embedding Float32Array (it's read-only by convention).
 */
function _dump(userId) {
  const list = ledger.get(userId);
  if (!list) return [];
  return list.map(e => ({ ...e }));
}

module.exports = {
  record,
  findExemplars,
  formatExemplarsBlock,
  stats,
  clearUser,
  _reset,
  _dump,
  MAX_ENTRIES_PER_USER,
};
