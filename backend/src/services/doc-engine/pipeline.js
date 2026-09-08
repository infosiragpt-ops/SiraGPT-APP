'use strict';

/**
 * Pipeline in-process: unpack → map → edit → validate → render → verify.
 * El worker Docker llama a los scripts Python; este módulo es el fallback
 * determinista (CI / sin daemon) y la fuente de verdad de transformToTemplate.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { transformToTemplate } = require('./transform-to-template');
const { unpackBuffer, countPdfPages, makeStubPdf } = require('./ooxml');
const { runVerifyLoop } = require('./verify-loop');
const { appendEvent, setArtifact, setError } = require('./job-store');
const { getDocEngineConfig } = require('./flags');

function emit(jobId, type, payload, onEvent) {
  const ev = jobId ? appendEvent(jobId, type, payload) : { type, ...payload };
  if (typeof onEvent === 'function') onEvent(ev);
  return ev;
}

function hasSoffice() {
  const r = spawnSync('sh', ['-c', 'command -v soffice || command -v libreoffice'], {
    encoding: 'utf8',
    timeout: 2_000,
  });
  return r.status === 0 && String(r.stdout || '').trim().length > 0;
}

function tryRenderPreview(docxPath, previewDir, { allowSoffice = process.env.NODE_ENV !== 'test' } = {}) {
  fs.mkdirSync(previewDir, { recursive: true });
  const script = path.resolve(__dirname, '../../../../packages/doc-skills/scripts/render_preview.py');
  if (allowSoffice && fs.existsSync(script) && hasSoffice()) {
    const r = spawnSync('python3', [script, docxPath, previewDir], {
      timeout: 90_000,
      encoding: 'utf8',
    });
    if (r.status === 0) {
      const pdf = fs.readdirSync(previewDir).find((n) => n.endsWith('.pdf'));
      const pages = fs.readdirSync(previewDir).filter((n) => n.endsWith('.png')).map((n) => path.join(previewDir, n));
      if (pdf) return { pdf: path.join(previewDir, pdf), pages, stub: false };
    }
  }
  const stub = path.join(previewDir, 'output.pdf');
  fs.writeFileSync(stub, makeStubPdf());
  return { pdf: stub, pages: [], stub: true };
}

async function runPipeline({
  sourceBuffer,
  templateBuffer,
  instructions = '',
  jobId = null,
  userId = null,
  onEvent,
  verifyDeps,
} = {}) {
  const cfg = getDocEngineConfig();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `doc-engine-${jobId || 'local'}-`));
  try {
    emit(jobId, 'unpack', { label: 'Desempaquetando source y plantilla' }, onEvent);
    const srcUnpack = path.join(work, 'source');
    const tmplUnpack = path.join(work, 'template');
    unpackBuffer(sourceBuffer, srcUnpack);
    unpackBuffer(templateBuffer, tmplUnpack);

    emit(jobId, 'map', { label: 'Mapeando w:styleId source→plantilla' }, onEvent);
    emit(jobId, 'edit', { label: 'Transplantando w:p / w:tbl (sectPr intacto)' }, onEvent);
    const transformed = transformToTemplate({
      sourceBuffer,
      templateBuffer,
      workDir: path.join(work, 'out'),
    });

    emit(jobId, 'validate', { label: 'Validando XML y r:id vs .rels' }, onEvent);
    if (transformed.templateSectPr !== transformed.resultSectPr) {
      throw new Error('sectPr de la plantilla no quedó byte-idéntico');
    }

    emit(jobId, 'render', { label: 'Renderizando preview PDF/PNG' }, onEvent);
    const preview = tryRenderPreview(transformed.outPath, path.join(work, 'preview'));
    const pages = countPdfPages(fs.readFileSync(preview.pdf));
    if (pages < 1) throw new Error('el PDF de preview tiene 0 páginas');

    emit(jobId, 'verify', { label: 'Verify visual DeepSeek V4 Flash/Pro' }, onEvent);
    const skipVerify = process.env.NODE_ENV === 'test' && !verifyDeps;
    const verify = skipVerify
      ? { ok: true, skipped: true, iterations: 0, log: [{ reason: 'test_skip' }] }
      : await runVerifyLoop({
        pages: preview.pages,
        instructions,
        jobId,
      }, verifyDeps || {});

    const artifact = {
      buffer: Buffer.from(transformed.buffer),
      filename: 'documento-formato.docx',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      pdfPages: pages,
      styleMap: transformed.styleMap,
      headerFooter: transformed.headerFooterAfter,
      verify,
    };
    if (jobId) setArtifact(jobId, artifact);
    emit(jobId, 'done', {
      label: 'Listo',
      filename: artifact.filename,
      pdfPages: pages,
      verifySkipped: Boolean(verify.skipped),
    }, onEvent);
    return { ok: true, artifact, timeoutMs: cfg.timeoutMs, userId };
  } catch (err) {
    const message = String(err?.message || err).slice(0, 2000);
    if (jobId) setError(jobId, message);
    emit(jobId, 'error', { message }, onEvent);
    return { ok: false, error: message };
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* cleanup best-effort */ }
  }
}

module.exports = {
  runPipeline,
  tryRenderPreview,
};
