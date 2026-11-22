'use strict';

/**
 * format-compliance — deterministic post-check + repair for explicit output
 * format constraints ("dame un resumen en 2 párrafos", "en un solo párrafo",
 * "máximo 100 palabras", "en viñetas").
 *
 * `output-format-contract` already turns the request into prompt directives;
 * models still drift (5 paragraphs with headings when 2 were asked). This
 * module verifies the finished answer and, when it does not comply, provides
 * (1) a repair prompt for one corrective pass on the SAME model with the
 * answer and its context kept, and (2) a zero-model fallback that reflows
 * the answer's own sentences into exactly N paragraphs.
 *
 * Pure functions, no I/O. Never applies to trivial turns: callers gate it
 * behind `qualityGuard` like the rest of the quality guard.
 */

const { parseOutputFormatRequest } = require('./output-format-contract');

const MAX_PARAGRAPHS = 6;

function stripCodeFences(text) {
  return String(text || '').replace(/```[\s\S]*?```/g, ' ');
}

/** Split an answer into its visible prose blocks (blank-line separated). */
function splitBlocks(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n+/)
    .map((block) => block.trim())
    .filter(Boolean);
}

const HEADING_RE = /^(?:#{1,6}\s+\S|\*\*[^*\n]{1,90}\*\*:?\s*$|[A-ZÁÉÍÓÚÑ][^.!?\n]{0,70}:\s*$)/;
const BULLET_LINE_RE = /^\s*(?:[-*•–]|\d{1,2}[.)])\s+\S/;

function isHeadingBlock(block) {
  const lines = block.split('\n').filter((l) => l.trim());
  return lines.length === 1 && HEADING_RE.test(lines[0].trim());
}

function hasBulletLines(block) {
  return block.split('\n').some((line) => BULLET_LINE_RE.test(line));
}

function countWords(text) {
  const words = stripCodeFences(text)
    .replace(/[#*_`>|]/g, ' ')
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w));
  return words.length;
}

/**
 * Measure the structure of an answer.
 * @returns {{ paragraphs: number, headings: number, bulletBlocks: number, words: number }}
 */
function measureAnswerStructure(text) {
  const blocks = splitBlocks(stripCodeFences(text));
  let paragraphs = 0;
  let headings = 0;
  let bulletBlocks = 0;
  for (const block of blocks) {
    if (isHeadingBlock(block)) headings += 1;
    else if (hasBulletLines(block)) bulletBlocks += 1;
    else if (/^\s*\|.*\|\s*$/m.test(block)) bulletBlocks += 1;
    else paragraphs += 1;
  }
  return { paragraphs, headings, bulletBlocks, words: countWords(text) };
}

/**
 * Check an answer against the user's explicit format request.
 * `applicable` is false when the prompt carries no checkable constraint.
 */
function checkFormatCompliance(response, specOrPrompt) {
  const spec = typeof specOrPrompt === 'string'
    ? parseOutputFormatRequest(specOrPrompt)
    : (specOrPrompt || {});
  const text = String(response || '').trim();
  const wantedParagraphs = spec.singleParagraph
    ? 1
    : (Number.isFinite(spec.paragraphs) && spec.paragraphs >= 1 ? Math.min(MAX_PARAGRAPHS, spec.paragraphs) : null);
  // A table or list request is structural; paragraph counting does not apply.
  const paragraphApplicable = Boolean(wantedParagraphs) && !spec.table && !spec.list;
  const wordsApplicable = Number.isFinite(spec.maxWords) && spec.maxWords > 0;
  const listApplicable = Boolean(spec.list) && !spec.table;

  if (!text || (!paragraphApplicable && !wordsApplicable && !listApplicable)) {
    return { applicable: false, compliant: true, reasons: [], spec, wantedParagraphs };
  }

  const measured = measureAnswerStructure(text);
  const reasons = [];
  if (paragraphApplicable) {
    if (measured.paragraphs !== wantedParagraphs) reasons.push(`paragraphs:${measured.paragraphs}!=${wantedParagraphs}`);
    if (measured.headings > 0) reasons.push('headings-present');
    if (measured.bulletBlocks > 0) reasons.push('bullets-present');
  }
  if (wordsApplicable && measured.words > Math.ceil(spec.maxWords * 1.1)) {
    reasons.push(`words:${measured.words}>${spec.maxWords}`);
  }
  if (listApplicable && measured.bulletBlocks === 0) {
    reasons.push('list-missing');
  }
  return {
    applicable: true,
    compliant: reasons.length === 0,
    reasons,
    spec,
    wantedParagraphs: paragraphApplicable ? wantedParagraphs : null,
    measured,
  };
}

/** Repair instruction for one corrective pass that keeps the answer's content. */
function buildFormatRepairPrompt(check, language = 'es') {
  const spec = check?.spec || {};
  const en = String(language || '').toLowerCase().startsWith('en');
  const parts = [];
  if (check?.wantedParagraphs === 1) {
    parts.push(en
      ? 'Rewrite your previous answer as exactly ONE polished paragraph.'
      : 'Reescribe tu respuesta anterior en exactamente UN párrafo bien redactado.');
  } else if (check?.wantedParagraphs) {
    parts.push(en
      ? `Rewrite your previous answer as exactly ${check.wantedParagraphs} well-developed paragraphs separated by a blank line.`
      : `Reescribe tu respuesta anterior en exactamente ${check.wantedParagraphs} párrafos bien desarrollados, separados por una línea en blanco.`);
  } else if (spec.list === 'numbered') {
    parts.push(en ? 'Rewrite your previous answer as a numbered list (1., 2., 3.).' : 'Reescribe tu respuesta anterior como una lista numerada (1., 2., 3.).');
  } else if (spec.list) {
    parts.push(en ? 'Rewrite your previous answer as concise bullet points, one idea per line.' : 'Reescribe tu respuesta anterior como viñetas concisas, una idea por línea.');
  } else {
    parts.push(en ? 'Rewrite your previous answer.' : 'Reescribe tu respuesta anterior.');
  }
  if (check?.wantedParagraphs) {
    parts.push(en
      ? 'No title, no headings, no bullet points, no table, no preamble and no closing offer.'
      : 'Sin título, sin encabezados, sin viñetas, sin tabla, sin preámbulo y sin ofrecimientos al final.');
  }
  if (Number.isFinite(spec.maxWords) && spec.maxWords > 0) {
    parts.push(en ? `Stay within ${spec.maxWords} words.` : `No superes ${spec.maxWords} palabras.`);
  }
  parts.push(en
    ? 'Keep every key fact from the source; do not invent anything new. Output only the rewritten answer.'
    : 'Conserva los datos clave de la fuente y no inventes nada nuevo. Entrega solo la respuesta reescrita.');
  return parts.join(' ');
}

function splitSentences(text) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (!flat) return [];
  const out = flat.match(/[^.!?…]+(?:[.!?…]+["»”)]*|$)/g) || [flat];
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * Zero-model fallback: drop headings, fold bullets into prose and reflow the
 * answer's own sentences into exactly `n` balanced paragraphs. Returns '' if
 * there are fewer sentences than paragraphs (cannot be repaired honestly).
 */
function reflowIntoParagraphs(response, n) {
  const count = Math.max(1, Math.min(MAX_PARAGRAPHS, Number(n) || 0));
  const blocks = splitBlocks(stripCodeFences(response)).filter((b) => !isHeadingBlock(b));
  const prose = blocks
    .map((block) => block
      .split('\n')
      .map((line) => line.replace(/^\s*(?:[-*•–]|\d{1,2}[.)])\s+/, '').replace(/\*\*/g, '').trim())
      .filter(Boolean)
      .map((line) => (/[.!?…:]$/.test(line) ? line : `${line}.`))
      .join(' '))
    .join(' ');
  const sentences = splitSentences(prose);
  if (sentences.length < count) return '';
  const perParagraph = sentences.length / count;
  const paragraphs = [];
  for (let i = 0; i < count; i += 1) {
    const start = Math.round(i * perParagraph);
    const end = Math.round((i + 1) * perParagraph);
    paragraphs.push(sentences.slice(start, end).join(' '));
  }
  return paragraphs.filter(Boolean).join('\n\n');
}

module.exports = {
  measureAnswerStructure,
  checkFormatCompliance,
  buildFormatRepairPrompt,
  reflowIntoParagraphs,
};
