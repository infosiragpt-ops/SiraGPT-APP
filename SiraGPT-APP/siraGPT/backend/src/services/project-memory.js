/**
 * project-memory — extract durable facts from a chat turn and persist
 * them against the project for later reference.
 *
 * Design:
 *   - One LLM call per turn (only for chats inside a project).
 *   - Fire-and-forget from ai.js — the user doesn't wait on this.
 *   - Strict-JSON output: { "facts": ["…", "…"] }, 0–3 bullets.
 *   - Short facts only (≤ 200 chars). Longer prose isn't memorable.
 *   - Skip trivia: the extractor prompt tells the model to pick only
 *     stable, reusable facts (user preferences, project scope,
 *     decisions), not ephemera ("user said hi").
 *   - Duplicate-suppression is client-side: a new fact matching an
 *     existing one case-insensitively is dropped. Not semantic dedup,
 *     but enough to avoid "user wants MLA citations" × 10.
 *   - Failures are swallowed — memory is a quality-of-life layer,
 *     never a required part of a chat turn.
 */

const OpenAI = require('openai');
const prisma = require('../config/database');

const MODEL = 'gpt-4o-mini';
const MAX_FACTS_PER_TURN = 3;
const MAX_FACT_CHARS = 200;
const MAX_FACTS_TOTAL = 60; // per project cap, trim oldest on overflow

const EXTRACTOR_PROMPT =
`You extract durable "things worth remembering" from one turn of a
conversation inside a user's private project. Reply with STRICT JSON:

{"facts": ["<fact 1>", "<fact 2>", ...]}

Rules:
- 0 to ${MAX_FACTS_PER_TURN} facts. Prefer fewer. Empty array is fine.
- Each fact is a single short sentence (≤ ${MAX_FACT_CHARS} characters).
- Write in the user's language.
- A good fact is stable and reusable across future chats:
    * user preferences ("prefers MLA citations")
    * project scope / goal ("researching X")
    * decisions made ("chose library Y over Z")
    * concrete constraints ("deadline March 5")
- Skip greetings, small talk, one-off questions, and facts already
  implied by the project's name or description.
- Output JSON only — no prose, no markdown fences.`;

async function extractFacts({ openai, projectName, projectDescription, userMessage, assistantMessage }) {
  if (!openai) throw new Error('project-memory: openai client required');
  if (!userMessage && !assistantMessage) return [];

  const userBlock = [
    projectName ? `Project: ${projectName}` : null,
    projectDescription ? `Goal: ${projectDescription}` : null,
    `\n--- Conversation turn ---`,
    userMessage ? `User: ${userMessage}` : null,
    assistantMessage ? `Assistant: ${assistantMessage}` : null,
  ].filter(Boolean).join('\n');

  const resp = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0.1,
    max_tokens: 400,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: EXTRACTOR_PROMPT },
      { role: 'user', content: userBlock },
    ],
  });

  const raw = resp.choices?.[0]?.message?.content || '';
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!parsed || !Array.isArray(parsed.facts)) return [];

  return parsed.facts
    .filter(f => typeof f === 'string' && f.trim().length > 0)
    .map(f => f.trim().slice(0, MAX_FACT_CHARS))
    .slice(0, MAX_FACTS_PER_TURN);
}

/**
 * Persist newly-extracted facts for a project. De-duplicates against
 * existing facts (case-insensitive exact match) and trims the project's
 * memory tail if it would exceed MAX_FACTS_TOTAL.
 */
async function saveFacts({ projectId, sourceChatId, facts }) {
  if (!projectId || !Array.isArray(facts) || facts.length === 0) return { inserted: 0 };

  const existing = await prisma.projectMemory.findMany({
    where: { projectId },
    select: { fact: true },
  });
  const seen = new Set(existing.map(m => m.fact.toLowerCase()));

  const fresh = [];
  for (const f of facts) {
    const lower = f.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    fresh.push(f);
  }
  if (fresh.length === 0) return { inserted: 0 };

  await prisma.projectMemory.createMany({
    data: fresh.map(fact => ({ projectId, sourceChatId: sourceChatId || null, fact })),
  });

  // Soft cap: trim oldest rows if we're over the ceiling. Uses
  // deleteMany with id-in-query so it's one round trip regardless
  // of how many need pruning.
  const total = existing.length + fresh.length;
  if (total > MAX_FACTS_TOTAL) {
    const excess = total - MAX_FACTS_TOTAL;
    const oldest = await prisma.projectMemory.findMany({
      where: { projectId },
      orderBy: { createdAt: 'asc' },
      take: excess,
      select: { id: true },
    });
    if (oldest.length > 0) {
      await prisma.projectMemory.deleteMany({
        where: { id: { in: oldest.map(r => r.id) } },
      });
    }
  }

  return { inserted: fresh.length };
}

/**
 * Fire-and-forget extractor invoked from the AI route after a chat
 * turn has been persisted. Swallows all errors — if memory
 * extraction fails, the user's chat is unaffected.
 *
 * Uses its own OpenAI client rather than the request's client so we
 * don't inadvertently pick up a router-specific provider (OpenRouter,
 * Gemini) that may not support the same JSON schema contract.
 */
async function extractAndSave({ projectId, projectName, projectDescription, userMessage, assistantMessage, sourceChatId }) {
  if (!process.env.OPENAI_API_KEY) return;
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const facts = await extractFacts({
      openai, projectName, projectDescription, userMessage, assistantMessage,
    });
    if (facts.length === 0) return;
    await saveFacts({ projectId, sourceChatId, facts });
  } catch (err) {
    console.warn('[project-memory] extract-and-save failed:', err.message);
  }
}

async function listMemory(projectId, { limit = 30 } = {}) {
  return prisma.projectMemory.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    take: Math.max(1, Math.min(limit, 100)),
    select: { id: true, fact: true, sourceChatId: true, createdAt: true },
  });
}

async function deleteMemory({ userId, projectId, factId }) {
  // Ownership-gate via project.userId so a guessed factId from another
  // user's project can't delete their data.
  const owned = await prisma.project.findFirst({
    where: { id: projectId, userId },
    select: { id: true },
  });
  if (!owned) return { ok: false, reason: 'not found' };
  const deleted = await prisma.projectMemory.deleteMany({
    where: { id: factId, projectId },
  });
  if (deleted.count === 0) return { ok: false, reason: 'fact not found' };
  return { ok: true };
}

module.exports = {
  extractFacts,
  saveFacts,
  extractAndSave,
  listMemory,
  deleteMemory,
  MAX_FACTS_PER_TURN,
  MAX_FACT_CHARS,
  MAX_FACTS_TOTAL,
};
