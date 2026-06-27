'use strict';

/**
 * audio-media-tools — agentic tools for AUDIO (text-to-speech) and MUSIC
 * (song) generation, matching the react-agent tool shape used by
 * task-tools.js / visual-media-tools.js:
 *
 *   { name, description, parameters, execute(args, ctx) → result }
 *
 * Why this module: ElevenLabs TTS + Music already exist as HTTP routes
 * (`/api/elevenlabs/text-to-speech`, `/api/elevenlabs/generate-music`),
 * but they were NOT exposed as agent tools — so a chat message like
 * "créame un audio narrando esto" or "una canción de 3 minutos" could
 * never reach them automatically. These tools close that gap: the agentic
 * chat runtime can now call them directly, the same way it calls
 * generate_image / generate_video.
 *
 * Both tools save their output through the shared artifact system
 * (saveArtifact → /api/agent/artifact/:id) and emit a `file_artifact`
 * event so the generated MP3 shows up as a downloadable, playable asset in
 * the chat bubble — no frontend changes required.
 *
 * Providers reused as-is (same contracts as the working routes):
 *   - TTS:   ElevenLabs SDK  client.textToSpeech.convert(voiceId, {...})
 *   - Music: ElevenLabs Music REST  POST https://api.elevenlabs.io/v1/music
 *
 * Graceful degradation: when ELEVENLABS_API_KEY is absent the tools return
 * a clear { ok:false, error } instead of throwing, so the agent can tell
 * the user the capability is not configured and continue.
 */

const crypto = require('crypto');
const { saveArtifact } = require('./task-tools');

const ELEVEN_API_BASE = process.env.ELEVENLABS_API_BASE || 'https://api.elevenlabs.io/v1';
// "Rachel" — a default ElevenLabs voice available to every account. Override
// per deployment with ELEVENLABS_DEFAULT_VOICE_ID.
const DEFAULT_VOICE_ID = process.env.ELEVENLABS_DEFAULT_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
const DEFAULT_TTS_MODEL = process.env.ELEVENLABS_TTS_MODEL || 'eleven_multilingual_v2';
const DEFAULT_MUSIC_MODEL = process.env.ELEVENLABS_MUSIC_MODEL || 'music_v1';
const MUSIC_OUTPUT_FORMAT = process.env.ELEVENLABS_MUSIC_FORMAT || 'mp3_44100_128';
const TTS_MAX_CHARS = 5000;

function clampInt(value, fallback, min, max) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

const MUSIC_MIN_SECONDS = clampInt(process.env.SIRAGPT_MUSIC_MIN_SECONDS, 5, 1, 60);
const MUSIC_MAX_SECONDS = clampInt(process.env.SIRAGPT_MUSIC_MAX_SECONDS, 300, 30, 900);

// ── Test seams (overridable so unit tests never hit the network) ─────────
let _clientFactory = null;
let _fetchImpl = null;

function getElevenClient() {
  if (_clientFactory) return _clientFactory();
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return null;
  let mod;
  try {
    // eslint-disable-next-line global-require
    mod = require('@elevenlabs/elevenlabs-js');
  } catch (err) {
    // The key IS set (guarded above), so this is a genuine SDK load failure —
    // log it so it isn't misreported to the user as "missing ELEVENLABS_API_KEY".
    console.warn('[audio-media-tools] ElevenLabs SDK require failed:', err && err.message);
    return null;
  }
  const Ctor = mod.ElevenLabsClient || mod.default || mod;
  try {
    return new Ctor({ apiKey: key });
  } catch (err) {
    console.warn('[audio-media-tools] ElevenLabs client construction failed:', err && err.message);
    return null;
  }
}

function getFetch() {
  if (_fetchImpl) return _fetchImpl;
  if (typeof fetch === 'function') return fetch;
  return null;
}

function emitEvent(ctx, type, data) {
  if (ctx && typeof ctx.onEvent === 'function') {
    try { ctx.onEvent({ type, ...data }); } catch { /* best-effort */ }
  }
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Collect an ElevenLabs/SDK/web stream (or buffer) into a Node Buffer. */
async function streamToBuffer(stream) {
  if (!stream) return Buffer.alloc(0);
  if (Buffer.isBuffer(stream)) return stream;
  if (stream instanceof Uint8Array) return Buffer.from(stream);
  if (typeof stream.arrayBuffer === 'function') return Buffer.from(await stream.arrayBuffer());
  if (typeof stream[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  if (typeof stream.getReader === 'function') {
    const reader = stream.getReader();
    const chunks = [];
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(Buffer.from(value));
      }
    } finally {
      // Release the stream even if read() throws mid-collection, so a
      // failed TTS/audio fetch doesn't leak the underlying socket.
      try { reader.cancel(); } catch (_) { /* ignore */ }
    }
    return Buffer.concat(chunks);
  }
  return Buffer.alloc(0);
}

function saveAudioArtifact({ filename, buffer, mime, ctx, category }) {
  return saveArtifact({
    filename,
    base64: buffer.toString('base64'),
    mime,
    ownerUserId: ctx && ctx.userId,
    chatId: ctx && ctx.chatId,
    // Tag the library category so the file-library Audio / Música tabs can
    // tell spoken audio from generated music (both are audio/mpeg MP3s).
    category,
  });
}

function emitFileArtifact(ctx, artifact, format, mime) {
  emitEvent(ctx, 'file_artifact', {
    artifact: {
      id: artifact.id,
      filename: artifact.filename,
      format,
      mime,
      sizeBytes: artifact.sizeBytes,
      downloadUrl: artifact.downloadUrl,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Tool: generate_speech (text-to-speech)
// ─────────────────────────────────────────────────────────────────────────

const generateSpeech = {
  name: 'generate_speech',
  description: 'Convert text into natural spoken audio (text-to-speech) with ElevenLabs and save it as a downloadable, playable MP3 artifact in the chat. Use when the user asks for an "audio", "voz", "narración", "locución", "voiceover", "podcast" or "léeme/dilo en voz alta". Provide the exact text to speak.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The exact text to speak aloud (required). Up to ~5000 characters.' },
      voiceId: { type: 'string', description: 'Optional ElevenLabs voice id. Defaults to a multilingual voice.' },
      modelId: { type: 'string', description: 'Optional ElevenLabs model id. Default: eleven_multilingual_v2 (works in Spanish + 28 languages).' },
    },
    required: ['text'],
    additionalProperties: false,
  },
  async execute({ text, voiceId, modelId } = {}, ctx = {}) {
    emitEvent(ctx, 'tool_call', { tool: 'generate_speech', preview: text });
    const clean = String(text || '').trim();
    if (!clean) return { ok: false, error: 'El texto a narrar está vacío.' };

    const client = getElevenClient();
    if (!client) {
      const msg = 'La generación de voz no está disponible (falta configurar ELEVENLABS_API_KEY).';
      emitEvent(ctx, 'tool_output', { tool: 'generate_speech', ok: false, preview: msg });
      return { ok: false, error: msg };
    }

    try {
      emitEvent(ctx, 'tool_output', { tool: 'generate_speech', preview: 'Generando audio…', partial: true });
      const stream = await client.textToSpeech.convert(voiceId || DEFAULT_VOICE_ID, {
        text: clean.slice(0, TTS_MAX_CHARS),
        model_id: modelId || DEFAULT_TTS_MODEL,
        voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true },
      });
      const buffer = await streamToBuffer(stream);
      if (!buffer || !buffer.length) {
        const msg = 'El servicio de voz no devolvió audio. Reintenta con un texto más corto.';
        emitEvent(ctx, 'tool_output', { tool: 'generate_speech', ok: false, preview: msg });
        return { ok: false, error: msg };
      }

      const filename = `voz_${crypto.randomBytes(4).toString('hex')}.mp3`;
      const artifact = saveAudioArtifact({ filename, buffer, mime: 'audio/mpeg', ctx, category: 'audio' });
      emitFileArtifact(ctx, artifact, 'mp3', 'audio/mpeg');
      emitEvent(ctx, 'tool_output', {
        tool: 'generate_speech',
        ok: true,
        preview: `Audio listo: ${artifact.filename} (${Math.round(artifact.sizeBytes / 1024)} KB)`,
      });

      return {
        ok: true,
        id: artifact.id,
        filename: artifact.filename,
        sizeBytes: artifact.sizeBytes,
        downloadUrl: artifact.downloadUrl,
        mime: 'audio/mpeg',
        kind: 'speech',
        characters: clean.length,
        voiceId: voiceId || DEFAULT_VOICE_ID,
      };
    } catch (err) {
      const msg = (err && err.message) || String(err);
      emitEvent(ctx, 'tool_output', { tool: 'generate_speech', ok: false, preview: `Error: ${msg}` });
      return { ok: false, error: msg };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Tool: generate_music (song / track)
// ─────────────────────────────────────────────────────────────────────────

const generateMusic = {
  name: 'generate_music',
  description: 'Generate an original music track / song from a text description with ElevenLabs Music and save it as a downloadable, playable MP3 artifact in the chat. Use when the user asks for a "canción", "música", "melodía", "instrumental", "banda sonora", "jingle" or "song" — optionally with a duration (e.g. "una canción de 3 minutos" → durationSeconds 180) and a genre/mood.',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Description of the music: theme, mood, instruments, genre and lyrics direction.' },
      durationSeconds: {
        type: 'integer',
        minimum: MUSIC_MIN_SECONDS,
        maximum: MUSIC_MAX_SECONDS,
        description: `Target length in seconds (default 30). Clamped to [${MUSIC_MIN_SECONDS}, ${MUSIC_MAX_SECONDS}]. A 3-minute song = 180.`,
      },
      genre: { type: 'string', description: 'Optional genre/style hint: lofi, rock, pop, jazz, cinematic, reggaeton, ambient, épica, etc.' },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
  async execute({ prompt, durationSeconds, genre } = {}, ctx = {}) {
    emitEvent(ctx, 'tool_call', { tool: 'generate_music', preview: prompt });
    const cleanPrompt = String(prompt || '').trim();
    if (!cleanPrompt) return { ok: false, error: 'La descripción de la música está vacía.' };

    const key = process.env.ELEVENLABS_API_KEY;
    const doFetch = getFetch();
    if (!key || !doFetch) {
      const msg = !key
        ? 'La generación de música no está disponible (falta configurar ELEVENLABS_API_KEY).'
        : 'fetch no está disponible en este runtime.';
      emitEvent(ctx, 'tool_output', { tool: 'generate_music', ok: false, preview: msg });
      return { ok: false, error: msg };
    }

    const seconds = clampInt(durationSeconds, 30, MUSIC_MIN_SECONDS, MUSIC_MAX_SECONDS);
    let finalPrompt = cleanPrompt;
    if (genre && !new RegExp(escapeRe(genre), 'i').test(finalPrompt)) {
      finalPrompt = `${cleanPrompt}. Estilo/género: ${genre}.`;
    }

    try {
      emitEvent(ctx, 'tool_output', { tool: 'generate_music', preview: `Componiendo música (${seconds}s)…`, partial: true });
      const resp = await doFetch(`${ELEVEN_API_BASE}/music`, {
        method: 'POST',
        headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: finalPrompt,
          music_length_ms: seconds * 1000,
          model_id: DEFAULT_MUSIC_MODEL,
          output_format: MUSIC_OUTPUT_FORMAT,
        }),
        signal: ctx.signal,
      });

      if (!resp || !resp.ok) {
        const status = resp ? resp.status : 0;
        let detail = '';
        try { detail = resp && typeof resp.text === 'function' ? await resp.text() : ''; } catch (e) { console.warn('[audio-media-tools] failed to read music error body:', e && e.message); }
        const msg = status === 402
          ? 'Créditos insuficientes para generar música en ElevenLabs.'
          : `El servicio de música respondió ${status}. ${String(detail).slice(0, 200)}`.trim();
        emitEvent(ctx, 'tool_output', { tool: 'generate_music', ok: false, preview: msg });
        return { ok: false, error: msg, status };
      }

      const ab = await resp.arrayBuffer();
      const buffer = Buffer.from(ab);
      if (!buffer.length) {
        const msg = 'El servicio de música no devolvió audio.';
        emitEvent(ctx, 'tool_output', { tool: 'generate_music', ok: false, preview: msg });
        return { ok: false, error: msg };
      }

      const filename = `cancion_${crypto.randomBytes(4).toString('hex')}.mp3`;
      const artifact = saveAudioArtifact({ filename, buffer, mime: 'audio/mpeg', ctx, category: 'music' });
      emitFileArtifact(ctx, artifact, 'mp3', 'audio/mpeg');
      emitEvent(ctx, 'tool_output', {
        tool: 'generate_music',
        ok: true,
        preview: `Música lista: ${artifact.filename} (${seconds}s, ${Math.round(artifact.sizeBytes / 1024)} KB)`,
      });

      return {
        ok: true,
        id: artifact.id,
        filename: artifact.filename,
        sizeBytes: artifact.sizeBytes,
        downloadUrl: artifact.downloadUrl,
        mime: 'audio/mpeg',
        kind: 'music',
        durationSeconds: seconds,
        prompt: finalPrompt,
      };
    } catch (err) {
      const msg = (err && err.message) || String(err);
      emitEvent(ctx, 'tool_output', { tool: 'generate_music', ok: false, preview: `Error: ${msg}` });
      return { ok: false, error: msg };
    }
  },
};

const AUDIO_MEDIA_TOOLS = [generateSpeech, generateMusic];

module.exports = {
  AUDIO_MEDIA_TOOLS,
  generateSpeech,
  generateMusic,
  // Internal helpers exposed for unit testing only.
  _internal: {
    streamToBuffer,
    clampInt,
    getFetch,
    getElevenClient,
    setElevenLabsClientFactory: (fn) => { _clientFactory = fn; },
    setFetchImpl: (fn) => { _fetchImpl = fn; },
    resetTestSeams: () => { _clientFactory = null; _fetchImpl = null; },
    DEFAULT_VOICE_ID,
    DEFAULT_TTS_MODEL,
    DEFAULT_MUSIC_MODEL,
    MUSIC_MIN_SECONDS,
    MUSIC_MAX_SECONDS,
  },
};
