'use strict';

/**
 * Audio transcriber — extracts text from audio/video files
 * using OpenAI Whisper API.
 *
 * Supports: mp3, mp4, mpeg, wav, webm, ogg, m4a, mov
 *
 * Falls back gracefully when OPENAI_API_KEY is not set,
 * returning a descriptive placeholder for the file.
 *
 * Config:
 *   WHISPER_MODEL = whisper-1 (default)
 *   WHISPER_LANGUAGE = auto-detect (set to e.g. 'es' for Spanish)
 *   WHISPER_PROMPT = optional guiding prompt
 *   AUDIO_MAX_FILE_BYTES = 25 MB (OpenAI API limit)
 */

const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');

const WHISPER_MODEL = process.env.WHISPER_MODEL || 'whisper-1';
const WHISPER_LANGUAGE = process.env.WHISPER_LANGUAGE || undefined;
const AUDIO_MAX_FILE_BYTES = Number.parseInt(process.env.AUDIO_MAX_FILE_BYTES || String(25 * 1024 * 1024), 10);

const AUDIO_MIME_MAP = {
  'audio/mpeg': { ext: 'mp3', label: 'MP3 Audio' },
  'audio/wav': { ext: 'wav', label: 'WAV Audio' },
  'audio/ogg': { ext: 'ogg', label: 'OGG Audio' },
  'audio/webm': { ext: 'webm', label: 'WebM Audio' },
  'audio/mp4': { ext: 'mp4', label: 'MP4 Audio' },
  'video/mp4': { ext: 'mp4', label: 'MP4 Video' },
  'video/mpeg': { ext: 'mpeg', label: 'MPEG Video' },
  'video/quicktime': { ext: 'mov', label: 'QuickTime Video' },
  'video/webm': { ext: 'webm', label: 'WebM Video' },
};

/**
 * Transcribe an audio or video file using OpenAI Whisper.
 * Returns { text, method: 'whisper' | 'placeholder' }
 */
async function transcribe(filePath, mimeType, originalName) {
  const info = AUDIO_MIME_MAP[mimeType];
  const label = info ? info.label : 'Media File';
  const fileName = originalName || path.basename(filePath);

  // Check if OpenAI key is available
  if (!process.env.OPENAI_API_KEY) {
    return {
      text: generatePlaceholder(fileName, label, mimeType, 'OpenAI API key not configured'),
      method: 'placeholder',
    };
  }

  // Check file size
  let fileSize = 0;
  try {
    const stat = await fsPromises.stat(filePath);
    fileSize = stat.size;
  } catch {
    fileSize = 0;
  }

  if (fileSize > AUDIO_MAX_FILE_BYTES) {
    return {
      text: generatePlaceholder(fileName, label, mimeType, `File too large (${(fileSize / 1024 / 1024).toFixed(1)}MB > ${(AUDIO_MAX_FILE_BYTES / 1024 / 1024).toFixed(0)}MB)`),
      method: 'placeholder',
    };
  }

  // Try Whisper transcription
  try {
    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const fileBuffer = await fsPromises.readFile(filePath);

    // OpenAI needs the file as a proper Blob-like object with a name
    const blob = new File([fileBuffer], fileName, { type: mimeType || 'audio/mpeg' });

    const transcription = await openai.audio.transcriptions.create({
      model: WHISPER_MODEL,
      file: blob,
      language: WHISPER_LANGUAGE,
      response_format: 'verbose_json',
      timestamp_granularities: ['segment'],
    });

    const text = transcription.text || '';

    if (!text || text.trim().length < 10) {
      return {
        text: generatePlaceholder(fileName, label, mimeType, 'No speech detected'),
        method: 'whisper',
      };
    }

    const header = `${label} transcription — ${text.length} characters, ` +
      `model: ${WHISPER_MODEL}` +
      (WHISPER_LANGUAGE ? `, language: ${WHISPER_LANGUAGE}` : '') +
      `\n---\n`;

    return {
      text: header + text,
      method: 'whisper',
      segments: transcription.segments?.map(s => ({
        start: s.start,
        end: s.end,
        text: s.text,
      })) || [],
    };
  } catch (err) {
    console.warn(`[audio-transcriber] Whisper failed for ${fileName}: ${err.message}`);
    return {
      text: generatePlaceholder(fileName, label, mimeType, `Transcription failed: ${err.message}`),
      method: 'placeholder',
    };
  }
}

function generatePlaceholder(fileName, label, mimeType, reason) {
  return [
    `${label} — ${fileName}`,
    `Type: ${mimeType || 'unknown'}`,
    `Status: Transcription not available (${reason})`,
    '',
    'This media file has been uploaded for reference. To enable transcription:',
    '1. Set OPENAI_API_KEY in your environment',
    '2. Ensure the file is under 25 MB',
    '3. Supported formats: mp3, mp4, mpeg, wav, webm, ogg, m4a, mov',
  ].join('\n');
}

module.exports = { transcribe };