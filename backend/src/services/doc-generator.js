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

const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const { run } = require('./agents/code-sandbox');

// ─── Style bundle — loaded once at boot ──────────────────────────────────
//
// The generator drops these Python modules into the sandbox temp dir
// (via the existing `files` option on run()) so the LLM-emitted main.py
// can `from sgpt_docx import ...` without worrying about fonts, APA
// rules, palettes, or pagination. This is what turns LLM output from
// "serviceable" into "extremadamente profesional".

const TEMPLATE_DIR = path.join(__dirname, 'doc-templates');
function _loadTemplate(name) {
  try { return fs.readFileSync(path.join(TEMPLATE_DIR, name), 'utf8'); }
  catch { return ''; }
}
const TEMPLATES = {
  'sgpt_docx.py': _loadTemplate('sgpt_docx.py'),
  'sgpt_xlsx.py': _loadTemplate('sgpt_xlsx.py'),
  'sgpt_pptx.py': _loadTemplate('sgpt_pptx.py'),
  'sgpt_pdf.py':  _loadTemplate('sgpt_pdf.py'),
};

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

const SYSTEM_PROMPT = `You are a senior technical writer + document engineer for the siraGPT assistant. Your output must feel like it came from a professional designer — not a minimally-working Python script.

Return a self-contained JSON object (no fences, no prose before or after):

{
  "format": "docx" | "xlsx" | "pptx" | "pdf" | "svg",
  "filename": string,
  "title": string,         // user-language short title shown above the artefact
  "explanation": string,   // 1-3 short sentences describing what the document contains
  "python": string         // self-contained Python 3 snippet that writes the file to OUT_PATH
}

=== SANDBOX CONVENTIONS ===
- The constant OUT_PATH is defined before your code runs. Just write the file there and DO NOT print anything.
- Available libraries already installed on the host:
    python-docx + docxtpl · openpyxl + xlsxwriter · python-pptx · reportlab + pypdf + pdfplumber · PIL
    (sympy / numpy / scipy / pandas / matplotlib / seaborn also available when you need them)
- You MUST import every library you use at the top of your snippet.

=== STYLE BUNDLE — use this instead of hand-rolling styles ===

siraGPT ships a curated Python style bundle that is placed next to your
script in the sandbox. Import from it whenever possible so output is
visually consistent, on-brand, and academically correct. The bundle:

  sgpt_docx  — APA 7 / tesis-grade Word documents
  sgpt_xlsx  — corporate Excel workbooks + psychometric analytics
  sgpt_pptx  — presentation decks (tesis UPN, defence, pitch)
  sgpt_pdf   — letterheaded PDF reports + rellenable forms

-------- sgpt_docx API (APA 7) --------
  from sgpt_docx import (
      apa_document, apa_cover, apa_page_break,
      apa_heading, apa_paragraph, apa_table, apa_references,
      apa_table_of_contents,
      instrument_bai, instrument_whoqol_bref, instrument_phq9, instrument_gad7,
  )
  doc = apa_document()                                 # TNR 12 pt · doble interlineado · márgenes 2.54 cm · header con número de página
  apa_cover(doc, title="...", author="...", institution="...", course=None, professor=None, date=None, degree=None)
  apa_heading(doc, 1..5, text)                         # level 1: centered bold · 2: left bold · 3: left bold italic · 4/5: sangría 1.27 cm
  apa_paragraph(doc, text, first_line_indent=True, italic=False, bold=False, center=False)   # justificado por defecto
  apa_table(doc, headers=[...], rows=[[...]], caption_number="1", caption_title="...", note="...")
  apa_references(doc, ["Autor, A. A. (2020). Título. ...", ...])
  apa_table_of_contents(doc)                           # inserta campo TOC — el usuario lo refresca al abrir
  # instrumentos psicológicos listos:
  instrument_bai(doc); instrument_whoqol_bref(doc); instrument_phq9(doc); instrument_gad7(doc)
  doc.save(OUT_PATH)

-------- sgpt_xlsx API --------
  from sgpt_xlsx import (
      corporate_workbook, write_table, add_likert_validation, add_color_scale,
      cronbach_alpha, spearman, spearman_matrix, descriptives,
      build_likert_db, build_cronbach_sheet, build_spearman_sheet, add_bar_chart,
  )
  wb = corporate_workbook(); ws = wb.active; ws.title = "Datos"
  write_table(ws, headers=[...], rows=[[...]], title="...", freeze_header=True, alt_rows=True,
              number_formats={"Salario": "$#,##0.00"}, autofit=True)
  add_likert_validation(ws, "E", first_row=2, last_row=31, scale="1-5")
  add_color_scale(ws, "B2:F31")
  build_likert_db(wb, sheet_name="Respuestas", headers=[...], likert_cols=[...], n_rows=30)
  build_cronbach_sheet(wb, sheet_name="Fiabilidad", responses=[[...], ...], label="BAI")
  build_spearman_sheet(wb, sheet_name="Correlaciones", df_like={"A":[...], "B":[...]})
  add_bar_chart(ws, title="...", data_range="Datos!$B$1:$D$11", categories_range="Datos!$A$2:$A$11", anchor_cell="H2")
  wb.save(OUT_PATH)

-------- sgpt_pptx API --------
  from sgpt_pptx import Deck
  d = Deck(title="Defensa de Tesis", subtitle="...", author="...", institution="UPN", date="2025", palette="tesis_upn")
  d.cover()
  d.agenda(["Introducción", "Metodología", "Resultados", "Discusión", "Conclusiones"])
  d.section("1. Introducción", subtitle="Planteamiento del problema")
  d.text_slide("Objetivos", ["Objetivo 1", "Objetivo 2"], kicker="Capítulo 1", notes="Speaker notes…")
  d.two_column("Comparación", left_title="Antes", left=[...], right_title="Después", right=[...])
  d.big_stat("68%", "reducción de tiempos con SMED", caption="n = 42 corridas")
  d.quote("Cita memorable", attribution="Autor, 2024")
  d.thanks("Gracias.", contact="luis@siragpt")
  d.save(OUT_PATH)
  # Palettes: "tesis_upn" (navy + cream + terracotta), "defense" (neutral + indigo), "pitch" (dark + orange).
  # Every slide already has a footer bar with the project title + page number.

-------- sgpt_pdf API --------
  from sgpt_pdf import PdfReport, build_form_pdf, merge_pdfs, split_pdf, extract_text
  r = PdfReport(title="Informe mensual", author="Luis Carrera", palette="academic")   # palettes: academic / corporate / clean
  r.cover(subtitle="Q3 2025", author="Luis Carrera", institution="UPN", date="octubre 2025")
  r.h1("Resumen ejecutivo", kicker="Sección 1")
  r.body("Párrafo justificado con tipografía profesional.")
  r.bullets(["Punto 1", "Punto 2"])
  r.table(headers=["Mes","Ventas","%"], rows=[["Ene","12 400","+8%"]], title="Ventas por mes", note="Datos preliminares.")
  r.page_break(); r.h2("Anexo A")
  r.build(OUT_PATH)
  # For rellenable forms use build_form_pdf(OUT_PATH, title=..., fields=[{"name":"nombre","label":"Nombre:","y":5,"width":10}, ...])

=== FORMAT PICKING ===
- docx → tesis, informes APA, memos, matrices narrativas, instrumentos psicológicos.
- xlsx → bases de datos Likert, Cronbach, Spearman, matrices descriptivas.
- pptx → defensas de tesis, presentaciones académicas o pitch.
- pdf  → reportes letterheaded de una sola vista, formularios rellenables, certificados.
- svg  → mapas / diagramas / planos imprimibles.

=== QUALITY BAR ===
- NEVER hand-roll fonts, margins, or colours if a helper exists — use the bundle.
- For "tesis APA 7" ALWAYS start with apa_document() + apa_cover() and use apa_heading() / apa_paragraph().
- For "Cronbach" or "Spearman" ALWAYS use the sgpt_xlsx analytics helpers.
- For "defensa" or "presentación UPN" ALWAYS use Deck(palette="tesis_upn").
- Embed REAL data when the user supplied it; otherwise fabricate plausible sample data and note so in "explanation".
- No "Lorem ipsum". No placeholder [NAME]. Fill every field with a realistic value.
- Keep the snippet < 160 lines. Code must be complete — no TODO or "add more here".

Return exactly ONE JSON object.`;

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
  const result = await run({
    language: 'python',
    source: instrumented,
    timeoutMs: 30_000,
    files: TEMPLATES,   // drop sgpt_docx.py / sgpt_xlsx.py / sgpt_pptx.py / sgpt_pdf.py next to main.py
  });
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
