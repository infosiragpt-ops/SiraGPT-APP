'use strict';

const PizZip = require('pizzip');
const adapter = require('./pptx-adapter');

function parts(zip) { return Object.keys(zip.files).filter((name) => !zip.files[name].dir).sort(); }
function sameParts(before, after, names) {
  return names.every((name) => after.file(name) && before.file(name).asNodeBuffer().equals(after.file(name).asNodeBuffer()));
}

// A transport/ZIP success is not an edit. Ignore packaging timestamps and
// core metadata so a repacked unchanged document cannot become a deliverable.
function verifyContentChanged(before, after, format) {
  if (!Buffer.isBuffer(before) || !Buffer.isBuffer(after) || !after.length) return { passed: false, reason: 'missing_buffer' };
  if (before.equals(after)) return { passed: false, reason: 'unchanged_document' };
  if (!['docx', 'pptx', 'xlsx'].includes(format)) return { passed: true, scope: 'bytes_changed_only' };
  try {
    const a = new PizZip(before); const b = new PizZip(after);
    const namesA = parts(a).filter((name) => !name.startsWith('docProps/'));
    const namesB = parts(b).filter((name) => !name.startsWith('docProps/'));
    if (JSON.stringify(namesA) === JSON.stringify(namesB) && sameParts(a, b, namesA))
      return { passed: false, reason: 'unchanged_document_content' };
    return { passed: true, scope: 'package_content_changed_only' };
  } catch { return { passed: false, reason: 'invalid_office_package' }; }
}

function verifySlideTitleEdit(before, after, edit) {
  try {
    const delta = verifyContentChanged(before, after, 'pptx');
    if (!delta.passed) return delta;
    const slidesBefore = adapter.listPptxSlides(before); const slidesAfter = adapter.listPptxSlides(after);
    const targetBefore = slidesBefore.find((slide) => slide.number === edit.slideNumber);
    const targetAfter = slidesAfter.find((slide) => slide.number === edit.slideNumber);
    if (!targetBefore || !targetAfter || targetAfter.title !== edit.title)
      return { passed: false, reason: 'requested_title_not_applied' };
    if (slidesBefore.length !== slidesAfter.length || targetBefore.partName !== targetAfter.partName)
      return { passed: false, reason: 'slide_structure_changed' };
    const a = new PizZip(before); const b = new PizZip(after); const names = parts(a);
    if (JSON.stringify(names) !== JSON.stringify(parts(b)) || !sameParts(a, b, names.filter((name) => name !== targetBefore.partName)))
      return { passed: false, reason: 'unrequested_package_changes' };
    const xmlBefore = a.file(targetBefore.partName).asText(); const xmlAfter = b.file(targetBefore.partName).asText();
    const shapeBefore = adapter.INTERNAL.findTitleShape(xmlBefore); const shapeAfter = adapter.INTERNAL.findTitleShape(xmlAfter);
    const redact = (shape) => shape.replace(/(<a:t\b[^>]*>)[\s\S]*?(<\/a:t>)/g, '$1$2');
    if (!shapeBefore || !shapeAfter || redact(shapeBefore.shape) !== redact(shapeAfter.shape)
      || xmlBefore.replace(shapeBefore.shape, '') !== xmlAfter.replace(shapeAfter.shape, ''))
      return { passed: false, reason: 'unrequested_slide_changes' };
    return { passed: true, scope: 'requested_slide_title_and_unchanged_other_parts', slideNumber: edit.slideNumber, slideCount: slidesAfter.length };
  } catch { return { passed: false, reason: 'title_edit_verification_failed' }; }
}

module.exports = { verifyContentChanged, verifySlideTitleEdit };
