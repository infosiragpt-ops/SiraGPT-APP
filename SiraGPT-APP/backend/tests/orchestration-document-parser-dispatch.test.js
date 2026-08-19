'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const { createDocumentParserDispatch } = require('../src/orchestration/document-parser-dispatch');

async function writeTempFile(name, content) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'siragpt-parser-test-'));
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, content, 'utf-8');
  return { filePath, dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }).catch(() => {}) };
}

test('exports createDocumentParserDispatch', () => {
  assert.equal(typeof createDocumentParserDispatch, 'function');
});

test('factory returns the documented dispatch surface', () => {
  const d = createDocumentParserDispatch();
  for (const fn of ['parse', 'parseNative', 'parseWithMarker', 'parseWithDocling', 'parseWithMarkItDown', 'parseWithUnstructured', 'parseWithSurya']) {
    assert.equal(typeof d[fn], 'function', `expected ${fn} to be a function`);
  }
});

test('parseNative reads .txt files directly', async () => {
  const { filePath, cleanup } = await writeTempFile('note.txt', 'hello plain text\nline 2');
  try {
    const d = createDocumentParserDispatch();
    const text = await d.parseNative(filePath, { name: 'note.txt' });
    assert.match(text, /hello plain text/);
    assert.match(text, /line 2/);
  } finally {
    await cleanup();
  }
});

test('parseNative reads .md files directly', async () => {
  const { filePath, cleanup } = await writeTempFile('doc.md', '# Heading\n\nParagraph.');
  try {
    const d = createDocumentParserDispatch();
    const text = await d.parseNative(filePath, { name: 'doc.md' });
    assert.match(text, /# Heading/);
    assert.match(text, /Paragraph/);
  } finally {
    await cleanup();
  }
});

test('parseNative reads .csv files directly', async () => {
  const { filePath, cleanup } = await writeTempFile('data.csv', 'name,value\nalpha,1\nbeta,2');
  try {
    const d = createDocumentParserDispatch();
    const text = await d.parseNative(filePath, { name: 'data.csv' });
    assert.match(text, /name,value/);
    assert.match(text, /alpha,1/);
  } finally {
    await cleanup();
  }
});

test('parseNative reads .json files directly', async () => {
  const payload = { hello: 'world', list: [1, 2, 3] };
  const { filePath, cleanup } = await writeTempFile('data.json', JSON.stringify(payload));
  try {
    const d = createDocumentParserDispatch();
    const text = await d.parseNative(filePath, { name: 'data.json' });
    const parsed = JSON.parse(text);
    assert.deepEqual(parsed, payload);
  } finally {
    await cleanup();
  }
});

test('parseNative returns empty string for unknown extensions', async () => {
  const { filePath, cleanup } = await writeTempFile('asset.bin', 'binary-stuff');
  try {
    const d = createDocumentParserDispatch();
    const text = await d.parseNative(filePath, { name: 'asset.bin' });
    assert.equal(text, '');
  } finally {
    await cleanup();
  }
});

test('parseNative returns empty string when the file does not exist', async () => {
  const d = createDocumentParserDispatch();
  const missing = path.join(os.tmpdir(), `does-not-exist-${crypto.randomBytes(4).toString('hex')}.txt`);
  const text = await d.parseNative(missing, { name: 'does-not-exist.txt' });
  assert.equal(text, '');
});

test('parse falls back to native extractor for .txt when external parsers are unavailable', async () => {
  // The plan for plain .txt resolves to ['internal-text-extractor'] from
  // parserPlanFor, which the dispatch loop skips (no matching fn), so it
  // falls into parseNative. This verifies the fallback chain end-to-end.
  const { filePath, cleanup } = await writeTempFile('story.txt', 'once upon a time');
  try {
    const d = createDocumentParserDispatch();
    const result = await d.parse(filePath, { name: 'story.txt' });
    assert.equal(result.parser, 'native');
    assert.equal(result.native, true);
    assert.match(result.text, /once upon a time/);
  } finally {
    await cleanup();
  }
});

test('parse throws a 422 when no parser produces output', async () => {
  const d = createDocumentParserDispatch();
  // Unknown extension + missing file: every parser fails and parseNative
  // returns ''. The dispatcher must surface a 422 instead of empty data.
  const missing = path.join(os.tmpdir(), `nope-${crypto.randomBytes(4).toString('hex')}.binarydata`);
  await assert.rejects(
    () => d.parse(missing, { name: 'nope.binarydata' }),
    (err) => {
      assert.equal(err.status, 422);
      assert.match(err.message, /All parsers failed/);
      return true;
    }
  );
});

test('factory accepts a custom timeoutMs override', () => {
  // The factory just wires timeoutMs into closures; verify it does not
  // throw when given a non-default value (smoke-test for arg plumbing).
  const d = createDocumentParserDispatch({ timeoutMs: 5000 });
  assert.equal(typeof d.parse, 'function');
});
