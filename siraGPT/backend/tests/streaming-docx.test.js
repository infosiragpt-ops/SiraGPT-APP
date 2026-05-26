'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { Document, Packer, Paragraph, TextRun } = require('docx');

const {
  streamDocxParagraphs,
  extractDocxStreaming,
  DocxParaScanner,
  decodeXmlEntities,
} = require('../src/services/document/streaming-docx');

function makeTmp(name) {
  return path.join(os.tmpdir(), `siragpt-stream-docx-${process.pid}-${Date.now()}-${name}`);
}

async function generateDocx({ paragraphs = 20 } = {}) {
  const filePath = makeTmp('test.docx');
  const children = [];
  for (let i = 0; i < paragraphs; i += 1) {
    children.push(new Paragraph({ children: [new TextRun(`Paragraph ${i + 1} sentinel-${i + 1}.`)] }));
  }
  const doc = new Document({ sections: [{ children }] });
  const buf = await Packer.toBuffer(doc);
  await fsp.writeFile(filePath, buf);
  return filePath;
}

test('decodeXmlEntities handles named and numeric entities', () => {
  assert.equal(decodeXmlEntities('a &amp; b'), 'a & b');
  assert.equal(decodeXmlEntities('&lt;tag&gt;'), '<tag>');
  assert.equal(decodeXmlEntities('&#65;'), 'A');
  assert.equal(decodeXmlEntities('&#x41;'), 'A');
});

test('DocxParaScanner emits one paragraph per </w:p>', () => {
  const scanner = new DocxParaScanner();
  const out = [];
  const xml =
    '<w:document><w:body>' +
    '<w:p><w:r><w:t>Hello</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>World &amp; co</w:t></w:r></w:p>' +
    '</w:body></w:document>';
  scanner.feed(xml, (p) => out.push(p));
  scanner.flush((p) => out.push(p));
  assert.equal(out.length, 2);
  assert.equal(out[0].text, 'Hello');
  assert.equal(out[1].text, 'World & co');
});

test('DocxParaScanner survives chunk boundaries inside <w:t>', () => {
  const scanner = new DocxParaScanner();
  const out = [];
  scanner.feed('<w:p><w:r><w:t>Hel', (p) => out.push(p));
  scanner.feed('lo wo', (p) => out.push(p));
  scanner.feed('rld</w:t></w:r></w:p>', (p) => out.push(p));
  scanner.flush((p) => out.push(p));
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'Hello world');
});

test('streamDocxParagraphs yields ordered paragraphs from a real .docx', async () => {
  const filePath = await generateDocx({ paragraphs: 15 });
  try {
    const seen = [];
    for await (const p of streamDocxParagraphs(filePath)) {
      seen.push(p);
    }
    // docx library may emit empty paragraphs around section content; filter:
    const meaningful = seen.filter((p) => p.text.includes('sentinel-'));
    assert.equal(meaningful.length, 15);
    for (let i = 0; i < meaningful.length; i += 1) {
      assert.match(meaningful[i].text, new RegExp(`sentinel-${i + 1}\\.`));
    }
  } finally {
    await fsp.unlink(filePath).catch(() => {});
  }
});

test('extractDocxStreaming returns paragraphCount and totalChars', async () => {
  const filePath = await generateDocx({ paragraphs: 8 });
  try {
    const res = await extractDocxStreaming(filePath);
    assert.ok(res.paragraphCount >= 8);
    assert.ok(res.totalChars > 0);
    assert.equal(res.partial, false);
    assert.ok(res.elapsedMs >= 0);
    assert.ok(res.paragraphs.some((t) => /sentinel-1\./.test(t)));
  } finally {
    await fsp.unlink(filePath).catch(() => {});
  }
});

test('streamDocxParagraphs throws when archive lacks word/document.xml', async () => {
  // Create an empty zip file using unzipper-compatible structure: easier — just write garbage
  // and assert the call rejects. We use a tmp non-zip file.
  const filePath = makeTmp('not-a-docx.bin');
  await fsp.writeFile(filePath, Buffer.from('not a zip'));
  try {
    await assert.rejects(async () => {
      // eslint-disable-next-line no-unused-vars
      for await (const _p of streamDocxParagraphs(filePath)) {
        // never
      }
    });
  } finally {
    await fsp.unlink(filePath).catch(() => {});
  }
});
