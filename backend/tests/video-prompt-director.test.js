'use strict';

// Video prompt director — professional direction + cross-clip continuity.
// Covers: continuity detection (ES/EN, explicit + soft overlap), professional
// prompt structure (camera/pacing/quality/audio), strict settings locking,
// idempotent re-enhancement, prompt length cap, negative prompt defaults,
// family inference, and composition with the fal video catalog payload
// builder (which stays a pure pass-through: enhancement happens in routes).

const test = require('node:test');
const assert = require('node:assert/strict');

const director = require('../src/services/video-prompt-director');
const { directVideoPrompt, detectContinuity, stripPreviousDirection } = director;
const {
  buildFalVideoInputPayload,
  resolveFalVideoModelRequest,
} = require('../src/services/fal-video-model-catalog');

// ── Continuity detection ──────────────────────────────────────────────

test('detectContinuity: no history → none', () => {
  assert.deepEqual(detectContinuity('un perro corriendo', []), { mode: 'none', matched: [] });
  assert.deepEqual(detectContinuity('un perro corriendo', null), { mode: 'none', matched: [] });
});

test('detectContinuity: explicit Spanish sequel markers → strict', () => {
  const history = [{ prompt: 'una astronauta en marte con traje rojo' }];
  for (const p of [
    'continúa la escena con la astronauta caminando',
    'siguiente escena: la astronauta mira al cielo',
    'el mismo personaje pero de noche',
    'mantén el mismo estilo y vestuario',
    'parte 2 del video anterior',
  ]) {
    const r = detectContinuity(p, history);
    assert.equal(r.mode, 'strict', p);
    assert.ok(r.matched.length > 0, p);
  }
});

test('detectContinuity: explicit English sequel markers → strict', () => {
  const history = [{ prompt: 'a knight in a dark forest' }];
  for (const p of [
    'continue with the knight drawing his sword',
    'next shot: close-up of the knight',
    'same character, now raining',
    'keep the same style',
  ]) {
    assert.equal(detectContinuity(p, history).mode, 'strict', p);
  }
});

test('detectContinuity: unrelated new topic with history → style (soft bible)', () => {
  const history = [{ prompt: 'una astronauta en marte con traje rojo' }];
  const r = detectContinuity('un tutorial de cocina con tomates frescos en una cocina moderna', history);
  assert.equal(r.mode, 'style');
});

test('detectContinuity: short follow-up sharing subject vocabulary → strict (soft)', () => {
  const history = [{ prompt: 'una astronauta en marte con traje rojo explorando un cráter' }];
  const r = detectContinuity('la astronauta entra al cráter', history);
  assert.equal(r.mode, 'strict');
  assert.deepEqual(r.matched, ['soft:subject-overlap']);
});

test('detectContinuity: anchors to the most recent clip, not older ones', () => {
  const history = [
    { prompt: 'gatos bailando en una cocina' },
    { prompt: 'perros en la playa' },
    { prompt: 'coches de carreras' },
    { prompt: 'montañas nevadas' },
    { prompt: 'océano profundo' },
    { prompt: 'una astronauta en marte con traje rojo' },
  ];
  // References an OLD clip only → style bible, not a strict sequel.
  const r = detectContinuity('los gatos siguen bailando en la cocina', history);
  assert.equal(r.mode, 'style');
  // References the LAST clip → strict.
  const r2 = detectContinuity('la astronauta con traje rojo despega', history);
  assert.equal(r2.mode, 'strict');
});

// ── Professional direction ────────────────────────────────────────────

test('directVideoPrompt: first clip carries camera + pacing + quality direction', () => {
  const r = directVideoPrompt({ prompt: 'un dron sobrevuela una ciudad al atardecer', aspectRatio: '16:9', durationSeconds: 5 });
  assert.equal(r.continuityMode, 'none');
  assert.match(r.prompt, /Camera:/);
  assert.match(r.prompt, /Pacing:/);
  assert.match(r.prompt, /professional color grading/);
  assert.match(r.prompt, /24fps/);
  assert.ok(r.prompt.includes('un dron sobrevuela una ciudad al atardecer'), 'keeps user words');
  assert.ok(r.negativePrompt.includes('morphing'));
  assert.ok(r.negativePrompt.includes('watermark'));
});

test('directVideoPrompt: 9:16 gets vertical framing direction', () => {
  const r = directVideoPrompt({ prompt: 'bailarina en estudio', aspectRatio: '9:16', durationSeconds: 8 });
  assert.match(r.prompt, /vertical 9:16/);
});

test('directVideoPrompt: long durations get multi-beat pacing, short get single beat', () => {
  const short = directVideoPrompt({ prompt: 'ola rompiendo', durationSeconds: 4 });
  const long = directVideoPrompt({ prompt: 'ola rompiendo', durationSeconds: 12 });
  assert.match(short.prompt, /single beat/);
  assert.match(long.prompt, /mini-sequence/);
});

test('directVideoPrompt: audio-capable endpoint adds audio cues; audio off marks silent', () => {
  const withAudio = directVideoPrompt({ prompt: 'concierto', endpoint: 'fal-ai/veo3.1/fast', audio: true });
  const silent = directVideoPrompt({ prompt: 'concierto', endpoint: 'fal-ai/veo3.1/fast', audio: false });
  assert.match(withAudio.prompt, /synchronized ambient audio/);
  assert.match(silent.prompt, /silent footage/);
});

test('directVideoPrompt: sora endpoint adds no audio cue', () => {
  const r = directVideoPrompt({ prompt: 'robot caminando', endpoint: 'fal-ai/sora-2/text-to-video', audio: true });
  assert.doesNotMatch(r.prompt, /ambient audio/);
  assert.doesNotMatch(r.prompt, /silent footage/);
});

test('directVideoPrompt: explicit supportsAudio override wins over family inference', () => {
  const r = directVideoPrompt({ prompt: 'robot caminando', endpoint: 'fal-ai/kling-video/v3/pro/text-to-video', audio: true, supportsAudio: false });
  assert.doesNotMatch(r.prompt, /ambient audio/);
});

// ── Continuity modes ──────────────────────────────────────────────────

test('directVideoPrompt: strict sequel embeds anchor + locks settings', () => {
  const history = [{
    prompt: 'una astronauta en marte con traje rojo',
    aspect_ratio: '9:16',
    resolution: '720p',
    audio: true,
    model: 'fal-ai/veo3.1/fast',
  }];
  const r = directVideoPrompt({
    prompt: 'continúa: la astronauta camina hacia una cueva',
    aspectRatio: '16:9', // user changed it — strict must lock back to 9:16
    durationSeconds: 8,
    history,
  });
  assert.equal(r.continuityMode, 'strict');
  assert.match(r.prompt, /Direct sequel to the previous shot/);
  assert.match(r.prompt, /same character, same wardrobe/);
  assert.ok(r.prompt.includes('una astronauta en marte con traje rojo'), 'anchor embedded');
  assert.equal(r.settings.aspect_ratio, '9:16');
  assert.ok(r.settingsLocked.includes('aspect_ratio'));
});

test('directVideoPrompt: style mode keeps new settings, adds universe bible', () => {
  const history = [{ prompt: 'una astronauta en marte', aspect_ratio: '9:16' }];
  const r = directVideoPrompt({
    prompt: 'un chef preparando pasta en roma',
    aspectRatio: '16:9',
    history,
  });
  assert.equal(r.continuityMode, 'style');
  assert.match(r.prompt, /Same visual universe/);
  assert.equal(r.settings.aspect_ratio, '16:9');
  assert.deepEqual(r.settingsLocked, []);
});

test('directVideoPrompt: explicit continuation:true forces strict', () => {
  const history = [{ prompt: 'un faro en una tormenta' }];
  const r = directVideoPrompt({ prompt: 'vista aérea del océano', history, continuation: true });
  assert.equal(r.continuityMode, 'strict');
});

test('directVideoPrompt: explicit continuation:false downgrades to style', () => {
  const history = [{ prompt: 'un faro en una tormenta' }];
  const r = directVideoPrompt({ prompt: 'continúa con el faro de cerca', history, continuation: false });
  assert.equal(r.continuityMode, 'style');
});

test('directVideoPrompt: re-enhancing an enhanced prompt does not stack anchors', () => {
  const history = [{ prompt: 'un faro en una tormenta' }];
  const once = directVideoPrompt({ prompt: 'continúa con el faro de cerca', history });
  const twice = directVideoPrompt({
    prompt: once.prompt,
    history,
    continuation: true,
  });
  const count = (twice.prompt.match(/Direct sequel to the previous shot/g) || []).length;
  assert.equal(count, 1, 'single sequel header after re-enhancement');
});

test('directVideoPrompt: prompt is capped at MAX_PROMPT_CHARS', () => {
  const longPrompt = 'una escena épica con dragones '.repeat(60);
  const r = directVideoPrompt({
    prompt: longPrompt,
    history: [{ prompt: 'un faro en una tormenta con olas gigantes y gaviotas al atardecer dorado' }],
    continuation: true,
  });
  assert.ok(r.prompt.length <= director.MAX_PROMPT_CHARS, `len=${r.prompt.length}`);
});

test('directVideoPrompt: professionalize:false keeps user text, still adds bible on strict', () => {
  const history = [{ prompt: 'un faro en una tormenta' }];
  const r = directVideoPrompt({
    prompt: 'continúa con el faro de cerca',
    history,
    professionalize: false,
  });
  assert.equal(r.professionalized, false);
  assert.doesNotMatch(r.prompt, /Camera:/);
  assert.match(r.prompt, /Direct sequel/);
});

test('directVideoPrompt: requires a prompt', () => {
  assert.throws(() => directVideoPrompt({ prompt: '   ' }), /prompt is required/);
});

test('stripPreviousDirection: removes injected headers', () => {
  const dirty = 'Direct sequel to the previous shot — same character. Same visual universe and art direction as the previous shot ("x"). Un dron al amanecer.';
  const clean = stripPreviousDirection(dirty);
  assert.ok(clean.includes('Un dron al amanecer.'));
  assert.doesNotMatch(clean, /Direct sequel/);
  assert.doesNotMatch(clean, /Same visual universe/);
});

test('inferDirectorFamily: maps canonical endpoints to families', () => {
  assert.equal(director.inferDirectorFamily('fal-ai/veo3.1/fast'), 'veo');
  assert.equal(director.inferDirectorFamily('fal-ai/veo3/fast/image-to-video'), 'veo');
  assert.equal(director.inferDirectorFamily('bytedance/seedance-2.0/text-to-video'), 'seedance');
  assert.equal(director.inferDirectorFamily('fal-ai/kling-video/v3/pro/text-to-video'), 'kling');
  assert.equal(director.inferDirectorFamily('fal-ai/sora-2/text-to-video/pro'), 'sora');
  assert.equal(director.inferDirectorFamily('fal-ai/pixverse/v6/text-to-video'), 'pixverse');
  assert.equal(director.inferDirectorFamily('something-unknown'), 'other');
});

// ── Catalog payload builder (unchanged pass-through + gating) ─────────

test('buildFalVideoInputPayload: passes prompt through untouched', () => {
  const payload = buildFalVideoInputPayload({
    endpoint: 'fal-ai/veo3.1/fast',
    prompt: 'un dron sobre la ciudad',
    aspectRatio: '9:16',
    duration: '8s',
  });
  assert.equal(payload.prompt, 'un dron sobre la ciudad');
  assert.equal(payload.aspect_ratio, '9:16');
  assert.equal(payload.duration, '8s');
  assert.equal(payload.generate_audio, true);
  assert.equal(payload.resolution, '720p');
});

test('buildFalVideoInputPayload: kling gets negative prompt, sora does not', () => {
  const kling = buildFalVideoInputPayload({
    endpoint: 'fal-ai/kling-video/v3/pro/text-to-video',
    prompt: 'robot caminando',
    negativePrompt: 'blurry, morphing',
  });
  assert.equal(kling.negative_prompt, 'blurry, morphing');
  const sora = buildFalVideoInputPayload({
    endpoint: 'fal-ai/sora-2/text-to-video',
    prompt: 'robot caminando',
    negativePrompt: 'blurry, morphing',
  });
  assert.equal(sora.negative_prompt, undefined);
});

test('buildFalVideoInputPayload: pixverse uses its audio switch field', () => {
  const payload = buildFalVideoInputPayload({
    endpoint: 'fal-ai/pixverse/v6/text-to-video',
    prompt: 'gato bailando',
    audio: true,
  });
  assert.equal(payload.generate_audio_switch, true);
  assert.equal(payload.generate_audio, undefined);
});

// ── Composition: director → locked settings → payload ─────────────────

test('composition: strict continuity locks aspect in the final payload', () => {
  const history = [{
    prompt: 'una astronauta en marte con traje rojo',
    aspect_ratio: '9:16',
    resolution: '720p',
    audio: true,
    model: 'fal-ai/veo3.1/fast',
  }];
  const direction = directVideoPrompt({
    prompt: 'continúa: la astronauta corre',
    aspectRatio: '16:9',
    durationSeconds: 8,
    endpoint: 'fal-ai/veo3.1',
    history,
  });
  assert.equal(direction.continuityMode, 'strict');
  // Route feeds the locked settings back into the payload builder.
  const payload = buildFalVideoInputPayload({
    endpoint: 'fal-ai/veo3.1',
    prompt: direction.prompt,
    aspectRatio: direction.settings.aspect_ratio,
    duration: '8s',
    negativePrompt: direction.negativePrompt,
    resolution: direction.settings.resolution || '720p',
    audio: direction.settings.audio,
  });
  assert.equal(payload.aspect_ratio, '9:16', 'locked to previous clip');
  assert.ok(payload.prompt.includes('Direct sequel to the previous shot'));
  assert.ok(payload.negative_prompt.includes('morphing'));
});

test('resolveFalVideoModelRequest: still resolves known models after changes', () => {
  const routed = resolveFalVideoModelRequest('fal-ai/veo3.1/fast', {});
  assert.equal(routed.ok, true);
  assert.equal(routed.endpoint, 'fal-ai/veo3.1/fast');
});
