const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fileProcessorModule = require('../src/services/fileProcessor');
const fileProcessor = fileProcessorModule.default || fileProcessorModule;
const { isTextLikeMime, sniffTextLike } = fileProcessorModule;

function tmpFile(name, contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-any-format-'));
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, contents);
  return { filePath, dir, size: fs.statSync(filePath).size };
}

test('isTextLikeMime recognises code/config/data MIME families and rejects binaries', () => {
  for (const mime of [
    'text/x-python', 'text/javascript', 'text/yaml', 'text/x-log',
    'application/x-yaml', 'application/toml', 'application/sql', 'application/x-sh',
    'application/javascript', 'application/typescript', 'application/ld+json',
    'application/vnd.api+json', 'application/rss+xml', 'application/x-ndjson',
  ]) {
    assert.equal(isTextLikeMime(mime), true, `${mime} should be text-like`);
  }
  for (const mime of ['', 'application/octet-stream', 'image/png', 'application/pdf', 'application/zip', 'video/mp4', 'application/x-msdownload']) {
    assert.equal(isTextLikeMime(mime), false, `${mime || '(empty)'} should not be text-like`);
  }
});

test('sniffTextLike separates plain-text bytes from binaries', async () => {
  const text = tmpFile('notes.unknownext', 'línea 1\nlínea 2\n\ttabulado\r\nfin');
  const binary = tmpFile('blob.bin', Buffer.concat([Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]), Buffer.alloc(512, 0x00)]));
  const empty = tmpFile('empty.dat', '');
  try {
    assert.equal(await sniffTextLike(text.filePath), true);
    assert.equal(await sniffTextLike(binary.filePath), false);
    assert.equal(await sniffTextLike(empty.filePath), false);
    assert.equal(await sniffTextLike(path.join(text.dir, 'missing.txt')), false);
  } finally {
    fs.rmSync(text.dir, { recursive: true, force: true });
    fs.rmSync(binary.dir, { recursive: true, force: true });
    fs.rmSync(empty.dir, { recursive: true, force: true });
  }
});

test('processFile reads any text-like format (source code without a dedicated parser) as text', async () => {
  const source = 'import os\n\ndef main():\n    print("hola")\n\nif __name__ == "__main__":\n    main()\n';
  const py = tmpFile('sample.py', source);
  try {
    const result = await fileProcessor.processFile({
      mimetype: 'text/x-python', path: py.filePath, originalname: 'sample.py', size: py.size,
    });
    assert.equal(result.success, true);
    assert.match(result.extractedText, /^Text file \(\.py\) — \d+ lines, \d+ chars\n---\n/);
    assert.ok(result.extractedText.endsWith(source), 'the full source must follow the header');
  } finally {
    fs.rmSync(py.dir, { recursive: true, force: true });
  }
});

test('processFile sniffs extension-less / unknown-MIME text files instead of storing a placeholder', async () => {
  const toml = tmpFile('config.toml', 'key = "value"\n[section]\nx = 1\n');
  const dockerfile = tmpFile('Dockerfile', 'FROM node:22-alpine\nWORKDIR /app\nCMD ["node", "index.js"]\n');
  try {
    const a = await fileProcessor.processFile({ mimetype: '', path: toml.filePath, originalname: 'config.toml', size: toml.size });
    assert.equal(a.success, true);
    assert.match(a.extractedText, /^Text file \(\.toml\)/);
    assert.match(a.extractedText, /\[section\]/);

    const b = await fileProcessor.processFile({ mimetype: 'application/octet-stream', path: dockerfile.filePath, originalname: 'Dockerfile', size: dockerfile.size });
    assert.equal(b.success, true);
    assert.match(b.extractedText, /^Text file \(application\/octet-stream\)/);
    assert.match(b.extractedText, /FROM node:22-alpine/);
  } finally {
    fs.rmSync(toml.dir, { recursive: true, force: true });
    fs.rmSync(dockerfile.dir, { recursive: true, force: true });
  }
});

test('processFile keeps the recognised opaque-binary placeholder for real binaries', async () => {
  const bytes = Buffer.alloc(4096);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 7919) % 256;
  const parquet = tmpFile('dataset.parquet', bytes);
  try {
    const result = await fileProcessor.processFile({
      mimetype: 'application/octet-stream', path: parquet.filePath, originalname: 'dataset.parquet', size: parquet.size,
    });
    assert.equal(result.success, true);
    assert.equal(
      result.extractedText,
      'File "dataset.parquet" uploaded successfully. Content type: application/octet-stream',
    );
  } finally {
    fs.rmSync(parquet.dir, { recursive: true, force: true });
  }
});
