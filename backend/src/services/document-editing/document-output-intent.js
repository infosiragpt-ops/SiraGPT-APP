'use strict';

// Output names are occurrences in an explicit delivery clause, not a global
// exclusion list: the same name may also identify the original elsewhere.
const QUOTED = '"[^"\\r\\n]*"|“[^”\\r\\n]*”|«[^»\\r\\n]*»|\'[^\'\\r\\n]*\'|‘[^’\\r\\n]*’|`[^`\\r\\n]*`';
const EXT = '(?:docx?|xlsx?|xlsm|pptx?|pdf|csv|txt|md)';
const BARE_NAME = `[\\p{L}\\p{N}_-][^\\s"'“”«»‘’\x60<>/\\\\,;:!?()\\[\\]{}]*\\.${EXT}(?![\\p{L}\\p{N}_-]|\\.[\\p{L}\\p{N}])`;
const TARGET = `(?:${QUOTED}|${BARE_NAME})`;
const OBJECT = '(?:(?:el|la|un|una|the|a)\\s+)?(?:(?:archivo|documento|resultado|copia|versi[oó]n|file|document|result|copy|version)(?:\\s+(?:editad[oa]|revisad[oa]|edited|revised|final))?\\s+)?';
const AS = '(?:como|as|con\\s+(?:el\\s+)?nombre(?:\\s+de)?)\\s+';
const SAVE = `(?:gu[aá]rda(?:r|me|lo|la)?|exporta(?:r|me|lo|la)?|save|export)\\s+${OBJECT}${AS}`;
const DELIVER = `(?:entr[eé]ga(?:r|me|lo|la)?|devu[eé]lv(?:e|eme|elo|ela)|dame|return|deliver)\\s+${OBJECT}(?:${AS})?`;
const LABEL = '(?:nombre\\s+(?:del\\s+archivo\\s+de\\s+salida|de\\s+salida)|output\\s+filename)\\s*[:=]\\s*';
const OUTPUT = new RegExp(`${QUOTED}|\\b(?:${SAVE}|${DELIVER}|${LABEL})(?<targets>${TARGET}(?:\\s*(?:,|y|e|and)\\s*${TARGET})*)`, 'giu');
const SAFE_NAME = new RegExp(`^[\\p{L}\\p{N}_-][^<>:"/\\\\|?*\\x00-\\x1f]*\\.${EXT}$`, 'iu');

function documentOutputIntent(instruction) {
  const text = String(instruction || '');
  const outputNames = [];
  // The quoted alternative consumes document values whole. Commands inside a
  // literal replacement (e.g. "Entrega final.docx") remain opaque content.
  const sourceInstruction = text.replace(OUTPUT, (...args) => {
    const targets = args.at(-1)?.targets;
    if (!targets) return args[0];
    const offset = args.at(-3);
    const before = text.slice(0, offset).replace(new RegExp(TARGET, 'giu'), ' ')
      .split(/[.!?;](?=\s|$)|\n/u).at(-1)
      .replace(/\bno\s+(?:cambies|alteres|modifiques|toques)\s+(?:(?:el|la|los|las)\s+)?(?:formato(?:\s+original)?|estilos?|resto(?:\s+del\s+documento)?|lo\s+dem[aá]s|nada\s+m[aá]s)\b/giu, ' ');
    const after = text.slice(offset + args[0].length);
    // A forbidden or conditional destination is not an unconditional rename.
    if (/\b(?:no|nunca|not|never|don['’]t)\b/iu.test(before)
      || /\bsin\s*$/iu.test(before)
      || /\b(?:si|if|unless|cuando)\b/iu.test(before)
      || /^\s*,?\s*(?:(?:solo|only)\s+)?(?:si|if|unless|cuando)\b/iu.test(after)) return args[0];
    const names = [...targets.matchAll(new RegExp(TARGET, 'giu'))].map(([token]) =>
      (/^["“«'‘`]/u.test(token) ? token.slice(1, -1) : token).normalize('NFC'));
    if (!names.length || names.some((name) => name.length > 240 || !SAFE_NAME.test(name))) return args[0];
    outputNames.push(...names);
    return ' ';
  });
  return { sourceInstruction, outputNames: [...new Set(outputNames)] };
}

module.exports = { documentOutputIntent };
