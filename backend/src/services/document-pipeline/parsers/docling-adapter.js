'use strict';

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const DOCLING_BIN = process.env.DOCLING_BIN || 'docling';
const DOCLING_TIMEOUT_MS = Number.parseInt(process.env.DOCLING_TIMEOUT_MS || '120000', 10);

function doclingAvailable() {
  return new Promise((resolve) => {
    execFile(DOCLING_BIN, ['--version'], { timeout: 5000 }, (err, stdout) => {
      resolve(!err && stdout.length > 0);
    });
  });
}

async function parseWithDocling(filePath, format = 'markdown') {
  if (!fs.existsSync(filePath)) {
    throw Object.assign(new Error(`File not found: ${filePath}`), { status: 404 });
  }
  const available = await doclingAvailable();
  if (!available) {
    return { parser: 'docling', available: false, text: null, fallback: true };
  }
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docling-output-'));
  try {
    await new Promise((resolve, reject) => {
      execFile(DOCLING_BIN, [filePath, '--output', outputDir, '--to', format], { timeout: DOCLING_TIMEOUT_MS, maxBuffer: 50 * 1024 * 1024 }, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
    const baseName = path.basename(filePath, path.extname(filePath));
    const mdFile = path.join(outputDir, `${baseName}.md`);
    const target = fs.existsSync(mdFile) ? mdFile : (fs.readdirSync(outputDir).find(f => f.endsWith('.md')) ? path.join(outputDir, fs.readdirSync(outputDir).find(f => f.endsWith('.md'))) : null);
    if (!target) {
      return { parser: 'docling', available: true, text: null, fallback: true, error: 'No output from docling' };
    }
    return { parser: 'docling', available: true, text: fs.readFileSync(target, 'utf-8'), fallback: false };
  } catch (err) {
    return { parser: 'docling', available: true, text: null, fallback: true, error: err.message };
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
}

function createDoclingParser() {
  return { name: 'docling', fileTypes: ['pdf', 'docx', 'pptx'], available: doclingAvailable, parse: parseWithDocling, description: 'IBM Docling — deep technical document structure understanding' };
}

module.exports = { createDoclingParser, doclingAvailable, parseWithDocling };
