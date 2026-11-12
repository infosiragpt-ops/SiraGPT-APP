'use strict';

// Word files built with pandoc (document-service createDocx). The table
// styling pass after pandoc is linear, pandoc is bounded, and the reference
// document is written once. A batch of 10 long transcripts used to block the
// API process (which also runs the media worker) for ~40 s in a pass that
// never changed a byte: it looked for a bare <w:t>, which pandoc never writes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const PizZip = require('pizzip');

const { styleDocxTables, pandocTimeoutMs, ensureReferenceDoc, rezipDocx } = require('../src/services/document-service')._internals;

// What pandoc writes: every run's text carries xml:space="preserve".
function run(text) {
  return `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
}
function table(rows) {
  const cell = text => `<w:tc><w:tcPr><w:tcW w:type="pct" w:w="2500" /></w:tcPr><w:p>${run(text)}</w:p></w:tc>`;
  return `<w:tbl><w:tblPr><w:tblStyle w:val="Table" /></w:tblPr><w:tblGrid><w:gridCol w:w="4680" /><w:gridCol w:w="4680" /></w:tblGrid>`
    + Array.from({ length: rows }, (_, i) => `<w:tr>${cell(`Campo ${i}`)}${cell(`Valor ${i}`)}</w:tr>`).join('') + '</w:tbl>';
}
function paragraphs(chars) {
  const words = 'la mitocondria produce energía para la célula durante la respiración celular '.repeat(4);
  const out = [];
  for (let size = 0; size < chars; size += words.length + 40) out.push(`<w:p>${run(words)}</w:p>`);
  return out.join('');
}
function documentXml(body) {
  return `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
}

// The four passes production ran before this change, for the equivalence check.
function previousPipeline(xml) {
  const styled = styleDocxTables(xml);
  // The dropped pass: on pandoc output it never matches, so it never changed a byte.
  const third = /(<w:tr>[\s\S]*?<w:tbl>[\s\S]*?<w:tc>[\s\S]*?<w:t>)/g;
  assert.equal(third.test(xml), false, 'no bare <w:t> in pandoc output');
  return styled;
}

test('the table pass styles every table and leaves the text runs as pandoc wrote them', () => {
  const xml = documentXml(`${paragraphs(2_000)}${table(4)}${paragraphs(2_000)}${table(3)}`);
  const styled = previousPipeline(xml);
  assert.equal((styled.match(/<w:tblBorders>/g) || []).length, 2, 'borders on both tables');
  assert.equal((styled.match(/<w:tblCellMar>/g) || []).length, 2);
  assert.equal((styled.match(/<w:tcMar>/g) || []).length, (xml.match(/<w:tcPr>/g) || []).length, 'margins on every cell');
  // Unchanged behaviour: the header fill looks for <w:tbl> within 250
  // characters of the row, and the border block written just before pushes
  // it farther away.
  assert.equal((styled.match(/w:fill="4472C4"/g) || []).length, 0);
  assert.equal((styled.match(/<w:t xml:space="preserve">/g) || []).length, (xml.match(/<w:t xml:space="preserve">/g) || []).length);
  assert.doesNotMatch(styled, /w:color w:val="FFFFFF"/, 'runs untouched, as before');
  // Idempotent on the text: nothing outside the table properties moves.
  const strip = value => value.replace(/<w:tblPr>[\s\S]*?<\/w:tblPr>/g, '').replace(/<w:tcPr>[\s\S]*?<\/w:tcPr>/g, '');
  assert.equal(strip(styled), strip(xml));
});

test('a long multi-recording transcript is styled in well under a second', () => {
  // 20 tables of 11 rows, each followed by ~400 KB of text: the shape of a
  // batch of long transcripts. The removed pass took minutes on this.
  let body = '';
  for (let i = 0; i < 20; i++) body += table(11) + paragraphs(400_000);
  const xml = documentXml(body);
  assert.ok(xml.length > 8_000_000);
  const started = process.hrtime.bigint();
  const styled = styleDocxTables(xml);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 1000, `took ${ms.toFixed(0)} ms`);
  assert.equal((styled.match(/<w:tblBorders>/g) || []).length, 20);
});

test('pandoc gets a bounded wall clock', () => {
  assert.equal(pandocTimeoutMs({}), 120000);
  assert.equal(pandocTimeoutMs({ SIRAGPT_PANDOC_TIMEOUT_MS: 'nope' }), 120000);
  assert.equal(pandocTimeoutMs({ SIRAGPT_PANDOC_TIMEOUT_MS: '1' }), 5000);
  assert.equal(pandocTimeoutMs({ SIRAGPT_PANDOC_TIMEOUT_MS: '90000' }), 90000);
  assert.equal(pandocTimeoutMs({ SIRAGPT_PANDOC_TIMEOUT_MS: '99999999' }), 600000);
});

test('the reference document is written once, to a content-addressed path', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sira-reference-doc-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const [a, b, c] = await Promise.all([ensureReferenceDoc(dir), ensureReferenceDoc(dir), ensureReferenceDoc(dir)]);
  assert.equal(a, b);
  assert.equal(b, c);
  assert.match(path.basename(a), /^reference-[0-9a-f]{16}\.docx$/);
  const bytes = await fsp.readFile(a);
  assert.ok(new PizZip(bytes).file('word/document.xml'), 'a real Word file');
  const before = (await fsp.stat(a)).mtimeMs;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(await ensureReferenceDoc(dir), a);
  assert.equal((await fsp.stat(a)).mtimeMs, before, 'not rewritten while another conversion may read it');
  assert.deepEqual((await fsp.readdir(dir)).filter(name => name.endsWith('.tmp')), [], 'no partial files left');
  // Removed by a temp sweep: written again.
  await fsp.rm(a);
  assert.equal(await ensureReferenceDoc(dir), a);
  assert.deepEqual(await fsp.readFile(a), bytes);
});

test('a pandoc that does not finish is killed and reported as such', async () => {
  const childProcess = require('child_process');
  const originalExecSync = childProcess.execSync;
  const originalExecFile = childProcess.execFile;
  const resolved = require.resolve('../src/services/document-service');
  const previousModule = require.cache[resolved];
  const calls = [];
  childProcess.execSync = () => Buffer.from('pandoc 3');
  childProcess.execFile = (file, args, options, callback) => {
    calls.push({ file, options });
    if (calls.length === 1) {
      const outputPath = args[args.indexOf('-o') + 1];
      const zip = new PizZip();
      zip.file('word/document.xml', documentXml(table(2)));
      fs.writeFileSync(outputPath, zip.generate({ type: 'nodebuffer' }));
      callback(null, '', '');
      return;
    }
    callback(Object.assign(new Error('Command failed: pandoc'), { killed: true, signal: 'SIGKILL' }), '', '');
  };
  delete require.cache[resolved];
  const userId = `pandoc-timeout-${process.pid}`;
  try {
    const { createDocument } = require('../src/services/document-service');
    const made = await createDocument(userId, 'a.docx', '# A\n\n| x | y |\n|---|---|\n| 1 | 2 |');
    assert.ok(fs.existsSync(made.filePath));
    assert.equal(calls[0].file, 'pandoc');
    assert.equal(calls[0].options.timeout, 120000);
    assert.equal(calls[0].options.killSignal, 'SIGKILL');
    await assert.rejects(createDocument(userId, 'b.docx', '# B'), { code: 'pandoc_timeout' });
  } finally {
    childProcess.execSync = originalExecSync;
    childProcess.execFile = originalExecFile;
    if (previousModule) require.cache[resolved] = previousModule;
    else delete require.cache[resolved];
    await fsp.rm(path.join(__dirname, '../uploads/documents', userId), { recursive: true, force: true });
  }
});

test('the styled Word is written back compressed, close to what pandoc wrote', () => {
  // A long transcript: many timestamped paragraphs, highly repetitive XML.
  const body = Array.from({ length: 4000 }, (_, i) => `<w:p>${run(`[00:${String(i % 60).padStart(2, '0')}:00] El profesor explica la mitocondria y la célula.`)}</w:p>`).join('');
  const zip = new PizZip();
  zip.file('[Content_Types].xml', '<Types/>');
  zip.file('word/document.xml', `<w:document><w:body>${body}</w:body></w:document>`);
  const stored = zip.generate({ type: 'nodebuffer' });
  const written = rezipDocx(zip);
  assert.ok(written.length * 5 < stored.length, `${written.length} vs ${stored.length} stored`);
  assert.equal(new PizZip(written).file('word/document.xml').asText(), zip.file('word/document.xml').asText());
});
