"use strict";

const path = require("path");
const fs = require("fs").promises;
const { getLogger } = require("../agents/structured-logger");
const { resolveProcessMimeType } = require("../fileProcessor");

const log = getLogger("document-parsers.index");

let _marker = null;
let _docling = null;
let _markitdown = null;

function lazyMarker() {
  if (!_marker) {
    try {
      _marker = require("./marker");
    } catch (e) {
      log.warn("marker module failed to load", { error: e.message });
      _marker = { isMarkerAvailable: async () => false };
    }
  }
  return _marker;
}

function lazyDocling() {
  if (!_docling) {
    try {
      _docling = require("./docling");
    } catch (e) {
      log.warn("docling module failed to load", { error: e.message });
      _docling = { isDoclingAvailable: async () => false };
    }
  }
  return _docling;
}

function lazyMarkitdown() {
  if (!_markitdown) {
    try {
      _markitdown = require("./markitdown");
    } catch (e) {
      log.warn("markitdown module failed to load", { error: e.message });
      _markitdown = { isMarkitdownAvailable: async () => false };
    }
  }
  return _markitdown;
}

const MIME_TO_PARSER_STRATEGY = new Map([
  ["application/pdf", ["marker", "docling", "markitdown", "pdf-parse"]],
  [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ["docling", "markitdown", "mammoth"],
  ],
  ["application/msword", ["docling", "mammoth"]],
  [
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ["docling", "markitdown", "officeparser"],
  ],
  [
    "application/vnd.ms-powerpoint",
    ["docling", "officeparser"],
  ],
  [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ["markitdown", "exceljs"],
  ],
  ["text/html", ["markitdown", "raw"]],
  ["text/csv", ["markitdown", "raw"]],
]);

function getParserStrategy(mimeType) {
  const normalized = String(mimeType || "").toLowerCase().split(";")[0].trim();
  return MIME_TO_PARSER_STRATEGY.get(normalized) || null;
}

/**
 * Check which document parsers are available in the current environment.
 * Lazy detection — caches after first call per process lifetime.
 *
 * @returns {Promise<Array<{ id: string, available: boolean }>>}
 */
async function availableParsers() {
  const results = await Promise.all([
    (async () => { try { return await lazyMarker().isMarkerAvailable(); } catch { return false; } })(),
    (async () => { try { return await lazyDocling().isDoclingAvailable(); } catch { return false; } })(),
    (async () => { try { return await lazyMarkitdown().isMarkitdownAvailable(); } catch { return false; } })(),
  ]);

  return [
    { id: "marker", available: results[0] },
    { id: "docling", available: results[1] },
    { id: "markitdown", available: results[2] },
    { id: "pdf-parse", available: true },
    { id: "mammoth", available: true },
    { id: "officeparser", available: true },
    { id: "exceljs", available: true },
    { id: "raw", available: true },
  ];
}

function parserKey(mime) {
  const n = String(mime || "").toLowerCase().split(";")[0].trim();
  if (n === "application/msword") return "mammoth";
  if (n === "application/vnd.ms-powerpoint") return "officeparser";
  return null;
}

/**
 * Unified document parser. Selects the best parser based on:
 *   1. MIME type → parser strategy chain
 *   2. Lazy availability check (tries each until one works)
 *   3. Falls back through the entire chain gracefully
 *
 * Priority order (per format):
 *   PDF  → Marker > Docling > MarkItDown > pdf-parse
 *   DOCX → Docling > MarkItDown > mammoth
 *   PPTX → Docling > MarkItDown > officeparser
 *   XLSX → MarkItDown > ExcelJS
 *   HTML → MarkItDown > raw text
 *
 * @param {string} filePath - absolute path to the file on disk
 * @param {string} mimeType - declared MIME type (can be inaccurate)
 * @param {object} [options]
 * @param {object} [options.file] - multer-style file object for improved MIME detection
 * @param {number} [options.timeoutMs] - per-parser timeout override
 * @returns {Promise<{ text: string, parser: string, metadata?: object, tried: Array<{ id: string, error?: string }> }>}
 */
const DEFAULT_TOTAL_TIMEOUT_MS = Number.parseInt(
  process.env.SIRAGPT_PARSER_TOTAL_TIMEOUT_MS || '120000',
  10
);

async function parseDocumentInner(filePath, mimeType, options = {}) {
  const effectiveMime =
    (options.file ? resolveProcessMimeType(options.file) : null) ||
    mimeType;

  const strategy = getParserStrategy(effectiveMime);
  const tried = [];

  if (!strategy) {
    // No strategy for this MIME type — return raw text
    log.info("no parser strategy for mime, returning raw text", {
      filePath,
      mimeType: effectiveMime,
    });
    try {
      const content = await fs.readFile(filePath, "utf8");
      return {
        text: content,
        parser: "raw",
        metadata: { engine: "raw (no strategy)", charCount: content.length },
        tried,
      };
    } catch {
      return {
        text: `[Unable to read: ${path.basename(filePath)}]`,
        parser: "none",
        metadata: { engine: "none", charCount: 0 },
        tried,
      };
    }
  }

  for (const parserId of strategy) {
    tried.push({ id: parserId });
    try {
      const result = await tryParserById(parserId, filePath, options, effectiveMime);
      if (result) {
        result.tried = tried;
        return result;
      }
    } catch (err) {
      tried[tried.length - 1].error = err.message;
      log.warn("parser failed, trying next", {
        parserId,
        filePath,
        error: err.message,
      });
    }
  }

  // Absolute last resort
  const lastResult = await lastResortParse(filePath, options);
  lastResult.tried = tried;
  return lastResult;
}

async function parseDocument(filePath, mimeType, options = {}) {
  const budgetMs = Number(options.totalTimeoutMs) || DEFAULT_TOTAL_TIMEOUT_MS;
  let timer;
  const budget = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`parser_total_timeout after ${budgetMs}ms`));
    }, budgetMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      parseDocumentInner(filePath, mimeType, options),
      budget,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function tryParserById(parserId, filePath, options, mimeType) {
  switch (parserId) {
    case "marker":
      return await lazyMarker().parseWithMarker(filePath, {
        timeoutMs: options.timeoutMs,
      });
    case "docling":
      return await lazyDocling().parseWithDocling(filePath, {
        timeoutMs: options.timeoutMs,
        file: options.file,
      });
    case "markitdown":
      return await lazyMarkitdown().parseWithMarkitdown(filePath, {
        timeoutMs: options.timeoutMs,
      });
    case "pdf-parse": {
      const pdf = require("pdf-parse");
      const dataBuffer = await fs.readFile(filePath);
      const data = await pdf(dataBuffer);
      return {
        text: data.text,
        parser: "pdf-parse",
        metadata: {
          engine: "pdf-parse",
          pages: data.numpages,
          charCount: data.text.length,
        },
      };
    }
    case "mammoth": {
      const mammoth = require("mammoth");
      const { value: html } = await mammoth.convertToHtml({ path: filePath });
      let md = html
        .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n")
        .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n")
        .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n")
        .replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**")
        .replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*")
        .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "$1\n\n")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      return {
        text: md,
        parser: "mammoth",
        metadata: { engine: "mammoth", charCount: md.length },
      };
    }
    case "officeparser": {
      const officeParser = require("officeparser");
      const parsed =
        typeof officeParser.parseOfficeAsync === "function"
          ? await officeParser.parseOfficeAsync(filePath)
          : await officeParser.parseOffice(filePath, { ocr: false });
      const text =
        typeof parsed === "string"
          ? parsed
          : typeof parsed?.toText === "function"
            ? parsed.toText()
            : String(parsed || "");
      return {
        text,
        parser: "officeparser",
        metadata: { engine: "officeparser", charCount: text.length },
      };
    }
    case "exceljs": {
      const { readXlsxFile, selectWorkbookWorksheets, worksheetRows } = require("../xlsx-safe-workbook");
      const workbook = await readXlsxFile(filePath);
      const { worksheets } = selectWorkbookWorksheets(workbook);
      const parts = [];
      worksheets.forEach((ws) => {
        const rows = worksheetRows(ws, { maxRows: 1000 }).filter(
          (r) => Array.isArray(r) && r.length > 0
        );
        if (rows.length === 0) return;
        parts.push(`Sheet: ${ws.name}`);
        rows.forEach((row) => parts.push(row.join("\t")));
      });
      const text = parts.join("\n");
      return {
        text,
        parser: "exceljs",
        metadata: { engine: "exceljs", charCount: text.length },
      };
    }
    default:
      throw new Error(`unknown parser id: ${parserId}`);
  }
}

async function lastResortParse(filePath, options = {}) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return {
      text: content,
      parser: "raw-last-resort",
      metadata: { engine: "raw (last resort)", charCount: content.length },
    };
  } catch {
    return {
      text: `[Unable to read: ${path.basename(filePath)}]`,
      parser: "none",
      metadata: { engine: "none", charCount: 0 },
    };
  }
}

module.exports = {
  parseDocument,
  availableParsers,
  getParserStrategy,
};