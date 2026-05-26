"use strict";

/**
 * Parser provider aggregator — exposes the project's document parsers
 * as a provider map compatible with document-pipeline-registry's
 * `dispatchParse({ providers })` contract.
 *
 * Each provider is an async fn `({ source, format, mime }) → { text,
 * parser, metadata }` where `source` is the file path (string) or a
 * Buffer. The dispatcher tries providers in preference order until
 * one succeeds.
 *
 * The provider IDs match the IDs declared in
 *   backend/src/services/sira/document-pipeline-registry.js
 * so the registry's `chooseParsers({ mime })` ranking flows naturally
 * into `dispatchParse({ providers: getLocalParsers() })`.
 *
 * Coverage today:
 *   marker     → PDF (via VikParuchuri/marker subprocess)
 *   docling    → PDF, DOCX, PPTX (via IBM docling subprocess)
 *   markitdown → DOCX, XLSX, PPTX, HTML, MD, PDF (via Microsoft markitdown)
 *   mammoth    → DOCX
 *   pdf-parse  → PDF (pure JS fallback)
 *   officeparser → PPTX (fallback)
 *   exceljs    → XLSX (fallback)
 *
 * Adding a parser: register its module here and the registry will pick
 * it up automatically through its declared preference rank.
 */

const { parseWithMarker } = require("../../document-parsers/marker");
const { parseWithDocling } = require("../../document-parsers/docling");
const { parseWithMarkitdown } = require("../../document-parsers/markitdown");
const fs = require("fs").promises;

/**
 * Wraps a parser function in the async provider shape required by
 * `dispatchParse`. The parser receives `source` (file path or buffer)
 * and must return `{ text, parser, metadata }`.
 */
function wrapParser(parserFn, parserId) {
  return async function provider({ source, format, mime } = {}) {
    const filePath = typeof source === "string" ? source : null;
    if (!filePath) {
      throw new Error(`${parserId} requires a file path (string source)`);
    }
    const out = await parserFn(filePath);
    if (!out || typeof out.text !== "string") {
      throw new Error(`${parserId} returned empty or invalid output`);
    }
    return out;
  };
}

/**
 * @returns {Record<string, (args: { source: string|Buffer, format?: string, mime?: string }) => Promise<{ text: string, parser: string, metadata?: object }>>}
 */
function getLocalParsers() {
  return {
    marker: wrapParser(parseWithMarker, "marker"),
    docling: wrapParser(parseWithDocling, "docling"),
    markitdown: wrapParser(parseWithMarkitdown, "markitdown"),
    mammoth: (async ({ source } = {}) => {
      const filePath = typeof source === "string" ? source : null;
      if (!filePath) throw new Error("mammoth requires a file path");
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
      return { text: md, parser: "mammoth", metadata: { engine: "mammoth" } };
    }),
    "pdf-parse": (async ({ source, mime } = {}) => {
      const filePath = typeof source === "string" ? source : null;
      const buffer = Buffer.isBuffer(source) ? source : null;
      const pdf = require("pdf-parse");
      const dataBuffer = buffer || await fs.readFile(filePath);
      const data = await pdf(dataBuffer);
      return {
        text: data.text,
        parser: "pdf-parse",
        metadata: { engine: "pdf-parse", pages: data.numpages },
      };
    }),
    officeparser: (async ({ source } = {}) => {
      const filePath = typeof source === "string" ? source : null;
      if (!filePath) throw new Error("officeparser requires a file path");
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
      return { text, parser: "officeparser", metadata: { engine: "officeparser" } };
    }),
    exceljs: (async ({ source } = {}) => {
      const filePath = typeof source === "string" ? source : null;
      if (!filePath) throw new Error("exceljs requires a file path");
      const { readXlsxFile, selectWorkbookWorksheets, worksheetRows } = require("../../xlsx-safe-workbook");
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
      return { text, parser: "exceljs", metadata: { engine: "exceljs" } };
    }),
  };
}

/**
 * Convenience: full one-shot dispatch using the local parser set.
 * Returns the dispatcher's success envelope
 * (`{ format, parser_used, output, errors }`).
 * Throws if no provider in the registry's preference-ranked list succeeds.
 *
 * @param {object} args
 * @param {string|Buffer} args.source       - file path or buffer
 * @param {string} [args.mime]              - MIME type
 * @param {string} [args.ext]               - file extension
 * @param {object} [args.runtime]           - forwarded to chooseParsers
 * @param {object} [args.requires]          - forwarded to chooseParsers
 * @returns {Promise<{ format: string, parser_used: string, output: object, errors: Array }>}
 */
async function parseWithLocalProviders({ source, mime, ext, runtime, requires } = {}) {
  const registry = require("../document-pipeline-registry");
  return registry.dispatchParse({
    source,
    mime,
    ext,
    requires,
    runtime: runtime || { node: true, python: true, binary: true },
    providers: getLocalParsers(),
  });
}

module.exports = {
  getLocalParsers,
  parseWithLocalProviders,
};
