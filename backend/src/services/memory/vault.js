'use strict';

/**
 * memory/vault — the ONE canonical user memory, Claude-Code style.
 *
 *   index always loaded   → buildIndexBlock(userId): a compact, always-on
 *                           system-prompt block (topics + the most important
 *                           entries) that tells the model what it knows and
 *                           how to open more.
 *   topic files on demand → readTopic(userId, topic): the full entries of one
 *                           topic, fetched only when the model asks.
 *   agentic search        → grep(userId, query): exact/lexical first;
 *                           search() adds the vector rung ONLY when the corpus
 *                           no longer fits the grep budget.
 *   same-conversation     → write()/forget() are deliberate, guarded writes
 *   writes                  the model (memory_write tool) and the extractor
 *                           both use; recordFacts() is the extractor sink.
 *
 * Storage: the existing `user_memories` table (Prisma `UserMemory`), which is
 * durable, per-user, unique on (userId, contentHash) and already indexed by
 * (userId, category). `category` == topic. No schema change.
 *
 * Every function fails soft: a DB error yields an empty result / `{ ok:false }`
 * and a warn, never a thrown error into the chat turn.
 */

const crypto = require('node:crypto');

const TOPICS = Object.freeze({
  personal: 'Datos personales',
  preference: 'Preferencias',
  work: 'Trabajo y contexto',
  project: 'Proyectos',
  people: 'Personas',
  decision: 'Decisiones',
  tool: 'Herramientas',
  instruction: 'Instrucciones',
  knowledge: 'Conocimiento',
});
const TOPIC_ALIASES = Object.freeze({
  identity: 'personal', perfil: 'personal', profile: 'personal', datos: 'personal',
  preferencias: 'preference', preferences: 'preference', gusto: 'preference',
  trabajo: 'work', empresa: 'work', job: 'work', context: 'work', contexto: 'work',
  proyecto: 'project', proyectos: 'project', projects: 'project',
  persona: 'people', personas: 'people', person: 'people', contacts: 'people',
  decisiones: 'decision', decisions: 'decision', decision: 'decision',
  herramienta: 'tool', herramientas: 'tool', tools: 'tool', stack: 'tool',
  instrucciones: 'instruction', instructions: 'instruction', rule: 'instruction', regla: 'instruction',
  general: 'knowledge', conocimiento: 'knowledge', fact: 'knowledge', hecho: 'knowledge',
});

const MAX_ENTRY_CHARS = 400;
const MIN_ENTRY_CHARS = 3;
const DEFAULT_INDEX_LINES = 12;
const DEFAULT_INDEX_MAX_CHARS = 1800;
const WRITE_WINDOW_MS = 10 * 60 * 1000;
const WRITE_WINDOW_MAX = 60;

const deps = { prisma: null, log: console };
const writeWindows = new Map(); // userId → timestamps
const legacyImported = new Set();

function setDeps(next = {}) { Object.assign(deps, next); }
function resetForTests() { deps.prisma = null; writeWindows.clear(); legacyImported.clear(); }

function prisma() {
  if (deps.prisma) return deps.prisma;
  try {
    // eslint-disable-next-line global-require
    deps.prisma = require('../../config/database');
  } catch (err) {
    deps.log.warn?.(`[memory-vault] prisma unavailable: ${err && err.message}`);
    deps.prisma = null;
  }
  return deps.prisma;
}

function grepMaxChars(env = process.env) {
  const n = Number(env.SIRAGPT_MEMORY_GREP_MAX_CHARS);
  return Number.isFinite(n) && n >= 2000 ? n : 24000;
}

function normalizeTopic(topic) {
  const t = String(topic || '').toLowerCase().trim();
  if (!t) return 'knowledge';
  if (TOPICS[t]) return t;
  return TOPIC_ALIASES[t] || 'knowledge';
}

function topicLabel(topic) { return TOPICS[normalizeTopic(topic)] || topic; }

function cleanText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_ENTRY_CHARS);
}

function fold(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
}

function contentHash(text) {
  return crypto.createHash('sha256').update(fold(text)).digest('hex').slice(0, 32);
}

function neutralize(text) {
  return String(text || '').replace(/[\r\n]+/g, ' ').replace(/</g, '‹').replace(/>/g, '›').trim();
}

function looksLikePii(text) {
  try {
    // eslint-disable-next-line global-require
    return require('../memory-document').looksLikePii(text);
  } catch { return false; }
}

function toEntry(row) {
  if (!row) return null;
  return {
    id: row.id,
    text: row.content,
    category: normalizeTopic(row.category),
    topic: normalizeTopic(row.category),
    source: row.source || null,
    importance: Number(row.importanceScore || 0),
    confidence: Number(row.confidence || 0),
    createdAt: row.createdAt ? new Date(row.createdAt).getTime() : null,
    updatedAt: row.updatedAt ? new Date(row.updatedAt).getTime() : null,
  };
}

const BASE_SELECT = { id: true, userId: true, content: true, category: true, importanceScore: true, confidence: true, source: true, createdAt: true, updatedAt: true, contentHash: true };

async function listRows(userId, { topic = null, limit = 500 } = {}) {
  const db = prisma();
  if (!db || !userId) return [];
  try {
    return await db.userMemory.findMany({
      where: { userId, ...(topic ? { category: normalizeTopic(topic) } : {}) },
      select: BASE_SELECT,
      orderBy: [{ importanceScore: 'desc' }, { updatedAt: 'desc' }],
      take: Math.max(1, Math.min(2000, limit)),
    });
  } catch (err) {
    deps.log.warn?.(`[memory-vault] list failed: ${err && err.message}`);
    return [];
  }
}

async function list(userId, opts = {}) {
  return (await listRows(userId, opts)).map(toEntry);
}

async function stats(userId) {
  const rows = await listRows(userId, { limit: 2000 });
  const byCategory = {};
  let chars = 0;
  for (const r of rows) {
    const t = normalizeTopic(r.category);
    byCategory[t] = (byCategory[t] || 0) + 1;
    chars += String(r.content || '').length;
  }
  return { total: rows.length, byCategory, chars };
}

function renderMarkdown(entries) {
  const groups = new Map();
  for (const e of entries) {
    const t = normalizeTopic(e.topic || e.category);
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t).push(e);
  }
  const lines = ['# Memoria de SiraGPT sobre ti', ''];
  for (const [t, items] of groups) {
    lines.push(`## ${topicLabel(t)} (${items.length})`);
    for (const e of items) lines.push(`- ${e.text}`);
    lines.push('');
  }
  return lines.join('\n').trim();
}

/** Route/UI contract of the legacy memory document: { entries, markdown, stats }. */
async function getDocument(userId) {
  await importLegacy(userId);
  const entries = await list(userId, { limit: 2000 });
  const s = await stats(userId);
  return { entries, markdown: renderMarkdown(entries), stats: { total: s.total, byCategory: s.byCategory } };
}

async function readTopic(userId, topic, { limit = 60 } = {}) {
  const t = normalizeTopic(topic);
  const entries = await list(userId, { topic: t, limit });
  return { topic: t, label: topicLabel(t), entries };
}

// ── search ──────────────────────────────────────────────────────────────────

function terms(query) {
  return Array.from(new Set(fold(query).split(/[^a-z0-9ñ]+/i).filter((w) => w.length >= 3))).slice(0, 12);
}

function scoreEntry(entry, query, termList) {
  const hay = fold(entry.text);
  const q = fold(query);
  let hits = 0;
  for (const t of termList) if (hay.includes(t)) hits += 1;
  if (!termList.length && !q) return 0;
  const coverage = termList.length ? hits / termList.length : 0;
  const phrase = q && hay.includes(q) ? 0.35 : 0;
  const ageDays = entry.updatedAt ? (Date.now() - entry.updatedAt) / 86400000 : 365;
  const recency = Math.max(0, 0.15 - Math.min(ageDays, 365) / 365 * 0.15);
  return Number((coverage * 0.6 + phrase + Math.min(1, entry.importance) * 0.15 + recency).toFixed(4));
}

/** Lexical, exact-ish search over the user's whole memory. Cheap, no network. */
async function grep(userId, query, { limit = 10, topic = null } = {}) {
  const termList = terms(query);
  if (!termList.length && !fold(query)) return [];
  const db = prisma();
  if (!db || !userId) return [];
  let rows = [];
  try {
    rows = await db.userMemory.findMany({
      where: {
        userId,
        ...(topic ? { category: normalizeTopic(topic) } : {}),
        ...(termList.length ? { OR: termList.map((t) => ({ content: { contains: t, mode: 'insensitive' } })) } : {}),
      },
      select: BASE_SELECT,
      take: 300,
    });
  } catch (err) {
    deps.log.warn?.(`[memory-vault] grep failed: ${err && err.message}`);
    return [];
  }
  return rows.map(toEntry)
    .map((e) => ({ ...e, score: scoreEntry(e, query, termList) }))
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(50, limit)));
}

/**
 * grep first; the vector rung joins ONLY when the corpus no longer fits the
 * grep budget (SIRAGPT_MEMORY_GREP_MAX_CHARS, default 24k chars ≈ 6k tokens).
 */
async function search(userId, query, { limit = 10, env = process.env, vectorRecall = null } = {}) {
  const s = await stats(userId);
  const lexical = await grep(userId, query, { limit });
  if (s.chars <= grepMaxChars(env)) return { mode: 'grep', corpusChars: s.chars, results: lexical };
  let vector = [];
  try {
    const recall = vectorRecall || defaultVectorRecall;
    vector = await recall(userId, query, limit);
  } catch (err) {
    deps.log.warn?.(`[memory-vault] vector rung failed: ${err && err.message}`);
  }
  const seen = new Set(lexical.map((e) => contentHash(e.text)));
  const merged = [...lexical];
  for (const v of vector) {
    const text = cleanText(v.text || v.fact || v.content);
    if (!text) continue;
    const h = contentHash(text);
    if (seen.has(h)) continue;
    seen.add(h);
    merged.push({ id: v.id || null, text, topic: normalizeTopic(v.category || v.topic), category: normalizeTopic(v.category || v.topic), score: Number(v.score || 0.3), source: 'vector' });
  }
  return { mode: 'hybrid', corpusChars: s.chars, results: merged.sort((a, b) => b.score - a.score).slice(0, limit) };
}

async function defaultVectorRecall(userId, query, k) {
  // eslint-disable-next-line global-require
  const ltm = require('../long-term-memory');
  const facts = await ltm.recallFacts(userId, query, k);
  return Array.isArray(facts) ? facts : [];
}

// ── writes ──────────────────────────────────────────────────────────────────

function checkWriteWindow(userId) {
  const now = Date.now();
  const list0 = (writeWindows.get(userId) || []).filter((t) => now - t < WRITE_WINDOW_MS);
  if (list0.length >= WRITE_WINDOW_MAX) { writeWindows.set(userId, list0); return false; }
  list0.push(now);
  writeWindows.set(userId, list0);
  return true;
}

function validateText(text) {
  const clean = cleanText(text);
  if (clean.length < MIN_ENTRY_CHARS) return { ok: false, error: 'memory_text_too_short' };
  if (looksLikePii(clean)) return { ok: false, error: 'memory_text_looks_like_secret' };
  return { ok: true, text: clean };
}

/**
 * Deliberate, guarded write. Upserts on (userId, contentHash): re-learning the
 * same fact bumps importance and refreshes updatedAt instead of duplicating.
 */
async function write(userId, { text, topic = null, source = 'manual', importance = 0.5, confidence = 0.8 } = {}) {
  if (!userId) return { ok: false, error: 'no_user' };
  const v = validateText(text);
  if (!v.ok) return v;
  if (!checkWriteWindow(userId)) return { ok: false, error: 'memory_write_rate_limited' };
  const db = prisma();
  if (!db) return { ok: false, error: 'memory_unavailable' };
  const category = normalizeTopic(topic);
  const hash = contentHash(v.text);
  // Reinforcing a known fact without naming a topic must not re-file it.
  const explicitTopic = topic != null && String(topic).trim() !== '';
  const imp = Math.max(0, Math.min(1, Number(importance) || 0.5));
  const conf = Math.max(0, Math.min(1, Number(confidence) || 0.8));
  try {
    const existing = await db.userMemory.findUnique({ where: { userId_contentHash: { userId, contentHash: hash } }, select: BASE_SELECT });
    if (existing) {
      const row = await db.userMemory.update({
        where: { id: existing.id },
        data: { ...(explicitTopic ? { category } : {}), importanceScore: Math.min(1, Math.max(existing.importanceScore || 0, imp) + 0.05), confidence: Math.max(existing.confidence || 0, conf), accessCount: { increment: 1 }, lastAccessedAt: new Date() },
        select: BASE_SELECT,
      });
      return { ok: true, created: false, entry: toEntry(row) };
    }
    const row = await db.userMemory.create({
      data: { userId, content: v.text, category, importanceScore: imp, confidence: conf, contentHash: hash, source: String(source || 'manual').slice(0, 80) },
      select: BASE_SELECT,
    });
    return { ok: true, created: true, entry: toEntry(row) };
  } catch (err) {
    deps.log.warn?.(`[memory-vault] write failed: ${err && err.message}`);
    return { ok: false, error: 'memory_write_failed' };
  }
}

async function update(userId, id, { text, topic } = {}) {
  const db = prisma();
  if (!db || !userId || !id) return { ok: false, error: 'bad_request' };
  const data = {};
  if (text !== undefined) {
    const v = validateText(text);
    if (!v.ok) return v;
    data.content = v.text;
    data.contentHash = contentHash(v.text);
  }
  if (topic !== undefined) data.category = normalizeTopic(topic);
  try {
    const existing = await db.userMemory.findFirst({ where: { id, userId }, select: { id: true } });
    if (!existing) return { ok: false, error: 'not_found' };
    const row = await db.userMemory.update({ where: { id }, data, select: BASE_SELECT });
    return { ok: true, entry: toEntry(row) };
  } catch (err) {
    deps.log.warn?.(`[memory-vault] update failed: ${err && err.message}`);
    return { ok: false, error: 'memory_update_failed' };
  }
}

async function forget(userId, id) {
  const db = prisma();
  if (!db || !userId || !id) return { ok: false, error: 'bad_request' };
  try {
    const res = await db.userMemory.deleteMany({ where: { id, userId } });
    return { ok: res.count > 0, error: res.count > 0 ? undefined : 'not_found' };
  } catch (err) {
    deps.log.warn?.(`[memory-vault] forget failed: ${err && err.message}`);
    return { ok: false, error: 'memory_forget_failed' };
  }
}

/** Forget by text match (the model says "olvida que X"). */
async function forgetMatching(userId, query, { limit = 3 } = {}) {
  const hits = await grep(userId, query, { limit });
  const removed = [];
  for (const h of hits) {
    if (h.score < 0.5 || !h.id) continue;
    const r = await forget(userId, h.id);
    if (r.ok) removed.push(h);
  }
  return { ok: true, removed };
}

async function clear(userId) {
  const db = prisma();
  if (!db || !userId) return { ok: false };
  try {
    await db.userMemory.deleteMany({ where: { userId } });
    return { ok: true };
  } catch (err) {
    deps.log.warn?.(`[memory-vault] clear failed: ${err && err.message}`);
    return { ok: false };
  }
}

/** Extractor sink: facts `{ fact|text, category, confidence }` → vault rows. */
async function recordFacts(userId, facts, { source = 'auto' } = {}) {
  const out = { stored: 0, updated: 0, skipped: 0 };
  if (!userId || !Array.isArray(facts)) return out;
  for (const f of facts.slice(0, 20)) {
    const text = f && (f.fact || f.text || f.content);
    const r = await write(userId, { text, topic: f && f.category, source, confidence: f && f.confidence, importance: 0.5 });
    if (!r.ok) out.skipped += 1;
    else if (r.created) out.stored += 1;
    else out.updated += 1;
  }
  return out;
}

/** One-time per process: pull the legacy on-disk memory document into the vault. */
async function importLegacy(userId) {
  if (!userId || legacyImported.has(userId)) return { imported: 0 };
  legacyImported.add(userId);
  try {
    const db = prisma();
    if (!db) return { imported: 0 };
    const count = await db.userMemory.count({ where: { userId } });
    if (count > 0) return { imported: 0 };
    // eslint-disable-next-line global-require
    const legacy = require('../memory-document');
    const doc = legacy.getDocument(userId);
    const entries = Array.isArray(doc && doc.entries) ? doc.entries : [];
    let imported = 0;
    for (const e of entries.slice(0, 200)) {
      const r = await write(userId, { text: e.text, topic: e.category, source: 'legacy-import', importance: 0.5 });
      if (r.ok && r.created) imported += 1;
    }
    if (imported) deps.log.info?.(`[memory-vault] imported ${imported} legacy entries for user ${userId}`);
    return { imported };
  } catch (err) {
    deps.log.warn?.(`[memory-vault] legacy import failed: ${err && err.message}`);
    return { imported: 0 };
  }
}

// ── the always-loaded index ────────────────────────────────────────────────

/**
 * Compact index for the system prompt: topic counts + the most important
 * entries, capped by lines and chars. Tells the model how to open more.
 */
async function buildIndexBlock(userId, { maxLines = DEFAULT_INDEX_LINES, maxChars = DEFAULT_INDEX_MAX_CHARS, tools = true } = {}) {
  if (!userId) return '';
  await importLegacy(userId);
  const rows = await listRows(userId, { limit: 400 });
  if (!rows.length) return '';
  const byTopic = new Map();
  for (const r of rows) {
    const t = normalizeTopic(r.category);
    byTopic.set(t, (byTopic.get(t) || 0) + 1);
  }
  const topicsLine = Array.from(byTopic.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${topicLabel(t)} (${n})`)
    .join(' · ');
  const lines = [
    '## Memoria del usuario (índice — siempre cargado)',
    `Temas: ${topicsLine}. Entradas: ${rows.length}.`,
  ];
  const picked = rows.slice(0, maxLines);
  for (const r of picked) {
    const line = `- [${topicLabel(r.category)}] ${neutralize(r.content).slice(0, 160)}`;
    if (lines.join('\n').length + line.length + 1 > maxChars) break;
    lines.push(line);
  }
  if (rows.length > picked.length) lines.push(`- … ${rows.length - picked.length} entradas más por tema.`);
  if (tools) {
    lines.push('Usa `memory_read_topic` para abrir un tema completo, `memory_search` para buscar en toda la memoria y `memory_write` para guardar algo nuevo y duradero (nunca datos sensibles). Si el usuario te contradice ahora, gana lo que dice ahora.');
  }
  return lines.join('\n');
}

module.exports = {
  TOPICS,
  MAX_ENTRY_CHARS,
  normalizeTopic,
  topicLabel,
  contentHash,
  cleanText,
  list,
  stats,
  getDocument,
  renderMarkdown,
  readTopic,
  grep,
  search,
  write,
  update,
  forget,
  forgetMatching,
  clear,
  recordFacts,
  importLegacy,
  buildIndexBlock,
  setDeps,
  resetForTests,
  _internal: { terms, scoreEntry, validateText, grepMaxChars },
};
