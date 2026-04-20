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

const COLLECTION_PREFIX = 'facts:';
const DEFAULT_RECALL_K = 5;
const MIN_CONFIDENCE = 0.6;
const MAX_FACTS_PER_TURN = 8;

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
  // setImmediate defers to the next tick so the caller returns to the
  // user as fast as possible; the extraction runs afterwards.
  setImmediate(async () => {
    try {
      const facts = await extractFacts(openai, userMessage, assistantMessage);
      if (facts.length === 0) return;
      const docs = facts.map(f => ({
        text: f.fact,
        title: f.category,
        source: `mem:${f.confidence.toFixed(2)}`,
      }));
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
async function recallFacts(userId, userMessage, k = DEFAULT_RECALL_K) {
  if (!userId || !userMessage) return [];
  try {
    const hits = await rag.retrieve(userId, collectionFor(userId), userMessage, k);
    return hits.map(h => ({
      text: h.text,
      category: h.title || 'knowledge',
      score: h.score,
    }));
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

function clearUserMemory(userId) {
  rag.clear(userId, collectionFor(userId));
}

function memoryStats(userId) {
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
  EXTRACTION_SYSTEM_PROMPT,
};
