'use strict';
const path = require('path');
const adapter = require('../document-editing/pptx-adapter');
const { parsePresentationTitleEdit, isScopedSlideMutation } = require('../document-editing/presentation-title-intent');
const { verifySlideTitleEdit } = require('../document-editing/edit-output-proof');

function trySurgicalPresentationFollowup({ instruction, files = [] }) {
  const candidates = files.filter((file) => /\.pptx$/i.test(file.name || '') && Buffer.isBuffer(file.buffer));
  if (!candidates.length && files.length) return null; // Word/Excel/PDF title edits belong to their own adapters.
  const prior = candidates.filter((file) => file.isPriorArtifact);
  const targets = prior.length ? prior : candidates;
  const looksLikeTitle = parsePresentationTitleEdit(instruction);
  if (!isScopedSlideMutation(instruction) && !looksLikeTitle) return null;
  if (!candidates.length && !/\b(?:pptx?|presentaci[oó]n|diapositiva\w*|l[aá]mina\w*|landin\w*|slide\w*|portada)\b/i.test(instruction)) return null;
  if (targets.length !== 1) {
    if (!looksLikeTitle && !/\b(?:landin\w*|t[ií]tulo)\b/i.test(instruction)) return null;
    return failure('Indica qué presentación debo editar o adjunta el PPTX original. No generé un reemplazo.');
  }
  const source = targets[0];
  const slides = adapter.listPptxSlides(source.buffer);
  const edit = parsePresentationTitleEdit(instruction, { slides });
  if (!edit) return null;
  if (!edit.slideNumber && slides.length === 1) edit.slideNumber = 1;
  if (!edit.slideNumber) return failure('Indica en qué diapositiva cambio el título. No modifiqué el archivo.');
  let result;
  try { result = adapter.setSlideTitle({ buffer: source.buffer, slideNumber: edit.slideNumber, title: edit.title }); }
  catch { return failure('No pude localizar el título en la diapositiva indicada. No modifiqué el archivo.'); }
  const proof = verifySlideTitleEdit(source.buffer, result.buffer, edit);
  if (!proof.passed) return failure(proof.reason.startsWith('unchanged')
    ? 'El título ya coincide con el solicitado; no generé una copia sin cambios.'
    : 'No pude verificar la edición y la conservación del PPTX original. No entregué el archivo.');
  return {
    outputs: [{ name: `${path.basename(source.name, path.extname(source.name))}_editado.pptx`, buffer: result.buffer, valid: true,
      validation: { ok: true, passed: true, engine: 'pptx_surgical_edit', ...proof } }],
    finalText: `Listo. Cambié el título de la diapositiva ${edit.slideNumber} a «${edit.title}». Conservé las ${slides.length} diapositivas y las demás partes del archivo sin cambios.`,
    steps: [{ tool: 'set_slide_title', ok: true, slideNumber: edit.slideNumber }], iterations: 0,
    stoppedReason: 'surgical_edit', driver: 'ooxml_surgical',
  };
}
function failure(message) { return { outputs: [], finalText: message, steps: [], iterations: 0, stoppedReason: 'edit_not_applied', driver: 'ooxml_surgical' }; }
module.exports = { trySurgicalPresentationFollowup };
