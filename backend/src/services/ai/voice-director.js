/**
 * voice-director
 *
 * Single source of truth for the chat composer's Voice mode. It makes
 * language / accent / stability / effect behave PROFESSIONALLY and
 * CONSISTENTLY across every speech model (any LLM/TTS provider), instead of
 * the previous behaviour where those controls only shaped the Gemini prompt
 * and were silently ignored by ElevenLabs.
 *
 * Research summary (baked into the tables below):
 * - ElevenLabs `eleven_turbo_v2` is ENGLISH-ONLY. Selecting it with Spanish
 *   (the screenshot bug: "ElevenLabs Turbo V2" + Spanish) can never work —
 *   the plan auto-upgrades to Flash V2.5 and reports a warning.
 * - `eleven_multilingual_v2`: 29 langs, 10k chars, most lifelike/consistent.
 *   Supports SSML `<break>` pauses. No audio tags.
 * - `eleven_flash_v2_5` / `eleven_turbo_v2_5`: 32 langs (29 + hu/no/vi),
 *   40k chars, ~75ms latency. Flash is recommended over Turbo by ElevenLabs.
 * - `eleven_v3`: 70+ langs, audio tags (`[whispers]`, `[Mexican accent]`,
 *   `[pause]`…) for native accent/effect direction, 5k chars, higher latency
 *   and more variable consistency.
 * - Gemini TTS (Flash/Pro preview): 100+ langs, auto-detects the language,
 *   fully director-prompted (Audio Profile + Scene + Director's Notes +
 *   Transcript + audio tags). Universal fallback when no ElevenLabs model
 *   covers the requested language or the text exceeds provider limits.
 *
 * All exports are pure/deterministic (no network, no clock) so they are
 * trivially unit-testable.
 */

'use strict';

// ─── Languages ──────────────────────────────────────────────────────────────
// `eleven`: ISO-639-3 code used in ElevenLabs docs. `multilingual`/`flash`
// flags mirror the official 29/32-language lists; everything else is v3+ only
// and auto-routes to eleven_v3 (<=5k chars) or Gemini.
const VOICE_LANGUAGES = [
  { name: 'English', native: 'English', eleven: 'eng', bcp47: 'en-US', multilingual: true, flash: true },
  { name: 'Spanish', native: 'Español', eleven: 'spa', bcp47: 'es-ES', multilingual: true, flash: true },
  { name: 'German', native: 'Deutsch', eleven: 'deu', bcp47: 'de-DE', multilingual: true, flash: true },
  { name: 'French', native: 'Français', eleven: 'fra', bcp47: 'fr-FR', multilingual: true, flash: true },
  { name: 'Portuguese', native: 'Português', eleven: 'por', bcp47: 'pt-BR', multilingual: true, flash: true },
  { name: 'Italian', native: 'Italiano', eleven: 'ita', bcp47: 'it-IT', multilingual: true, flash: true },
  { name: 'Dutch', native: 'Nederlands', eleven: 'nld', bcp47: 'nl-NL', multilingual: true, flash: true },
  { name: 'Polish', native: 'Polski', eleven: 'pol', bcp47: 'pl-PL', multilingual: true, flash: true },
  { name: 'Russian', native: 'Русский', eleven: 'rus', bcp47: 'ru-RU', multilingual: true, flash: true },
  { name: 'Ukrainian', native: 'Українська', eleven: 'ukr', bcp47: 'uk-UA', multilingual: true, flash: true },
  { name: 'Turkish', native: 'Türkçe', eleven: 'tur', bcp47: 'tr-TR', multilingual: true, flash: true },
  { name: 'Arabic', native: 'العربية', eleven: 'ara', bcp47: 'ar-SA', multilingual: true, flash: true },
  { name: 'Hindi', native: 'हिन्दी', eleven: 'hin', bcp47: 'hi-IN', multilingual: true, flash: true },
  { name: 'Japanese', native: '日本語', eleven: 'jpn', bcp47: 'ja-JP', multilingual: true, flash: true },
  { name: 'Chinese', native: '中文', eleven: 'cmn', bcp47: 'cmn-CN', multilingual: true, flash: true },
  { name: 'Korean', native: '한국어', eleven: 'kor', bcp47: 'ko-KR', multilingual: true, flash: true },
  { name: 'Indonesian', native: 'Bahasa Indonesia', eleven: 'ind', bcp47: 'id-ID', multilingual: true, flash: true },
  { name: 'Swedish', native: 'Svenska', eleven: 'swe', bcp47: 'sv-SE', multilingual: true, flash: true },
  { name: 'Bulgarian', native: 'Български', eleven: 'bul', bcp47: 'bg-BG', multilingual: true, flash: true },
  { name: 'Romanian', native: 'Română', eleven: 'ron', bcp47: 'ro-RO', multilingual: true, flash: true },
  { name: 'Czech', native: 'Čeština', eleven: 'ces', bcp47: 'cs-CZ', multilingual: true, flash: true },
  { name: 'Greek', native: 'Ελληνικά', eleven: 'ell', bcp47: 'el-GR', multilingual: true, flash: true },
  { name: 'Finnish', native: 'Suomi', eleven: 'fin', bcp47: 'fi-FI', multilingual: true, flash: true },
  { name: 'Croatian', native: 'Hrvatski', eleven: 'hrv', bcp47: 'hr-HR', multilingual: true, flash: true },
  { name: 'Malay', native: 'Bahasa Melayu', eleven: 'msa', bcp47: 'ms-MY', multilingual: true, flash: true },
  { name: 'Slovak', native: 'Slovenčina', eleven: 'slk', bcp47: 'sk-SK', multilingual: true, flash: true },
  { name: 'Danish', native: 'Dansk', eleven: 'dan', bcp47: 'da-DK', multilingual: true, flash: true },
  { name: 'Tamil', native: 'தமிழ்', eleven: 'tam', bcp47: 'ta-IN', multilingual: true, flash: true },
  { name: 'Filipino', native: 'Filipino', eleven: 'fil', bcp47: 'fil-PH', multilingual: true, flash: true },
  { name: 'Hungarian', native: 'Magyar', eleven: 'hun', bcp47: 'hu-HU', multilingual: false, flash: true },
  { name: 'Norwegian', native: 'Norsk', eleven: 'nor', bcp47: 'nb-NO', multilingual: false, flash: true },
  { name: 'Vietnamese', native: 'Tiếng Việt', eleven: 'vie', bcp47: 'vi-VN', multilingual: false, flash: true },
  // v3 / Gemini only (NOT covered by multilingual/flash — previously broken):
  { name: 'Hebrew', native: 'עברית', eleven: 'heb', bcp47: 'he-IL', multilingual: false, flash: false },
  { name: 'Catalan', native: 'Català', eleven: 'cat', bcp47: 'ca-ES', multilingual: false, flash: false },
  { name: 'Bengali', native: 'বাংলা', eleven: 'ben', bcp47: 'bn-BD', multilingual: false, flash: false },
  { name: 'Afrikaans', native: 'Afrikaans', eleven: 'afr', bcp47: 'af-ZA', multilingual: false, flash: false },
  { name: 'Armenian', native: 'Հայերեն', eleven: 'hye', bcp47: 'hy-AM', multilingual: false, flash: false },
  { name: 'Assamese', native: 'অসমীয়া', eleven: 'asm', bcp47: 'as-IN', multilingual: false, flash: false },
  { name: 'Azerbaijani', native: 'Azərbaycanca', eleven: 'aze', bcp47: 'az-AZ', multilingual: false, flash: false },
  { name: 'Belarusian', native: 'Беларуская', eleven: 'bel', bcp47: 'be-BY', multilingual: false, flash: false },
  { name: 'Serbian', native: 'Српски', eleven: 'srp', bcp47: 'sr-RS', multilingual: false, flash: false },
  { name: 'Thai', native: 'ไทย', eleven: 'tha', bcp47: 'th-TH', multilingual: false, flash: false },
  { name: 'Urdu', native: 'اردو', eleven: 'urd', bcp47: 'ur-PK', multilingual: false, flash: false },
  { name: 'Swahili', native: 'Kiswahili', eleven: 'swa', bcp47: 'sw-KE', multilingual: false, flash: false },
];

const LANGUAGE_BY_KEY = new Map();
for (const lang of VOICE_LANGUAGES) {
  for (const key of [lang.name, lang.native, lang.eleven, lang.bcp47]) {
    if (key) LANGUAGE_BY_KEY.set(String(key).toLowerCase(), lang);
  }
}

// ─── Accents (per language — the old fixed 6-item list is gone) ─────────────
// `tag`: Eleven v3 audio tag. `direction`: Gemini director's-note phrasing.
const VOICE_ACCENTS = {
  English: [
    { name: 'US', tag: '[American accent]', direction: 'General American English accent as heard in national US broadcasts' },
    { name: 'British', tag: '[British accent]', direction: 'British English accent as heard in London, England' },
    { name: 'Australian', tag: '[Australian accent]', direction: 'Australian English accent as heard in Sydney' },
    { name: 'Canadian', tag: '[Canadian accent]', direction: 'Canadian English accent as heard in Toronto' },
    { name: 'Indian', tag: '[Indian accent]', direction: 'Indian English accent as heard in Mumbai' },
    { name: 'Neutral', tag: '', direction: 'clear neutral English with no marked regional accent' },
  ],
  Spanish: [
    { name: 'Latino', tag: '[Latin American accent]', direction: 'neutral Latin American Spanish, clear pan-regional broadcast accent' },
    { name: 'Mexican', tag: '[Mexican accent]', direction: 'Mexican Spanish as spoken in Mexico City, with characteristic intonation and seseo' },
    { name: 'Spain', tag: '[Castilian accent]', direction: 'Castilian Spanish from Spain as heard in Madrid, with distinción (ceceo)' },
    { name: 'Argentino', tag: '[Argentinian accent]', direction: 'Rioplatense Spanish as spoken in Buenos Aires, with voseo and sh-like "ll/y"' },
    { name: 'Colombiano', tag: '[Colombian accent]', direction: 'Colombian Spanish as spoken in Bogotá, clear and formal Andean intonation' },
    { name: 'Neutral', tag: '', direction: 'clear neutral Spanish with no marked regional accent' },
  ],
  Portuguese: [
    { name: 'Brazilian', tag: '[Brazilian accent]', direction: 'Brazilian Portuguese as spoken in São Paulo' },
    { name: 'European', tag: '[European Portuguese accent]', direction: 'European Portuguese as spoken in Lisbon' },
    { name: 'Neutral', tag: '', direction: 'clear neutral Portuguese with no marked regional accent' },
  ],
  French: [
    { name: 'France', tag: '[French accent]', direction: 'Metropolitan French as heard in Paris' },
    { name: 'Quebec', tag: '[Quebecois accent]', direction: 'Quebec French as spoken in Montreal' },
    { name: 'Belgian', tag: '[Belgian accent]', direction: 'Belgian French as spoken in Brussels' },
    { name: 'Neutral', tag: '', direction: 'clear neutral French with no marked regional accent' },
  ],
  German: [
    { name: 'Standard', tag: '[German accent]', direction: 'Standard High German (Hochdeutsch) as heard in national broadcasts' },
    { name: 'Austrian', tag: '[Austrian accent]', direction: 'Austrian Standard German as spoken in Vienna' },
    { name: 'Swiss', tag: '[Swiss accent]', direction: 'Swiss Standard German as spoken in Zurich' },
    { name: 'Neutral', tag: '', direction: 'clear neutral German with no marked regional accent' },
  ],
  Italian: [
    { name: 'Standard', tag: '[Italian accent]', direction: 'Standard Italian as heard in Milan broadcasts' },
    { name: 'Northern', tag: '[Northern Italian accent]', direction: 'Northern Italian accent as heard in Milan' },
    { name: 'Southern', tag: '[Southern Italian accent]', direction: 'Southern Italian accent as heard in Naples' },
    { name: 'Neutral', tag: '', direction: 'clear neutral Italian with no marked regional accent' },
  ],
  Dutch: [
    { name: 'Standard', tag: '[Dutch accent]', direction: 'Standard Dutch (Algemeen Beschaafd Nederlands) as heard in Amsterdam' },
    { name: 'Flemish', tag: '[Flemish accent]', direction: 'Flemish Dutch as spoken in Antwerp' },
    { name: 'Neutral', tag: '', direction: 'clear neutral Dutch with no marked regional accent' },
  ],
  Arabic: [
    { name: 'Modern Standard', tag: '[Arabic accent]', direction: 'Modern Standard Arabic (Fusha) as used in Al Jazeera broadcasts' },
    { name: 'Egyptian', tag: '[Egyptian accent]', direction: 'Egyptian Arabic dialect as spoken in Cairo' },
    { name: 'Gulf', tag: '[Gulf accent]', direction: 'Gulf Arabic dialect as spoken in the UAE' },
    { name: 'Levantine', tag: '[Levantine accent]', direction: 'Levantine Arabic dialect as spoken in Beirut' },
  ],
  Hindi: [
    { name: 'Standard', tag: '[Hindi accent]', direction: 'Standard Hindi as heard in New Delhi broadcasts' },
    { name: 'Neutral', tag: '', direction: 'clear neutral Hindi with no marked regional accent' },
  ],
  Chinese: [
    { name: 'Mandarin Mainland', tag: '[Mandarin accent]', direction: 'Mainland Mandarin (Putonghua) as heard in Beijing broadcasts' },
    { name: 'Taiwanese', tag: '[Taiwanese Mandarin accent]', direction: 'Taiwanese Mandarin as spoken in Taipei' },
    { name: 'Neutral', tag: '', direction: 'clear neutral Mandarin with no marked regional accent' },
  ],
};

const GENERIC_ACCENTS = [
  { name: 'Neutral', tag: '', direction: '' },
  { name: 'Standard', tag: '', direction: '' },
  { name: 'Formal', tag: '[formal tone]', direction: 'formal, polished register of the language' },
];

const DEFAULT_ACCENT_BY_LANGUAGE = {
  English: 'US',
  Spanish: 'Latino',
  Portuguese: 'Brazilian',
  French: 'France',
  German: 'Standard',
  Italian: 'Standard',
  Dutch: 'Standard',
  Arabic: 'Modern Standard',
  Hindi: 'Standard',
  Chinese: 'Mandarin Mainland',
};

function accentsForLanguage(languageName) {
  const list = VOICE_ACCENTS[String(languageName || '')];
  if (Array.isArray(list) && list.length) return list.map((a) => ({ ...a }));
  return GENERIC_ACCENTS.map((a) => ({
    ...a,
    direction: a.direction || `clear neutral ${String(languageName || 'speech')} with no marked regional accent`,
  }));
}

function defaultAccentForLanguage(languageName) {
  return DEFAULT_ACCENT_BY_LANGUAGE[String(languageName || '')] || 'Neutral';
}

// ─── Effects ────────────────────────────────────────────────────────────────
// Kept to the 6 existing names (no UI breakage) but each now carries a real
// per-provider behaviour instead of a single prompt fragment.
const VOICE_EFFECTS = [
  {
    name: 'None',
    description: 'Voz tal cual, sin dirección de audio.',
    elevenTag: '',
    elevenStyleDelta: 0,
    openaiSpeedDelta: 0,
    geminiScene: '',
    geminiStyle: '',
  },
  {
    name: 'Studio Clean',
    description: 'Cabina tratada: primer plano, sin ruido, máxima inteligibilidad.',
    elevenTag: '[clean studio recording]',
    elevenStyleDelta: 0,
    openaiSpeedDelta: 0,
    geminiScene: 'A professionally treated recording booth: dry, close-miked, silent background.',
    geminiStyle: 'Pristine studio delivery. Crisp consonants, controlled breaths, flat noise floor, broadcast clarity.',
  },
  {
    name: 'Warm',
    description: 'Íntima y cercana, presencia cálida de medios-graves.',
    elevenTag: '[warm tone]',
    elevenStyleDelta: 0.1,
    openaiSpeedDelta: -0.03,
    geminiScene: 'A small warm vocal booth, intimate late-night radio atmosphere.',
    geminiStyle: 'Warm intimate delivery: slightly lowered pitch energy, soft onset consonants, close and personal tone.',
  },
  {
    name: 'Cinematic',
    description: 'Tráiler dramático: dinámica amplia, pausas marcadas.',
    elevenTag: '[dramatic tone]',
    elevenStyleDelta: 0.25,
    openaiSpeedDelta: -0.08,
    geminiScene: 'A cinematic trailer stage: vast dynamic range, dramatic pauses, larger-than-life presence.',
    geminiStyle: 'Dramatic cinematic delivery: deliberate pacing, weighted pauses before key words, swelling emphasis, powerful projection without shouting.',
  },
  {
    name: 'Narration',
    description: 'Audiolibro/documental: cadencia estable y articulación cuidada.',
    elevenTag: '[calm narration]',
    elevenStyleDelta: 0.05,
    openaiSpeedDelta: -0.05,
    geminiScene: 'A documentary narration session: steady, trustworthy storytelling pace.',
    geminiStyle: 'Measured audiobook narration: even cadence, careful articulation, gentle emphasis on meaning, never rushed.',
  },
  {
    name: 'Podcast',
    description: 'Conversacional: dos micros, energía natural de sobremesa.',
    elevenTag: '[conversational tone]',
    elevenStyleDelta: 0.15,
    openaiSpeedDelta: 0,
    geminiScene: 'A conversational podcast table: two microphones, relaxed natural energy.',
    geminiStyle: 'Conversational podcast delivery: natural energy, light smile in the voice, fluid phrasing with human hesitations kept minimal.',
  },
];

const EFFECT_BY_NAME = new Map(VOICE_EFFECTS.map((e) => [e.name.toLowerCase(), e]));

function effectByName(name) {
  return EFFECT_BY_NAME.get(String(name || '').toLowerCase()) || EFFECT_BY_NAME.get('studio clean');
}

// ─── Models ─────────────────────────────────────────────────────────────────
const VOICE_MODELS = [
  {
    id: 'eleven_v3',
    label: 'Eleven V3',
    provider: 'elevenlabs',
    badge: 'Expresivo',
    languages: '70+ idiomas',
    maxChars: 5000,
    latency: 'Alta',
    quality: 'Máxima expresividad',
    supportsAudioTags: true,
    supportsNativeStability: true,
    bestFor: ['Efectos', 'Acentos marcados', 'Actuación'],
    description: 'El modelo más expresivo. Acentos y efectos nativos con audio tags en 70+ idiomas.',
  },
  {
    id: 'eleven_multilingual_v2',
    label: 'Multilingual V2',
    provider: 'elevenlabs',
    badge: 'Natural',
    languages: '29 idiomas',
    maxChars: 10000,
    latency: 'Media',
    quality: 'La más natural y consistente',
    supportsAudioTags: false,
    supportsNativeStability: true,
    bestFor: ['Narración', 'Audiolibros', 'Calidad'],
    description: 'La voz más natural y consistente. Ideal para narración y audiolibros.',
  },
  {
    id: 'eleven_flash_v2_5',
    label: 'Flash V2.5',
    provider: 'elevenlabs',
    badge: 'Rápido',
    languages: '32 idiomas',
    maxChars: 40000,
    latency: '~75 ms',
    quality: 'Alta, optimizada',
    supportsAudioTags: false,
    supportsNativeStability: true,
    bestFor: ['Tiempo real', 'Textos largos', 'Velocidad'],
    description: 'Ultra-baja latencia y textos de hasta 40.000 caracteres. Recomendado sobre Turbo.',
  },
  {
    id: 'eleven_turbo_v2_5',
    label: 'Turbo V2.5',
    provider: 'elevenlabs',
    badge: 'Legacy',
    languages: '32 idiomas',
    maxChars: 40000,
    latency: '~300 ms',
    quality: 'Alta',
    supportsAudioTags: false,
    supportsNativeStability: true,
    bestFor: ['Compatibilidad'],
    description: 'Modelo de baja latencia de primera generación. ElevenLabs recomienda Flash V2.5.',
  },
  {
    id: 'gemini-2.5-flash-preview-tts',
    label: 'Gemini Flash TTS',
    provider: 'gemini',
    badge: 'Versátil',
    languages: '100+ idiomas',
    maxChars: 32000,
    latency: 'Media',
    quality: 'Alta, dirigible',
    supportsAudioTags: true,
    supportsNativeStability: false,
    bestFor: ['Cualquier idioma', 'Fallback universal'],
    description: 'Cobertura universal de idiomas con dirección actoral por prompt. Fallback automático.',
  },
  {
    id: 'gemini-2.5-pro-preview-tts',
    label: 'Gemini Pro TTS',
    provider: 'gemini',
    badge: 'Estudio',
    languages: '100+ idiomas',
    maxChars: 32000,
    latency: 'Alta',
    quality: 'Máxima con prompts complejos',
    supportsAudioTags: true,
    supportsNativeStability: false,
    bestFor: ['Calidad máxima', 'Dirección compleja'],
    description: 'Máxima fidelidad a direcciones de estilo complejas en 100+ idiomas.',
  },
  {
    id: 'tts-1',
    label: 'OpenAI TTS',
    provider: 'openai',
    badge: 'Directo',
    languages: 'Multilingüe',
    maxChars: 4096,
    latency: 'Baja',
    quality: 'Alta, voces optimizadas EN',
    supportsAudioTags: false,
    supportsNativeStability: false,
    bestFor: ['Latencia', 'Voces OpenAI'],
    description: 'Síntesis directa de OpenAI. Voz con OPENAI_TTS_VOICE.',
  },
  {
    id: 'tts-1-hd',
    label: 'OpenAI TTS HD',
    provider: 'openai',
    badge: 'Calidad',
    languages: 'Multilingüe',
    maxChars: 4096,
    latency: 'Media',
    quality: 'Alta definición',
    supportsAudioTags: false,
    supportsNativeStability: false,
    bestFor: ['Calidad', 'Voces OpenAI'],
    description: 'Versión HD de OpenAI TTS. Voz con OPENAI_TTS_VOICE.',
  },
  {
    id: 'gpt-4o-mini-tts',
    label: 'GPT-4o mini TTS',
    provider: 'openai',
    badge: 'Dirigible',
    languages: 'Multilingüe',
    maxChars: 2000,
    latency: 'Baja',
    quality: 'Alta, dirigible por instrucciones',
    supportsAudioTags: false,
    supportsNativeStability: false,
    supportsInstructions: true,
    bestFor: ['Dirección por instrucciones', 'Tiempo real'],
    description: 'El TTS más nuevo de OpenAI: acepta instrucciones de estilo.',
  },
];

const MODEL_BY_ID = new Map(VOICE_MODELS.map((m) => [m.id, m]));

// Backward-compatible aliases from the old 2-option UI and the
// "ElevenLabs Turbo V2" label seen in the screenshot.
const MODEL_ALIASES = new Map([
  ['elevenlabs', 'eleven_multilingual_v2'],
  // Current frontend catalog labels (lib/voice-catalog.ts).
  ['multilingual v2', 'eleven_multilingual_v2'],
  ['eleven v3', 'eleven_v3'],
  ['flash v2.5', 'eleven_flash_v2_5'],
  ['turbo v2.5', 'eleven_turbo_v2_5'],
  ['gemini flash tts', 'gemini-2.5-flash-preview-tts'],
  ['gemini pro tts', 'gemini-2.5-pro-preview-tts'],
  ['elevenlabs turbo v2', 'eleven_turbo_v2_5'],
  ['elevenlabs turbo v2.5', 'eleven_turbo_v2_5'],
  ['eleven-turbo-v2', 'eleven_turbo_v2_5'],
  ['eleven_turbo_v2', 'eleven_turbo_v2_5'],
  ['eleven_turbo_v2_5', 'eleven_turbo_v2_5'],
  ['eleven_multilingual_v2', 'eleven_multilingual_v2'],
  ['eleven_flash_v2_5', 'eleven_flash_v2_5'],
  ['eleven_v3', 'eleven_v3'],
  ['gemini', 'gemini-2.5-flash-preview-tts'],
  ['gemini 2.5 flash tts', 'gemini-2.5-flash-preview-tts'],
  ['gemini-2.5-flash-preview-tts', 'gemini-2.5-flash-preview-tts'],
  ['gemini-2.5-pro-preview-tts', 'gemini-2.5-pro-preview-tts'],
  ['gemini pro', 'gemini-2.5-pro-preview-tts'],
  ['mimo', 'gemini-2.5-flash-preview-tts'],
  ['minimax', 'gemini-2.5-flash-preview-tts'],
  // OpenAI TTS family.
  ['openai', 'tts-1'],
  ['openai tts', 'tts-1'],
  ['openai tts hd', 'tts-1-hd'],
  ['tts-1', 'tts-1'],
  ['tts-1-hd', 'tts-1-hd'],
  ['gpt-4o-mini-tts', 'gpt-4o-mini-tts'],
  ['gpt-4o mini tts', 'gpt-4o-mini-tts'],
]);

function resolveModelId(raw) {
  const key = String(raw || '').trim().toLowerCase();
  if (!key) return 'eleven_multilingual_v2';
  if (MODEL_BY_ID.has(String(raw).trim())) return String(raw).trim();
  return MODEL_ALIASES.get(key) || 'eleven_multilingual_v2';
}

function modelById(id) {
  return MODEL_BY_ID.get(String(id || '')) || MODEL_BY_ID.get('eleven_multilingual_v2');
}

function isKnownVoiceModelId(raw) {
  const id = String(raw || '').trim();
  return MODEL_BY_ID.has(id) || MODEL_ALIASES.has(id.toLowerCase());
}

function languageSupportsElevenModel(lang, modelId) {
  if (!lang) return false;
  if (modelId === 'eleven_v3') return true; // 70+ langs covers the whole catalog
  if (modelId === 'eleven_flash_v2_5' || modelId === 'eleven_turbo_v2_5') return Boolean(lang.flash);
  if (modelId === 'eleven_multilingual_v2') return Boolean(lang.multilingual);
  return false;
}

// OpenAI TTS auto-detects the input language — every catalog language renders.
function languageSupportsOpenAiModel(lang /* , modelId */) {
  return Boolean(lang);
}

// ─── Stability ──────────────────────────────────────────────────────────────
// ElevenLabs semantics: HIGH stability = consistent/monotone, LOW =
// expressive/variable. The slider (0-100) maps 1:1 to `stability`, while
// `similarity_boost` rises gently with stability and `style` does the
// opposite (style only shapes Multilingual/Flash/Turbo; v3 uses audio tags).
function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.75;
  return Math.min(1, Math.max(0, n));
}

function mapStabilityToElevenSettings(stability01, { effectStyleDelta = 0 } = {}) {
  const s = clamp01(stability01);
  const style = Math.min(1, Math.max(0, (1 - s) * 0.65 + Number(effectStyleDelta || 0)));
  return {
    stability: Number(s.toFixed(3)),
    similarity_boost: Number((0.55 + 0.35 * s).toFixed(3)),
    style: Number(style.toFixed(3)),
    use_speaker_boost: s < 0.95,
  };
}

// OpenAI TTS has no stability knob — only `speed` (0.25–4.0). Professional
// mapping: the effect sets the base pace (dramatic reads slower), and the
// stability slider tilts it ±0.05 (expressive = slightly quicker, ultra-stable
// = slightly slower and clearer). Always well inside the API range.
function mapStabilityToOpenAiSpeed(stability01, { effectSpeedDelta = 0 } = {}) {
  const s = clamp01(stability01);
  const speed = 1.0 + Number(effectSpeedDelta || 0) + (0.5 - s) * 0.1;
  return Number(Math.min(4.0, Math.max(0.25, speed)).toFixed(2));
}

function describeStability(stabilityPct) {
  const v = Number(stabilityPct);
  if (!Number.isFinite(v)) return 'Equilibrado';
  if (v < 25) return 'Muy expresivo';
  if (v < 50) return 'Expresivo';
  if (v < 75) return 'Equilibrado';
  if (v < 90) return 'Estable';
  return 'Ultra estable';
}

const STABILITY_PRESETS = [
  { name: 'Publicidad', value: 35, hint: 'Máxima expresividad para anuncios.' },
  { name: 'Conversación', value: 55, hint: 'Natural y dinámica para diálogo.' },
  { name: 'Narración', value: 80, hint: 'Estable y clara para narrar.' },
  { name: 'Audiolibro', value: 72, hint: 'Consistente en textos largos.' },
];

// ─── Normalisation ──────────────────────────────────────────────────────────
function normalizeLanguage(raw) {
  if (!raw) return VOICE_LANGUAGES[1]; // Spanish
  const hit = LANGUAGE_BY_KEY.get(String(raw).trim().toLowerCase());
  return hit || VOICE_LANGUAGES[1];
}

function normalizeAccent(raw, languageName) {
  const options = accentsForLanguage(languageName);
  const wanted = String(raw || '').trim().toLowerCase();
  if (wanted) {
    const hit = options.find((a) => a.name.toLowerCase() === wanted);
    if (hit) return { accent: hit, adjusted: false };
  }
  const fallbackName = defaultAccentForLanguage(languageName);
  const fallback = options.find((a) => a.name.toLowerCase() === String(fallbackName).toLowerCase())
    || options[0];
  return { accent: fallback, adjusted: Boolean(wanted) };
}

function normalizeEffect(raw) {
  return effectByName(raw);
}

function clampStabilityPct(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 100;
  return Math.min(100, Math.max(0, Math.round(n)));
}

// ─── The plan ───────────────────────────────────────────────────────────────
// resolveVoicePlan() is the ONE place that decides which provider/model
// actually renders the audio and how each control is honoured. It never
// throws for unknown inputs — it normalises + explains via `warnings`.
function resolveVoicePlan({
  text = '',
  model,
  modelId,
  language,
  accent,
  effect,
  stability,
  voiceSettings,
} = {}) {
  const warnings = [];
  const requestedRaw = String(modelId || model || '').trim();
  let canonicalId = resolveModelId(requestedRaw);
  if (requestedRaw && canonicalId === 'eleven_multilingual_v2' && !MODEL_BY_ID.has(requestedRaw)
    && !MODEL_ALIASES.has(requestedRaw.toLowerCase())) {
    warnings.push(`Modelo «${requestedRaw}» no reconocido: usando Multilingual V2.`);
  }

  const lang = normalizeLanguage(language);

  const { accent: accentEntry, adjusted: accentAdjusted } = normalizeAccent(accent, lang.name);
  if (accentAdjusted) {
    warnings.push(`Acento «${accent}» no disponible en ${lang.name}: usando «${accentEntry.name}».`);
  }

  const effectEntry = normalizeEffect(effect);
  const stabilityPct = clampStabilityPct(stability);
  const stability01 = stabilityPct / 100;

  let entry = modelById(canonicalId);

  // Legacy Turbo V2 normalisation — runs BEFORE the capability gates so they
  // operate on the real target model. `eleven_turbo_v2` is English-only and
  // deprecated by ElevenLabs in favour of Flash. The screenshot bug:
  // "ElevenLabs Turbo V2" + Spanish could never synthesise.
  // An explicit new-catalog "Turbo V2.5" pick (contains "2.5") is honoured.
  if (/turbo.?v2/i.test(requestedRaw) && !/2[._]5/.test(requestedRaw)) {
    warnings.push('Turbo V2 está descatalogado y solo soportaba inglés: usando Flash V2.5 automáticamente.');
    canonicalId = 'eleven_flash_v2_5';
    entry = modelById(canonicalId);
  }

  // Capability gate 1 — language coverage (fixes the Turbo-V2 + Spanish bug).
  if (entry.provider === 'elevenlabs' && !languageSupportsElevenModel(lang, entry.id)) {
    if (lang.multilingual || lang.flash) {
      const upgraded = lang.flash ? 'eleven_flash_v2_5' : 'eleven_multilingual_v2';
      warnings.push(
        `${entry.label} no soporta ${lang.name}: usando ${modelById(upgraded).label} automáticamente.`,
      );
      canonicalId = upgraded;
      entry = modelById(upgraded);
    } else {
      // v3-only language: v3 when it fits, otherwise the universal fallback.
      const textLen = String(text || '').length;
      if (textLen <= 5000 && textLen > 0) {
        warnings.push(`${entry.label} no soporta ${lang.name}: usando Eleven V3 automáticamente.`);
        canonicalId = 'eleven_v3';
        entry = modelById(canonicalId);
      } else {
        warnings.push(`${entry.label} no soporta ${lang.name}: usando Gemini Flash TTS automáticamente.`);
        canonicalId = 'gemini-2.5-flash-preview-tts';
        entry = modelById(canonicalId);
      }
    }
  }

  // Capability gate 2 — character limits. Overflow always lands on a model
  // that fits: Eleven Flash V2.5 (40k) for medium texts, Gemini Flash for
  // anything larger. (The chat route already caps at 5000 chars, so this is
  // defence in depth for programmatic callers.)
  const textLen = String(text || '').length;
  if (textLen > entry.maxChars) {
    if (entry.provider !== 'gemini' && textLen <= 40000 && entry.id !== 'eleven_flash_v2_5') {
      warnings.push(`Texto de ${textLen} caracteres supera el límite de ${entry.label} (${entry.maxChars}): usando Flash V2.5.`);
      canonicalId = 'eleven_flash_v2_5';
      entry = modelById(canonicalId);
    } else if (entry.provider !== 'gemini') {
      warnings.push(`Texto de ${textLen} caracteres supera los límites de ${entry.label}: usando Gemini Flash TTS.`);
      canonicalId = 'gemini-2.5-flash-preview-tts';
      entry = modelById(canonicalId);
    } else if (textLen <= 40000) {
      warnings.push(`Texto de ${textLen} caracteres supera el límite de ${entry.label} (${entry.maxChars}): usando Flash V2.5.`);
      canonicalId = 'eleven_flash_v2_5';
      entry = modelById(canonicalId);
    } else {
      warnings.push(`Texto de ${textLen} caracteres supera todos los límites de voz disponibles; el proveedor puede truncarlo.`);
    }
  }

  const voiceSettingsResolved = entry.provider === 'elevenlabs'
    ? {
      ...mapStabilityToElevenSettings(stability01, { effectStyleDelta: effectEntry.elevenStyleDelta }),
      ...(voiceSettings && typeof voiceSettings === 'object' ? voiceSettings : {}),
    }
    : undefined;

  // OpenAI shaping: `speed` always applies; `instructions` only exist on
  // gpt-4o-mini-tts (tts-1/tts-1-hd ignore them per OpenAI docs).
  const openaiSpeed = entry.provider === 'openai'
    ? mapStabilityToOpenAiSpeed(stability01, { effectSpeedDelta: effectEntry.openaiSpeedDelta })
    : undefined;
  const openaiInstructions = entry.provider === 'openai' && entry.supportsInstructions
    ? buildOpenAiInstructions({ language: lang.name, accent: accentEntry, effect: effectEntry, stability: stabilityPct })
    : undefined;

  // v3 audio-tag prefix: the ONLY native way to steer accent/effect on v3.
  // Conservative: only when the user moved away from Neutral/Studio-Clean, so
  // plain narrations never risk a tag being spoken aloud.
  let elevenTagPrefix = '';
  if (canonicalId === 'eleven_v3') {
    const tags = [];
    if (accentEntry.tag) tags.push(accentEntry.tag);
    if (effectEntry.elevenTag && effectEntry.name !== 'Studio Clean' && effectEntry.name !== 'None') {
      tags.push(effectEntry.elevenTag);
    }
    if (tags.length) elevenTagPrefix = `${tags.join(' ')} `;
  }

  return {
    provider: entry.provider,
    modelId: canonicalId,
    modelLabel: entry.label,
    language: lang.name,
    languageNative: lang.native,
    languageBcp47: lang.bcp47,
    accent: accentEntry.name,
    accentDirection: accentEntry.direction,
    effect: effectEntry.name,
    effectDescription: effectEntry.description,
    stability: stabilityPct,
    stabilityLabel: describeStability(stabilityPct),
    voiceSettings: voiceSettingsResolved,
    elevenTagPrefix,
    openaiSpeed,
    openaiInstructions,
    geminiVoiceHint: entry.provider === 'gemini',
    warnings,
    model: entry,
  };
}

// ─── Gemini director prompt ─────────────────────────────────────────────────
// Professional structure per Google's TTS prompting guide: preamble +
// Audio Profile + Scene + Director's Notes (Style/Pace/Accent) + Transcript.
// The transcript is ALWAYS delimited so the model never reads the directions.
function buildGeminiDirectorPrompt(transcript, { language, accent, effect, stability } = {}) {
  const text = String(transcript || '').trim();
  const lang = normalizeLanguage(language);
  const { accent: accentEntry } = normalizeAccent(accent, lang.name);
  const effectEntry = normalizeEffect(effect);
  const stabilityPct = clampStabilityPct(stability);
  const delivery = stabilityPct < 60 ? 'expressive and dynamic' : 'steady, natural and professional';
  const pace = stabilityPct < 35
    ? 'Highly expressive pacing: stretch key words, use dramatic pauses, let emotion move the tempo.'
    : stabilityPct < 60
      ? 'Natural conversational pacing with light dynamic variation.'
      : stabilityPct < 90
        ? 'Steady measured pacing: even cadence, careful articulation, never rushed.'
        : 'Very consistent pacing: metronome-steady cadence, uniform energy, maximum intelligibility.';

  const accentLine = accentEntry.direction
    ? `Accent: ${accentEntry.direction}.`
    : `Language: ${lang.name} (${lang.native}).`;
  const lines = [
    'You are a professional voice actor in a recording studio. Synthesize speech — do not explain, translate, or comment.',
    '',
    `Audio Profile: adult ${delivery} narrator, native-level ${lang.name} (${lang.native}) speaker.`,
    effectEntry.geminiScene ? `Scene: ${effectEntry.geminiScene}` : '',
    '',
    "Director's Notes:",
    effectEntry.geminiStyle ? `Style: ${effectEntry.geminiStyle}` : `Style: ${delivery} ${lang.name} narration.`,
    `Pace: ${pace}`,
    accentLine,
    'Fidelity: read the TRANSCRIPT exactly as written. Do not add, remove, translate, or explain any words.',
    '',
    'TRANSCRIPT:',
    text,
  ];
  return lines.filter((line) => line !== '').join('\n');
}

// ─── OpenAI instructions ────────────────────────────────────────────────────
// Short style direction for `gpt-4o-mini-tts` (the only OpenAI TTS model that
// accepts `instructions`; tts-1/tts-1-hd ignore them). Never includes the
// transcript — OpenAI takes it via the separate `input` field.
function buildOpenAiInstructions({ language, accent, effect, stability } = {}) {
  const lang = normalizeLanguage(
    typeof language === 'string' ? language : (language && language.name),
  );
  const entry = accent && typeof accent === 'object'
    ? accent
    : normalizeAccent(accent, lang.name).accent;
  const effectEntry = effect && typeof effect === 'object'
    ? effect
    : normalizeEffect(effect);
  const stabilityPct = clampStabilityPct(stability);
  const delivery = stabilityPct < 60 ? 'expressive and dynamic' : 'steady, natural and professional';
  const style = effectEntry.geminiStyle || `${delivery} ${lang.name} narration.`;
  return [
    `You are a professional ${lang.name} (${lang.native}) voice actor.`,
    entry.direction ? `Accent: ${entry.direction}.` : '',
    `Style: ${style}`,
    `Delivery: ${delivery}. Read exactly the given text — do not add, translate, or explain anything.`,
  ].filter((line) => line !== '').join(' ');
}

module.exports = {
  VOICE_LANGUAGES,
  VOICE_ACCENTS,
  VOICE_EFFECTS,
  VOICE_MODELS,
  STABILITY_PRESETS,
  accentsForLanguage,
  defaultAccentForLanguage,
  effectByName,
  resolveModelId,
  modelById,
  isKnownVoiceModelId,
  languageSupportsElevenModel,
  languageSupportsOpenAiModel,
  mapStabilityToElevenSettings,
  mapStabilityToOpenAiSpeed,
  describeStability,
  normalizeLanguage,
  normalizeAccent,
  normalizeEffect,
  clampStabilityPct,
  resolveVoicePlan,
  buildGeminiDirectorPrompt,
  buildOpenAiInstructions,
};
