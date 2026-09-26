'use strict';

/**
 * Docx engine — Cowork-grade, model-driven editing of Word documents.
 *
 *   editWordDocument({ buffer, filename, instruction, client, model, … })
 *     → { ok, status, buffer, filename, mime, summary, message, changes, verification }
 *
 * .doc sources are converted to .docx for editing and converted back, so the
 * user receives the same format they uploaded. The picked model drives the
 * edit; this module never chooses a provider.
 */

const path = require('node:path');
const { runDocxEngineEdit } = require('./agent');
const soffice = require('./soffice');
const { sharedDocxRenderer, pdftoppmAvailable } = require('./render');
const { formatChecklist } = require('./checklist');

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const DOC_MIME = 'application/msword';

function isWordFilename(name) {
  return /\.docx?$/i.test(String(name || ''));
}

function docxEngineEnabled() { return true; }

/** Versioned output name: "x.docx" → "x (editado).docx" → "x (editado v2).docx". */
function editedFilename(name) {
  const ext = path.extname(String(name || 'documento.docx')) || '.docx';
  const base = path.basename(String(name || 'documento.docx'), ext);
  // Also recognise the artifact store's sanitised form ("x_-_editado_",
  // "x_-_editado_v2_") so a follow-up edit bumps the version instead of
  // stacking "(editado) (editado)".
  const m = /^(.*?)[\s_]*[-_]?[\s_]*\(?editado(?:[\s_]+v(\d+))?\)?_?$/i.exec(base);
  if (!m || !m[1]) return `${base} (editado)${ext}`;
  const next = m[2] ? Number(m[2]) + 1 : 2;
  return `${m[1]} (editado v${next})${ext}`;
}

function describeChangeForUser(change) {
  if (!change || change.op === 'warning') return null;
  const after = String(change.after || '').trim();
  const before = String(change.before || '').trim();
  switch (change.op) {
    case 'fill_field':
      return `${String(change.label || '').replace(/[\s:：]+$/, '')}: ${change.value || after}`;
    case 'set_cell':
      return before ? `«${before}» → «${after || '(vacío)'}»` : `«${after}»`;
    case 'replace_text':
    case 'delete_text':
      return `«${before}» → «${after || '(eliminado)'}»`;
    case 'insert_paragraph':
      return `Nuevo párrafo: «${after}»`;
    case 'insert_table_row':
      return `Nueva fila: ${after}`;
    case 'delete_paragraph':
    case 'delete_row':
    case 'delete_table':
      return `Eliminado: «${before}»`;
    case 'set_format':
      return `Formato: ${after}`;
    case 'set_checkbox':
      return `Casilla ${before} → ${after}`;
    default:
      return after ? `«${after}»` : null;
  }
}

function buildUserSummary({ modelSummary, changes, verification, filename }) {
  const lines = [];
  const clean = String(modelSummary || '').trim();
  lines.push(clean || `Listo. Edité «${filename}» directamente, conservando su formato original.`);
  // Ground truth from the engine's change log (not the model's claim).
  const described = (changes || []).map(describeChangeForUser).filter(Boolean);
  if (described.length) {
    lines.push('', '**Cambios aplicados en el documento:**');
    for (const d of described.slice(0, 20)) lines.push(`- ${d}`);
    if (described.length > 20) lines.push(`- … y ${described.length - 20} cambio(s) más.`);
  }
  const r = verification?.report || {};
  const facts = [];
  if (r.pagesAfter) {
    if (r.pagesBefore && r.pagesBefore !== r.pagesAfter) facts.push(`${r.pagesBefore} → ${r.pagesAfter} páginas`);
    else if (r.pagesBefore) facts.push(`${r.pagesAfter} página(s), igual que el original`);
    else facts.push(`${r.pagesAfter} página(s)`);
  }
  if (facts.length) lines.push('', `Verificado: ${facts.join('; ')}.`);
  if (Array.isArray(r.checklist) && r.checklist.length) {
    lines.push('', '**Comprobación punto por punto (mirando la captura del documento):**');
    for (const line of formatChecklist(r.checklist).split('\n')) lines.push(`- ${line}`);
  }
  if (r.visual && typeof r.visual.summary === 'string' && r.visual.summary.trim()) {
    lines.push('', `Captura comparada con el original: ${r.visual.summary.split('\n').filter(Boolean).slice(0, 3).join(' ')}`);
  }
  if (r.intent?.missing_information?.length) lines.push('', `Datos que faltan: ${r.intent.missing_information.join('; ')}.`);
  lines.push('', 'El archivo original se conserva.');
  return lines.join('\n');
}

/** Persisted verification: keep facts, drop the page bitmaps (they only serve the loop and the live UI). */
function compactVerification(verification) {
  if (!verification || !verification.report) return verification;
  const { visual, ...rest } = verification.report;
  const report = { ...rest };
  if (visual) {
    const { annotated: _annotated, ...facts } = visual;
    report.visual = facts;
  }
  return { ...verification, report };
}

async function editWordDocument({
  buffer,
  filename = 'documento.docx',
  instruction,
  client,
  model,
  signal,
  onEvent = () => {},
  extraContext = '',
  render: renderOverride,
  renderPages: renderPagesOverride,
  vision = undefined,
  convert: convertOverride,
} = {}) {
  signal?.throwIfAborted();
  const isDoc = /\.doc$/i.test(filename);
  const convert = convertOverride || soffice;
  let workBuffer = buffer;
  if (isDoc) {
    onEvent({ label: 'Abriendo el documento Word' });
    workBuffer = await convert.docToDocx(buffer);
  }
  let render = renderOverride;
  let renderPages = renderPagesOverride;
  if (render === undefined) {
    if (await soffice.sofficeAvailable()) {
      const renderer = sharedDocxRenderer();
      render = (buf) => renderer.render(buf);
      // Page bitmaps need pdftoppm (poppler) next to LibreOffice; without it
      // the loop still verifies structure and rendered text.
      if (renderPages === undefined) renderPages = (await pdftoppmAvailable()) ? (buf, opts) => renderer.pages(buf, opts) : null;
    } else {
      render = null;
    }
  }
  if (renderPages === undefined) renderPages = null;
  const result = await runDocxEngineEdit({
    buffer: workBuffer,
    filename: isDoc ? filename.replace(/\.doc$/i, '.docx') : filename,
    instruction,
    client,
    model,
    signal,
    onEvent,
    render,
    renderPages,
    vision,
    extraContext,
  });
  if (!result.ok) {
    const fallback = result.status === 'needs_input'
      ? (result.summary || 'Necesito un dato más para editar el documento.')
      : result.status === 'cannot'
        ? (result.summary || 'No es posible hacer ese cambio en este documento.')
        : 'No pude completar la edición del documento con el modelo seleccionado. El original no se modificó; inténtalo de nuevo o reformula el cambio.';
    return { ok: false, status: result.status, message: fallback, changes: result.changes, verification: compactVerification(result.verification), checklist: result.checklist || null };
  }
  let outBuffer = result.buffer;
  let outName = editedFilename(filename);
  let mime = DOCX_MIME;
  if (isDoc) {
    try {
      outBuffer = await convert.docxToDoc(result.buffer);
      signal?.throwIfAborted();
      // Verify the DELIVERED legacy bytes, not just the intermediate DOCX.
      const roundtrip = await convert.docToDocx(outBuffer);
      if (typeof render === 'function') {
        const finalRender = await render(roundtrip);
        const workRender = await render(result.buffer);
        const norm = (text) => String(text || '').replace(/\s+/g, ' ').trim();
        if (!Number.isSafeInteger(finalRender?.pages) || finalRender.pages < 1
          || typeof finalRender.text !== 'string' || typeof workRender?.text !== 'string'
          || finalRender.pages !== workRender.pages || norm(finalRender.text) !== norm(workRender.text))
          throw new Error('La conversión final cambió el contenido o la paginación');
      } else {
        // No renderer means the converted binary cannot be proved usable.
        throw new Error('La conversión final no pudo comprobarse');
      }
      mime = DOC_MIME;
    } catch {
      signal?.throwIfAborted();
      // Could not convert back: deliver the faithful .docx instead of failing.
      outName = editedFilename(filename.replace(/\.doc$/i, '.docx'));
      outBuffer = result.buffer;
    }
  }
  signal?.throwIfAborted();
  return {
    ok: true,
    status: 'done',
    buffer: outBuffer,
    filename: outName,
    mime,
    summary: buildUserSummary({ modelSummary: result.summary, changes: result.changes, verification: result.verification, filename })
      + (isDoc ? (mime === DOC_MIME
        ? '\n\nEl archivo .doc requirió conversión para editarlo; se comprobó el contenido de la copia final.'
        : '\n\nTe entrego la copia en .docx porque no pude verificar la conversión de vuelta a .doc.') : ''),
    changes: result.changes,
    verification: compactVerification(result.verification),
    checklist: result.checklist || null,
    iterations: result.iterations,
  };
}

module.exports = {
  editWordDocument,
  isWordFilename,
  docxEngineEnabled,
  editedFilename,
  buildUserSummary,
  compactVerification,
  describeChangeForUser,
  DOCX_MIME,
};
