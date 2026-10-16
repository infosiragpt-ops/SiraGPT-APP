'use strict';

// Golden tests for the professional transcript pack (PR-5 of the 5-hour
// transcription program). Inputs are fixed and outputs are pinned: a change in
// the rendered TXT / SRT / VTT / Markdown must be deliberate.

const test = require('node:test');
const assert = require('node:assert/strict');
const fmt = require('../src/services/media-transcript-format');

const NOW = new Date('2026-10-15T15:00:00Z');

// ── fixtures ────────────────────────────────────────────────────────────────

const SMALL = Object.freeze({
  ok: true,
  durationSec: 64,
  language: 'es',
  engine: 'mixed',
  providers: { openai: 2, local: 1 },
  segments: [
    { start: 0, end: 4.2, text: 'Buenos días a todos, hoy hablaremos de la célula.', speaker: 'SPEAKER_00' },
    { start: 4.4, end: 9.8, text: 'La mitocondria es la central energética de la célula.', speaker: 'SPEAKER_00' },
    { start: 10.1, end: 12.6, text: '¿Profesor, puede repetir la última parte?', speaker: 'SPEAKER_01', confidence: 0.32 },
    { start: 12.9, end: 21.5, text: 'Claro. La mitocondria produce ATP mediante la fosforilación oxidativa, en la membrana interna.', speaker: 'SPEAKER_00' },
    { start: 24.0, end: 27.0, text: 'Anoten esto: el ciclo de Krebs ocurre en la matriz.', speaker: 'SPEAKER_00' },
    { start: 27.0, end: 50.0, text: '¡Gracias!' },
    { start: 50.0, end: 52.0, text: 'Subtítulos realizados por la comunidad de Amara.org' },
  ],
  gaps: [{ start: 52, end: 58, reason: 'timeout' }],
});

const GOLDEN_SMALL_TXT = 'TRANSCRIPCIÓN\n'
  + '════════════════════════════════════════════════\n'
  + 'Archivo: clase-biologia.mp4\n'
  + 'Duración: 1 min 04 s\n'
  + 'Idioma: español\n'
  + 'Motor: mixto (nube y local) — OpenAI (2 tramos), Whisper local (1 tramo)\n'
  + 'Fecha: 15 de octubre de 2026\n'
  + 'Palabras: 47\n'
  + 'Cobertura: 90,6 % del audio\n'
  + 'Tramos sin transcribir: 00:52–00:58 (tiempo agotado)\n'
  + 'Hablantes: 2\n'
  + '\n'
  + 'Nota: [?] marca fragmentos de baja confianza; conviene verificarlos con el audio.\n'
  + 'Nota: Se omitieron 2 fragmentos repetidos o inventados por el motor en silencios.\n'
  + '════════════════════════════════════════════════\n'
  + '\n'
  + '[00:00] Hablante 1: Buenos días a todos, hoy hablaremos de la célula. La mitocondria es la central energética de la célula.\n'
  + '\n'
  + '[00:10] Hablante 2: ¿Profesor, puede repetir la última parte? [?]\n'
  + '\n'
  + '[00:12] Hablante 1: Claro. La mitocondria produce ATP mediante la fosforilación oxidativa, en la membrana interna.\n'
  + '\n'
  + '[00:24] Hablante 1: Anoten esto: el ciclo de Krebs ocurre en la matriz.\n'
  + '\n'
  + '[00:52–00:58 · tramo sin transcribir]\n';

const GOLDEN_SMALL_SRT = '1\n00:00:00,000 --> 00:00:04,200\nHablante 1: Buenos días a todos,\nhoy hablaremos de la célula.\n'
  + '\n2\n00:00:04,400 --> 00:00:09,800\nLa mitocondria es la central\nenergética de la célula.\n'
  + '\n3\n00:00:10,100 --> 00:00:12,600\nHablante 2: ¿Profesor,\npuede repetir la última parte?\n'
  + '\n4\n00:00:12,900 --> 00:00:17,321\nHablante 1: Claro.\nLa mitocondria produce ATP mediante\n'
  + '\n5\n00:00:17,321 --> 00:00:21,500\nla fosforilación oxidativa,\nen la membrana interna.\n'
  + '\n6\n00:00:24,000 --> 00:00:27,000\nAnoten esto: el ciclo de\nKrebs ocurre en la matriz.\n';

const GOLDEN_SMALL_VTT = 'WEBVTT\n\n'
  + '00:00:00.000 --> 00:00:04.200\n<v Hablante 1>Buenos días a todos, hoy\nhablaremos de la célula.\n\n'
  + '00:00:04.400 --> 00:00:09.800\n<v Hablante 1>La mitocondria es la central\nenergética de la célula.\n\n'
  + '00:00:10.100 --> 00:00:12.600\n<v Hablante 2>¿Profesor, puede repetir la última parte?\n\n'
  + '00:00:12.900 --> 00:00:17.064\n<v Hablante 1>Claro. La mitocondria\nproduce ATP mediante la\n\n'
  + '00:00:17.064 --> 00:00:21.500\n<v Hablante 1>fosforilación oxidativa,\nen la membrana interna.\n\n'
  + '00:00:24.000 --> 00:00:27.000\n<v Hablante 1>Anoten esto: el ciclo de\nKrebs ocurre en la matriz.\n';

const GOLDEN_SMALL_MD = '# Transcripción — clase-biologia.mp4\n\n'
  + '| Dato | Detalle |\n| --- | --- |\n'
  + '| Archivo | clase-biologia.mp4 |\n'
  + '| Duración | 1 min 04 s |\n'
  + '| Idioma | español |\n'
  + '| Motor | mixto (nube y local) — OpenAI (2 tramos), Whisper local (1 tramo) |\n'
  + '| Fecha | 15 de octubre de 2026 |\n'
  + '| Palabras | 47 |\n'
  + '| Cobertura | 90,6 % del audio |\n'
  + '| Tramos sin transcribir | 00:52–00:58 (tiempo agotado) |\n'
  + '| Hablantes | 2 |\n\n'
  + '## Transcripción\n\n'
  + '**[00:00] Hablante 1:** Buenos días a todos, hoy hablaremos de la célula. La mitocondria es la central energética de la célula.\n\n'
  + '**[00:10] Hablante 2:** ¿Profesor, puede repetir la última parte? [?]\n\n'
  + '**[00:12] Hablante 1:** Claro. La mitocondria produce ATP mediante la fosforilación oxidativa, en la membrana interna.\n\n'
  + '**[00:24] Hablante 1:** Anoten esto: el ciclo de Krebs ocurre en la matriz.\n\n'
  + '*[00:52–00:58 · tramo sin transcribir]*\n\n'
  + '## Notas\n\n'
  + '- [?] marca fragmentos de baja confianza; conviene verificarlos con el audio.\n'
  + '- Se omitieron 2 fragmentos repetidos o inventados por el motor en silencios.\n';

const WORDS = ['la', 'célula', 'mitocondria', 'energía', 'membrana', 'proteína', 'núcleo', 'síntesis',
  'proceso', 'importante', 'estudiar', 'examen', 'ejemplo', 'clase', 'ahora', 'vamos', 'entonces',
  'ribosoma', 'enzima', 'glucosa', 'oxígeno', 'respiración', 'transporte', 'gradiente'];

/** Deterministic 3-hour lecture: ~1665 segments, a 10-minute gap at 01:20:00. */
function threeHourLecture({ speakers = false } = {}) {
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const lengths = [5.5, 6.2, 4.8, 7.1, 3.9];
  const pauses = [0.3, 0.2, 2.1, 0.4, 0.1, 0.6];
  const segments = [];
  let t = 0;
  let i = 0;
  while (t < 10780) {
    if (t >= 4800 && t < 5400) { t = 5400; continue; }
    const len = lengths[i % lengths.length];
    const n = 8 + Math.floor(rand() * 8);
    const words = [];
    for (let k = 0; k < n; k++) words.push(WORDS[Math.floor(rand() * WORDS.length)]);
    const text = `${words[0][0].toUpperCase()}${words.join(' ').slice(1)}${i % 3 === 2 ? '.' : ','}`;
    const seg = { start: Math.round(t * 1000) / 1000, end: Math.round((t + len) * 1000) / 1000, text };
    if (speakers) seg.speaker = (Math.floor(i / 40) % 3 === 2) ? 'SPEAKER_01' : 'SPEAKER_00';
    segments.push(seg);
    t += len + pauses[i % pauses.length];
    i++;
  }
  return {
    ok: true,
    durationSec: 10805,
    language: 'spanish',
    engine: 'cloud',
    providers: { groq: 16, openai: 2 },
    segments,
    gaps: [{ start: 4800, end: 5400, reason: 'provider_failed' }],
    partial: true,
  };
}

// ── validators ──────────────────────────────────────────────────────────────

function clockMs(h, m, s, ms) {
  return ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(ms);
}

function len(text) {
  return Array.from(text).length;
}

function assertValidSubtitles(body, kind) {
  const sep = kind === 'srt' ? ',' : '.';
  let text = body;
  if (kind === 'vtt') {
    assert.ok(body.startsWith('WEBVTT\n\n'), 'VTT starts with the WEBVTT header');
    text = body.slice('WEBVTT\n\n'.length);
  }
  assert.ok(text.endsWith('\n') && !text.endsWith('\n\n'), 'single trailing newline');
  const blocks = text.trimEnd().split('\n\n');
  const timing = new RegExp(`^(\\d{2}):(\\d{2}):(\\d{2})\\${sep}(\\d{3}) --> (\\d{2}):(\\d{2}):(\\d{2})\\${sep}(\\d{3})$`);
  let prevEnd = -1;
  blocks.forEach((block, idx) => {
    const lines = block.split('\n');
    if (kind === 'srt') assert.equal(lines.shift(), String(idx + 1), `cue ${idx + 1} numbered sequentially`);
    const m = timing.exec(lines.shift());
    assert.ok(m, `cue ${idx + 1} has a ${kind} timing line`);
    const start = clockMs(m[1], m[2], m[3], m[4]);
    const end = clockMs(m[5], m[6], m[7], m[8]);
    assert.ok(start >= prevEnd, `cue ${idx + 1} does not overlap the previous one`);
    assert.ok(end - start >= 700, `cue ${idx + 1} lasts ≥ 0.7 s (${end - start} ms)`);
    assert.ok(end - start <= 7000, `cue ${idx + 1} lasts ≤ 7 s (${end - start} ms)`);
    assert.ok(lines.length >= 1 && lines.length <= 2, `cue ${idx + 1} has 1-2 lines`);
    for (const line of lines) {
      assert.ok(line.trim(), `cue ${idx + 1} has no empty line`);
      const visible = kind === 'vtt'
        ? line.replace(/^<v [^>]+>/, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
        : line;
      assert.ok(len(visible) <= 42, `cue ${idx + 1} line ≤ 42 chars: «${visible}»`);
      if (kind === 'srt') assert.ok(!line.includes('-->'), 'no arrow inside an SRT cue');
    }
    prevEnd = end;
  });
  return blocks.length;
}

// ── golden: small, with speakers, a gap and hallucinations ──────────────────

test('golden pack: speakers, low confidence, hallucinations and a gap', () => {
  const pack = fmt.buildTranscriptPack(SMALL, { fileName: 'clase-biologia.mp4', now: NOW });
  assert.equal(pack.txt, GOLDEN_SMALL_TXT);
  assert.equal(pack.srt, GOLDEN_SMALL_SRT);
  assert.equal(pack.vtt, GOLDEN_SMALL_VTT);
  assert.equal(pack.md, GOLDEN_SMALL_MD);
  assert.deepEqual(pack.stats, {
    words: 47,
    durationSec: 64,
    language: 'es',
    languageName: 'español',
    coverage: 0.90625,
    speakers: 2,
    segments: 5,
    paragraphs: 4,
    gaps: 1,
    partial: true,
    legacy: false,
    lowConfidence: 1,
    cleanup: { input: 7, kept: 5, empty: 0, hallucinations: 2, repeats: 0, loops: 0, removed: 2 },
  });
  assertValidSubtitles(pack.srt, 'srt');
  assertValidSubtitles(pack.vtt, 'vtt');
});

test('the individual renderers match the pack', () => {
  assert.equal(fmt.renderText(SMALL, { fileName: 'clase-biologia.mp4', now: NOW }), GOLDEN_SMALL_TXT);
  assert.equal(fmt.renderSrt(SMALL), GOLDEN_SMALL_SRT);
  assert.equal(fmt.renderVtt(SMALL), GOLDEN_SMALL_VTT);
  assert.equal(fmt.renderMarkdown(SMALL, { fileName: 'clase-biologia.mp4', now: NOW }), GOLDEN_SMALL_MD);
  const only = fmt.buildTranscriptPack(SMALL, { fileName: 'x.mp4', formats: ['srt'], now: NOW });
  assert.equal(only.txt, null);
  assert.equal(only.vtt, null);
  assert.equal(only.md, null);
  assert.equal(only.srt, GOLDEN_SMALL_SRT);
});

test('golden body without speakers: no labels, [mm:ss] under one hour', () => {
  const result = {
    segments: [
      { start: 0.4, end: 3.1, text: 'Hola, ¿se escucha bien?' },
      { start: 3.3, end: 8.0, text: 'Hoy repasamos la unidad tres.' },
      { start: 11.0, end: 15.5, text: 'Empezamos por la definición.' },
    ],
  };
  assert.equal(
    fmt.renderText(result, { header: false }),
    '[00:00] Hola, ¿se escucha bien? Hoy repasamos la unidad tres.\n\n[00:11] Empezamos por la definición.\n',
  );
  // A single diarized speaker is not worth a label either.
  const single = { segments: result.segments.map((s) => ({ ...s, speaker: 'speaker_0' })) };
  assert.equal(fmt.renderText(single, { header: false }), fmt.renderText(result, { header: false }));
  // A renamed speaker (a real name) is always shown.
  const named = { segments: result.segments.map((s) => ({ ...s, speaker: 'Dra. Pérez' })) };
  assert.match(fmt.renderText(named, { header: false }), /^\[00:00\] Dra\. Pérez: Hola/);
});

// ── 3-hour synthetic transcript ─────────────────────────────────────────────

test('3-hour lecture with speakers: golden header, [hh:mm:ss] paragraphs, gap in place', () => {
  const result = threeHourLecture({ speakers: true });
  assert.equal(result.segments.length, 1665);
  const pack = fmt.buildTranscriptPack(result, { fileName: 'clase-5h.mp4', now: NOW });
  const lines = pack.txt.split('\n');
  assert.deepEqual(lines.slice(0, 13), [
    'TRANSCRIPCIÓN',
    '════════════════════════════════════════════════',
    'Archivo: clase-5h.mp4',
    'Duración: 3 h 00 min 05 s',
    'Idioma: español',
    'Motor: en la nube — Groq (16 tramos), OpenAI (2 tramos)',
    'Fecha: 15 de octubre de 2026',
    'Palabras: 19.167',
    'Cobertura: 94,4 % del audio',
    'Tramos sin transcribir: 01:20:00–01:30:00 (el motor no respondió)',
    'Hablantes: 2',
    '════════════════════════════════════════════════',
    '',
  ]);
  assert.equal(lines[13], '[00:00:00] Hablante 1: Síntesis clase gradiente entonces ejemplo oxígeno respiración célula gradiente proteína membrana gradiente, Importante la célula entonces transporte glucosa ribosoma célula, Examen membrana respiración célula glucosa energía la ribosoma ribosoma oxígeno glucosa oxígeno.');
  assert.match(lines[15], /^\[00:00:19\] Hablante 1: La proceso energía vamos/);

  const gapIdx = lines.indexOf('[01:20:00–01:30:00 · tramo sin transcribir]');
  assert.ok(gapIdx > 0, 'gap marker present');
  assert.match(lines[gapIdx - 2], /^\[01:19:50\] Hablante 1: /);
  assert.match(lines[gapIdx + 2], /^\[01:30:00\] Hablante 1: Importante estudiar ejemplo/);
  assert.match(lines[lines.length - 2], /^\[02:59:08\] Hablante 2: Clase la proceso enzima/);

  const paragraphs = lines.filter((l) => /^\[\d{2}:\d{2}:\d{2}\] /.test(l));
  assert.equal(paragraphs.length, pack.stats.paragraphs);
  for (const p of paragraphs) assert.match(p, /^\[\d{2}:\d{2}:\d{2}\] Hablante [12]: \S/);
  // Paragraph timestamps strictly increase.
  const toSec = (l) => { const [h, m, s] = l.slice(1, 9).split(':').map(Number); return h * 3600 + m * 60 + s; };
  for (let k = 1; k < paragraphs.length; k++) assert.ok(toSec(paragraphs[k]) > toSec(paragraphs[k - 1]));

  assert.deepEqual({ ...pack.stats, coverage: Math.round(pack.stats.coverage * 10000) / 10000 }, {
    words: 19167,
    durationSec: 10805,
    language: 'es',
    languageName: 'español',
    coverage: 0.9445,
    speakers: 2,
    segments: 1665,
    paragraphs: 306,
    gaps: 1,
    partial: true,
    legacy: false,
    lowConfidence: 0,
    cleanup: { input: 1665, kept: 1665, empty: 0, hallucinations: 0, repeats: 0, loops: 0, removed: 0 },
  });

  assert.equal(pack.srt.split('\n\n').slice(0, 3).join('\n\n'),
    '1\n00:00:00,000 --> 00:00:02,842\nHablante 1: Síntesis clase\ngradiente entonces ejemplo oxígeno\n\n'
    + '2\n00:00:02,842 --> 00:00:05,500\nrespiración célula gradiente\nproteína membrana gradiente,\n\n'
    + '3\n00:00:05,800 --> 00:00:12,000\nImportante la célula entonces\ntransporte glucosa ribosoma célula,');
  assert.equal(assertValidSubtitles(pack.srt, 'srt'), 2941);
  const vttCues = assertValidSubtitles(pack.vtt, 'vtt');
  assert.ok(vttCues >= 1665);
  for (const block of pack.vtt.slice(8).trimEnd().split('\n\n')) {
    assert.match(block.split('\n')[1], /^<v Hablante [12]>/, 'every VTT cue carries its voice');
  }
  // No cue falls inside the untranscribed hour-twenty gap.
  for (const block of pack.srt.trimEnd().split('\n\n')) {
    const [, timing] = block.split('\n');
    const m = /^(\d{2}):(\d{2}):(\d{2}),(\d{3})/.exec(timing);
    const start = clockMs(m[1], m[2], m[3], m[4]) / 1000;
    assert.ok(start < 4800 || start >= 5400, `cue at ${start}s is outside the gap`);
  }
});

test('3-hour lecture without speakers: paragraphs carry no label and the markdown is complete', () => {
  const result = threeHourLecture({ speakers: false });
  const body = fmt.renderText(result, { header: false });
  assert.ok(body.startsWith('[00:00:00] Síntesis clase gradiente'));
  assert.ok(!/Hablante/.test(body));
  assert.ok(body.includes('\n\n[01:20:00–01:30:00 · tramo sin transcribir]\n\n[01:30:00] Importante estudiar'));
  const md = fmt.renderMarkdown(result, {
    fileName: 'clase-5h.mp4',
    now: NOW,
    chapters: [{ start: 0, title: 'Introducción' }, { start: 3600, title: 'Respiración celular' }, { start: 7200, title: 'Repaso final' }],
  });
  assert.ok(md.startsWith('# Transcripción — clase-5h.mp4\n\n| Dato | Detalle |\n| --- | --- |\n'));
  assert.ok(md.includes('## Índice\n\n| N.º | Inicio | Capítulo |\n| --- | --- | --- |\n| 1 | 00:00:00 | Introducción |\n| 2 | 01:00:00 | Respiración celular |\n| 3 | 02:00:00 | Repaso final |\n'));
  assert.ok(md.includes('### Introducción\n\n**[00:00:00]** Síntesis clase'));
  // The chapter forces a paragraph break at (or right after) its start.
  assert.match(md, /### Respiración celular\n\n\*\*\[01:00:0\d\]\*\* /);
  // A segment starting up to 0.5 s before the chapter opens it.
  assert.match(md, /### Repaso final\n\n\*\*\[(?:01:59:59|02:00:0\d)\]\*\* /);
  assert.ok(md.includes('*[01:20:00–01:30:00 · tramo sin transcribir]*'));
  // Paragraphs are separated by blank lines so pandoc keeps one per paragraph.
  assert.ok(!/\n\*\*\[[^\n]+\n\*\*\[/.test(md));
});

// ── paragraphs ──────────────────────────────────────────────────────────────

test('buildParagraphs: breaks on pause, speaker change, gaps and the ~75 s limit', () => {
  const segs = [];
  // 20 contiguous 5 s segments without sentence ends: only the hard limit (90 s) breaks.
  for (let k = 0; k < 20; k++) segs.push({ start: k * 5, end: k * 5 + 5, text: `frase ${k} sin punto` });
  let paras = fmt.buildParagraphs(segs);
  assert.deepEqual(paras.map((p) => p.start), [0, 90]);
  // With sentence ends, the paragraph closes at the first one after ~60 s.
  const ended = segs.map((s, k) => ({ ...s, text: k % 4 === 3 ? 'fin de idea.' : 'sigue la idea' }));
  paras = fmt.buildParagraphs(ended);
  assert.deepEqual(paras.map((p) => p.start), [0, 60]);
  // Pause ≥ 1.5 s breaks; 1.4 s does not.
  paras = fmt.buildParagraphs([
    { start: 0, end: 2, text: 'uno' }, { start: 3.4, end: 5, text: 'dos' }, { start: 6.5, end: 8, text: 'tres' },
  ]);
  assert.deepEqual(paras.map((p) => p.text), ['uno dos', 'tres']);
  // Speaker change breaks even without a pause.
  paras = fmt.buildParagraphs([
    { start: 0, end: 2, text: 'pregunta', speaker: 'A' }, { start: 2, end: 4, text: 'respuesta', speaker: 'B' },
  ]);
  assert.equal(paras.length, 2);
  // A gap between two segments breaks the paragraph.
  paras = fmt.buildParagraphs([{ start: 0, end: 2, text: 'antes' }, { start: 2.5, end: 4, text: 'después' }], { gaps: [{ start: 2, end: 2.5 }] });
  assert.deepEqual(paras.map((p) => p.text), ['antes', 'después']);
  // pauseSec is configurable.
  paras = fmt.buildParagraphs([{ start: 0, end: 2, text: 'a' }, { start: 3, end: 4, text: 'b' }], { pauseSec: 0.5 });
  assert.equal(paras.length, 2);
});

test('timestamps switch to [hh:mm:ss] when the recording lasts an hour or more', () => {
  const short = { durationSec: 3599, segments: [{ start: 3500, end: 3505, text: 'casi una hora' }] };
  assert.equal(fmt.renderText(short, { header: false }), '[58:20] casi una hora\n');
  const long = { durationSec: 3600, segments: [{ start: 5, end: 9, text: 'inicio' }] };
  assert.equal(fmt.renderText(long, { header: false }), '[00:00:05] inicio\n');
  // Even without a declared duration, a segment past the hour switches the form.
  const late = { segments: [{ start: 1, end: 2, text: 'a' }, { start: 3700, end: 3702, text: 'b' }] };
  assert.equal(fmt.renderText(late, { header: false }), '[00:00:01] a\n\n[01:01:40] b\n');
});

// ── gaps ────────────────────────────────────────────────────────────────────

test('gaps: header lists each stretch with its reason, coverage, and markers in order', () => {
  const result = {
    durationSec: 7200,
    language: 'en',
    engine: 'local',
    segments: [
      { start: 0, end: 5, text: 'Welcome back.' },
      { start: 4790, end: 4799, text: 'Before the break.' },
      { start: 5410, end: 5418, text: 'After the break.' },
      { start: 7000, end: 7005, text: 'Last words.' },
    ],
    gaps: [{ start: 5400, end: 5405, reason: 'quota_exhausted' }, { start: 4800, end: 5401, reason: 'timeout' }, { start: 7100, end: 7200 }],
  };
  const txt = fmt.renderText(result, { fileName: 'lecture.m4a', now: NOW });
  assert.match(txt, /\nIdioma: inglés\n/);
  assert.match(txt, /\nMotor: local \(Whisper en el servidor\)\n/);
  assert.match(txt, /\nTramos sin transcribir: 01:20:00–01:30:05 \(tiempo agotado\); 01:58:20–02:00:00\n/);
  assert.match(txt, /\nCobertura: 90,2 % del audio\n/);
  const body = txt.split('════════════════════════════════════════════════\n\n')[1];
  assert.equal(body, '[00:00:00] Welcome back.\n\n[01:19:50] Before the break.\n\n[01:20:00–01:30:05 · tramo sin transcribir]\n\n[01:30:10] After the break.\n\n[01:56:40] Last words.\n\n[01:58:20–02:00:00 · tramo sin transcribir]\n');
  const pack = fmt.buildTranscriptPack({ ...result, coverage: 0.95 }, { now: NOW });
  assert.equal(pack.stats.coverage, 0.95, 'an explicit coverage wins over the computed one');
  assert.equal(pack.stats.partial, true);
  assert.match(pack.txt, /\nCobertura: 95 % del audio\n/);
  // No gaps: the header says so.
  const clean = fmt.renderText({ segments: [{ start: 0, end: 2, text: 'hola' }] }, { now: NOW });
  assert.match(clean, /\nTramos sin transcribir: ninguno\n/);
  assert.match(clean, /\nCobertura: 100 % del audio\n/);
});

// ── legacy text-only results ────────────────────────────────────────────────

test('legacy text-only result: engine header stripped, no fake timestamps', () => {
  const legacy = {
    ok: true,
    status: 'ready',
    method: 'local-whisper',
    model: 'base',
    language: 'es',
    text: 'Transcripción local — 87 caracteres, modelo: base, idioma: es\n---\nPrimera parte de la clase. Seguimos con la unidad.\n\nSegunda parte de la clase.',
  };
  const txt = fmt.renderText(legacy, { fileName: 'nota.ogg', now: NOW });
  assert.ok(!txt.includes('87 caracteres'));
  assert.match(txt, /\nMotor: local \(Whisper en el servidor\)\n/);
  assert.match(txt, /\nNota: Esta transcripción no tiene marcas de tiempo\.\n/);
  assert.ok(txt.endsWith('\n\nPrimera parte de la clase. Seguimos con la unidad.\n\nSegunda parte de la clase.\n'));
  assert.ok(!/\[\d{2}:\d{2}\]/.test(txt));
  assert.ok(!/Tramos sin transcribir/.test(txt));
  assert.equal(fmt.renderText(legacy, { header: false }), 'Primera parte de la clase. Seguimos con la unidad.\n\nSegunda parte de la clase.\n');
  // Without a duration there is nothing to time: no subtitles.
  assert.equal(fmt.renderSrt(legacy), '');
  assert.equal(fmt.renderVtt(legacy), '');
  const pack = fmt.buildTranscriptPack(legacy, { now: NOW });
  assert.equal(pack.stats.legacy, true);
  assert.equal(pack.stats.words, 14);
  assert.match(pack.md, /## Transcripción\n\nPrimera parte de la clase\. Seguimos con la unidad\.\n\nSegunda parte de la clase\.\n/);
  // A bare string is accepted too.
  assert.equal(fmt.renderText('Hola mundo.', { header: false }), 'Hola mundo.\n');
  // A failed result renders no transcript (never the placeholder text).
  const failed = { ok: false, status: 'failed', method: 'placeholder', text: 'Audio — x.mp3\nEstado: Transcripción no disponible.' };
  assert.equal(fmt.renderText(failed, { header: false }), '');
  assert.equal(fmt.renderSrt(failed), '');
});

test('legacy text with a known duration gets proportionally timed, valid subtitles', () => {
  const words = [];
  for (let k = 0; k < 400; k++) words.push(k % 12 === 11 ? 'palabra.' : 'palabra');
  const legacy = { ok: true, transcript: words.join(' '), durationSec: 240 };
  const srt = fmt.renderSrt(legacy);
  const cues = assertValidSubtitles(srt, 'srt');
  assert.ok(cues >= 35, `≥ 240/7 cues (${cues})`);
  assert.match(srt.trimEnd().split('\n\n').pop(), /--> 00:04:00,000\n/);
  // A long legacy block is re-paragraphed at sentence ends.
  const long = fmt.renderText({ text: Array.from({ length: 120 }, (_, k) => `Oración número ${k} de la clase.`).join(' ') }, { header: false });
  const paragraphs = long.trimEnd().split('\n\n');
  assert.ok(paragraphs.length > 3);
  for (const p of paragraphs) assert.ok(p.length <= 1500 && p.endsWith('.'));
});

// ── hallucination cleanup ───────────────────────────────────────────────────

test('cleanup removes engine hallucinations (positives)', () => {
  const { segments, cleanup } = fmt.cleanSegmentsDetailed([
    { start: 0, end: 3, text: 'Hola a todos.' },
    { start: 3, end: 5, text: 'Subtítulos realizados por la comunidad de Amara.org' },
    { start: 5, end: 9, text: 'Esto es real. Subtítulos por la comunidad de Amara.org' },
    { start: 9, end: 12, text: '¡Gracias por ver!' },
    { start: 12, end: 14, text: 'Suscríbete al canal.' },
    { start: 14, end: 16, text: 'Thank you for watching.' },
    { start: 16, end: 18, text: '[BLANK_AUDIO]' },
    { start: 18, end: 48, text: '¡Gracias!' },
    { start: 48, end: 49, text: 'Gracias.', confidence: 0.2 },
    { start: 49, end: 50, text: '   ' },
    { start: 50, end: 51, text: '...' },
    { start: 51, end: 55, text: 'Dale like y suscríbete.' },
    { start: 55, end: 58, text: 'Sottotitoli creati dalla comunità Amara.org' },
  ]);
  assert.deepEqual(segments.map((s) => s.text), ['Hola a todos.', 'Esto es real.']);
  // 9 invented fragments (one was a credit inside a kept segment), 11 segments dropped.
  assert.deepEqual(cleanup, { input: 13, kept: 2, empty: 3, hallucinations: 9, repeats: 0, loops: 0, removed: 11 });
});

test('cleanup collapses loops and repeats ≥ 3 (positives)', () => {
  const run = fmt.cleanSegmentsDetailed([
    { start: 0, end: 2, text: 'Vamos a empezar.' },
    { start: 2, end: 4, text: 'Y entonces.' },
    { start: 4, end: 6, text: 'Y entonces.' },
    { start: 6, end: 8, text: 'y entonces' },
    { start: 8, end: 10, text: 'Y entonces.' },
    { start: 10, end: 12, text: 'Sigamos.' },
  ]);
  assert.deepEqual(run.segments.map((s) => s.text), ['Vamos a empezar.', 'Y entonces.', 'Sigamos.']);
  assert.equal(run.cleanup.repeats, 3);

  const cycle = fmt.cleanSegments([
    { start: 0, end: 1, text: '¿Me oyen?' }, { start: 1, end: 2, text: 'Sí.' },
    { start: 2, end: 3, text: '¿Me oyen?' }, { start: 3, end: 4, text: 'Sí.' },
    { start: 4, end: 5, text: '¿Me oyen?' }, { start: 5, end: 6, text: 'Sí.' },
    { start: 6, end: 7, text: 'Bien, empecemos.' },
  ]);
  assert.deepEqual(cycle.map((s) => s.text), ['¿Me oyen?', 'Sí.', 'Bien, empecemos.']);

  const loop = fmt.cleanSegmentsDetailed([
    { start: 0, end: 30, text: 'Lo que vamos a ver hoy, lo que vamos a ver hoy, lo que vamos a ver hoy, lo que vamos a ver hoy.' },
    { start: 30, end: 40, text: 'la la la la la la la la' },
    { start: 40, end: 50, text: 'muy bien muy bien muy bien muy bien muy bien' },
  ]);
  assert.deepEqual(loop.segments.map((s) => s.text), ['Lo que vamos a ver hoy.', 'la', 'muy bien']);
  assert.equal(loop.cleanup.loops, 3);
  assert.equal(loop.cleanup.removed, 0, 'a looped segment is kept, only its loop collapses');
});

test('cleanup keeps legitimate speech (negatives)', () => {
  const input = [
    { start: 0, end: 2, text: 'Repitan conmigo.' },
    { start: 2, end: 4, text: 'La célula es la unidad de la vida.' },
    { start: 4, end: 6, text: 'La célula es la unidad de la vida.' },
    { start: 6, end: 6.8, text: '¡Gracias!' },
    { start: 7, end: 10, text: 'Muy bien, muy bien, muy bien.' },
    { start: 10, end: 12, text: 'No, no, no, eso no es así.' },
    { start: 12, end: 16, text: 'Les digo gracias por ver esto con atención, ahora seguimos.' },
    { start: 16, end: 18, text: '[Música]' },
    { start: 18, end: 20, text: 'Sí. Sí. Sí.' },
    { start: 20, end: 24, text: 'Suscríbete a la revista científica si te interesa el tema.' },
  ];
  const { segments, cleanup } = fmt.cleanSegmentsDetailed(input);
  assert.deepEqual(segments.map((s) => s.text), input.map((s) => s.text));
  assert.equal(cleanup.removed, 0);
  assert.equal(cleanup.loops, 0);
  // cleanSegments accepts the sidecar's compact shape and sorts by time.
  const compact = fmt.cleanSegments([{ s: 5, e: 6, t: 'segundo', spk: 0 }, { s: 1, e: 2, t: 'primero', conf: 0.9 }]);
  assert.deepEqual(compact, [{ start: 1, end: 2, text: 'primero', confidence: 0.9 }, { start: 5, end: 6, text: 'segundo', speaker: '0' }]);
});

test('low-confidence marker: in TXT/MD, documented in the header, never in subtitles', () => {
  // A percentage (35) is read as 0.35.
  const result = { segments: [{ start: 0, end: 3, text: 'Se oye bien.', confidence: 0.9 }, { start: 3, end: 6, text: 'mitocondria quizá', confidence: 0.39 }, { start: 6, end: 9, text: 'Seguimos.', confidence: 35 }] };
  const txt = fmt.renderText(result, { now: NOW });
  assert.match(txt, /Se oye bien\. mitocondria quizá \[\?\] Seguimos\. \[\?\]\n$/);
  assert.match(txt, /\nNota: \[\?\] marca fragmentos de baja confianza; conviene verificarlos con el audio\.\n/);
  assert.match(fmt.renderMarkdown(result, { now: NOW }), /\*\*\[00:00\]\*\* Se oye bien\. mitocondria quizá \[\?\] Seguimos\. \[\?\]\n/);
  assert.ok(!fmt.renderSrt(result).includes('[?]'));
  assert.ok(!fmt.renderVtt(result).includes('[?]'));
  // Confidence 0.4 is not low.
  assert.ok(!fmt.renderText({ segments: [{ start: 0, end: 1, text: 'ok', confidence: 0.4 }] }).includes('[?]'));
});

// ── subtitles: edge cases ───────────────────────────────────────────────────

test('subtitles honor norms on hard input: tiny, long, overlapping, long words, escaping', () => {
  const segments = [
    { start: 0, end: 0.2, text: 'Sí.', speaker: 'A' },
    { start: 0.2, end: 0.4, text: 'Claro.', speaker: 'A' },
    { start: 0.4, end: 0.5, text: 'Bueno.', speaker: 'B' },
    { start: 0.45, end: 40, text: 'Este segmento dura casi cuarenta segundos y tiene muchísimo texto para obligar a dividirlo en varios subtítulos legibles, porque ningún subtítulo puede durar más de siete segundos ni tener más de dos líneas de cuarenta y dos caracteres cada una, así que el formateador debe repartir el texto con cuidado.', speaker: 'B' },
    { start: 40, end: 42, text: 'https://ejemplo.com/una/ruta/larguisima/que/no/cabe/en/una/linea/de/subtitulo', speaker: 'A' },
    { start: 42, end: 45, text: 'Usa x < y && y > z --> fin', speaker: 'A' },
  ];
  const srt = fmt.renderSrt(segments);
  const vtt = fmt.renderVtt({ segments });
  assert.ok(assertValidSubtitles(srt, 'srt') >= 8);
  assert.ok(assertValidSubtitles(vtt, 'vtt') >= 8);
  assert.ok(srt.includes('x < y && y > z → fin'), 'SRT keeps text but never an arrow inside a cue');
  assert.ok(vtt.includes('x &lt; y &amp;&amp; y &gt; z --&gt; fin'), 'VTT escapes markup characters');
  assert.match(vtt, /<v Hablante 1>Sí\. Claro\.\n/);
  assert.match(srt, /\nHablante 2: Bueno\./);
  // Tiny cues of the same speaker merge instead of flashing.
  assert.ok(!/\n00:00:00,200 --> /.test(srt));
});

test('VTT has no voice tags and SRT no prefixes without speakers', () => {
  const plain = { segments: [{ start: 0, end: 2, text: 'Hola.' }, { start: 2, end: 4, text: 'Adiós.' }] };
  assert.equal(fmt.renderSrt(plain), '1\n00:00:00,000 --> 00:00:02,000\nHola.\n\n2\n00:00:02,000 --> 00:00:04,000\nAdiós.\n');
  assert.equal(fmt.renderVtt(plain), 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHola.\n\n00:00:02.000 --> 00:00:04.000\nAdiós.\n');
  assert.equal(fmt.renderSrt([]), '');
  assert.equal(fmt.renderVtt([]), '');
});

test('wrapCue balances two lines within 42 characters', () => {
  assert.deepEqual(fmt.wrapCue('corto'), ['corto']);
  assert.deepEqual(fmt.wrapCue('La mitocondria es la central energética de la célula.'), ['La mitocondria es la central', 'energética de la célula.']);
  assert.equal(fmt.wrapCue('a'.repeat(30) + ' ' + 'b'.repeat(30) + ' ' + 'c'.repeat(30)), null);
});

// ── markdown escaping ───────────────────────────────────────────────────────

test('markdown escapes syntax in transcript text but keeps names readable', () => {
  const result = { segments: [{ start: 0, end: 3, text: 'El *dato* [clave] cuesta $10 y 2^3 <b>' }] };
  const md = fmt.renderMarkdown(result, { fileName: 'clase_final|v2.mp4', now: NOW });
  assert.ok(md.startsWith('# Transcripción — clase_final|v2.mp4\n'));
  assert.match(md, /\| Archivo \| clase_final\/v2\.mp4 \|/);
  assert.match(md, /\*\*\[00:00\]\*\* El \\\*dato\\\* \\\[clave\\\] cuesta \\\$10 y 2\\\^3 \\<b\\>\n/);
  // Every table row has exactly the two columns document-service expects.
  for (const row of md.split('\n').filter((l) => l.startsWith('|'))) assert.equal(row.split('|').length, 4, row);
  // A chapter title with markup is escaped in the heading.
  const withChapter = fmt.renderMarkdown(result, { chapters: [{ start: 0, title: 'Tema #1: *intro*' }], now: NOW });
  assert.match(withChapter, /\n### Tema \\#1: \\\*intro\\\*\n/);
});

test('markdown keeps legacy paragraphs from turning into lists or table rows', () => {
  const md = fmt.renderMarkdown({ text: '- uno y dos\n\n1. primero\n\n| a | b |' }, { now: NOW });
  assert.ok(md.includes('\n\\- uno y dos\n\n1\\. primero\n\n\\| a | b |\n'));
});

test('regression: the timestamped body is still a transcript for the queue and RAG filters', () => {
  const { hasTranscript } = require('../src/services/media-transcription-queue');
  const { isAudioTranscriptionPlaceholder } = require('../src/services/rag-audio-placeholder-filter');
  const withGap = fmt.renderText(SMALL, { header: false });
  const withHeader = fmt.renderText(SMALL, { fileName: 'clase.mp4', now: NOW });
  for (const text of [withGap, withHeader, fmt.renderMarkdown(SMALL, { now: NOW })]) {
    assert.equal(hasTranscript({ processingStage: 'ready', extractedText: text }), true);
    assert.equal(isAudioTranscriptionPlaceholder(text), false);
  }
});

// ── slicing and ranges ──────────────────────────────────────────────────────

test('sliceSegments: overlap semantics at segment boundaries', () => {
  const segs = [
    { start: 0, end: 1795, text: 'antes' },
    { start: 1795, end: 1800, text: 'termina justo al inicio' },
    { start: 1798, end: 1803, text: 'cruza el inicio' },
    { start: 1803, end: 2690, text: 'dentro' },
    { start: 2695, end: 2705, text: 'cruza el final' },
    { start: 2700, end: 2710, text: 'empieza justo al final' },
  ];
  assert.deepEqual(fmt.sliceSegments(segs, { start: 1800, end: 2700 }).map((s) => s.text), ['cruza el inicio', 'dentro', 'cruza el final']);
  assert.deepEqual(fmt.sliceSegments(segs, { start: 2700 }).map((s) => s.text), ['cruza el final', 'empieza justo al final']);
  assert.deepEqual(fmt.sliceSegments(segs, { end: 1796 }).map((s) => s.text), ['antes', 'termina justo al inicio']);
  assert.equal(fmt.sliceSegments(segs, { start: 1800, end: 2700 })[0], segs[2], 'original objects and times are kept');
  // Compact sidecar segments slice the same way.
  assert.deepEqual(fmt.sliceSegments([{ s: 10, e: 20, t: 'x' }, { s: 30, e: 40, t: 'y' }], { start: 20, end: 30 }), []);
});

test('sliceResult: window header, clipped gaps, recomputed coverage, legacy refused', () => {
  const window = fmt.sliceResult(threeHourLecture({ speakers: false }), { start: 4500, end: 5700 });
  assert.equal(window.gaps.length, 1);
  assert.deepEqual(window.gaps[0], { start: 4800, end: 5400, reason: 'provider_failed' });
  assert.equal(window.coverage, 0.5);
  assert.ok(window.segments.every((s) => s.end > 4500 && s.start < 5700));
  const txt = fmt.renderText(window, { fileName: 'clase-5h.mp4', now: NOW });
  assert.match(txt, /\nTramo: 01:15:00–01:35:00\n/);
  assert.match(txt, /\nCobertura: 50 % del audio\n/);
  const body = txt.split('════════════════════════════════════════════════\n\n')[1];
  // The segment that crosses the window start is kept whole.
  assert.ok(body.startsWith('[01:14:56] Entonces importante célula'));
  for (const line of body.split('\n\n')) assert.match(line, /^\[01:(1[4-9]|2\d|3[0-4]):\d\d[\]–]/, line.slice(0, 30));
  // A window inside the gap shows the clipped gap only.
  const inGap = fmt.sliceResult(threeHourLecture(), { start: 4810, end: 4900 });
  assert.deepEqual(inGap.segments, []);
  assert.equal(inGap.coverage, 0);
  assert.equal(fmt.renderText(inGap, { header: false }), '[01:20:10–01:21:40 · tramo sin transcribir]\n');
  // A window with neither speech nor gap says so instead of rendering nothing.
  const silent = fmt.sliceResult({ segments: [{ start: 0, end: 5, text: 'a' }, { start: 60, end: 65, text: 'b' }] }, { start: 10, end: 50 });
  assert.match(fmt.renderText(silent, { now: NOW }), /\nTramo: 00:10–00:50\n[\s\S]*\n\n\(Sin voz transcrita en este tramo\.\)\n$/);
  assert.match(fmt.renderMarkdown(silent, { now: NOW }), /## Transcripción\n\n\*\(Sin voz transcrita en este tramo\.\)\*\n$/);
  assert.equal(fmt.renderText(silent, { header: false }), '', 'the RAG/extractedText form stays empty');
  assert.equal(fmt.sliceResult({ text: 'sin marcas' }, { start: 0, end: 10 }), null);
});

test('parseTimeRange: Spanish and English windows, hour-aware ends', () => {
  const cases = [
    ['transcribe del minuto 30 al 45', { start: 1800, end: 2700 }],
    ['del minuto 30 al minuto 45 por favor', { start: 1800, end: 2700 }],
    ['de 1:30:00 a 2:00:00', { start: 5400, end: 7200 }],
    ['del 60 al 1:20', { start: 3600, end: 4800 }],
    ['del minuto 60 al minuto 1:20', { start: 3600, end: 4800 }],
    ['de 1:30:00 al 2:00', { start: 5400, end: 7200 }],
    ['los primeros 10 minutos', { start: 0, end: 600 }],
    ['solo la primera media hora', { start: 0, end: 1800 }],
    ['la primera hora', { start: 0, end: 3600 }],
    ['la segunda hora', { start: 3600, end: 7200 }],
    ['del minuto 1.5 al 10', { start: 90, end: 600 }],
    ['del minuto 1,5 al 10', { start: 90, end: 600 }],
    ['entre el minuto 10 y el 20', { start: 600, end: 1200 }],
    ['desde el minuto 30 hasta el 45', { start: 1800, end: 2700 }],
    ['30:00-45:00', { start: 1800, end: 2700 }],
    ['1:30:00–2:00:00', { start: 5400, end: 7200 }],
    ['minuto 30-45', { start: 1800, end: 2700 }],
    ['de la hora 1 a la hora 2', { start: 3600, end: 7200 }],
    ['de 1h30 a 2h', { start: 5400, end: 7200 }],
    ['del segundo 30 al 90', { start: 30, end: 90 }],
    ['de 30 a 45 minutos', { start: 1800, end: 2700 }],
    ['del 30 al 45', { start: 1800, end: 2700 }],
    ['desde el minuto 30', { start: 1800, end: null }],
    ['a partir del minuto 90', { start: 5400, end: null }],
    ['hasta el minuto 10', { start: 0, end: 600 }],
    ['from minute 30 to 45', { start: 1800, end: 2700 }],
    ['between 1:30:00 and 2:00:00', { start: 5400, end: 7200 }],
    ['the first 10 minutes', { start: 0, end: 600 }],
  ];
  for (const [text, expected] of cases) assert.deepEqual(fmt.parseTimeRange(text), expected, text);
  assert.deepEqual(fmt.parseTimeRange('los últimos 10 minutos', { durationSec: 18000 }), { start: 17400, end: 18000 });
});

test('parseTimeRange: returns null when no time window is named', () => {
  for (const text of [
    'transcribe el video',
    'transcribe los audios del 1 al 10',
    'hazme un resumen de 2 a 3 minutos',
    'dame 5 a 10 ideas',
    'del 1 al 5 de los videos',
    'del capítulo 2 al 5',
    'entre las 10 y las 12',
    'del minuto 45 al 30',
    'los últimos 10 minutos',
    '',
    null,
  ]) {
    assert.equal(fmt.parseTimeRange(text), null, String(text));
  }
});

// ── labels ──────────────────────────────────────────────────────────────────

test('language names in Spanish and readable durations', () => {
  assert.equal(fmt.languageNameEs('es'), 'español');
  assert.equal(fmt.languageNameEs('es-PE'), 'español');
  assert.equal(fmt.languageNameEs('spanish'), 'español');
  assert.equal(fmt.languageNameEs('English'), 'inglés');
  assert.equal(fmt.languageNameEs('qu'), 'quechua');
  assert.equal(fmt.languageNameEs(null), 'no detectado');
  assert.equal(fmt.languageNameEs('auto'), 'no detectado');
  assert.equal(fmt.languageCode('Português'), 'pt');
  assert.equal(fmt.languageCode('klingon'), null);
  assert.equal(fmt.languageCode('pt-BR'), 'pt');
  assert.equal(fmt.formatDurationHuman(18000), '5 h 00 min 00 s');
  assert.equal(fmt.formatDurationHuman(2712), '45 min 12 s');
  assert.equal(fmt.formatDurationHuman(52), '52 s');
  assert.equal(fmt.formatClock(3723.9, true), '01:02:03');
  assert.equal(fmt.formatClock(83, false), '01:23');
});

test('sliceResult coverage only counts audio that exists: a range past the end of the recording is not «transcribed»', () => {
  const fiveHours = {
    ok: true,
    durationSec: 18000,
    segments: [{ start: 16800, end: 17000, text: 'Última pregunta de la clase.' }],
    gaps: [{ start: 17000, end: 18000, reason: 'provider_failed' }],
  };
  const range = fmt.parseTimeRange('transcribe del minuto 280 al 320');
  assert.deepEqual(range, { start: 16800, end: 19200 });
  const window = fmt.sliceResult(fiveHours, range);
  // 1200 s of audio exist in the window and 1000 s of them are a gap.
  assert.equal(Math.round(window.coverage * 1000) / 1000, 0.167);
  assert.match(fmt.renderText(window, { now: NOW }), /\nCobertura: 16,6 % del audio\n/);
  // An open range keeps using the recording's end.
  assert.equal(Math.round(fmt.sliceResult(fiveHours, { start: 16800 }).coverage * 1000) / 1000, 0.167);
});

test('a link clip keeps its own length and covers [offset, offset + duration] on the recording clock', () => {
  // «del minuto 60 al 90»: segments and gaps already on the recording clock.
  const clip = {
    ok: true,
    timeOffsetSec: 3600,
    durationSec: 1800,
    segments: [
      { start: 3600, end: 3700, text: 'Retomamos la clase en la hora uno.' },
      { start: 4800, end: 4900, text: 'Segunda parte del tramo.' },
    ],
    gaps: [{ start: 4200, end: 4500, reason: 'timeout' }],
  };
  const meta = fmt.normalizeTranscriptResult(clip);
  assert.equal(meta.timeOffsetSec, 3600);
  assert.equal(meta.durationSec, 1800);
  assert.equal(Math.round(meta.coverage * 1000) / 1000, 0.833, '300 s of 1800 s missing');
  // Without a declared length, the clip lasts from its offset to its last moment.
  assert.equal(fmt.normalizeTranscriptResult({ ...clip, durationSec: null }).durationSec, 1300);

  // «hasta el minuto 80»: the window starts where the clip starts.
  const head = fmt.sliceResult(clip, { start: 0, end: 4800 });
  assert.equal(Math.round(head.coverage * 1000) / 1000, 0.75, '300 s of the 1200 s that exist');
  assert.equal(head.timeOffsetSec, 3600);
  // A whole-clip window ends at offset + duration, not at the clip's length.
  assert.equal(Math.round(fmt.sliceResult(clip, { start: 0 }).coverage * 1000) / 1000, 0.833);
  // A clip whose offset was not forwarded is never squeezed into [0, 1800].
  const unforwarded = { ...clip, timeOffsetSec: undefined };
  assert.equal(fmt.sliceResult(unforwarded, { start: 4200, end: 4800 }).coverage, 0.5);

  const txt = fmt.renderText(clip, { fileName: 'tramo.mp4', now: NOW });
  assert.match(txt, /\nDuración: 30 min 00 s\n/);
  assert.match(txt, /\nTramo: 01:00:00–01:30:00\n/);
  assert.match(txt, /\n\[01:00:00\] Retomamos la clase en la hora uno\.\n/);
  assert.match(txt, /\n\[01:10:00–01:15:00 · tramo sin transcribir\]\n/);
});
