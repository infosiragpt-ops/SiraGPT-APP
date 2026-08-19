'use strict';

// Pure mutation operators for the lightweight mutation runner.
// Each operator scans source code and yields { id, label, start, end, replacement }
// describing a single point mutation. The runner applies one mutant at a time.

const OPERATORS = [
  { id: 'EQ_TO_NEQ', label: '=== → !==', pattern: /===/g, replacement: '!==' },
  { id: 'NEQ_TO_EQ', label: '!== → ===', pattern: /!==/g, replacement: '===' },
  { id: 'LOOSE_EQ_TO_NEQ', label: '== → !=', pattern: /(?<![=!<>])==(?!=)/g, replacement: '!=' },
  { id: 'LOOSE_NEQ_TO_EQ', label: '!= → ==', pattern: /(?<![<>])!=(?!=)/g, replacement: '==' },
  { id: 'GTE_TO_LT', label: '>= → <', pattern: />=/g, replacement: '<' },
  { id: 'LTE_TO_GT', label: '<= → >', pattern: /<=/g, replacement: '>' },
  { id: 'GT_TO_LTE', label: '> → <=', pattern: /(?<![=!<>])>(?![=>])/g, replacement: '<=' },
  { id: 'LT_TO_GTE', label: '< → >=', pattern: /(?<![=!<>])<(?![=<])/g, replacement: '>=' },
  { id: 'AND_TO_OR', label: '&& → ||', pattern: /&&/g, replacement: '||' },
  { id: 'OR_TO_AND', label: '|| → &&', pattern: /\|\|/g, replacement: '&&' },
  { id: 'TRUE_TO_FALSE', label: 'true → false', pattern: /\btrue\b/g, replacement: 'false' },
  { id: 'FALSE_TO_TRUE', label: 'false → true', pattern: /\bfalse\b/g, replacement: 'true' },
  { id: 'PLUS_TO_MINUS', label: '+ → -', pattern: /(?<![+=])\+(?![+=])/g, replacement: '-' },
  { id: 'MINUS_TO_PLUS', label: '- → +', pattern: /(?<![-=])-(?![-=>])/g, replacement: '+' },
];

// Spans we never mutate inside: string/template/regex literals and comments.
function buildSkipMask(source) {
  const mask = new Uint8Array(source.length);
  const len = source.length;
  let i = 0;
  while (i < len) {
    const c = source[i];
    const n = source[i + 1];
    if (c === '/' && n === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? len : end;
      for (let k = i; k < stop; k++) mask[k] = 1;
      i = stop;
      continue;
    }
    if (c === '/' && n === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? len : end + 2;
      for (let k = i; k < stop; k++) mask[k] = 1;
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      let k = i + 1;
      while (k < len) {
        if (source[k] === '\\') {
          k += 2;
          continue;
        }
        if (source[k] === quote) {
          k += 1;
          break;
        }
        k += 1;
      }
      for (let j = i; j < k; j++) mask[j] = 1;
      i = k;
      continue;
    }
    i += 1;
  }
  return mask;
}

function inSkipRange(mask, start, end) {
  for (let k = start; k < end; k++) {
    if (mask[k]) return true;
  }
  return false;
}

function generateMutants(source, opts = {}) {
  const operators = opts.operators || OPERATORS;
  const max = Number.isFinite(opts.max) ? opts.max : Infinity;
  const mask = buildSkipMask(source);
  const mutants = [];
  for (const op of operators) {
    op.pattern.lastIndex = 0;
    let match;
    while ((match = op.pattern.exec(source)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (inSkipRange(mask, start, end)) continue;
      mutants.push({
        id: `${op.id}@${start}`,
        operator: op.id,
        label: op.label,
        start,
        end,
        original: match[0],
        replacement: op.replacement,
      });
      if (mutants.length >= max) return mutants;
    }
  }
  return mutants;
}

function applyMutant(source, mutant) {
  return source.slice(0, mutant.start) + mutant.replacement + source.slice(mutant.end);
}

module.exports = {
  OPERATORS,
  buildSkipMask,
  generateMutants,
  applyMutant,
};
