'use strict';

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const MARKER_BIN = process.env.MARKER_BIN || 'marker';
const MARKER_TIMEOUT_MS = Number.parseInt(process.env.MARKER_TIMEOUT_MS || '120000', 10);

function markerAvailable() {
  return new Promise((resolve) => {
    execFile(MARKER_BIN, ['--version'], { timeout: 5000 }, (err, stdout) => {
      resolve(!err && stdout.length > 0);
    });
  });
}

async function parsePDFWithMarker(filePath) {
  if (!fs.existsSync(filePath)) {
    throw Object.assign(new Error(`File not found: ${filePath}`), { status: 404 });
  }
  const available = await markerAvailable();
  if (!available) {
    return { parser: 'marker', available: false, text: null, fallback: true };
  }
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marker-output-'));
  try {
    await new Promise((resolve, reject) => {
      execFile(MARKER_BIN, [filePath, outputDir, '--output_format', 'markdown', '--paginate_output'], { timeout: MARKER_TIMEOUT_MS, maxBuffer: 50 * 1024 * 1024 }, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
    const baseName = path.basename(filePath, path.extname(filePath));
    const mdFiles = fs.readdirSync(outputDir).filter(f => f.endsWith('.md'));
    if (mdFiles.length === 0) {
      return { parser: 'marker', available: true, text: null, fallback: true, error: 'No markdown output from marker' };
    }
    const texts = mdFiles.map(f => fs.readFileSync(path.join(outputDir, f), 'utf-8'));
    return { parser: 'marker', available: true, text: texts.join('\n\n'), pageCount: texts.length, fallback: false };
  } catch (err) {
    return { parser: 'marker', available: true, text: null, fallback: true, error: err.message };
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
}

function createMarkerParser() {
  return { name: 'marker', fileTypes: ['pdf'], available: markerAvailable, parse: parsePDFWithMarker, description: 'Marker PDF parser — preserves tables and LaTeX formulas' };
}

module.exports = { createMarkerParser, markerAvailable, parsePDFWithMarker };
