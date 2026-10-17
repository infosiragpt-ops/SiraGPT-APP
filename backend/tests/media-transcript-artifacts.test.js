'use strict';

// The deliverables of a media turn, built from the real formatter: what a
// user downloads after a 5-hour class (TXT/Word/SRT/VTT), ranges, the link
// clock and the bounded chat preview.
const test = require('node:test');
const assert = require('node:assert/strict');
const artifacts = require('../src/services/media-transcript-artifacts');

function lecture({ hours = 3, speakers = false, gaps = [] } = {}) {
  const segments = [];
  for (let t = 0; t < hours * 3600; t += 30) {
    segments.push({ start: t, end: t + 25, text: `Minuto ${Math.floor(t / 60)}: explicamos el tema número ${t}.`, ...(speakers ? { speaker: t % 120 === 0 ? 'Hablante 1' : 'Hablante 2' } : {}) });
  }
  return { language: 'es', durationSec: hours * 3600, coverage: gaps.length ? 0.95 : 1, gaps, partial: gaps.length > 0,
    providers: { local: 30 }, engine: 'local', segments };
}

const decode = (artifact) => Buffer.from(artifact.base64, 'base64').toString('utf8');
const row = (id, extra = {}) => ({ id, originalName: `${id}.mp4`, mimeType: 'video/mp4', processingStage: 'ready',
  extractedText: 'Texto de respaldo.', ...extra });
const fakeDocument = (calls) => async (userId, filename, markdown) => {
  calls.push({ userId, filename, markdown });
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mta-')), 'doc.bin');
  fs.writeFileSync(file, `DOC:${markdown.length}`);
  return { filePath: file };
};

test('a 3-hour class video gets TXT with a header, Word, SRT and VTT, named after the source', async () => {
  const docs = [];
  const built = await artifacts.buildMediaTranscriptArtifacts({ rows: [row('Clase 7')], transcripts: new Map([['Clase 7', lecture()]]),
    output: artifacts.resolveTranscriptOutput('transcribe este video'), userId: 'u1', createDocument: fakeDocument(docs) });
  assert.deepEqual(built.artifacts.map(a => a.filename), ['Clase 7 (transcripción).txt', 'Clase 7 (transcripción).docx',
    'Clase 7 (transcripción).srt', 'Clase 7 (transcripción).vtt']);
  const txt = decode(built.artifacts[0]);
  assert.match(txt, /Archivo/);
  assert.match(txt, /\[02:59:30\]/, 'hh:mm:ss for a recording over one hour');
  assert.match(decode(built.artifacts[3]), /^WEBVTT/);
  assert.match(decode(built.artifacts[2]), /^1\n00:00:00,000 --> /);
  assert.equal(docs.length, 1);
  assert.match(docs[0].markdown, /^# Transcripción — Clase 7/m);
});

test('a short voice note gets only its TXT; Word and subtitles appear when asked', async () => {
  const short = { language: 'es', durationSec: 40, segments: [{ start: 0, end: 40, text: 'Hola, te dejo este audio.' }] };
  const audio = row('nota', { originalName: 'nota.ogg', mimeType: 'audio/ogg' });
  const plain = await artifacts.buildMediaTranscriptArtifacts({ rows: [audio], transcripts: new Map([['nota', short]]),
    output: artifacts.resolveTranscriptOutput('transcribe el audio'), userId: 'u1' });
  assert.deepEqual(plain.artifacts.map(a => a.format), ['txt']);
  const docs = [];
  const asked = await artifacts.buildMediaTranscriptArtifacts({ rows: [audio], transcripts: new Map([['nota', short]]),
    output: artifacts.resolveTranscriptOutput('pásalo a word y hazme subtítulos srt'), userId: 'u1', createDocument: fakeDocument(docs) });
  assert.deepEqual(asked.artifacts.map(a => a.format), ['txt', 'docx', 'srt', 'vtt']);
});

test('«del minuto 30 al 45» slices every format to that window', async () => {
  const output = artifacts.resolveTranscriptOutput('transcribe del minuto 30 al 45 en word', { });
  assert.deepEqual(output.range, { start: 1800, end: 2700 });
  assert.equal(output.documentFormat, 'docx');
  const built = await artifacts.buildMediaTranscriptArtifacts({ rows: [row('clase')], transcripts: new Map([['clase', lecture({ hours: 1 })]]),
    output, userId: 'u1', createDocument: fakeDocument([]) });
  const txt = decode(built.artifacts.find(a => a.format === 'txt'));
  assert.match(built.artifacts[0].filename, /\(transcripción 30\.00–45\.00\)\.txt$/);
  assert.match(txt, /\[30:00\]|\[00:30:00\]/);
  assert.doesNotMatch(txt, /Minuto 10:/);
  assert.doesNotMatch(txt, /Minuto 50:/);
});

test('«desde el minuto 30» runs to the end of the recording', async () => {
  const output = artifacts.resolveTranscriptOutput('transcribe desde el minuto 30');
  assert.deepEqual(output.range, { start: 1800, end: null });
  const built = await artifacts.buildMediaTranscriptArtifacts({ rows: [row('clase')], transcripts: new Map([['clase', lecture({ hours: 1 })]]),
    output, userId: 'u1', createDocument: fakeDocument([]) });
  const txt = decode(built.artifacts[0]);
  assert.match(txt, /Minuto 59:/);
  assert.doesNotMatch(txt, /Minuto 29:/);
  assert.match(built.artifacts[0].filename, /desde 30\.00/);
});

test('a link clip keeps the recording clock (offset) in every format', async () => {
  const clip = { language: 'es', durationSec: 1200, segments: [{ start: 0, end: 10, text: 'Empieza el tramo.' }, { start: 600, end: 610, text: 'Mitad del tramo.' }] };
  const built = await artifacts.buildMediaTranscriptArtifacts({ rows: [row('tramo', { mimeType: 'audio/mp4', originalName: 'tramo.m4a' })],
    transcripts: new Map([['tramo', clip]]), output: { timeOffsetSec: 3600, wantsSubtitles: true }, userId: 'u1', createDocument: fakeDocument([]) });
  const txt = decode(built.artifacts.find(a => a.format === 'txt'));
  assert.match(txt, /\[01:00:00\][^\n]*Empieza el tramo/);
  assert.match(txt, /\[01:10:00\][^\n]*Mitad del tramo/);
  assert.match(decode(built.artifacts.find(a => a.format === 'srt')), /01:00:00,000 -->/);
});

test('a batch: one combined TXT, subtitles per file only when asked, gaps honest', async () => {
  const rows = [row('a'), row('b', { originalName: 'b.mp3', mimeType: 'audio/mpeg' })];
  const transcripts = new Map([['a', lecture({ hours: 1, gaps: [{ start: 1200, end: 1800, reason: 'all_providers_failed' }] })], ['b', lecture({ hours: 1 })]]);
  const built = await artifacts.buildMediaTranscriptArtifacts({ rows, transcripts, output: artifacts.resolveTranscriptOutput('transcribe'),
    userId: 'u1', createDocument: fakeDocument([]) });
  assert.deepEqual(built.artifacts.map(a => a.filename), ['Transcripciones (2 archivos).txt', 'Transcripciones (2 archivos).docx']);
  const txt = decode(built.artifacts[0]);
  assert.match(txt, /1\. a\.mp4/);
  assert.match(txt, /2\. b\.mp3/);
  assert.match(txt, /20:00[^\n]*30:00|00:20:00[^\n]*00:30:00/, 'the gap is marked with its times');
  const subs = await artifacts.buildMediaTranscriptArtifacts({ rows, transcripts, output: artifacts.resolveTranscriptOutput('hazme subtítulos srt'), userId: 'u1', createDocument: fakeDocument([]) });
  assert.deepEqual(subs.artifacts.filter(a => a.format === 'srt').map(a => a.filename), ['a (transcripción).srt', 'b (transcripción).srt']);
});

test('a legacy transcript (no sidecar) still delivers its text, and a range says it cannot be cut', async () => {
  const built = await artifacts.buildMediaTranscriptArtifacts({ rows: [row('viejo', { extractedText: 'Texto completo antiguo sin tiempos.' })],
    transcripts: new Map([['viejo', null]]), output: artifacts.resolveTranscriptOutput('del minuto 1 al 2'), userId: 'u1' });
  assert.equal(built.artifacts.length, 1);
  assert.match(decode(built.artifacts[0]), /Texto completo antiguo sin tiempos/);
  assert.match(built.notes.join(' '), /no tiene marcas de tiempo/);
});

test('a failed Word render never loses the TXT and is reported', async () => {
  const built = await artifacts.buildMediaTranscriptArtifacts({ rows: [row('clase')], transcripts: new Map([['clase', lecture({ hours: 1 })]]),
    output: { documentFormat: 'docx' }, userId: 'u1', logger: { warn() {} },
    createDocument: async () => { throw new Error('pandoc crashed'); } });
  assert.ok(built.artifacts.some(a => a.format === 'txt'));
  assert.ok(!built.artifacts.some(a => a.format === 'docx'));
  assert.match(built.notes.join(' '), /No pude generar el Word/);
});

test('the chat preview of a 5-hour class is a summary line plus the first minutes, never the whole text', () => {
  const preview = artifacts.buildTranscriptChatPreview({ rows: [row('clase')], transcripts: new Map([['clase', lecture({ hours: 5 })]]), output: {} });
  assert.ok(preview.length < 6000, `bounded: ${preview.length}`);
  assert.match(preview, /5 h/);
  assert.match(preview, /español/);
  assert.match(preview, /Vista previa/);
  const short = artifacts.buildTranscriptChatPreview({ rows: [row('nota', { extractedText: 'Hola.' })], transcripts: new Map([['nota', { durationSec: 5, segments: [{ start: 0, end: 5, text: 'Hola.' }] }]]), output: {} });
  assert.doesNotMatch(short, /Vista previa/);
  assert.match(short, /Hola\./);
});

test('translation deliverables: TXT always, Word for long texts, named after the source', async () => {
  const docs = [];
  const built = await artifacts.buildTranslationArtifacts({ files: [{ id: 'clase', name: 'Clase 7.mp4', text: 'Hello. '.repeat(4000) }],
    target: { code: 'en', name: 'inglés' }, output: {}, userId: 'u1', createDocument: fakeDocument(docs) });
  assert.deepEqual(built.artifacts.map(a => a.filename), ['Clase 7 (traducción al inglés).txt', 'Clase 7 (traducción al inglés).docx']);
  const small = await artifacts.buildTranslationArtifacts({ files: [{ id: 'n', name: 'nota.ogg', text: 'Hello.' }], target: { code: 'en', name: 'inglés' }, userId: 'u1' });
  assert.deepEqual(small.artifacts.map(a => a.format), ['txt']);
});

test('two overlapping Word renders with the same deliverable name never read or delete each other\'s file', async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mta-shared-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const names = [];
  // Like document-service: one folder per user, the (sanitized) name is the path.
  const sharedFolder = async (userId, filename, markdown) => {
    names.push(filename);
    const filePath = path.join(dir, filename.replace(/[^a-zA-Z0-9_.-]/g, '_'));
    await fs.promises.writeFile(filePath, markdown);
    await new Promise(resolve => setTimeout(resolve, 20));
    return { filePath };
  };
  const recording = (id, words) => ({ row: row(id, { originalName: 'Nueva grabación.m4a', mimeType: 'audio/mp4' }),
    transcript: { language: 'es', durationSec: 900, segments: [{ start: 0, end: 900, text: words }] } });
  const one = recording('r1', 'Primera grabación sobre mitocondrias.');
  const two = recording('r2', 'Segunda grabación sobre fotosíntesis.');
  const build = ({ row: r, transcript }) => artifacts.buildMediaTranscriptArtifacts({ rows: [r], transcripts: new Map([[r.id, transcript]]),
    output: { documentFormat: 'docx' }, userId: 'u1', createDocument: sharedFolder, logger: { warn() {} } });
  const [first, second] = await Promise.all([build(one), build(two)]);
  const docOf = built => decode(built.artifacts.find(a => a.format === 'docx'));
  assert.equal(first.artifacts.find(a => a.format === 'docx').filename, 'Nueva grabación (transcripción).docx', 'friendly name on the artifact');
  assert.match(docOf(first), /mitocondrias/);
  assert.doesNotMatch(docOf(first), /fotosíntesis/);
  assert.match(docOf(second), /fotosíntesis/);
  assert.equal(new Set(names).size, 2, 'unique working names');
  assert.deepEqual(fs.readdirSync(dir), [], 'working copies removed');
});

test('a transcript stored already on the recording clock is not shifted again by the clip offset', async () => {
  const stored = { language: 'es', durationSec: 1200, timeOffsetSec: 3600,
    segments: [{ start: 3600, end: 3610, text: 'Empieza el tramo.' }, { start: 4200, end: 4210, text: 'Mitad del tramo.' }] };
  const clip = row('tramo', { mimeType: 'audio/mp4', originalName: 'tramo.m4a' });
  for (const output of [{ timeOffsetSec: 3600, wantsSubtitles: true }, { wantsSubtitles: true }]) {
    const built = await artifacts.buildMediaTranscriptArtifacts({ rows: [clip], transcripts: new Map([['tramo', stored]]),
      output, userId: 'u1', createDocument: fakeDocument([]) });
    const txt = decode(built.artifacts.find(a => a.format === 'txt'));
    assert.match(txt, /\[01:00:00\][^\n]*Empieza el tramo/, JSON.stringify(output));
    assert.match(txt, /\[01:10:00\][^\n]*Mitad del tramo/);
    assert.doesNotMatch(txt, /02:00:00|02:10:00/);
  }
  assert.equal(artifacts.clockOffsetFor(stored, { timeOffsetSec: 3600 }), 0);
  assert.equal(artifacts.clockOffsetFor({ durationSec: 1200 }, { timeOffsetSec: 3600 }), 3600);
  // Same shape either way: durationSec is the clip's length, timeOffsetSec marks the shift.
  const fresh = artifacts.transcriptView(clip, { language: 'es', durationSec: 1200, segments: stored.segments.map(s => ({ ...s, start: s.start - 3600, end: s.end - 3600 })) },
    { timeOffsetSec: 3600 });
  const kept = artifacts.transcriptView(clip, stored, { timeOffsetSec: 3600 });
  for (const view of [fresh, kept]) {
    assert.equal(view.result.durationSec, 1200);
    assert.equal(view.result.timeOffsetSec, 3600);
    assert.equal(view.result.segments[0].start, 3600);
    // The audio the clip holds, on the recording clock (a window outside it has nothing to show).
    assert.deepEqual(view.span, { start: 3600, end: 4800 });
  }
  assert.deepEqual(artifacts.audioSpanOf({ segments: [], gaps: [] }), { start: 0, end: null });
  assert.deepEqual(artifacts.audioSpanOf({ durationSec: 100, segments: [{ start: 0, end: 130 }], gaps: [{ start: 130, end: 160 }] }), { start: 0, end: 160 });
  assert.equal(fresh.shifted, true);
  assert.equal(kept.shifted, false);
});
