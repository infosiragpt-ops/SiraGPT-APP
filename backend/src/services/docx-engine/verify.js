'use strict';

/**
 * Verification of an edited package before it is delivered:
 *   1. structural: every ZIP entry outside the edited parts is byte-identical;
 *      edited parts are well-formed XML.
 *   2. diff: which paragraphs/rows changed, compared with what the ops touched.
 *   3. render: LibreOffice renders the result; page count vs the original and
 *      every value the model says it wrote is visible in the rendered text.
 * Returns { ok, issues[], report } — issues are Spanish, actionable sentences
 * the agent receives to self-correct.
 */

const PizZip = require('pizzip');
const { XMLValidator } = require('fast-xml-parser');
const X = require('./xml-scan');
const { assertBoundedOfficePackage } = require('../document-editing/edit-output-proof');

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
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[\s\u00ad]+/g, '');
}

async function verifyEditedDocx({
  originalBuffer,
  editedBuffer,
  changedParts = [],
  expectedValues = [],
  render = null,
  originalRender = null,
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
    if (changed.has(name)) {
      if (!bytesEqual(a.asUint8Array(), b.asUint8Array())) actualChanges += 1;
      continue;
    }
    if (bytesEqual(a.asUint8Array(), b.asUint8Array())) report.identicalEntries += 1;
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
    try {
      report.diff[name] = diffCount(paragraphSignatures(before), paragraphSignatures(after));
    } catch {
      report.diff[name] = null;
    }
  }

  // Check claimed values in reopened story text even when no renderer exists.
  const storyText = Object.keys(edited.files).filter((name) => /^word\/(?:document|header\d+|footer\d+|footnotes|endnotes)\.xml$/.test(name))
    .map((name) => {
      const xml = edited.file(name).asText();
      return [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => X.decodeEntities(m[1])).join('');
    }).join('\n');
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
      const missing = (expectedValues || [])
        .map((v) => String(v || '').trim())
        .filter(Boolean)
        .filter((v) => !rendered.includes(normalizeText(v)));
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
  return { ok: issues.length === 0, issues, report };
}

module.exports = { verifyEditedDocx, diffCount, paragraphSignatures };
