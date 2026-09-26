'use strict';

/**
 * Verification of an edited package before it is delivered:
 *   1. structural: every ZIP entry outside the edited parts is byte-identical;
 *      edited parts are well-formed XML; parts that must never change as a
 *      side effect (styles, numbering, theme, settings, the section setup)
 *      are guarded unless an operation explicitly targeted them.
 *   2. diff: which paragraphs/rows changed, compared with what the ops touched.
 *   3. render: LibreOffice renders the result; page count vs the original and
 *      every value the model says it wrote is visible in the rendered text.
 *   4. visual: the rendered pages are compared pixel by pixel with the
 *      original — changed zones are boxed for the model and the user.
 * Returns { ok, issues[], report } — issues are Spanish, actionable sentences
 * the agent receives to self-correct.
 */

const PizZip = require('pizzip');
const { XMLValidator } = require('fast-xml-parser');
const X = require('./xml-scan');
const { assertBoundedOfficePackage } = require('../document-editing/edit-output-proof');

/** Parts an edit must not touch unless an op deliberately targets them. */
const PROTECTED_PART_RE = /^word\/(?:styles|numbering|settings|fontTable|webSettings|stylesWithEffects)\.xml$|^word\/theme\//;

function bytesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function paragraphSignatures(xml) {
  const root = X.scan(xml);
  const out = [];
  X.walk(root, (node) => {
    if (node.name === 'w:p') {
      out.push(X.outerXml(xml, node));
      return false;
    }
    return true;
  });
  return out;
}

/** Longest-common-subsequence diff size between two signature lists (bounded). */
function diffCount(a, b) {
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) return { changed: Math.abs(n - m), approximate: true };
  let prev = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    const cur = new Array(m + 1).fill(0);
    for (let j = 1; j <= m; j += 1) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    prev = cur;
  }
  const common = prev[m];
  return { removed: n - common, added: m - common, changed: Math.max(n, m) - common };
}

function normalizeText(text) {
  return String(text || '')
    .toLocaleLowerCase('es')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[\s­]+/g, '');
}

/** The body-level section properties (page size, margins, orientation, columns). */
function bodySectPr(xml) {
  const matches = [...String(xml || '').matchAll(/<w:sectPr(?:\s[^>]*)?(?:\/>|>[\s\S]*?<\/w:sectPr>)/g)];
  if (!matches.length) return '';
  // The document-level sectPr is the last child of w:body; paragraph-level
  // ones (section breaks) live inside w:pPr and come earlier.
  return matches[matches.length - 1][0];
}

function collectStoryText(zip) {
  return Object.keys(zip.files).filter((name) => /^word\/(?:document|header\d+|footer\d+|footnotes|endnotes)\.xml$/.test(name))
    .map((name) => {
      const xml = zip.file(name).asText();
      return [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => X.decodeEntities(m[1])).join('');
    }).join('\n');
}

async function verifyEditedDocx({
  originalBuffer,
  editedBuffer,
  changedParts = [],
  expectedValues = [],
  render = null,
  originalRender = null,
  renderPages = null,
  originalRenderPages = null,
  authorizedParts = [],
  allowSectionChange = false,
} = {}) {
  const issues = [];
  const report = { changedParts, identicalEntries: 0, totalEntries: 0 };

  let original;
  let edited;
  try {
    assertBoundedOfficePackage(originalBuffer);
    assertBoundedOfficePackage(editedBuffer);
    original = new PizZip(originalBuffer);
    edited = new PizZip(editedBuffer);
  } catch {
    return { ok: false, issues: ['El archivo editado no es un ZIP de Word válido.'], report };
  }
  const changed = new Set(changedParts);
  const authorized = new Set(authorizedParts);
  let actualChanges = 0;
  for (const name of Object.keys(original.files)) {
    const a = original.file(name);
    if (!a || a.dir) continue;
    report.totalEntries += 1;
    const b = edited.file(name);
    if (!b) {
      issues.push(`Falta la parte ${name} en el archivo editado.`);
      continue;
    }
    const identical = bytesEqual(a.asUint8Array(), b.asUint8Array());
    if (changed.has(name)) {
      if (!identical) {
        actualChanges += 1;
        if (PROTECTED_PART_RE.test(name) && !authorized.has(name)) {
          issues.push(`La parte ${name} (estilos, numeración, tema o configuración) cambió sin que la petición lo requiriera. Deshaz ese cambio: solo se editan las partes necesarias.`);
        }
      }
      continue;
    }
    if (identical) report.identicalEntries += 1;
    else issues.push(`La parte ${name} cambió sin que ninguna operación la editara.`);
  }
  for (const name of Object.keys(edited.files)) {
    if (!edited.files[name].dir && !original.file(name)) issues.push(`Se agregó una parte no autorizada: ${name}.`);
  }
  if (!actualChanges) issues.push('El documento no contiene ningún cambio efectivo respecto del original.');
  report.diff = {};
  for (const name of changed) {
    if (!original.file(name) || !edited.file(name)) {
      issues.push(`Falta la parte editada ${name}.`);
      continue;
    }
    const after = edited.file(name)?.asText() || '';
    const valid = XMLValidator.validate(after);
    if (valid !== true) {
      issues.push(`La parte ${name} quedó con XML inválido (${valid.err?.msg || 'error'}).`);
      continue;
    }
    const before = original.file(name)?.asText() || '';
    if (name === 'word/document.xml' && !allowSectionChange && bodySectPr(before) !== bodySectPr(after)) {
      report.sectionChanged = true;
      issues.push('La configuración de sección del documento (tamaño de página, márgenes u orientación) cambió. Restaura la sección original: la edición debe limitarse al contenido pedido.');
    }
    try {
      report.diff[name] = diffCount(paragraphSignatures(before), paragraphSignatures(after));
    } catch {
      report.diff[name] = null;
    }
  }

  // Check claimed values in reopened story text even when no renderer exists.
  const storyText = collectStoryText(edited);
  const values = (expectedValues || []).map((v) => String(v || '').trim()).filter(Boolean);
  for (const value of values) {
    if (!normalizeText(storyText).includes(normalizeText(value))) issues.push(`El valor «${value.slice(0, 60)}» no aparece en el archivo editado.`);
  }
  report.rendered = false;
  if (typeof render === 'function') {
    try {
      const after = await render(editedBuffer);
      if (!Number.isSafeInteger(after?.pages) || after.pages < 1 || typeof after.text !== 'string') throw new Error('Render sin páginas o texto válido');
      const before = originalRender ? await originalRender() : null;
      report.pagesAfter = after.pages;
      if (before) report.pagesBefore = before.pages;
      // Page growth can be explicitly requested or legitimate reflow. The
      // intent reviewer checks unauthorized additions; page count is a fact,
      // not a blanket rejection of valid long edits.
      report.pageCountChanged = Boolean(before && after.pages !== before.pages);
      const rendered = normalizeText(after.text);
      const story = normalizeText(storyText);
      // pdftotext interleaves table columns line by line, so a value written
      // into a narrow cell ("Coherente con las variables de estudio.") rarely
      // survives as one contiguous string. When the value IS in the story XML,
      // accept it if its words are visible in the render; only values absent
      // from both are a real placement problem.
      const visibleInRender = (v) => {
        const value = normalizeText(v);
        if (rendered.includes(value)) return true;
        if (!story.includes(value)) return false;
        const words = String(v).split(/\s+/).map(normalizeText).filter((w) => w.length >= 3);
        if (!words.length) return true;
        const hits = words.filter((w) => rendered.includes(w)).length;
        return hits >= Math.ceil(words.length * 0.8);
      };
      const missing = (expectedValues || [])
        .map((v) => String(v || '').trim())
        .filter(Boolean)
        .filter((v) => !visibleInRender(v));
      if (missing.length) {
        issues.push(`Estos valores no aparecen en el documento renderizado: ${missing.map((v) => `«${v.slice(0, 60)}»`).join(', ')}. Verifica que la edición quedó en el lugar correcto.`);
      }
      report.rendered = true;
    } catch (err) {
      report.rendered = false;
      report.renderError = String(err?.message || err).slice(0, 200);
      issues.push('No pude renderizar el archivo editado para comprobar que se abre y muestra los cambios.');
    }
  }

  // Visual comparison: look at the pages, not only the text.
  if (report.rendered && typeof renderPages === 'function' && actualChanges > 0) {
    try {
      const { comparePageSets, pngDataUri } = require('./visual-diff');
      const afterPages = await renderPages(editedBuffer);
      const beforePages = originalRenderPages ? await originalRenderPages() : [];
      const compared = await comparePageSets(beforePages, afterPages, {
        annotate: true, pagesBefore: report.pagesBefore ?? null, pagesAfter: report.pagesAfter ?? null,
      });
      const comparedPages = compared.pages.map((p) => p.page);
      const maxCompared = comparedPages.length ? Math.max(...comparedPages) : 0;
      const partial = Number.isInteger(report.pagesAfter) && report.pagesAfter > maxCompared;
      report.visual = {
        summary: compared.summary + (partial ? `\n(Se compararon las primeras ${maxCompared} páginas de ${report.pagesAfter}.)` : ''),
        anyChange: compared.anyChange,
        partial,
        pages: compared.pages.map((p) => (p.diff
          ? { page: p.page, identical: p.diff.identical, changedRatio: Number(p.diff.changedRatio.toFixed(4)), regions: p.diff.regions, width: p.diff.width, height: p.diff.height }
          : { page: p.page, missing: p.missing })),
        annotated: compared.annotated.map((a) => ({ page: a.page, dataUri: pngDataUri(a.png) })),
      };
      if (!compared.anyChange && !partial) {
        issues.push('Ninguna página muestra cambios visibles respecto del original. Comprueba que la edición quedó en el lugar correcto y se ve en el documento.');
      }
    } catch (err) {
      report.visual = { error: String(err?.message || err).slice(0, 200) };
    }
  }
  return { ok: issues.length === 0, issues, report };
}

module.exports = { verifyEditedDocx, diffCount, paragraphSignatures, bodySectPr, PROTECTED_PART_RE };
