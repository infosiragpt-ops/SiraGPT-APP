"use strict";

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs").promises;
const { getLogger } = require("../agents/structured-logger");

const log = getLogger("document-parsers.marker");

const MARKER_PYTHON_PATH =
  process.env.MARKER_PYTHON_PATH || "marker_single";
const MARKER_OUTPUT_DIR =
  process.env.MARKER_OUTPUT_DIR || path.join(process.env.TMPDIR || "/tmp", "siragpt-marker");

let _markerAvailable = null;

async function isMarkerAvailable() {
  if (_markerAvailable !== null) return _markerAvailable;
  try {
    await fs.mkdir(MARKER_OUTPUT_DIR, { recursive: true });
    await new Promise((resolve, reject) => {
      const proc = spawn(MARKER_PYTHON_PATH, ["--help"], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10000,
      });
      let stdout = "";
      proc.stdout.on("data", (d) => { stdout += d.toString(); });
      proc.on("error", reject);
      proc.on("close", (code) => {
        if (code === 0) {
          _markerAvailable = true;
          resolve();
        } else {
          _markerAvailable = false;
          reject(new Error(`marker --help exited ${code}`));
        }
      });
    });
  } catch (err) {
    log.warn("marker not available", { error: err.message });
    _markerAvailable = false;
  }
  return _markerAvailable;
}

/**
 * Parse a PDF file using Marker (VikParuchuri/marker).
 * Returns markdown with preserved tables and LaTeX formulas.
 * Falls back to pdf-parse if Marker is unavailable or fails.
 *
 * @param {string} filePath - absolute path to the PDF file
 * @param {object} [options]
 * @param {number} [options.timeoutMs=120000] - timeout for the subprocess
 * @param {boolean} [options.singleThread=false] - single-threaded mode
 * @param {boolean} [options.forceOcr=false] - force OCR even on text PDFs
 * @returns {Promise<{ text: string, parser: string, metadata?: object }>}
 */
async function parseWithMarker(filePath, options = {}) {
  const timeoutMs = options.timeoutMs || 120000;

  if (!(await isMarkerAvailable())) {
    log.info("marker unavailable, delegating to fallback");
    throw new Error("marker_not_available");
  }

  const args = [filePath, MARKER_OUTPUT_DIR, "--output_format", "markdown"];

  if (options.singleThread) args.push("--single_threaded");
  if (options.forceOcr) args.push("--force_ocr");

  log.info("running marker", { filePath, outputDir: MARKER_OUTPUT_DIR });

  const runMarker = () =>
    new Promise((resolve, reject) => {
      const proc = spawn(MARKER_PYTHON_PATH, args, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (d) => { stdout += d.toString(); });
      proc.stderr.on("data", (d) => { stderr += d.toString(); });

      const timer = setTimeout(() => {
        proc.kill("SIGTERM");
        reject(new Error(`marker timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      proc.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });

      proc.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(
            new Error(
              `marker exited with code ${code}: ${stderr.slice(0, 500)}`
            )
          );
        }
      });
    });

  try {
    const rawOutput = await runMarker();

    // Marker writes output to <MARKER_OUTPUT_DIR>/<basename>/<basename>.md
    const basename = path.basename(filePath, path.extname(filePath));
    const expectedMarkdown = path.join(MARKER_OUTPUT_DIR, basename, `${basename}.md`);

    let markdownText = rawOutput;
    try {
      const mdContent = await fs.readFile(expectedMarkdown, "utf8");
      if (mdContent.trim().length > 0) {
        markdownText = mdContent;
      }
    } catch {
      // If the file doesn't exist, use stdout as fallback
      if (rawOutput.trim().length > 0) {
        markdownText = rawOutput;
      } else {
        throw new Error("marker produced no output");
      }
    }

    log.info("marker succeeded", {
      filePath,
      chars: markdownText.length,
      outputFile: expectedMarkdown,
    });

    return {
      text: markdownText,
      parser: "marker",
      metadata: {
        engine: "marker (VikParuchuri/marker)",
        outputFile: expectedMarkdown,
        charCount: markdownText.length,
      },
    };
  } catch (err) {
    log.warn("marker failed, will fall back to pdf-parse", {
      filePath,
      error: err.message,
    });
    throw err;
  }
}

/**
 * Full parse pipeline: try Marker, fall back to pdf-parse.
 *
 * @param {string} filePath
 * @param {object} [options]
 * @returns {Promise<{ text: string, parser: string, metadata?: object }>}
 */
async function parsePdfWithMarkerFallback(filePath, options = {}) {
  try {
    return await parseWithMarker(filePath, options);
  } catch (markerErr) {
    log.warn("marker fallback triggered, using pdf-parse", {
      filePath,
      markerError: markerErr.message,
    });
    try {
      const pdf = require("pdf-parse");
      const dataBuffer = await fs.readFile(filePath);
      const data = await pdf(dataBuffer);
      return {
        text: data.text,
        parser: "pdf-parse",
        metadata: {
          engine: "pdf-parse (fallback)",
          pages: data.numpages,
          charCount: data.text.length,
        },
      };
    } catch (pdfErr) {
      log.error("pdf-parse fallback also failed", {
        filePath,
        markerError: markerErr.message,
        pdfParseError: pdfErr.message,
      });
      throw new Error(
        `PDF parsing failed (marker: ${markerErr.message}, pdf-parse: ${pdfErr.message})`
      );
    }
  }
}

parseWithMarker.isAvailable = isMarkerAvailable;

module.exports = {
  parseWithMarker,
  parsePdfWithMarkerFallback,
  isMarkerAvailable,
};
