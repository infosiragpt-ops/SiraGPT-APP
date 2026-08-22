'use strict';

/**
 * Pipeline: unpack → map → edit → validate → render → verify → done.
 * Isolated path: ephemeral docker run --rm (no network). Vision runs on
 * this control worker (has network) via DeepSeek only.
 * Fallback: in-process PizZip when Docker/image is missing (CI / tests).
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
const { runEphemeralSandbox } = require('./runner');
const artifacts = require('./artifact-store');
const { parseClosedDsl, looksLikeXmlOrCode } = require('./visual-dsl');

function emit(jobId, type, payload, onEvent) {
  const ev = jobId ? appendEvent(jobId, type, payload) : { type, ...payload };
  persistResume(jobId, ev);
  if (typeof onEvent === 'function') onEvent(ev);
  return ev;
}

function persistResume(jobId, ev) {
  if (!jobId || !ev) return;
  try {
    const resume = require('../ai/stream-resume');
    const chunk = JSON.stringify(ev);
    if (chunk.length > 8000) return;
    void resume.append(jobId, chunk).catch(() => {});
  } catch { /* resume is best-effort */ }
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

function applyClosedPatches(documentXmlPath, ops) {
  if (!ops || !ops.length || !documentXmlPath || !fs.existsSync(documentXmlPath)) return 0;
  const script = path.resolve(__dirname, '../../../../packages/doc-skills/scripts/apply_visual_patch.py');
  if (!fs.existsSync(script)) return 0;
  const r = spawnSync('python3', [script, '--document', documentXmlPath, '--ops', JSON.stringify({ ops })], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  return r.status === 0 ? 1 : 0;
}

function trySandboxTransform({ jobId, sourceBuffer, templateBuffer, work }) {
  if (process.env.NODE_ENV === 'test' && process.env.DOC_ENGINE_FORCE_SANDBOX !== '1') {
    return null;
  }
  const paths = artifacts.writeInputs(jobId || `local-${Date.now()}`, { sourceBuffer, templateBuffer });
  fs.mkdirSync(paths.output, { recursive: true });
  const outPath = path.join(paths.output, 'output.docx');
  const ran = runEphemeralSandbox({
    jobId: jobId || 'local',
    sourcePath: paths.sourcePath,
    templatePath: paths.templatePath,
    outPath,
  });
  if (!ran.ok) return null;
  return { buffer: fs.readFileSync(outPath), outPath, via: 'sandbox' };
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

    const { resultFromDocxBuffer } = require('./transform-to-template');
    const sandboxed = trySandboxTransform({ jobId, sourceBuffer, templateBuffer, work });
    const transformed = sandboxed
      ? resultFromDocxBuffer(sandboxed.buffer, { via: 'sandbox', outPath: sandboxed.outPath })
      : transformToTemplate({
        sourceBuffer,
        templateBuffer,
        workDir: path.join(work, 'out'),
      });

    emit(jobId, 'validate', { label: 'Validando XML y r:id vs .rels' }, onEvent);
    if (transformed.templateSectPr !== transformed.resultSectPr) {
      throw new Error('sectPr de la plantilla no quedó byte-idéntico');
    }

    emit(jobId, 'render', { label: 'Renderizando preview PDF/PNG' }, onEvent);
    let renderSrc = transformed.outPath;
    if (!renderSrc || !fs.existsSync(renderSrc)) {
      renderSrc = path.join(work, 'preview-src.docx');
      fs.writeFileSync(renderSrc, transformed.buffer);
    }
    const preview = tryRenderPreview(renderSrc, path.join(work, 'preview'));
    const pages = countPdfPages(fs.readFileSync(preview.pdf));
    if (pages < 1) throw new Error('el PDF de preview tiene 0 páginas');

    emit(jobId, 'verify', { label: 'Verify visual DeepSeek V4 Flash/Pro' }, onEvent);
    const skipVerify = process.env.NODE_ENV === 'test' && !verifyDeps;
    const verify = skipVerify
      ? { ok: true, skipped: true, iterations: 0, log: [{ reason: 'test_skip' }], ops: [] }
      : await runVerifyLoop({
        pages: preview.pages,
        instructions,
        jobId,
      }, verifyDeps || {});

    if (verify.ops && verify.ops.length && !looksLikeXmlOrCode(JSON.stringify(verify.ops))) {
      const unpacked = path.join(work, 'out', 'unpacked', 'word', 'document.xml');
      try { parseClosedDsl(verify.ops); applyClosedPatches(unpacked, verify.ops); } catch { /* closed DSL only */ }
    }

    if (jobId && transformed.buffer) {
      artifacts.writeOutput(jobId, transformed.buffer, 'output.docx');
    }

    const artifact = {
      buffer: Buffer.from(transformed.buffer),
      filename: 'documento-formato.docx',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      pdfPages: pages,
      styleMap: transformed.styleMap,
      headerFooter: transformed.headerFooterAfter,
      verify,
      path: jobId ? path.join(artifacts.jobDir(jobId), 'out', 'output.docx') : null,
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
  applyClosedPatches,
};
