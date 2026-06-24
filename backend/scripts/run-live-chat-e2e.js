#!/usr/bin/env node
'use strict';

/**
 * run-live-chat-e2e.js — REAL end-to-end validation through the LIVE chat.
 *
 * Exercises the actual production path a user hits:
 *   1. Auth: mints a JWT + inserts a Session row for a dedicated, tagged
 *      test user (fingerprint null → fingerprint check skipped). Bearer auth
 *      is CSRF-exempt and bypasses requireScope (JWT session).
 *   2. Upload: POST /api/files/upload (multipart) → runs the REAL
 *      fileProcessor (docx/xlsx/pdf via parsers, png via tesseract OCR) and
 *      persists File rows with extractedText.
 *   3. Chat: POST /api/ai/generate (SSE) with {model, provider, prompt,
 *      files:[id], chatId} → the FULL enrichment stack (master prompt,
 *      context-intelligence, attribution, cowork, RAG, …) → streamed answer.
 *   4. Grade: deterministic expected-substring against facts planted in the
 *      fixtures. Multi-turn threads test in-thread context retention (the
 *      bug fixed in commit 46de40b85): turn 2+ does NOT re-attach the doc.
 *   5. Cleanup: deletes every row this run created (messages, chats, files +
 *      on-disk blobs, session, user). Use --keep to skip.
 *
 * Usage:
 *   node backend/scripts/run-live-chat-e2e.js                # full corpus
 *   node backend/scripts/run-live-chat-e2e.js --probe        # discover working provider/model
 *   node backend/scripts/run-live-chat-e2e.js --limit 10     # first N units
 *   node backend/scripts/run-live-chat-e2e.js --category excel
 *   node backend/scripts/run-live-chat-e2e.js --concurrency 4
 *   node backend/scripts/run-live-chat-e2e.js --model gpt-oss-120b --provider Cerebras
 *   node backend/scripts/run-live-chat-e2e.js --keep         # leave test data in DB
 *
 * Exit code: 0 if overall deterministic pass-rate >= THRESHOLD (default .75).
 */

const fs = require('fs');
const path = require('path');

try { require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env.local') }); } catch (_) {}
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); } catch (_) {}

const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const { generateAll } = require('./lib/e2e-fixtures');

const prisma = new PrismaClient();

// ── args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 ? (args[i + 1] ?? d) : d; };
const PROBE = has('--probe');
const KEEP = has('--keep');
const LIMIT = Number(val('--limit', 0)) || 0;
const CONCURRENCY = Number(val('--concurrency', 3)) || 3;
const ONLY_CAT = val('--category', '');
const ONLY_IDS = (val('--ids', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const BASE = val('--base', process.env.E2E_BASE_URL || 'http://localhost:5000');
const THRESHOLD = Number(process.env.E2E_THRESHOLD) || 0.75;
let MODEL = val('--model', process.env.E2E_MODEL || '');
let PROVIDER = val('--provider', process.env.E2E_PROVIDER || '');
const REQ_TIMEOUT_MS = Number(process.env.E2E_REQ_TIMEOUT_MS) || 120000;

// ── helpers ─────────────────────────────────────────────────────────────────
const stripAccents = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const norm = (s) => stripAccents(String(s || '').toLowerCase())
  .replace(/(?<=\d)[.,](?=\d{3}\b)/g, '')
  .replace(/\s+/g, ' ')
  .trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Global dispatch gate: /api/ai/generate is capped at 60 req / 60s, so we
// serialize request *starts* to a minimum gap (≈52/min) to never burst.
const MIN_GAP_MS = Number(process.env.E2E_MIN_GAP_MS) || 1150;
let _gateChain = Promise.resolve();
let _lastStart = 0;
function rateGate() {
  _gateChain = _gateChain.then(async () => {
    const wait = Math.max(0, _lastStart + MIN_GAP_MS - Date.now());
    if (wait) await sleep(wait);
    _lastStart = Date.now();
  });
  return _gateChain;
}

// The agentic path (any turn with attachments) streams a fenced
// ```agent-task-state {…}``` sentinel whose `finalText` holds the real
// answer. Prefer that; otherwise strip sentinels and use the plain text.
function extractAnswer(raw) {
  const s = String(raw || '');
  const fences = [...s.matchAll(/```agent-task-state\n([\s\S]*?)\n```/g)];
  for (let i = fences.length - 1; i >= 0; i--) {
    try {
      const st = JSON.parse(fences[i][1]);
      if (st && typeof st.finalText === 'string' && st.finalText.trim()) return st.finalText.trim();
    } catch (_) { /* fall through */ }
  }
  const stripped = s.replace(/```agent-task-state\n[\s\S]*?\n```/g, '').trim();
  return stripped || s;
}

function gradeAnswer(ans, expect) {
  const a = norm(ans);
  if (!a) return false;
  if (expect.all) return expect.all.every((s) => a.includes(norm(s)));
  if (expect.any) return expect.any.some((s) => a.includes(norm(s)));
  return null; // judge-only
}

// ── auth setup ───────────────────────────────────────────────────────────────
let ctx = { user: null, token: null, fileIds: {}, chats: [] };

async function setup() {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET missing in env (.env.local)');
  const stamp = `${Date.now()}`;
  const email = `e2e-live+${stamp}@siragpt.local`;
  const user = await prisma.user.create({
    data: {
      email,
      name: 'E2E Live Tester',
      // Placeholder bcrypt-shaped hash; we never log in with a password.
      password: '$2a$10$E2EE2EE2EE2EE2EE2EE2EOE2EE2EE2EE2EE2EE2EE2EE2EE2EE2EEa',
      // ENTERPRISE bypasses the FREE-plan daily-query cap; huge (not zero)
      // limits keep the literal monthly-limit middleware from blocking.
      plan: 'ENTERPRISE',
      monthlyCallLimit: BigInt(100000000),
      monthlyLimit: BigInt(1000000000),
      gemaTokenLimit: BigInt(1000000000),
      isAdmin: false,
    },
  });
  const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, {
    expiresIn: '2d',
    audience: process.env.JWT_AUDIENCE || 'siragpt-clients',
    issuer: process.env.JWT_ISSUER || 'siragpt-api',
  });
  await prisma.session.create({
    data: {
      userId: user.id,
      token,
      expiresAt: new Date(Date.now() + 2 * 24 * 3600 * 1000),
      fingerprint: null, // null → fingerprint binding check skipped
    },
  });
  ctx.user = user;
  ctx.token = token;
  console.log(`  ✅ test user ${email} (id=${user.id})`);
}

// ── HTTP primitives ──────────────────────────────────────────────────────────
async function uploadFile(fixture) {
  const buf = fs.readFileSync(fixture.path);
  const fd = new FormData();
  fd.append('files', new Blob([buf], { type: fixture.mime }), fixture.name);
  const res = await fetch(`${BASE}/api/files/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ctx.token}` },
    body: fd,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`upload ${fixture.name} → HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  const json = await res.json();
  const f = (json.files || [])[0] || {};
  return { id: f.id, success: f.success, chars: (f.extractedText || '').length, ocr: f.ocr };
}

async function chat(opts) {
  // Transient-only retry: 429 / 5xx / network → backoff + retry (max 2).
  let last = null;
  for (let attempt = 0; attempt <= 2; attempt++) {
    const r = await chatOnce(opts);
    if (r.ok) return r;
    const transient = r.status === 429 || r.status >= 500 || r.status === 0;
    last = r;
    if (!transient || attempt === 2) return r;
    // 429 → the 60s window must drain; wait it out. 5xx/network → short backoff.
    await sleep(r.status === 429 ? 6000 : 800 * (attempt + 1));
  }
  return last;
}

async function chatOnce({ prompt, fileIds = [], chatId = null }) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  await rateGate();
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE}/api/ai/generate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ctx.token}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model: MODEL, provider: PROVIDER, prompt,
        files: fileIds, ...(chatId ? { chatId } : {}),
      }),
      signal: ctrl.signal,
    });
    const fallback = res.headers.get('x-sira-fallback') || null;
    if (!res.ok || !res.body) {
      const t = await res.text().catch(() => '');
      return { ok: false, status: res.status, text: '', error: t.slice(0, 300), ms: Date.now() - t0, fallback };
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let text = '';
    let resolvedModel = null;
    const events = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
        for (const line of frame.split('\n')) {
          const l = line.trim();
          if (!l.startsWith('data:')) continue;
          const data = l.slice(5).trim();
          if (data === '[DONE]') continue;
          let j; try { j = JSON.parse(data); } catch { continue; }
          if (j.type) events.push(j.type);
          if (j.type === 'model_resolved' && j.model) resolvedModel = j.model;
          if (typeof j.content === 'string') {
            if (j.replace) text = j.content; else text += j.content;
          }
        }
      }
    }
    return { ok: true, status: res.status, text: extractAnswer(text), rawText: text, ms: Date.now() - t0, fallback, resolvedModel, events };
  } catch (e) {
    return { ok: false, status: 0, text: '', error: String(e.message || e), ms: Date.now() - t0 };
  } finally {
    clearTimeout(to);
  }
}

// ── corpus ───────────────────────────────────────────────────────────────────
const { CORPUS } = require('./lib/e2e-corpus');

// ── cleanup ──────────────────────────────────────────────────────────────────
async function cleanup() {
  if (KEEP) { console.log('  (--keep) leaving test data in DB'); return; }
  const uid = ctx.user?.id;
  if (!uid) return;
  try {
    // Delete on-disk file blobs first (path stored on File rows).
    const files = await prisma.file.findMany({ where: { userId: uid }, select: { path: true } });
    for (const f of files) {
      if (f.path) { try { fs.existsSync(f.path) && fs.unlinkSync(f.path); } catch (_) {} }
    }
    await prisma.message.deleteMany({ where: { chat: { userId: uid } } }).catch(() => {});
    await prisma.chat.deleteMany({ where: { userId: uid } }).catch(() => {});
    await prisma.file.deleteMany({ where: { userId: uid } }).catch(() => {});
    await prisma.session.deleteMany({ where: { userId: uid } }).catch(() => {});
    // User cascade-deletes most relations; do it last.
    await prisma.user.delete({ where: { id: uid } }).catch(async () => {
      // Some relations may not cascade; best-effort secondary sweep then retry.
      await prisma.user.delete({ where: { id: uid } }).catch((e) => console.warn('  user delete failed:', e.message));
    });
    console.log('  ✅ cleaned up test user + all created rows/blobs');
  } catch (e) {
    console.warn('  cleanup warning:', e.message);
  }
}

// ── run ──────────────────────────────────────────────────────────────────────
const results = [];
function rec(unitId, cat, turnIdx, pass, detail, extra = {}) {
  results.push({ unitId, category: cat, turn: turnIdx, pass: pass === true, judged: pass, detail: String(detail).slice(0, 160), ...extra });
  const mark = pass === true ? '✅' : (pass === null ? '🔵' : '❌');
  process.stdout.write(`  ${mark} [${cat}] ${unitId}${turnIdx != null ? `#${turnIdx}` : ''} — ${String(detail).slice(0, 96)}\n`);
}

function resolveFiles(doc) {
  if (!doc) return [];
  const keys = Array.isArray(doc) ? doc : [doc];
  return keys.map((k) => ctx.fileIds[k]).filter(Boolean);
}

async function runUnit(unit) {
  // A "unit" is either a single-turn case or a multi-turn thread.
  const turns = unit.turns || [{ ...unit, _single: true }];
  let chatId = null;
  if (!unit._single && turns.length > 1) {
    // Multi-turn → pre-create a Chat so messages persist (context retention).
    const c = await prisma.chat.create({
      data: { userId: ctx.user.id, title: `E2E ${unit.id}`, model: MODEL || 'gpt-oss-120b' },
    });
    chatId = c.id;
    ctx.chats.push(c.id);
  }
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    const files = resolveFiles(t.doc);
    const r = await chat({ prompt: t.prompt, fileIds: files, chatId });
    if (!r.ok) {
      rec(unit.id, unit.category, turns.length > 1 ? i + 1 : null, false, `HTTP ${r.status} ${r.error || ''} (${r.ms}ms)`, { ms: r.ms, answer: '' });
      continue;
    }
    const verdict = gradeAnswer(r.text, t);
    const detail = `${r.ms}ms${r.fallback ? ` fb=${r.fallback}` : ''}${r.resolvedModel ? ` model=${r.resolvedModel}` : ''} ans="${norm(r.text).slice(0, 60)}"`;
    rec(unit.id, unit.category, turns.length > 1 ? i + 1 : null, verdict, detail, {
      ms: r.ms, answer: r.text.slice(0, 1500), expect: t.any || t.all || null, judge: !!t.judge, agentic: /agent-task-state/.test(r.rawText || ''),
    });
  }
}

async function pool(units, n) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, units.length) }, async () => {
    while (i < units.length) { const u = units[i++]; await runUnit(u); }
  });
  await Promise.all(workers);
}

async function probe() {
  // Upload one fixture and try provider/model combos to find a working free path.
  const fx = ctx._fixtures.find((f) => f.key === 'contrato');
  const up = await uploadFile(fx);
  ctx.fileIds[fx.key] = up.id;
  console.log(`  uploaded ${fx.name}: id=${up.id} chars=${up.chars}`);
  const combos = [
    { provider: 'Cerebras', model: 'gpt-oss-120b' },
    { provider: 'Cerebras', model: '__virtual_gpt_oss_120b__' },
    { provider: 'OpenRouter', model: 'meta-llama/llama-3.1-8b-instruct' },
    { provider: 'OpenRouter', model: 'openai/gpt-4o-mini' },
    { provider: 'OpenAI', model: 'gpt-4o-mini' },
    { provider: 'Gemini', model: 'gemini-1.5-flash' },
  ];
  for (const c of combos) {
    MODEL = c.model; PROVIDER = c.provider;
    const r = await chat({ prompt: '¿Cuál es la capital de Francia? Responde en una frase.', fileIds: [] });
    const ok = r.ok && norm(r.text).includes('paris');
    console.log(`  ${ok ? '✅' : '❌'} ${c.provider}/${c.model} → status=${r.status} ${r.ms}ms fb=${r.fallback || '-'} model=${r.resolvedModel || '-'} ans="${norm(r.text).slice(0, 50)}" ${r.error ? 'err=' + r.error.slice(0, 80) : ''}`);
    if (ok) { console.log(`\n  ⇒ WORKING: --provider ${c.provider} --model ${c.model}\n`); return c; }
  }
  console.log('\n  ⚠ no combo produced a correct answer; inspect errors above.\n');
  return null;
}

(async () => {
  process.stdout.write('═══ LIVE chat E2E (real docs through /api/ai/generate) ═══\n');
  // health
  try {
    const h = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(5000) });
    const hj = await h.json();
    console.log(`  backend: ${hj.status} (db=${(hj.checks || []).find((c) => c.name === 'database')?.status})`);
  } catch (e) { throw new Error(`backend not reachable at ${BASE}: ${e.message}`); }

  console.log('▶ generating fixtures…');
  const { dir, fixtures } = await generateAll();
  ctx._fixtures = fixtures;
  ctx._fixturesDir = dir;
  console.log(`  ${fixtures.length} fixtures in ${dir}`);

  console.log('▶ auth setup…');
  await setup();

  try {
    if (PROBE) { await probe(); return; }

    if (!MODEL || !PROVIDER) {
      console.log('▶ probing for a working provider/model…');
      const c = await probe();
      if (!c) throw new Error('no working provider/model found; pass --model/--provider explicitly');
    }
    console.log(`▶ using provider=${PROVIDER} model=${MODEL}`);

    console.log('▶ uploading fixtures through /api/files/upload…');
    for (const fx of fixtures) {
      if (ctx.fileIds[fx.key]) continue;
      const up = await uploadFile(fx);
      ctx.fileIds[fx.key] = up.id;
      console.log(`  ✅ ${fx.name}: id=${up.id} chars=${up.chars}${fx.mime.startsWith('image/') ? ' (OCR)' : ''}`);
      if (!up.id) throw new Error(`upload of ${fx.name} returned no id`);
    }

    // Build units: group threaded cases; keep singles standalone.
    let units = CORPUS;
    if (ONLY_CAT) units = units.filter((u) => u.category === ONLY_CAT);
    if (ONLY_IDS.length) units = units.filter((u) => ONLY_IDS.includes(u.id));
    if (LIMIT) units = units.slice(0, LIMIT);
    const totalTurns = units.reduce((a, u) => a + (u.turns ? u.turns.length : 1), 0);
    console.log(`▶ running ${units.length} units / ${totalTurns} graded turns (concurrency ${CONCURRENCY})…\n`);
    await pool(units, CONCURRENCY);
  } finally {
    console.log('\n▶ cleanup…');
    await cleanup();
    try { fs.rmSync(ctx._fixturesDir, { recursive: true, force: true }); } catch (_) {}
    await prisma.$disconnect().catch(() => {});
  }

  // ── aggregate ──
  const byCat = {};
  for (const r of results) {
    const c = byCat[r.category] || (byCat[r.category] = { pass: 0, total: 0, judge: 0 });
    if (r.judge && r.judged === null) { c.judge++; continue; }
    c.total++; if (r.pass) c.pass++;
  }
  const graded = results.filter((r) => !(r.judge && r.judged === null));
  const passed = graded.filter((r) => r.pass).length;
  const total = graded.length;
  const rate = total ? passed / total : 0;

  process.stdout.write('\n═══ Summary ═══\n');
  for (const [cat, s] of Object.entries(byCat)) {
    process.stdout.write(`  ${cat.padEnd(16)} ${s.pass}/${s.total} (${s.total ? Math.round((s.pass / s.total) * 100) : 0}%)${s.judge ? ` +${s.judge} judge-only` : ''}\n`);
  }
  process.stdout.write(`  ${'OVERALL'.padEnd(16)} ${passed}/${total} (${Math.round(rate * 100)}%) — threshold ${Math.round(THRESHOLD * 100)}%\n`);

  try {
    const reportPath = path.join(__dirname, '..', 'evals', 'live-chat-e2e-report.json');
    fs.writeFileSync(reportPath, JSON.stringify({
      generatedBy: 'run-live-chat-e2e.js', base: BASE, provider: PROVIDER, model: MODEL,
      overall: { passed, total, rate }, byCategory: byCat, results,
    }, null, 2));
    process.stdout.write(`\n📄 report → ${path.relative(path.join(__dirname, '..', '..'), reportPath)}\n`);
  } catch (e) { console.warn('report write failed:', e.message); }

  process.exit(rate >= THRESHOLD ? 0 : 1);
})().catch(async (e) => {
  console.error('\n💥 harness crashed:', e.message);
  try { await cleanup(); } catch (_) {}
  try { await prisma.$disconnect(); } catch (_) {}
  process.exit(2);
});
