'use strict';

/**
 * typo-repairer — deterministic, high-precision typo repair for the ROUTER
 * INPUT only (brain-infra roadmap #2, user-understanding). The big LLM keeps
 * seeing the literal prompt; only triage/routing sees the repaired text —
 * mirroring the short-query-expander contract at routes/ai.js (PR-4).
 *
 * Why: the live bugs this line of work fixed ("el docuemtno", "resumne",
 * "reemplaces", "Landin") show users type fast and mobile-mangled. The doc
 * pipeline got an LLM intent brain; the general chat router gets this cheap
 * deterministic layer (~0ms, no network).
 *
 * Precision-first design: only repair a token when
 *   (a) it's in the curated misspelling dictionary, or
 *   (b) it's NOT a known Spanish/English word and exactly ONE domain-vocab
 *       word is within edit distance 1 (len ≥ 5) / 2 (len ≥ 9).
 * Anything ambiguous stays untouched — a wrong repair is worse than none.
 */

// Curated high-frequency misspellings seen in real prompts (ES chat domain).
const DIRECT_FIXES = new Map(Object.entries({
  docuemnto: 'documento', docuemtno: 'documento', documeto: 'documento',
  documentoo: 'documento', docmuento: 'documento',
  resumne: 'resumen', reusmen: 'resumen', resmuen: 'resumen',
  imagne: 'imagen', imgen: 'imagen', imagn: 'imagen',
  palabaras: 'palabras', palbras: 'palabras',
  pagnia: 'página', pagia: 'página',
  diapositvas: 'diapositivas', diapositva: 'diapositiva',
  presentacino: 'presentación', presetacion: 'presentación',
  garfico: 'gráfico', grafcio: 'gráfico',
  exel: 'excel', excle: 'excel', ecxel: 'excel',
  wrod: 'word', owrd: 'word',
  archvo: 'archivo', archivio: 'archivo',
  investigacino: 'investigación', investigacon: 'investigación',
  intrumentos: 'instrumentos', intruemntos: 'instrumentos', instumentos: 'instrumentos',
  cuestionaro: 'cuestionario',
  analsis: 'análisis', analisi: 'análisis',
  profeisonal: 'profesional', profeiosnal: 'profesional', profesinal: 'profesional',
  porfavor: 'por favor', porfa: 'por favor',
  tabal: 'tabla', tabl: 'tabla',
  correo: 'correo', corregir: 'corregir', corrgir: 'corregir', corregri: 'corregir',
  agregale: 'agrégale', agregar: 'agregar',
  hazme: 'hazme', hasme: 'hazme',
  buscame: 'búscame', busacme: 'búscame',
}));

// Domain vocabulary for conservative fuzzy repair (only unique dist-1/2 hits).
const DOMAIN_VOCAB = [
  'documento', 'documentos', 'resumen', 'imagen', 'imágenes', 'palabras',
  'página', 'páginas', 'lámina', 'láminas', 'diapositiva', 'diapositivas',
  'presentación', 'gráfico', 'gráficos', 'tabla', 'tablas', 'archivo',
  'archivos', 'análisis', 'investigación', 'instrumento', 'instrumentos',
  'cuestionario', 'encuesta', 'columna', 'celda', 'fórmula', 'moneda',
  'porcentaje', 'profesional', 'traducir', 'traduce', 'corrige', 'reemplaza',
  'elimina', 'agrega', 'genera', 'crea', 'busca', 'explica', 'compara',
];

// Common short words we must never "repair" into vocab (precision guard).
const KNOWN_WORDS = new Set([
  'para', 'pero', 'como', 'este', 'esta', 'esto', 'ese', 'esa', 'eso',
  'con', 'los', 'las', 'del', 'que', 'una', 'uno', 'unos', 'unas', 'por',
  'favor', 'sobre', 'entre', 'hasta', 'desde', 'cuando', 'donde', 'quien',
  'word', 'excel', 'pdf', 'ppt', 'pptx', 'docx', 'xlsx', 'chat', 'the',
  'and', 'for', 'with', 'this', 'that', 'make', 'create', 'table', 'cell',
  'datos', 'dato', 'tema', 'temas', 'texto', 'todo', 'toda', 'nada',
]);

const NORMALIZE_ACCENTS = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

function editDistanceLe(a, b, max) {
  // Bounded Levenshtein: returns distance if ≤ max, else max+1. Small strings only.
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = prev[0];
    prev[0] = i;
    let rowMin = prev[0];
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = prev[j];
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = tmp;
      if (prev[j] < rowMin) rowMin = prev[j];
    }
    if (rowMin > max) return max + 1;
  }
  return prev[b.length];
}

// Pre-normalized vocab for accent-insensitive matching.
const VOCAB_NORM = DOMAIN_VOCAB.map((w) => ({ word: w, norm: NORMALIZE_ACCENTS(w.toLowerCase()) }));

function fuzzyRepair(tokenLower) {
  if (tokenLower.length < 5) return null;
  const norm = NORMALIZE_ACCENTS(tokenLower);
  const maxDist = tokenLower.length >= 9 ? 2 : 1;
  let match = null;
  for (const { word, norm: vocabNorm } of VOCAB_NORM) {
    if (vocabNorm === norm) return null; // already correct modulo accents
    const d = editDistanceLe(norm, vocabNorm, maxDist);
    if (d <= maxDist) {
      if (match) return null; // ambiguous — two candidates → don't touch
      match = word;
    }
  }
  return match;
}

function preserveCase(original, replacement) {
  if (original === original.toUpperCase() && original.length > 1) return replacement.toUpperCase();
  if (original[0] === original[0].toUpperCase()) {
    return replacement[0].toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

/**
 * Repair typos in a prompt for ROUTER consumption. Returns
 *   { repaired, changes: [{from, to}], source: 'repaired'|'no_change' }.
 * Never throws; worst case returns the input untouched.
 */
function repairTypos(prompt = '') {
  try {
    const text = String(prompt || '');
    if (!text || text.length > 4_000) return { repaired: text, changes: [], source: 'no_change' };
    const changes = [];
    const repaired = text.replace(/[A-Za-zÁÉÍÓÚÑáéíóúñü]{3,}/g, (token) => {
      const lower = token.toLowerCase();
      if (KNOWN_WORDS.has(lower)) return token;
      const direct = DIRECT_FIXES.get(lower);
      if (direct) {
        const fixed = preserveCase(token, direct);
        changes.push({ from: token, to: fixed });
        return fixed;
      }
      const fuzzy = fuzzyRepair(lower);
      if (fuzzy && NORMALIZE_ACCENTS(lower) !== NORMALIZE_ACCENTS(fuzzy)) {
        const fixed = preserveCase(token, fuzzy);
        changes.push({ from: token, to: fixed });
        return fixed;
      }
      return token;
    });
    return changes.length
      ? { repaired, changes: changes.slice(0, 20), source: 'repaired' }
      : { repaired: text, changes: [], source: 'no_change' };
  } catch {
    return { repaired: String(prompt || ''), changes: [], source: 'no_change' };
  }
}

module.exports = { repairTypos, INTERNAL: { editDistanceLe, fuzzyRepair, DIRECT_FIXES } };
