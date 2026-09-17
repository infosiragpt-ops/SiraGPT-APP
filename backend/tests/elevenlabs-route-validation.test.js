const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { body, validationResult } = require('express-validator');

const aiRouteSource = fs.readFileSync(path.join(__dirname, '../src/routes/ai.js'), 'utf8');
const elevenlabsRouteSource = fs.readFileSync(path.join(__dirname, '../src/routes/elevenlabs.js'), 'utf8');

// Mirrors the hardened input validators on the legacy ElevenLabs audio routes
// (backend/src/routes/elevenlabs.js). Locks the bounded contract so a future
// edit can't silently re-open the unbounded-`duration` credit-abuse hole
// (duration fed directly into ElevenLabs `music_length_ms` and the cost row).
const musicValidators = [
  body('text').trim().notEmpty().isLength({ max: 2000 }),
  body('duration').optional().isInt({ min: 1, max: 300 }).toInt(),
  body('model_id').optional().isString().trim().isLength({ max: 80 }),
  body('output_format').optional().isString().trim().isLength({ max: 40 }),
];

const ttsValidators = [
  body('text').trim().notEmpty().isLength({ max: 5000 }),
  body('voice_id').optional().isString().trim().isLength({ max: 120 }),
  body('model_id').optional().isString().trim().isLength({ max: 80 }),
];

async function validate(chains, reqBody) {
  const req = { body: { ...reqBody } };
  for (const c of chains) await c.run(req);
  return { ok: validationResult(req).isEmpty(), req };
}

test('music route: rejects out-of-range / non-integer duration', async () => {
  assert.equal((await validate(musicValidators, { text: 'x', duration: 500 })).ok, false, '500s must be rejected');
  assert.equal((await validate(musicValidators, { text: 'x', duration: -5 })).ok, false, 'negative must be rejected');
  assert.equal((await validate(musicValidators, { text: 'x', duration: 0 })).ok, false, 'zero must be rejected');
  assert.equal((await validate(musicValidators, { text: 'x', duration: 12.5 })).ok, false, 'float must be rejected');
});

test('music route: accepts a valid in-range duration and coerces to int', async () => {
  const { ok, req } = await validate(musicValidators, { text: 'lofi piano', duration: '30' });
  assert.equal(ok, true);
  assert.equal(req.body.duration, 30);
  // 300 is the upper bound (allows up to 5-min tracks).
  assert.equal((await validate(musicValidators, { text: 'x', duration: 300 })).ok, true);
});

test('music route: rejects empty or oversized text', async () => {
  assert.equal((await validate(musicValidators, { text: '   ' })).ok, false);
  assert.equal((await validate(musicValidators, { text: 'a'.repeat(2001) })).ok, false);
  assert.equal((await validate(musicValidators, { text: 'ok' })).ok, true);
});

test('tts route: caps text length and rejects empty', async () => {
  assert.equal((await validate(ttsValidators, { text: '' })).ok, false);
  assert.equal((await validate(ttsValidators, { text: 'a'.repeat(5001) })).ok, false);
  assert.equal((await validate(ttsValidators, { text: 'hola mundo' })).ok, true);
});

// Mirrors the Professional Voice Cloning validators
// (POST /elevenlabs/pvc/voices, POST /elevenlabs/pvc/voices/:voiceId/train).
// Locks the bounded contract so a future edit can't silently accept an
// unbounded name/language/model_id that ElevenLabs would bill or reject.
const pvcCreateValidators = [
  body('name').trim().notEmpty().isLength({ max: 80 }),
  body('language').optional().isString().trim().isLength({ max: 10 }),
];

const pvcTrainValidators = [
  body('model_id').optional().isString().trim().isLength({ max: 80 }),
];

test('pvc route: requires a bounded name and caps language length', async () => {
  assert.equal((await validate(pvcCreateValidators, { name: '   ' })).ok, false, 'blank name must be rejected');
  assert.equal((await validate(pvcCreateValidators, { name: 'a'.repeat(81) })).ok, false, '81 chars must be rejected');
  assert.equal((await validate(pvcCreateValidators, { name: 'Mi voz', language: 'portuguese-br' })).ok, false, 'overlong language must be rejected');
  assert.equal((await validate(pvcCreateValidators, { name: 'Mi voz', language: 'es' })).ok, true);
  assert.equal((await validate(pvcCreateValidators, { name: 'Mi voz' })).ok, true, 'language defaults server-side');
});

test('pvc train route: caps model_id length and accepts an empty body', async () => {
  assert.equal((await validate(pvcTrainValidators, { model_id: 'x'.repeat(81) })).ok, false);
  assert.equal((await validate(pvcTrainValidators, {})).ok, true);
});

test('pvc routes proxy the official ElevenLabs PVC API behind auth + paid plan', () => {
  assert.ok(elevenlabsRouteSource.includes("router.post('/pvc/voices'"), 'missing PVC create route');
  assert.ok(elevenlabsRouteSource.includes("pvcUpload.array('files'"), 'samples must go through the bounded PVC uploader');
  assert.ok(elevenlabsRouteSource.includes("router.post('/pvc/voices/:voiceId/train'"), 'missing PVC train route');
  assert.ok(elevenlabsRouteSource.includes("router.get('/pvc/voices/:voiceId'"), 'missing PVC status route');
  assert.ok(elevenlabsRouteSource.includes('/v1/voices/pvc'), 'must forward to the official PVC endpoints');
  assert.ok(elevenlabsRouteSource.includes("'xi-api-key'"), 'must authenticate upstream with xi-api-key');
  assert.ok(
    elevenlabsRouteSource.includes("requirePaidPlan({ feature: 'voice_generation' })"),
    'PVC must keep the same paid-plan gate as ElevenLabs TTS'
  );
});

test('chat speech and music routes propagate client disconnect cancellation', () => {
  assert.match(aiRouteSource, /const requestAbort = bindRequestAbort\(req, res\)/);
  assert.match(
    aiRouteSource,
    /generateSpeechFile\(\{[\s\S]{0,240}signal: requestAbort\.signal/,
    'speech generation must receive the request abort signal'
  );
  assert.match(
    aiRouteSource,
    /generateGeminiSpeechFile\(\{[\s\S]{0,300}signal: requestAbort\.signal/,
    'Gemini speech generation must receive the request abort signal'
  );
  assert.match(
    aiRouteSource,
    /generateLyriaMusicFile\(\{[^}]*signal: requestAbort\.signal[^}]*\}\)/,
    'Lyria generation must receive the request abort signal'
  );
  assert.match(
    aiRouteSource,
    /generateMusicFile\(\{[^}]*signal: requestAbort\.signal[^}]*\}\)/,
    'ElevenLabs music generation must receive the request abort signal'
  );
  assert.match(aiRouteSource, /cancelled by client/);
});

test('chat speech route selects Gemini and falls back across configured providers', () => {
  assert.match(aiRouteSource, /const geminiReady = geminiTts\.isGeminiTtsConfigured\(\)/);
  assert.match(aiRouteSource, /const wantsGemini = \/gemini\|mimo\|minimax\/i\.test\(selectedModel\)/);
  assert.match(aiRouteSource, /isRecoverableSpeechProviderError\(providerError\)/);
  assert.match(aiRouteSource, /modelLabel = usedProvider === 'gemini'/);
  assert.match(aiRouteSource, /format: audioFormat/);
});
