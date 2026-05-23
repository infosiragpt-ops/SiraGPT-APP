'use strict';

/**
 * pluralize — small English heuristic for pluralize/singularize.
 * Pairs with case-convert (#101): handy for table/resource naming
 * (User → Users), error messages (1 file vs 5 files), and code-gen
 * scaffolding without pulling in the full npm pluralize dictionary.
 *
 * Coverage:
 *   - Irregulars table (child/children, mouse/mice, person/people, …)
 *   - Uncountables (information, equipment, fish, …) → identity
 *   - Regex rule pipeline applied first-match-wins (-y → -ies, -us
 *     → -i, -ix → -ices, -fe → -ves, -[sxz]/-[cs]h → -es, fallback +s)
 *
 * Public API:
 *   pluralize(word, count?)              — count plural-aware
 *   singularize(word)                    — best-effort inverse
 *   plural(word) / singular(word)        — forced (ignores count)
 *   addIrregular(singular, plural)       — extend at runtime
 */

const IRREGULAR = new Map([
  ['child', 'children'], ['mouse', 'mice'], ['louse', 'lice'],
  ['goose', 'geese'], ['foot', 'feet'], ['tooth', 'teeth'],
  ['man', 'men'], ['woman', 'women'], ['person', 'people'],
  ['ox', 'oxen'], ['die', 'dice'], ['datum', 'data'], ['cactus', 'cacti'],
  ['focus', 'foci'], ['fungus', 'fungi'], ['nucleus', 'nuclei'],
  ['syllabus', 'syllabi'], ['analysis', 'analyses'], ['diagnosis', 'diagnoses'],
  ['oasis', 'oases'], ['thesis', 'theses'], ['crisis', 'crises'],
  ['phenomenon', 'phenomena'], ['criterion', 'criteria'],
]);

const UNCOUNTABLE = new Set([
  'information', 'equipment', 'rice', 'fish', 'sheep', 'deer',
  'series', 'species', 'aircraft', 'software', 'news', 'data',
]);

const PLURAL_RULES = [
  [/(quiz)$/i, '$1zes'],
  [/^(ox)$/i, '$1en'],
  [/([m|l])ouse$/i, '$1ice'],
  [/(matr|vert|ind)ix|ex$/i, '$1ices'],
  [/(x|ch|ss|sh)$/i, '$1es'],
  [/([^aeiouy]|qu)y$/i, '$1ies'],
  [/(hive)$/i, '$1s'],
  [/(?:([^f])fe|([lr])f)$/i, '$1$2ves'],
  [/sis$/i, 'ses'],
  [/([ti])um$/i, '$1a'],
  [/(buffal|tomat|potat|her)o$/i, '$1oes'],
  [/(bu)s$/i, '$1ses'],
  [/(alias|status)$/i, '$1es'],
  [/(octop|vir)us$/i, '$1i'],
  [/s$/i, 's'],
  [/$/, 's'],
];

const SINGULAR_RULES = [
  [/(quiz)zes$/i, '$1'],
  [/(matr)ices$/i, '$1ix'],
  [/(vert|ind)ices$/i, '$1ex'],
  [/^(ox)en$/i, '$1'],
  [/(alias|status)es$/i, '$1'],
  [/([octop|vir])i$/i, '$1us'],
  [/(cris|ax|test)es$/i, '$1is'],
  [/(shoe)s$/i, '$1'],
  [/(o)es$/i, '$1'],
  [/(bus)es$/i, '$1'],
  [/([m|l])ice$/i, '$1ouse'],
  [/(x|ch|ss|sh)es$/i, '$1'],
  [/(m)ovies$/i, '$1ovie'],
  [/(s)eries$/i, '$1eries'],
  [/([^aeiouy]|qu)ies$/i, '$1y'],
  [/([lr])ves$/i, '$1f'],
  [/(tive)s$/i, '$1'],
  [/(hive)s$/i, '$1'],
  [/([^f])ves$/i, '$1fe'],
  [/(^analy)ses$/i, '$1sis'],
  [/((a)naly|(b)a|(d)iagno|(p)arenthe|(p)rogno|(s)yno|(t)he)ses$/i, '$1$2sis'],
  [/([ti])a$/i, '$1um'],
  [/n(om|enom)ina$/i, 'n$1on'],
  [/s$/i, ''],
];

const PLURAL_TO_SINGULAR = new Map();
for (const [s, p] of IRREGULAR) PLURAL_TO_SINGULAR.set(p, s);

function applyRules(word, rules) {
  for (const [re, repl] of rules) {
    if (re.test(word)) return word.replace(re, repl);
  }
  return word;
}

function plural(word) {
  if (typeof word !== 'string' || !word) return '';
  const lower = word.toLowerCase();
  if (UNCOUNTABLE.has(lower)) return word;
  if (IRREGULAR.has(lower)) return IRREGULAR.get(lower);
  return applyRules(word, PLURAL_RULES);
}

function singular(word) {
  if (typeof word !== 'string' || !word) return '';
  const lower = word.toLowerCase();
  if (UNCOUNTABLE.has(lower)) return word;
  if (PLURAL_TO_SINGULAR.has(lower)) return PLURAL_TO_SINGULAR.get(lower);
  return applyRules(word, SINGULAR_RULES);
}

function pluralize(word, count) {
  if (count === 1) return singular(word);
  return plural(word);
}

function singularize(word) { return singular(word); }

function addIrregular(singularForm, pluralForm) {
  if (typeof singularForm !== 'string' || typeof pluralForm !== 'string') {
    throw new TypeError('addIrregular: both forms must be strings');
  }
  IRREGULAR.set(singularForm.toLowerCase(), pluralForm);
  PLURAL_TO_SINGULAR.set(pluralForm.toLowerCase(), singularForm);
}

module.exports = {
  pluralize,
  singularize,
  plural,
  singular,
  addIrregular,
  IRREGULAR,
  UNCOUNTABLE,
};
