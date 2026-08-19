/**
 * pptx-package-validator — phase 6 of the Validation Fabric (PPTX).
 *
 * The PPTX equivalent of MathRenderValidator. Opens the package as
 * a JSZip, reads `ppt/presentation.xml` to count slide refs, then
 * confirms the slide XML files those refs point at actually exist.
 * Refuses to mark "Validado" on a presentation that came back with
 * 0 slides (pipeline crash mid-build), broken references (template
 * generation skipped slide files), or a corrupted ZIP.
 *
 * Static check only — visual fidelity belongs in the future
 * PreviewScreenshotValidator (Playwright). This pass costs ~30 ms
 * per artifact and runs in production.
 *
 * Public API:
 *   countPptxStructure(buffer)
 *     -> Promise<{ ok, reason?, sheets: never, slideRefs, slideFiles, ok?: boolean }>
 *   validatePptxPackage({ buffer, prompt })
 *     -> Promise<{ ok, reason?, slideRefs, slideFiles, contentExpected }>
 */

const JSZip = require('jszip');

const PPTX_MIN_BYTES = 200;
const MIN_SLIDES_DEFAULT = 1;

const SLIDE_REF_RE = /<p:sldId\b[^/>]*?(?:r:id|r:embed)="([^"]+)"/g;
const SLIDE_FILE_RE = /^ppt\/slides\/slide\d+\.xml$/i;

async function countPptxStructure(buffer) {
  if (!buffer
    || (Buffer.isBuffer(buffer) && buffer.length < PPTX_MIN_BYTES)
    || (typeof buffer === 'string' && !buffer.length)) {
    return { ok: false, reason: 'empty_buffer', slideRefs: 0, slideFiles: 0 };
  }

  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (err) {
    return { ok: false, reason: `zip_open_failed: ${err.message || 'unknown'}`, slideRefs: 0, slideFiles: 0 };
  }

  // PPTX presentation manifest. If this file is missing the package
  // isn't a valid presentation — most likely a renamed docx/xlsx.
  const presentation = zip.file('ppt/presentation.xml');
  if (!presentation) {
    return { ok: false, reason: 'missing_presentation_xml', slideRefs: 0, slideFiles: 0 };
  }

  let presentationXml;
  try {
    presentationXml = await presentation.async('string');
  } catch (err) {
    return { ok: false, reason: `xml_read_failed: ${err.message || 'unknown'}`, slideRefs: 0, slideFiles: 0 };
  }

  const slideRefs = (presentationXml.match(SLIDE_REF_RE) || []).length;

  // Count actual slideN.xml files inside the zip — catches the
  // failure mode where the manifest references slide ids but the
  // slide bodies were never written (template crash).
  let slideFiles = 0;
  zip.forEach((relativePath) => {
    if (SLIDE_FILE_RE.test(relativePath)) slideFiles += 1;
  });

  return { ok: true, slideRefs, slideFiles };
}

const CONTENT_HINT_RE = new RegExp(
  [
    'presentaci[óo]n', 'pptx?\\b', 'power\\s*point', 'diapositivas',
    'slides', 'deck', 'tesis', 'defensa', 'pitch', 'demo',
  ].join('|'),
  'i',
);

function expectsSlides(text) {
  if (!text || typeof text !== 'string') return false;
  return CONTENT_HINT_RE.test(text);
}

async function validatePptxPackage({ buffer, prompt, sourceText, minSlides } = {}) {
  const structure = await countPptxStructure(buffer);
  const contentExpected = expectsSlides(prompt) || expectsSlides(sourceText);
  if (!structure.ok) {
    return { ...structure, contentExpected };
  }
  const limit = Number.isFinite(minSlides) ? minSlides : MIN_SLIDES_DEFAULT;
  if (structure.slideFiles < limit) {
    return {
      ok: false,
      reason: 'no_slides_rendered',
      slideRefs: structure.slideRefs,
      slideFiles: structure.slideFiles,
      contentExpected,
    };
  }
  if (structure.slideRefs > 0 && structure.slideRefs !== structure.slideFiles) {
    // Manifest says N slides but only M files made it onto disk —
    // the deck is broken and PowerPoint will surface a corruption
    // dialog the moment the user opens it.
    return {
      ok: false,
      reason: 'slide_manifest_mismatch',
      slideRefs: structure.slideRefs,
      slideFiles: structure.slideFiles,
      contentExpected,
    };
  }
  return { ...structure, contentExpected };
}

module.exports = {
  countPptxStructure,
  validatePptxPackage,
  expectsSlides,
};
