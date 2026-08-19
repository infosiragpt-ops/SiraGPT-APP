'use strict';

/**
 * document-parser-dispatch — Python CLI-powered parser dispatch for
 * Marker, Docling, MarkItDown, Unstructured, and Surya OCR.
 * Falls back to Node.js-native parsers when Python is unavailable.
 */
const { execFile } = require('node:child_process');
const { readFile, mkdir, unlink } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { parserPlanFor } = require('./document-pipeline');

const DEFAULT_TIMEOUT_MS = 120000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

function createDocumentParserDispatch({ env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const tmpDir = path.join(os.tmpdir(), 'siragpt-parser');
  mkdir(tmpDir, { recursive: true }).catch(() => {});

  async function runParser(binary, args = [], input, opts = {}) {
    const { timeout = timeoutMs } = opts;
    return new Promise((resolve, reject) => {
      execFile(binary, args, { timeout, maxBuffer: MAX_OUTPUT_BYTES, env, windowsHide: true },
        (err, stdout, stderr) => { err ? reject(Object.assign(new Error(`${binary}: ${stderr?.trim() || err.message}`), { code: err.code })) : resolve(stdout || ''); });
    });
  }

  async function runPython(args) { return runParser('python3', args); }
  async function hasPythonModule(name) { try { await runPython(['-c', `import ${name}`], undefined, { timeout: 5000 }); return true; } catch { return false; } }

  async function parseWithMarker(filePath) {
    const outDir = path.dirname(filePath);
    try {
      await runPython(['-m', 'marker_single', filePath, outDir, '--output_format', 'markdown'], undefined, { timeout: timeoutMs * 2 });
      const baseName = path.basename(filePath, path.extname(filePath));
      const outputPath = path.join(outDir, `${baseName}.md`);
      const content = await readFile(outputPath, 'utf-8').catch(() => '');
      await unlink(outputPath).catch(() => {});
      return content;
    } catch { throw new Error('marker unavailable'); }
  }

  async function parseWithDocling(filePath) {
    try {
      return await runPython(['-m', 'docling', 'convert', filePath, '--format', 'markdown'], undefined, { timeout: timeoutMs * 2 });
    } catch { throw new Error('docling unavailable'); }
  }

  async function parseWithMarkItDown(filePath) {
    try { return await runPython(['-m', 'markitdown', filePath], undefined, { timeout: timeoutMs }); } catch { throw new Error('markitdown unavailable'); }
  }

  async function parseWithUnstructured(filePath) {
    try {
      const stdout = await runPython(['-m', 'unstructured.partition.auto', filePath, '--strategy', 'hi_res'], undefined, { timeout: timeoutMs * 2 });
      try { const elements = JSON.parse(stdout); return elements.map(e => e.text || '').filter(Boolean).join('\n\n'); } catch { return stdout || ''; }
    } catch { throw new Error('unstructured unavailable'); }
  }

  async function parseWithSurya(filePath, opts = {}) {
    try {
      return await runPython(['-m', 'surya_ocr', filePath, '--languages', opts.language || 'es'], undefined, { timeout: timeoutMs * 3 });
    } catch { throw new Error('surya unavailable'); }
  }

  async function parseNative(filePath, fileInfo = {}) {
    const name = String(fileInfo.name || '').toLowerCase();
    if (name.endsWith('.txt') || name.endsWith('.md') || name.endsWith('.csv') || name.endsWith('.json')) {
      try { return await readFile(filePath, 'utf-8'); } catch { return ''; }
    }
    if (name.endsWith('.docx')) { try { const mammoth = require('mammoth'); const r = await mammoth.extractRawText({ path: filePath }); return r.value || ''; } catch { return ''; } }
    if (name.endsWith('.pdf')) { try { const pdfParse = require('pdf-parse'); const buf = await readFile(filePath); const data = await pdfParse(buf); return data.text || ''; } catch { return ''; } }
    return '';
  }

  async function parse(filePath, fileInfo = {}, opts = {}) {
    const plan = parserPlanFor(fileInfo);
    for (const parserName of plan) {
      const fns = { marker: parseWithMarker, docling: parseWithDocling, markitdown: parseWithMarkItDown, unstructured: parseWithUnstructured, 'surya-ocr': parseWithSurya };
      const fn = fns[parserName]; if (!fn) continue;
      try { const text = await fn(filePath, opts); if (text?.trim()) return { text, parser: parserName, native: false }; } catch {}
    }
    try { const text = await parseNative(filePath, fileInfo); if (text?.trim()) return { text, parser: 'native', native: true }; } catch {}
    throw Object.assign(new Error(`All parsers failed for ${fileInfo.name || filePath}`), { status: 422 });
  }

  return { parse, parseNative, parseWithMarker, parseWithDocling, parseWithMarkItDown, parseWithUnstructured, parseWithSurya };
}

module.exports = { createDocumentParserDispatch };
