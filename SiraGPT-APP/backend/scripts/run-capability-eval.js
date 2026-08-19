#!/usr/bin/env node
'use strict';

/**
 * run-capability-eval.js — REPRESENTATIVE, honest, end-to-end capability eval.
 *
 * What this IS:
 *   - A repeatable, objective pass/fail signal across categories, run through
 *     the REAL pipeline: document text extraction (fileProcessor.processFile —
 *     the same code the chat uses for Word/PDF/image) + the REAL AI provider
 *     (FlashGPT / Cerebras) for reasoning / multilingual / coding Q&A, graded
 *     deterministically (expected-substring match).
 *
 * What this is NOT:
 *   - NOT the official industry benchmarks (SWE-bench Pro/Verified,
 *     Terminal-Bench, OSWorld, BrowseComp, MCP-Atlas, CyberGym, Finance Agent,
 *     HLE, GPQA Diamond, CharXiv, MMMLU). Those are gated datasets that require
 *     their own harnesses/sandboxes and measure the underlying model, not this
 *     app. This script does not claim or simulate those scores.
 *
 * Categories:
 *   - doc-extraction (deterministic, no AI): txt + md + PNG(OCR) + real
 *     docx/pdf fixtures → assert non-trivial extraction (+ known substrings
 *     for generated fixtures).
 *   - reasoning | multilingual | coding (AI): from evals/capability-cases.json.
 *
 * Usage:
 *   node backend/scripts/run-capability-eval.js [--no-ai] [--docs a.docx,b.pdf]
 * Exit code: 0 if overall pass-rate >= THRESHOLD (default 0.6), else 1.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

try { require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env.local') }); } catch (_) {}
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); } catch (_) {}

const THRESHOLD = Number(process.env.CAPABILITY_EVAL_THRESHOLD) || 0.6;
const args = process.argv.slice(2);
const NO_AI = args.includes('--no-ai');
const docsArg = (() => { const i = args.indexOf('--docs'); return i >= 0 ? (args[i + 1] || '') : ''; })();

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const results = [];
function record(category, id, pass, detail) {
  results.push({ category, id, pass: !!pass, detail: String(detail || '').slice(0, 140) });
  process.stdout.write(`  ${pass ? '✅' : '❌'} [${category}] ${id} — ${String(detail || '').slice(0, 90)}\n`);
}

// ── Fixtures (generated, portable) ───────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-eval-'));
function writeFixture(name, content) {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, content);
  return p;
}
function makePngWithText(name, text) {
  const { createCanvas } = require('canvas');
  const c = createCanvas(640, 200);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 640, 200);
  ctx.fillStyle = '#000000'; ctx.font = 'bold 64px DejaVu Sans, Arial, sans-serif';
  ctx.fillText(text, 30, 120);
  const p = path.join(tmp, name);
  fs.writeFileSync(p, c.toBuffer('image/png'));
  return p;
}

async function runDocExtraction() {
  process.stdout.write('\n▶ doc-extraction (real pipeline — fileProcessor.processFile)\n');
  const fileProcessor = require('../src/services/fileProcessor');

  const TXT = 'CAPEVAL-MARKER-9173. Documento de prueba: el nivel de estrés afecta la calidad del sueño.';
  const cases = [
    { f: writeFixture('sample.txt', TXT), mime: 'text/plain', mustContain: ['CAPEVAL-MARKER-9173'] },
    { f: writeFixture('sample.md', `# Título de prueba\n\n${TXT}\n`), mime: 'text/markdown', mustContain: ['CAPEVAL-MARKER-9173'] },
  ];
  // PNG OCR (image transcription)
  try {
    const png = makePngWithText('ocr.png', 'EVAL 7421');
    cases.push({ f: png, mime: 'image/png', mustContain: ['7421'], ocr: true, lenient: true });
  } catch (e) {
    record('doc-extraction', 'png-ocr', false, `canvas/PNG fixture failed: ${e.message}`);
  }

  // Real docx/pdf: explicit --docs, else auto-discover in uploads/agent-artifacts.
  let realDocs = docsArg ? docsArg.split(',').map((s) => s.trim()).filter(Boolean) : [];
  if (realDocs.length === 0) {
    const dir = path.join(__dirname, '..', '..', 'uploads', 'agent-artifacts');
    try {
      const found = fs.readdirSync(dir)
        .filter((n) => /\.(docx|pdf)$/i.test(n))
        .map((n) => path.join(dir, n));
      const docx = found.find((p) => /\.docx$/i.test(p));
      const pdf = found.find((p) => /\.pdf$/i.test(p));
      realDocs = [docx, pdf].filter(Boolean);
    } catch (_) { /* none */ }
  }
  for (const p of realDocs) {
    const mime = /\.pdf$/i.test(p) ? 'application/pdf'
      : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    cases.push({ f: p, mime, mustContain: [], lenient: true });
  }

  for (const c of cases) {
    const id = path.basename(c.f);
    try {
      const size = fs.statSync(c.f).size;
      const out = await fileProcessor.processFile({ mimetype: c.mime, path: c.f, originalname: id, size });
      const text = (out && out.extractedText) || '';
      const okLen = c.lenient ? text.trim().length >= 8 : text.trim().length >= 20;
      const okContains = (c.mustContain || []).every((s) => norm(text).includes(norm(s)));
      const pass = !!(out && out.success !== false) && okLen && okContains;
      record('doc-extraction', id, pass,
        `${size}B → ${text.trim().length} chars extracted${c.mustContain && c.mustContain.length ? `, hasMarker=${okContains}` : ''}${c.ocr ? ' (OCR)' : ''}`);
    } catch (e) {
      record('doc-extraction', id, false, `threw: ${e.message}`);
    }
  }
}

async function runAi() {
  process.stdout.write('\n▶ reasoning / multilingual / coding (real AI — FlashGPT/Cerebras)\n');
  const { createCerebrasClient, getCerebrasConfig, isFreeIaConfigured } = require('../src/services/ai/cerebras-client');
  if (!isFreeIaConfigured()) {
    process.stdout.write('  ⚠ AI provider not configured (CEREBRAS_API_KEY missing) — skipping AI categories.\n');
    return;
  }
  const client = createCerebrasClient();
  const cfg = getCerebrasConfig();
  // The configured FREE_IA_MODEL_ID may not exist on this account (e.g. a
  // llama-* id 404s while the account only serves gpt-oss/zai). Resolve a
  // real, available model from the live models list — prefer the strongest.
  let model = cfg.model || 'llama3.1-8b';
  try {
    const list = await client.models.list();
    const ids = (list.data || list || []).map((m) => m.id).filter(Boolean);
    if (ids.length) {
      const pref = ['gpt-oss-120b', 'llama-3.3-70b', 'zai-glm-4.7'];
      model = pref.find((p) => ids.includes(p)) || (ids.includes(model) ? model : ids[0]);
      process.stdout.write(`  (using model: ${model}; available: ${ids.join(', ')})\n`);
    }
  } catch (e) {
    process.stdout.write(`  (models.list failed: ${e.message}; trying configured "${model}")\n`);
  }
  const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'evals', 'capability-cases.json'), 'utf8'));
  for (const cse of corpus.ai) {
    try {
      const resp = await client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: 'You are a precise evaluator. Answer in the exact short form requested, nothing else.' },
          { role: 'user', content: cse.q },
        ],
        temperature: 0,
        // Reasoning models (gpt-oss) spend tokens on hidden reasoning before
        // the final answer; a tiny cap leaves the answer empty/truncated.
        max_tokens: 2048,
      });
      const msg = resp.choices?.[0]?.message || {};
      const ans = norm(msg.content || msg.reasoning_content || msg.reasoning || '');
      const pass = (cse.expectAny || []).some((e) => ans.includes(norm(e)));
      record(cse.category, cse.id, pass, `ans="${ans.slice(0, 50)}" expect=${JSON.stringify(cse.expectAny)}`);
    } catch (e) {
      record(cse.category, cse.id, false, `AI call failed: ${e.message}`);
    }
  }
}

(async () => {
  process.stdout.write('═══ Representative capability eval (NOT official benchmarks) ═══\n');
  await runDocExtraction();
  if (!NO_AI) { await runAi(); } else { process.stdout.write('\n(skipping AI categories: --no-ai)\n'); }

  // Aggregate
  const byCat = {};
  for (const r of results) {
    byCat[r.category] = byCat[r.category] || { pass: 0, total: 0 };
    byCat[r.category].total++; if (r.pass) byCat[r.category].pass++;
  }
  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  const rate = total ? passed / total : 0;

  process.stdout.write('\n═══ Summary ═══\n');
  for (const [cat, s] of Object.entries(byCat)) {
    process.stdout.write(`  ${cat.padEnd(16)} ${s.pass}/${s.total} (${Math.round((s.pass / s.total) * 100)}%)\n`);
  }
  process.stdout.write(`  ${'OVERALL'.padEnd(16)} ${passed}/${total} (${Math.round(rate * 100)}%) — threshold ${Math.round(THRESHOLD * 100)}%\n`);

  try {
    const reportPath = path.join(__dirname, '..', 'evals', 'last-report.json');
    fs.writeFileSync(reportPath, JSON.stringify({ generatedBy: 'run-capability-eval.js', overall: { passed, total, rate }, byCategory: byCat, results }, null, 2));
    process.stdout.write(`\n📄 report → ${path.relative(path.join(__dirname, '..', '..'), reportPath)}\n`);
  } catch (_) {}

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  process.exit(rate >= THRESHOLD ? 0 : 1);
})().catch((e) => { console.error('eval crashed:', e); process.exit(2); });
