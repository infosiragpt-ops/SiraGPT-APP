'use strict';

/**
 * Minimal LibreOffice bridge for the docx engine: render a buffer to PDF (for
 * verification) and convert between .doc and .docx (legacy Word support).
 * Conversions are serialized — soffice is heavy and flaky in parallel.
 */

const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { buildSofficeConvertArgs, sofficeSpawnEnv } = require('../document-pipeline/soffice-pdf-export');

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 90_000;
let chain = Promise.resolve();
let available = null;

async function sofficeAvailable() {
  if (available !== null) return available;
  try {
    await execFileAsync(process.env.SOFFICE_BIN || 'soffice', ['--version'], { timeout: 15_000 });
    available = true;
  } catch {
    available = false;
  }
  return available;
}

function serialize(task) {
  const job = chain.catch(() => {}).then(task);
  chain = job.catch(() => {});
  return job;
}

async function convertBuffer(buffer, { inputName = 'in.docx', target = 'pdf:writer_pdf_Export', outputExt = '.pdf' } = {}) {
  return serialize(async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'siragpt-docx-engine-'));
    const profileDir = path.join(dir, 'profile');
    const outDir = path.join(dir, 'out');
    await fsp.mkdir(profileDir, { recursive: true });
    await fsp.mkdir(outDir, { recursive: true });
    const sourcePath = path.join(dir, inputName);
    try {
      await fsp.writeFile(sourcePath, buffer);
      const args = buildSofficeConvertArgs({ sourcePath, outDir, profileDir });
      const idx = args.indexOf('--convert-to');
      if (idx !== -1) args[idx + 1] = target;
      await execFileAsync(process.env.SOFFICE_BIN || 'soffice', args, { timeout: TIMEOUT_MS, env: sofficeSpawnEnv(profileDir) });
      const produced = (await fsp.readdir(outDir)).find((f) => f.toLowerCase().endsWith(outputExt));
      if (!produced) throw new Error('LibreOffice no produjo el archivo convertido.');
      return await fsp.readFile(path.join(outDir, produced));
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
}

async function renderDocxToPdf(buffer) {
  return convertBuffer(buffer, { inputName: 'documento.docx', target: 'pdf:writer_pdf_Export', outputExt: '.pdf' });
}

async function docToDocx(buffer) {
  return convertBuffer(buffer, { inputName: 'documento.doc', target: 'docx:MS Word 2007 XML', outputExt: '.docx' });
}

async function docxToDoc(buffer) {
  return convertBuffer(buffer, { inputName: 'documento.docx', target: 'doc:MS Word 97', outputExt: '.doc' });
}

async function pdfInfo(pdfBuffer) {
  const pdfParse = require('pdf-parse/lib/pdf-parse.js');
  const parsed = await pdfParse(pdfBuffer);
  return { pages: parsed.numpages || 0, text: String(parsed.text || '') };
}

module.exports = { sofficeAvailable, renderDocxToPdf, docToDocx, docxToDoc, pdfInfo };
