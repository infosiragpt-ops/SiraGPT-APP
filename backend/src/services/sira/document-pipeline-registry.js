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

  // ── Streaming / line-delimited formats ─────────────────────────
  { id: "ndjson-writer",     format: "ndjson", language: "node",  runtime: "library", template_support: false, mime: "application/x-ndjson", preference: 92 },
  { id: "tsv-writer",        format: "tsv",   language: "node",   runtime: "library", template_support: false, mime: "text/tab-separated-values", preference: 90 },

  // ── Calendar / contact / bibliography ──────────────────────────
  { id: "ics-writer",        format: "ics",   language: "node",   runtime: "library", template_support: false, mime: "text/calendar", preference: 92 },
  { id: "vcf-writer",        format: "vcf",   language: "node",   runtime: "library", template_support: false, mime: "text/vcard", preference: 92 },
  { id: "bibtex-writer",     format: "bib",   language: "node",   runtime: "library", template_support: false, mime: "application/x-bibtex", preference: 90 },
]);

const MIME_TO_FORMAT = Object.freeze({
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.ms-powerpoint": "ppt",
  "text/csv": "csv",
  "application/csv": "csv",
  "text/html": "html",
  "application/xhtml+xml": "html",
  "text/markdown": "md",
  "text/x-markdown": "md",
  "application/markdown": "md",
  "image/png": "image",
  "image/jpeg": "image",
  "image/jpg": "image",
  "image/webp": "image",
  "image/gif": "image",
  "image/bmp": "image",
  "image/tiff": "image",
  "image/svg+xml": "svg",
  "image/svg": "svg",
  "text/plain": "txt",
  "application/json": "json",
  "application/ld+json": "json",
  "text/json": "json",
  "application/xml": "xml",
  "text/xml": "xml",
  "application/yaml": "yaml",
  "text/yaml": "yaml",
  "application/x-yaml": "yaml",
  "text/x-yaml": "yaml",
  "application/rtf": "rtf",
  "text/rtf": "rtf",
  "text/x-rtf": "rtf",
  "application/vnd.oasis.opendocument.text": "odt",
  "application/epub+zip": "epub",
  "application/x-tex": "tex",
  "application/x-latex": "tex",
  "text/x-tex": "tex",
  "application/x-ndjson": "ndjson",
  "application/ndjson": "ndjson",
  "application/jsonl": "ndjson",
  "application/x-jsonlines": "ndjson",
  "text/tab-separated-values": "tsv",
  "text/tsv": "tsv",
  "text/calendar": "ics",
  "text/x-vcalendar": "ics",
  "text/vcard": "vcf",
  "text/x-vcard": "vcf",
  "application/x-bibtex": "bib",
  "text/x-bibtex": "bib",
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
  if (mime) {
    const m = String(mime).toLowerCase().split(";")[0].trim();
    if (MIME_TO_FORMAT[m]) return MIME_TO_FORMAT[m];
  }
  const e = String(ext || "").replace(/^\./, "").toLowerCase();
  if (["pdf", "docx", "doc", "xlsx", "pptx", "ppt", "csv", "html", "htm", "md",
       "markdown", "mdown", "mkd", "svg", "txt", "json", "xml", "yaml", "yml",
       "rtf", "odt", "epub", "tex", "latex", "ltx", "xhtml",
       "ndjson", "jsonl", "tsv", "ics", "ical", "ifb", "vcf", "vcard", "bib", "bibtex"].includes(e)) {
    if (e === "yml") return "yaml";
    if (e === "htm" || e === "xhtml") return "html";
    if (e === "markdown" || e === "mdown" || e === "mkd") return "md";
    if (e === "latex" || e === "ltx") return "tex";
    if (e === "jsonl") return "ndjson";
    if (e === "ical" || e === "ifb") return "ics";
    if (e === "vcard") return "vcf";
    if (e === "bibtex") return "bib";
    return e;
  }
  if (["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff"].includes(e)) return "image";
  return null;
}

/**
 * Look up a generator by id. Returns undefined when unknown.
 */
function getGeneratorById(id) {
  return GENERATORS.find(g => g.id === id);
}

/**
 * Look up a parser by id. Returns undefined when unknown.
 */
function getParserById(id) {
  return PARSERS.find(p => p.id === id);
}

/**
 * Distinct list of formats supported by either parsers or generators.
 * Pass { side: "parsers" | "generators" } to restrict.
 */
function listFormats({ side } = {}) {
  const set = new Set();
  if (side !== "generators") {
    for (const p of PARSERS) for (const f of p.formats) set.add(f);
  }
  if (side !== "parsers") {
    for (const g of GENERATORS) set.add(g.format);
  }
  return Array.from(set).sort();
}

/**
 * MIME type for a format, derived from the highest-preference generator.
 * Returns null when no generator declares a MIME for the format.
 */
function mimeForFormat(format) {
  const cands = GENERATORS.filter(g => g.format === format);
  if (!cands.length) return null;
  cands.sort((a, b) => b.preference - a.preference);
  return cands[0].mime;
}

// Canonical filesystem extension (no leading dot) for a logical format.
// Used when persisting generator output to disk and when suggesting a
// download filename. Stays in lock-step with `inferFormat`.
const FORMAT_TO_EXTENSION = Object.freeze({
  pdf: "pdf", doc: "doc", docx: "docx", xlsx: "xlsx", pptx: "pptx", ppt: "ppt",
  csv: "csv", html: "html", md: "md", svg: "svg", txt: "txt", json: "json",
  xml: "xml", yaml: "yaml", rtf: "rtf", odt: "odt", epub: "epub", tex: "tex",
  ndjson: "ndjson", tsv: "tsv", ics: "ics", vcf: "vcf", bib: "bib",
  png: "png", image: "png",
});

/**
 * Canonical filesystem extension (without leading dot) for a logical
 * format. Returns null for unknown formats.
 */
function formatExtension(format) {
  if (!format) return null;
  return FORMAT_TO_EXTENSION[String(format).toLowerCase()] || null;
}

/**
 * Capability summary for a format. Returns null when unknown to either
 * parsers or generators. The agent can call this to decide whether a
 * given format is reachable in the current runtime profile, what MIME
 * type it should advertise, and whether parsers exist.
 */
function inspectFormat(format, runtime = { python: true, node: true, binary: true }) {
  if (!format) return null;
  const fmt = String(format).toLowerCase();

  const parserList = PARSERS.filter(p => p.formats.includes(fmt));
  const generatorList = GENERATORS.filter(g => g.format === fmt);

  if (parserList.length === 0 && generatorList.length === 0) return null;

  const allowedParsers = parserList.filter(p => runtimeAllowed(p, runtime));
  const allowedGenerators = generatorList.filter(g => runtimeAllowed(g, runtime));

  // Capability flags rolled up from any allowed parser
  const cap = (key) => allowedParsers.some(p => !!p[key]);

  return {
    format: fmt,
    extension: formatExtension(fmt),
    mime: mimeForFormat(fmt),
    parsers: parserList.length,
    generators: generatorList.length,
    parsersAvailable: allowedParsers.length,
    generatorsAvailable: allowedGenerators.length,
    canParse: allowedParsers.length > 0,
    canGenerate: allowedGenerators.length > 0,
    capabilities: {
      ocr: cap("ocr"),
      tables: cap("tables"),
      formulas: cap("formulas"),
      layout: cap("layout"),
      reading_order: cap("reading_order"),
    },
    bestParser: allowedParsers.sort((a, b) => b.preference - a.preference)[0]?.id || null,
    bestGenerator: allowedGenerators.sort((a, b) => b.preference - a.preference)[0]?.id || null,
  };
}

/**
 * Lightweight schema check on a generator plan. Catches obvious shape bugs
 * (empty plans, tabular formats with no rows, etc.) before invoking a real
 * generator that might fail with a less helpful error.
 *
 * Returns { ok: true } or { ok: false, issues: [...] }.
 */
function validateGeneratorPlan(format, plan) {
  const issues = [];
  const fmt = String(format || "").toLowerCase();

  if (plan === null || plan === undefined) {
    issues.push("plan_missing");
    return { ok: false, issues };
  }
  if (typeof plan !== "object" && typeof plan !== "string") {
    issues.push("plan_must_be_object_or_string");
    return { ok: false, issues };
  }

  // Tabular formats expect rows
  if (["csv", "tsv", "xlsx"].includes(fmt)) {
    const rows = plan.rows || plan.data || (Array.isArray(plan) ? plan : null);
    if (!Array.isArray(rows) || rows.length === 0) {
      issues.push("tabular_plan_needs_rows");
    }
  }

  // ndjson expects an iterable of records
  if (fmt === "ndjson") {
    const records = plan.records || plan.rows || (Array.isArray(plan) ? plan : null);
    if (!Array.isArray(records) || records.length === 0) {
      issues.push("ndjson_plan_needs_records");
    }
  }

  // ics expects events
  if (fmt === "ics") {
    const events = plan.events || (Array.isArray(plan) ? plan : null);
    if (!Array.isArray(events) || events.length === 0) {
      issues.push("ics_plan_needs_events");
    }
  }

  // vcf expects contacts
  if (fmt === "vcf") {
    const contacts = plan.contacts || (Array.isArray(plan) ? plan : null);
    if (!Array.isArray(contacts) || contacts.length === 0) {
      issues.push("vcf_plan_needs_contacts");
    }
  }

  // Document formats benefit from a body/sections/markdown field
  if (["docx", "pdf", "rtf", "odt", "epub", "html", "md", "tex"].includes(fmt)) {
    const hasContent =
      typeof plan === "string" ||
      typeof plan.body === "string" ||
      typeof plan.markdown === "string" ||
      typeof plan.html === "string" ||
      Array.isArray(plan.sections);
    if (!hasContent) {
      issues.push("document_plan_needs_body_or_sections");
    }
  }

  return { ok: issues.length === 0, issues };
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
  const listItems = (text.match(/^\s*(?:[-*+]|\d+\.)\s+\S/gm) || []).length;
  const codeBlocks = (text.match(/```[\s\S]*?```/g) || []).length;
  const links = (text.match(/\[[^\]]+\]\([^)]+\)/g) || []).length;
  const tableRows = (text.match(/^\s*\|.+\|\s*$/gm) || []).length;

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

  // Repetition: same line repeated many times suggests templated/empty filler.
  const lines = text.split(/\n/).map(l => l.trim()).filter(l => l.length > 8);
  if (lines.length >= 6) {
    const counts = new Map();
    for (const l of lines) counts.set(l, (counts.get(l) || 0) + 1);
    const maxRep = Math.max(...counts.values());
    if (maxRep >= Math.max(4, Math.ceil(lines.length * 0.35))) {
      warnings.push('repeated_lines');
      score -= 10;
    }
  }

  return {
    score: Math.max(0, Math.round(score)),
    issues,
    warnings,
    passed: score >= 60,
    detail: {
      bodyLen,
      sentences,
      headings,
      paragraphs,
      listItems,
      codeBlocks,
      links,
      tableRows,
      avgWords: sentences > 0 ? Math.round(text.split(/\s+/).length / sentences) : 0,
    },
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
  if ((uc.includes('cv') || uc.includes('resume') || uc.includes('curriculum') || uc.includes('currículum')) && lower !== 'pdf' && lower !== 'docx') {
    advice.alternatives.push('pdf');
    advice.notes.push('Resumes/CVs are typically delivered as PDF (or DOCX for editable versions).');
  }
  if ((uc.includes('book') || uc.includes('libro') || uc.includes('ebook') || uc.includes('novel')) && lower !== 'epub' && lower !== 'pdf') {
    advice.alternatives.push('epub');
    advice.notes.push('Long-form publications are best as EPUB (reflowable) or PDF (fixed layout).');
  }
  if ((uc.includes('calendar') || uc.includes('event') || uc.includes('calendario') || uc.includes('evento') || uc.includes('meeting')) && lower !== 'ics') {
    advice.alternatives.push('ics');
    advice.notes.push('Calendar events should use the ICS format for cross-app compatibility.');
  }
  if ((uc.includes('contact') || uc.includes('contacto') || uc.includes('vcard') || uc.includes('address book')) && lower !== 'vcf') {
    advice.alternatives.push('vcf');
    advice.notes.push('Contact records should use the VCF (vCard) format.');
  }
  if ((uc.includes('citation') || uc.includes('bibliograph') || uc.includes('reference')) && lower !== 'bib') {
    advice.alternatives.push('bib');
    advice.notes.push('Bibliographies are best stored as BibTeX (.bib) for use with LaTeX/Pandoc.');
  }
  if ((uc.includes('stream') || uc.includes('log') || uc.includes('event log')) && lower !== 'ndjson') {
    advice.alternatives.push('ndjson');
    advice.notes.push('Streaming or line-delimited records are best as NDJSON (JSON Lines).');
  }

  // Dedupe alternatives while preserving order
  advice.alternatives = Array.from(new Set(advice.alternatives));
  return advice;
}

module.exports = {
  PARSERS,
  GENERATORS,
  MIME_TO_FORMAT,
  FORMAT_TO_EXTENSION,
  chooseParsers,
  chooseGenerators,
  contentQualityScore,
  dispatchParse,
  dispatchGenerate,
  formatAdvice,
  formatExtension,
  inspectFormat,
  getGeneratorById,
  getParserById,
  inferFormat,
  integrity,
  listFormats,
  mimeForFormat,
  validateGeneratorPlan,
};
