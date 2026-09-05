'use strict';

/**
 * Sira Voz pipelines — orchestrate VoiceStudio for the studio features and
 * leave the results where the existing media routes already serve them:
 *   audio  → <UPLOAD_DIR>/audio/…   (GET /api/elevenlabs/audio/:filename, Range-aware)
 *   video  → <UPLOAD_DIR>/videos/…  (GET /api/video/watch/:filename, Range-aware)
 *
 * Every pipeline receives the job `ctx` from services/voice-studio/jobs.js
 * ({ jobId, signal, progress() }) and resolves with the public result object.
 */

const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');

const voiceStudio = require('../ai/voicestudio-client');
const translate = require('./translate');
const chatPersistence = require('./chat-persistence');

const uploadRoot = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.resolve(__dirname, '../../../uploads');
const audioDir = path.join(uploadRoot, 'audio');
const videosDir = path.join(uploadRoot, 'videos');

const MODEL_LABEL = 'Sira Voz';

function outputName(prefix, ext) {
  return `siravoz-${prefix}-${Date.now()}-${randomUUID().replace(/-/g, '').slice(0, 10)}.${ext}`;
}

function formatClock(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function srtTimestamp(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const ms = Math.round((total - Math.floor(total)) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function segmentsToSrt(segments = []) {
  return segments
    .filter((s) => String(s.text || '').trim())
    .map((s, i) => `${i + 1}\n${srtTimestamp(s.start)} --> ${srtTimestamp(s.end)}\n${String(s.text).trim()}\n`)
    .join('\n');
}

function languageSpanish(value) {
  const name = voiceStudio.languageName(value);
  const map = {
    English: 'inglés', Spanish: 'español', German: 'alemán', French: 'francés', Portuguese: 'portugués', Italian: 'italiano',
    Chinese: 'chino', Japanese: 'japonés', Korean: 'coreano', Arabic: 'árabe', Russian: 'ruso', Dutch: 'neerlandés', Polish: 'polaco',
    Turkish: 'turco', Hindi: 'hindi', Catalan: 'catalán', Quechua: 'quechua', Afrikaans: 'afrikáans', Armenian: 'armenio',
    Assamese: 'asamés', Azerbaijani: 'azerí', Belarusian: 'bielorruso', Bengali: 'bengalí', Auto: 'automático',
  };
  return map[name] || name;
}

// ── Transcription (synchronous, used by the route directly) ────────────────

async function transcribeFile({ filePath, filename, mime, language = null, signal } = {}, options = {}) {
  const result = await voiceStudio.transcribe({ filePath, filename, mime, language, signal }, options);
  return {
    text: result.text,
    language: result.language,
    duration: result.duration,
    segments: result.segments,
    srt: segmentsToSrt(result.segments),
    model: 'Sira Voz · WhisperX',
  };
}

// ── Dubbing ────────────────────────────────────────────────────────────────

function prepStageLabel(evt) {
  switch (evt?.type) {
    case 'download_start':
    case 'download_progress':
      return { stage: 'descargando el vídeo', progress: 4 };
    case 'extract_start':
      return { stage: 'extrayendo el audio', progress: 6 };
    case 'extract_done':
      return { stage: 'audio extraído', progress: 9 };
    case 'demucs_start':
      return { stage: 'separando voces y música', progress: 10 };
    case 'demucs_done':
      return { stage: 'voces separadas', progress: 16 };
    case 'scene_start':
      return { stage: 'detectando escenas', progress: 18 };
    case 'scene_done':
      return { stage: 'escenas detectadas', progress: 20 };
    default:
      return null;
  }
}

function buildDubSegments(segments, translated, { voiceProfileId = null } = {}) {
  const byId = new Map(translated.map((t) => [String(t.id), t.text]));
  return segments
    .map((seg) => {
      const text = String(byId.get(String(seg.id)) ?? seg.text ?? '').trim();
      if (!text) return null;
      const speaker = String(seg.speaker_id || seg.speaker || '').trim();
      const profileId = voiceProfileId
        ? voiceProfileId
        : speaker
          ? `auto:${speaker}`
          : `auto-seg:${seg.id}`;
      return {
        start: Number(seg.start) || 0,
        end: Math.max(Number(seg.end) || 0, (Number(seg.start) || 0) + 0.2),
        text,
        profile_id: profileId,
      };
    })
    .filter(Boolean);
}

/**
 * ctx: { jobId, signal, progress }
 * input: { sourcePath, filename, mime, inputType, targetLanguage, sourceLanguage,
 *          voiceProfileId, voiceLabel, numSpeakers, keepBackground, userId, chatId, title }
 */
async function runDubJob(ctx, input, options = {}) {
  const { signal } = ctx;
  const inputType = input.inputType === 'audio' ? 'audio' : 'video';
  const targetName = voiceStudio.languageName(input.targetLanguage);
  const targetCode = voiceStudio.languageCode(input.targetLanguage) || 'es';

  await ctx.progress({ stage: 'subiendo a Sira Voz', progress: 2 });
  const upload = await voiceStudio.dubUpload({
    filePath: input.sourcePath,
    filename: input.filename,
    mime: input.mime,
    inputType,
    sourceLang: input.sourceLanguage,
    signal,
  }, options);
  const vsJobId = upload.job_id;
  const prepTaskId = upload.task_id;
  await ctx.progress({ stage: 'preparando el audio', progress: 5, result: { __private: { vsJobId } } });

  await voiceStudio.waitForDubReady(prepTaskId, {
    signal,
    onEvent: (evt) => {
      const mapped = prepStageLabel(evt);
      if (mapped) void ctx.progress(mapped);
    },
  }, options);

  await ctx.progress({ stage: 'transcribiendo (reconocimiento de voz)', progress: 24 });
  const transcript = await voiceStudio.dubTranscribe(vsJobId, { numSpeakers: input.numSpeakers || null, signal }, options);
  const segments = transcript.segments.filter((s) => String(s.text || '').trim());
  if (!segments.length) {
    throw Object.assign(new Error('No se detectó voz en el archivo. Prueba con un vídeo o audio con diálogo claro.'), { code: 'NO_SPEECH' });
  }
  const sourceLang = transcript.sourceLang || voiceStudio.languageCode(input.sourceLanguage) || null;

  await ctx.progress({ stage: `traduciendo ${segments.length} frases al ${languageSpanish(targetName)}`, progress: 44 });
  const translation = await translate.translateSegments(
    segments.map((s) => ({ id: s.id, text: s.text })),
    { targetLanguage: targetName, sourceLanguage: sourceLang, signal },
    options,
  );

  await ctx.progress({ stage: 'generando las voces dobladas', progress: 50 });
  const dubSegments = buildDubSegments(segments, translation.segments, { voiceProfileId: input.voiceProfileId || null });
  const generate = await voiceStudio.dubGenerate(vsJobId, {
    segments: dubSegments,
    language: targetName,
    language_code: targetCode,
    speed: 1.0,
    num_step: 16,
    guidance_scale: 2.0,
  }, { signal }, options);
  if (!generate.taskId) throw new Error('VoiceStudio no devolvió el identificador de la generación');

  const total = dubSegments.length;
  await voiceStudio.waitForDubDone(generate.taskId, {
    signal,
    onEvent: (evt) => {
      if (evt?.type === 'progress' && Number.isFinite(Number(evt.current)) && total > 0) {
        const fraction = Math.min(1, Math.max(0, Number(evt.current) / (Number(evt.total) || total)));
        void ctx.progress({ progress: 50 + Math.round(fraction * 40) });
      }
    },
  }, options);

  await ctx.progress({ stage: 'exportando el resultado', progress: 92 });
  let outputPath;
  let filename;
  let mime;
  let downloadUrl;
  if (inputType === 'video') {
    filename = outputName('doblaje', 'mp4');
    outputPath = path.join(videosDir, filename);
    await voiceStudio.dubDownloadVideo({ jobId: vsJobId, outPath: outputPath, defaultTrack: targetCode, preserveBg: input.keepBackground !== false, signal }, options);
    mime = 'video/mp4';
    downloadUrl = `/api/video/watch/${filename}`;
  } else {
    filename = outputName('doblaje', 'mp3');
    outputPath = path.join(audioDir, filename);
    // Audio-only jobs export through the same /dub/download endpoint with an
    // `out_format` container (the -audio route only emits WAV).
    await voiceStudio.dubDownloadVideo({ jobId: vsJobId, outPath: outputPath, defaultTrack: targetCode, preserveBg: input.keepBackground !== false, outFormat: 'mp3', signal }, options);
    mime = 'audio/mpeg';
    downloadUrl = `/api/elevenlabs/audio/${filename}`;
  }
  const stat = await fsPromises.stat(outputPath);

  let srt = '';
  try {
    srt = await voiceStudio.dubSubtitles({ jobId: vsJobId, format: 'srt', lang: targetCode, signal }, options);
  } catch {
    srt = segmentsToSrt(dubSegments);
  }
  const srtPath = `${outputPath}.srt`;
  await fsPromises.writeFile(srtPath, srt || segmentsToSrt(dubSegments)).catch(() => {});

  const durationSeconds = segments.length ? Math.max(...segments.map((s) => Number(s.end) || 0)) : null;
  const voiceLabel = input.voiceLabel || (input.voiceProfileId ? 'tu voz clonada' : 'clonación automática de los hablantes originales');
  const summary = [
    `**Doblaje al ${languageSpanish(targetName)} listo** (Sira Voz, 100 % local).`,
    `- Frases dobladas: ${dubSegments.length}${durationSeconds ? ` · duración ${formatClock(durationSeconds)}` : ''}`,
    `- Voz: ${voiceLabel}`,
    `- Idioma original: ${sourceLang ? languageSpanish(voiceStudio.languageName(sourceLang)) : 'detectado automáticamente'} · traducción: ${translation.engine === 'sira-llm' ? 'Sira' : translation.engine === 'nllb' ? 'traductor local' : 'sin cambios'}`,
    input.keepBackground === false ? '- Pista de fondo: eliminada' : '- Música y ambiente originales conservados',
  ].join('\n');

  const result = {
    kind: 'dub',
    filename,
    mime,
    sizeBytes: stat.size,
    downloadUrl,
    subtitlesUrl: null,
    targetLanguage: targetName,
    sourceLanguage: sourceLang,
    segments: dubSegments.length,
    durationSeconds,
    translationEngine: translation.engine,
    summary,
    __private: { vsJobId, outputPath, srtPath },
  };

  if (input.chatId && input.userId) {
    try {
      const files = inputType === 'video'
        ? [chatPersistence.buildVideoFileSnapshot({ filename, originalName: `${path.parse(input.filename || 'video').name}-${targetCode}.mp4`, sizeBytes: stat.size, url: downloadUrl, durationSeconds })]
        : null;
      const content = inputType === 'video'
        ? summary
        : chatPersistence.agentTaskStateBlock(chatPersistence.buildAudioArtifactState({
          goal: `Doblaje al ${languageSpanish(targetName)} de ${input.filename || 'audio'}`,
          label: 'Doblaje generado',
          tool: 'dub_audio',
          finalText: summary,
          artifact: chatPersistence.buildAudioArtifact({
            id: `dub-${filename}`,
            filename: `${path.parse(input.filename || 'audio').name}-${targetCode}.mp3`,
            mime,
            format: 'mp3',
            sizeBytes: stat.size,
            downloadUrl,
            prompt: `Doblaje al ${languageSpanish(targetName)}`,
            kind: 'dub',
          }),
        }));
      result.messageId = await chatPersistence.persistAssistantTurn({
        userId: input.userId,
        chatId: input.chatId,
        content,
        files,
        metadata: { voiceStudioJobId: ctx.jobId, kind: 'dub' },
      });
    } catch (err) {
      result.persistWarning = String(err?.message || err).slice(0, 200);
    }
  }
  return result;
}

// ── Audiobooks ─────────────────────────────────────────────────────────────

/**
 * input: { text?, sourcePath?, filename?, mime?, title, author, voiceProfileId,
 *          voiceLabel, language, format, userId, chatId }
 */
async function runAudiobookJob(ctx, input, options = {}) {
  const { signal } = ctx;
  let text = String(input.text || '').trim();
  let chapters = 0;
  if (!text && input.sourcePath) {
    await ctx.progress({ stage: 'importando el libro', progress: 3 });
    const imported = await voiceStudio.audiobookImport({ filePath: input.sourcePath, filename: input.filename, mime: input.mime, signal }, options);
    text = imported.text;
    chapters = imported.chapters;
  }
  if (!text) throw Object.assign(new Error('El audiolibro necesita texto o un archivo (.txt, .md, .epub, .pdf).'), { code: 'TEXT_REQUIRED' });

  const format = input.format === 'mp3' ? 'mp3' : 'm4b';
  const title = String(input.title || path.parse(input.filename || '').name || 'Audiolibro').trim().slice(0, 160);
  const author = String(input.author || '').trim().slice(0, 160);
  await ctx.progress({ stage: 'generando los capítulos', progress: 8 });

  let totalChapters = chapters || 0;
  const done = await voiceStudio.audiobookRender({
    text,
    defaultVoice: input.voiceProfileId || null,
    language: input.language || null,
    format,
    bitrate: '128k',
    metadata: { title, ...(author ? { artist: author, album_artist: author } : {}), album: title, genre: 'Audiobook', comment: 'Generado con Sira Voz' },
    signal,
    onEvent: (evt) => {
      if (evt?.type === 'started' && Number(evt.chapters) > 0) {
        totalChapters = Number(evt.chapters);
        void ctx.progress({ stage: `narrando ${totalChapters} capítulo${totalChapters === 1 ? '' : 's'}`, progress: 10 });
      } else if (evt?.type === 'chapter' && Number.isFinite(Number(evt.index))) {
        const total = Number(evt.total) || totalChapters || 1;
        const fraction = Math.min(1, (Number(evt.index) + 1) / total);
        void ctx.progress({ stage: `capítulo ${Number(evt.index) + 1} de ${total} listo`, progress: 10 + Math.round(fraction * 78) });
      } else if (evt?.type === 'assembling') {
        void ctx.progress({ stage: 'uniendo los capítulos', progress: 90 });
      } else if (evt?.type === 'mastering') {
        void ctx.progress({ stage: 'masterizando el audio', progress: 93 });
      }
    },
  }, options);

  await ctx.progress({ stage: 'exportando el audiolibro', progress: 96 });
  const ext = format === 'mp3' ? 'mp3' : 'm4b';
  const filename = outputName('audiolibro', ext);
  const outputPath = path.join(audioDir, filename);
  await voiceStudio.downloadOutput(done.output, outputPath, { signal }, options);
  const stat = await fsPromises.stat(outputPath);
  const mime = format === 'mp3' ? 'audio/mpeg' : 'audio/mp4';
  const downloadUrl = `/api/elevenlabs/audio/${filename}`;
  const durationSeconds = Number(done.duration_s) || null;
  const renderedChapters = Number(done.chapters) || totalChapters || 0;
  const summary = [
    `**Audiolibro «${title}» listo** (Sira Voz, 100 % local).`,
    `- ${renderedChapters} capítulo${renderedChapters === 1 ? '' : 's'}${durationSeconds ? ` · duración ${formatClock(durationSeconds)}` : ''} · formato ${ext.toUpperCase()}`,
    `- Voz: ${input.voiceLabel || (input.voiceProfileId ? 'tu voz clonada' : 'voz predeterminada de Sira Voz')}`,
    author ? `- Autor: ${author}` : null,
  ].filter(Boolean).join('\n');

  const result = {
    kind: 'audiobook',
    filename,
    mime,
    sizeBytes: stat.size,
    downloadUrl,
    title,
    author: author || null,
    chapters: renderedChapters,
    durationSeconds,
    format: ext,
    summary,
    __private: { outputPath, output: done.output },
  };

  if (input.chatId && input.userId) {
    try {
      const content = chatPersistence.agentTaskStateBlock(chatPersistence.buildAudioArtifactState({
        goal: `Audiolibro: ${title}`,
        label: 'Audiolibro generado',
        tool: 'generate_audiobook',
        finalText: summary,
        artifact: chatPersistence.buildAudioArtifact({
          id: `audiobook-${filename}`,
          filename: `${title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'audiolibro'}.${ext}`,
          mime,
          format: ext,
          sizeBytes: stat.size,
          downloadUrl,
          prompt: `Audiolibro «${title}»`,
          kind: 'audiobook',
        }),
      }));
      result.messageId = await chatPersistence.persistAssistantTurn({
        userId: input.userId,
        chatId: input.chatId,
        content,
        metadata: { voiceStudioJobId: ctx.jobId, kind: 'audiobook' },
      });
    } catch (err) {
      result.persistWarning = String(err?.message || err).slice(0, 200);
    }
  }
  return result;
}

async function ensureOutputDirs() {
  await fsPromises.mkdir(audioDir, { recursive: true });
  await fsPromises.mkdir(videosDir, { recursive: true });
}

module.exports = {
  MODEL_LABEL,
  audioDir,
  videosDir,
  outputName,
  formatClock,
  segmentsToSrt,
  languageSpanish,
  buildDubSegments,
  prepStageLabel,
  transcribeFile,
  runDubJob,
  runAudiobookJob,
  ensureOutputDirs,
  fileExists: (p) => fs.existsSync(p),
};
