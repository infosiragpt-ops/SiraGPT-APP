'use strict';

// The document-agent loop accepts PDF outputs from the selected model. A
// filename and nonzero bytes are not evidence that the file opens or that a
// requested literal replacement was actually made. Use the PDF parser already
// shipped with the backend; keep this check independent of the model/sandbox.

let pdfJsPromise;

function quotedReplacementPairs(instruction) {
  const value = String.raw`(?:«([^»]+)»|“([^”]+)”|"([^"]+)"|'([^']+)')`;
  const pair = new RegExp(String.raw`${value}\s*(?:por|con|a|to|with|→|->|para\s+que\s+(?:diga|sea|quede\s+como))\s*${value}`, 'giu');
  return [...String(instruction || '').matchAll(pair)].map((match) => ({
    before: match.slice(1, 5).find(Boolean),
    after: match.slice(5, 9).find(Boolean),
  })).filter(({ before, after }) => before && after && before !== after);
}

// A simple unquoted instruction can still identify an exact replacement. Keep
// this intentionally narrow: ambiguous prose is not a safe source of a PDF
// text plan, and quoted pairs above remain authoritative when present.
function unquotedReplacementPairs(instruction) {
  const command = /\b(?:cambia|reemplaza|sustituye|change|replace)\s+(?:(?:solo|solamente|únicamente)\s+)?(?:(?:el|la)\s+(?:título|texto|frase|palabra|nombre|fecha)\s+(?:de\s+)?)?([^.;:\n]{2,100}?)\s+(?:por|con|a|to|with|→|->)\s+([^.;:\n]{2,100})(?:[.;:\n]|$)/giu;
  return [...String(instruction || '').matchAll(command)].map((match) => ({
    before: match[1].trim(),
    after: match[2].replace(/\s+(?:y\s+)?(?:conserva|mant[eé]n|preserva)\b.*$/iu, '').trim(),
  })).filter(({ before, after }) => before && after && before !== after
    && !/[«»“”"']/.test(before + after));
}

function normalizedText(value) {
  return String(value || '').normalize('NFC').replace(/\s+/gu, ' ').trim();
}

async function inspectPdf(buffer, { withText = false } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new Error('invalid_pdf_header');
  }
  pdfJsPromise ||= import('pdfjs-dist/legacy/build/pdf.mjs');
  const { getDocument } = await pdfJsPromise;
  const loading = getDocument({
    data: Uint8Array.from(buffer),
    isEvalSupported: false,
    useSystemFonts: true,
    stopAtErrors: true,
  });
  let document;
  try {
    document = await loading.promise;
    if (!document.numPages) throw new Error('empty_pdf');
    const pages = [];
    for (let number = 1; number <= document.numPages; number += 1) {
      const page = await document.getPage(number);
      const viewport = page.getViewport({ scale: 1 });
      const items = withText
        ? (await page.getTextContent()).items.filter((item) => normalizedText(item.str)).map((item) => ({
          text: normalizedText(item.str),
          x: Number(item.transform?.[4]),
          y: Number(item.transform?.[5]),
          size: Math.hypot(Number(item.transform?.[0]), Number(item.transform?.[1])),
        }))
        : [];
      pages.push({ width: viewport.width, height: viewport.height, items });
      page.cleanup();
    }
    return pages;
  } finally {
    if (document) await document.destroy();
    else await loading.destroy();
  }
}

function textChangeMatches(beforePages, afterPages, pairs) {
  if (beforePages.length !== afterPages.length) return false;
  const seenPairs = new Set();
  for (let pageIndex = 0; pageIndex < beforePages.length; pageIndex += 1) {
    const before = beforePages[pageIndex];
    const after = afterPages[pageIndex];
    if (Math.abs(before.width - after.width) > 0.5 || Math.abs(before.height - after.height) > 0.5) return false;
    if (before.items.length !== after.items.length) return false;
    const remaining = new Map();
    for (const item of after.items) {
      if (!remaining.has(item.text)) remaining.set(item.text, []);
      remaining.get(item.text).push(item);
    }
    for (const original of before.items) {
      let expected = original.text;
      for (const [pairIndex, pair] of pairs.entries()) {
        if (expected.includes(pair.before)) {
          expected = expected.replaceAll(pair.before, pair.after);
          seenPairs.add(pairIndex);
        }
      }
      const candidates = remaining.get(expected) || [];
      const matchIndex = candidates.findIndex((candidate) =>
        Math.abs(candidate.x - original.x) <= 0.75
        && Math.abs(candidate.y - original.y) <= 0.75
        && Math.abs(candidate.size - original.size) <= 0.5);
      if (matchIndex < 0) return false;
      candidates.splice(matchIndex, 1);
    }
    if ([...remaining.values()].some((items) => items.length)) return false;
  }
  return seenPairs.size === pairs.length;
}

async function validateEditedPdf({ originalBuffer, editedBuffer, instruction = '' } = {}) {
  const quoted = Buffer.isBuffer(originalBuffer) ? quotedReplacementPairs(instruction) : [];
  const pairs = quoted.length ? quoted : (Buffer.isBuffer(originalBuffer) ? unquotedReplacementPairs(instruction) : []);
  let after;
  try {
    after = await inspectPdf(editedBuffer, { withText: pairs.length > 0 });
  } catch {
    return { ok: false, reason: 'pdf_unreadable' };
  }
  if (!pairs.length) return { ok: true, reason: 'pdf_readable' };
  let before;
  try {
    before = await inspectPdf(originalBuffer, { withText: true });
  } catch {
    return { ok: false, reason: 'pdf_baseline_unreadable' };
  }
  // An unquoted color/layout instruction can resemble a text replacement.
  // Only impose the strict literal-text gate when its old phrase is actually
  // present in the PDF's extracted text; quoted pairs are explicit regardless.
  if (!quoted.length && !pairs.every(({ before: needle }) => before.some((page) =>
    normalizedText(page.items.map((item) => item.text).join(' ')).includes(normalizedText(needle))))) {
    return { ok: true, reason: 'pdf_readable' };
  }
  return textChangeMatches(before, after, pairs)
    ? { ok: true, reason: 'pdf_literal_edit_verified' }
    : { ok: false, reason: 'pdf_edit_unverified' };
}

module.exports = { validateEditedPdf, quotedReplacementPairs, unquotedReplacementPairs };
