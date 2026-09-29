'use strict';
const path = require('path');
const adapter = require('../document-editing/pptx-adapter');
const { parsePresentationTitleEdit, isScopedSlideMutation, documentReferenceText } = require('../document-editing/presentation-title-intent');
const { verifySlideTitleEdit, assertBoundedOfficePackage } = require('../document-editing/edit-output-proof');

function trySurgicalPresentationFollowup({ instruction, files = [] }) {
  const candidates = files.filter((file) => /\.pptx$/i.test(file.name || '') && Buffer.isBuffer(file.buffer));
  if (!candidates.length && files.length) return null; // Word/Excel/PDF title edits belong to their own adapters.
  const prior = candidates.filter((file) => file.isPriorArtifact);
  const looksLikeTitle = parsePresentationTitleEdit(instruction);
  if (!isScopedSlideMutation(instruction) && !looksLikeTitle) return null;
  if (!candidates.length && !/\b(?:pptx?|presentaci[oó]n|diapositiva\w*|l[aá]mina\w*|landin\w*|slide\w*|portada)\b/i.test(instruction)) return null;
  const outsideQuotes = documentReferenceText(instruction);
  const named = candidates.filter((file) => {
    const name = path.basename(file.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![\\p{L}\\p{N}_.-])${name}(?![\\p{L}\\p{N}_-]|\\.[\\p{L}\\p{N}])`, 'iu').test(outsideQuotes);
  });
  const targets = named.length ? named : prior.length ? prior : candidates;
  // A slide location alone does not mean the single-title grammar can fulfill
  // the request. In a mixed-document batch the intact instruction names all
  // sources and may contain several edits; decline it before treating that
  // batch scope as an error. The inferred-title form needs the existing slide
  // text to compile, so keep that exact path grounded in the selected source.
  let compiledSource = null;
  let compiledSlides = null;
  if (!looksLikeTitle && targets.length === 1) {
    compiledSource = targets[0];
    try {
      assertBoundedOfficePackage(compiledSource.buffer);
      compiledSlides = adapter.listPptxSlides(compiledSource.buffer);
    } catch {
      return failure('No pude abrir esta presentación dentro de los límites seguros. Comprueba el archivo o adjunta una versión más pequeña; no modifiqué el original.');
    }
    if (!parsePresentationTitleEdit(instruction, { slides: compiledSlides })) return null;
  }
  // This fast path edits ONE source only. Never silently reduce "both" to
  // the previous artifact, or let recency override a file the user names.
  if (/\bamb[oa]s\b|\b(?:tod[oa]s|cada|los\s+(?:dos|tres)|las\s+(?:dos|tres))\s+(?:(?:los|las)\s+)?(?:pptx?|presentaciones?|archivos?|documentos?)\b/i.test(outsideQuotes))
    return failure('Esta edición indica varias presentaciones. Indica un archivo por turno; no modifiqué ninguno.');
  if (/\.pptx\b/i.test(outsideQuotes) && named.length === 0)
    return failure('No encontré la presentación nombrada entre los archivos disponibles. Adjunta esa versión; no modifiqué otra en su lugar.');
  if (targets.length !== 1) {
    if (!looksLikeTitle && !/\b(?:landin\w*|t[ií]tulo)\b/i.test(instruction)) return null;
    return failure('Indica qué presentación debo editar o adjunta el PPTX original. No generé un reemplazo.');
  }
  const source = targets[0];
  let slides;
  try {
    if (source === compiledSource) slides = compiledSlides;
    else {
      assertBoundedOfficePackage(source.buffer);
      slides = adapter.listPptxSlides(source.buffer);
    }
  } catch {
    return failure('No pude abrir esta presentación dentro de los límites seguros. Comprueba el archivo o adjunta una versión más pequeña; no modifiqué el original.');
  }
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
