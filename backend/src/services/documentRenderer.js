/**
 * documentRenderer — converts non-web-native office documents to PDF
 * for high-fidelity preview in the unified viewer.
 *
 * Why we need a server-side step:
 *   PPTX, PPT, DOC, RTF, ODP, ODS and ODT cannot be rendered 1:1 in the
 *   browser. Hand-rolled XML extraction (JSZip) gets text + images but
 *   loses layouts, fonts, slide masters, animations, page geometry.
 *   LibreOffice (or Gotenberg, which wraps LibreOffice) produces a PDF
 *   that matches the source visually, and the browser then renders that
 *   PDF with pdf.js — same path as native PDF previews.
 *
 * Engine resolution:
 *   1. If env `GOTENBERG_URL` is set → POST the file to Gotenberg's
 *      `/forms/libreoffice/convert` endpoint. Best for serverless /
 *      containerised deployments where LibreOffice isn't on the host.
 *   2. Else, spawn local `soffice` (LibreOffice headless). Configurable
 *      via env `LIBREOFFICE_BIN` (defaults to `soffice` on PATH).
 *   3. If neither is available, throws `RendererUnavailableError` so the
 *      route can return 503 cleanly and the viewer falls back to the
 *      JSZip text-only renderer.
 *
 * Output cache:
 *   Cached at `<UPLOAD_DIR>/_rendered/<fileId>.pdf`. Files are
 *   immutable (each upload gets a fresh DB row + filename) so the id is
 *   a safe cache key — no hashing required.
 */

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const UPLOAD_DIR = process.env.UPLOAD_DIR || 'uploads';
const RENDER_CACHE_DIR = path.join(UPLOAD_DIR, '_rendered');
const LIBREOFFICE_BIN = process.env.LIBREOFFICE_BIN || 'soffice';
const GOTENBERG_URL = process.env.GOTENBERG_URL || null;
const RENDER_TIMEOUT_MS = parseInt(process.env.RENDER_TIMEOUT_MS, 10) || 60_000;

// MIME types we know how to convert. The viewer should only call us for
// these — anything else returns 415 from the route.
const CONVERTIBLE_MIMES = new Set([
  // Word
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/rtf',
  'text/rtf',
  // PowerPoint
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // Excel OOXML (legacy .xls is rejected at upload policy level).
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  // OpenDocument
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
]);

const CONVERTIBLE_EXTS = new Set([
  'doc', 'docx', 'rtf',
  'ppt', 'pptx',
  'xlsx',
  'odt', 'ods', 'odp',
]);

class RendererUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RendererUnavailableError';
    this.code = 'RENDERER_UNAVAILABLE';
  }
}

class RendererUnsupportedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RendererUnsupportedError';
    this.code = 'RENDERER_UNSUPPORTED';
  }
}

function isConvertible(mimeType, originalName) {
  if (mimeType && CONVERTIBLE_MIMES.has(mimeType.toLowerCase())) return true;
  const ext = (originalName || '').split('.').pop()?.toLowerCase();
  return ext ? CONVERTIBLE_EXTS.has(ext) : false;
}

async function ensureCacheDir() {
  await fsp.mkdir(RENDER_CACHE_DIR, { recursive: true });
}

function cachePathFor(fileId) {
  return path.join(RENDER_CACHE_DIR, `${fileId}.pdf`);
}

async function pathExists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

// ─── Gotenberg engine ────────────────────────────────────────────────

async function convertViaGotenberg(srcPath, originalName) {
  // Lazy require — don't pull form-data unless we're actually using it.
  const FormData = require('form-data');
  const fetch = (...a) => import('node-fetch').then(({ default: f }) => f(...a));

  const form = new FormData();
  form.append('files', fs.createReadStream(srcPath), { filename: originalName });

  const url = GOTENBERG_URL.replace(/\/$/, '') + '/forms/libreoffice/convert';
  // Bound the external converter: without a timeout a hung Gotenberg blocks
  // the render (and the upstream request) indefinitely. Abort after a
  // configurable deadline and surface a clear timeout error.
  const timeoutMs = Number(process.env.GOTENBERG_TIMEOUT_MS) || RENDER_TIMEOUT_MS || 60_000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      body: form,
      headers: form.getHeaders(),
      signal: ac.signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error(`Gotenberg conversion timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Gotenberg ${res.status}: ${txt.slice(0, 240)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return buf;
}

// ─── Local LibreOffice engine ────────────────────────────────────────

async function commandExists(bin) {
  return new Promise((resolve) => {
    const child = spawn(bin, ['--version'], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

async function convertViaLibreOffice(srcPath) {
  // Per-invocation user profile dir avoids the "another instance is
  // running" lock when concurrent uploads hit the renderer. Cleaned up
  // in the finally block. (LibreOffice's lockfile is in the profile.)
  const profileDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lo-profile-'));
  const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lo-out-'));

  try {
    await new Promise((resolve, reject) => {
      const args = [
        `-env:UserInstallation=file://${profileDir}`,
        '--headless',
        '--norestore',
        '--nolockcheck',
        '--nodefault',
        '--nofirststartwizard',
        '--convert-to', 'pdf',
        '--outdir', outDir,
        srcPath,
      ];
      const child = spawn(LIBREOFFICE_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d.toString(); });

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`LibreOffice timed out after ${RENDER_TIMEOUT_MS}ms`));
      }, RENDER_TIMEOUT_MS);

      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`LibreOffice exited ${code}: ${stderr.slice(0, 240)}`));
      });
    });

    // LibreOffice writes `<basename>.pdf` to outDir.
    const baseNoExt = path.basename(srcPath, path.extname(srcPath));
    const outPath = path.join(outDir, `${baseNoExt}.pdf`);
    if (!(await pathExists(outPath))) {
      throw new Error(`LibreOffice produced no output for ${path.basename(srcPath)}`);
    }
    return await fsp.readFile(outPath);
  } finally {
    // Best-effort cleanup; don't propagate cleanup errors.
    fsp.rm(profileDir, { recursive: true, force: true }).catch(() => {});
    fsp.rm(outDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Render a source document to PDF. Returns the cached PDF path.
 *
 * @param {{ id: string, path: string, mimeType: string, originalName: string }} file
 * @returns {Promise<{ pdfPath: string, fromCache: boolean, engine: 'gotenberg'|'libreoffice' }>}
 */
async function renderToPdf(file) {
  if (!isConvertible(file.mimeType, file.originalName)) {
    throw new RendererUnsupportedError(`Format not convertible: ${file.mimeType || file.originalName}`);
  }

  await ensureCacheDir();
  const pdfPath = cachePathFor(file.id);

  if (await pathExists(pdfPath)) {
    return { pdfPath, fromCache: true, engine: 'cache' };
  }

  // Pick engine.
  let engine;
  let pdfBuffer;
  if (GOTENBERG_URL) {
    engine = 'gotenberg';
    pdfBuffer = await convertViaGotenberg(file.path, file.originalName);
  } else if (await commandExists(LIBREOFFICE_BIN)) {
    engine = 'libreoffice';
    pdfBuffer = await convertViaLibreOffice(file.path);
  } else {
    throw new RendererUnavailableError(
      `No conversion engine available. Install LibreOffice (\`${LIBREOFFICE_BIN}\`) on the backend host, or set GOTENBERG_URL to point at a Gotenberg instance.`
    );
  }

  // Atomic write — write to a sibling tmp then rename. Prevents partial
  // PDFs from being served if two requests for the same file race.
  const tmpPath = `${pdfPath}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmpPath, pdfBuffer);
  await fsp.rename(tmpPath, pdfPath);

  return { pdfPath, fromCache: false, engine };
}

module.exports = {
  renderToPdf,
  isConvertible,
  RendererUnavailableError,
  RendererUnsupportedError,
};
