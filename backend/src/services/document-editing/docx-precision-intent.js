'use strict';

// Literal replacement is a data operation, not a request to rewrite a document.
// Only instruction text is normalized; quoted document text is kept verbatim.
const normalize = (text) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const VERB = '(?:reempla[zc]\\w*|sustitu\\w*|cambi\\w*|modifi(?:c|q)\\w*|corrig\\w*|replace|change)';
const MARK = '\\uE000(\\d+)\\uE001';
const ORDINALS = { primera: 1, primer: 1, primero: 1, segunda: 2, segundo: 2, tercera: 3, tercer: 3, tercero: 3,
  cuarta: 4, cuarto: 4, quinta: 5, quinto: 5, sexta: 6, sexto: 6, septima: 7, septimo: 7,
  octava: 8, octavo: 8, novena: 9, noveno: 9, decima: 10, decimo: 10 };

function failure(code, message) { return { error: { code: `DOCX_EDIT_${code}`, message } }; }

function quotedInstruction(raw) {
  const values = [];
  const text = raw.replace(/"([^"\r\n]*)"|“([^”\r\n]*)”|«([^»\r\n]*)»|'([^'\r\n]*)'|‘([^’\r\n]*)’|`([^`\r\n]*)`/gu, (...args) => {
    const value = args.slice(1, 7).find((item) => item !== undefined);
    values.push(value);
    return `\uE000${values.length - 1}\uE001`;
  });
  return { values, text: normalize(text) };
}

function numberedSelector(text, unit) {
  const ordinals = Object.keys(ORDINALS).join('|');
  const numeric = [...text.matchAll(new RegExp(`\\b${unit}\\s*(?:numero\\s*|n[.º°]\\s*|#\\s*)?(\\d+)\\b`, 'g'))];
  const ordinal = [...text.matchAll(new RegExp(`\\b(${ordinals})\\s+${unit}\\b`, 'g'))];
  const matches = [...numeric.map((m) => Number(m[1])), ...ordinal.map((m) => ORDINALS[m[1]])];
  const range = new RegExp(`\\b${unit}\\s+\\d+\\s*(?:y|al?|hasta|,|-)\\s*\\d+\\b`).test(text);
  if (range || matches.some((value) => !Number.isSafeInteger(value) || value < 1) || new Set(matches).size > 1) return { invalid: true };
  return { value: matches[0], clauses: [...numeric, ...ordinal].map((m) => m[0]) };
}

function parseDocxPrecisionRequest(instruction = '') {
  const raw = String(instruction || '');
  if (!raw.trim()) return null;
  // Markers are internal tokens, never user-supplied syntax.
  if (/[\uE000\uE001]/u.test(raw)) return failure('INSTRUCTION_REQUIRED', 'Indica el texto original y el nuevo entre comillas.');
  const { text, values } = quotedInstruction(raw);
  const preserve = /\b(?:milimetric\w*|edicion exacta|edicion precisa|sin (?:cambiar|alterar|modificar|perder) (?:el )?formato|conserv\w* (?:el )?formato original|preserv\w* (?:el )?formato original)\b/.test(text);
  const replacementVerb = new RegExp(`\\b${VERB}\\b`).test(text);
  if (!replacementVerb) {
    if (preserve && /\b(?:edita\w*|corrig\w*|modific\w*|cambia\w*)\b/.test(text))
      return failure('INSTRUCTION_REQUIRED', 'Para editar con precisión, indica el texto original y el nuevo entre comillas; por ejemplo: cambia "2026" por "2027".');
    return null;
  }
  // A question about an edit is not authorization to perform it.
  if (/^\s*(?:explica\w*|describe\w*|que (?:significa|pasaria)|como (?:puedo|se)|what|explain)\b/.test(text)) return null;
  const pairRe = new RegExp(`\\b${VERB}\\s+(?:(?:de|del|el|la|los|las|texto|frase|palabra|letra|caracter|valor|exacto|exacta)\\s+)*${MARK}\\s*(?:por|con|a|to|with|→|->)\\s*${MARK}`, 'g');
  const pairs = [...text.matchAll(pairRe)];
  if (!pairs.length) {
    if (preserve || values.length >= 2 || /\b(?:letra|caracter)\b/.test(text))
      return failure('INSTRUCTION_REQUIRED', 'Indica el cambio literal entre comillas, por ejemplo: cambia "a" por "á" en el párrafo que contiene "frase identificadora". El original no se modificó.');
    return null;
  }
  if (pairs.length !== 1) return failure('INSTRUCTION_REQUIRED', 'Para aplicar una edición exacta, indica un solo reemplazo por mensaje. El original no se modificó.');
  const pair = pairs[0];
  const before = text.slice(0, pair.index);
  if (/\b(?:no|nunca|sin)\s*$/.test(before)) return failure('INSTRUCTION_REQUIRED', 'No apliqué cambios. Indica el reemplazo que sí deseas realizar.');
  const needle = values[Number(pair[1])];
  const replacement = values[Number(pair[2])];
  if (!needle.length) return failure('INSTRUCTION_REQUIRED', 'El texto original no puede estar vacío. Indica la letra, palabra o frase que deseas cambiar.');
  const edit = { needle, replacement };
  // Search only outside the actual values. "página", "todos", etc. may be
  // legitimate replacement text and must never become a scope selector.
  let remaining = text.slice(0, pair.index) + ' ' + text.slice(pair.index + pair[0].length);
  const contexts = [...remaining.matchAll(new RegExp(`\\b(?:parrafo|frase|texto)\\s+(?:que\\s+)?(?:contiene|dice|incluye|comienza\\s+con|empieza\\s+con)\\s*${MARK}`, 'g'))];
  if (contexts.length > 1) return failure('INSTRUCTION_REQUIRED', 'Indica una sola frase de contexto para ubicar el cambio.');
  if (contexts.length) {
    edit.context = values[Number(contexts[0][1])];
    if (!edit.context.length) return failure('INSTRUCTION_REQUIRED', 'La frase de contexto no puede estar vacía.');
    if (/\b(?:comienza|empieza)\b/.test(contexts[0][0])) edit.contextPosition = 'start';
    remaining = remaining.replace(contexts[0][0], ' ');
  }
  // Quoted filenames identify sources, not document content.
  const sourceNames = [];
  remaining = remaining.replace(new RegExp(MARK, 'g'), (token, index) => {
    const name = values[Number(index)];
    if (!/\.(?:docx?|dotx|xlsx?|pptx?|pdf)$/i.test(name)) return token;
    sourceNames.push(name);
    return ' archivo ';
  });
  if (/[\uE000\uE001]/u.test(remaining)) return failure('INSTRUCTION_REQUIRED', 'No pude identificar de forma inequívoca el texto y su ubicación. Usa un reemplazo y, si hace falta, un párrafo que contiene una frase entre comillas.');
  remaining = remaining.replace(/[^\s,;:!?()]+\.(?:docx?|dotx|xlsx?|pptx?|pdf)\b/g, (name) => { sourceNames.push(name); return 'archivo'; });
  if (new Set(sourceNames.map((name) => name.toLowerCase())).size > 1)
    return failure('SOURCE_AMBIGUOUS', 'Indica un único archivo para esta edición exacta. No modifiqué ninguno.');
  const paragraph = numberedSelector(remaining, 'parrafo');
  const occurrence = numberedSelector(remaining, '(?:coincidencia|aparicion|ocurrencia|vez)');
  if (paragraph.invalid || occurrence.invalid) return failure('INSTRUCTION_REQUIRED', 'Indica un único número de párrafo o de coincidencia, contando desde 1.');
  if (paragraph.value) edit.paragraph = paragraph.value;
  if (occurrence.value) edit.occurrence = occurrence.value;
  for (const clause of [...paragraph.clauses, ...occurrence.clauses]) remaining = remaining.replace(clause, ' ');
  const allClause = /\b(?:todas (?:las )?(?:coincidencias|apariciones|ocurrencias)|cada coincidencia|replace all)\b/;
  if (allClause.test(remaining)) edit.all = true;
  remaining = remaining.replace(allClause, ' ');
  if (edit.all && edit.occurrence) return failure('INSTRUCTION_REQUIRED', 'Elige una coincidencia concreta o todas las coincidencias, no ambas.');
  const scopes = [
    ['header', /\bencabezados?\b/], ['footer', /\bpie(?:s)? de pagina\b/],
    ['footnote', /\bnotas? al pie\b/], ['endnote', /\bnotas? (?:al final|finales)\b/],
    ['body', /\bcuerpo(?: del documento)?\b/],
  ].filter(([, regex]) => regex.test(remaining));
  if (scopes.length > 1) return failure('INSTRUCTION_REQUIRED', 'Indica una sola zona del documento para el cambio.');
  if (scopes.length) {
    edit.scope = scopes[0][0];
    remaining = remaining.replace(scopes[0][1], ' ');
  }
  if (/\b(?:paginas?|hojas?|titulos?|subtitulos?|portadas?|tablas?|filas?|columnas?|celdas?|secciones?|anexos?|capitulos?)\b/.test(remaining))
    return failure('UNSUPPORTED_LOCATION', 'Para localizar el cambio sin alterar el formato, indica el número de párrafo o una frase exacta que contiene. No puedo deducir con seguridad esa ubicación a partir de la página o el título.');
  if (/\b(?:ultim[ao]|penultim[ao]|restantes|excepto|menos|antes de|despues de|segunda y|primer[ao] y|cada parrafo|todos los parrafos)\b/.test(remaining))
    return failure('UNSUPPORTED_LOCATION', 'Indica un único párrafo, una frase de contexto o el número de coincidencia. No apliqué un cambio de alcance aproximado.');
  // Never execute one clause and silently discard a second requested mutation.
  const instructionsOnly = remaining
    .replace(/\bsin\s+(?:cambiar|alterar|modificar|perder|tocar)\b/g, ' conservar ')
    .replace(/\bno\s+(?:cambies|alteres|modifiques|toques)\b/g, ' conservar ');
  if (/\b(?:agreg\w*|anad\w*|insert\w*|borr\w*|elimin\w*|reescrib\w*|traduc\w*|resum\w*|corrig\w*|reempla[zc]\w*|modific\w*|cambi\w*|revis\w*|mejora\w*)\b/.test(instructionsOnly))
    return failure('INSTRUCTION_REQUIRED', 'Esta edición exacta admite un reemplazo por mensaje. Separa los demás cambios para no alterar partes no solicitadas.');
  // Consume a small, explicit grammar. Unknown qualifiers are NOT ignored:
  // "párrafo dos", "segunda línea", conditions, negated scopes, formatting
  // commands or an English location must ask for clarification, not broaden
  // the change to a unique occurrence somewhere else in the document.
  const remainder = remaining
    .replace(/\b(?:sin (?:cambiar|alterar|modificar|perder|tocar)|no (?:cambies|alteres|modifiques|toques)|conserva\w*|preserva\w*|manten\w*)\s+(?:(?:el|la)\s+)?(?:formato(?: original)?|resto(?: del documento)?|(?:todo )?lo demas|nada mas)\b/g, ' ')
    .replace(/\b(?:devuelveme|entregame|devuelve|entrega)\s+(?:(?:el|mi)\s+)?(?:(?:mismo|original)\s+)?(?:documento|archivo|word|docx)(?:\s+(?:editado|completo|original))?\b/g, ' ')
    .replace(/\b(?:por favor|quiero que|necesito que|puedes|podrias)\b/g, ' ')
    .replace(/\b(?:en|del|de|el|la|los|las|mi|este|esta|ese|esa|mismo|misma|documento|archivo|word|docx|original|adjunto|subido|cargado|ahora|solo|solamente|unicamente|y|e|the|please)\b/g, ' ')
    .replace(/[\s,;:.!?()]+/g, '');
  if (remainder) return failure('INSTRUCTION_REQUIRED', 'No pude interpretar toda la ubicación o las condiciones del cambio con seguridad. Indica un reemplazo entre comillas y, si hace falta, el número de párrafo o una frase exacta de contexto. El original no se modificó.');
  return { edit, ...(sourceNames.length ? { sourceFilename: sourceNames[0] } : {}) };
}

module.exports = { parseDocxPrecisionRequest };
