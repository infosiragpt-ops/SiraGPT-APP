'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

function markerAvailable() {
  try { spawn.sync('marker', ['--help'], { stdio: 'ignore', timeout: 3000 }); return true; } catch (_) { return false; }
}

function markitdownAvailable() {
  try { spawn.sync('markitdown', ['--help'], { stdio: 'ignore', timeout: 3000 }); return true; } catch (_) { return false; }
}

function doclingAvailable() {
  try { spawn.sync('docling', ['--help'], { stdio: 'ignore', timeout: 3000 }); return true; } catch (_) { return false; }
}

function suryaAvailable() {
  try { spawn.sync('surya_ocr', ['--help'], { stdio: 'ignore', timeout: 3000 }); return true; } catch (_) { return false; }
}

async function markerParsePdf(filePath, { env = process.env, logger = console } = {}) {
  const tempDir = path.join(os.tmpdir(), 'siragpt-marker-' + Date.now());
  fs.mkdirSync(tempDir, { recursive: true });
  try {
    const args = [
      filePath,
      tempDir,
      '--output_format', 'markdown',
      '--force_ocr',
      '--use_llm',
    ];
    if (env.SIRAGPT_MARKER_LANGUAGES) args.push('--languages', env.SIRAGPT_MARKER_LANGUAGES);
    const result = await new Promise((resolve, reject) => {
      const proc = spawn('marker', args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
      let stdout = ''; let stderr = '';
      proc.stdout.on('data', d => stdout += d);
      proc.stderr.on('data', d => stderr += d);
      proc.on('close', code => {
        if (code === 0) resolve({ stdout, stderr });
        else reject(new Error(`marker exited ${code}: ${stderr}`));
      });
      proc.on('error', reject);
    });
    const mdPath = path.join(tempDir, path.basename(filePath, path.extname(filePath)), `${path.basename(filePath, path.extname(filePath))}.md`);
    if (fs.existsSync(mdPath)) {
      const content = fs.readFileSync(mdPath, 'utf-8');
      return { provider: 'marker', content, tables: content.includes('|'), latex: content.includes('$$') };
    }
    const altMd = findMdFiles(tempDir);
    if (altMd) return { provider: 'marker', content: fs.readFileSync(altMd, 'utf-8') };
    throw new Error('marker produced no output');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function findMdFiles(dir) {
  try {
    const files = fs.readdirSync(dir, { recursive: true });
    const md = files.find(f => f.endsWith('.md'));
    return md ? path.join(dir, md) : null;
  } catch (_) { return null; }
}

async function markitdownParse(filePath, { env = process.env, logger = console } = {}) {
  const ext = path.extname(filePath).toLowerCase();
  return new Promise((resolve, reject) => {
    const proc = spawn('markitdown', [filePath], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
    let stdout = ''; let stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    proc.on('close', code => {
      if (code === 0) resolve({ provider: 'markitdown', content: stdout, type: ext.slice(1) });
      else reject(new Error(`markitdown exited ${code}: ${stderr}`));
    });
    proc.on('error', reject);
  });
}

async function doclingParse(filePath, { env = process.env, logger = console } = {}) {
  const outPath = filePath + '.docling.json';
  try {
    await new Promise((resolve, reject) => {
      const proc = spawn('docling', [filePath, '--to', 'json', '--output', outPath], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
      let stderr = '';
      proc.stderr.on('data', d => stderr += d);
      proc.on('close', code => {
        if (code === 0) resolve();
        else reject(new Error(`docling exited ${code}: ${stderr}`));
      });
      proc.on('error', reject);
    });
    if (fs.existsSync(outPath)) {
      const json = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
      const content = doclingToMarkdown(json);
      return { provider: 'docling', content, tables: content.includes('|'), latex: content.includes('$$') };
    }
    throw new Error('docling produced no output');
  } finally {
    fs.rmSync(outPath, { force: true });
  }
}

function doclingToMarkdown(json) {
  const parts = [];
  if (Array.isArray(json)) {
    for (const item of json) {
      if (item.type === 'text') parts.push(item.text);
      else if (item.type === 'table') parts.push(doclingTableToMd(item));
      else if (item.type === 'image') parts.push(`![${item.alt || ''}](${item.src || ''})`);
    }
  }
  return parts.join('\n\n');
}

function doclingTableToMd(table) {
  const rows = table.rows || table.data || [];
  if (!rows.length) return '';
  const result = [];
  result.push('| ' + (rows[0].map(c => String(c || '')).join(' | ')) + ' |');
  result.push('| ' + rows[0].map(() => '---').join(' | ') + ' |');
  for (let i = 1; i < rows.length; i++) {
    result.push('| ' + rows[i].map(c => String(c || '')).join(' | ') + ' |');
  }
  return result.join('\n');
}

function createParserAdapter({ env = process.env, logger = console } = {}) {
  return {
    capabilities() {
      return {
        marker: markerAvailable(),
        markitdown: markitdownAvailable(),
        docling: doclingAvailable(),
        suryaOcr: suryaAvailable(),
      };
    },
    async parsePdf(filePath, parser = 'marker') {
      const caps = this.capabilities();
      const pipeline = [parser, ...['marker', 'docling'].filter(p => p !== parser)];
      for (const p of pipeline) {
        if (p === 'marker' && caps.marker) {
          try { return await markerParsePdf(filePath, { env, logger }); } catch (err) { logger.warn?.({ err }, 'marker failed, trying next'); }
        }
        if (p === 'docling' && caps.docling) {
          try { return await doclingParse(filePath, { env, logger }); } catch (err) { logger.warn?.({ err }, 'docling failed, trying next'); }
        }
      }
      throw new Error('All external PDF parsers unavailable');
    },
    async parseOffice(filePath, parser = 'markitdown') {
      if (markitdownAvailable()) {
        try { return await markitdownParse(filePath, { env, logger }); } catch (err) { logger.warn?.({ err }, 'markitdown failed'); }
      }
      throw new Error('MarkItDown not available for office document parsing');
    },
    async suryaOcr(imagePath) {
      if (!suryaAvailable()) throw new Error('Surya OCR not installed');
      return new Promise((resolve, reject) => {
        const proc = spawn('surya_ocr', [imagePath], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
        let stdout = ''; let stderr = '';
        proc.stdout.on('data', d => stdout += d);
        proc.stderr.on('data', d => stderr += d);
        proc.on('close', code => {
          if (code === 0) resolve({ provider: 'surya', content: stdout });
          else reject(new Error(`surya_ocr exited ${code}: ${stderr}`));
        });
        proc.on('error', reject);
      });
    },
  };
}

module.exports = { createParserAdapter, markerAvailable, markitdownAvailable, doclingAvailable, suryaAvailable, markerParsePdf, markitdownParse, doclingParse };
