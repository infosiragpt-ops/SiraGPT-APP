'use strict';

/**
 * audio-quality: the engine-agnostic quality of one transcribed piece and the
 * choice between hypotheses (contract C4, quality half). Pure: no binaries,
 * no network, no clock.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const q = require('../src/services/audio-quality');
const format = require('../src/services/media-transcript-format');

const SPEECH = 'Buenos días a todos. Hoy vamos a hablar de la elasticidad precio de la demanda, '
  + 'que mide cuánto cambia la cantidad demandada cuando cambia el precio de un bien.';

const SENTENCES = [
  'La oferta agregada depende de los costos de producción y de la tecnología disponible.',
  'Cuando sube la tasa de interés, la inversión privada suele disminuir en el corto plazo.',
  'El banco central publicó su informe trimestral con nuevas proyecciones de inflación.',
  'Los estudiantes deben entregar el ensayo final antes del viernes por la tarde.',
  'En Ayacucho se celebró una feria agrícola con productores de quinua y papa nativa.',
  'La profesora pidió revisar el capítulo cuatro sobre externalidades y bienes públicos.',
  'Un aumento del salario mínimo puede afectar el empleo formal de los jóvenes.',
  'El tipo de cambio se mantuvo estable gracias a las intervenciones del regulador.',
  'Las exportaciones mineras crecieron por la mejora en los precios internacionales del cobre.',
  'Para el examen parcial entra todo lo visto desde la primera semana de clases.',
];
/** Varied prose (a repeated sentence would read as a decoder loop). */
function prose(sentences) {
  return Array.from({ length: sentences }, (_, i) => `${SENTENCES[i % SENTENCES.length]} (${i + 1})`).join(' ');
}

function hyp(text, extra = {}) {
  return q.assessHypothesis({ text, segments: [], durationSec: 60, ...extra });
}

test('non-speech annotations, engine sign-offs and credits are never speech; real words are', () => {
  for (const text of ['[Música]', '[BLANK_AUDIO]', '(silencio)', '♪ ♪', '<|nospeech|>', '...']) {
    assert.equal(q.classifySegment({ start: 0, end: 5, text }), 'annotation', text);
  }
  assert.equal(q.classifySegment({ start: 0, end: 5, text: 'Gracias por ver el video.' }), 'lexicon');
  assert.equal(q.classifySegment({ start: 0, end: 5, text: 'Subtítulos realizados por la comunidad de Amara.org' }), 'lexicon');
  assert.equal(q.classifySegment({ start: 0, end: 5, text: '¡Suscríbete al canal!' }), 'lexicon');
  assert.equal(q.classifySegment({ start: 0, end: 4, text: 'Gracias.' }), 'soft', 'a lone «Gracias» over ≥ 3 s needs a second opinion');
  assert.equal(q.classifySegment({ start: 0, end: 1, text: 'Gracias.' }), 'speech', 'a short «Gracias» is speech');
  assert.equal(q.classifySegment({ start: 0, end: 2, text: 'Sí.' }), 'speech');
  assert.equal(q.isNonSpeechText('[MÚSICA] Hola'), false, 'an annotation next to words keeps the words');
});

test('multi-word annotations over music or noise are never speech; bracketed words and lyrics are', () => {
  for (const text of [
    '[Música de fondo]', '(música suave)', '[Music playing]', '(upbeat music)', '[Sonido de fondo]', '[♪]',
    '[MUSIC PLAYING]', '*música*', '*[Música]*', '[Aplausos y risas]', '(laughs)', '[Música de fondo] [Aplausos]',
    '(silencio) ...', '[BLANK_AUDIO] <| nospeech |>',
  ]) {
    assert.equal(q.isNonSpeechText(text), true, text);
    assert.equal(q.classifySegment({ start: 0, end: 20, text }), 'annotation', text);
  }
  for (const text of [
    '[Profesor] La clase empieza ahora.',
    '(risas) Bueno, como decía, la demanda cae.',
    'Música.',
    '[♪ Te quiero mucho, mi amor ♪]',
    '[La música barroca nace en Italia en el siglo diecisiete]',
    '*hola a todos*',
    '[Música de fondo] Hola a todos.',
  ]) {
    assert.equal(q.isNonSpeechText(text), false, text);
  }
  // A music-only clip is «nothing said», never a transcript of «[Música de fondo]».
  const music = q.assessHypothesis({ text: '[Música de fondo]', segments: [{ start: 0, end: 20, text: '[Música de fondo]' }], durationSec: 20 });
  assert.equal(music.empty, true);
  assert.equal(q.saysNothing(music), true);
  // Bounded scan: a very long annotation-looking text is linear and conservative.
  assert.equal(q.isNonSpeechText('[Música] '.repeat(5000)), true);
  assert.equal(q.isNonSpeechText(`[${'música '.repeat(40)}]`), false, 'a group over the size cap is not trusted as an annotation');
});

test('prompt echo: a run of the primed words is never speech; a sentence using one of them is', () => {
  const index = q.buildPromptIndex(['Bioquímica', 'Pérez', 'Ayacucho']);
  assert.equal(q.classifySegment({ start: 0, end: 2, text: 'Bioquímica, Pérez, Ayacucho.' }, index), 'echo');
  assert.equal(q.classifySegment({ start: 0, end: 4, text: 'Pérez.' }, index), 'soft');
  assert.equal(q.classifySegment({ start: 0, end: 6, text: 'El profesor Pérez explicó la bioquímica del suelo.' }, index), 'speech');
  const echo = q.assessHypothesis({ text: 'Bioquímica, Pérez, Ayacucho.', segments: [], durationSec: 20, voicedSec: 15, promptIndex: index });
  assert.equal(echo.hardOnly, true);
  assert.deepEqual(echo.flags, ['hallucination']);
  assert.equal(echo.kinds.echo, 1);
});

test('compression ratio flags a decoder loop; ordinary prose and short text do not', () => {
  const loop = Array.from({ length: 40 }, () => 'y entonces el profesor dijo que').join(' ');
  assert.ok(q.compressionRatio(loop) > q.LOOP_COMPRESSION_RATIO);
  assert.ok(q.compressionRatio(SPEECH + ' ' + SPEECH.split('').reverse().join('')) < q.LOOP_COMPRESSION_RATIO);
  assert.equal(q.compressionRatio('Hola, ¿cómo estás?'), null, 'under 200 chars: no verdict');
  const assessed = hyp(loop);
  assert.ok(assessed.flags.includes('loop'));
  assert.deepEqual(assessed.spans.map((s) => s.reason), ['loop']);
  assert.ok(q.isHard(assessed));
});

test('empty text: silence is fine, speech energy is suspicious, unknown energy asks to be measured', () => {
  const silent = q.assessHypothesis({ text: '', durationSec: 600, voicedSec: 0.5 });
  assert.deepEqual(silent.flags, []);
  assert.equal(silent.score, 1);
  assert.equal(silent.empty, true);
  const energetic = q.assessHypothesis({ text: '[Música]', durationSec: 600, voicedSec: 240 });
  assert.deepEqual(energetic.flags, ['empty_with_energy']);
  assert.equal(energetic.score, 0.1);
  assert.ok(q.saysNothing(energetic));
  const unknown = q.assessHypothesis({ text: '', durationSec: 600 });
  assert.equal(unknown.needsEnergy, true);
  assert.deepEqual(unknown.flags, []);
  const signOff = q.assessHypothesis({ text: 'Gracias por ver el video.', durationSec: 30, voicedSec: 20 });
  assert.deepEqual(signOff.flags, ['hallucination']);
});

test('characters per voiced second: skipped speech and text invented over silence are flagged only with measured evidence', () => {
  const sparse = q.assessHypothesis({ text: 'Hola a todos.', durationSec: 600, voicedSec: 400 });
  assert.ok(sparse.flags.includes('under_transcribed'));
  assert.equal(sparse.spans[0].reason, 'under_transcribed');
  const unmeasured = q.assessHypothesis({ text: 'Hola a todos.', durationSec: 600 });
  assert.equal(unmeasured.needsEnergy, true, 'sparse for its length: measure before judging');
  assert.deepEqual(unmeasured.flags, []);
  const dense = q.assessHypothesis({ text: prose(4), durationSec: 30, voicedSec: 4 });
  assert.ok(dense.flags.includes('over_generated'));
  const normal = q.assessHypothesis({ text: SPEECH, durationSec: 15, voicedSec: 13 });
  assert.deepEqual(normal.flags, []);
  assert.equal(normal.score, 1);
});

test('holes: a voiced stretch ≥ 30 s without any segment is dropped speech; a silent one is not', () => {
  const segments = [{ start: 0, end: 10, text: SENTENCES[0] }, { start: 80, end: 120, text: SENTENCES[1] }];
  const voicedHole = q.assessHypothesis({ text: SPEECH, segments, durationSec: 120, voicedSec: 110, silences: [] });
  assert.ok(voicedHole.flags.includes('dropped_speech'));
  assert.deepEqual(voicedHole.spans.filter((s) => s.reason === 'dropped_speech').map(({ start, end, reason }) => ({ start, end, reason })),
    [{ start: 10, end: 80, reason: 'dropped_speech' }]);
  const silentHole = q.assessHypothesis({ text: SPEECH, segments, durationSec: 120, voicedSec: 50, silences: [{ start: 11, end: 79 }] });
  assert.ok(!silentHole.flags.includes('dropped_speech'));
  assert.deepEqual(q.timestampHoles(segments, 120), [{ start: 10, end: 80 }]);
});

test('an engine\'s own low confidence flags the piece but never counts in a choice between engines', () => {
  const low = q.assessHypothesis({
    text: SPEECH, segments: [{ start: 0, end: 15, text: SPEECH, confidence: 0.2 }], durationSec: 15, voicedSec: 14,
  });
  assert.ok(low.flags.includes('low_confidence'));
  assert.ok(low.score < 1);
  assert.equal(low.agnosticScore, 1, 'the engine-agnostic score ignores logprob-derived flags');
  assert.equal(q.meanConfidence([{ start: 0, end: 1, confidence: 0.9 }, { start: 1, end: 4, confidence: 0.1 }]), 0.3);
});

test('word agreement ≈ 1 − WER, case and accent insensitive, bounded', () => {
  assert.equal(q.wordAgreement('Hola, ¿cómo estás?', 'hola como estas'), 1);
  assert.equal(q.wordAgreement('uno dos tres cuatro cinco seis siete ocho nueve diez', 'uno dos tres cuatro cinco seis siete ocho nueve once'), 0.9);
  assert.equal(q.wordAgreement('', ''), 1);
  assert.equal(q.wordAgreement('hola', ''), 0);
  const long = Array.from({ length: 5000 }, (_, i) => `palabra${i % 50}`).join(' ');
  assert.equal(q.wordAgreement(long, long), 1, 'capped token lists still compare');
});

test('choosing: every hypothesis says nothing → the first stays, confirmed when two agree', () => {
  const one = q.chooseHypothesis([{ order: 0, assessment: hyp('') }]);
  assert.equal(one.confirmedEmpty, false);
  const two = q.chooseHypothesis([{ order: 0, assessment: hyp('[Música]') }, { order: 1, assessment: hyp('') }]);
  assert.equal(two.chosen.order, 0);
  assert.equal(two.confirmedEmpty, true);
  // A lone «Gracias» against «nothing heard» is the silence hallucination.
  const suspect = q.chooseHypothesis([
    { order: 0, assessment: q.assessHypothesis({ text: 'Gracias.', segments: [{ start: 0, end: 5, text: 'Gracias.' }], durationSec: 6 }) },
    { order: 1, assessment: hyp('') },
  ]);
  assert.equal(suspect.chosen.order, 1);
  assert.equal(suspect.confirmedEmpty, true);
  // An invented sign-off first, nothing heard second: the empty one is kept.
  const signOff = q.assessHypothesis({ text: 'Gracias por ver el video.', segments: [{ start: 0, end: 4, text: 'Gracias por ver el video.' }], durationSec: 600, voicedSec: 300 });
  assert.equal(signOff.hardOnly, true);
  const kept = q.chooseHypothesis([{ order: 0, assessment: signOff }, { order: 1, assessment: q.assessHypothesis({ text: '', durationSec: 600, voicedSec: 300 }) }]);
  assert.equal(kept.confirmedEmpty, true);
  assert.equal(kept.chosen.order, 1, 'the truly empty hypothesis, not the hallucination');
  const both = q.chooseHypothesis([{ order: 0, assessment: signOff }, { order: 1, assessment: hyp('[Música]') }, { order: 2, assessment: hyp('') }]);
  assert.equal(both.chosen.order, 1, 'the first one that says nothing honestly (an annotation) wins');
});

test('choosing: speech beats nothing, a clean reading beats a loop; a flagged reading replaced is a repair, not a disagreement', () => {
  const recovered = q.chooseHypothesis([{ order: 0, assessment: hyp('') }, { order: 1, assessment: hyp(SPEECH) }]);
  assert.equal(recovered.chosen.order, 1);
  assert.equal(recovered.disagreement, false);
  const loop = Array.from({ length: 40 }, () => 'y entonces el profesor dijo que').join(' ');
  const unlooped = q.chooseHypothesis([{ order: 0, assessment: hyp(loop) }, { order: 1, assessment: hyp(SPEECH) }]);
  assert.equal(unlooped.chosen.order, 1);
  const repaired = q.chooseHypothesis([
    { order: 0, engineKey: 'groq:x', assessment: q.assessHypothesis({ text: 'Hola a todos.', durationSec: 600, voicedSec: 300 }) },
    { order: 1, engineKey: 'elevenlabs:scribe', assessment: q.assessHypothesis({ text: prose(10), durationSec: 600, voicedSec: 300 }) },
  ]);
  assert.equal(repaired.chosen.order, 1, 'clearly better (≥ 0.25) wins without agreement');
  assert.equal(repaired.disagreement, false);
});

test('choosing: two readings that agree confirm each other; confidence breaks ties only within one engine', () => {
  const lowConfA = q.assessHypothesis({ text: SPEECH, segments: [{ start: 0, end: 15, text: SPEECH, confidence: 0.2 }], durationSec: 15, voicedSec: 14 });
  const noConfB = q.assessHypothesis({ text: SPEECH, durationSec: 15, voicedSec: 14 });
  const crossEngine = q.chooseHypothesis([
    { order: 0, engineKey: 'local:ggml-base.bin', assessment: lowConfA },
    { order: 1, engineKey: 'xai:grok-stt', assessment: noConfB },
  ]);
  assert.equal(crossEngine.chosen.order, 0, 'a logprob is never compared with another engine: the first answer stays');
  assert.ok(crossEngine.agreement >= q.AGREEMENT_OK);
  const highConf = q.assessHypothesis({ text: SPEECH, segments: [{ start: 0, end: 15, text: SPEECH, confidence: 0.9 }], durationSec: 15, voicedSec: 14 });
  const sameEngine = q.chooseHypothesis([
    { order: 0, engineKey: 'local:ggml-base.bin', assessment: lowConfA },
    { order: 1, engineKey: 'local:ggml-base.bin', assessment: highConf },
  ]);
  assert.equal(sameEngine.chosen.order, 1, 'the same engine on an enhanced copy: its own confidence decides');
});

test('choosing: two clean readings that differ keep the first answer and are a disagreement', () => {
  const other = 'El mercado de valores cerró con una caída del tres por ciento según los analistas consultados por la radio local.';
  const choice = q.chooseHypothesis([
    { order: 0, engineKey: 'groq:x', assessment: q.assessHypothesis({ text: SPEECH, durationSec: 15, voicedSec: 14 }) },
    { order: 1, engineKey: 'openai:y', assessment: q.assessHypothesis({ text: other, durationSec: 15, voicedSec: 14 }) },
  ]);
  assert.equal(choice.chosen.order, 0);
  assert.equal(choice.disagreement, true);
});

test('silencedetect output → voiced seconds; a trailing silence runs to the end of the piece', () => {
  const stderr = [
    '[silencedetect @ 0x1] silence_start: 0',
    '[silencedetect @ 0x1] silence_end: 4.5 | silence_duration: 4.5',
    '[silencedetect @ 0x1] silence_start: 50',
  ].join('\n');
  const out = q.voicedFromSilencedetect(stderr, 60);
  assert.equal(out.voicedSec, 45.5);
  assert.deepEqual(out.silences, [{ start: 0, end: 4.5 }, { start: 50, end: 60 }]);
  assert.equal(q.voicedFromSilencedetect('', 0).voicedSec, null, 'no length, no verdict');
  assert.equal(q.voicedWithin(out.silences, 0, 10), 5.5);
});

test('summarizeQuality: duration-weighted score, gaps count as zero, spans merged and bounded, Spanish notes', () => {
  const report = q.summarizeQuality({
    pieces: [
      { start: 0, end: 600, covered: true, score: 1, engine: 'groq:whisper-large-v3-turbo', lowConfidence: [] },
      { start: 600, end: 1200, covered: true, score: 0.6, engine: 'local:ggml-base.bin', disagreement: true,
        lowConfidence: [{ start: 600, end: 1200, reason: 'engine_disagreement' }], reviewed: true },
      { start: 1200, end: 1800, covered: false, score: 0 },
    ],
    segments: [
      { start: 10, end: 12, text: 'a', confidence: 0.2 },
      { start: 12.5, end: 14, text: 'b', confidence: 0.3 },
      { start: 30, end: 31, text: 'c', confidence: 0.9 },
    ],
    escalations: 2,
  });
  assert.equal(report.score, Math.round(((1 * 600 + 0.6 * 600) / 1800) * 1000) / 1000);
  assert.equal(report.level, 'baja');
  assert.deepEqual(report.lowConfidence, [
    { start: 10, end: 14, reason: 'low_confidence' },
    { start: 600, end: 1200, reason: 'engine_disagreement' },
  ]);
  assert.deepEqual(report.enginesUsed, ['groq:whisper-large-v3-turbo', 'local:ggml-base.bin']);
  assert.equal(report.escalations, 2, 'attempts, failed ones included');
  assert.ok(report.notes.some((n) => /Revisé 1 tramo dudoso /.test(n)), 'the note counts pieces that got another reading, not attempts');
  assert.ok(report.notes.some((n) => /los motores no coincidieron/.test(n)));
  // The formatter's own normalizer accepts it as is.
  assert.deepEqual(format.normalizeQuality(report), report);
  assert.equal(q.qualityLevel(0.9), 'alta');
  assert.equal(q.qualityLevel(0.7), 'media');
  assert.equal(q.qualityLevel(0.2), 'baja');
});

test('summarizeQuality: attempts that all failed are not «revisé»; a confirmation says «una segunda lectura»', () => {
  // One clip: the first alternative errored, none answered.
  const failed = q.summarizeQuality({
    pieces: [{ start: 0, end: 20, covered: true, score: 0.75, engine: 'openai:whisper-1', lowConfidence: [], reviewed: false }],
    escalations: 2,
  });
  assert.equal(failed.escalations, 2);
  assert.ok(!failed.notes.some((n) => /Revisé/.test(n)), 'nothing was reviewed: no «Revisé N tramos»');
  assert.ok(failed.notes.some((n) => /1 tramo quedó con señales de baja calidad que no se pudieron revisar/.test(n)));
  // An explicit count wins over the per-piece flags.
  const explicit = q.summarizeQuality({ pieces: [{ start: 0, end: 20, covered: true, score: 1, lowConfidence: [] }], escalations: 3, reviewedPieces: 2 });
  assert.ok(explicit.notes.some((n) => /Revisé 2 tramos dudosos/.test(n)));
  const confirmed = q.summarizeQuality({ pieces: [{ start: 0, end: 600, covered: true, score: 1, lowConfidence: [], confirmedEmpty: true, reviewed: true }], escalations: 1 });
  assert.ok(confirmed.notes.some((n) => /lo confirmé con una segunda lectura/.test(n)));
  assert.ok(!confirmed.notes.some((n) => /segundo motor/.test(n)), 'the confirmation may come from the same engine on an enhanced copy');
});

test('summarizeQuality: the basic local model alone caps «alta» without confidence data and says so', () => {
  const pieces = [{ start: 0, end: 60, covered: true, score: 1, engine: 'local:ggml-base.bin', lowConfidence: [] }];
  const capped = q.summarizeQuality({ pieces, basicLocalOnly: true });
  assert.equal(capped.level, 'media');
  assert.ok(capped.notes.some((n) => /motor local básico/.test(n)));
  const measured = q.summarizeQuality({ pieces, basicLocalOnly: true, capBasicLevel: false });
  assert.equal(measured.level, 'alta');
  const many = q.mergeSpans(Array.from({ length: 2000 }, (_, i) => ({ start: i * 10, end: i * 10 + 1, reason: i % 2 ? 'noise' : 'loop' })));
  assert.equal(many.length, 500, 'bounded like the sidecar');
});

test('a verbose_json segment the engine itself rates as silence (no_speech_prob > 0.6, avg_logprob < −1) needs a second opinion', () => {
  assert.equal(q.classifySegment({ start: 0, end: 5, text: 'Hasta luego.', no_speech_prob: 0.9, avg_logprob: -1.4 }), 'soft');
  assert.equal(q.classifySegment({ start: 0, end: 5, text: 'Hasta luego.', no_speech_prob: 0.9, avg_logprob: -0.3 }), 'speech');
  assert.equal(q.segmentConfidence({ avg_logprob: Math.log(0.5) }), 0.5);
  const cloud = q.assessHypothesis({ text: 'x', segments: [{ start: 0, end: 10, text: 'Buenos días a todos y bienvenidos.', avg_logprob: -2 }], durationSec: 10, voicedSec: 9 });
  assert.ok(cloud.flags.includes('low_confidence'), 'avg_logprob counts as the engine\'s own confidence');
});
