'use strict';

/**
 * Characterization tests for text-encoding-detector.js
 *
 * These tests pin the behavior of the encoding-detection helpers AS WRITTEN.
 * Notable real-code subtleties captured here (not assumptions):
 *
 *  - detectBom hashes the first 4 bytes (hex4, 8 hex chars) then the first 2
 *    bytes (hex2, 4 hex chars). The UTF-8 BOM key "efbbbf" is 6 hex chars, so
 *    it ONLY matches when the buffer is exactly 3 bytes long (hex4 collapses to
 *    "efbbbf"). A UTF-8 BOM followed by content is NOT detected by detectBom.
 *  - The 4-byte UTF-32LE BOM (fffe0000) is checked before the 2-byte
 *    UTF-16LE BOM (fffe), so a buffer starting ff fe 00 00 is UTF-32 LE.
 *  - isMostlyAscii skips 0x00 bytes entirely and requires ratio > 0.80.
 *  - isValidUtf8 rejects overlong/out-of-range leads (0xC0/0xC1/0xF5+),
 *    lone continuations, and truncated multibyte sequences.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  detectEncoding,
  readTextFile,
  isValidUtf8,
  detectBom,
  isMostlyAscii,
} = require('../src/services/text-encoding-detector.js');

describe('module exports', () => {
  test('exports the documented functions', () => {
    assert.equal(typeof detectEncoding, 'function');
    assert.equal(typeof readTextFile, 'function');
    assert.equal(typeof isValidUtf8, 'function');
    assert.equal(typeof detectBom, 'function');
    assert.equal(typeof isMostlyAscii, 'function');
  });
});

describe('detectBom', () => {
  test('detects UTF-8 BOM only when buffer is exactly 3 bytes', () => {
    assert.deepEqual(detectBom(Buffer.from([0xEF, 0xBB, 0xBF])), {
      encoding: 'utf8',
      name: 'UTF-8',
    });
  });

  test('does NOT detect UTF-8 BOM when content follows (hex4 != efbbbf)', () => {
    // Real code: bufferToHex(buf,4) -> "efbbbf41..." (8 chars), hex2 -> "efbb".
    // Neither equals the 6-char key "efbbbf", so this returns null.
    assert.equal(detectBom(Buffer.from([0xEF, 0xBB, 0xBF, 0x41, 0x42])), null);
  });

  test('detects UTF-16 LE BOM (2-byte) on its own', () => {
    assert.deepEqual(detectBom(Buffer.from([0xFF, 0xFE])), {
      encoding: 'utf16le',
      name: 'UTF-16 LE',
    });
  });

  test('detects UTF-16 LE BOM with trailing content', () => {
    assert.deepEqual(detectBom(Buffer.from([0xFF, 0xFE, 0x41, 0x00])), {
      encoding: 'utf16le',
      name: 'UTF-16 LE',
    });
  });

  test('detects UTF-16 BE BOM', () => {
    assert.deepEqual(detectBom(Buffer.from([0xFE, 0xFF, 0x00, 0x41])), {
      encoding: 'utf16be',
      name: 'UTF-16 BE',
    });
  });

  test('detects UTF-32 LE BOM and prefers it over the 2-byte UTF-16 LE BOM', () => {
    // fffe0000 (4-byte) is checked before fffe (2-byte) — precedence pin.
    assert.deepEqual(detectBom(Buffer.from([0xFF, 0xFE, 0x00, 0x00])), {
      encoding: 'utf32le',
      name: 'UTF-32 LE',
    });
  });

  test('detects UTF-32 BE BOM', () => {
    assert.deepEqual(detectBom(Buffer.from([0x00, 0x00, 0xFE, 0xFF])), {
      encoding: 'utf32be',
      name: 'UTF-32 BE',
    });
  });

  test('returns null for a buffer with no BOM', () => {
    assert.equal(detectBom(Buffer.from('Hello', 'ascii')), null);
  });

  test('returns null for an empty buffer', () => {
    assert.equal(detectBom(Buffer.from([])), null);
  });
});

describe('isValidUtf8', () => {
  test('accepts pure ASCII', () => {
    assert.equal(isValidUtf8(Buffer.from('Hello, World!\n\t', 'ascii')), true);
  });

  test('accepts an empty buffer', () => {
    assert.equal(isValidUtf8(Buffer.from([])), true);
  });

  test('accepts a valid 2-byte sequence (é = C3 A9)', () => {
    assert.equal(isValidUtf8(Buffer.from([0xC3, 0xA9])), true);
  });

  test('accepts a valid 3-byte sequence (€ = E2 82 AC)', () => {
    assert.equal(isValidUtf8(Buffer.from([0xE2, 0x82, 0xAC])), true);
  });

  test('accepts a valid 4-byte sequence (😀 = F0 9F 98 80)', () => {
    assert.equal(isValidUtf8(Buffer.from([0xF0, 0x9F, 0x98, 0x80])), true);
  });

  test('accepts mixed ASCII + multibyte', () => {
    assert.equal(isValidUtf8(Buffer.from('A é € 😀 Z', 'utf8')), true);
  });

  test('rejects a lone continuation byte (0x80)', () => {
    assert.equal(isValidUtf8(Buffer.from([0x80])), false);
  });

  test('rejects a truncated 2-byte sequence (lead 0xC3 with no continuation)', () => {
    assert.equal(isValidUtf8(Buffer.from([0xC3])), false);
  });

  test('rejects a truncated 3-byte sequence (E2 82 then EOF)', () => {
    assert.equal(isValidUtf8(Buffer.from([0xE2, 0x82])), false);
  });

  test('rejects overlong / illegal lead byte 0xC0', () => {
    assert.equal(isValidUtf8(Buffer.from([0xC0, 0x80])), false);
  });

  test('rejects illegal lead byte 0xC1', () => {
    assert.equal(isValidUtf8(Buffer.from([0xC1, 0x80])), false);
  });

  test('rejects out-of-range lead byte 0xF5', () => {
    assert.equal(isValidUtf8(Buffer.from([0xF5, 0x80, 0x80, 0x80])), false);
  });

  test('rejects a continuation byte where a lead is required', () => {
    // After valid é, a stray continuation 0xBF with no lead is invalid.
    assert.equal(isValidUtf8(Buffer.from([0xC3, 0xA9, 0xBF])), false);
  });

  test('rejects a multibyte sequence interrupted by ASCII', () => {
    // Lead 0xC3 expects a continuation, but gets 0x41 ('A').
    assert.equal(isValidUtf8(Buffer.from([0xC3, 0x41])), false);
  });
});

describe('isMostlyAscii', () => {
  test('true for pure ASCII text', () => {
    assert.equal(isMostlyAscii(Buffer.from('Hello World\n', 'ascii')), true);
  });

  test('false for an empty buffer (total === 0)', () => {
    assert.equal(isMostlyAscii(Buffer.from([])), false);
  });

  test('false for an all-null buffer (every byte skipped, total stays 0)', () => {
    assert.equal(isMostlyAscii(Buffer.from([0x00, 0x00, 0x00])), false);
  });

  test('false when more than 20% of (non-null) bytes are high bytes', () => {
    // 10 counted bytes, 3 high (30% non-ascii) => ratio 0.70, not > 0.80.
    const buf = Buffer.from([0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0xC0, 0xC1, 0xC2]);
    assert.equal(isMostlyAscii(buf), false);
  });

  test('true when only a small fraction are high bytes (ratio > 0.80)', () => {
    // 8 bytes, 1 high => ratio 0.875 > 0.80.
    const buf = Buffer.from([0x48, 0x65, 0x6C, 0x6C, 0x6F, 0x20, 0xE9, 0x21]);
    assert.equal(isMostlyAscii(buf), true);
  });

  test('null bytes do not count toward the total', () => {
    // 5 ASCII + 1 high byte, plus nulls that are skipped -> ratio 5/6 > 0.80.
    const buf = Buffer.from([0x00, 0x41, 0x42, 0x00, 0x43, 0x44, 0x45, 0xE9, 0x00]);
    assert.equal(isMostlyAscii(buf), true);
  });

  test('treats tab/newline/carriage-return as ASCII', () => {
    assert.equal(isMostlyAscii(Buffer.from([0x09, 0x0A, 0x0D, 0x41])), true);
  });
});

describe('detectEncoding — return shape and branches', () => {
  test('BOM present => confidence 1.0 and hasBom true', async () => {
    const result = await detectEncoding(Buffer.from([0xFF, 0xFE, 0x41, 0x00]));
    assert.deepEqual(result, {
      encoding: 'utf16le',
      confidence: 1.0,
      name: 'UTF-16 LE',
      hasBom: true,
    });
  });

  test('UTF-32 LE BOM wins over UTF-16 LE in detectEncoding too', async () => {
    const result = await detectEncoding(Buffer.from([0xFF, 0xFE, 0x00, 0x00]));
    assert.equal(result.encoding, 'utf32le');
    assert.equal(result.confidence, 1.0);
    assert.equal(result.hasBom, true);
  });

  test('clean UTF-8 (no BOM) => utf8 at confidence 0.98', async () => {
    const result = await detectEncoding(Buffer.from('Hello é €', 'utf8'));
    assert.deepEqual(result, {
      encoding: 'utf8',
      confidence: 0.98,
      name: 'UTF-8',
      hasBom: false,
    });
  });

  test('valid UTF-8 containing a 0x00 byte => confidence drops to 0.92', async () => {
    const buf = Buffer.concat([
      Buffer.from('Hello', 'ascii'),
      Buffer.from([0x00]),
      Buffer.from('é', 'utf8'),
    ]);
    const result = await detectEncoding(buf);
    assert.equal(result.encoding, 'utf8');
    assert.equal(result.confidence, 0.92);
    assert.equal(result.hasBom, false);
  });

  test('empty buffer => UTF-8 (empty) at confidence 0.9', async () => {
    const result = await detectEncoding(Buffer.from([]));
    assert.deepEqual(result, {
      encoding: 'utf8',
      confidence: 0.9,
      name: 'UTF-8 (empty)',
      hasBom: false,
    });
  });

  test('non-buffer, non-string input => default UTF-8 at confidence 0.5', async () => {
    const result = await detectEncoding(12345);
    assert.deepEqual(result, {
      encoding: 'utf8',
      confidence: 0.5,
      name: 'UTF-8 (default)',
      hasBom: false,
    });
  });

  test('null input => default UTF-8 at confidence 0.5', async () => {
    const result = await detectEncoding(null);
    assert.equal(result.confidence, 0.5);
    assert.equal(result.name, 'UTF-8 (default)');
  });

  test('invalid UTF-8 but mostly ASCII => latin1 / ISO-8859-1 at 0.70', async () => {
    // "Hello é!" in latin1: single high byte 0xE9, invalid as UTF-8 lead.
    const buf = Buffer.from([0x48, 0x65, 0x6C, 0x6C, 0x6F, 0x20, 0xE9, 0x21]);
    const result = await detectEncoding(buf);
    assert.deepEqual(result, {
      encoding: 'latin1',
      confidence: 0.70,
      name: 'ISO-8859-1',
      hasBom: false,
    });
  });

  test('invalid UTF-8, mostly ASCII, many 0x80-0x9F bytes => windows-1252 at 0.75', async () => {
    const ascii = Array.from(
      'The quick brown fox jumps over the lazy dog. '.repeat(3)
    ).map((c) => c.charCodeAt(0));
    const win = ascii.concat([0x91, 0x92, 0x93, 0x94, 0x95, 0x96]); // 6 bytes in 0x80-0x9F
    const result = await detectEncoding(Buffer.from(win));
    assert.deepEqual(result, {
      encoding: 'windows-1252',
      confidence: 0.75,
      name: 'Windows-1252',
      hasBom: false,
    });
  });

  test('invalid UTF-8, not mostly ASCII, Shift_JIS pattern => shift_jis at 0.65', async () => {
    const sjis = [];
    for (let i = 0; i < 15; i++) {
      sjis.push(0x82, 0x60); // lead 0x82 (0x81-0x9F), trail 0x60 (0x40-0x7E)
    }
    const result = await detectEncoding(Buffer.from(sjis));
    assert.deepEqual(result, {
      encoding: 'shift_jis',
      confidence: 0.65,
      name: 'Shift_JIS',
      hasBom: false,
    });
  });

  test('invalid UTF-8, not mostly ASCII, EUC-JP pattern => euc-jp at 0.60', async () => {
    const euc = [];
    for (let i = 0; i < 15; i++) {
      euc.push(0xA1, 0xA1); // both bytes in 0xA1-0xFE, not a Shift_JIS lead range
    }
    const result = await detectEncoding(Buffer.from(euc));
    assert.equal(result.encoding, 'euc-jp');
    assert.equal(result.confidence, 0.60);
    assert.equal(result.name, 'EUC-JP');
  });

  test('invalid UTF-8, not mostly ASCII, GBK pattern => gbk at 0.60', async () => {
    const gbk = [];
    for (let i = 0; i < 15; i++) {
      gbk.push(0x81, 0x40); // lead 0x81 (not 0x81-0x9F Shift_JIS? it is) ... use 0xC0 lead
    }
    // 0x81 IS a Shift_JIS lead and 0x40 IS a Shift_JIS trail, so the above would
    // be caught by Shift_JIS first. Use a GBK-only pattern: lead 0xB0, trail 0xB0.
    // 0xB0 is NOT a Shift_JIS lead (0x81-0x9F or 0xE0-0xEF); both in EUC range
    // (0xA1-0xFE) so EUC-JP would catch it first. To isolate GBK we need a trail
    // in 0x40-0xA0 that is outside the EUC second-byte range (0xA1-0xFE) and
    // outside the Shift_JIS lead range. lead 0xB0 (GBK ok, not SJIS lead, EUC ok),
    // trail 0x41 (GBK ok 0x40-0xFE, NOT EUC 0xA1-0xFE, and 0xB0 is not SJIS lead).
    const gbkOnly = [];
    for (let i = 0; i < 15; i++) {
      gbkOnly.push(0xB0, 0x41);
    }
    const result = await detectEncoding(Buffer.from(gbkOnly));
    assert.equal(result.encoding, 'gbk');
    assert.equal(result.confidence, 0.60);
    assert.equal(result.name, 'GBK');
  });

  test('invalid UTF-8, not mostly ASCII, no CJK heuristic => UTF-8 best guess at 0.40', async () => {
    // 0xC0 is an invalid UTF-8 lead; all bytes non-printable so not mostly ASCII;
    // pairs do not satisfy Shift_JIS/EUC/GBK trail constraints.
    const buf = Buffer.from([0xC0, 0xC0, 0xC0, 0xC0]);
    const result = await detectEncoding(buf);
    assert.deepEqual(result, {
      encoding: 'utf8',
      confidence: 0.40,
      name: 'UTF-8 (best guess)',
      hasBom: false,
    });
  });

  test('large buffer is sampled to the first 64KB (still detected as UTF-8)', async () => {
    const big = Buffer.alloc(70000, 0x41); // 'A' * 70000, exceeds SAMPLE_SIZE 65536
    const result = await detectEncoding(big);
    assert.equal(result.encoding, 'utf8');
    assert.equal(result.confidence, 0.98);
  });
});

describe('readTextFile (uses os.tmpdir only)', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  function tmpFile(name, bytes) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enc-test-'));
    const p = path.join(dir, name);
    fs.writeFileSync(p, bytes);
    return p;
  }

  test('reads a clean UTF-8 file and reports the detected encoding', async () => {
    const p = tmpFile('clean.txt', Buffer.from('Hola, mundo — café €', 'utf8'));
    const result = await readTextFile(p);
    assert.equal(result.text, 'Hola, mundo — café €');
    assert.equal(result.encoding, 'utf8');
    assert.equal(result.confidence, 0.98);
  });

  test('strips a leading UTF-8 BOM (U+FEFF) from the decoded text', async () => {
    // BOM bytes + content; detectEncoding returns utf8 (BOM not matched by
    // detectBom with trailing content, but the content is valid UTF-8), and
    // readTextFile strips the leading U+FEFF after decoding.
    const p = tmpFile('bom.txt', Buffer.concat([
      Buffer.from([0xEF, 0xBB, 0xBF]),
      Buffer.from('content', 'utf8'),
    ]));
    const result = await readTextFile(p);
    assert.equal(result.text, 'content');
    // First char is the real content, not a leftover U+FEFF.
    assert.equal(result.text.charCodeAt(0), 'c'.charCodeAt(0));
    assert.notEqual(result.text.charCodeAt(0), 0xFEFF);
  });

  test('decodes a UTF-16 LE file with BOM and strips the BOM', async () => {
    // 'hi' in UTF-16 LE with BOM: FF FE 68 00 69 00
    const p = tmpFile('u16.txt', Buffer.from([0xFF, 0xFE, 0x68, 0x00, 0x69, 0x00]));
    const result = await readTextFile(p);
    assert.equal(result.text, 'hi');
    assert.equal(result.encoding, 'utf16le');
    assert.equal(result.confidence, 1.0);
  });

  test('latin1 content (high confidence) decodes via the latin1 branch', async () => {
    // Needs ratio > 0.80 to reach isMostlyAscii: use 7 ASCII + 1 high byte.
    // "Hello é!" in latin1 (0xE9 = é): invalid UTF-8 but mostly ASCII => latin1 @ 0.70.
    const bytes = Buffer.from([0x48, 0x65, 0x6C, 0x6C, 0x6F, 0x20, 0xE9, 0x21]);
    const p = tmpFile('latin.txt', bytes);
    const result = await readTextFile(p);
    assert.equal(result.encoding, 'latin1');
    assert.equal(result.confidence, 0.70);
    // latin1 decode of 0xE9 -> 'é'; readTextFile uses raw.toString('latin1').
    assert.equal(result.text, 'Hello é!');
  });
});
