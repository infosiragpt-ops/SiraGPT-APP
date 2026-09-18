'use strict';

/**
 * memory/consolidation — the between-sessions "dreaming" pass.
 *
 * For a user whose memory changed since the last pass, an LLM (on the memory
 * failover ladder) reorganises the vault: merges duplicates, resolves
 * contradictions (newest wins), re-files entries under the right topic and
 * drops noise. The proposal is validated FAIL-CLOSED (every input id must be
 * accounted for exactly once, no oversized entries, no mass deletion) and
 * applied atomically. Every pass leaves a REVIEWABLE report — what was merged,
 * dropped or re-filed, plus a snapshot to revert to — persisted in
 * `system_settings` (key `memory.consolidation.<userId>`, last 5 reports).
 *
 * Runs nightly from system-cron (jobs/memory-consolidation.js) and on demand
 * from POST /api/memory/consolidation/run.
 */

const crypto = require('node:crypto');
const vault = require('./vault');

const MAX_REPORTS = 5;
const MAX_ENTRIES_PER_PASS = 400;
const MAX_DROP_RATIO = 0.4;
const LLM_TIMEOUT_MS = 90000;

const deps = { prisma: null, llm: null, log: console, now: () => Date.now() };
function setDeps(next = {}) { Object.assign(deps, next); }
function resetForTests() { deps.prisma = null; deps.llm = null; }

function prisma() {
  if (deps.prisma) return deps.prisma;
  try {
    // eslint-disable-next-line global-require
    deps.prisma = require('../../config/database');
  } catch { deps.prisma = null; }
  return deps.prisma;
}

function storageKey(userId) { return `memory.consolidation.${userId}`; }

function isEnabled(env = process.env) {
  const v = String(env.SIRAGPT_MEMORY_CONSOLIDATION || '').toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false');
}

async function loadReports(userId) {
  const db = prisma();
  if (!db || !db.systemSettings) return [];
  try {
    const row = await db.systemSettings.findUnique({ where: { key: storageKey(userId) } });
    if (!row) return [];
    const parsed = JSON.parse(row.value || '{}');
    return Array.isArray(parsed.reports) ? parsed.reports : [];
  } catch (err) {
    deps.log.warn?.(`[memory-consolidation] load reports failed: ${err && err.message}`);
    return [];
  }
}

async function saveReports(userId, reports) {
  const db = prisma();
  if (!db || !db.systemSettings) return false;
  const value = JSON.stringify({ reports: reports.slice(0, MAX_REPORTS) });
  try {
    await db.systemSettings.upsert({ where: { key: storageKey(userId) }, create: { key: storageKey(userId), value }, update: { value } });
    return true;
  } catch (err) {
    deps.log.warn?.(`[memory-consolidation] save reports failed: ${err && err.message}`);
    return false;
  }
}

function summaryReport(r) {
  if (!r) return null;
  const { snapshot, ...rest } = r;
  return { ...rest, snapshotSize: Array.isArray(snapshot) ? snapshot.length : 0 };
}

async function lastReport(userId) {
  const reports = await loadReports(userId);
  return reports[0] || null;
}

// ── proposal ────────────────────────────────────────────────────────────────

function buildPrompt(entries) {
  const topics = Object.keys(vault.TOPICS).join(', ');
  const listing = entries.map((e) => JSON.stringify({ id: e.id, topic: e.topic, text: e.text, updatedAt: e.updatedAt ? new Date(e.updatedAt).toISOString().slice(0, 10) : null })).join('\n');
  return [
    {
      role: 'system',
      content: [
        'Eres el proceso de consolidación nocturna de la memoria de un asistente. Recibes TODAS las entradas de memoria de un usuario y devuelves una versión reorganizada.',
        'Reglas:',
        '1. Fusiona duplicados y entradas que dicen lo mismo en una sola entrada clara (≤ 300 caracteres, en español, sin opiniones tuyas).',
        '2. Si dos entradas se contradicen, gana la más reciente (updatedAt); descarta la antigua.',
        `3. Clasifica cada entrada en uno de estos temas: ${topics}.`,
        '4. Descarta solo ruido evidente (saludos, frases sin información sobre el usuario). Nunca inventes hechos.',
        '5. CADA id de entrada debe aparecer exactamente una vez: en el array "from" de una entrada resultante o en "drop".',
        'Responde SOLO con JSON: {"entries":[{"text":"...","topic":"...","importance":0.0-1.0,"from":["id",...]}],"drop":["id",...],"notes":"resumen de 1-2 frases de lo que cambió"}',
      ].join('\n'),
    },
    { role: 'user', content: `Entradas (${entries.length}):\n${listing}` },
  ];
}

function extractJson(text) {
  const raw = String(text || '').trim();
  try { return JSON.parse(raw); } catch { /* fall through */ }
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) { try { return JSON.parse(fence[1]); } catch { /* fall through */ } }
  const start = raw.indexOf('{'); const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) { try { return JSON.parse(raw.slice(start, end + 1)); } catch { /* fall through */ } }
  return null;
}

/** Fail-closed validation of the model's proposal against the input set. */
function validateProposal(proposal, entries) {
  if (!proposal || typeof proposal !== 'object') return { ok: false, error: 'proposal_not_object' };
  const ids = new Set(entries.map((e) => e.id));
  const seen = new Set();
  const out = [];
  const drop = Array.isArray(proposal.drop) ? proposal.drop.map(String) : [];
  const list = Array.isArray(proposal.entries) ? proposal.entries : [];
  if (list.length > entries.length) return { ok: false, error: 'proposal_grows_memory' };
  for (const e of list) {
    if (!e || typeof e !== 'object') return { ok: false, error: 'entry_not_object' };
    const rawText = String(e.text || e.content || '').replace(/\s+/g, ' ').trim();
    if (rawText.length < 3 || rawText.length > vault.MAX_ENTRY_CHARS) return { ok: false, error: 'entry_text_out_of_bounds' };
    const text = vault.cleanText(rawText);
    const from = Array.isArray(e.from) ? e.from.map(String) : [];
    if (!from.length) return { ok: false, error: 'entry_without_provenance' };
    for (const id of from) {
      if (!ids.has(id)) return { ok: false, error: `unknown_id:${id}` };
      if (seen.has(id)) return { ok: false, error: `id_used_twice:${id}` };
      seen.add(id);
    }
    out.push({ text, topic: vault.normalizeTopic(e.topic), importance: Math.max(0, Math.min(1, Number(e.importance) || 0.5)), from });
  }
  for (const id of drop) {
    if (!ids.has(id)) return { ok: false, error: `unknown_drop_id:${id}` };
    if (seen.has(id)) return { ok: false, error: `id_used_twice:${id}` };
    seen.add(id);
  }
  if (seen.size !== ids.size) return { ok: false, error: `ids_unaccounted:${ids.size - seen.size}` };
  if (entries.length >= 5 && drop.length / entries.length > MAX_DROP_RATIO) return { ok: false, error: 'drops_too_many' };
  return { ok: true, entries: out, drop, notes: String(proposal.notes || '').slice(0, 400) };
}

async function proposeWithLlm(entries, { llm, env = process.env, signal } = {}) {
  const client = llm || deps.llm || (() => {
    // eslint-disable-next-line global-require
    return require('../memory-llm-client').createMemoryLlmClient({ env });
  })();
  if (!client || !client.chat || !client.chat.completions) return { ok: false, error: 'no_llm' };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), LLM_TIMEOUT_MS);
  if (signal) signal.addEventListener('abort', () => ac.abort(), { once: true });
  try {
    const res = await client.chat.completions.create({
      model: env.SIRAGPT_MEMORY_LLM_MODEL || undefined,
      temperature: 0,
      max_tokens: 4000,
      response_format: { type: 'json_object' },
      messages: buildPrompt(entries),
    }, { signal: ac.signal });
    const text = res && res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content;
    const parsed = extractJson(text);
    if (!parsed) return { ok: false, error: 'llm_not_json' };
    return { ok: true, proposal: parsed };
  } catch (err) {
    return { ok: false, error: `llm_failed:${String((err && err.message) || err).slice(0, 120)}` };
  } finally {
    clearTimeout(timer);
  }
}

// ── apply ───────────────────────────────────────────────────────────────────

function sameText(a, b) { return vault.contentHash(a) === vault.contentHash(b); }

async function applyProposal(userId, entries, plan) {
  const db = prisma();
  if (!db) return { ok: false, error: 'no_db' };
  const byId = new Map(entries.map((e) => [e.id, e]));
  const merged = []; const refiled = []; const rewritten = []; const kept = [];
  const dropped = plan.drop.map((id) => byId.get(id)).filter(Boolean).map((e) => ({ id: e.id, text: e.text, topic: e.topic }));
  const ops = [];
  for (const e of plan.entries) {
    const sources = e.from.map((id) => byId.get(id)).filter(Boolean);
    const single = sources.length === 1 ? sources[0] : null;
    if (single && sameText(single.text, e.text)) {
      if (single.topic !== e.topic) refiled.push({ id: single.id, text: single.text, from: single.topic, to: e.topic });
      else kept.push(single.id);
      ops.push(db.userMemory.update({ where: { id: single.id }, data: { category: e.topic, importanceScore: e.importance } }));
      continue;
    }
    const hash = vault.contentHash(e.text);
    const record = { userId, content: e.text, category: e.topic, importanceScore: e.importance, confidence: Math.max(...sources.map((s) => s.confidence || 0.8), 0.8), contentHash: hash, source: 'consolidation' };
    // Delete the sources first so the (userId, contentHash) unique never collides with one of them.
    ops.push(db.userMemory.deleteMany({ where: { userId, id: { in: sources.map((s) => s.id) } } }));
    ops.push(db.userMemory.upsert({ where: { userId_contentHash: { userId, contentHash: hash } }, create: record, update: { category: e.topic, importanceScore: e.importance, source: 'consolidation' } }));
    if (sources.length > 1) merged.push({ from: sources.map((s) => ({ id: s.id, text: s.text })), to: { text: e.text, topic: e.topic } });
    else rewritten.push({ id: single.id, from: single.text, to: e.text, topic: e.topic });
  }
  if (dropped.length) ops.push(db.userMemory.deleteMany({ where: { userId, id: { in: dropped.map((d) => d.id) } } }));
  try {
    if (typeof db.$transaction === 'function') await db.$transaction(ops);
    else for (const op of ops) await op;
  } catch (err) {
    return { ok: false, error: `apply_failed:${String((err && err.message) || err).slice(0, 160)}` };
  }
  return { ok: true, merged, refiled, rewritten, dropped, kept: kept.length };
}

/**
 * Consolidate one user. `{ ok, skipped?, report? }`. Never throws.
 */
async function consolidateUser(userId, { llm = null, env = process.env, force = false, signal } = {}) {
  if (!userId) return { ok: false, error: 'no_user' };
  if (!isEnabled(env) && !force) return { ok: false, skipped: 'disabled' };
  const entries = await vault.list(userId, { limit: MAX_ENTRIES_PER_PASS });
  if (entries.length < 2) return { ok: true, skipped: 'too_few_entries', count: entries.length };
  const reports = await loadReports(userId);
  const last = reports[0];
  const newest = Math.max(...entries.map((e) => e.updatedAt || 0), 0);
  if (!force && last && last.at && newest <= new Date(last.at).getTime()) return { ok: true, skipped: 'unchanged_since_last' };

  const proposed = await proposeWithLlm(entries, { llm, env, signal });
  if (!proposed.ok) return { ok: false, error: proposed.error };
  const plan = validateProposal(proposed.proposal, entries);
  if (!plan.ok) {
    deps.log.warn?.(`[memory-consolidation] proposal rejected for ${userId}: ${plan.error}`);
    return { ok: false, error: `rejected:${plan.error}` };
  }
  const applied = await applyProposal(userId, entries, plan);
  if (!applied.ok) return { ok: false, error: applied.error };
  const after = await vault.stats(userId);
  const report = {
    id: crypto.randomUUID(),
    at: new Date(deps.now()).toISOString(),
    before: entries.length,
    after: after.total,
    merged: applied.merged,
    refiled: applied.refiled,
    rewritten: applied.rewritten,
    dropped: applied.dropped,
    kept: applied.kept,
    notes: plan.notes,
    reverted: false,
    snapshot: entries.map((e) => ({ id: e.id, text: e.text, topic: e.topic, importance: e.importance, confidence: e.confidence, source: e.source })),
  };
  await saveReports(userId, [report, ...reports]);
  deps.log.info?.(`[memory-consolidation] user ${userId}: ${entries.length} → ${after.total} (merged ${applied.merged.length}, refiled ${applied.refiled.length}, dropped ${applied.dropped.length})`);
  return { ok: true, report: summaryReport(report) };
}

/** Restore the snapshot taken before a report was applied. */
async function revert(userId, reportId) {
  const db = prisma();
  if (!db || !userId || !reportId) return { ok: false, error: 'bad_request' };
  const reports = await loadReports(userId);
  const idx = reports.findIndex((r) => r.id === reportId);
  if (idx < 0) return { ok: false, error: 'not_found' };
  const report = reports[idx];
  if (report.reverted) return { ok: false, error: 'already_reverted' };
  const snapshot = Array.isArray(report.snapshot) ? report.snapshot : [];
  const ops = [db.userMemory.deleteMany({ where: { userId } })];
  const seen = new Set();
  for (const s of snapshot) {
    const hash = vault.contentHash(s.text);
    if (seen.has(hash)) continue;
    seen.add(hash);
    ops.push(db.userMemory.create({ data: { id: s.id, userId, content: s.text, category: vault.normalizeTopic(s.topic), importanceScore: Number(s.importance) || 0.5, confidence: Number(s.confidence) || 0.8, contentHash: hash, source: s.source || 'restored' } }));
  }
  try {
    if (typeof db.$transaction === 'function') await db.$transaction(ops);
    else for (const op of ops) await op;
  } catch (err) {
    return { ok: false, error: `revert_failed:${String((err && err.message) || err).slice(0, 160)}` };
  }
  reports[idx] = { ...report, reverted: true, revertedAt: new Date(deps.now()).toISOString() };
  await saveReports(userId, reports);
  return { ok: true, restored: seen.size, report: summaryReport(reports[idx]) };
}

async function listReports(userId) {
  return (await loadReports(userId)).map(summaryReport);
}

/** Users whose memory changed since their last pass (for the nightly job). */
async function usersDue({ batch = 50 } = {}) {
  const db = prisma();
  if (!db) return [];
  let groups = [];
  try {
    groups = await db.userMemory.groupBy({ by: ['userId'], _count: { _all: true }, _max: { updatedAt: true } });
  } catch (err) {
    deps.log.warn?.(`[memory-consolidation] groupBy failed: ${err && err.message}`);
    return [];
  }
  const due = [];
  for (const g of groups) {
    if ((g._count && g._count._all) < 2) continue;
    const last = await lastReport(g.userId);
    const newest = g._max && g._max.updatedAt ? new Date(g._max.updatedAt).getTime() : 0;
    if (last && last.at && newest <= new Date(last.at).getTime()) continue;
    due.push(g.userId);
    if (due.length >= batch) break;
  }
  return due;
}

async function runPass({ batch = 50, env = process.env, llm = null, log = deps.log } = {}) {
  if (!isEnabled(env)) return { ok: true, skipped: 'disabled', users: 0 };
  const users = await usersDue({ batch });
  const out = { ok: true, users: users.length, consolidated: 0, failed: 0, skipped: 0, errors: [] };
  for (const userId of users) {
    const r = await consolidateUser(userId, { llm, env });
    if (r.ok && r.report) out.consolidated += 1;
    else if (r.ok) out.skipped += 1;
    else { out.failed += 1; out.errors.push(`${userId}:${r.error}`); }
  }
  log.info?.(`[memory-consolidation] pass: users=${out.users} consolidated=${out.consolidated} skipped=${out.skipped} failed=${out.failed}`);
  return out;
}

module.exports = {
  isEnabled,
  consolidateUser,
  revert,
  listReports,
  lastReport,
  usersDue,
  runPass,
  validateProposal,
  buildPrompt,
  extractJson,
  setDeps,
  resetForTests,
};
