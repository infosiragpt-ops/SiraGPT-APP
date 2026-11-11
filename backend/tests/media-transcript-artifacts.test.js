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

test('audio the browser extracted from a short video still gets the automatic SRT/VTT of a video', async () => {
  const short = { language: 'es', durationSec: 300, segments: [{ start: 0, end: 300, text: 'Clase corta grabada con el teléfono.' }] };
  const extracted = row('clip', { originalName: 'clip.audio.ogg', mimeType: 'audio/ogg' });
  const asAudio = await artifacts.buildMediaTranscriptArtifacts({ rows: [extracted], transcripts: new Map([['clip', short]]),
    output: artifacts.resolveTranscriptOutput('transcribe'), userId: 'u1' });
  assert.deepEqual(asAudio.artifacts.map(a => a.format), ['txt'], 'a 5-minute audio gets its TXT only');
  const fromVideo = await artifacts.buildMediaTranscriptArtifacts({ rows: [extracted],
    transcripts: new Map([['clip', { ...short, sourceMedia: 'video' }]]),
    output: artifacts.resolveTranscriptOutput('transcribe'), userId: 'u1' });
  assert.deepEqual(fromVideo.artifacts.map(a => a.format), ['txt', 'srt', 'vtt']);
});

test('the files of an extracted video carry the video\'s name, not «.audio.ogg»', async () => {
  const short = { language: 'es', durationSec: 300, sourceMedia: 'video', sourceName: 'Clase 3 (final).mp4',
    segments: [{ start: 0, end: 300, text: 'Clase corta.' }] };
  const extractedRow = row('clip', { originalName: 'Clase 3 (final).audio.ogg', mimeType: 'audio/ogg' });
  const built = await artifacts.buildMediaTranscriptArtifacts({ rows: [extractedRow],
    transcripts: new Map([['clip', short]]), output: artifacts.resolveTranscriptOutput('transcribe'), userId: 'u1' });
  assert.deepEqual(built.artifacts.map(a => a.filename), ['Clase 3 (final) (transcripción).txt', 'Clase 3 (final) (transcripción).srt', 'Clase 3 (final) (transcripción).vtt']);
  assert.match(decode(built.artifacts[0]), /Clase 3 \(final\)\.mp4/);
  const preview = artifacts.buildTranscriptChatPreview({ rows: [extractedRow], transcripts: new Map([['clip', short]]), output: {} });
  assert.match(preview, /#### Clase 3 \(final\)\.mp4/);
  assert.doesNotMatch(preview, /audio\.ogg/);
});

test('audio extracted from a large WAV keeps its source name without turning into a video; Mistral is named cleanly', async () => {
  const shortAudio = { language: 'es', durationSec: 180, sourceMedia: 'audio', sourceName: 'Entrevista_fiscal.wav',
    quality: { level: 'alta', score: 0.96, enginesUsed: ['mistral:voxtral-mini-latest'], lowConfidence: [], notes: [] },
    segments: [{ start: 0, end: 180, text: 'Declaración grabada en WAV sin comprimir.' }] };
  const extractedWebm = row('wav1', { originalName: 'Entrevista_fiscal.audio.webm', mimeType: 'audio/webm' });
  const built = await artifacts.buildMediaTranscriptArtifacts({ rows: [extractedWebm],
    transcripts: new Map([['wav1', shortAudio]]), output: artifacts.resolveTranscriptOutput('transcribe'), userId: 'u1' });
  assert.deepEqual(built.artifacts.map(a => a.filename), ['Entrevista_fiscal (transcripción).txt']);
  assert.equal(artifacts.engineNameEs('mistral:voxtral-mini-latest'), 'Mistral');
  assert.match(artifacts.transcriptQualityReport(artifacts.transcriptResultFor(extractedWebm, shortAudio)).line, /motor: Mistral/);
});

test('PR3 batch ZIP: >= 5 files produces a structured ZIP with 00-INDICE.md, BOM 00-INDICE.csv, per-file txt/ and video srt/vtt/', async () => {
  const PizZip = require('pizzip');
  const readyRows = [
    row('c1', { originalName: 'Clase 1.mp4', mimeType: 'video/mp4' }),
    row('c2', { originalName: 'Clase 2.mp3', mimeType: 'audio/mpeg' }),
    row('c3', { originalName: 'Clase 3.audio.ogg', mimeType: 'audio/ogg' }),
    row('c4', { originalName: 'Clase 4.m4a', mimeType: 'audio/mp4' }),
    row('c5', { originalName: 'Clase 5.mp3', mimeType: 'audio/mpeg', processingError: 'Parcial: 1 tramo falló' }),
  ];
  const failedRow = { id: 'c6', originalName: 'Clase 6 dañada.mp4', mimeType: 'video/mp4', processingStage: 'failed',
    processingError: 'El archivo no tiene pista de audio.', extractedText: null };
  const transcripts = new Map([
    ['c1', lecture({ hours: 1 })],
    ['c2', { language: 'es', durationSec: 300, segments: [{ start: 0, end: 60, text: 'Segunda grabación.' }] }],
    ['c3', { language: 'es', durationSec: 400, sourceMedia: 'video', sourceName: 'Clase 3 real.mp4', segments: [{ start: 0, end: 80, text: 'Tercera en video.' }] }],
    ['c4', { language: 'en', durationSec: 240, segments: [{ start: 0, end: 50, text: 'Fourth recording in English.' }] }],
    ['c5', lecture({ hours: 1, gaps: [{ start: 600, end: 900, reason: 'timeout' }] })],
  ]);
  const built = await artifacts.buildMediaTranscriptArtifacts({
    rows: readyRows,
    allRows: [...readyRows, failedRow],
    transcripts,
    output: artifacts.resolveTranscriptOutput('transcribe'),
    userId: 'u1',
    createDocument: fakeDocument([]),
  });
  assert.deepEqual(built.artifacts.map(a => a.filename), [
    'Transcripciones (5 archivos).txt',
    'Transcripciones (5 archivos).docx',
    'Transcripciones (5 archivos).zip',
  ]);
  const zipArtifact = built.artifacts.find(a => a.format === 'zip');
  assert.equal(zipArtifact.mime, 'application/zip');
  const zip = new PizZip(Buffer.from(zipArtifact.base64, 'base64'));
  const names = Object.keys(zip.files).filter(k => !zip.files[k].dir).sort();
  assert.ok(names.includes('00-INDICE.md'));
  assert.ok(names.includes('00-INDICE.csv'));
  assert.ok(names.includes('txt/01 - Clase 1.txt'));
  assert.ok(names.includes('txt/03 - Clase 3 real.txt'), 'extracted video keeps its real name inside ZIP');
  assert.ok(names.includes('srt/01 - Clase 1.srt') && names.includes('vtt/01 - Clase 1.vtt'), 'videos get SRT/VTT inside the batch ZIP');
  assert.ok(names.includes('srt/03 - Clase 3 real.srt') && names.includes('vtt/03 - Clase 3 real.vtt'));
  assert.equal(names.some(n => n.startsWith('srt/02 -')), false, 'audio-only files omit subtitles unless asked');
  const csv = zip.file('00-INDICE.csv').asText();
  assert.equal(csv.startsWith('\uFEFFN,Archivo,Estado,'), true, 'UTF-8 BOM for Excel');
  assert.match(csv, /Clase 3 real\.mp4,Completo/);
  assert.match(csv, /Clase 5\.mp3,Parcial/);
  assert.match(csv, /Clase 6 dañada\.mp4,Con incidencia/);
  const indexMd = zip.file('00-INDICE.md').asText();
  assert.match(indexMd, /Índice de transcripciones \(6 archivos\)/);
  assert.match(indexMd, /Con incidencia:\*\* 1/);
});

test('explicit ZIP request, > 20 subtitle files preserved in ZIP, dual Word+PDF, and massive-batch document OOM guard', async () => {
  const PizZip = require('pizzip');
  const two = [row('u1a'), row('u1b')];
  const twoMap = new Map([['u1a', { language: 'es', durationSec: 120, segments: [{ start: 0, end: 20, text: 'Uno.' }] }],
    ['u1b', { language: 'es', durationSec: 120, segments: [{ start: 0, end: 20, text: 'Dos.' }] }]]);
  const dualDocs = [];
  const dualOut = artifacts.resolveTranscriptOutput('transcribe en Word y PDF y dámelo en un zip');
  assert.equal(dualOut.documentFormat, 'docx');
  assert.equal(dualOut.alsoPdf, true);
  assert.equal(dualOut.wantsZip, true);
  const dualBuilt = await artifacts.buildMediaTranscriptArtifacts({ rows: two, transcripts: twoMap, output: dualOut, userId: 'u1',
    createDocument: fakeDocument(dualDocs) });
  assert.deepEqual(dualBuilt.artifacts.map(a => a.format), ['txt', 'docx', 'pdf', 'zip']);

  // 25 files with explicit subtitle request: loose chat cards capped at 20, ZIP holds all 25 SRT + 25 VTT.
  const manyRows = Array.from({ length: 25 }, (_, i) => row(`v${i + 1}`, { originalName: `Sesion_${i + 1}.mp3`, mimeType: 'audio/mpeg' }));
  const manyMap = new Map(manyRows.map((r, i) => [r.id, { language: 'es', durationSec: 180, segments: [{ start: 0, end: 30, text: `Sesión número ${i + 1}.` }] }]));
  const manyDocs = [];
  const manyBuilt = await artifacts.buildMediaTranscriptArtifacts({
    rows: manyRows,
    transcripts: manyMap,
    output: artifacts.resolveTranscriptOutput('transcribe con subtítulos srt'),
    userId: 'u1',
    maxDocumentMarkdownChars: 1500,
    createDocument: fakeDocument(manyDocs),
  });
  assert.equal(manyBuilt.artifacts.filter(a => a.format === 'srt').length, 20, 'loose SRT attachments stay capped at 20');
  assert.match(manyBuilt.notes.join(' '), /paquete ZIP contiene los subtítulos SRT y VTT de los 25 archivos/);
  assert.match(manyBuilt.notes.join(' '), /Por la extensión del lote, el documento incluye el índice maestro/);
  assert.match(manyDocs[0].markdown, /Índice de transcripciones \(25 archivos\)/);
  const zip25 = new PizZip(Buffer.from(manyBuilt.artifacts.find(a => a.format === 'zip').base64, 'base64'));
  const srtInZip = Object.keys(zip25.files).filter(name => /^srt\/.*\.srt$/.test(name));
  const vttInZip = Object.keys(zip25.files).filter(name => /^vtt\/.*\.vtt$/.test(name));
  assert.equal(srtInZip.length, 25, 'every single file gets its SRT in the batch ZIP');
  assert.equal(vttInZip.length, 25, 'every single file gets its VTT in the batch ZIP');
});
