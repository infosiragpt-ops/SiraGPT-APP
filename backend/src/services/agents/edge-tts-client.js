'use strict';

/**
 * edge-tts-client — Microsoft Edge neural TTS (no API key).
 *
 * Same public Read Aloud WebSocket the Python `edge-tts` / `node-edge-tts`
 * clients use. Default voice is es-PE-CamilaNeural so Spanish narration
 * ("Juan vende papas en el mercado") is a real MP3 without ElevenLabs or
 * OpenAI. Injectable WebSocket + clock for unit tests; never hits the
 * network unless the caller uses the real `ws` constructor.
 */

const crypto = require('crypto');

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const WIN_EPOCH = 11644473600;
const SEC_MS_GEC_VERSION = '1-143.0.3650.75';
const CHROMIUM_MAJOR = '143';
const WSS_BASE = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
const DEFAULT_VOICE = process.env.SIRAGPT_EDGE_TTS_VOICE || 'es-PE-CamilaNeural';
const DEFAULT_TIMEOUT_MS = 30_000;
const CHUNK_CHARS = 3500;

const WSS_HEADERS = {
  Pragma: 'no-cache',
  'Cache-Control': 'no-cache',
  Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
  'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR}.0.0.0`,
  'Accept-Language': 'es-PE,es;q=0.9,en;q=0.8',
};

let _wsFactory = null;
let _nowSec = null;

function setWebSocketFactory(fn) {
  _wsFactory = fn;
}

function setNowSec(fn) {
  _nowSec = fn;
}

function resetTestSeams() {
  _wsFactory = null;
  _nowSec = null;
}

function currentUnixSec() {
  if (typeof _nowSec === 'function') return Number(_nowSec()) || 0;
  return Math.floor(Date.now() / 1000);
}

function generateSecMsGec(unixSec = currentUnixSec(), skewSec = 0) {
  let ticks = Number(unixSec) + Number(skewSec || 0) + WIN_EPOCH;
  ticks -= ticks % 300;
  const windowsTicks = ticks * 10_000_000;
  return crypto
    .createHash('sha256')
    .update(`${windowsTicks}${TRUSTED_CLIENT_TOKEN}`)
    .digest('hex')
    .toUpperCase();
}

function connectId() {
  return crypto.randomUUID().replace(/-/g, '');
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function sanitizeTtsText(value) {
  return String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ');
}

function inferLangFromVoice(voice) {
  const match = String(voice || '').match(/^([a-z]{2}-[A-Z]{2})-/);
  return match ? match[1] : 'es-PE';
}

function isEdgeVoiceId(voiceId) {
  return typeof voiceId === 'string' && /Neural/i.test(voiceId) && /^[a-z]{2}-[A-Z]{2}-/.test(voiceId);
}

function pickVoice(voiceId) {
  return isEdgeVoiceId(voiceId) ? voiceId : DEFAULT_VOICE;
}

function chunkText(text, maxChars = CHUNK_CHARS) {
  const clean = String(text || '').trim();
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];
  const chunks = [];
  let rest = clean;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf(' ', maxChars);
    if (cut < Math.floor(maxChars / 2)) cut = maxChars;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function buildSsml(text, voice) {
  const lang = inferLangFromVoice(voice);
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${escapeXml(lang)}">` +
    `<voice name="${escapeXml(voice)}">` +
    `<prosody pitch="+0Hz" rate="+0%" volume="+0%">${escapeXml(sanitizeTtsText(text))}</prosody>` +
    '</voice></speak>'
  );
}

function dateToString(now = new Date()) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${days[now.getUTCDay()]} ${months[now.getUTCMonth()]} ${pad(now.getUTCDate())} ` +
    `${now.getUTCFullYear()} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}` +
    ' GMT+0000 (Coordinated Universal Time)'
  );
}

function extractAudioFromBinary(raw) {
  if (!raw) return Buffer.alloc(0);
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  if (buf.length >= 2) {
    const headerLength = buf.readUInt16BE(0);
    const headerEnd = 2 + headerLength;
    if (headerEnd <= buf.length) {
      const header = buf.subarray(2, headerEnd).toString('utf8');
      if (/Path:\s*audio/i.test(header)) {
        const body = buf.subarray(headerEnd);
        if (!/Content-Type:\s*audio\//i.test(header)) return Buffer.alloc(0);
        return body;
      }
    }
  }
  const sep = Buffer.from('\r\n\r\n');
  const idx = buf.indexOf(sep);
  if (idx === -1) return Buffer.alloc(0);
  return buf.subarray(idx + 4);
}

function headerPath(text) {
  const match = String(text || '').match(/^Path:\s*(.+)$/im);
  return match ? match[1].trim() : '';
}

function loadWsCtor() {
  if (typeof _wsFactory === 'function') return _wsFactory();
  // eslint-disable-next-line global-require
  return require('ws');
}

function synthesizeChunk({ text, voice, timeoutMs, skewSec, signal }) {
  const Ws = loadWsCtor();
  const requestId = connectId();
  const url = (
    `${WSS_BASE}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
    `&Sec-MS-GEC=${generateSecMsGec(currentUnixSec(), skewSec)}` +
    `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}` +
    `&ConnectionId=${requestId}`
  );

  return new Promise((resolve, reject) => {
    let settled = false;
    const chunks = [];
    let timer = null;

    const finish = (err, buffer) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { ws.removeAllListeners(); } catch { /* ignore */ }
      try { ws.close(); } catch { /* ignore */ }
      if (err) reject(err);
      else resolve(buffer);
    };

    const ws = new Ws(url, {
      headers: {
        ...WSS_HEADERS,
        MUID: crypto.randomBytes(16).toString('hex').toUpperCase(),
      },
    });

    const onAbort = () => finish(Object.assign(new Error('La generación de voz se canceló.'), { code: 'ABORT_ERR' }));
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    timer = setTimeout(() => {
      finish(new Error('La generación de voz tardó demasiado. Reintenta con un texto más corto.'));
    }, timeoutMs);

    ws.on('unexpected-response', (_req, res) => {
      const status = res && res.statusCode;
      finish(new Error(`Edge TTS rechazó la conexión (HTTP ${status || '?'}).`));
    });

    ws.on('error', (err) => {
      finish(err instanceof Error ? err : new Error(String(err)));
    });

    ws.on('open', () => {
      const stamp = dateToString();
      ws.send(
        `X-Timestamp:${stamp}\r\n` +
        'Content-Type:application/json; charset=utf-8\r\n' +
        'Path:speech.config\r\n\r\n' +
        `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"${OUTPUT_FORMAT}"}}}}\r\n`
      );
      ws.send(
        `X-RequestId:${connectId()}\r\n` +
        'Content-Type:application/ssml+xml\r\n' +
        `X-Timestamp:${stamp}Z\r\n` +
        'Path:ssml\r\n\r\n' +
        buildSsml(text, voice)
      );
    });

    ws.on('message', (data, isBinary) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      // `ws` delivers text frames as Buffer with isBinary=false. Treating every
      // Buffer as audio would swallow Path:turn.end and hang until timeout.
      const preview = buf.subarray(0, Math.min(buf.length, 240)).toString('utf8');
      const looksLikeControl = /Path:\s*(turn\.end|turn\.start|response|audio\.metadata|speech\.config)/i.test(preview);
      const treatAsText = isBinary === false || (isBinary !== true && looksLikeControl);
      if (treatAsText) {
        if (headerPath(buf.toString('utf8')) === 'turn.end') {
          const buffer = Buffer.concat(chunks);
          if (!buffer.length) {
            finish(new Error('El servicio de voz no devolvió audio.'));
            return;
          }
          finish(null, buffer);
        }
        return;
      }
      const audio = extractAudioFromBinary(buf);
      if (audio.length) chunks.push(audio);
    });

    ws.on('close', () => {
      if (settled) return;
      const buffer = Buffer.concat(chunks);
      if (buffer.length) finish(null, buffer);
      else finish(new Error('La conexión de voz se cerró sin audio.'));
    });
  });
}

async function synthesizeEdgeSpeech(text, opts = {}) {
  const clean = String(text || '').trim();
  if (!clean) {
    const err = new Error('El texto a narrar está vacío.');
    err.code = 'empty_text';
    throw err;
  }

  const voice = pickVoice(opts.voice);
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const parts = chunkText(clean, opts.chunkChars || CHUNK_CHARS);
  const buffers = [];

  for (const part of parts) {
    let lastErr = null;
    let ok = null;
    for (const skewSec of [0, -300, 300]) {
      try {
        ok = await synthesizeChunk({
          text: part,
          voice,
          timeoutMs,
          skewSec,
          signal: opts.signal,
        });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        const msg = (err && err.message) || String(err);
        if (!/HTTP 403|403/.test(msg)) break;
      }
    }
    if (!ok) throw lastErr || new Error('No se pudo generar el audio.');
    buffers.push(ok);
  }

  return {
    buffer: Buffer.concat(buffers),
    voice,
    mime: 'audio/mpeg',
    format: 'mp3',
    provider: 'edge',
  };
}

module.exports = {
  synthesizeEdgeSpeech,
  generateSecMsGec,
  pickVoice,
  isEdgeVoiceId,
  chunkText,
  buildSsml,
  extractAudioFromBinary,
  DEFAULT_VOICE,
  TRUSTED_CLIENT_TOKEN,
  SEC_MS_GEC_VERSION,
  _internal: {
    setWebSocketFactory,
    setNowSec,
    resetTestSeams,
    dateToString,
    escapeXml,
    sanitizeTtsText,
    inferLangFromVoice,
    headerPath,
  },
};
