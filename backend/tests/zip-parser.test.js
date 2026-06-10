'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const PizZip = require('pizzip');

const { parseZip } = require('../src/services/zip-parser');

/**
 * Regression coverage for the `totalChars` ReferenceError that broke ALL
 * text extraction from uploaded .zip archives: `totalChars` lived only in
 * parseZip()'s scope but was read/mutated by the top-level walkDirectory(),
 * so the first extractable text file threw "totalChars is not defined" —
 * re-wrapped into a misleading "Ensure 'unzip' is installed" message.
 *
 * Proving that two text files (and a nested one) are all fully extracted
 * exercises the cross-file/cross-recursion accumulation the bug killed.
 */

function writeZip(entries) {
  const zip = new PizZip();
  for (const [name, content] of Object.entries(entries)) {
    zip.file(name, content);
  }
  const buf = zip.generate({ type: 'nodebuffer' });
  const zipPath = path.join(os.tmpdir(), `siragpt-ziptest-${crypto.randomUUID()}.zip`);
  fs.writeFileSync(zipPath, buf);
  return zipPath;
}

test('parseZip extracts text from every text file in a flat archive', async () => {
  const zipPath = writeZip({
    'alpha.txt': 'ALPHA-BODY-CONTENT',
    'bravo.md': 'BRAVO-BODY-CONTENT',
  });
  try {
    const out = await parseZip(zipPath);
    assert.match(out, /=== alpha\.txt ===/);
    assert.match(out, /ALPHA-BODY-CONTENT/);
    assert.match(out, /=== bravo\.md ===/);
    assert.match(out, /BRAVO-BODY-CONTENT/);
    // The old bug surfaced this misleading message — it must be gone.
    assert.doesNotMatch(out, /totalChars is not defined/);
  } finally {
    fs.rmSync(zipPath, { force: true });
  }
});

test('parseZip threads the char counter through nested directories', async () => {
  const zipPath = writeZip({
    'top.txt': 'TOP-LEVEL-TEXT',
    'sub/deep.txt': 'NESTED-DEEP-TEXT',
  });
  try {
    const out = await parseZip(zipPath);
    assert.match(out, /TOP-LEVEL-TEXT/);
    assert.match(out, /NESTED-DEEP-TEXT/);
    assert.match(out, /sub\/deep\.txt/);
  } finally {
    fs.rmSync(zipPath, { force: true });
  }
});

test('parseZip rejects corrupted and truncated archives with a clean structured error', async () => {
  const junkPath = path.join(os.tmpdir(), `siragpt-ziptest-junk-${crypto.randomUUID()}.zip`);
  fs.writeFileSync(junkPath, Buffer.from('this is definitely not a zip archive, just junk bytes'));

  // Truncated: take a valid archive and chop off its central directory.
  const validPath = writeZip({ 'a.txt': 'X'.repeat(400), 'b.txt': 'Y'.repeat(400) });
  const truncPath = path.join(os.tmpdir(), `siragpt-ziptest-trunc-${crypto.randomUUID()}.zip`);
  const validBuf = fs.readFileSync(validPath);
  fs.writeFileSync(truncPath, validBuf.subarray(0, Math.floor(validBuf.length / 3)));

  try {
    for (const badPath of [junkPath, truncPath]) {
      let thrown;
      try {
        await parseZip(badPath);
      } catch (err) {
        thrown = err;
      }
      assert.ok(thrown instanceof Error, 'parseZip must reject malformed archives');
      assert.match(thrown.message, /invalid or corrupted ZIP/i);
      // The old wrapper blamed a missing unzip binary even when unzip ran
      // fine and the archive was simply broken — that lie must be gone.
      assert.doesNotMatch(thrown.message, /Ensure 'unzip' is installed/);
    }
  } finally {
    for (const p of [junkPath, validPath, truncPath]) fs.rmSync(p, { force: true });
  }
});

test('parseZip skips hostile ../ and absolute-path entries without losing safe siblings', async () => {
  const marker = crypto.randomUUID();
  // extractDir lives directly inside os.tmpdir(), so a honoured "../" entry
  // would land at os.tmpdir()/<name>; the unique marker makes that provable.
  const escapeName = `siragpt-zip-escape-${marker}.txt`;
  const zipPath = writeZip({
    'good.txt': 'SAFE-GOOD-CONTENT',
    [`../${escapeName}`]: 'HOSTILE-PAYLOAD',
    [`/siragpt-zip-abs-${marker}.txt`]: 'HOSTILE-PAYLOAD',
  });
  const escapeTarget = path.join(os.tmpdir(), escapeName);
  try {
    // Before the fix this threw outright: unzip exits 1 (warning) when it
    // sanitizes hostile names, and any non-zero exit aborted the parse.
    const out = await parseZip(zipPath);
    assert.match(out, /SAFE-GOOD-CONTENT/, 'safe sibling must still be extracted');
    assert.doesNotMatch(out, /HOSTILE-PAYLOAD/, 'hostile entry content must not be extracted');
    assert.match(out, /Skipped \d+ entr(y|ies) with unsafe path/, 'skips must be reported');
    assert.ok(!fs.existsSync(escapeTarget), 'no file may be written outside the extraction dir');
  } finally {
    fs.rmSync(zipPath, { force: true });
    fs.rmSync(escapeTarget, { force: true });
  }
});

test('parseZip rejects archives whose declared uncompressed size exceeds the cap (zip-bomb guard)', async () => {
  const resolved = require.resolve('../src/services/zip-parser');
  const saved = process.env.ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES;
  process.env.ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES = '100';
  delete require.cache[resolved];
  const fresh = require('../src/services/zip-parser');
  const zipPath = writeZip({ 'big.txt': 'Z'.repeat(5000) });
  try {
    let thrown;
    try {
      await fresh.parseZip(zipPath);
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof Error, 'oversized archive must be rejected before extraction');
    assert.match(thrown.message, /zip bomb|exceeds/i);
  } finally {
    fs.rmSync(zipPath, { force: true });
    if (saved === undefined) delete process.env.ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES;
    else process.env.ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES = saved;
    delete require.cache[resolved];
    require('../src/services/zip-parser'); // re-prime with default env
  }
});

test('parseZip caps extracted text at the char limit and accumulates across files', async () => {
  // Force a tiny cap via env and re-require a fresh module instance so the
  // module-level constant picks it up regardless of prior cache state.
  const resolved = require.resolve('../src/services/zip-parser');
  const saved = process.env.ZIP_MAX_EXTRACTED_CHARS;
  process.env.ZIP_MAX_EXTRACTED_CHARS = '25';
  delete require.cache[resolved];
  const fresh = require('../src/services/zip-parser');
  const zipPath = writeZip({
    'a.txt': 'X'.repeat(20),
    'b.txt': 'Y'.repeat(20),
  });
  try {
    const out = await fresh.parseZip(zipPath);
    // First file consumes most of the 25-char budget; the second is
    // truncated — proving the counter accumulated across files.
    assert.match(out, /truncated at 25 chars total/);
  } finally {
    fs.rmSync(zipPath, { force: true });
    if (saved === undefined) delete process.env.ZIP_MAX_EXTRACTED_CHARS;
    else process.env.ZIP_MAX_EXTRACTED_CHARS = saved;
    delete require.cache[resolved];
    require('../src/services/zip-parser'); // re-prime with default env
  }
});
