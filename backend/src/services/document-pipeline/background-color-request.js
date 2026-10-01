'use strict';

// A series/label/accent color is not a request to repaint the whole deck.
// Leave detailed chart styling to the selected model and native chart options.
const LOCAL_TARGET_RE = /\b(?:gr[aá]fic[ao]s?|charts?|series?|barras?|columnas?|l[ií]neas?|leyendas?|ejes?|t[ií]tulos?|textos?|tablas?|celdas?|paleta|acentos?|multicolor|combinaci[oó]n)\b/i;
const COLOR_TOKEN = '(#[0-9a-fA-F]{6}(?![0-9a-fA-F])|[a-záéíóúñ]+)';
const BACKGROUND_RE = new RegExp(`\\b(?:fondo|background)(?:\\s+(?:general|global|de\\s+(?:(?:la|las|el|los)\\s+)?(?:presentaci[oó]n|pptx?|diapositivas?|slides?|deck)))?\\s*(?::|=)?\\s*(?:(?:de\\s+)?color\\s+|en\\s+|de\\s+)?${COLOR_TOKEN}`, 'gi');

function backgroundColorRequest(text) {
  const prompt = String(text || '');
  if (!LOCAL_TARGET_RE.test(prompt)) return prompt;
  // Explicit whole-canvas backgrounds can coexist with any number of series
  // colors. Ignore a plot-specific background and negated instructions.
  for (const match of prompt.matchAll(BACKGROUND_RE)) {
    const prefix = prompt.slice(Math.max(0, match.index - 70), match.index);
    const localBackground = /(?:gr[aá]fic[ao]|chart|plot|[aá]rea de trazado)\s+(?:con\s+|de\s+)?$/i.test(prefix);
    const negated = /\b(?:sin|no|evita|excepto)\s+$/i.test(prefix);
    const suffix = prompt.slice(match.index + match[0].length, match.index + match[0].length + 50);
    if (!localBackground && !negated && !/^\s+(?:de|del)\s+(?:(?:la|el)\s+)?(?:gr[aá]fic[ao]|chart|plot)\b/i.test(suffix)) {
      return match[1];
    }
  }
  return '';
}

module.exports = { backgroundColorRequest };
