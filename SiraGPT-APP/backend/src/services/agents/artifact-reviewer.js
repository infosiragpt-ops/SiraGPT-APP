/**
 * artifact-reviewer — deterministic pass/fail testing of an artifact
 * against a TaskContract (task-contract-schema.js).
 *
 * Design principles:
 * - Tests return **pass/fail booleans + concrete detail strings**.
 *   There are no percentage scores here; the user specifically
 *   asked us to stop inventing "100/100" numbers from heuristic
 *   ratios. A test either passes or it fails.
 * - Deterministic tests run without an LLM: extension match, MIME
 *   sniff, XML/ZIP parse, row/column counts, contains_text, etc.
 *   They are cheap and reproducible. Semantic tests (type=semantic)
 *   are skipped here — the route runs them via an LLM grader AFTER
 *   all deterministic tests pass.
 * - Every failure includes WHY in `detail` so the agent can
 *   self-repair without guessing (e.g. "required 30 rows, file has
 *   12").
 *
 * The reviewer never throws for test failures; it only throws for
 * actual bugs (missing buffer, unknown check). Callers inspect
 * `passed` and the `tests` array.
 */

const fs = require("fs");
const path = require("path");

const TEXT_EXTENSIONS = new Set(["svg", "csv", "tsv", "json", "md", "txt", "html", "xml", "py", "js", "ts", "tsx", "jsx"]);
const OFFICE_EXTENSIONS = new Set(["docx", "xlsx", "pptx"]);

// ─── Low-level helpers ──────────────────────────────────────────────────

function sniffMimeFromMagic(buffer, hintedExt) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  const head = buffer.slice(0, 8);

  // PDF: %PDF-
  if (head.slice(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  // PNG
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return "image/png";
  // JPEG
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  // GIF
  if (head.slice(0, 3).toString("ascii") === "GIF") return "image/gif";
  // WebP (RIFF....WEBP)
  if (head.slice(0, 4).toString("ascii") === "RIFF" && buffer.slice(8, 12).toString("ascii") === "WEBP") return "image/webp";

  // ZIP (covers docx/xlsx/pptx). Disambiguate by the ZIP internals.
  if (head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05 || head[2] === 0x07)) {
    if (hintedExt === "docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    if (hintedExt === "xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    if (hintedExt === "pptx") return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    return "application/zip";
  }

  // Text-like payload: probe for SVG / JSON / HTML / XML.
  try {
    const text = buffer.slice(0, 2048).toString("utf8");
    if (/^\s*<\?xml[^>]*\?>\s*<svg[\s>]/i.test(text) || /^\s*<svg[\s>]/i.test(text)) return "image/svg+xml";
    if (/^\s*<\?xml/i.test(text)) return "application/xml";
    if (/^\s*<!doctype html|^\s*<html[\s>]/i.test(text)) return "text/html";
    // JSON starts with { or [ after optional whitespace
    if (/^\s*[{[]/.test(text)) {
      try { JSON.parse(buffer.toString("utf8")); return "application/json"; } catch { /* fall through */ }
    }
  } catch { /* binary */ }

  // Fallback: extension → plain-text family.
  if (hintedExt === "csv") return "text/csv";
  if (hintedExt === "md") return "text/markdown";
  if (hintedExt === "txt") return "text/plain";
  if (hintedExt && TEXT_EXTENSIONS.has(hintedExt)) return "text/plain";
  return "application/octet-stream";
}

function readBuffer(artifact) {
  if (artifact.buffer && Buffer.isBuffer(artifact.buffer)) return artifact.buffer;
  if (artifact.path && fs.existsSync(artifact.path)) return fs.readFileSync(artifact.path);
  throw new Error("artifact-reviewer: artifact needs a buffer or an existing path");
}

function extOf(filename) {
  const e = path.extname(String(filename || "")).replace(/^\./, "").toLowerCase();
  return e || null;
}

function textOf(buffer) {
  if (!buffer) return "";
  return buffer.toString("utf8");
}

// ─── Built-in deterministic checks ──────────────────────────────────────
//
// Each check receives { contract, artifact, buffer, ext, mimeSniffed,
// params } and returns { ok: boolean, detail: string }.

const CHECKS = {
  extension_match({ artifact, contract, ext, params }) {
    const want = String(params?.value || contract.required_extension || "").toLowerCase();
    if (!want) return { ok: true, detail: "no required extension in contract" };
    return ext === want
      ? { ok: true, detail: `extension is .${ext}` }
      : { ok: false, detail: `required .${want}, got .${ext || "(none)"} — filename ${artifact.filename}` };
  },

  mime_magic_match({ contract, mimeSniffed, params }) {
    const want = String(params?.value || contract.mime_type || "").toLowerCase();
    if (!want) return { ok: true, detail: "no required MIME in contract" };
    return mimeSniffed === want
      ? { ok: true, detail: `MIME magic matches ${want}` }
      : { ok: false, detail: `required MIME ${want}, got ${mimeSniffed || "(unknown)"}` };
  },

  parses_as_xml({ buffer }) {
    const text = textOf(buffer).trim();
    if (!text) return { ok: false, detail: "empty file" };
    const looksXml = /^\s*<\?xml/.test(text) || /^\s*<[a-zA-Z][\w:-]*[\s>]/.test(text);
    const balanced = (() => {
      // crude but effective: every opened tag has a matching close or is self-closing
      const opens = (text.match(/<[a-zA-Z][\w:-]*(?=[\s/>])/g) || []).length;
      const closes = (text.match(/<\/[a-zA-Z][\w:-]*\s*>/g) || []).length;
      const selfClose = (text.match(/\/>/g) || []).length;
      return closes + selfClose >= Math.ceil(opens * 0.6);
    })();
    return looksXml && balanced
      ? { ok: true, detail: "xml-shaped and tag-balanced" }
      : { ok: false, detail: "does not parse as balanced XML" };
  },

  parses_as_json({ buffer }) {
    try { JSON.parse(textOf(buffer)); return { ok: true, detail: "valid JSON" }; }
    catch (err) { return { ok: false, detail: `invalid JSON: ${err.message}` }; }
  },

  parses_as_svg({ buffer }) {
    const text = textOf(buffer);
    const hasOpen = /<svg[\s>]/i.test(text);
    const hasClose = /<\/svg>/i.test(text);
    const noScript = !/<script[\s>]/i.test(text);
    if (hasOpen && hasClose && noScript) return { ok: true, detail: "contains <svg> and </svg>, no <script>" };
    const why = [];
    if (!hasOpen) why.push("no <svg> open tag");
    if (!hasClose) why.push("no </svg> close tag");
    if (!noScript) why.push("contains <script> (rejected)");
    return { ok: false, detail: why.join(", ") };
  },

  parses_as_zip({ buffer }) {
    if (buffer[0] === 0x50 && buffer[1] === 0x4b) return { ok: true, detail: "ZIP magic OK" };
    return { ok: false, detail: "missing ZIP magic (PK header)" };
  },

  opens_as_docx({ buffer, ext }) {
    if (ext !== "docx") return { ok: false, detail: `expected .docx, got .${ext}` };
    if (!(buffer[0] === 0x50 && buffer[1] === 0x4b)) return { ok: false, detail: "not a ZIP" };
    const text = buffer.toString("binary");
    return /word\/document\.xml/.test(text)
      ? { ok: true, detail: "ZIP contains word/document.xml" }
      : { ok: false, detail: "ZIP does not contain word/document.xml" };
  },

  opens_as_xlsx({ buffer, ext }) {
    if (ext !== "xlsx") return { ok: false, detail: `expected .xlsx, got .${ext}` };
    if (!(buffer[0] === 0x50 && buffer[1] === 0x4b)) return { ok: false, detail: "not a ZIP" };
    const text = buffer.toString("binary");
    return /xl\/workbook\.xml/.test(text)
      ? { ok: true, detail: "ZIP contains xl/workbook.xml" }
      : { ok: false, detail: "ZIP does not contain xl/workbook.xml" };
  },

  opens_as_pptx({ buffer, ext }) {
    if (ext !== "pptx") return { ok: false, detail: `expected .pptx, got .${ext}` };
    if (!(buffer[0] === 0x50 && buffer[1] === 0x4b)) return { ok: false, detail: "not a ZIP" };
    const text = buffer.toString("binary");
    return /ppt\/presentation\.xml/.test(text)
      ? { ok: true, detail: "ZIP contains ppt/presentation.xml" }
      : { ok: false, detail: "ZIP does not contain ppt/presentation.xml" };
  },

  opens_as_pdf({ buffer, ext }) {
    if (ext !== "pdf") return { ok: false, detail: `expected .pdf, got .${ext}` };
    const head = buffer.slice(0, 5).toString("ascii");
    const tail = buffer.slice(-32).toString("ascii");
    if (head !== "%PDF-") return { ok: false, detail: "missing %PDF- header" };
    if (!/%%EOF\s*$/.test(tail)) return { ok: false, detail: "missing %%EOF footer" };
    return { ok: true, detail: "valid %PDF- header and %%EOF footer" };
  },

  // Data volume checks for tabular / textual deliverables.
  // Count rows from a parsed CSV or from xlsx ZIP. For xlsx we use a
  // cheap approximation: count <row> tags in the first sheet XML.
  min_rows({ buffer, ext, params }) {
    const want = Number(params?.value || 0);
    let rows = 0;
    if (ext === "csv" || ext === "tsv") {
      const delim = ext === "tsv" ? "\t" : ",";
      const lines = textOf(buffer).split(/\r?\n/).filter(l => l.trim().length > 0);
      rows = lines.length;
      return rows >= want
        ? { ok: true, detail: `${rows} rows ≥ ${want}` }
        : { ok: false, detail: `only ${rows} rows, required ${want}. Delimiter: ${delim === "\t" ? "tab" : "comma"}` };
    }
    if (ext === "xlsx") {
      const text = buffer.toString("binary");
      // Match <row r="N"> inside any sheetN.xml — crude but fine for a pass/fail gate.
      const m = text.match(/<row\b[^>]*>/g);
      rows = m ? m.length : 0;
      return rows >= want
        ? { ok: true, detail: `${rows} <row> tags detected ≥ ${want}` }
        : { ok: false, detail: `only ${rows} <row> tags detected, required ${want}` };
    }
    // For text documents, count newlines as a very loose proxy.
    rows = textOf(buffer).split(/\r?\n/).length;
    return rows >= want
      ? { ok: true, detail: `${rows} lines ≥ ${want}` }
      : { ok: false, detail: `only ${rows} lines, required ${want}` };
  },

  min_columns({ buffer, ext, params }) {
    const want = Number(params?.value || 0);
    if (ext === "csv") {
      const firstLine = textOf(buffer).split(/\r?\n/)[0] || "";
      const cols = firstLine.split(",").length;
      return cols >= want
        ? { ok: true, detail: `${cols} CSV columns ≥ ${want}` }
        : { ok: false, detail: `only ${cols} CSV columns, required ${want}` };
    }
    if (ext === "xlsx") {
      // First <dimension ref="A1:F31"/> in sheet1 reveals width.
      const text = buffer.toString("binary");
      const m = text.match(/<dimension\s+ref="[A-Z]+1:([A-Z]+)\d+"/);
      if (m) {
        const letter = m[1];
        const cols = letter.split("").reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0);
        return cols >= want
          ? { ok: true, detail: `xlsx dimension ref implies ${cols} cols ≥ ${want}` }
          : { ok: false, detail: `xlsx dimension ref implies ${cols} cols, required ${want}` };
      }
      return { ok: false, detail: "xlsx has no <dimension ref> — cannot confirm columns" };
    }
    return { ok: true, detail: "column check skipped for this format" };
  },

  min_pages({ buffer, ext, params }) {
    const want = Number(params?.value || 0);
    if (ext !== "pdf") return { ok: true, detail: "page count skipped for non-pdf" };
    // PDF /Count N in the root pages dict.
    const text = buffer.toString("binary");
    const m = text.match(/\/Type\s*\/Pages[\s\S]{0,200}?\/Count\s+(\d+)/);
    const pages = m ? parseInt(m[1], 10) : 0;
    return pages >= want
      ? { ok: true, detail: `pdf /Count = ${pages} ≥ ${want}` }
      : { ok: false, detail: `pdf /Count = ${pages}, required ${want}` };
  },

  min_slides({ buffer, ext, params }) {
    const want = Number(params?.value || 0);
    if (ext !== "pptx") return { ok: true, detail: "slide count skipped for non-pptx" };
    const text = buffer.toString("binary");
    const m = text.match(/ppt\/slides\/slide\d+\.xml/g);
    const slides = m ? new Set(m).size : 0;
    return slides >= want
      ? { ok: true, detail: `${slides} slide XML parts ≥ ${want}` }
      : { ok: false, detail: `only ${slides} slide XML parts, required ${want}` };
  },

  min_paragraphs({ buffer, ext, params }) {
    const want = Number(params?.value || 0);
    if (ext !== "docx") return { ok: true, detail: "paragraph count skipped for non-docx" };
    const text = buffer.toString("binary");
    const m = text.match(/<w:p[\s>]/g);
    const paras = m ? m.length : 0;
    return paras >= want
      ? { ok: true, detail: `${paras} <w:p> paragraphs ≥ ${want}` }
      : { ok: false, detail: `only ${paras} <w:p> paragraphs, required ${want}` };
  },

  contains_text({ buffer, params }) {
    const value = String(params?.value || "");
    if (!value) return { ok: true, detail: "empty contains_text — skipped" };
    const text = textOf(buffer);
    return text.includes(value)
      ? { ok: true, detail: `found literal "${value.slice(0, 60)}"` }
      : { ok: false, detail: `missing literal "${value.slice(0, 60)}"` };
  },

  contains_regex({ buffer, params }) {
    const pattern = String(params?.pattern || "");
    if (!pattern) return { ok: false, detail: "contains_regex requires pattern" };
    let rx;
    try { rx = new RegExp(pattern, params?.flags || ""); }
    catch (err) { return { ok: false, detail: `invalid regex: ${err.message}` }; }
    const text = textOf(buffer);
    return rx.test(text)
      ? { ok: true, detail: `matched /${pattern}/${params?.flags || ""}` }
      : { ok: false, detail: `did not match /${pattern}/${params?.flags || ""}` };
  },

  forbidden_format_absent({ artifact, ext, params }) {
    const forbidden = Array.isArray(params?.extensions)
      ? params.extensions.map(e => String(e || "").toLowerCase())
      : [];
    if (!forbidden.length) return { ok: true, detail: "no forbidden extensions declared" };
    if (forbidden.includes(ext)) {
      return { ok: false, detail: `delivered .${ext} but forbidden list includes it. Filename ${artifact.filename}.` };
    }
    return { ok: true, detail: `extension .${ext} not in forbidden list [${forbidden.join(", ")}]` };
  },

  semantic_match({ /* reserved for LLM grader */ }) {
    return { ok: false, detail: "semantic_match is evaluated by an LLM grader after deterministic tests pass; reviewer cannot run it alone." };
  },
};

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Run every deterministic test in a TaskContract against an artifact.
 *
 * @param {object} args
 * @param {object} args.contract — TaskContract (see task-contract-schema)
 * @param {object} args.artifact — { filename, buffer?, path? } — either buffer or path required
 *
 * @returns {{
 *   passed: boolean,
 *   testsTotal: number,
 *   testsPassed: number,
 *   tests: Array<{ id, type, description, check, ok, detail }>,
 *   ext: string|null,
 *   mimeSniffed: string|null,
 *   deterministicOnly: boolean,
 * }}
 */
function reviewArtifact({ contract, artifact }) {
  if (!contract || typeof contract !== "object") {
    throw new Error("artifact-reviewer: contract required");
  }
  if (!artifact || typeof artifact !== "object") {
    throw new Error("artifact-reviewer: artifact required");
  }

  const buffer = readBuffer(artifact);
  const ext = extOf(artifact.filename);
  const mimeSniffed = sniffMimeFromMagic(buffer, ext);

  const tests = (contract.success_tests || []).map(t => ({
    id: t.id,
    type: t.type,
    description: t.description,
    check: t.check,
    parameters: t.parameters || {},
  }));

  const results = [];
  let deterministicOnly = true;
  for (const t of tests) {
    if (t.type === "semantic") {
      // skipped here — route will run the LLM grader
      results.push({ ...t, ok: null, detail: "semantic test deferred to LLM grader" });
      deterministicOnly = false;
      continue;
    }
    const check = t.check || t.id; // allow using the id when it matches a known check
    const fn = CHECKS[check];
    if (typeof fn !== "function") {
      results.push({ ...t, ok: false, detail: `unknown check "${check}"` });
      continue;
    }
    try {
      const r = fn({ contract, artifact, buffer, ext, mimeSniffed, params: t.parameters });
      results.push({ ...t, ok: Boolean(r.ok), detail: r.detail || "" });
    } catch (err) {
      results.push({ ...t, ok: false, detail: `check threw: ${err.message}` });
    }
  }

  const deterministicResults = results.filter(r => r.type === "deterministic");
  const failedDet = deterministicResults.filter(r => r.ok === false);
  const passedDet = deterministicResults.filter(r => r.ok === true);

  return {
    passed: failedDet.length === 0 && deterministicResults.length > 0,
    testsTotal: deterministicResults.length,
    testsPassed: passedDet.length,
    tests: results,
    failedTests: failedDet.map(r => ({ id: r.id, description: r.description, detail: r.detail })),
    ext,
    mimeSniffed,
    deterministicOnly,
  };
}

/**
 * Review in-chat text against a TaskContract (no file artifact).
 * We wrap the text as a pseudo-artifact so the same check matrix
 * applies (contains_text / contains_regex / forbidden_format_absent).
 */
function reviewInlineText({ contract, text, meta }) {
  const buffer = Buffer.from(String(text || ""), "utf8");
  const artifact = { filename: "inline-answer.txt", buffer, meta: meta || {} };
  return reviewArtifact({ contract, artifact });
}

module.exports = {
  reviewArtifact,
  reviewInlineText,
  sniffMimeFromMagic,
  CHECKS,
};
