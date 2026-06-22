'use strict';

/**
 * Characterization tests for file-integrity-validator.
 * Pins the behavior of checkMagicBytes / MAGIC_BYTES (pure) plus the
 * fs-touching readHeader / validateStructure / validateFile using
 * temp files under os.tmpdir() only.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  validateFile,
  checkMagicBytes,
  validateStructure,
  readHeader,
  MAGIC_BYTES,
} = require('../src/services/file-integrity-validator');

// ---------------------------------------------------------------------------
// MAGIC_BYTES shape
// ---------------------------------------------------------------------------
describe('MAGIC_BYTES', () => {
  test('contains the expected format keys', () => {
    const keys = Object.keys(MAGIC_BYTES);
    for (const k of ['pdf', 'jpg', 'png', 'gif', 'webp', 'bmp', 'tiffLE', 'tiffBE', 'zip', 'eml']) {
      assert.ok(keys.includes(k), `expected MAGIC_BYTES to include "${k}"`);
    }
  });

  test('each entry has offset, a Buffer of bytes, and a label', () => {
    for (const [, spec] of Object.entries(MAGIC_BYTES)) {
      assert.equal(typeof spec.offset, 'number');
      assert.ok(Buffer.isBuffer(spec.bytes));
      assert.equal(typeof spec.label, 'string');
    }
  });

  test('pdf signature is %PDF and zip signature is PK\\x03\\x04', () => {
    assert.deepEqual([...MAGIC_BYTES.pdf.bytes], [...Buffer.from('%PDF')]);
    assert.deepEqual([...MAGIC_BYTES.zip.bytes], [0x50, 0x4b, 0x03, 0x04]);
  });

  test('only eml carries an orMatch regex', () => {
    assert.ok(MAGIC_BYTES.eml.orMatch instanceof RegExp);
    assert.equal(MAGIC_BYTES.pdf.orMatch, undefined);
  });
});

// ---------------------------------------------------------------------------
// checkMagicBytes — pure function
// ---------------------------------------------------------------------------
describe('checkMagicBytes', () => {
  test('detects PDF header', () => {
    const r = checkMagicBytes(Buffer.from('%PDF-1.7'));
    assert.equal(r.ok, true);
    assert.equal(r.format, 'pdf');
    assert.ok(r.matches.includes('pdf'));
  });

  test('detects JPEG header [0xFF,0xD8,0xFF]', () => {
    const r = checkMagicBytes(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
    assert.equal(r.ok, true);
    assert.equal(r.format, 'jpg');
    assert.deepEqual(r.matches, ['jpg']);
  });

  test('detects PNG header [0x89,0x50,0x4E,0x47]', () => {
    const r = checkMagicBytes(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    assert.equal(r.ok, true);
    assert.equal(r.format, 'png');
    assert.deepEqual(r.matches, ['png']);
  });

  test('detects ZIP/OOXML header [0x50,0x4B,0x03,0x04]', () => {
    const r = checkMagicBytes(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]));
    assert.equal(r.ok, true);
    assert.equal(r.format, 'zip');
    assert.deepEqual(r.matches, ['zip']);
  });

  test('detects GIF header', () => {
    const r = checkMagicBytes(Buffer.from('GIF89a'));
    assert.equal(r.ok, true);
    assert.equal(r.format, 'gif');
  });

  test('detects BMP header (2-byte "BM")', () => {
    const r = checkMagicBytes(Buffer.from('BM______'));
    assert.equal(r.ok, true);
    assert.equal(r.format, 'bmp');
  });

  test('detects WebP via RIFF prefix', () => {
    const r = checkMagicBytes(Buffer.from('RIFF....WEBP'));
    assert.equal(r.ok, true);
    assert.ok(r.matches.includes('webp'));
    assert.equal(r.format, 'webp');
  });

  test('detects TIFF little-endian', () => {
    const r = checkMagicBytes(Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08]));
    assert.equal(r.ok, true);
    assert.ok(r.matches.includes('tiffLE'));
  });

  test('detects TIFF big-endian', () => {
    const r = checkMagicBytes(Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0x00]));
    assert.equal(r.ok, true);
    assert.ok(r.matches.includes('tiffBE'));
  });

  test('email-style "Subject: hi" header matches eml via orMatch regex', () => {
    const r = checkMagicBytes(Buffer.from('Subject: hi\r\n\r\nbody'));
    assert.equal(r.ok, true);
    assert.ok(r.matches.includes('eml'));
    assert.equal(r.format, 'eml');
  });

  test('"From " prefix matches eml via byte signature', () => {
    const r = checkMagicBytes(Buffer.from('From someone@example.com Mon Jan 1\r\n'));
    assert.equal(r.ok, true);
    assert.ok(r.matches.includes('eml'));
  });

  test('regex orMatch is case-insensitive and multiline', () => {
    // "return-path:" lowercase, not at start of buffer -> multiline+insensitive
    const r = checkMagicBytes(Buffer.from('x\nreturn-path: <a@b.com>\n'));
    assert.equal(r.ok, true);
    assert.ok(r.matches.includes('eml'));
  });

  test('null header → {ok:false, matches:[], format:null}', () => {
    assert.deepEqual(checkMagicBytes(null), { ok: false, matches: [], format: null });
  });

  test('undefined header → {ok:false, matches:[], format:null}', () => {
    assert.deepEqual(checkMagicBytes(undefined), { ok: false, matches: [], format: null });
  });

  test('empty buffer (length 0) → {ok:false, matches:[], format:null}', () => {
    assert.deepEqual(checkMagicBytes(Buffer.alloc(0)), { ok: false, matches: [], format: null });
  });

  test('single-byte buffer (length < 2) → {ok:false, matches:[], format:null}', () => {
    assert.deepEqual(checkMagicBytes(Buffer.from([0x42])), { ok: false, matches: [], format: null });
  });

  test('random/unknown ≥2-byte header → no match, null format', () => {
    const r = checkMagicBytes(Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]));
    assert.deepEqual(r, { ok: false, matches: [], format: null });
  });

  test('plain text that is not email-like → no match', () => {
    const r = checkMagicBytes(Buffer.from('hello world, just some text'));
    assert.equal(r.ok, false);
    assert.deepEqual(r.matches, []);
    assert.equal(r.format, null);
  });

  test('format equals matches[0] when multiple would match', () => {
    // "From:" matches the eml orMatch regex; pin format is the first match.
    const r = checkMagicBytes(Buffer.from('From: a@b.com\n'));
    assert.equal(r.format, r.matches[0]);
    assert.ok(r.matches.includes('eml'));
  });
});

// ---------------------------------------------------------------------------
// fs-touching helpers — temp files under os.tmpdir() only
// ---------------------------------------------------------------------------
describe('fs-backed helpers (tmpdir only)', () => {
  let dir;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fiv-test-'));
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeFile(name, content) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, content);
    return p;
  }

  describe('readHeader', () => {
    test('returns only the bytes that exist when file is shorter than maxBytes', async () => {
      const p = writeFile('short.bin', Buffer.from('abc'));
      const buf = await readHeader(p, 4096);
      assert.equal(buf.length, 3);
      assert.equal(buf.toString('utf8'), 'abc');
    });

    test('caps the read at maxBytes', async () => {
      const p = writeFile('long.bin', Buffer.alloc(100, 0x41));
      const buf = await readHeader(p, 10);
      assert.equal(buf.length, 10);
    });

    test('empty file yields a zero-length buffer', async () => {
      const p = writeFile('empty.bin', Buffer.alloc(0));
      const buf = await readHeader(p, 16);
      assert.equal(buf.length, 0);
    });
  });

  describe('validateStructure', () => {
    test('valid PDF (header + %%EOF, large enough) → no issues', async () => {
      const body = '%PDF-1.7\n' + 'x'.repeat(120) + '\n%%EOF';
      const p = writeFile('good.pdf', Buffer.from(body));
      const r = await validateStructure(p, 'application/pdf', Buffer.byteLength(body));
      assert.equal(r.valid, true);
      assert.equal(r.issueCount, 0);
      assert.deepEqual(r.issues, []);
    });

    test('PDF missing %PDF- header → corrupt_header issue', async () => {
      const body = 'NOTPDF\n' + 'x'.repeat(120) + '\n%%EOF';
      const p = writeFile('badheader.pdf', Buffer.from(body));
      const r = await validateStructure(p, 'application/pdf', Buffer.byteLength(body));
      assert.equal(r.valid, false);
      assert.ok(r.issues.some((i) => i.code === 'corrupt_header'));
    });

    test('PDF missing %%EOF trailer (size > 50) → missing_trailer issue', async () => {
      const body = '%PDF-1.7\n' + 'y'.repeat(200);
      const p = writeFile('notrailer.pdf', Buffer.from(body));
      const r = await validateStructure(p, 'application/pdf', Buffer.byteLength(body));
      assert.ok(r.issues.some((i) => i.code === 'missing_trailer'));
    });

    test('tiny PDF (fileSize < 50) → too_small issue', async () => {
      const body = '%PDF-1.7';
      const p = writeFile('tiny.pdf', Buffer.from(body));
      const r = await validateStructure(p, 'application/pdf', body.length);
      assert.ok(r.issues.some((i) => i.code === 'too_small'));
    });

    test('detects PDF by .pdf extension even with empty mimeType', async () => {
      const body = 'NOTPDF';
      const p = writeFile('byext.pdf', Buffer.from(body));
      const r = await validateStructure(p, '', body.length);
      assert.ok(r.issues.some((i) => i.code === 'corrupt_header'));
    });

    test('valid ZIP-based office doc by extension → no zip issue', async () => {
      const buf = Buffer.concat([
        Buffer.from([0x50, 0x4b, 0x03, 0x04]),
        Buffer.alloc(200, 0x00),
      ]);
      const p = writeFile('doc.docx', buf);
      const r = await validateStructure(p, '', buf.length);
      assert.equal(r.valid, true);
      assert.equal(r.issueCount, 0);
    });

    test('office doc without PK signature → not_zip issue', async () => {
      const buf = Buffer.alloc(200, 0x00);
      const p = writeFile('bad.docx', buf);
      const r = await validateStructure(p, '', buf.length);
      assert.ok(r.issues.some((i) => i.code === 'not_zip'));
    });

    test('tiny office doc (size < 100) → too_small issue', async () => {
      const buf = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
      const p = writeFile('small.xlsx', buf);
      const r = await validateStructure(p, '', buf.length);
      assert.ok(r.issues.some((i) => i.code === 'too_small'));
    });

    test('valid JSON starting with { → no issue', async () => {
      const body = '{"a":1,"b":2}';
      const p = writeFile('ok.json', Buffer.from(body));
      const r = await validateStructure(p, 'application/json', body.length);
      assert.equal(r.valid, true);
      assert.equal(r.issueCount, 0);
    });

    test('JSON not starting with {, [, or " → invalid_start issue', async () => {
      const body = 'oops not json';
      const p = writeFile('bad.json', Buffer.from(body));
      const r = await validateStructure(p, 'application/json', body.length);
      assert.ok(r.issues.some((i) => i.code === 'invalid_start'));
    });

    test('tiny JSON (size < 2) → too_small issue', async () => {
      const body = '{';
      const p = writeFile('tiny.json', Buffer.from(body));
      const r = await validateStructure(p, 'application/json', body.length);
      assert.ok(r.issues.some((i) => i.code === 'too_small'));
    });

    test('image with valid magic and adequate size → no issues', async () => {
      const buf = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(60, 0x00),
      ]);
      const p = writeFile('pic.png', buf);
      const r = await validateStructure(p, 'image/png', buf.length);
      assert.equal(r.valid, true);
      assert.equal(r.issueCount, 0);
    });

    test('image with unknown magic → invalid_magic issue', async () => {
      const buf = Buffer.alloc(64, 0x00);
      const p = writeFile('bad.img', buf);
      const r = await validateStructure(p, 'image/png', buf.length);
      assert.ok(r.issues.some((i) => i.code === 'invalid_magic'));
    });

    test('tiny image (fileSize < 30) → too_small issue', async () => {
      const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      const p = writeFile('tiny.png', buf);
      const r = await validateStructure(p, 'image/png', buf.length);
      assert.ok(r.issues.some((i) => i.code === 'too_small'));
    });

    test('non-special mimeType → valid with no issues', async () => {
      const p = writeFile('plain.txt', Buffer.from('just text content here'));
      const r = await validateStructure(p, 'text/plain', 22);
      assert.equal(r.valid, true);
      assert.deepEqual(r.issues, []);
    });
  });

  describe('validateFile', () => {
    test('missing filePath → no_path issue, invalid', async () => {
      const r = await validateFile('', 'application/pdf', 100);
      assert.equal(r.valid, false);
      assert.equal(r.magicOk, false);
      assert.equal(r.structureOk, false);
      assert.equal(r.issues[0].code, 'no_path');
    });

    test('non-existent file → not_found issue', async () => {
      const p = path.join(dir, 'does-not-exist.bin');
      const r = await validateFile(p, '', 0);
      assert.equal(r.valid, false);
      assert.equal(r.issues[0].code, 'not_found');
    });

    test('empty (0-byte) file → empty_file issue', async () => {
      const p = writeFile('zero.bin', Buffer.alloc(0));
      const r = await validateFile(p, '', 0);
      assert.equal(r.valid, false);
      assert.equal(r.issues[0].code, 'empty_file');
    });

    test('valid PDF → valid true, magicOk + structureOk true', async () => {
      const body = '%PDF-1.7\n' + 'x'.repeat(120) + '\n%%EOF';
      const p = writeFile('valid-file.pdf', Buffer.from(body));
      const r = await validateFile(p, 'application/pdf', Buffer.byteLength(body));
      assert.equal(r.magicOk, true);
      assert.equal(r.structureOk, true);
      assert.equal(r.valid, true);
      assert.ok(r.magicResult.includes('pdf'));
      assert.equal(r.fileSize, Buffer.byteLength(body));
    });

    test('stats file size when fileSize arg is 0', async () => {
      const body = '%PDF-1.7\n' + 'x'.repeat(120) + '\n%%EOF';
      const p = writeFile('autosize.pdf', Buffer.from(body));
      const r = await validateFile(p, 'application/pdf', 0);
      assert.equal(r.fileSize, Buffer.byteLength(body));
      assert.equal(r.valid, true);
    });

    test('unknown-magic large file → warning, magicOk false, valid false', async () => {
      const buf = Buffer.alloc(200, 0x00);
      const p = writeFile('unknown.bin', buf);
      const r = await validateFile(p, '', buf.length);
      assert.equal(r.magicOk, false);
      assert.equal(r.valid, false);
      assert.ok(r.warnings.some((w) => w.code === 'unknown_magic'));
    });

    test('very small file (>0, <10 bytes) → very_small warning', async () => {
      const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic, 4 bytes
      const p = writeFile('tiny-warn.png', buf);
      const r = await validateFile(p, 'image/png', buf.length);
      assert.ok(r.warnings.some((w) => w.code === 'very_small'));
    });

    test('structureOk false drags overall valid to false even when magicOk', async () => {
      // PNG magic (magicOk true) but image too small (structure issue)
      const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      const p = writeFile('magicok-structbad.png', buf);
      const r = await validateFile(p, 'image/png', buf.length);
      assert.equal(r.magicOk, true);
      assert.equal(r.structureOk, false);
      assert.equal(r.valid, false);
    });
  });
});
