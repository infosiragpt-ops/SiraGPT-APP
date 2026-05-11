/**
 * long-term-memory — cross-session user facts, extracted automatically
 * from completed conversations and recalled into future system prompts.
 *
 * Flow (per chat turn):
 *   1. After each assistant reply, extractFactsAsync(userId, turn) is
 *      fired-and-forgotten. It asks a small LLM to pull out durable
 *      facts from the last user+assistant pair (preferences, personal
 *      details, work context, explicit instructions) and writes them
 *      into the RAG service under the user's private `facts:<userId>`
 *      collection as embedded chunks.
 *   2. Before each new chat turn, recallFacts(userId, userMessage) runs
 *      a quick cosine-similarity retrieval from the same collection and
 *      returns the top-K most relevant facts. The caller prepends those
 *      to the system prompt.
 *
 * Why this design:
 *   - We already have in-memory embeddings (rag-service.js). Reusing it
 *     means NO new DB migration, NO new vector store. When we swap
 *     rag-service to pgvector later, memory rides along for free.
 *   - Facts are low-frequency (one extraction per completed turn) so
 *     the extra LLM call is small even for heavy users.
 *   - Scoped per-user + per-collection so collections can't leak
 *     between users or into the document RAG.
 *
 * Pattern reference: IliaGPT's server/memory/longTermMemory.ts — same
 * intent (extract → embed → recall), simplified for our in-memory store.
 */

const rag = require('./rag-service');
const { mmrRerank } = require('./mmr');

const COLLECTION_PREFIX = 'facts:';
const DEFAULT_RECALL_K = 5;
const MIN_CONFIDENCE = 0.6;
const MAX_FACTS_PER_TURN = 8;

// ─── Active toggle + bounded memory (added 2026-05) ───────────────────────
//
// Two operational guards on top of the existing scoring:
//
//   1. SIRAGPT_MEMORY_DISABLED=1 turns extraction off entirely. Useful
//      for privacy-sensitive deployments and tests that don't want
//      background fire-and-forget side effects polluting state.
//      Recall still returns whatever was previously stored — flipping
//      the flag does not delete history.
//
//   2. SIRAGPT_MEMORY_MAX_FACTS_PER_USER caps per-user factMeta map
//      size. Without it, a long-running user could grow the in-memory
//      map indefinitely (a slow leak). At the cap, upsertFactMeta drops
//      the least-recently-seen fact before adding a new one. This is
//      LRU-by-lastSeen, which biases retention toward facts the user
//      has recently reinforced — exactly what the importance score
//      already values.
//
// Both knobs are env-driven so deploys can tune them per-environment
// without code changes.
const MEMORY_DISABLED = process.env.SIRAGPT_MEMORY_DISABLED === '1';
const MAX_FACTS_PER_USER = Math.max(
  10,
  Number.parseInt(process.env.SIRAGPT_MEMORY_MAX_FACTS_PER_USER, 10) || 1000,
);

// ─── Importance + decay ───────────────────────────────────────────────────────
//
// We layer two per-fact signals on top of plain cosine similarity:
//
//   importance = min(mentionCount / 10, 1)
//     Facts the user has reinforced across turns (same normalised text
//     extracted again) climb toward 1.0. A fact mentioned once caps at 0.1,
//     a fact mentioned ten or more times caps at 1.0.
//
//   decay = exp(-ageDays / HALF_LIFE_DAYS * ln(2))
//     Classic half-life decay: a fact's weight halves every HALF_LIFE_DAYS.
//     Prevents ancient single-mention facts from outranking fresh context.
//
// Final recall score = cosine * (0.6 + 0.2 * importance + 0.2 * decay).
// The 0.6 floor keeps cosine as the dominant signal; importance and decay
// each tilt the ranking by up to 20%.
//
// Pattern reference: Iliagpt.io server/memory/ImportanceScorer.ts + temporalDecay.ts.

const HALF_LIFE_DAYS = 30;
const DECAY_LN2 = Math.log(2);
// Per-user registry keyed by normalised fact text. We track mention
// count + last-seen time so ingestion can upsert and recall can re-weight.
// Swap to Redis or Postgres when rag-service swaps its in-memory store.
const factMeta = new Map(); // userId → Map<normText, { mentions, firstSeen, lastSeen }>

function normalizeFact(text) {
  return (text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function getUserMeta(userId) {
  let m = factMeta.get(userId);
  if (!m) {
    m = new Map();
    factMeta.set(userId, m);
  }
  return m;
}

function upsertFactMeta(userId, factText, capOverride) {
  const norm = normalizeFact(factText);
  if (!norm) return { mentions: 1, ageDays: 0 };
  const meta = getUserMeta(userId);
  const now = Date.now();
  const existing = meta.get(norm);
  if (existing) {
    existing.mentions += 1;
    existing.lastSeen = now;
    return {
      mentions: existing.mentions,
      ageDays: (now - existing.firstSeen) / (1000 * 60 * 60 * 24),
    };
  }
  // Bounded map: when the user is at the cap, evict the
  // least-recently-seen fact before inserting. This is the same LRU
  // signal the importance score already weights against, so eviction
  // tracks what the recall ranker would deprioritise anyway. The
  // optional capOverride lets tests exercise the eviction path
  // without inserting MAX_FACTS_PER_USER (1000 by default) entries.
  const cap = Number.isFinite(capOverride) && capOverride > 0
    ? Math.floor(capOverride)
    : MAX_FACTS_PER_USER;
  if (meta.size >= cap) {
    let oldestKey = null;
    let oldestSeen = Infinity;
    for (const [k, v] of meta) {
      if (v.lastSeen < oldestSeen) {
        oldestSeen = v.lastSeen;
        oldestKey = k;
      }
    }
    if (oldestKey !== null) meta.delete(oldestKey);
  }
  meta.set(norm, { mentions: 1, firstSeen: now, lastSeen: now });
  return { mentions: 1, ageDays: 0 };
}

/**
 * Drop facts that are both stale (lastSeen older than maxAgeDays) and
 * unreinforced (mentions <= minMentions). Returns the number of meta
 * entries pruned. Note: does NOT touch the RAG store — the embedded
 * fact text remains in the user's collection. Pruning meta only
 * removes the importance/decay weighting, which means recall falls
 * back to plain cosine for the affected facts. A future deletion path
 * through `rag.delete()` can hook in here without breaking callers.
 *
 * @param {object} [opts]
 * @param {string} [opts.userId]       prune one user; omit to prune all
 * @param {number} [opts.maxAgeDays=90]
 * @param {number} [opts.minMentions=1]
 */
function pruneFactMeta(opts = {}) {
  const { userId, maxAgeDays = 90, minMentions = 1 } = opts;
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let pruned = 0;
  const userIds = userId ? [userId] : Array.from(factMeta.keys());
  for (const uid of userIds) {
    const meta = factMeta.get(uid);
    if (!meta) continue;
    for (const [k, v] of meta) {
      if (v.lastSeen < cutoff && v.mentions <= minMentions) {
        meta.delete(k);
        pruned += 1;
      }
    }
    if (meta.size === 0) factMeta.delete(uid);
  }
  return pruned;
}

/**
 * Snapshot of a user's in-memory fact metadata. Useful for diagnostics
 * (e.g. an `/admin/memory/:userId` endpoint) and for tests asserting
 * cap/eviction behavior without poking at module internals.
 */
function listFactMeta(userId) {
  const meta = factMeta.get(userId);
  if (!meta) return [];
  const now = Date.now();
  return Array.from(meta, ([norm, v]) => ({
    norm,
    mentions: v.mentions,
    firstSeen: v.firstSeen,
    lastSeen: v.lastSeen,
    ageDays: (now - v.firstSeen) / (1000 * 60 * 60 * 24),
  }));
}

function getFactMeta(userId, factText) {
  const norm = normalizeFact(factText);
  const meta = getUserMeta(userId).get(norm);
  if (!meta) return { mentions: 1, ageDays: 0 };
  return {
    mentions: meta.mentions,
    ageDays: (Date.now() - meta.firstSeen) / (1000 * 60 * 60 * 24),
  };
}

function importanceScore(mentions) {
  return Math.min(mentions / 10, 1);
}

function decayScore(ageDays) {
  return Math.exp(-ageDays / HALF_LIFE_DAYS * DECAY_LN2);
}

const EXTRACTION_SYSTEM_PROMPT = `Extract durable facts about the user from the conversation turn below. Durable = useful across future conversations (preferences, personal/work context, explicit instructions about how the assistant should behave). Skip greetings, acknowledgments, one-off task details, and facts about the assistant.

Return STRICT JSON:
{"facts": [{"fact": "<self-contained statement, one sentence>", "category": "preference|personal|work|knowledge|instruction", "confidence": 0.0-1.0}]}

Rules:
- Each fact must be understandable with zero external context.
- Category is one of: preference, personal, work, knowledge, instruction.
- Confidence reflects how clearly the user stated or implied the fact.
- Return at most ${MAX_FACTS_PER_TURN} facts. Return an empty array when nothing durable came up.
- Write facts in the same language as the conversation.`;

function collectionFor(userId) {
  return `${COLLECTION_PREFIX}${userId || 'anon'}`;
}

/**
 * Build a compact transcript for extraction. Only the latest user +
 * assistant pair is passed — older turns are already covered by prior
 * extractions, so re-reading them wastes tokens and risks re-inserting
 * duplicates.
 */
function buildTurnTranscript(userMessage, assistantMessage) {
  const u = (userMessage || '').toString().slice(0, 4000);
  const a = (assistantMessage || '').toString().slice(0, 4000);
  return `user: ${u}\n\nassistant: ${a}`;
}

/**
 * Invoke the extraction LLM and parse its JSON response. Returns an
 * array of `{ fact, category, confidence }` — empty when the model
 * returned nothing usable.
 */
async function extractFacts(openai, userMessage, assistantMessage) {
  if (!openai) return [];
  const transcript = buildTurnTranscript(userMessage, assistantMessage);
  if (transcript.length < 20) return [];

  try {
    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.1,
      max_tokens: 600,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
        { role: 'user',   content: transcript },
      ],
    });
    const raw = resp.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.facts)) return [];
    return parsed.facts
      .filter(f => f && typeof f.fact === 'string' && f.fact.trim().length > 0)
      .filter(f => typeof f.confidence !== 'number' || f.confidence >= MIN_CONFIDENCE)
      .slice(0, MAX_FACTS_PER_TURN)
      .map(f => ({
        fact: f.fact.trim(),
        category: typeof f.category === 'string' ? f.category : 'knowledge',
        confidence: typeof f.confidence === 'number' ? f.confidence : 0.8,
      }));
  } catch (err) {
    console.warn('[long-term-memory] extraction failed:', err.message);
    return [];
  }
}

/**
 * Fire-and-forget: extract facts from the just-completed turn and
 * store them in the user's facts collection. Errors are swallowed —
 * memory is best-effort, it must NEVER block or fail the main reply
 * path.
 */
function extractFactsAsync({ openai, userId, userMessage, assistantMessage }) {
  if (!userId) return;
  // Privacy/ops guard: SIRAGPT_MEMORY_DISABLED=1 short-circuits the
  // extraction pipeline. We DON'T touch the RAG store here, so any
  // facts already learned for this user remain recallable until a
  // separate clearUserMemory call is made.
  if (MEMORY_DISABLED) return;
  // setImmediate defers to the next tick so the caller returns to the
  // user as fast as possible; the extraction runs afterwards.
  setImmediate(async () => {
    try {
      const facts = await extractFacts(openai, userMessage, assistantMessage);
      if (facts.length === 0) return;
      const docs = facts.map(f => {
        // Upsert importance tracking BEFORE ingesting so the source
        // field carries the current mention count — useful later when
        // we migrate to pgvector and need to seed the table.
        const { mentions } = upsertFactMeta(userId, f.fact);
        return {
          text: f.fact,
          title: f.category,
          source: `mem:${f.confidence.toFixed(2)}:m${mentions}`,
        };
      });
      await rag.ingest(userId, collectionFor(userId), docs, { size: 2000, overlap: 0 });
      console.log(`🧠 long-term-memory: stored ${facts.length} fact(s) for user ${userId}`);
    } catch (err) {
      console.warn('[long-term-memory] store failed:', err.message);
    }
  });
}

/**
 * Retrieve top-K facts most similar to the user's current message.
 * Returns an array of `{ text, category, score }`. Caller decides how
 * to splice these into the system prompt.
 */
async function recallFacts(userId, userMessage, k = DEFAULT_RECALL_K, opts = {}) {
  if (!userId || !userMessage) return [];
  const { useDiversity = true, overfetch = k * 3 } = opts;
  try {
    // Overfetch, then re-weight with importance + decay, then optionally
    // MMR for diversity so we don't return 5 near-duplicate facts.
    const raw = await rag.retrieve(userId, collectionFor(userId), userMessage, overfetch);
    const weighted = raw.map(h => {
      const { mentions, ageDays } = getFactMeta(userId, h.text);
      const imp = importanceScore(mentions);
      const dec = decayScore(ageDays);
      // Cosine stays the dominant signal (60%); importance and decay
      // nudge the ranking by 20% each. See header comment for rationale.
      const weightedScore = h.score * (0.6 + 0.2 * imp + 0.2 * dec);
      return {
        text: h.text,
        category: h.title || 'knowledge',
        score: weightedScore,
        cosine: h.score,
        importance: imp,
        decay: dec,
        mentions,
      };
    });
    weighted.sort((a, b) => b.score - a.score);

    const finalList = useDiversity && weighted.length > 1
      ? mmrRerank(weighted, { lambda: 0.75, k })
      : weighted.slice(0, k);

    return finalList;
  } catch (err) {
    console.warn('[long-term-memory] recall failed:', err.message);
    return [];
  }
}

/**
 * Format recalled facts as a system-prompt block. Returns an empty
 * string when nothing relevant was found so the prompt doesn't sprout
 * an empty header.
 */
function buildMemoryBlock(facts) {
  if (!Array.isArray(facts) || facts.length === 0) return '';
  const lines = facts.map(f => `- [${f.category}] ${f.text}`);
  return `\n\n## REMEMBERED ABOUT THE USER\nThese are durable facts carried over from previous conversations. Prefer answers that are consistent with them unless the user contradicts a fact in the current turn (in which case the new information wins and the memory block will be refreshed).\n${lines.join('\n')}`;
}

async function clearUserMemory(userId) {
  await rag.clear(userId, collectionFor(userId));
  factMeta.delete(userId);
}

async function memoryStats(userId) {
  return rag.stats(userId, collectionFor(userId));
}

module.exports = {
  extractFacts,          // exported for tests (pure async fn, no side effects)
  extractFactsAsync,     // fire-and-forget
  recallFacts,
  buildMemoryBlock,
  clearUserMemory,
  memoryStats,
  collectionFor,         // exported for tests
  // scoring internals — exported for tests and for potential reuse
  importanceScore,
  decayScore,
  upsertFactMeta,
  getFactMeta,
  normalizeFact,
  HALF_LIFE_DAYS,
  EXTRACTION_SYSTEM_PROMPT,
  // lifecycle / ops (added 2026-05)
  pruneFactMeta,
  listFactMeta,
  MAX_FACTS_PER_USER,
  MEMORY_DISABLED,
};
