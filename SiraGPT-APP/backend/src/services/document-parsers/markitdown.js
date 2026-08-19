"use strict";

const { spawn } = require("child_process");
const path = require("path");
const { getLogger } = require("../agents/structured-logger");
const { resolveProcessMimeType } = require("../fileProcessor");

const log = getLogger("document-parsers.markitdown");

const MARKITDOWN_PYTHON_PATH =
  process.env.MARKITDOWN_PYTHON_PATH || "markitdown";

let _markitdownAvailable = null;

async function isMarkitdownAvailable() {
  if (_markitdownAvailable !== null) return _markitdownAvailable;
  try {
    await new Promise((resolve, reject) => {
      const proc = spawn(MARKITDOWN_PYTHON_PATH, ["--help"], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10000,
      });
      let stdout = "";
      proc.stdout.on("data", (d) => { stdout += d.toString(); });
      proc.on("error", reject);
      proc.on("close", (code) => {
        if (code === 0) {
          _markitdownAvailable = true;
          resolve();
        } else {
          _markitdownAvailable = false;
          reject(new Error(`markitdown --help exited ${code}`));
        }
      });
    });
  } catch (err) {
    log.warn("markitdown not available", { error: err.message });
    _markitdownAvailable = false;
  }
  return _markitdownAvailable;
}

/**
 * Parse a document using Microsoft's MarkItDown.
 * Converts DOCX, XLSX, PPTX, HTML to clean markdown.
 * Fast path for simple documents.
 *
 * @param {string} filePath - absolute path to the document
 * @param {object} [options]
 * @param {number} [options.timeoutMs=90000] - timeout for the subprocess
 * @returns {Promise<{ text: string, parser: string, metadata?: object }>}
 */
async function parseWithMarkitdown(filePath, options = {}) {
  const timeoutMs = options.timeoutMs || 90000;

  if (!(await isMarkitdownAvailable())) {
    log.info("markitdown unavailable, delegating to fallback");
    throw new Error("markitdown_not_available");
  }

  const args = [filePath];

  log.info("running markitdown", { filePath });

  return new Promise((resolve, reject) => {
    const proc = spawn(MARKITDOWN_PYTHON_PATH, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`markitdown timed out after ${timeoutMs}ms`));
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
          reject(new Error("markitdown produced empty output"));
          return;
        }
        log.info("markitdown succeeded", { filePath, chars: text.length });
        resolve({
          text,
          parser: "markitdown",
          metadata: {
            engine: "markitdown (Microsoft)",
            charCount: text.length,
          },
        });
      } else {
        reject(
          new Error(
            `markitdown exited with code ${code}: ${stderr.slice(0, 500)}`
          )
        );
      }
    });
  });
}

/**
 * Try markitdown; if it fails, fall back to officeparser.
 *
 * @param {string} filePath
 * @param {object} [options]
 * @returns {Promise<{ text: string, parser: string, metadata?: object }>}
 */
async function parseWithMarkitdownFallback(filePath, options = {}) {
  try {
    return await parseWithMarkitdown(filePath, options);
  } catch (mdErr) {
    log.warn("markitdown fallback triggered, using officeparser", {
      filePath,
      markitdownError: mdErr.message,
    });
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
          engine: "officeparser (fallback after markitdown)",
          charCount: text.length,
        },
      };
    } catch (officeErr) {
      log.error("officeparser fallback also failed", {
        filePath,
        markitdownError: mdErr.message,
        officeError: officeErr.message,
      });
      throw new Error(
        `Document parsing failed (markitdown: ${mdErr.message}, officeparser: ${officeErr.message})`
      );
    }
  }
}

parseWithMarkitdown.isAvailable = isMarkitdownAvailable;

module.exports = {
  parseWithMarkitdown,
  parseWithMarkitdownFallback,
  isMarkitdownAvailable,
};
