'use strict';

// Render → vision-critique loop, ported from Anthropic's document skills:
// convert the generated artifact to page images with LibreOffice headless,
// then have a vision model adversarially inspect them ("assume there are
// problems — find them"). This is the automated version of the manual QA
// that caught the blank-page-1 / broken-table / half-empty-slide bugs.
//
// Doctrine: strictly best-effort. This module NEVER throws to the caller and
// NEVER turns a successful generation into a failure — worst case it returns
// { skipped: true, reason }. Budgeted, env-gated, off in tests by default.

const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const MAX_PAGES = Number(process.env.SIRAGPT_DOC_CRITIQUE_MAX_PAGES || 6);
const BUDGET_MS = Number(process.env.SIRAGPT_DOC_CRITIQUE_BUDGET_MS || 45_000);
const RENDERABLE = new Set(['docx', 'pptx', 'xlsx', 'pdf']);

let _sofficeChecked = null;
async function hasSoffice() {
  if (_sofficeChecked !== null) return _sofficeChecked;
  try {
    await execFileAsync(process.env.SOFFICE_BIN || 'soffice', ['--version'], { timeout: 10_000 });
    _sofficeChecked = true;
  } catch {
    _sofficeChecked = false;
  }
  return _sofficeChecked;
}

function critiqueEnabled(env = process.env) {
  if (String(env.NODE_ENV) === 'test' && env.SIRAGPT_DOC_CRITIQUE !== '1') return false;
  return !/^(0|false|off|no)$/i.test(String(env.SIRAGPT_DOC_CRITIQUE ?? '1').trim());
}

// soffice → PDF → pdf-to-img PNGs. Returns [{ page, png }] (Buffer), capped.
async function renderDocumentToImages(filePath, format, { maxPages = MAX_PAGES, signal } = {}) {
  const runDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'siragpt-critique-'));
  try {
    let pdfPath = filePath;
    if (format !== 'pdf') {
      await execFileAsync(process.env.SOFFICE_BIN || 'soffice', [
        '--headless', '--convert-to', 'pdf', '--outdir', runDir, filePath,
      ], { timeout: 90_000, signal });
      const produced = (await fsp.readdir(runDir)).find((f) => f.endsWith('.pdf'));
      if (!produced) throw new Error('soffice produced no PDF');
      pdfPath = path.join(runDir, produced);
    }
    // pdf-to-img is ESM-only — dynamic import from CJS.
    const { pdf } = await import('pdf-to-img');
    const doc = await pdf(pdfPath, { scale: 1.2 });
    const images = [];
    let index = 0;
    for await (const png of doc) {
      images.push({ page: ++index, png });
      if (index >= maxPages) break;
    }
    return images;
  } finally {
    try { await fsp.rm(runDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

const CRITIQUE_SYSTEM = [
  'Eres un director de arte y QA de documentos corporativos. Recibes páginas/láminas renderizadas de un documento generado.',
  'ASUME QUE HAY PROBLEMAS — tu trabajo es encontrarlos. Si no encontraste ninguno, mira otra vez.',
  'Busca específicamente: (1) páginas o mitades de página en blanco, (2) texto desbordado o cortado, (3) tablas rotas o vacías, (4) texto de sistema/meta que un humano no escribiría ("generado por", "pipeline", placeholders, lorem), (5) títulos que son ecos de la instrucción del usuario, (6) elementos solapados, (7) márgenes violados, (8) inconsistencia tipográfica o de color.',
  'Responde SOLO JSON: {"defects":[{"page":n,"defect":"...","severity":"high|medium|low","suggestion":"..."}],"overall":"pass|needs_work","summary":"una frase"}.',
  'Sé preciso: reporta solo defectos visibles reales, con la página exacta. Un documento corto y limpio SÍ puede ser un pass.',
].join('\n');

// Vision critique via the Anthropic Messages API (raw fetch — no SDK dep).
// The prod OPENAI key is dead; ANTHROPIC_API_KEY is provisioned (Codex uses it).
async function critiqueRenderedPages(images, { expectation = '', model, signal, env = process.env } = {}) {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const chosenModel = model || env.SIRAGPT_DOC_CRITIQUE_MODEL || 'claude-haiku-4-5-20251001';
  const content = [];
  for (const { page, png } of images) {
    content.push({ type: 'text', text: `Página/lámina ${page}:` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } });
  }
  content.push({
    type: 'text',
    text: `Contexto del documento: ${expectation || 'documento profesional generado a partir de una solicitud del usuario'}. Inspecciona todas las páginas y responde el JSON.`,
  });
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: chosenModel,
      max_tokens: 1200,
      system: CRITIQUE_SYSTEM,
      messages: [{ role: 'user', content }],
    }),
    signal,
  });
  if (!res.ok) throw new Error(`vision critique HTTP ${res.status}`);
  const payload = await res.json();
  const text = (payload?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  const parsed = JSON.parse(jsonMatch[0]);
  const defects = (Array.isArray(parsed.defects) ? parsed.defects : [])
    .filter((d) => d && d.defect)
    .slice(0, 12)
    .map((d) => ({
      page: Number(d.page) || 0,
      defect: String(d.defect).slice(0, 200),
      severity: /^(high|medium|low)$/.test(d.severity) ? d.severity : 'medium',
      suggestion: String(d.suggestion || '').slice(0, 200),
    }));
  return {
    defects,
    overall: parsed.overall === 'pass' ? 'pass' : 'needs_work',
    summary: String(parsed.summary || '').slice(0, 240),
    model: chosenModel,
  };
}

/**
 * Best-effort visual QA of a generated document. Returns
 *   { skipped: true, reason }                         when unavailable, or
 *   { skipped: false, pagesRendered, report, durationMs }
 * NEVER throws.
 */
async function runRenderCritique({ filePath, format, expectation = '', env = process.env } = {}) {
  const startedAt = Date.now();
  try {
    if (!critiqueEnabled(env)) return { skipped: true, reason: 'disabled' };
    if (!RENDERABLE.has(format)) return { skipped: true, reason: `format ${format} not renderable` };
    if (!env.ANTHROPIC_API_KEY) return { skipped: true, reason: 'no vision provider' };
    if (format !== 'pdf' && !(await hasSoffice())) return { skipped: true, reason: 'soffice unavailable' };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BUDGET_MS);
    try {
      const images = await renderDocumentToImages(filePath, format, { signal: controller.signal });
      if (images.length === 0) return { skipped: true, reason: 'no pages rendered' };
      const report = await critiqueRenderedPages(images, { expectation, signal: controller.signal, env });
      if (!report) return { skipped: true, reason: 'critique unparseable' };
      return { skipped: false, pagesRendered: images.length, report, durationMs: Date.now() - startedAt };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return { skipped: true, reason: err?.message?.slice(0, 160) || 'critique failed' };
  }
}

module.exports = {
  runRenderCritique,
  renderDocumentToImages,
  critiqueRenderedPages,
  critiqueEnabled,
  hasSoffice,
};
