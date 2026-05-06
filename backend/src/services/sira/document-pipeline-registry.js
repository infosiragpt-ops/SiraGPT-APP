"use strict";

/**
 * document-pipeline-registry — declarative map of which library/binary
 * Sira chooses for every document operation.
 *
 *   Parsers (mime/ext  →  parser)
 *     PDF                  Docling > LlamaParse > MinerU > PyMuPDF > pdfplumber > pypdf
 *     DOCX                 Mammoth (HTML) > python-docx (structure) > Docling
 *     XLSX/CSV             ExcelJS > openpyxl > pandas
 *     PPTX                 python-pptx > Docling
 *     HTML/Markdown        MarkItDown > unified+rehype
 *     Image (OCR)          Tesseract > PaddleOCR > EasyOCR
 *
 *   Generators (format  →  generator)
 *     DOCX                 python-docx + docxtpl  ·  docx (JS)  ·  docxtemplater (JS)
 *     XLSX                 ExcelJS  ·  XlsxWriter  ·  openpyxl
 *     PPTX                 PptxGenJS  ·  python-pptx
 *     PDF                  WeasyPrint  ·  Playwright (HTML→PDF)  ·  ReportLab  ·  PDFKit  ·  pdf-lib
 *     SVG                  Sharp (rasterise)  ·  resvg  ·  canvg
 *     HTML→PDF             Playwright (preferred)  ·  WeasyPrint  ·  wkhtmltopdf
 *     Markdown             markdown-it · marked
 *     LaTeX                Pandoc · Tectonic · Quarto
 *
 * The registry is queryable: caller passes mime/ext → gets a list of
 * preferred parsers in order. The dispatcher tries them one by one
 * until one succeeds. Every choice carries metadata (license, runtime
 * dep, binary required, OCR support) so the platform can refuse a
 * step if the runtime can't satisfy it.
 *
 * Pure JS, deterministic, zero deps.
 */

const PARSERS = Object.freeze([
  // ── PDF ────────────────────────────────────────────────────────
  { id: "docling",      formats: ["pdf"],            language: "python", runtime: "binary",   ocr: true,  layout: true,  tables: true,  formulas: true,  reading_order: true,  preference: 100 },
  { id: "llamaparse",   formats: ["pdf"],            language: "python", runtime: "saas",     ocr: true,  layout: true,  tables: true,  formulas: false, reading_order: true,  preference: 95 },
  { id: "mineru",       formats: ["pdf","docx","pptx","xlsx","image"], language: "python", runtime: "binary", ocr: true, layout: true, tables: true, formulas: true, reading_order: true, preference: 92 },
  { id: "pymupdf",      formats: ["pdf"],            language: "python", runtime: "library",  ocr: false, layout: true,  tables: false, formulas: false, reading_order: true,  preference: 85 },
  { id: "pdfplumber",   formats: ["pdf"],            language: "python", runtime: "library",  ocr: false, layout: true,  tables: true,  formulas: false, reading_order: true,  preference: 80 },
  { id: "pypdf",        formats: ["pdf"],            language: "python", runtime: "library",  ocr: false, layout: false, tables: false, formulas: false, reading_order: false, preference: 60 },
  { id: "marker",       formats: ["pdf"],            language: "python", runtime: "binary",   ocr: true,  layout: true,  tables: true,  formulas: true,  reading_order: true,  preference: 88 },

  // ── DOCX ───────────────────────────────────────────────────────
  { id: "mammoth",      formats: ["docx"],           language: "node",   runtime: "library",  ocr: false, layout: true,  tables: true,  formulas: false, reading_order: true,  preference: 90 },
  { id: "python-docx",  formats: ["docx"],           language: "python", runtime: "library",  ocr: false, layout: true,  tables: true,  formulas: false, reading_order: true,  preference: 88 },
  { id: "docx2txt",     formats: ["docx"],           language: "python", runtime: "library",  ocr: false, layout: false, tables: false, formulas: false, reading_order: false, preference: 60 },

  // ── XLSX / CSV ─────────────────────────────────────────────────
  { id: "exceljs",      formats: ["xlsx","csv"],      language: "node", runtime: "library", ocr: false, layout: false, tables: true, formulas: true, reading_order: false, preference: 92 },
  { id: "openpyxl",     formats: ["xlsx"],           language: "python", runtime: "library",  ocr: false, layout: false, tables: true,  formulas: true,  reading_order: false, preference: 90 },
  { id: "pandas",       formats: ["xlsx","csv"],     language: "python", runtime: "library",  ocr: false, layout: false, tables: true,  formulas: false, reading_order: false, preference: 85 },

  // ── PPTX ───────────────────────────────────────────────────────
  { id: "python-pptx",  formats: ["pptx"],           language: "python", runtime: "library",  ocr: false, layout: true,  tables: true,  formulas: false, reading_order: true,  preference: 90 },

  // ── HTML / Markdown ────────────────────────────────────────────
  { id: "markitdown",   formats: ["html","htm","md","docx","pptx","xlsx","pdf"], language: "python", runtime: "library", ocr: false, layout: true, tables: true, formulas: false, reading_order: true, preference: 85 },
  { id: "unified",      formats: ["md","html"],      language: "node",   runtime: "library",  ocr: false, layout: false, tables: true,  formulas: false, reading_order: true,  preference: 80 },

  // ── OCR ────────────────────────────────────────────────────────
  { id: "tesseract",    formats: ["image","pdf"],    language: "binary", runtime: "binary",   ocr: true,  layout: false, tables: false, formulas: false, reading_order: false, preference: 75 },
  { id: "paddleocr",    formats: ["image","pdf"],    language: "python", runtime: "library",  ocr: true,  layout: true,  tables: true,  formulas: false, reading_order: true,  preference: 88 },
  { id: "easyocr",      formats: ["image","pdf"],    language: "python", runtime: "library",  ocr: true,  layout: false, tables: false, formulas: false, reading_order: false, preference: 80 },
]);

const GENERATORS = Object.freeze([
  // ── DOCX ───────────────────────────────────────────────────────
  { id: "python-docx",       format: "docx",  language: "python", runtime: "library", template_support: false, mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", preference: 92 },
  { id: "docxtpl",           format: "docx",  language: "python", runtime: "library", template_support: true,  mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", preference: 90 },
  { id: "docx-js",           format: "docx",  language: "node",   runtime: "library", template_support: false, mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", preference: 85 },
  { id: "docxtemplater",     format: "docx",  language: "node",   runtime: "library", template_support: true,  mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", preference: 88 },

  // ── XLSX ───────────────────────────────────────────────────────
  { id: "exceljs",           format: "xlsx",  language: "node",   runtime: "library", template_support: false, mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", preference: 92 },
  { id: "xlsxwriter",        format: "xlsx",  language: "python", runtime: "library", template_support: false, mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", preference: 90 },
  { id: "openpyxl",          format: "xlsx",  language: "python", runtime: "library", template_support: false, mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", preference: 88 },

  // ── PPTX ───────────────────────────────────────────────────────
  { id: "pptxgenjs",         format: "pptx",  language: "node",   runtime: "library", template_support: false, mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", preference: 92 },
  { id: "python-pptx",       format: "pptx",  language: "python", runtime: "library", template_support: false, mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", preference: 90 },

  // ── PDF ────────────────────────────────────────────────────────
  { id: "playwright-pdf",    format: "pdf",   language: "node",   runtime: "binary",  template_support: false, mime: "application/pdf", preference: 92 },
  { id: "weasyprint",        format: "pdf",   language: "python", runtime: "library", template_support: false, mime: "application/pdf", preference: 90 },
  { id: "reportlab",         format: "pdf",   language: "python", runtime: "library", template_support: false, mime: "application/pdf", preference: 85 },
  { id: "pdfkit",            format: "pdf",   language: "node",   runtime: "library", template_support: false, mime: "application/pdf", preference: 82 },
  { id: "pdf-lib",           format: "pdf",   language: "node",   runtime: "library", template_support: false, mime: "application/pdf", preference: 80 },
  { id: "wkhtmltopdf",       format: "pdf",   language: "binary", runtime: "binary",  template_support: false, mime: "application/pdf", preference: 75 },

  // ── SVG / image ────────────────────────────────────────────────
  { id: "sharp",             format: "png",   language: "node",   runtime: "library", template_support: false, mime: "image/png", preference: 92 },
  { id: "resvg",             format: "svg",   language: "binary", runtime: "binary",  template_support: false, mime: "image/svg+xml", preference: 88 },
  { id: "canvg",             format: "svg",   language: "node",   runtime: "library", template_support: false, mime: "image/svg+xml", preference: 80 },

  // ── HTML / Markdown ────────────────────────────────────────────
  { id: "markdown-it",       format: "html",  language: "node",   runtime: "library", template_support: false, mime: "text/html", preference: 90 },
  { id: "marked",            format: "html",  language: "node",   runtime: "library", template_support: false, mime: "text/html", preference: 88 },

  // ── LaTeX ──────────────────────────────────────────────────────
  { id: "pandoc",            format: "tex",   language: "binary", runtime: "binary",  template_support: false, mime: "application/x-tex", preference: 95 },
  { id: "tectonic",          format: "pdf",   language: "binary", runtime: "binary",  template_support: false, mime: "application/pdf", preference: 88 },
  { id: "quarto",            format: "pdf",   language: "binary", runtime: "binary",  template_support: true,  mime: "application/pdf", preference: 87 },

  // ── Plain text / data ──────────────────────────────────────────
  { id: "text-writer",       format: "txt",   language: "node",   runtime: "library", template_support: false, mime: "text/plain", preference: 95 },
  { id: "json-writer",       format: "json",  language: "node",   runtime: "library", template_support: false, mime: "application/json", preference: 95 },
  { id: "csv-writer",        format: "csv",   language: "node",   runtime: "library", template_support: false, mime: "text/csv", preference: 92 },
  { id: "yaml-writer",       format: "yaml",  language: "node",   runtime: "library", template_support: false, mime: "application/yaml", preference: 90 },
  { id: "xml-writer",        format: "xml",   language: "node",   runtime: "library", template_support: false, mime: "application/xml", preference: 88 },

  // ── Office alternatives (RTF / ODT / EPUB) ─────────────────────
  { id: "pandoc-rtf",        format: "rtf",   language: "binary", runtime: "binary",  template_support: false, mime: "application/rtf", preference: 90 },
  { id: "rtf-writer",        format: "rtf",   language: "node",   runtime: "library", template_support: false, mime: "application/rtf", preference: 80 },
  { id: "pandoc-odt",        format: "odt",   language: "binary", runtime: "binary",  template_support: false, mime: "application/vnd.oasis.opendocument.text", preference: 90 },
  { id: "odfpy",             format: "odt",   language: "python", runtime: "library", template_support: false, mime: "application/vnd.oasis.opendocument.text", preference: 85 },
  { id: "pandoc-epub",       format: "epub",  language: "binary", runtime: "binary",  template_support: false, mime: "application/epub+zip", preference: 92 },
  { id: "epub-gen",          format: "epub",  language: "node",   runtime: "library", template_support: false, mime: "application/epub+zip", preference: 85 },
]);

const MIME_TO_FORMAT = Object.freeze({
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.ms-powerpoint": "ppt",
  "text/csv": "csv",
  "text/html": "html",
  "text/markdown": "md",
  "image/png": "image",
  "image/jpeg": "image",
  "image/jpg": "image",
  "image/webp": "image",
  "image/gif": "image",
  "image/svg+xml": "svg",
  "text/plain": "txt",
  "application/json": "json",
  "application/xml": "xml",
  "text/xml": "xml",
  "application/yaml": "yaml",
  "text/yaml": "yaml",
  "application/rtf": "rtf",
  "text/rtf": "rtf",
  "application/vnd.oasis.opendocument.text": "odt",
  "application/epub+zip": "epub",
  "application/x-tex": "tex",
});

/**
 * @param {object} args
 * @param {string} [args.mime]
 * @param {string} [args.ext]
 * @param {object} [args.requires]   { ocr?:true, tables?:true, formulas?:true, layout?:true }
 * @param {object} [args.runtime]    { python?:bool, node?:bool, binary?:bool }  what's available
 * @returns {{ format, parsers: Array }}
 */
function chooseParsers({ mime, ext, requires = {}, runtime = { python: true, node: true, binary: true } } = {}) {
  const format = inferFormat(mime, ext);
  if (!format) throw mkErr("unknown_format", `cannot infer format from mime "${mime}" ext "${ext}"`);

  const candidates = PARSERS
    .filter(p => p.formats.includes(format))
    .filter(p => runtimeAllowed(p, runtime))
    .filter(p => meetsRequirements(p, requires));

  candidates.sort((a, b) => b.preference - a.preference);
  return { format, parsers: candidates };
}

/**
 * @param {object} args
 * @param {string} args.format            "docx" | "xlsx" | "pptx" | "pdf" | "svg" | "png" | "html" | "tex"
 * @param {object} [args.requires]        { template_support?:true }
 * @param {object} [args.runtime]
 * @returns {{ generators: Array }}
 */
function chooseGenerators({ format, requires = {}, runtime = { python: true, node: true, binary: true } } = {}) {
  if (!format) throw mkErr("missing_format", "format required");
  const candidates = GENERATORS
    .filter(g => g.format === format)
    .filter(g => runtimeAllowed(g, runtime))
    .filter(g => !requires.template_support || g.template_support);
  candidates.sort((a, b) => b.preference - a.preference);
  return { generators: candidates };
}

/**
 * Dispatch a parse action through the registry. Tries parsers in
 * preference order; returns the first non-throwing result.
 *
 * @param {object} args
 * @param {Buffer|string} args.source
 * @param {string} [args.mime]
 * @param {object} [args.requires]
 * @param {object} args.providers   { docling: async fn, mammoth: async fn, … }
 * @param {object} [args.runtime]
 */
async function dispatchParse({ source, mime, ext, requires = {}, providers = {}, runtime } = {}) {
  const { format, parsers } = chooseParsers({ mime, ext, requires, runtime });
  if (parsers.length === 0) throw mkErr("no_parser_available", `no parser for ${format} satisfies requirements`);
  const errors = [];
  for (const p of parsers) {
    const fn = providers[p.id];
    if (typeof fn !== "function") {
      errors.push({ parser: p.id, error: "provider_not_injected" });
      continue;
    }
    try {
      const out = await fn({ source, format, mime });
      return { format, parser_used: p.id, output: out, errors };
    } catch (err) {
      errors.push({ parser: p.id, error: err && err.message ? err.message : String(err) });
    }
  }
  throw mkErr("all_parsers_failed", `every available parser failed for format ${format}; tried ${errors.length}`);
}

async function dispatchGenerate({ format, plan, requires = {}, providers = {}, runtime } = {}) {
  const { generators } = chooseGenerators({ format, requires, runtime });
  if (generators.length === 0) throw mkErr("no_generator_available", `no generator for ${format} satisfies requirements`);
  const errors = [];
  for (const g of generators) {
    const fn = providers[g.id];
    if (typeof fn !== "function") {
      errors.push({ generator: g.id, error: "provider_not_injected" });
      continue;
    }
    try {
      const out = await fn({ format, plan, mime: g.mime });
      // Output sanity: must carry buffer or dataUrl + mime + filename
      if (!out || (!out.buffer && !out.dataUrl)) {
        errors.push({ generator: g.id, error: "generator_returned_empty" });
        continue;
      }
      return { format, generator_used: g.id, output: out, errors };
    } catch (err) {
      errors.push({ generator: g.id, error: err && err.message ? err.message : String(err) });
    }
  }
  throw mkErr("all_generators_failed", `every available generator failed for format ${format}; tried ${errors.length}`);
}

function inferFormat(mime, ext) {
  if (mime && MIME_TO_FORMAT[String(mime).toLowerCase()]) return MIME_TO_FORMAT[String(mime).toLowerCase()];
  const e = String(ext || "").replace(/^\./, "").toLowerCase();
  if (["pdf", "docx", "doc", "xlsx", "pptx", "ppt", "csv", "html", "htm", "md",
       "svg", "txt", "json", "xml", "yaml", "yml", "rtf", "odt", "epub", "tex"].includes(e)) {
    if (e === "yml") return "yaml";
    if (e === "htm") return "html";
    return e;
  }
  if (["png", "jpg", "jpeg", "webp", "gif"].includes(e)) return "image";
  return null;
}

function runtimeAllowed(p, runtime) {
  if (p.language === "python" && !runtime.python) return false;
  if (p.language === "node" && !runtime.node) return false;
  if (p.language === "binary" && !runtime.binary) return false;
  if (p.runtime === "binary" && !runtime.binary) return false;
  return true;
}

function meetsRequirements(p, requires) {
  if (requires.ocr && !p.ocr) return false;
  if (requires.tables && !p.tables) return false;
  if (requires.formulas && !p.formulas) return false;
  if (requires.layout && !p.layout) return false;
  if (requires.reading_order && !p.reading_order) return false;
  return true;
}

function integrity() {
  const issues = [];
  const ids = new Set();
  for (const arr of [PARSERS, GENERATORS]) {
    for (const x of arr) {
      const key = `${arr === PARSERS ? "p" : "g"}:${x.id}:${arr === PARSERS ? x.formats.join("/") : x.format}`;
      if (ids.has(key)) issues.push(`duplicate ${key}`);
      ids.add(key);
      if (typeof x.preference !== "number") issues.push(`${x.id} missing preference`);
    }
  }
  return { ok: issues.length === 0, issues, parsers: PARSERS.length, generators: GENERATORS.length };
}

// Codes preserved verbatim. Most thrown values from this module are
// either "format unknown / parser missing" (operator/config issue
// → ContextError, internal/500) or caller-shape complaints
// ("missing_format" → IngressError, 400). The map below routes them.
const _DOCUMENT_PIPELINE_INGRESS_CODES = new Set(["missing_format"]);
function mkErr(code, message) {
  const { ContextError, IngressError } = require("./pipeline-errors");
  if (_DOCUMENT_PIPELINE_INGRESS_CODES.has(code)) {
    return new IngressError({ code, message: `${code}: ${message}` });
  }
  return new ContextError({ code, message: `${code}: ${message}` });
}

// ── Content quality validator ────────────────────────────────────
// Scores a generated document's content quality to help the agent
// decide whether to re-generate or flag issues to the user.

const QUALITY_INDICATORS = Object.freeze({
  min_body_length: { min: 50, label: "body_length" },
  min_sentences: { min: 3, label: "sentence_count" },
  min_headings: { min: 1, label: "heading_count" },
  min_paragraphs: { min: 2, label: "paragraph_count" },
});

/**
 * Score generated content quality on a 0-100 scale.
 * Returns { score, issues[], warnings[], passed }
 *
 * content — plain text or markdown
 * format  — the target format (docx, pdf, xlsx, etc.)
 * options.requiredSections — array of section names that must appear
 */
function contentQualityScore(content, format, options = {}) {
  if (!content || typeof content !== 'string') {
    return { score: 0, issues: ['no_content'], warnings: [], passed: false };
  }

  const text = content.trim();
  const issues = [];
  const warnings = [];
  let score = 100;

  // Basic length checks
  const bodyLen = text.length;
  const sentences = text.split(/[.!?]+/).filter(Boolean).length;
  const headings = (text.match(/^#{1,6}\s/gm) || []).length;
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length > 10).length;

  if (bodyLen < QUALITY_INDICATORS.min_body_length.min) {
    issues.push('content_too_short');
    score -= 30;
  } else if (bodyLen < 200) {
    warnings.push('content_brief');
    score -= 5;
  }

  if (sentences < QUALITY_INDICATORS.min_sentences.min) {
    issues.push('too_few_sentences');
    score -= 20;
  }

  if (format !== 'xlsx' && format !== 'csv' && headings < QUALITY_INDICATORS.min_headings.min) {
    warnings.push('no_headings');
    score -= 10;
  }

  if (format !== 'xlsx' && format !== 'csv' && paragraphs < QUALITY_INDICATORS.min_paragraphs.min) {
    warnings.push('few_paragraphs');
    score -= 10;
  }

  // Required sections
  if (Array.isArray(options.requiredSections)) {
    for (const section of options.requiredSections) {
      const pattern = new RegExp(section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      if (!pattern.test(text)) {
        issues.push(`missing_section:${section}`);
        score -= 25;
      }
    }
  }

  // Check for placeholders
  const hasPlaceholders = /\b(lorem ipsum|todo|placeholder|insert .+ here|\[.*?\])\b/i.test(text);
  if (hasPlaceholders) {
    warnings.push('contains_placeholders');
    score -= 15;
  }

  // Check for extremely long sentences (poor readability)
  if (sentences > 0) {
    const avgWords = text.split(/\s+/).length / sentences;
    if (avgWords > 40) {
      warnings.push('long_sentences');
      score -= 10;
    }
  }

  return {
    score: Math.max(0, Math.round(score)),
    issues,
    warnings,
    passed: score >= 60,
    detail: { bodyLen, sentences, headings, paragraphs, avgWords: sentences > 0 ? Math.round(text.split(/\s+/).length / sentences) : 0 },
  };
}

/**
 * Suggest format improvements for an agent-generated document plan.
 * Returns advisory hints about the chosen format for the given use-case.
 */
function formatAdvice(format, useCase = '') {
  const lower = format ? format.toLowerCase() : '';
  const uc = useCase.toLowerCase();

  const advice = {
    best: lower,
    alternatives: [],
    notes: [],
  };

  if ((uc.includes('report') || uc.includes('reporte') || uc.includes('informe')) && lower !== 'docx' && lower !== 'pdf') {
    advice.alternatives.push('docx');
    advice.notes.push('For formal reports, DOCX or PDF is recommended.');
  }
  if ((uc.includes('data') || uc.includes('dato') || uc.includes('tabla') || uc.includes('table')) && lower !== 'xlsx' && lower !== 'csv') {
    advice.alternatives.push('xlsx');
    advice.notes.push('Tabular data is best presented in XLSX or CSV format.');
  }
  if ((uc.includes('slide') || uc.includes('presentación') || uc.includes('diapositiva')) && lower !== 'pptx') {
    advice.alternatives.push('pptx');
    advice.notes.push('Presentation content is best in PPTX format.');
  }
  if ((uc.includes('chart') || uc.includes('gráfico') || uc.includes('graph')) && lower !== 'svg') {
    advice.alternatives.push('svg');
    advice.notes.push('Charts and graphs render well as SVG or PNG.');
  }

  return advice;
}

module.exports = {
  PARSERS,
  GENERATORS,
  MIME_TO_FORMAT,
  chooseParsers,
  chooseGenerators,
  contentQualityScore,
  dispatchParse,
  dispatchGenerate,
  formatAdvice,
  inferFormat,
  integrity,
};
