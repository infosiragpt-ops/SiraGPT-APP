'use strict';

/**
 * whisper.cpp invocation for long media: real timestamps (no -nt), language
 * auto-detection instead of whisper-cli's English default, the vocabulary
 * prompt, and a beam width picked by the length of the whole recording.
 */

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const engine = require('../src/services/local-whisper-engine');

function child(write, exitCode = 0) {
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  queueMicrotask(() => {
    try { write?.(); } catch (error) { c.emit('error', error); return; }
    c.emit('close', exitCode);
  });
  return c;
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-whisper-args-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const wavPath = path.join(dir, 'audio.wav');
  const modelPath = path.join(dir, 'ggml-base.bin');
  fs.writeFileSync(wavPath, 'wav');
  fs.writeFileSync(modelPath, 'model');
  return { dir, wavPath, modelPath };
}

const base = { modelPath: '/m/ggml-base.bin', wavPath: '/tmp/a.wav', outBase: '/tmp/transcript' };

test('timestamps are decoded: -nt is never passed, JSON + txt output stay', () => {
  const args = engine.buildWhisperCppArgs({ ...base, language: 'es', threads: 2 });
  assert.ok(!args.includes('-nt'), 'no -nt: whisper.cpp seeks on real segment ends');
  assert.ok(args.includes('-oj') && args.includes('-otxt'));
  assert.equal(args[args.indexOf('-of') + 1], '/tmp/transcript');
});

test('an unknown language is -l auto (whisper-cli otherwise assumes English); tags are reduced to ISO', () => {
  for (const language of [undefined, null, '', 'auto', 'detect', 'spanish']) {
    const args = engine.buildWhisperCppArgs({ ...base, language });
    assert.equal(args[args.indexOf('-l') + 1], 'auto', String(language));
  }
  assert.equal(engine.whisperLanguageArg('es-PE'), 'es');
  assert.equal(engine.whisperLanguageArg('EN'), 'en');
  const args = engine.buildWhisperCppArgs({ ...base, language: 'pt' });
  assert.equal(args[args.indexOf('-l') + 1], 'pt');
});

test('the vocabulary prompt travels as one clean argv entry', () => {
  const args = engine.buildWhisperCppArgs({ ...base, language: 'es', prompt: 'Clase de Microeconomía.\nElasticidad, Pareto,\u0007 Nash.' });
  assert.equal(args[args.indexOf('--prompt') + 1], 'Clase de Microeconomía. Elasticidad, Pareto, Nash.');
  assert.ok(!engine.buildWhisperCppArgs({ ...base, prompt: '   ' }).includes('--prompt'));
  const long = engine.buildWhisperCppArgs({ ...base, prompt: 'x'.repeat(5000) });
  assert.equal(long[long.indexOf('--prompt') + 1].length, 1000);
});

test('beam width: 5 for clips up to 10 min, 2 for long media, WHISPER_CPP_BEAM_SIZE wins', () => {
  assert.equal(engine.resolveBeamSize({ env: {}, durationSeconds: 45 }), 5);
  assert.equal(engine.resolveBeamSize({ env: {}, durationSeconds: 600 }), 5);
  assert.equal(engine.resolveBeamSize({ env: {}, durationSeconds: 120, mediaDurationSeconds: 18000 }), 2, 'a 10-min piece of a 5 h lecture uses the long-media beam');
  assert.equal(engine.resolveBeamSize({ env: { WHISPER_CPP_BEAM_SIZE: '1' }, durationSeconds: 45 }), 1);
  assert.equal(engine.resolveBeamSize({ env: { WHISPER_CPP_BEAM_SIZE: '99' } }), 10);
  assert.equal(engine.resolveBeamSize({ env: { WHISPER_CPP_BEAM_SIZE: 'nope' }, durationSeconds: 7200 }), 2);
  const args = engine.buildWhisperCppArgs({ ...base, beamSize: 2 });
  assert.equal(args[args.indexOf('-bs') + 1], '2');
});

test('transcribeWithWhisperCpp sends auto + prompt + beam and reports the detected language', async (t) => {
  const { dir, wavPath, modelPath } = fixture(t);
  let seen;
  const result = await engine.transcribeWithWhisperCpp(wavPath, undefined, {
    env: {}, whisperBin: 'fixture-whisper', modelPath, prompt: 'Pareto, Nash.', mediaDurationSeconds: 18000,
    spawnImpl(command, args) {
      seen = args;
      return child(() => {
        const outBase = args[args.indexOf('-of') + 1];
        fs.writeFileSync(`${outBase}.json`, JSON.stringify({
          result: { language: 'en' },
          transcription: [
            { offsets: { from: 0, to: 4200 }, text: 'Hello class.' },
            { offsets: { from: 4200, to: 9100 }, text: 'Today: Pareto.' },
          ],
        }));
      });
    },
  });
  assert.equal(seen[seen.indexOf('-l') + 1], 'auto');
  assert.equal(seen[seen.indexOf('--prompt') + 1], 'Pareto, Nash.');
  assert.equal(seen[seen.indexOf('-bs') + 1], '2');
  assert.ok(!seen.includes('-nt'));
  assert.equal(result.language, 'en', 'auto mode reports what whisper.cpp detected');
  assert.deepEqual(result.segments.map((s) => [s.start, s.end]), [[0, 4.2], [4.2, 9.1]]);
  assert.ok(fs.existsSync(dir));
});

test('a forced language is reported as forced; the python fallback gets no bogus --language', async (t) => {
  const { wavPath, modelPath } = fixture(t);
  const cpp = await engine.transcribeWithWhisperCpp(wavPath, 'es', {
    env: {}, whisperBin: 'fixture-whisper', modelPath,
    spawnImpl(_command, args) {
      return child(() => fs.writeFileSync(`${args[args.indexOf('-of') + 1]}.json`, JSON.stringify({ result: { language: 'en' }, transcription: [{ text: 'Hola' }] })));
    },
  });
  assert.equal(cpp.language, 'es');
  let pyArgs;
  await engine.transcribeWithPython(wavPath, 'auto', {
    env: {},
    spawnImpl(_command, args) {
      pyArgs = args;
      return child(() => fs.writeFileSync(args[args.indexOf('--output') + 1], JSON.stringify({ text: 'hola', segments: [], language: 'es' })));
    },
  });
  assert.ok(!pyArgs.includes('--language'), 'auto is the python default; never pass the literal «auto»');
});

test('decoding a long whole file to WAV gets a budget scaled to its length', () => {
  assert.equal(engine.conversionTimeoutMs({ env: {} }), 180_000);
  assert.equal(engine.conversionTimeoutMs({ env: {}, durationSeconds: 18000 }), 1_800_000);
  assert.equal(engine.conversionTimeoutMs({ env: {}, mediaDurationSeconds: 36000, durationSeconds: 600 }), 3_600_000);
});

// ── Quality flags: feature-detected, never trusted (C4 quality half) ────────

const HELP_175 = [
  'usage: whisper-cli [options] file0 file1 ...',
  'options:',
  '  -h,        --help              [default] show this help message and exit',
  '  -mc N,     --max-context N     [-1     ] maximum number of text context tokens to store',
  '  -oj,       --output-json       [false  ] output result in a JSON file',
  '  -ojf,      --output-json-full  [false  ] include more information in the JSON file',
  '  -sns,      --suppress-nst      [false  ] suppress non-speech tokens',
  '  -dl,       --detect-language   [false  ] exit after automatically detecting language',
].join('\n');
const HELP_VAD = `${HELP_175}\nVoice Activity Detection (VAD) options:\n             --vad                           [false  ] enable Voice Activity Detection (VAD)\n  -vm FNAME, --vad-model FNAME               [       ] VAD model path`;

test('whisper-cli -h is parsed into the flags this build accepts', () => {
  assert.deepEqual(engine.parseWhisperHelp(HELP_175), {
    outputJsonFull: true, vad: false, maxContext: true, suppressNst: true, detectLanguage: true, carryInitialPrompt: false,
  });
  assert.equal(engine.parseWhisperHelp(HELP_VAD).vad, true);
  assert.equal(engine.parseWhisperHelp('  -vm FNAME, --vad-model FNAME').vad, false, '--vad-model alone is not --vad');
  assert.equal(engine.parseWhisperHelp('segmentation fault').outputJsonFull, false, 'not a help text: no optional flag');
});

test('the help is read once per binary; an unreadable one keeps today\'s arguments (one WARN)', async () => {
  let calls = 0;
  const whisperHelpImpl = async () => { calls++; return { stdout: '', stderr: HELP_175 }; };
  const a = await engine.whisperCliCapabilities('/opt/whisper-cli-a', { whisperHelpImpl });
  const b = await engine.whisperCliCapabilities('/opt/whisper-cli-a', { whisperHelpImpl });
  assert.equal(calls, 1);
  assert.equal(a.outputJsonFull && b.maxContext, true);
  const exitOne = async () => { throw Object.assign(new Error('exit 1'), { code: 1, stderr: HELP_VAD }); };
  assert.equal((await engine.whisperCliCapabilities('/opt/whisper-cli-b', { whisperHelpImpl: exitOne })).vad, true, 'usage printed with a non-zero exit still counts');
  const warns = [];
  const missing = async () => { throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }); };
  const none = await engine.whisperCliCapabilities('/opt/missing-cli', { whisperHelpImpl: missing, logImpl: (m) => warns.push(m) });
  assert.deepEqual(Object.values(none), [false, false, false, false, false, false]);
  assert.deepEqual(await engine.whisperCliCapabilities('/x', { whisperCapabilities: { vad: true, bogus: true } }), {
    outputJsonFull: false, vad: true, maxContext: false, suppressNst: false, detectLanguage: false, carryInitialPrompt: false,
  });
});

test('a whisper-cli -h that timed out is read again after a while; a binary that cannot run is remembered', async () => {
  let clock = 5_000_000;
  const now = () => clock;
  let calls = 0;
  let hang = true;
  const whisperHelpImpl = async () => {
    calls++;
    if (hang) throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT', killed: true, stdout: '', stderr: '' });
    return { stdout: '', stderr: HELP_175 };
  };
  const opts = { whisperHelpImpl, now, logImpl: () => {} };
  assert.equal((await engine.whisperCliCapabilities('/opt/whisper-cli-slow', opts)).outputJsonFull, false);
  await engine.whisperCliCapabilities('/opt/whisper-cli-slow', opts);
  assert.equal(calls, 1, 'within the retry window the failure is reused');
  hang = false;
  clock += 5 * 60_000;
  assert.equal((await engine.whisperCliCapabilities('/opt/whisper-cli-slow', opts)).outputJsonFull, true, 'read again: -ojf comes back');
  clock += 24 * 3600_000;
  await engine.whisperCliCapabilities('/opt/whisper-cli-slow', opts);
  assert.equal(calls, 2, 'a help that was read is kept for the process');

  let missingCalls = 0;
  const missing = async () => { missingCalls++; throw Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }); };
  await engine.whisperCliCapabilities('/opt/whisper-cli-noexec', { whisperHelpImpl: missing, now, logImpl: () => {} });
  clock += 24 * 3600_000;
  await engine.whisperCliCapabilities('/opt/whisper-cli-noexec', { whisperHelpImpl: missing, now, logImpl: () => {} });
  assert.equal(missingCalls, 1, 'a binary that cannot run does not come back by waiting');
});

test('optional flags appear only when the build lists them: -ojf, -mc, --vad --vad-model', () => {
  const plain = engine.buildWhisperCppArgs({ ...base, language: 'es', threads: 2, maxContext: 0, vadModel: '/v.bin' });
  assert.deepEqual(plain, ['-m', '/m/ggml-base.bin', '-f', '/tmp/a.wav', '-otxt', '-oj', '-of', '/tmp/transcript', '--no-prints', '-ng', '-t', '2', '-l', 'es'],
    'without capabilities: exactly today\'s arguments');
  const caps = engine.parseWhisperHelp(HELP_VAD);
  const full = engine.buildWhisperCppArgs({ ...base, language: 'es', threads: 2, capabilities: caps, maxContext: 0, vadModel: '/v.bin', prompt: 'Pareto.' });
  assert.ok(full.includes('-ojf'));
  assert.deepEqual(full.slice(full.indexOf('-mc'), full.indexOf('-mc') + 2), ['-mc', '0']);
  assert.deepEqual(full.slice(full.indexOf('--vad'), full.indexOf('--vad') + 3), ['--vad', '--vad-model', '/v.bin']);
  assert.equal(full.at(-1), 'Pareto.', 'the prompt stays last');
  const noVadModel = engine.buildWhisperCppArgs({ ...base, capabilities: caps });
  assert.ok(!noVadModel.includes('--vad') && !noVadModel.includes('-mc'));
});

test('-ojf tokens give every local segment a confidence (geometric mean of its text tokens)', async (t) => {
  const { wavPath, modelPath } = fixture(t);
  let seen;
  const result = await engine.transcribeWithWhisperCpp(wavPath, 'es', {
    env: {}, whisperBin: 'fixture-whisper-ojf', modelPath, whisperHelp: HELP_175,
    spawnImpl(_command, args) {
      seen = args;
      return child(() => fs.writeFileSync(`${args[args.indexOf('-of') + 1]}.json`, JSON.stringify({
        transcription: [
          { offsets: { from: 0, to: 2000 }, text: ' Hola mundo', tokens: [
            { text: '[_BEG_]', p: 0.99 }, { text: ' Hola', p: 0.9 }, { text: ' mundo', p: 0.4 }, { text: '[_TT_100]', p: 0.01 },
          ] },
          { offsets: { from: 2000, to: 4000 }, text: ' sin tokens' },
        ],
      })));
    },
  });
  assert.ok(seen.includes('-ojf'));
  assert.deepEqual(result.segments[0], { start: 0, end: 2, text: 'Hola mundo', confidence: 0.6, minP: 0.4 });
  assert.equal(result.segments[1].confidence, undefined, 'no tokens: no invented confidence');
  assert.deepEqual(engine.tokenConfidence([{ text: '<|endoftext|>', p: 0.5 }]), null);
});

test('VAD only with WHISPER_CPP_VAD=1, a build that has --vad, and a readable Silero model', async (t) => {
  const { dir, wavPath, modelPath } = fixture(t);
  const vadModel = path.join(dir, 'ggml-silero-v5.1.2.bin');
  fs.writeFileSync(vadModel, 'silero');
  const run = async (options) => {
    let seen;
    await engine.transcribeWithWhisperCpp(wavPath, 'es', {
      modelPath, whisperBin: 'fixture-whisper-vad', logImpl() {},
      spawnImpl(_c, args) { seen = args; return child(() => fs.writeFileSync(`${args[args.indexOf('-of') + 1]}.json`, JSON.stringify({ transcription: [{ text: 'hola' }] }))); },
      ...options,
    });
    return seen;
  };
  const on = await run({ env: { WHISPER_CPP_VAD: '1', WHISPER_CPP_VAD_MODEL: vadModel }, whisperHelp: HELP_VAD });
  assert.deepEqual(on.slice(on.indexOf('--vad'), on.indexOf('--vad') + 3), ['--vad', '--vad-model', vadModel]);
  assert.ok(!(await run({ env: { WHISPER_CPP_VAD_MODEL: vadModel }, whisperHelp: HELP_VAD })).includes('--vad'), 'off unless WHISPER_CPP_VAD=1');
  assert.ok(!(await run({ env: { WHISPER_CPP_VAD: '1', WHISPER_CPP_VAD_MODEL: vadModel }, whisperHelp: HELP_175 })).includes('--vad'), 'v1.7.5 has no --vad');
  assert.ok(!(await run({ env: { WHISPER_CPP_VAD: '1', WHISPER_CPP_VAD_MODEL: path.join(dir, 'missing.bin') }, whisperHelp: HELP_VAD, vadModelPath: path.join(dir, 'nope.bin') })).includes('--vad'),
    'no readable model: no VAD');
  const loop = await run({ env: {}, whisperHelp: HELP_175, maxContext: 0 });
  assert.deepEqual(loop.slice(loop.indexOf('-mc'), loop.indexOf('-mc') + 2), ['-mc', '0']);
});

test('an unknown `-l` exits 0 without output: the error carries whisper-cli\'s words', async (t) => {
  const { wavPath, modelPath } = fixture(t);
  await assert.rejects(engine.transcribeWithWhisperCpp(wavPath, 'xx', {
    env: {}, whisperBin: 'fixture-whisper-lang', modelPath,
    spawnImpl() {
      const c = new EventEmitter();
      c.stdout = new EventEmitter();
      c.stderr = new EventEmitter();
      queueMicrotask(() => { c.stderr.emit('data', Buffer.from("error: unknown language 'xx'\n")); c.emit('close', 0); });
      return c;
    },
  }), (err) => err.code === 'LOCAL_WHISPER_EMPTY' && /unknown language/.test(err.diagnostics));
});

test('an alternative-hypothesis decode carries its -af chain; anything that is not a filter chain is ignored', async (t) => {
  const { dir, wavPath } = fixture(t);
  const decode = async (audioFilter) => {
    let seen;
    await engine.convertToWav(wavPath, path.join(dir, `out-${Math.random()}.wav`), {
      env: {}, audioFilter,
      spawnImpl(_c, args) { seen = args; return child(() => fs.writeFileSync(args.at(-1), 'wav')); },
    });
    return seen;
  };
  const enhanced = await decode('highpass=f=80,dynaudnorm=f=150:g=15:p=0.9:m=20');
  assert.equal(enhanced[enhanced.indexOf('-af') + 1], 'highpass=f=80,dynaudnorm=f=150:g=15:p=0.9:m=20');
  assert.ok(!(await decode('volume=2; rm -rf /')).includes('-af'));
  assert.ok(!(await decode(undefined)).includes('-af'));
});

test('a SIGKILL we did not send is reported with its signal (OOM), and python is remembered as missing', async (t) => {
  const { dir, wavPath, modelPath } = fixture(t);
  await assert.rejects(engine.transcribeWithWhisperCpp(wavPath, 'es', {
    env: {}, whisperBin: 'fixture-whisper-oom', modelPath,
    spawnImpl() {
      const c = new EventEmitter();
      c.stdout = new EventEmitter();
      c.stderr = new EventEmitter();
      queueMicrotask(() => c.emit('close', null, 'SIGKILL'));
      return c;
    },
  }), (err) => err.code === 'LOCAL_WHISPER_FAILED' && err.signal === 'SIGKILL');

  const commands = [];
  const spawnImpl = (command, args) => {
    commands.push(command);
    if (command === 'ffmpeg') return child(() => fs.copyFileSync(wavPath, args.at(-1)));
    return child(null, command === 'python3' ? 2 : 1);
  };
  const options = { env: {}, whisperBin: 'fixture-whisper-py', modelPath, spawnImpl, logImpl() {} };
  const input = path.join(dir, 'in.wav');
  fs.writeFileSync(input, 'wav');
  await assert.rejects(engine.transcribeLocal(input, options), { code: 'LOCAL_WHISPER_UNAVAILABLE' });
  await assert.rejects(engine.transcribeLocal(input, options), { code: 'LOCAL_WHISPER_UNAVAILABLE' });
  assert.deepEqual(commands, ['ffmpeg', 'fixture-whisper-py', 'python3', 'ffmpeg', 'fixture-whisper-py'],
    'the second failure does not spawn the python fallback again');
});
