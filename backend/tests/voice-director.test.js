const test = require('node:test');
const assert = require('node:assert/strict');

const director = require('../src/services/ai/voice-director');

test('catalog: every UI language resolves and every accent list is non-empty', () => {
  assert.ok(director.VOICE_LANGUAGES.length >= 30);
  for (const lang of director.VOICE_LANGUAGES) {
    const accents = director.accentsForLanguage(lang.name);
    assert.ok(accents.length >= 2, `${lang.name} has accents`);
    assert.ok(accents.some((a) => a.name === director.defaultAccentForLanguage(lang.name)));
  }
});

test('resolveVoicePlan: Turbo V2 + Spanish auto-upgrades (the screenshot bug)', () => {
  const plan = director.resolveVoicePlan({
    text: 'Hola mundo',
    model: 'ElevenLabs Turbo V2',
    language: 'Spanish',
    accent: 'Latino',
    effect: 'Studio Clean',
    stability: 100,
  });
  assert.equal(plan.provider, 'elevenlabs');
  assert.equal(plan.modelId, 'eleven_flash_v2_5');
  assert.ok(plan.warnings.length > 0);
  assert.match(plan.warnings.join(' '), /Flash V2\.5/);
});

test('resolveVoicePlan: v3-only languages route to V3 or Gemini, never break', () => {
  for (const language of ['Bengali', 'Afrikaans', 'Armenian', 'Hebrew', 'Catalan']) {
    const plan = director.resolveVoicePlan({
      text: 'Test',
      model: 'Multilingual V2',
      language,
      stability: 70,
    });
    assert.equal(plan.language, language);
    assert.ok(['eleven_v3', 'gemini-2.5-flash-preview-tts'].includes(plan.modelId), `${language} -> ${plan.modelId}`);
    assert.ok(plan.warnings.length > 0);
  }
});

test('resolveVoicePlan: unknown accent falls back to the language default with a warning', () => {
  const plan = director.resolveVoicePlan({
    text: 'Hola',
    language: 'Spanish',
    accent: 'British',
  });
  assert.equal(plan.accent, 'Latino');
  assert.ok(plan.warnings.some((w) => /British/.test(w)));
});

test('resolveVoicePlan: per-language accents are honoured without warnings', () => {
  const plan = director.resolveVoicePlan({
    text: 'Hello',
    model: 'Eleven V3',
    language: 'English',
    accent: 'British',
    effect: 'Cinematic',
    stability: 40,
  });
  assert.equal(plan.warnings.length, 0);
  assert.equal(plan.accent, 'British');
  assert.ok(plan.elevenTagPrefix.includes('[British accent]'));
  assert.ok(plan.elevenTagPrefix.includes('[dramatic tone]'));
});

test('resolveVoicePlan: long text exceeding the model limit upgrades the model', () => {
  const plan = director.resolveVoicePlan({
    text: 'x'.repeat(8000),
    model: 'Eleven V3',
    language: 'Spanish',
  });
  assert.notEqual(plan.modelId, 'eleven_v3');
  assert.ok(plan.warnings.some((w) => /8000/.test(w)));
});

test('resolveVoicePlan: stability shapes the full ElevenLabs settings curve', () => {
  const expressive = director.resolveVoicePlan({ text: 'Hi', stability: 20 });
  const stable = director.resolveVoicePlan({ text: 'Hi', stability: 95 });
  assert.ok(expressive.voiceSettings.style > stable.voiceSettings.style);
  assert.ok(expressive.voiceSettings.similarity_boost < stable.voiceSettings.similarity_boost);
  assert.equal(expressive.stabilityLabel, 'Muy expresivo');
  assert.equal(stable.stabilityLabel, 'Ultra estable');
});

test('resolveVoicePlan: legacy UI labels keep resolving (backward compat)', () => {
  assert.equal(director.resolveModelId('ElevenLabs'), 'eleven_multilingual_v2');
  assert.equal(director.resolveModelId('Gemini 2.5 Flash TTS'), 'gemini-2.5-flash-preview-tts');
  assert.equal(director.resolveModelId('eleven-turbo-v2'), 'eleven_turbo_v2_5');
  assert.equal(director.resolveModelId('Multilingual V2'), 'eleven_multilingual_v2');
  assert.equal(director.resolveModelId('Gemini Pro TTS'), 'gemini-2.5-pro-preview-tts');
  const plan = director.resolveVoicePlan({ text: 'Hola', model: 'ElevenLabs', language: 'Spanish' });
  assert.equal(plan.modelId, 'eleven_multilingual_v2');
  assert.equal(plan.warnings.length, 0);
});

test('resolveVoicePlan: legacy turbo + v3-only language ends on V3 (gates chain)', () => {
  const plan = director.resolveVoicePlan({
    text: 'Test',
    modelId: 'eleven_turbo_v2',
    language: 'Hebrew',
    stability: 70,
  });
  assert.equal(plan.modelId, 'eleven_v3');
  assert.equal(plan.language, 'Hebrew');
  assert.ok(plan.warnings.length >= 2);
});

test('resolveVoicePlan: explicit Turbo V2.5 pick is honoured without warnings', () => {
  const plan = director.resolveVoicePlan({
    text: 'Hola',
    model: 'Turbo V2.5',
    language: 'Spanish',
    accent: 'Latino',
    effect: 'Studio Clean',
    stability: 80,
  });
  assert.equal(plan.modelId, 'eleven_turbo_v2_5');
  assert.equal(plan.warnings.length, 0);
});

test('resolveVoicePlan: missing accent picks the per-language default silently', () => {
  const es = director.resolveVoicePlan({ text: 'Hola', language: 'Spanish' });
  assert.equal(es.accent, 'Latino');
  const en = director.resolveVoicePlan({ text: 'Hello', language: 'English' });
  assert.equal(en.accent, 'US');
  assert.equal(en.warnings.length, 0);
});

test('resolveVoicePlan: OpenAI models resolve and shape speed + instructions', () => {
  assert.equal(director.resolveModelId('OpenAI TTS'), 'tts-1');
  assert.equal(director.resolveModelId('OpenAI TTS HD'), 'tts-1-hd');
  assert.equal(director.resolveModelId('GPT-4o mini TTS'), 'gpt-4o-mini-tts');

  const mini = director.resolveVoicePlan({
    text: 'Hola mundo',
    model: 'GPT-4o mini TTS',
    language: 'Spanish',
    accent: 'Mexican',
    effect: 'Cinematic',
    stability: 40,
  });
  assert.equal(mini.provider, 'openai');
  assert.equal(mini.modelId, 'gpt-4o-mini-tts');
  assert.ok(mini.openaiSpeed < 1.0);
  assert.match(mini.openaiInstructions, /Mexico City/);
  assert.match(mini.openaiInstructions, /dramatic/i);
  assert.equal(mini.warnings.length, 0);

  const classic = director.resolveVoicePlan({
    text: 'Hola mundo',
    model: 'OpenAI TTS',
    language: 'Spanish',
    stability: 80,
  });
  assert.equal(classic.openaiInstructions, undefined);
  assert.ok(classic.openaiSpeed <= 1.0);
});

test('resolveVoicePlan: OpenAI covers every catalog language without warnings', () => {
  for (const lang of director.VOICE_LANGUAGES) {
    const plan = director.resolveVoicePlan({
      text: 'Prueba de voz',
      model: 'OpenAI TTS',
      language: lang.name,
      stability: 70,
    });
    assert.equal(plan.language, lang.name, lang.name);
    assert.equal(plan.provider, 'openai');
    assert.equal(plan.warnings.length, 0, `${lang.name}: ${plan.warnings.join('; ')}`);
  }
});

test('resolveVoicePlan: OpenAI char overflow reroutes to a model that fits', () => {
  const plan = director.resolveVoicePlan({
    text: 'x'.repeat(3000),
    model: 'GPT-4o mini TTS',
    language: 'Spanish',
  });
  assert.equal(plan.modelId, 'eleven_flash_v2_5');
  assert.ok(plan.warnings.some((w) => /3000/.test(w)));
});

test('mapStabilityToOpenAiSpeed: effect pace + stability tilt inside API range', () => {
  const slow = director.mapStabilityToOpenAiSpeed(1, {});
  const fast = director.mapStabilityToOpenAiSpeed(0, {});
  assert.ok(fast > slow);
  assert.ok(slow >= 0.25 && fast <= 4.0);
  const cinematic = director.mapStabilityToOpenAiSpeed(0.5, { effectSpeedDelta: -0.08 });
  assert.ok(cinematic < 1.0);
});

test('buildOpenAiInstructions: short direction without transcript', () => {
  const text = director.buildOpenAiInstructions({
    language: 'French',
    accent: 'Quebec',
    effect: 'Podcast',
    stability: 55,
  });
  assert.match(text, /French/);
  assert.match(text, /Montreal/);
  assert.match(text, /podcast/i);
  assert.ok(text.length < 600);
});

test('mapStabilityToElevenSettings: professional curve endpoints', () => {
  const low = director.mapStabilityToElevenSettings(0);
  const high = director.mapStabilityToElevenSettings(1);
  assert.equal(low.stability, 0);
  assert.equal(high.stability, 1);
  assert.ok(low.style > high.style);
  assert.ok(low.similarity_boost < high.similarity_boost);
  assert.equal(high.use_speaker_boost, false);
  assert.equal(low.use_speaker_boost, true);
});

test('buildGeminiDirectorPrompt: transcript fidelity + director notes', () => {
  const prompt = director.buildGeminiDirectorPrompt('No me cambies.', {
    language: 'Spanish',
    accent: 'Mexican',
    effect: 'Studio Clean',
    stability: 100,
  });
  assert.match(prompt, /Mexico City/);
  assert.match(prompt, /TRANSCRIPT:\nNo me cambies\.$/);
  assert.match(prompt, /exactly as written/);
});
