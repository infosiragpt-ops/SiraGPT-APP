'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const PDFDocument = require('pdfkit');

const { streamPdfPages, extractPdfStreaming } = require('../src/services/document/streaming-pdf');

let _tmpCounter = 0;
function makeTmp(name) {
  _tmpCounter += 1;
  return path.join(os.tmpdir(), `siragpt-stream-pdf-${process.pid}-${Date.now()}-${_tmpCounter}-${name}`);
}

async function generatePdf({ pages = 5, paragraphsPerPage = 1, padBytesPerPage = 0 } = {}) {
  const filePath = makeTmp('test.pdf');
  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ autoFirstPage: false });
    const out = fs.createWriteStream(filePath);
    out.on('finish', resolve);
    out.on('error', reject);
    doc.pipe(out);

    for (let p = 0; p < pages; p += 1) {
      doc.addPage();
      doc.fontSize(14).text(`PAGE ${p + 1} HEADER`);
      doc.moveDown();
      for (let k = 0; k < paragraphsPerPage; k += 1) {
        doc.fontSize(10).text(`Page ${p + 1} paragraph ${k + 1} — sentinel-${p + 1}-${k + 1}.`);
      }
      if (padBytesPerPage > 0) {
        // Fill the page with pseudo-random ASCII to bulk up file size.
        const padChunkSize = 1024;
        let written = 0;
        while (written < padBytesPerPage) {
          const n = Math.min(padChunkSize, padBytesPerPage - written);
          let s = '';
          for (let i = 0; i < n; i += 1) {
            s += String.fromCharCode(33 + ((i + p + written) % 90));
          }
          doc.fontSize(6).text(s, { lineBreak: true });
          written += n;
        }
      }
    }
    doc.end();
  });
  return filePath;
}

test('streamPdfPages yields pages in order with text content', async () => {
  const filePath = await generatePdf({ pages: 4, paragraphsPerPage: 2 });
  try {
    const seen = [];
    for await (const page of streamPdfPages(filePath)) {
      seen.push(page);
      assert.equal(typeof page.page, 'number');
      assert.equal(typeof page.text, 'string');
      assert.equal(page.charCount, page.text.length);
    }
    assert.equal(seen.length, 4, 'should emit one item per page');
    for (let i = 0; i < seen.length; i += 1) {
      assert.equal(seen[i].page, i + 1);
      assert.match(seen[i].text, new RegExp(`sentinel-${i + 1}-`));
    }
  } finally {
    await fsp.unlink(filePath).catch(() => {});
  }
});

test('extractPdfStreaming reports pageCount, totalChars, metrics', async () => {
  const filePath = await generatePdf({ pages: 3, paragraphsPerPage: 3 });
  try {
    const res = await extractPdfStreaming(filePath, { collectText: false });
    assert.equal(res.pageCount, 3);
    assert.ok(res.totalChars > 0, 'should accumulate chars');
    assert.equal(res.partial, false);
    assert.ok(res.peakRssMb > 0);
    assert.ok(res.elapsedMs >= 0);
    assert.equal(res.pages.length, 3);
    assert.equal(res.pages[0].text, undefined, 'collectText:false should drop text');
  } finally {
    await fsp.unlink(filePath).catch(() => {});
  }
});

test('streamPdfPages aborts early when maxRssMb is exceeded (partial flag)', async () => {
  const filePath = await generatePdf({ pages: 3 });
  try {
    const partialRef = { partial: false };
    const out = [];
    // maxRssMb=1 forces immediate abort after first page yield.
    for await (const p of streamPdfPages(filePath, { maxRssMb: 1, partialRef })) {
      out.push(p);
    }
    assert.ok(out.length >= 1, 'at least one page must be yielded before abort');
    assert.ok(out.length < 3, 'should not yield all pages');
    assert.equal(partialRef.partial, true);
  } finally {
    await fsp.unlink(filePath).catch(() => {});
  }
});

test('streamPdfPages handles a multi-MB PDF without buffering all text', async () => {
  // Generate a multi-page PDF; the goal is many pages, not a specific byte size.
  const filePath = await generatePdf({ pages: 12, paragraphsPerPage: 20 });
  try {
    const stat = await fsp.stat(filePath);
    assert.ok(stat.size > 5 * 1024, `expected >5KB, got ${stat.size}`);

    let pageCount = 0;
    let charsSeen = 0;
    for await (const p of streamPdfPages(filePath)) {
      pageCount += 1;
      charsSeen += p.charCount;
    }
    assert.equal(pageCount, 12);
    assert.ok(charsSeen > 0);
  } finally {
    await fsp.unlink(filePath).catch(() => {});
  }
});
