'use strict';

/**
 * text-encoding-detector — detects character encoding of text files.
 *
 * Uses a pure-JS heuristic approach: samples the first 64KB of a file,
 * checks for BOM markers, and validates against common encodings.
 *
 * Supports: UTF-8, UTF-16 LE/BE, UTF-32 LE/BE, ISO-8859-1, Windows-1252,
 *           Shift_JIS, EUC-JP, EUC-KR, GB2312, GBK, Big5.
 */

const fs = require('fs');

const BOM_MAP = {
  'efbbbf': { encoding: 'utf8', name: 'UTF-8' },
  'fffe': { encoding: 'utf16le', name: 'UTF-16 LE' },
  'feff': { encoding: 'utf16be', name: 'UTF-16 BE' },
  'fffe0000': { encoding: 'utf32le', name: 'UTF-32 LE' },
  '0000feff': { encoding: 'utf32be', name: 'UTF-32 BE' },
};

const SAMPLE_SIZE = 65536;

function bufferToHex(buf, maxLen) {
  const len = Math.min(buf.length, maxLen || 16);
  let hex = '';
  for (let i = 0; i < len; i++) hex += buf[i].toString(16).padStart(2, '0');
  return hex;
}

function detectBom(buffer) {
  const hex4 = bufferToHex(buffer, 4);
  if (BOM_MAP[hex4]) return BOM_MAP[hex4];
  const hex2 = bufferToHex(buffer, 2);
  if (BOM_MAP[hex2]) return BOM_MAP[hex2];
  return null;
}

/**
 * Validate UTF-8 by checking for valid multi-byte sequences.
 */
function isValidUtf8(buffer) {
  let state = 0;
  for (let i = 0; i < buffer.length; i++) {
    const byte = buffer[i];
    if (state === 0) {
      if (byte <= 0x7F) continue;
      if (byte >= 0xC2 && byte <= 0xDF) { state = 1; continue; }
      if (byte >= 0xE0 && byte <= 0xEF) { state = 2; continue; }
      if (byte >= 0xF0 && byte <= 0xF4) { state = 3; continue; }
      return false;
    }
    if (byte < 0x80 || byte > 0xBF) return false;
    state--;
  }
  return state === 0;
}

/**
 * Check if content is mostly ASCII (printable chars + common whitespace + newlines).
 */
function isMostlyAscii(buffer) {
  let ascii = 0;
  let total = 0;
  for (let i = 0; i < buffer.length; i++) {
    const byte = buffer[i];
    if (byte === 0x00) continue;
    total++;
    if ((byte >= 0x20 && byte <= 0x7E) || byte === 0x09 || byte === 0x0A || byte === 0x0D) {
      ascii++;
    }
  }
  return total > 0 && (ascii / total) > 0.80;
}

/**
 * Check for Windows-1252 / ISO-8859-1 patterns (bytes 0x80-0x9F range used).
 */
function looksLikeWindows1252(buffer) {
  let win1252 = 0;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] >= 0x80 && buffer[i] <= 0x9F) win1252++;
  }
  return win1252 > 5;
}

/**
 * Detect if content matches Shift_JIS encoding pattern.
 */
function looksLikeShiftJIS(buffer) {
  let sjisBytes = 0;
  for (let i = 0; i < buffer.length - 1; i++) {
    const b1 = buffer[i];
    const b2 = buffer[i + 1];
    if (
      ((b1 >= 0x81 && b1 <= 0x9F) || (b1 >= 0xE0 && b1 <= 0xEF)) &&
      ((b2 >= 0x40 && b2 <= 0x7E) || (b2 >= 0x80 && b2 <= 0xFC))
    ) {
      sjisBytes++;
      i++;
    }
  }
  return sjisBytes > 10;
}

/**
 * Detect if content looks like EUC-JP.
 */
function looksLikeEUCJP(buffer) {
  let eucBytes = 0;
  for (let i = 0; i < buffer.length - 1; i++) {
    if (buffer[i] >= 0xA1 && buffer[i] <= 0xFE && buffer[i + 1] >= 0xA1 && buffer[i + 1] <= 0xFE) {
      eucBytes++;
      i++;
    }
  }
  return eucBytes > 10;
}

/**
 * Detect if content might be GB2312/GBK/GB18030.
 */
function looksLikeGBK(buffer) {
  let gbkBytes = 0;
  for (let i = 0; i < buffer.length - 1; i++) {
    if (buffer[i] >= 0x81 && buffer[i] <= 0xFE && buffer[i + 1] >= 0x40 && buffer[i + 1] <= 0xFE) {
      gbkBytes++;
      i++;
    }
  }
  return gbkBytes > 10;
}

/**
 * Main encoding detection function.
 * @param {Buffer|string} buffer — file buffer or path to file
 * @returns {Promise<{ encoding: string, confidence: number, name: string, hasBom: boolean }>}
 */
async function detectEncoding(input) {
  let buffer;
  if (Buffer.isBuffer(input)) {
    buffer = input.length > SAMPLE_SIZE ? input.slice(0, SAMPLE_SIZE) : input;
  } else if (typeof input === 'string') {
    const fd = await fs.promises.open(input, 'r');
    try {
      const { bytesRead, buffer: buf } = await fd.read(Buffer.alloc(SAMPLE_SIZE), 0, SAMPLE_SIZE, 0);
      buffer = buf.slice(0, bytesRead);
    } finally {
      await fd.close();
    }
  } else {
    return { encoding: 'utf8', confidence: 0.5, name: 'UTF-8 (default)', hasBom: false };
  }

  if (!buffer || buffer.length === 0) {
    return { encoding: 'utf8', confidence: 0.9, name: 'UTF-8 (empty)', hasBom: false };
  }

  const bom = detectBom(buffer);
  if (bom) {
    return { encoding: bom.encoding, confidence: 1.0, name: bom.name, hasBom: true };
  }

  if (isValidUtf8(buffer)) {
    let confidence = 0.98;
    if (buffer.some(b => b === 0x00)) confidence = 0.92;
    return { encoding: 'utf8', confidence, name: 'UTF-8', hasBom: false };
  }

  if (isMostlyAscii(buffer)) {
    const win1252 = looksLikeWindows1252(buffer);
    if (win1252) return { encoding: 'windows-1252', confidence: 0.75, name: 'Windows-1252', hasBom: false };
    return { encoding: 'latin1', confidence: 0.70, name: 'ISO-8859-1', hasBom: false };
  }

  if (looksLikeShiftJIS(buffer)) {
    return { encoding: 'shift_jis', confidence: 0.65, name: 'Shift_JIS', hasBom: false };
  }
  if (looksLikeEUCJP(buffer)) {
    return { encoding: 'euc-jp', confidence: 0.60, name: 'EUC-JP', hasBom: false };
  }
  if (looksLikeGBK(buffer)) {
    return { encoding: 'gbk', confidence: 0.60, name: 'GBK', hasBom: false };
  }

  return { encoding: 'utf8', confidence: 0.40, name: 'UTF-8 (best guess)', hasBom: false };
}

/**
 * Read a text file with encoding detection.
 * @param {string} filePath — absolute path
 * @param {object} [opts]
 * @param {string} [opts.fallbackEncoding='utf8'] — encoding to use if detection fails
 * @returns {Promise<{ text: string, encoding: string, confidence: number }>}
 */
async function readTextFile(filePath, opts = {}) {
  const raw = await fs.promises.readFile(filePath);
  const detection = await detectEncoding(raw);
  const useEncoding = detection.confidence > 0.40 ? detection.encoding : (opts.fallbackEncoding || 'utf8');

  let text;
  if (useEncoding === 'utf8') {
    text = raw.toString('utf8');
    // Strip UTF-8 BOM (EF BB BF) if present — invisible U+FEFF corrupts
    // JSON parsing and CSV column detection downstream.
    if (text.charCodeAt(0) === 0xFEFF) {
      text = text.slice(1);
    }
  } else if (useEncoding === 'utf16le') {
    text = raw.toString('utf16le');
    if (text.charCodeAt(0) === 0xFEFF) {
      text = text.slice(1);
    }
  } else if (useEncoding === 'utf16be') {
    text = raw.swap16().toString('utf16le');
    if (text.charCodeAt(0) === 0xFEFF) {
      text = text.slice(1);
    }
  } else {
    const iconv = (() => { try { return require('iconv-lite'); } catch { return null; } })();
    if (iconv) {
      text = iconv.decode(raw, useEncoding);
    } else {
      // iconv-lite not installed — decoding as latin1 will produce
      // mojibake for Shift_JIS/GBK/EUC-KR/EUC-JP documents.
      // Log once per process so operators know to `npm i iconv-lite`.
      if (!readTextFile._iconvWarned) {
        readTextFile._iconvWarned = true;
        console.warn(
          '[encoding] iconv-lite is not installed. Non-UTF-8 documents ' +
          `(detected as ${useEncoding}) will decode as garbled latin1. ` +
          'Install iconv-lite for full multi-encoding support: npm i iconv-lite'
        );
      }
      text = raw.toString('latin1');
    }
  }

  return { text, encoding: useEncoding, confidence: detection.confidence };
}

module.exports = {
  detectEncoding,
  readTextFile,
  isValidUtf8,
  detectBom,
  isMostlyAscii,
};