'use strict';

// Contract C7 — platform captions for links. They are a glossary for the
// recogniser and the fallback when no voice is recognised; they replace ASR
// only when they are human captions in the audio's language, cover ≥ 90 % of
// the range and agree with a sample of the audio (a translated, partial or
// shifted track fails one of the checks). Offline: fake yt-dlp / ffmpeg /
// transcriber.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tool = require('../src/services/agent-harness/tools/transcribe-url-tool');

const URL = 'https://www.youtube.com/watch?v=clase';

function clock(seconds) {
  const s = Math.max(0, seconds);
  const two = n => String(Math.floor(n)).padStart(2, '0');
  return `${two(s / 3600)}:${two((s % 3600) / 60)}:${two(s % 60)}.${String(Math.round((s % 1) * 1000)).padStart(3, '0')}`;
}

/** A WebVTT track: one cue every 5 s from `from` to `to`. */
function vtt({ from = 0, to = 600, text = i => `Frase ${i} sobre la fotosíntesis y la clorofila en la hoja` } = {}) {
  const cues = ['WEBVTT', 'Kind: captions', 'Language: es', ''];
  for (let t = from, i = 0; t < to; t += 5, i++) cues.push(`${clock(t)} --> ${clock(t + 4.5)} align:start position:0%`, text(i), '');
  return cues.join('\n');
}

function setup({ info = {}, captionFiles = {}, asr = null, spot = null, env = {} } = {}) {
  const calls = [];
  const transcribed = [];
  const runCommand = async (bin, args, { cwd } = {}) => {
    calls.push({ bin, args });
    if (bin === 'yt-dlp' && args.includes('--dump-single-json')) return { code: 0, stdout: JSON.stringify({ duration: 600, title: 'Clase de Fotosíntesis con la Dra. Pérez', ...info }), stderr: '' };
    if (bin === 'yt-dlp' && args.includes('--write-subs')) {
      for (const [name, text] of Object.entries(captionFiles)) fs.writeFileSync(path.join(cwd, name), text);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (bin === 'yt-dlp') { fs.writeFileSync(path.join(cwd, 'source.webm'), 'audio'); return { code: 0, stdout: '', stderr: '' }; }
    if (bin === 'ffmpeg') { fs.writeFileSync(args[args.length - 1], 'aac'); return { code: 0, stdout: '', stderr: '' }; }
    throw new Error(`unexpected ${bin}`);
  };
  const saved = [];
  const deps = {
    runCommand, dnsCheck: async () => true, tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tuc-')),
    env: { TRANSCRIBE_URL_MAX_SECONDS: '3600', TRANSCRIBE_URL_DURABLE: '0', ...env },
    discoverMedia: async () => ({ ok: false, reason: 'no_media_found', candidates: [], loginWall: false }),
    cookieJar: { save: async () => ({ hosts: [] }), load: async () => null }, loadAttachedCookies: async () => null,
    computer: null, capture: null,
    transcribe: async (filePath, mime, name, opts) => {
      transcribed.push({ name, opts });
      if (name === 'muestra.m4a') {
        return spot || { ok: true, language: 'es', segments: [{ start: 0, end: 30, text: 'frase sobre la fotosíntesis y la clorofila en la hoja verde' }] };
      }
      return asr || { ok: true, method: 'local-whisper', language: 'es', transcript: 'Texto del reconocedor.',
        segments: [{ start: 0, end: 3, text: 'Texto del reconocedor.' }, { start: 4, end: 8, text: 'Segunda frase.' }] };
    },
    saveArtifact: (input) => { saved.push(input); return { id: `a${saved.length}`, filename: input.filename, mime: input.mime, format: 'txt', sizeBytes: 1, downloadUrl: '/a' }; },
  };
  return { deps, calls, transcribed, saved };
}

test('verified human captions in the audio language replace ASR (only a 60 s sample is transcribed)', async () => {
  const s = setup({ info: { language: 'es', subtitles: { es: [{ ext: 'vtt' }] } }, captionFiles: { 'captions.es.vtt': vtt() } });
  const res = await tool.executeTranscribeUrl({ url: URL, subtitles: true }, { userId: 'u1' }, s.deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.method, 'platform_captions');
  assert.equal(res.captions.kind, 'manual');
  assert.equal(res.captions.language, 'es');
  assert.ok(res.captions.coverage >= 0.9);
  assert.ok(res.captions.agreement >= 0.5);
  assert.deepEqual(s.transcribed.map(t => t.name), ['muestra.m4a'], 'no full ASR when the captions pass');
  assert.match(res.text, /usé los subtítulos que publicó la plataforma \(español\)/);
  assert.match(res.text, /\n\[00:00\] Frase 0 sobre la fotosíntesis/);
  assert.match(res.text, /\n\[00:30\] Frase 6 sobre la fotosíntesis/, 'the captions keep the recording clock');
  assert.equal(s.saved.length, 2, 'TXT and the requested SRT');
  const captionCall = s.calls.find(c => c.args.includes('--write-subs'));
  assert.ok(captionCall.args.includes('--skip-download') && captionCall.args.includes('--write-auto-subs'));
  assert.equal(captionCall.args[captionCall.args.indexOf('--sub-langs') + 1], 'es,es-.*');
  const probe = s.calls.find(c => c.args.includes('--dump-single-json'));
  assert.equal(probe.args[probe.args.indexOf('--extractor-args') + 1], 'youtube:skip=translated_subs', 'the 2 MB probe fix');
});

test('a translated, partial or disagreeing track never replaces ASR; its names still prime the recogniser', async () => {
  // Translation: the only human track is English, the audio is Spanish.
  const translated = setup({ info: { language: 'es', subtitles: { en: [{ ext: 'vtt' }] } }, captionFiles: { 'captions.en.vtt': vtt({ text: i => `Sentence ${i} about Photosynthesis in the Leaf` }) } });
  const a = await tool.executeTranscribeUrl({ url: URL }, {}, translated.deps);
  assert.equal(a.method, 'local-whisper');
  assert.equal(a.captionCheck.reason, 'language_mismatch');
  // Partial: the human track covers only the first third.
  const partial = setup({ info: { language: 'es', subtitles: { es: [{ ext: 'vtt' }] } }, captionFiles: { 'captions.es.vtt': vtt({ to: 200 }) } });
  const b = await tool.executeTranscribeUrl({ url: URL }, {}, partial.deps);
  assert.equal(b.method, 'local-whisper');
  assert.equal(b.captionCheck.reason, 'low_coverage');
  // Shifted / wrong: the sample of the audio says something else.
  const wrong = setup({ info: { language: 'es', subtitles: { es: [{ ext: 'vtt' }] } }, captionFiles: { 'captions.es.vtt': vtt() },
    spot: { ok: true, language: 'es', segments: [{ start: 0, end: 30, text: 'hoy hablamos del mercado de valores y la inflación anual' }] } });
  const c = await tool.executeTranscribeUrl({ url: URL }, {}, wrong.deps);
  assert.equal(c.method, 'local-whisper');
  assert.equal(c.captionCheck.reason, 'spot_disagrees');
  const full = wrong.transcribed.find(t => t.name !== 'muestra.m4a');
  assert.ok(full.opts.hints.terms.includes('Fotosíntesis'), 'title terms keep their accents');
  assert.ok(full.opts.hints.terms.includes('Pérez'));
});

test('no voice recognised: the platform captions are delivered with an honest note instead of a failure', async () => {
  const s = setup({ info: { language: 'es', automatic_captions: { 'es-orig': [{ ext: 'vtt' }] } },
    captionFiles: { 'captions.es-orig.vtt': vtt() }, asr: { ok: false, status: 'no_speech', reasonCode: 'no_speech' } });
  const res = await tool.executeTranscribeUrl({ url: URL }, {}, s.deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.fallback, true);
  assert.equal(res.asrFailure, 'no_speech');
  assert.equal(res.captions.kind, 'auto');
  assert.match(res.text, /^Nota: no pude reconocer la voz del audio; esto son los subtítulos automáticos de la plataforma \(español\), que pueden tener errores\./);
  // Without captions the same failure stays an honest error.
  const bare = setup({ asr: { ok: false, status: 'no_speech' } });
  const err = await tool.executeTranscribeUrl({ url: URL }, {}, bare.deps);
  assert.equal(err.code, 'transcription_failed');
  assert.equal(err.noSpeech, true);
  assert.equal(bare.calls.some(c => c.args.includes('--write-subs')), false, 'no caption call when the platform lists none');
});

test('the kill switch skips the platform captions', async () => {
  const s = setup({ info: { language: 'es', subtitles: { es: [{ ext: 'vtt' }] } }, captionFiles: { 'captions.es.vtt': vtt() },
    env: { TRANSCRIBE_URL_PLATFORM_CAPTIONS: '0' } });
  const res = await tool.executeTranscribeUrl({ url: URL }, {}, s.deps);
  assert.equal(res.method, 'local-whisper');
  assert.equal(s.calls.some(c => c.args.includes('--write-subs')), false);
});

test('caption parsing: rolling automatic captions, SRT, inline word timings; coverage tolerates short pauses', () => {
  const rolling = [
    'WEBVTT', '',
    '00:00:01.000 --> 00:00:03.000 align:start position:0%', 'hola<00:00:01.500><c> a</c><00:00:02.000><c> todos</c>', '',
    '00:00:03.000 --> 00:00:03.010', 'hola a todos', '',
    '00:00:03.010 --> 00:00:06.000', 'hola a todos', 'hoy vemos la célula', '',
  ].join('\n');
  assert.deepEqual(tool.parseCaptionText(rolling), [
    { start: 1, end: 3, text: 'hola a todos' },
    { start: 3.01, end: 6, text: 'hoy vemos la célula' },
  ]);
  const srt = '1\n00:00:02,000 --> 00:00:04,500\n<i>Buenos días</i>\n\n2\n00:01:00,000 --> 00:01:02,000\nAdiós\n';
  assert.deepEqual(tool.parseCaptionText(srt), [{ start: 2, end: 4.5, text: 'Buenos días' }, { start: 60, end: 62, text: 'Adiós' }]);
  const cues = [{ start: 0, end: 4, text: 'a' }, { start: 6, end: 10, text: 'b' }];
  assert.equal(tool.captionCoverage(cues, 0, 10), 1, 'a 2 s pause is covered');
  assert.ok(tool.captionCoverage([{ start: 0, end: 10, text: 'a' }], 0, 100) < 0.2);
  assert.deepEqual(tool.captionBasesToFetch(tool.listCaptionTracks({ language: 'es', subtitles: { en: [], es: [] }, automatic_captions: { 'es-orig': [] } }), null), ['es', 'en']);
  assert.deepEqual(tool.captionTerms([{ text: 'Hoy el profesor Quispe habla de Ayacucho y de Ayacucho otra vez' }]), ['Ayacucho', 'Quispe']);
});

// ── verifier fixes: per-key kinds, bounded spot check, captions kept for the queue ──

test('a caption file is human only when ITS key is a human track (es-419 vs es, en vs en-orig)', async () => {
  const latam = tool.listCaptionTracks({ language: 'es', subtitles: { 'es-419': [] }, automatic_captions: { es: [], 'es-orig': [] } });
  assert.equal(tool.captionKindFor(latam, 'es-419'), 'manual');
  assert.equal(tool.captionKindFor(latam, 'es'), 'auto');
  assert.equal(tool.captionKindFor(latam, 'es-orig'), 'auto');
  const english = tool.listCaptionTracks({ language: 'en', subtitles: { en: [] }, automatic_captions: { 'en-orig': [] } });
  assert.equal(tool.captionKindFor(english, 'en'), 'manual');
  assert.equal(tool.captionKindFor(english, 'en-orig'), 'auto');
  // No voice and only the automatic «es» file was written: it is labelled automatic.
  const s = setup({ info: { language: 'es', subtitles: { 'es-419': [{ ext: 'vtt' }] }, automatic_captions: { es: [{ ext: 'vtt' }] } },
    captionFiles: { 'captions.es.vtt': vtt() }, asr: { ok: false, status: 'no_speech', reasonCode: 'no_speech' } });
  const res = await tool.executeTranscribeUrl({ url: URL }, {}, s.deps);
  assert.equal(res.captions.kind, 'auto');
  assert.match(res.text, /subtítulos automáticos de la plataforma \(español\), que pueden tener errores/);
  // A human «en» track that covers a third never lets the automatic «en-orig» one replace ASR.
  const mixed = setup({ info: { language: 'en', subtitles: { en: [{ ext: 'vtt' }] }, automatic_captions: { 'en-orig': [{ ext: 'vtt' }] } },
    captionFiles: { 'captions.en.vtt': vtt({ to: 200, text: i => `Sentence ${i} about photosynthesis and chlorophyll in the leaf` }),
      'captions.en-orig.vtt': vtt({ text: i => `Sentence ${i} about photosynthesis and chlorophyll in the leaf` }) },
    spot: { ok: true, language: 'en', segments: [{ start: 0, end: 30, text: 'sentence about photosynthesis and chlorophyll in the leaf' }] } });
  const b = await tool.executeTranscribeUrl({ url: URL }, {}, mixed.deps);
  assert.equal(b.method, 'local-whisper', 'automatic captions never replace ASR');
  assert.equal(b.captionCheck.reason, 'low_coverage');
});

test('a spot check that cannot get a transcription slot times out and the long link is still handed off', async () => {
  const handed = [];
  const s = setup({ info: { duration: 1800, language: 'es', subtitles: { es: [{ ext: 'vtt' }] } }, captionFiles: { 'captions.es.vtt': vtt({ to: 1800 }) },
    env: { TRANSCRIBE_URL_DURABLE: '1', TRANSCRIBE_URL_CAPTION_SPOT_TIMEOUT_MS: '60' } });
  const sampleCalls = [];
  const fullTranscribe = s.deps.transcribe;
  s.deps.transcribe = async (filePath, mime, name, opts) => {
    if (name === 'muestra.m4a') { sampleCalls.push(opts); return new Promise(() => {}); } // never resolves, ignores the signal
    return fullTranscribe(filePath, mime, name, opts);
  };
  s.deps.durableHandoff = async (payload) => { handed.push(payload); return { ok: true, fileId: 'f1', deliveryId: 'md_1', message: 'Te aviso aquí.' }; };
  const started = Date.now();
  // The deadline timer is unref'd (a server keeps the loop alive); keep it alive here.
  const keepAlive = setInterval(() => {}, 1000);
  let res;
  try { res = await tool.executeTranscribeUrl({ url: URL }, { userId: 'u1', chatId: 'c1' }, s.deps); } finally { clearInterval(keepAlive); }
  assert.ok(Date.now() - started < 5000, 'bounded by the spot deadline, not the tool timeout');
  assert.equal(res.deferred, true, JSON.stringify(res));
  assert.equal(res.captionCheck.reason, 'spot_timeout');
  assert.equal(sampleCalls[0].lane, 'interactive', 'the sample rides the interactive admission lane');
  // The unverified human track travels with the job for the queue's fallback.
  assert.equal(handed[0].captions.kind, 'manual');
  assert.equal(handed[0].captions.language, 'es');
  assert.equal(handed[0].captions.clock, 'recording');
  assert.ok(handed[0].captions.segments.length > 300);
});

test('the hand-off keeps the fallback captions with the File (owner-scoped, bounded) before queuing the job', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caption-handoff-'));
  const clipPath = path.join(dir, 'clip.m4a');
  fs.writeFileSync(clipPath, 'aac');
  const log = [];
  const analyses = new Map();
  const prisma = {
    file: { create: async ({ data }) => { log.push('file.create'); return { id: 'f1', ...data }; }, delete: async () => ({}) },
    documentAnalysis: {
      findUnique: async ({ where }) => analyses.get(where.fileId) || null,
      upsert: async ({ where, create, update }) => {
        log.push('captions');
        const row = analyses.get(where.fileId);
        analyses.set(where.fileId, row ? { ...row, metadata: update.metadata } : { ...create });
        return analyses.get(where.fileId);
      },
    },
  };
  const services = {
    prisma, transcriptStore: { recordMediaClipOffset: async () => ({ ok: true }) },
    delivery: { isMediaDeliveryEnabled: () => true, createDelivery: async (record) => { log.push('delivery'); return { id: 'md_1', ...record }; }, handOffMessage: () => 'Te aviso aquí.' },
    enqueueMediaTranscription: async () => { log.push('enqueue'); return { queued: true }; },
  };
  const cues = Array.from({ length: 50 }, (_, i) => ({ start: 3600 + i * 10, end: 3600 + i * 10 + 8, text: `Frase ${i}` }));
  const pick = tool.pickFallbackCaptions({ tracks: [{ language: 'es', key: 'es', kind: 'auto', cues }] }, { known: 'es', rangeStart: 3600, rangeEnd: 4100 });
  const captions = tool.linkCaptionsRecord(pick, { rangeStart: 3600, rangeEnd: 4100 });
  assert.equal(captions.kind, 'auto');
  assert.equal(captions.segments[0].start, 3600, 'on the recording clock');
  const result = await tool.defaultDurableHandoff({ clipPath, title: 'Clase', url: new globalThis.URL('https://www.youtube.com/watch?v=x'),
    rangeStart: 3600, rangeEnd: 4100, spanSec: 500, sectioned: true, subtitles: false, ctx: { userId: 'u1', chatId: 'c1' },
    env: { UPLOAD_DIR: path.join(dir, 'uploads') }, captions, services });
  assert.equal(result.ok, true);
  assert.deepEqual(log, ['file.create', 'captions', 'delivery', 'enqueue']);
  const kept = await tool.readLinkCaptions(prisma, { fileId: 'f1', userId: 'u1' });
  assert.equal(kept.kind, 'auto');
  assert.equal(kept.language, 'es');
  assert.equal(kept.segments.length, 50);
  assert.equal(await tool.readLinkCaptions(prisma, { fileId: 'f1', userId: 'otro' }), null, 'owner-scoped');
  // Bounded: a huge track is cut and marked.
  const huge = Array.from({ length: 9000 }, (_, i) => ({ start: i, end: i + 0.9, text: 'x'.repeat(40) }));
  const big = tool.linkCaptionsRecord({ track: { language: 'es', kind: 'manual', cues: huge }, end: 9000, coverage: 1 }, { rangeStart: 0, rangeEnd: 9000 });
  assert.equal(big.truncated, true);
  assert.ok(big.segments.length <= 6000);
});
