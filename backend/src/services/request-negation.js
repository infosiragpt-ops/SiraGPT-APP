'use strict';

/**
 * request-negation — which words of a request are turned down, in Spanish and
 * English (accents, case and apostrophes folded).
 *
 * A negation covers the rest of its clause: up to a comma, a stop, «pero»,
 * «sino», «y», «but», «and», or eight words. It is written before the words
 * («no quiero subtítulos», «sin Word ni PDF», «nada de resúmenes», «no hace
 * falta resumir», «quita los subtítulos», «without subtitles», «don't
 * summarize») or right after a single word at the end of its clause («Word
 * no, PDF sí»). A bare «no» («no, mejor en PDF»), «no solo», «no te olvides
 * de», «no sé», «sin embargo», «sin falta» and a suggestion («¿por qué no lo
 * pones en Word?», «¿no me lo pasas en PDF?», «why not in Word») turn
 * nothing down.
 *
 * Used by the transcript output (formats), the analysis intent (summary,
 * analysis) and the translation intent: a paid analysis of a 100-file batch
 * must never start from a refusal.
 */

/** Lowercase, no accents, no apostrophes: the text the patterns read. Same length as its input minus accents. */
function foldRequest(text) {
  return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’'`´]/g, '').toLowerCase();
}

const BOUNDARY_WORDS = new Set(['pero', 'sino', 'y', 'e', 'aunque', 'mientras', 'but', 'and', 'instead', 'rather', 'though']);
const MAX_SCOPE_WORDS = 8;
// Words that, right after «no», make it something other than a refusal.
const NOT_A_REFUSAL_AFTER_NO = new Set([
  'solo', 'solamente', 'nomas', 'unicamente', // «no solo X sino Y»
  'olvides', 'olvide', 'olvidar', 'dejes', 'falles', // «no olvides resumirlo», «no dejes de traducirlo»
  'se', 'entiendo', 'entendi', 'recuerdo', 'acuerdo', 'estoy', 'tengo', 'puedo', 'pude', 'sabia', // «no sé qué dice»
  'only', 'just', 'forget', 'sure', 'know', 'understand', // «not only», «don't forget», «I don't know»
]);
// «no te olvides de», «no se te olvide»: a pronoun before the word above.
const PRONOUNS = new Set(['me', 'te', 'se', 'nos', 'lo', 'la', 'los', 'las', 'le', 'les']);
const STARTERS = [
  ['nada', 'de'], ['no', 'hace', 'falta'], ['no', 'es', 'necesario'], ['do', 'not'], ['no', 'need'],
];
const SINGLE_STARTERS = new Set([
  'no', 'ni', 'sin', 'tampoco', 'nunca', 'jamas', 'ningun', 'ninguna', 'ninguno',
  'quita', 'quitale', 'quitalo', 'quitala', 'quitar', 'quitarle', 'elimina', 'eliminale', 'eliminar', 'borra', 'borrale', 'borrar',
  'omite', 'omitir', 'excluye', 'excluir', 'descarta', 'cancela', 'retira', 'olvida', 'olvidate',
  'not', 'dont', 'without', 'skip', 'remove', 'drop', 'never', 'nor',
]);
const NOT_A_REFUSAL_AFTER_SIN = new Set(['embargo', 'falta', 'duda', 'problema']);

const POSTFIX_DETERMINERS = new Set(['el', 'la', 'los', 'las', 'lo', 'ese', 'esa', 'eso', 'esos', 'esas', 'este', 'esta', 'un', 'una', 'the', 'that', 'this']);
// After a closing «no»: words that only say the thing is not wanted.
const POSTFIX_REFUSAL_TAILS = [
  ['me', 'sirve'], ['me', 'sirven'], ['nos', 'sirve'], ['hace', 'falta'], ['es', 'necesario'],
  ['lo', 'necesito'], ['la', 'necesito'], ['los', 'necesito'], ['las', 'necesito'],
  ['lo', 'quiero'], ['la', 'quiero'], ['los', 'quiero'], ['las', 'quiero'],
  ['necesito'], ['quiero'], ['gracias'], ['porfa'], ['por', 'favor'], ['please'], ['thanks'],
];

/** Is the «no» before token i closing (its clause ends, or only says «I don't need it»)? */
function closesRefusal(tokens, i) {
  if (isBoundary(tokens[i])) return true;
  return POSTFIX_REFUSAL_TAILS.some(seq => seq.every((word, k) => tokens[i + k]?.word && tokens[i + k].text === word)
    && isBoundary(tokens[i + seq.length]));
}

function tokenize(folded) {
  const tokens = [];
  for (const match of folded.matchAll(/[a-z0-9]+|[.,;:!?¿¡()[\]{}"«»\n]/g)) {
    tokens.push({ text: match[0], start: match.index, end: match.index + match[0].length, word: /^[a-z0-9]/.test(match[0]) });
  }
  return tokens;
}

const isBoundary = token => !token || !token.word || BOUNDARY_WORDS.has(token.text);

/** Is a refusal starting at token i? Returns the number of tokens it spans, or 0. */
function starterAt(tokens, i) {
  for (const seq of STARTERS) {
    if (seq.every((word, k) => tokens[i + k]?.word && tokens[i + k].text === word)) return seq.length;
  }
  const token = tokens[i];
  if (!token?.word || !SINGLE_STARTERS.has(token.text)) return 0;
  const next = tokens[i + 1];
  if (token.text === 'no' || token.text === 'not' || token.text === 'dont') {
    if (isBoundary(next)) return 0; // «no, mejor en PDF»
    const before = tokens[i - 1];
    // A suggestion: «¿por qué no lo pones en Word?», «why not», «¿no me lo pasas en PDF?».
    // «porque» without its accent is «por qué» only in a question («¿porque
    // no lo pones en Word?»); otherwise it is «because» («porque no lo quiero
    // en Word» refuses).
    const asking = tokens.slice(i).some(t => t.text === '?');
    if (before && (before.text === '¿' || before.text === 'why'
      || (before.text === 'porque' && asking)
      || (before.text === 'que' && tokens[i - 2]?.text === 'por' && asking))) return 0;
    if (NOT_A_REFUSAL_AFTER_NO.has(next.text)) return 0;
    if (PRONOUNS.has(next.text) && NOT_A_REFUSAL_AFTER_NO.has(tokens[i + 2]?.text)) return 0; // «no te olvides»
    if (PRONOUNS.has(next.text) && PRONOUNS.has(tokens[i + 2]?.text) && NOT_A_REFUSAL_AFTER_NO.has(tokens[i + 3]?.text)) return 0; // «no se te olvide»
  }
  if (token.text === 'sin' && next?.word && NOT_A_REFUSAL_AFTER_SIN.has(next.text)) return 0;
  return 1;
}

/**
 * The stretches of the folded text a refusal covers: [{ start, end }]
 * character offsets in `foldRequest(text)`.
 */
function negatedRanges(folded) {
  const tokens = tokenize(folded);
  const ranges = [];
  for (let i = 0; i < tokens.length; i++) {
    const span = starterAt(tokens, i);
    if (span) {
      let last = i + span - 1;
      let words = 0;
      for (let k = i + span; k < tokens.length && !isBoundary(tokens[k]) && words < MAX_SCOPE_WORDS; k++) {
        last = k;
        words += 1;
      }
      ranges.push({ start: tokens[i].start, end: tokens[last].end });
      i = last;
      continue;
    }
    // «Word no, PDF sí», «subtítulos no», «el Word sí, el PDF no», «que el
    // PDF no me sirve», «el PDF no lo necesito»: one word (with its article)
    // refused right before a closing «no», or a «no» that only says it is
    // not wanted. «el PDF no se ve bien» refuses nothing.
    const token = tokens[i];
    const next = tokens[i + 1];
    if (token.word && next?.word && (next.text === 'no' || next.text === 'not') && closesRefusal(tokens, i + 2)) {
      const before = tokens[i - 1];
      const opensClause = i === 0 || isBoundary(before);
      const withArticle = before?.word && POSTFIX_DETERMINERS.has(before.text)
        && (i - 1 === 0 || isBoundary(tokens[i - 2]) || tokens[i - 2]?.text === 'que');
      if (opensClause || withArticle) {
        ranges.push({ start: (withArticle && !opensClause ? before : token).start, end: next.end });
        i += 1;
      }
    }
  }
  return ranges;
}

/** The folded text with every refused stretch blanked (same length, for pattern tests). */
function withoutRefused(text) {
  const folded = foldRequest(text);
  let out = folded;
  for (const { start, end } of negatedRanges(folded)) out = out.slice(0, start) + ' '.repeat(end - start) + out.slice(end);
  return out;
}

/**
 * Every match of `re` in the folded text, split into the refused ones and
 * the asked ones: { refused: string[], asked: string[] } (the matched text).
 */
function splitMentions(text, re) {
  const folded = foldRequest(text);
  const ranges = negatedRanges(folded);
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  const refused = [];
  const asked = [];
  for (const match of folded.matchAll(new RegExp(re.source, flags))) {
    const at = match.index;
    (ranges.some(range => at >= range.start && at < range.end) ? refused : asked).push(match[0]);
  }
  return { refused, asked };
}

module.exports = { foldRequest, negatedRanges, withoutRefused, splitMentions };
