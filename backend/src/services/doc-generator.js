/**
 * doc-generator — natural-language brief → downloadable document.
 *
 * Supported output formats:
 *   · docx   — python-docx (and docxtpl if needed): APA 7 tesis,
 *              matrices narrativas, psychometric instruments.
 *   · xlsx   — openpyxl + xlsxwriter: literary DB, Cronbach's alpha
 *              worksheets, correlation matrices.
 *   · pptx   — python-pptx: tesis defences, UPN style decks.
 *   · pdf    — reportlab / pypdf / pdfplumber: formularios rellenables,
 *              merges, extracción OCR.
 *   · svg    — pure Python string output (arch plans, diagrams).
 *
 * Pipeline mirrors viz/math/plan:
 *   1. LLM emits JSON { format, filename, title, explanation, python }.
 *   2. Python is executed in the isolated code-sandbox. The snippet
 *      writes the document to OUT_PATH and the generator
 *      appends a b64-encode tail so the bytes make it out of the
 *      sandbox before temp-dir cleanup.
 *   3. Route stitches everything into an assistant message with a
 *      file artefact: { type:'doc', format, filename, dataUrl, size }.
 */

const OpenAI = require('openai');
const { run } = require('./agents/code-sandbox');

function clientForModel(modelName) {
  if (!modelName) return { provider: 'OpenAI', client: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) };
  const m = String(modelName);
  if (/^(anthropic|x-ai|openrouter|meta-llama|deepseek|mistralai|qwen|z-ai|google|moonshotai)\//i.test(m)
      || m.includes('/gpt-oss')) {
    return {
      provider: 'OpenRouter',
      client: new OpenAI({ apiKey: process.env.OPENROUTER_API_KEY, baseURL: 'https://openrouter.ai/api/v1' }),
    };
  }
  if (m.includes('gemini')) {
    return {
      provider: 'Gemini',
      client: new OpenAI({ apiKey: process.env.GEMINI_API_KEY, baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/' }),
    };
  }
  return { provider: 'OpenAI', client: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) };
}

const SYSTEM_PROMPT = `You are a senior technical writer + document engineer for the siraGPT assistant.

You must produce a self-contained JSON object (no fences, no prose) with this shape:

{
  "format": "docx" | "xlsx" | "pptx" | "pdf" | "svg",
  "filename": string,      // short, no spaces preferred, no extension needed — the extension is added from "format"
  "title": string,         // user-language short title shown above the artefact
  "explanation": string,   // 1-3 short sentences describing what the document contains
  "python": string         // self-contained Python 3 snippet that writes the document to OUT_PATH
}

Rules for the Python snippet:
- The constant OUT_PATH is already defined in the environment (set by the generator — a path to /tmp ending in the correct extension). DO NOT redefine it and DO NOT print the path. Just write the file there.
- Imports are your responsibility. Available libraries on the sandbox:
    · python-docx (from docx import Document), docxtpl
    · openpyxl (from openpyxl import Workbook), xlsxwriter
    · python-pptx (from pptx import Presentation, pptx.util.Inches, pptx.util.Pt)
    · reportlab (from reportlab.lib.pagesizes import letter, A4; from reportlab.pdfgen import canvas; reportlab.platypus)
    · pypdf, pdfplumber, PIL
  Don't import things you don't use — cold-start cost on pandas/scipy is high, not on document libs but still keep it lean.
- Embed ALL data the user mentioned; fabricate realistic sample values when the user's brief is vague, and note so in "explanation".
- Style: clean, professional. docx/pptx default fonts: Calibri/Inter. APA 7 when the user asks. No lorem ipsum.
- Keep the snippet under 120 lines. Don't print anything to stdout — the generator captures the file bytes, not stdout.
- Respond in the user's language (default Spanish) for title and explanation; the document content itself follows the user's brief language.

Pick format:
- "docx"  → informes, tesis, memos, instrumentos de evaluación, matrices narrativas, cartas.
- "xlsx"  → tablas, bases de datos, hojas de cálculo, matrices Likert, análisis estadístico.
- "pptx"  → presentaciones, defensas, pitch decks.
- "pdf"   → documentos de una sola vista (formularios, facturas, certificados, A4 académico con tabla) cuando el usuario explícitamente pide PDF.
- "svg"   → mapas / diagramas / planos cuando el usuario pide un archivo vectorial imprimible.

Return ONE JSON object, no fences.`;

function extractJson(raw) {
  if (!raw) throw new Error('empty');
  const tries = [raw];
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  tries.push(stripped);
  const i = stripped.indexOf('{');
  const j = stripped.lastIndexOf('}');
  if (i >= 0 && j > i) tries.push(stripped.slice(i, j + 1));
  let lastErr;
  for (const t of tries) { try { return JSON.parse(t); } catch (e) { lastErr = e; } }
  throw new Error(`JSON parse failed: ${lastErr?.message}`);
}

const EXT_MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
  svg: 'image/svg+xml',
};

async function callLlm({ prompt, model, signal }) {
  const routed = clientForModel(model);
  if (!routed.client) throw new Error(`doc-generator: no API key for "${model}"`);
  const callModel = async (useJsonMode) => {
    const params = {
      model: model || 'gpt-4o',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 4000,
    };
    if (useJsonMode && routed.provider !== 'Gemini') params.response_format = { type: 'json_object' };
    return routed.client.chat.completions.create(params, { signal });
  };
  let resp;
  try { resp = await callModel(true); }
  catch (err) {
    if (/response_format|json_object|invalid.*param/i.test(err?.message || '')) resp = await callModel(false);
    else throw err;
  }
  return extractJson(resp.choices?.[0]?.message?.content || '');
}

function sanitiseFilename(name, ext) {
  const base = String(name || 'document').replace(/[^\w.\-]+/g, '_').replace(/\.+$/, '').slice(0, 80) || 'document';
  if (base.toLowerCase().endsWith(`.${ext}`)) return base;
  return `${base}.${ext}`;
}

async function renderDocument({ parsed }) {
  const format = parsed.format;
  if (!EXT_MIME[format]) {
    return { ok: false, error: `Formato no soportado: ${format}` };
  }
  const python = parsed.python;
  if (!python || !python.trim()) {
    return { ok: false, error: 'El modelo no entregó código Python' };
  }
  // OUT_PATH is injected as a local variable the snippet can use
  // unmodified. After the snippet finishes, we read-and-base64 the
  // bytes back to stdout so they escape the sandbox temp dir.
  const outName = `doc-out.${format}`;
  const instrumented = `
OUT_PATH = "${outName}"

${python}

import base64, os, sys
try:
    with open(OUT_PATH, "rb") as _f:
        _b = _f.read()
    sys.stdout.write("__DOC_B64__" + base64.b64encode(_b).decode("ascii"))
except Exception as _e:
    sys.stderr.write("failed to read OUT_PATH: " + repr(_e))
`;
  const result = await run({ language: 'python', source: instrumented, timeoutMs: 25_000 });
  if (result.timedOut) return { ok: false, error: 'timeout' };
  const out = result.stdout || '';
  const marker = out.lastIndexOf('__DOC_B64__');
  if (marker === -1) {
    return { ok: false, error: result.stderr || 'no file produced', stderr: result.stderr };
  }
  const b64 = out.slice(marker + '__DOC_B64__'.length).trim();
  const size = Math.floor(b64.length * 0.75); // approximate byte count
  const filename = sanitiseFilename(parsed.filename || parsed.title || 'document', format);
  const mime = EXT_MIME[format];
  return {
    ok: true,
    dataUrl: `data:${mime};base64,${b64}`,
    mime,
    filename,
    size,
    stderr: result.stderr,
  };
}

function buildArtefact({ parsed, rendered, renderError }) {
  const { format, title, explanation } = parsed;
  const file = {
    type: 'doc',
    format,
    title: title || 'Documento',
    explanation: explanation || '',
    filename: rendered?.filename || sanitiseFilename(parsed.filename || title, format),
    dataUrl: rendered?.dataUrl || null,
    mime: rendered?.mime || EXT_MIME[format],
    size: rendered?.size || 0,
    pythonCode: parsed.python,
    error: renderError || null,
  };
  const contentLines = [
    `**${title || 'Documento'}**`,
    '',
    explanation || '',
  ];
  if (renderError) {
    contentLines.push('', `_⚠ No fue posible generar el archivo:_ \`${renderError.slice(0, 200)}\``);
  }
  return { content: contentLines.filter(Boolean).join('\n'), file };
}

async function generateDoc({ prompt, model, signal }) {
  const parsed = await callLlm({ prompt, model, signal });
  let rendered = null;
  let renderError = null;
  const r = await renderDocument({ parsed });
  if (r.ok) rendered = r;
  else renderError = r.error || 'unknown error';
  const { content, file } = buildArtefact({ parsed, rendered, renderError });
  return { parsed, content, file, renderError };
}

async function* streamDoc({ prompt, model, signal }) {
  yield { type: 'stage', label: 'Analizando la solicitud', pct: 5 };
  let parsed;
  try {
    yield { type: 'stage', label: 'Eligiendo formato', pct: 15 };
    parsed = await callLlm({ prompt, model, signal });
  } catch (err) {
    if (err?.name === 'AbortError') { yield { type: 'error', error: 'aborted' }; return; }
    yield { type: 'error', error: err?.message || 'LLM failed' };
    return;
  }
  yield { type: 'stage', label: `Compilando .${parsed.format}`, pct: 55 };
  const r = await renderDocument({ parsed });
  if (!r.ok) {
    yield { type: 'error', error: r.error || 'render failed' };
    return;
  }
  yield { type: 'stage', label: 'Documento listo', pct: 95 };
  const { content, file } = buildArtefact({ parsed, rendered: r });
  yield { type: 'final', content, file, format: parsed.format };
}

module.exports = { generateDoc, streamDoc, clientForModel };
