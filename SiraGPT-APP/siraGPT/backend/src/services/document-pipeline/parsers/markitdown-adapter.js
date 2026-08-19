'use strict';

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const MARKITDOWN_BIN = process.env.MARKITDOWN_BIN || 'markitdown';
const MARKITDOWN_TIMEOUT_MS = Number.parseInt(process.env.MARKITDOWN_TIMEOUT_MS || '60000', 10);

function markitdownAvailable() {
  return new Promise((resolve) => {
    execFile(MARKITDOWN_BIN, ['--version'], { timeout: 5000 }, (err, stdout) => {
      resolve(!err && stdout.length > 0);
    });
  });
}

async function parseOfficeWithMarkItDown(filePath) {
  if (!fs.existsSync(filePath)) {
    throw Object.assign(new Error(`File not found: ${filePath}`), { status: 404 });
  }
  const available = await markitdownAvailable();
  if (!available) {
    return { parser: 'markitdown', available: false, text: null, fallback: true };
  }
  const outputFile = path.join(os.tmpdir(), `markitdown-${Date.now()}.md`);
  try {
    await new Promise((resolve, reject) => {
      execFile(MARKITDOWN_BIN, [filePath, '-o', outputFile], { timeout: MARKITDOWN_TIMEOUT_MS, maxBuffer: 30 * 1024 * 1024 }, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
    if (!fs.existsSync(outputFile)) {
      return { parser: 'markitdown', available: true, text: null, fallback: true, error: 'No output from markitdown' };
    }
    return { parser: 'markitdown', available: true, text: fs.readFileSync(outputFile, 'utf-8'), fallback: false };
  } catch (err) {
    return { parser: 'markitdown', available: true, text: null, fallback: true, error: err.message };
  } finally {
    if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
  }
}

function createMarkItDownParser() {
  return { name: 'markitdown', fileTypes: ['docx', 'xlsx', 'pptx'], available: markitdownAvailable, parse: parseOfficeWithMarkItDown, description: 'Microsoft MarkItDown — DOCX/XLSX/PPTX to clean Markdown' };
}

module.exports = { createMarkItDownParser, markitdownAvailable, parseOfficeWithMarkItDown };
