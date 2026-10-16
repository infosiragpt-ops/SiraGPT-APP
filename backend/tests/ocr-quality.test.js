'use strict';

// ocr-quality: pure text checks for OCR output (unicode gate, garbage gate,
// repetition loops, agreement between reads, digits, [ilegible] markers).

const test = require('node:test');
const assert = require('node:assert/strict');

const q = require('../src/services/ocr-quality');

test('useful chars count every script; CJK weighs double; the old Latin-only gate scored these 0', () => {
  assert.equal(q.usefulCharCount('Привет мир'), 9);
  assert.equal(q.usefulCharCount('你好世界'), 8);
  assert.equal(q.usefulCharCount('مرحبا بالعالم'), 12);
  assert.equal(q.usefulCharCount('Γειά σου'), 7);
  assert.equal(q.usefulCharCount('こんにちは'), 10);
  assert.equal(q.usefulCharCount('Ação, façade, Straße'), 16);
  assert.equal(q.usefulCharCount('|| -- ~~ ##'), 0);
  assert.equal(q.usefulCharCount(null), 0);
  assert.equal(q.usefulCharCount(undefined), 0);
});

test('short math is legible; a lone symbol is not', () => {
  const read = (t) => ({ usefulChars: q.usefulCharCount(t), mathSymbols: q.mathSymbolCount(t) });
  assert.equal(q.isLegibleShort(read('√2')), true);
  assert.equal(q.isLegibleShort(read('x²=4')), true);
  assert.equal(q.isLegibleShort(read('π')), false, 'one glyph alone is too little');
  assert.equal(q.isLegibleShort(read('=')), false);
  assert.equal(q.isLegibleShort(read('hola')), true);
  assert.equal(q.isLegibleShort(read('ab')), false);
});

test('script profile names the dominant script', () => {
  assert.equal(q.scriptProfile('Это русский текст').dominant, 'cyrillic');
  assert.equal(q.scriptProfile('这是中文').dominant, 'cjk');
  assert.equal(q.scriptProfile('هذا نص عربي').dominant, 'arabic');
  assert.equal(q.scriptProfile('Texto en español').dominant, 'latin');
  assert.equal(q.scriptProfile('12345').dominant, null);
});

test('dictionary-word ratio separates real Spanish/English from Tesseract noise and abstains on little evidence', () => {
  const spanish = 'La factura fue emitida por la empresa en Lima el día de ayer y debe pagarse antes del viernes.';
  const english = 'The invoice was issued by the company yesterday and must be paid before Friday.';
  const noise = 'rnmw tHe Iil xqzpt aaaa vvbnkl zzrt pkkqw ||| Ww mmnnb';
  assert.ok(q.dictionaryWordRatio(spanish) > 0.9);
  assert.ok(q.dictionaryWordRatio(english) > 0.9);
  assert.ok(q.dictionaryWordRatio(noise) < 0.4);
  assert.equal(q.dictionaryWordRatio('hola mundo'), null, 'too few tokens to judge');
  assert.equal(q.dictionaryWordRatio('Это достаточно длинный русский текст для проверки'), null, 'non-Latin is never judged');
  assert.ok(q.stopwordRatio(spanish) > 0.3);
});

test('plausible word shapes', () => {
  for (const w of ['Huamán', 'Ayacucho', 'construcción', 'DNI', 'PDF', 'a', 'y', 'strengths', 'rhythm']) {
    assert.equal(q.isPlausibleLatinWord(w), true, w);
  }
  for (const w of ['rnmw', 'tHe', 'aaaa', 'xqzpt', 'k', '']) {
    assert.equal(q.isPlausibleLatinWord(w), false, w);
  }
});

test('repetition loop: the same line four times in a row', () => {
  const text = 'Título del informe\nPrimera línea real\nfila repetida del modelo\nfila repetida del modelo\n\nfila repetida del modelo\nfila repetida del modelo\nfila repetida del modelo';
  const loop = q.detectRepetitionLoop(text);
  assert.equal(loop.looping, true);
  assert.equal(loop.kind, 'line');
  assert.equal(loop.repeats, 5);
  assert.equal(loop.kept, 'Título del informe\nPrimera línea real\nfila repetida del modelo');
});

test('repetition loop: a periodic tail inside one line', () => {
  const text = `Resumen del contrato: ${'el plazo es de treinta días '.repeat(12)}`;
  const loop = q.detectRepetitionLoop(text);
  assert.equal(loop.looping, true);
  assert.equal(loop.kind, 'tail');
  assert.ok(loop.repeats >= 5);
  assert.ok(loop.kept.startsWith('Resumen del contrato:'));
  assert.ok(loop.kept.length < text.length / 3);
});

test('repetition loop: legitimate repetition is not a loop', () => {
  // Chat laughter, dot leaders, table rules, empty table rows, a few repeats.
  assert.equal(q.detectRepetitionLoop('Me dijo que sí jajajajajajajaja').looping, false);
  assert.equal(q.detectRepetitionLoop(`Introducción ${'.'.repeat(80)} 5`).looping, false);
  assert.equal(q.detectRepetitionLoop('| a | b |\n|---|---|\n|---|---|\n|---|---|\n|---|---|').looping, false);
  assert.equal(q.detectRepetitionLoop('| | |\n| | |\n| | |\n| | |\n| | |').looping, false);
  assert.equal(q.detectRepetitionLoop('Total\nTotal\nTotal').looping, false, 'three copies are below the threshold');
  assert.equal(q.detectRepetitionLoop(`Saldo ${'| 0.00 | 0.00 |\n'.repeat(6)}`).looping, false, 'numeric rows need a model-length run');
  assert.equal(q.detectRepetitionLoop('').looping, false);
});

test('repetition loop: identical lines in the MIDDLE are content (receipt items, form fields, table rows)', () => {
  const receipt = [
    'BODEGA SAN JUAN', 'RUC 20123456789', 'Fecha: 12/10/2026',
    '1 x Inca Kola 500ml 3.50', '1 x Inca Kola 500ml 3.50', '1 x Inca Kola 500ml 3.50', '1 x Inca Kola 500ml 3.50',
    'TOTAL 14.00', 'Gracias por su compra',
  ].join('\n');
  const r = q.detectRepetitionLoop(receipt);
  assert.equal(r.looping, false);
  assert.equal(r.kept, receipt, 'nothing is dropped');
  assert.equal(q.assessText(receipt).garbageLikely, false);

  const form = 'SOLICITUD DE INSCRIPCIÓN\nNombre: Juan Pérez\nFirma: ____________\nFirma: ____________\nFirma: ____________\nFirma: ____________';
  assert.equal(q.detectRepetitionLoop(form).looping, false, 'signature lines at the end are form fields');
  assert.equal(q.assessText(form).garbageLikely, false, 'underscores of a form are layout, not noise');
  const leaders = 'Índice\nCapítulo 1 .......... 5\nCapítulo 1 .......... 5\nCapítulo 1 .......... 5\nCapítulo 1 .......... 5\nCapítulo 1 .......... 5';
  assert.equal(q.detectRepetitionLoop(leaders).looping, false);

  const table = [
    '| Producto | Precio |', '|---|---|',
    '| Inca Kola | 3.50 |', '| Inca Kola | 3.50 |', '| Inca Kola | 3.50 |', '| Inca Kola | 3.50 |',
  ].join('\n');
  assert.equal(q.detectRepetitionLoop(table).looping, false, 'four identical table rows, even at the end');
  assert.equal(q.detectRepetitionLoop(`${table}\n${'| Inca Kola | 3.50 |\n'.repeat(3)}`).looping, false, 'seven rows: still below the table threshold');
  const loopedTable = `${table}\n${'| Inca Kola | 3.50 |\n'.repeat(20)}`;
  assert.equal(q.detectRepetitionLoop(loopedTable).looping, true, 'a model-length run of rows at the end is a loop');
});

test('repetition loop: a run that reaches the end is a loop even when the last copy is cut mid-line', () => {
  const text = `Acta de reunión\nAsistentes: 4\n${'El modelo repite esta línea\n'.repeat(9)}El modelo rep`;
  const loop = q.detectRepetitionLoop(text);
  assert.equal(loop.looping, true);
  assert.equal(loop.kind, 'line');
  assert.equal(loop.position, 'end');
  assert.equal(loop.repeats, 9);
  assert.equal(loop.kept, 'Acta de reunión\nAsistentes: 4\nEl modelo repite esta línea');
});

test('repetition loop: a long run in the middle is flagged but the text after it is kept', () => {
  const text = `Título\n${'línea repetida del modelo\n'.repeat(10)}Cierre del documento firmado`;
  const loop = q.detectRepetitionLoop(text);
  assert.equal(loop.looping, true);
  assert.equal(loop.position, 'middle');
  assert.equal(loop.repeats, 10);
  assert.equal(loop.kept, 'Título\nlínea repetida del modelo\nCierre del documento firmado');
  // Eight copies that are NOT half of the text: content, not a loop.
  const long = `${'Párrafo distinto número uno del informe\n'}${Array.from({ length: 12 }, (_, i) => `Línea ${i} del informe anual`).join('\n')}\n${'Fila repetida\n'.repeat(8)}${Array.from({ length: 6 }, (_, i) => `Cierre ${i}`).join('\n')}`;
  assert.equal(q.detectRepetitionLoop(long).looping, false);
});

test('assessText: a Markdown table or LaTeX math is not symbol noise; a stray | in prose still counts', () => {
  const table = [
    '| Mes | Producto | Ventas |', '|---|:---:|---:|',
    '| Enero | Arroz | 1200 |', '| Febrero | Azúcar | 980 |', '| Marzo | Aceite | 1500 |',
    '| Abril | Leche | 760 |', '| Mayo | Fideos | 890 |', '| Junio | Harina | 1100 |',
  ].join('\n');
  const t1 = q.assessText(table);
  assert.equal(t1.symbolRatio, 0);
  assert.equal(t1.garbageLikely, false);
  assert.equal(q.oddSymbolCensus(table).table, true);

  const latex = 'La fórmula es $$\\frac{a_{1}}{b^{2}} + \\sqrt{x}$$ y además $x_{i}$ se usa en el texto del informe.';
  assert.equal(q.assessText(latex).garbageLikely, false);

  // One `|` line is not a table: pipes in noise keep counting.
  assert.equal(q.oddSymbolCensus('|||| ~~ |').table, false);
  assert.ok(q.oddSymbolCensus('El total | es ~ diez').odd >= 2);
  const pipeNoise = q.assessText('| | |\n| | |\n|| ~ ||\n¦¦ ~~ || ¬ |\n|~| ¤ |');
  assert.ok(pipeNoise.reasons.includes('symbol_noise'), 'pipe-only rows are not a table');
});

test('agreement: identical reads agree, column order barely matters, disjoint reads disagree', () => {
  const a = 'Contrato de arrendamiento\nMonto: S/ 1.200\nPlazo: 12 meses';
  assert.ok(q.agreementScore(a, a).score > 0.99);
  const reordered = 'Plazo: 12 meses\nContrato de arrendamiento\nMonto: S/ 1.200';
  const r = q.agreementScore(a, reordered);
  assert.equal(r.wordF1, 1);
  assert.ok(r.score > 0.6);
  assert.ok(q.agreementScore(a, 'Receta de cocina con huevos y harina').score < 0.2);
  assert.equal(q.agreementScore('', 'algo').comparable, false);
  assert.ok(q.wordAgreement('你好世界', '你好世界') === 1, 'CJK is tokenised per glyph');
});

test('agreement ignores [ilegible] markers and unwraps uncertain words', () => {
  const tesseract = 'El paciente presenta fiebre alta';
  const vlm = 'El paciente [¿presenta?] fiebre [ilegible] alta';
  assert.ok(q.agreementScore(tesseract, vlm).wordF1 > 0.99);
});

test('levenshtein and charSimilarity are bounded', () => {
  assert.equal(q.levenshtein('kitten', 'sitting'), 3);
  assert.equal(q.levenshtein('', 'abc'), 3);
  assert.equal(q.levenshtein('a'.repeat(3000), 'b'.repeat(3000), { maxCells: 1000 }), null);
  assert.equal(q.charSimilarity('abc', 'abc'), 1);
  assert.equal(q.charSimilarity('x'.repeat(5000), 'y'.repeat(5000)), null, 'too big to align: abstains');
});

test('digit agreement: separators do not matter, a changed digit does', () => {
  const ok = q.digitAgreement('Total S/ 1.234,50 — RUC 20123456789', 'Total S/ 1234,50 RUC 20123456789');
  assert.equal(ok.recall, 1);
  assert.equal(ok.score, 1);
  const changed = q.digitAgreement('DNI 45678912, fecha 03/10/2026', 'DNI 45678913, fecha 03/10/2026');
  assert.equal(changed.recall, 0.5);
  assert.deepEqual(changed.missing, ['45678912']);
  const none = q.digitAgreement('sin números', 'tampoco');
  assert.equal(none.comparable, false);
  assert.equal(none.score, 1);
});

test('[ilegible]: variants are normalised, counted and stripped', () => {
  const raw = 'Firma: [illegible] (ilegible) [texto ilegible] — monto [unreadable: tachado] y [¿Huamán?]';
  const normalized = q.normalizeIllegibleMarkers(raw);
  assert.equal(normalized, 'Firma: [ilegible] — monto [ilegible] y [¿Huamán?]');
  assert.deepEqual(q.countIllegible(raw), { illegible: 2, uncertain: 1, total: 3 });
  assert.equal(q.stripIllegibleMarkers('a [ilegible] b [¿c?]').replace(/\s+/g, ' ').trim(), 'a b c');
  assert.equal(q.markUncertain('palabra'), '[¿palabra?]');
  assert.equal(q.markUncertain(''), '[ilegible]');
  assert.equal(q.illegibleRatio('[ilegible] [ilegible] uno'), 0.5, 'consecutive markers collapse into one');
  assert.equal(q.illegibleRatio(''), 0);
  // Ordinary brackets are untouched.
  assert.equal(q.normalizeIllegibleMarkers('[1] nota [...] fin'), '[1] nota [...] fin');
});

test('markIllegible turns low-confidence Tesseract words into one marker per run, never invents', () => {
  const words = [
    { text: 'Recibí', confidence: 92, line: 0 },
    { text: 'de', confidence: 90, line: 0 },
    { text: 'xq#', confidence: 12, line: 0 },
    { text: 'j!!', confidence: 8, line: 0 },
    { text: 'la', confidence: 88, line: 0 },
    { text: 'suma', confidence: 55, line: 1 },
    { text: '1500', confidence: 91, line: 1 },
  ];
  const out = q.markIllegible(words, { minConfidence: 30, uncertainBelow: 60 });
  assert.equal(out.text, 'Recibí de [ilegible] la\n[¿suma?] 1500');
  assert.equal(out.illegible, 2);
  assert.equal(out.uncertain, 1);
  assert.equal(out.words, 7);
  assert.equal(q.markIllegible(null).text, '');
});

test('page markers are honest Spanish', () => {
  assert.equal(q.unreadablePageMarker(3, 'too_little_text'), '[página 3 — no legible: sin texto legible]');
  assert.equal(q.unreadablePageMarker(4, 'local_ocr_timeout'), '[página 4 — no legible: tiempo agotado]');
  assert.equal(q.unreadablePageMarker(5, 'whatever'), '[página 5 — no legible: sin texto legible]');
  assert.equal(q.pageCapMarker(31, 40), '[páginas 31–40 sin OCR: límite]');
  assert.equal(q.pageCapMarker(7, 7, 'tiempo agotado'), '[página 7 sin OCR: tiempo agotado]');
});

test('assessText: garbage is flagged, clean text and non-Latin scripts are not', () => {
  const clean = q.assessText('La factura fue emitida por la empresa en Lima el día de ayer y debe pagarse antes del viernes.');
  assert.equal(clean.garbageLikely, false);
  const symbols = q.assessText('~~|| \\\\ ^^ ¦¦ ¬¬ ¤¤ ~| |~ ¦ ~~ || ¤ ¬ ~ |');
  assert.equal(symbols.garbageLikely, true);
  assert.ok(symbols.reasons.includes('symbol_noise'));
  const noise = q.assessText('rnmw tHe Iil xqzpt aaaa vvbnkl zzrt pkkqw Ww mmnnb');
  assert.ok(noise.reasons.includes('implausible_words'));
  const confusable = q.assessText('Тhe cоmpany рaid thе invоice tоday');
  assert.ok(confusable.reasons.includes('mixed_script'));
  const russian = q.assessText('Это обычный русский текст без ошибок распознавания');
  assert.equal(russian.garbageLikely, false);
  const math = q.assessText('x² + 2x = 4\n√16 = 4\n∑ aᵢ ≤ 10');
  assert.equal(math.garbageLikely, false);
  const looped = q.assessText(`Inicio ${'línea que se repite sin fin '.repeat(10)}`);
  assert.ok(looped.reasons.includes('repetition_loop'));
});
