'use strict';

/**
 * Prompt blocks for document RLCD. Compact, Spanish-first, no vendor
 * names, no instruction to leak the trailer to the user.
 */

function buildRlcdPromptBlock({ language = 'es' } = {}) {
  const es = String(language || 'es').slice(0, 2).toLowerCase() !== 'en';
  if (es) {
    return [
      '',
      '## CALIBRACION DOCUMENTAL (RLCD)',
      'Antes de afirmar un dato del documento, estima tu confianza 0-1.',
      'Si la evidencia no está en el extracto, dilo y pide sección/página; no inventes.',
      'Al final, en una línea oculta (nunca la menciones al usuario), escribe exactamente:',
      '<!--rlcd:{"c":0.00,"r":"razon breve"}-->',
      'c es 0-1. r es una frase corta sin datos personales.',
    ].join('\n');
  }
  return [
    '',
    '## DOCUMENT CALIBRATION (RLCD)',
    'Before asserting a document fact, estimate your confidence 0-1.',
    'If the evidence is not in the extract, say so and ask for a section/page; do not invent.',
    'At the end, on a hidden line the user must never see, write exactly:',
    '<!--rlcd:{"c":0.00,"r":"short reason"}-->',
    'c is 0-1. r is a short phrase with no personal data.',
  ].join('\n');
}

function flattenSnippet(value, max = 160) {
  return String(value || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<EMAIL>')
    .trim()
    .slice(0, max);
}

function formatCalibratedNotes(exemplars) {
  if (!Array.isArray(exemplars) || exemplars.length === 0) return '';
  const lines = [];
  let good = null;
  let bad = null;
  for (const e of exemplars) {
    const rlcd = (e && e.judgeScore && e.judgeScore.rlcd) || e.rlcd || null;
    if (!rlcd || rlcd.confidence == null) continue;
    const outcome = rlcd.outcome === 'correct' ? 'correcta' : rlcd.outcome === 'incorrecta' || rlcd.outcome === 'incorrect' ? 'incorrecta' : null;
    if (!outcome) continue;
    const c = Number(rlcd.confidence);
    if (!Number.isFinite(c)) continue;
    lines.push(`- Confianza ${c.toFixed(2)} → ${outcome}${rlcd.bin ? ` (${rlcd.bin})` : ''}`);
    const snippet = flattenSnippet(e.response || e.responseText || e.chosen || '', 140);
    if (outcome === 'correcta' && !good && snippet) good = snippet;
    if (outcome === 'incorrecta' && !bad && snippet) bad = snippet;
    if (lines.length >= 3 && good && bad) break;
  }
  if (!lines.length) return '';
  if (good) lines.push(`- Bien calibrada: «${good}»`);
  if (bad) lines.push(`- Sobreconfianza (no copies): «${bad}»`);
  return [
    '',
    '## CALIBRACION APRENDIDA',
    'Ejemplos previos con resultado humano. Ajusta tu confianza; no copies datos personales.',
    ...lines,
  ].join('\n');
}

module.exports = {
  buildRlcdPromptBlock,
  formatCalibratedNotes,
};
