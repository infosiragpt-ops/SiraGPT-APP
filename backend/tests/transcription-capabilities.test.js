'use strict';

// Transcription / OCR capability report (C9): reads the feature detections
// the engines export, never leaks a key, degrades per probe, logs ONE line.
// Every module is injected: no binary, network or uploads dir is touched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const express = require('express');
const request = require('supertest');

const caps = require('../src/services/transcription-capabilities');
const { buildTranscriptionCapabilitiesRouter } = require('../src/routes/admin-transcription-capabilities');

const SECRET_OPENAI = 'sk-test-openai-SECRET-123';
const SECRET_GROQ = 'gsk_test_groq_SECRET_456';
const SECRET_ELEVEN = 'xi-test-eleven-SECRET-789';

function fakeModules(overrides = {}) {
  const calls = { whisperHelp: [], ensureAvailable: 0, ffmpegFilters: 0 };
  const audioTranscriber = {
    providerOrder: () => ['openai', 'groq', 'xai', 'meta', 'local'],
    cloudProviders: () => [
      { name: 'openai', kind: 'cloud', model: 'whisper-1', key: SECRET_OPENAI, client: () => ({ apiKey: SECRET_OPENAI }) },
      { name: 'groq', kind: 'cloud', model: 'whisper-large-v3-turbo', key: SECRET_GROQ, client: () => ({}) },
    ],
    providerInCooldown: (rung) => rung.name === 'openai',
    escalationProviderNames: () => ['elevenlabs'],
    escalationRungs: () => [{ name: 'elevenlabs', model: 'scribe_v1', key: SECRET_ELEVEN, escalation: true }],
    ffmpegFilterSet: async () => {
      calls.ffmpegFilters += 1;
      return new Set(['silencedetect', 'highpass', 'dynaudnorm', 'astats', 'select']);
    },
    VARIANT_FILTERS: {
      dynaudnorm: { filter: 'highpass,dynaudnorm', needs: ['highpass', 'dynaudnorm'] },
      loudnorm: { filter: 'highpass,loudnorm', needs: ['highpass', 'loudnorm'] },
    },
  };
  const localWhisper = {
    describeLocalWhisperAvailability: () => ({
      ok: true, code: null, reason: null, bin: '/usr/local/bin/whisper-cli', model: '/usr/local/share/whisper/ggml-base.bin', ffmpeg: 'ffmpeg',
    }),
    resolveThreadCount: () => 4,
    whisperCliCapabilities: async (bin) => {
      calls.whisperHelp.push(bin);
      return { outputJsonFull: true, vad: false, maxContext: true, suppressNst: true, detectLanguage: true, carryInitialPrompt: false };
    },
    vadModelPath: () => '/usr/local/share/whisper/ggml-silero-v5.1.2.bin',
    vadRequested: () => true,
  };
  const ocrInput = {
    getOcrInputCapabilities: async () => ({
      heif: { available: true, bin: 'heif-dec', version: '1.19.8' },
      ffmpeg: { available: true, version: '8.1.2' },
      tesseractCli: { available: true, version: '5.5.2' },
      tessdata: { dir: '/usr/share/tessdata', languages: ['deu', 'eng', 'fra', 'ita', 'osd', 'por', 'spa'] },
      osd: { available: true, reason: null },
      tessdataCacheDir: '/tmp/siragpt-tessdata-cache',
    }),
    resolveLocalTessdata: (lang) => (lang === 'spa+eng' ? { dir: '/usr/share/tessdata', languages: ['spa', 'eng'] } : null),
  };
  const ollamaOcr = {
    describe: () => ({ enabled: true, model: 'glm-ocr', available: null, reason: null, checkedAt: null, pulling: false }),
    ensureAvailable: async () => { calls.ensureAvailable += 1; return { available: true, reason: null }; },
  };
  const visionRuntime = {
    visionRuntimeCandidates: () => [
      { provider: 'Gemini', model: 'gemini-3.5-flash', apiKey: 'should-not-appear' },
      { provider: 'OpenAI', model: 'gpt-5.6-sol' },
    ],
  };
  const voiceStudio = { isConfigured: () => false };
  return { calls, modules: { audioTranscriber, localWhisper, ocrInput, ollamaOcr, visionRuntime, voiceStudio, ...overrides } };
}

const ENV = Object.freeze({ ELEVENLABS_API_KEY: SECRET_ELEVEN, OPENAI_API_KEY: SECRET_OPENAI });

test('report reads every engine detection and never carries a key', async () => {
  const { modules, calls } = fakeModules();
  const report = await caps.collectTranscriptionCapabilities({ env: { ...ENV }, modules });

  assert.equal(report.status, 'ok');
  assert.deepEqual(report.probeErrors, []);
  assert.deepEqual(report.stt.ladder.map((r) => [r.name, r.cooldown]), [['openai', true], ['groq', false], ['local', false]]);
  assert.deepEqual(report.stt.escalation, [{ name: 'elevenlabs', model: 'scribe_v1', cooldown: false }]);
  assert.equal(report.stt.dictation.scribeForPaidPlans, true);
  // Free dictation stays on-host by default; paid uses the shared order after Scribe.
  assert.deepEqual(report.stt.dictation.free, { providers: 'local,voicestudio', policy: 'on_host' });
  assert.deepEqual(report.stt.dictation.paid, { providers: 'ladder', policy: 'shared' });
  assert.equal(report.local.ok, true);
  assert.equal(report.local.threads, 4);
  assert.deepEqual(calls.whisperHelp, ['/usr/local/bin/whisper-cli']);
  assert.equal(report.whisperFlags.flags.outputJsonFull, true);
  assert.equal(report.whisperFlags.flags.vad, false);
  // VAD model present and requested, but v1.7.5 has no --vad: inactive, flagged.
  assert.deepEqual(report.vad, { model: '/usr/local/share/whisper/ggml-silero-v5.1.2.bin', requested: true, flagSupported: false, active: false });
  assert.ok(report.warnings.includes('vad:flag_unsupported'));
  assert.equal(report.ffmpeg.readable, true);
  assert.deepEqual(report.ffmpeg.variants, ['dynaudnorm']);
  assert.deepEqual(report.ffmpeg.missingForVariants, { loudnorm: ['loudnorm'] });
  assert.equal(report.ffmpeg.has.silencedetect, true);
  assert.equal(report.ocr.heif.available, true);
  assert.deepEqual(report.ocr.tessdata.missing, []);
  assert.equal(report.ocr.tessdata.localForSpaEng, true);
  assert.deepEqual(report.vision.runtimes, [{ provider: 'Gemini', model: 'gemini-3.5-flash' }, { provider: 'OpenAI', model: 'gpt-5.6-sol' }]);
  // Boot / default collection never probes Ollama over the network.
  assert.equal(calls.ensureAvailable, 0);
  assert.equal(report.glmOcr.available, null);
  assert.equal(report.glmOcr.probed, false);

  const serialized = JSON.stringify(report);
  for (const secret of [SECRET_OPENAI, SECRET_GROQ, SECRET_ELEVEN, 'should-not-appear']) {
    assert.ok(!serialized.includes(secret), `report must not contain ${secret}`);
  }
});

test('probeNetwork asks ollama-ocr ensureAvailable once', async () => {
  const { modules, calls } = fakeModules();
  const report = await caps.collectTranscriptionCapabilities({ env: { ...ENV }, modules, probeNetwork: true });
  assert.equal(calls.ensureAvailable, 1);
  assert.equal(report.glmOcr.available, true);
  assert.equal(report.glmOcr.probed, true);
});

test('a probe that throws degrades the report; the other probes still answer', async () => {
  const { modules } = fakeModules({
    ocrInput: { getOcrInputCapabilities: async () => { throw Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN' }); } },
  });
  const report = await caps.collectTranscriptionCapabilities({ env: { ...ENV }, modules });
  assert.equal(report.status, 'degraded');
  assert.deepEqual(report.probeErrors, [{ probe: 'ocr_inputs', error: 'EAGAIN' }]);
  assert.equal(report.ocr, null);
  assert.equal(report.local.ok, true);
  assert.equal(report.ffmpeg.readable, true);
  assert.match(caps.summarizeCapabilities(report), /probe_errors=ocr_inputs:EAGAIN/);
});

test('a hung probe times out instead of hanging the report', async () => {
  const { modules } = fakeModules();
  modules.audioTranscriber = { ...modules.audioTranscriber, ffmpegFilterSet: () => new Promise(() => {}) };
  const started = Date.now();
  const report = await caps.collectTranscriptionCapabilities({ env: { ...ENV }, modules, timeoutMs: 50 });
  assert.ok(Date.now() - started < 5000);
  assert.equal(report.status, 'degraded');
  assert.deepEqual(report.probeErrors, [{ probe: 'ffmpeg_filters', error: 'timeout' }]);
  assert.equal(report.ffmpeg, null);
  assert.ok(report.stt);
});

test('a module that cannot load is a typed probe error, never a throw', async () => {
  const { modules } = fakeModules({ audioTranscriber: null, localWhisper: () => { throw new Error('boom'); } });
  const report = await caps.collectTranscriptionCapabilities({ env: { ...ENV }, modules });
  assert.equal(report.status, 'degraded');
  const probes = report.probeErrors.map((e) => e.probe).sort();
  assert.ok(probes.includes('stt'));
  assert.ok(probes.includes('ffmpeg_filters'));
  assert.ok(probes.includes('local_whisper'));
  assert.ok(report.probeErrors.every((e) => typeof e.error === 'string' && e.error.length > 0));
  assert.ok(report.ocr && report.vision);
});

test('missing binaries become warnings; whisper flags are not read without a binary', async () => {
  const { modules, calls } = fakeModules({
    localWhisper: {
      describeLocalWhisperAvailability: () => ({ ok: false, code: 'model_missing', reason: 'model missing (/usr/local/share/whisper/ggml-base.bin)', bin: null, model: null }),
      resolveThreadCount: () => 2,
      whisperCliCapabilities: async () => { throw new Error('must not run'); },
      vadModelPath: () => null,
      vadRequested: () => false,
    },
    ocrInput: {
      getOcrInputCapabilities: async () => ({
        heif: { available: false }, ffmpeg: { available: true, version: '8.1.2' }, tesseractCli: { available: true, version: '5.5.2' },
        tessdata: { dir: '/usr/share/tessdata', languages: ['eng', 'osd', 'spa'] }, osd: { available: true }, tessdataCacheDir: null,
      }),
      resolveLocalTessdata: () => null,
    },
  });
  const report = await caps.collectTranscriptionCapabilities({ env: {}, modules });
  assert.equal(report.status, 'ok');
  assert.deepEqual(report.whisperFlags, { read: false, reason: 'binary_missing', flags: null });
  assert.equal(calls.whisperHelp.length, 0);
  for (const w of ['local_whisper:model_missing', 'ocr:heif_decoder_missing', 'ocr:tessdata_missing:por', 'ocr:tessdata_missing:deu']) {
    assert.ok(report.warnings.includes(w), `missing warning ${w}`);
  }
  assert.ok(!report.warnings.includes('ocr:tessdata_missing:spa'));
  assert.equal(report.stt.dictation.scribeForPaidPlans, false);
});

test('ffmpeg filters come from media-probe when it answers; unknown falls back; missing is a warning', async () => {
  const definitive = fakeModules({
    mediaProbe: { detectFfmpegFilters: async () => ({ available: true, definitive: true, filters: new Set(['highpass', 'loudnorm', 'select', 'showinfo']) }) },
  });
  let report = await caps.collectTranscriptionCapabilities({ env: {}, modules: definitive.modules });
  assert.equal(report.ffmpeg.source, 'media-probe');
  assert.equal(definitive.calls.ffmpegFilters, 0, 'one ffmpeg -filters answer is enough');
  assert.deepEqual(report.ffmpeg.variants, ['loudnorm']);
  assert.equal(report.ffmpeg.has.showinfo, true);

  const unknown = fakeModules({
    mediaProbe: { detectFfmpegFilters: async () => ({ available: true, definitive: false, filters: null, reason: 'timeout' }) },
  });
  report = await caps.collectTranscriptionCapabilities({ env: {}, modules: unknown.modules });
  assert.equal(report.ffmpeg.source, 'media-probe+audio-transcriber');
  assert.equal(unknown.calls.ffmpegFilters, 1);
  assert.equal(report.ffmpeg.readable, true);

  const missing = fakeModules({
    mediaProbe: { detectFfmpegFilters: async () => ({ available: false, definitive: true, filters: new Set(), reason: 'missing' }) },
  });
  missing.modules.audioTranscriber = { ...missing.modules.audioTranscriber, ffmpegFilterSet: async () => new Set() };
  report = await caps.collectTranscriptionCapabilities({ env: {}, modules: missing.modules });
  assert.equal(report.ffmpeg.available, false);
  assert.equal(report.ffmpeg.readable, false);
  assert.ok(report.warnings.includes('ffmpeg:missing'));
  assert.match(caps.summarizeCapabilities(report), / ffmpeg=missing /);
});

test('ocr-engine worker state surfaces a local tessdata failure', async () => {
  const { modules } = fakeModules({ ocrEngine: { _internals: { workerState: { localBroken: true } } } });
  const report = await caps.collectTranscriptionCapabilities({ env: {}, modules });
  assert.equal(report.ocr.tessdata.localBrokenInProcess, true);
  assert.ok(report.warnings.includes('ocr:local_tessdata_failed_cdn_fallback'));
  // Not injected → unknown (null), never a real require from an injected report.
  const plain = await caps.collectTranscriptionCapabilities({ env: {}, modules: fakeModules().modules });
  assert.equal(plain.ocr.tessdata.localBrokenInProcess, null);
});

test('summary is ONE bounded line with the key facts and no secret', async () => {
  const { modules } = fakeModules();
  const report = await caps.collectTranscriptionCapabilities({ env: { ...ENV }, modules });
  const line = caps.summarizeCapabilities(report);
  assert.ok(!/[\r\n]/.test(line));
  assert.ok(line.length <= 900);
  assert.match(line, /^\[transcription\] capabilities status=ok /);
  assert.match(line, /stt=openai\(cooldown\),groq,local escalation=elevenlabs dictation_free=local,voicestudio /);
  assert.match(line, /local=ok\(ggml-base\.bin,t=4\)/);
  assert.match(line, /flags=ojf,mc,sns,dl/);
  assert.match(line, /vad=off\(model,no-flag,requested\)/);
  assert.match(line, /ffmpeg=8\.1\.2 filters=5 variants=dynaudnorm/);
  assert.match(line, /tesseract=5\.5\.2 tessdata=deu,eng,fra,ita,osd,por,spa osd=yes heif=heif-dec\(1\.19\.8\)/);
  assert.match(line, /glm-ocr=unprobed/);
  assert.match(line, /vision=Gemini,OpenAI/);
  for (const secret of [SECRET_OPENAI, SECRET_GROQ, SECRET_ELEVEN]) assert.ok(!line.includes(secret));
  // A degenerate report still summarizes.
  assert.match(caps.summarizeCapabilities(null), /^\[transcription\] capabilities status=\?/);
});

test('logBootSummary writes one info line when clean, one warn line otherwise, and never throws', async () => {
  const clean = fakeModules({
    localWhisper: { ...fakeModules().modules.localWhisper, vadRequested: () => false },
    audioTranscriber: { ...fakeModules().modules.audioTranscriber, ffmpegFilterSet: async () => new Set(['highpass', 'dynaudnorm', 'loudnorm']) },
  });
  const lines = { info: [], warn: [] };
  const logger = { info: (l) => lines.info.push(l), warn: (l) => lines.warn.push(l) };
  const report = await caps.logBootSummary({ logger, env: { ...ENV }, modules: clean.modules });
  assert.equal(report.status, 'ok');
  assert.deepEqual(report.warnings, []);
  assert.equal(lines.info.length, 1);
  assert.equal(lines.warn.length, 0);
  assert.match(lines.info[0], /^\[transcription\] capabilities /);

  const broken = fakeModules({ ocrInput: null });
  const warnLines = [];
  await caps.logBootSummary({ logger: { info: () => assert.fail('must warn'), warn: (l) => warnLines.push(l) }, env: {}, modules: broken.modules });
  assert.equal(warnLines.length, 1);
  assert.match(warnLines[0], /status=degraded/);

  // A logger that throws is swallowed.
  const out = await caps.logBootSummary({ logger: { info: () => { throw new Error('x'); }, warn: () => { throw new Error('x'); } }, env: {}, modules: broken.modules });
  assert.ok(out);
});

test('GET /api/admin/transcription-capabilities: guarded, no-store, network probe, typed failure', async () => {
  const seen = [];
  const authenticate = (req, _res, next) => { req.user = { id: 'u1', isSuperAdmin: req.headers['x-role'] === 'super' }; next(); };
  const authorize = (req, res, next) => (req.user.isSuperAdmin ? next() : res.status(403).json({ error: 'Super admin access required' }));
  let fail = false;
  const collect = async (opts) => {
    seen.push(opts);
    if (fail) throw Object.assign(new Error('nope'), { code: 'EBOOM' });
    return { status: 'ok', warnings: [] };
  };
  const app = express();
  app.use('/api/admin/transcription-capabilities', buildTranscriptionCapabilitiesRouter({ authenticate, authorize, collect }));

  await request(app).get('/api/admin/transcription-capabilities').expect(403);
  assert.equal(seen.length, 0);

  const ok = await request(app).get('/api/admin/transcription-capabilities?refresh=1').set('x-role', 'super').expect(200);
  assert.deepEqual(ok.body, { status: 'ok', warnings: [] });
  assert.equal(ok.headers['cache-control'], 'no-store');
  assert.deepEqual(seen[0], { probeNetwork: true, refresh: true });

  fail = true;
  const bad = await request(app).get('/api/admin/transcription-capabilities').set('x-role', 'super').expect(500);
  assert.deepEqual(bad.body, { error: 'transcription_capabilities_unavailable' });
});

test('index.js mounts the report before the fail-closed /api/admin router and logs it after boot', () => {
  const index = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
  const mount = index.indexOf("app.use('/api/admin/transcription-capabilities', adminTranscriptionCapabilitiesRoutes)");
  const admin = index.indexOf("app.use('/api/admin', adminRoutes)");
  assert.ok(mount > 0 && admin > 0 && mount < admin);
  assert.match(index, /require\('\.\/src\/services\/transcription-capabilities'\)\s*\.logBootSummary\(\{ logger \}\)/);
  const route = fs.readFileSync(path.join(__dirname, '../src/routes/admin-transcription-capabilities.js'), 'utf8');
  assert.match(route, /requireSuperAdmin/);
});

test('dictation ladder policy: free on-host by default, opt-in cloud, operator list for every plan', async () => {
  assert.deepEqual(caps.dictationLadderOptions({}), { providers: ['local', 'voicestudio'], escalationProviders: [], policy: 'on_host' });
  assert.deepEqual(caps.dictationLadderOptions({}, { paid: true }), { policy: 'shared' });
  assert.deepEqual(caps.dictationLadderOptions({ SIRAGPT_DICTATION_FREE_CLOUD: '1' }), { policy: 'shared' });
  assert.deepEqual(caps.dictationLadderOptions({ SIRAGPT_DICTATION_FREE_CLOUD: '0' }).providers, ['local', 'voicestudio']);
  // The operator's list bounds a free dictation: no inherited paid escalation rung.
  assert.deepEqual(caps.dictationLadderOptions({ SIRAGPT_DICTATION_PROVIDERS: 'GROQ, local,groq' }), { providers: ['groq', 'local'], escalationProviders: [], policy: 'env' });
  assert.deepEqual(caps.dictationLadderOptions({ SIRAGPT_DICTATION_PROVIDERS: 'local,voicestudio', TRANSCRIBE_ESCALATION_PROVIDERS: 'elevenlabs' }).escalationProviders, []);
  assert.deepEqual(caps.dictationLadderOptions({ SIRAGPT_DICTATION_PROVIDERS: 'groq' }, { paid: true }), { providers: ['groq'], policy: 'env' });
  assert.deepEqual(caps.dictationLadderOptions({ SIRAGPT_DICTATION_PROVIDERS: ' , !!' }).providers, ['local', 'voicestudio']);
  // The returned list is a copy: a caller cannot mutate the policy.
  caps.dictationLadderOptions({}).providers.push('openai');
  assert.deepEqual(caps.DICTATION_FREE_PROVIDERS, ['local', 'voicestudio']);

  const { modules } = fakeModules();
  const report = await caps.collectTranscriptionCapabilities({ env: { SIRAGPT_DICTATION_FREE_CLOUD: '1' }, modules });
  assert.deepEqual(report.stt.dictation.free, { providers: 'ladder', policy: 'shared' });
  assert.match(caps.summarizeCapabilities(report), / dictation_free=ladder /);
});

test('Sira Voz listed after whisper.cpp: the report says short clips read whisper.cpp first', async () => {
  const withOrder = (order) => fakeModules({
    audioTranscriber: { ...fakeModules().modules.audioTranscriber, providerOrder: () => order },
    voiceStudio: { isConfigured: () => true },
  }).modules;
  // Appended after 'local': a long recording still asks Sira Voz first, a short clip does not.
  const after = await caps.collectTranscriptionCapabilities({ env: {}, modules: withOrder(['openai', 'local', 'voicestudio']) });
  assert.deepEqual(after.stt.ladder.map((r) => r.name), ['openai', 'groq', 'voicestudio', 'local']);
  assert.deepEqual(after.stt.voiceStudio, { configured: true, inLadder: true, shortClips: 'after_local' });
  assert.match(caps.summarizeCapabilities(after), /stt=openai\(cooldown\),groq,voicestudio,local voicestudio_short=after_local /);
  // Listed before it (or without it): Sira Voz is the preferred engine everywhere.
  const before = await caps.collectTranscriptionCapabilities({ env: {}, modules: withOrder(['voicestudio', 'local']) });
  assert.equal(before.stt.voiceStudio.shortClips, 'first');
  assert.doesNotMatch(caps.summarizeCapabilities(before), /voicestudio_short/);
  const none = await caps.collectTranscriptionCapabilities({ env: {}, modules: withOrder(['openai', 'local']) });
  assert.equal(none.stt.voiceStudio.shortClips, null);
});

test('memo: one entry per key — a boot pass that resolves late never overwrites or un-dedupes the admin pass', async () => {
  const { memoized } = caps._internals;
  caps.resetCapabilitiesMemo();
  let clock = 1_000;
  const now = () => clock;
  const deferred = () => {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
  };
  const boot = deferred();
  const admin = deferred();
  let adminComputes = 0;
  const bootP = memoized('local', () => boot.promise, { now });
  const adminP1 = memoized('net', () => { adminComputes += 1; return admin.promise; }, { now });

  // The boot pass resolves while the admin pass is still pending.
  boot.resolve({ status: 'ok', kind: 'boot' });
  assert.deepEqual(await bootP, { status: 'ok', kind: 'boot' });

  // Admin calls are still deduped onto the SAME pending pass.
  const adminP2 = memoized('net', () => { adminComputes += 1; return admin.promise; }, { now });
  assert.equal(adminP2, adminP1);
  assert.equal(adminComputes, 1);

  admin.resolve({ status: 'ok', kind: 'net' });
  assert.deepEqual(await adminP1, { status: 'ok', kind: 'net' });

  // Each key serves its own report from the memo (no recompute).
  let recomputed = 0;
  assert.deepEqual(await memoized('net', () => { recomputed += 1; return {}; }, { now }), { status: 'ok', kind: 'net' });
  assert.deepEqual(await memoized('local', () => { recomputed += 1; return {}; }, { now }), { status: 'ok', kind: 'boot' });
  assert.equal(recomputed, 0);

  // TTL and refresh.
  clock += 120_000;
  assert.deepEqual(await memoized('net', () => ({ kind: 'net2' }), { now }), { kind: 'net2' });
  assert.deepEqual(await memoized('net', () => ({ kind: 'net3' }), { now, refresh: true }), { kind: 'net3' });

  // A reset while a pass is pending: the old pass writes into its detached entry only.
  const late = deferred();
  const lateP = memoized('net', () => late.promise, { now, refresh: true });
  caps.resetCapabilitiesMemo();
  late.resolve({ kind: 'late' });
  await lateP;
  assert.deepEqual(await memoized('net', () => ({ kind: 'fresh' }), { now }), { kind: 'fresh' });
  caps.resetCapabilitiesMemo();
});

// ── Image: OCR packs, heif-dec and the sha256-pinned Silero VAD model ──────

const DOCKERFILE = fs.readFileSync(path.join(__dirname, '../Dockerfile'), 'utf8');
const VAD_SHA = '29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf';

function extraLayer() {
  const start = DOCKERFILE.indexOf('COPY scripts/install-whisper-vad.sh');
  assert.ok(start > 0, 'VAD installer must be copied into the image');
  const runStart = DOCKERFILE.indexOf('RUN apk add --no-cache \\\n      libheif-tools', start);
  assert.ok(runStart > 0, 'extras layer must start with apk add libheif-tools');
  const end = DOCKERFILE.indexOf('\n\n', runStart);
  return DOCKERFILE.slice(runStart, end);
}

test('Dockerfile: extras layer after the whisper build, packs + smoke checks + pinned VAD, whisper.cpp not bumped', () => {
  const whisperLayer = DOCKERFILE.indexOf('sh /tmp/install-local-whisper.sh');
  const layer = extraLayer();
  assert.ok(DOCKERFILE.indexOf(layer) > whisperLayer, 'extras must not invalidate the whisper build cache');
  for (const pkg of ['libheif-tools', 'tesseract-ocr-data-por', 'tesseract-ocr-data-fra', 'tesseract-ocr-data-ita', 'tesseract-ocr-data-deu']) {
    assert.match(layer, new RegExp(`\\b${pkg}\\b`));
  }
  assert.match(layer, /command -v heif-dec/);
  assert.match(layer, /tesseract --list-langs/);
  assert.match(layer, /for lang in eng spa osd por fra ita deu/);
  assert.match(layer, /sh \/tmp\/install-whisper-vad\.sh/);
  assert.match(DOCKERFILE, new RegExp(`ARG WHISPER_VAD_MODEL_SHA256=${VAD_SHA}`));
  // Pinned HF revision, never `main`: a re-upload upstream cannot break a publish.
  const VAD_URL = /https:\/\/huggingface\.co\/ggml-org\/whisper-vad\/resolve\/9ffd54a1e1ee413ddf265af9913beaf518d1639b\/ggml-silero-v5\.1\.2\.bin/;
  assert.match(DOCKERFILE, new RegExp(`ARG WHISPER_VAD_MODEL_URL=${VAD_URL.source}`));
  assert.doesNotMatch(DOCKERFILE, /whisper-vad\/resolve\/main\//);
  const vadScript = fs.readFileSync(path.join(__dirname, '../scripts/install-whisper-vad.sh'), 'utf8');
  assert.match(vadScript, new RegExp(`WHISPER_VAD_MODEL_URL:-${VAD_URL.source}`));
  assert.doesNotMatch(vadScript, /whisper-vad\/resolve\/main\//);
  // The existing whisper contract stays.
  assert.match(DOCKERFILE, /WHISPER_LANGUAGE=es/);
  const installer = fs.readFileSync(path.join(__dirname, '../scripts/install-local-whisper.sh'), 'utf8');
  assert.match(installer, /REF="\$\{WHISPER_CPP_REF:-v1\.7\.5\}"/);
  assert.doesNotMatch(DOCKERFILE, /WHISPER_CPP_REF=/);
  // The engine looks for the model where the image puts it.
  const engine = fs.readFileSync(path.join(__dirname, '../src/services/local-whisper-engine.js'), 'utf8');
  assert.match(engine, /\/usr\/local\/share\/whisper\/ggml-silero-v5\.1\.2\.bin/);
});

test('Dockerfile: the extras RUN body is valid POSIX sh', () => {
  const body = extraLayer().replace(/^RUN /, '').replace(/\\\n/g, ' ');
  const parsed = spawnSync('sh', ['-n', '-c', body], { encoding: 'utf8' });
  assert.equal(parsed.status, 0, parsed.stderr || parsed.stdout);
});

// ── install-whisper-vad.sh (file:// sources only — no network) ─────────────

const VAD_SCRIPT = path.join(__dirname, '../scripts/install-whisper-vad.sh');

function runVad(env) {
  return spawnSync('sh', [VAD_SCRIPT], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
}

function sha256(file) {
  return require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('install-whisper-vad.sh: verified copy installs 0644; mismatch fails and leaves nothing; optional download failure is a WARN', (t) => {
  const parsed = spawnSync('sh', ['-n', VAD_SCRIPT], { encoding: 'utf8' });
  assert.equal(parsed.status, 0, parsed.stderr);
  const script = fs.readFileSync(VAD_SCRIPT, 'utf8');
  assert.match(script, /^#!\/bin\/sh\b/m);
  assert.match(script, new RegExp(VAD_SHA));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-vad-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const src = path.join(dir, 'seed.bin');
  fs.writeFileSync(src, Buffer.from('fake-silero-model-bytes'));
  const good = sha256(src);
  const modelDir = path.join(dir, 'share', 'whisper');
  const dest = path.join(modelDir, 'ggml-silero-v5.1.2.bin');

  // Checksum mismatch: exit 3, no file, no partial.
  let ran = runVad({ WHISPER_VAD_MODEL_URL: `file://${src}`, WHISPER_VAD_MODEL_SHA256: VAD_SHA, WHISPER_VAD_MODEL_DIR: modelDir });
  assert.equal(ran.status, 3, ran.stderr);
  assert.match(ran.stderr, /checksum mismatch/);
  assert.ok(!fs.existsSync(dest));
  assert.ok(!fs.existsSync(`${dest}.partial`));

  // Verified copy.
  ran = runVad({ WHISPER_VAD_MODEL_URL: `file://${src}`, WHISPER_VAD_MODEL_SHA256: good, WHISPER_VAD_MODEL_DIR: modelDir });
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(sha256(dest), good);
  assert.equal(fs.statSync(dest).mode & 0o777, 0o644);

  // Re-run with the same pin: no-op.
  ran = runVad({ WHISPER_VAD_MODEL_URL: `file://${path.join(dir, 'gone.bin')}`, WHISPER_VAD_MODEL_SHA256: good, WHISPER_VAD_MODEL_DIR: modelDir });
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stderr, /already present and verified/);

  // Optional model, source unavailable: WARN + exit 0, nothing installed.
  const other = path.join(dir, 'other');
  ran = runVad({ WHISPER_VAD_MODEL_URL: `file://${path.join(dir, 'gone.bin')}`, WHISPER_VAD_MODEL_SHA256: good, WHISPER_VAD_MODEL_DIR: other });
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stderr, /WARN: Silero VAD model not downloaded/);
  assert.ok(!fs.existsSync(path.join(other, 'ggml-silero-v5.1.2.bin')));

  // Required model, source unavailable: exit 2.
  ran = runVad({ WHISPER_VAD_MODEL_URL: `file://${path.join(dir, 'gone.bin')}`, WHISPER_VAD_MODEL_SHA256: good, WHISPER_VAD_MODEL_DIR: other, WHISPER_VAD_REQUIRED: '1' });
  assert.equal(ran.status, 2, ran.stderr);
});
