"use strict";

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs").promises;
const { getLogger } = require("../agents/structured-logger");
const { resolveProcessMimeType } = require("../fileProcessor");

const log = getLogger("document-parsers.docling");

const DOCLING_PYTHON_PATH =
  process.env.DOCLING_PYTHON_PATH || "docling";

let _doclingAvailable = null;

async function isDoclingAvailable() {
  if (_doclingAvailable !== null) return _doclingAvailable;
  try {
    await new Promise((resolve, reject) => {
      const proc = spawn(DOCLING_PYTHON_PATH, ["--help"], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10000,
      });
      let stdout = "";
      proc.stdout.on("data", (d) => { stdout += d.toString(); });
      proc.on("error", reject);
      proc.on("close", (code) => {
        if (code === 0) {
          _doclingAvailable = true;
          resolve();
        } else {
          _doclingAvailable = false;
          reject(new Error(`docling --help exited ${code}`));
        }
      });
    });
  } catch (err) {
    log.warn("docling not available", { error: err.message });
    _doclingAvailable = false;
  }
  return _doclingAvailable;
}

/**
 * Parse a document using IBM Docling.
 * Supports PDF, DOCX, PPTX input. Returns markdown with document
 * structure preserved (headings, tables, lists, reading order).
 *
 * @param {string} filePath - absolute path to the document
 * @param {object} [options]
 * @param {number} [options.timeoutMs=180000] - timeout for the subprocess
 * @param {object} [options.file] - multer-style file object for MIME detection fallback
 * @returns {Promise<{ text: string, parser: string, metadata?: object }>}
 */
async function parseWithDocling(filePath, options = {}) {
  const timeoutMs = options.timeoutMs || 180000;

  if (!(await isDoclingAvailable())) {
    log.info("docling unavailable, delegating to fallback");
    throw new Error("docling_not_available");
  }

  const args = [filePath, "--to", "md"];

  log.info("running docling", { filePath });

  return new Promise((resolve, reject) => {
    const proc = spawn(DOCLING_PYTHON_PATH, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`docling timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        const text = stdout.trim();
        if (text.length === 0) {
          reject(new Error("docling produced empty output"));
          return;
        }
        log.info("docling succeeded", { filePath, chars: text.length });
        resolve({
          text,
          parser: "docling",
          metadata: {
            engine: "docling (IBM)",
            charCount: text.length,
          },
        });
      } else {
        reject(
          new Error(
            `docling exited with code ${code}: ${stderr.slice(0, 500)}`
          )
        );
      }
    });
  });
}

/**
 * Try docling; if it fails, fall back to mammoth (DOCX) or
 * officeparser (PPTX, mixed formats).
 *
 * @param {string} filePath
 * @param {object} [options]
 * @param {object} [options.file] - file object for MIME resolution
 * @returns {Promise<{ text: string, parser: string, metadata?: object }>}
 */
async function parseWithDoclingFallback(filePath, options = {}) {
  try {
    return await parseWithDocling(filePath, options);
  } catch (doclingErr) {
    log.warn("docling fallback triggered", {
      filePath,
      doclingError: doclingErr.message,
    });

    try {
      const file = options.file || { path: filePath };
      const mime = resolveProcessMimeType(file);
      const ext = path.extname(filePath).toLowerCase();

      if (mime.includes("wordprocessingml") || mime.includes("msword") || ext === ".docx" || ext === ".doc") {
        const mammoth = require("mammoth");
        const { value: html } = await mammoth.convertToHtml({ path: filePath });
        // Lightweight HTML→markdown (same as fileProcessor's approach)
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
          metadata: {
            engine: "mammoth (fallback after docling)",
            charCount: md.length,
          },
        };
      }

      // Generic fallback: officeparser
      try {
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
          metadata: {
            engine: "officeparser (fallback after docling)",
            charCount: text.length,
          },
        };
      } catch {
        // Final fallback: read raw buffer
        const buf = await fs.readFile(filePath);
        return {
          text: `[binary document: ${path.basename(filePath)}, ${buf.length} bytes]`,
          parser: "raw",
          metadata: { engine: "raw (binary fallback)", charCount: 0 },
        };
      }
    } catch (fallbackErr) {
      log.error("all docling fallbacks failed", {
        filePath,
        doclingError: doclingErr.message,
        fallbackError: fallbackErr.message,
      });
      throw new Error(
        `Document parsing failed (docling: ${doclingErr.message}, fallback: ${fallbackErr.message})`
      );
    }
  }
}

parseWithDocling.isAvailable = isDoclingAvailable;

module.exports = {
  parseWithDocling,
  parseWithDoclingFallback,
  isDoclingAvailable,
};
