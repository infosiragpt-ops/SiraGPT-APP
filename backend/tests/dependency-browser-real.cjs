'use strict';

// Explicit integration command, not an optional/skipped unit test. Requires
// installed Chrome (PUPPETEER_EXECUTABLE_PATH or Puppeteer's managed browser).
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkApp } = require('../src/services/codex/browser-check');
const officeParser = require('officeparser');

test('installed Puppeteer drives the actual backend browser check, screenshot and PDF export offline', async () => {
  const marker = 'SIRA browser runtime compatibility';
  const html = `<html><head><title>Offline integration</title></head><body><div id="root">${marker}</div></body></html>`;
  const result = await checkApp({ url: `data:text/html,${encodeURIComponent(html)}`, expectedText: marker,
    settleMs: 0, captureScreenshot: true, timeoutMs: 20000 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.expectedTextFound, true);
  assert.match(result.screenshot?.dataUrl || '', /^data:image\//);

  const puppeteer = (await import('puppeteer')).default;
  const browser = await puppeteer.launch({ executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    const pdf = Buffer.from(await page.pdf({ format: 'A4', printBackground: true }));
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    const parsed = await officeParser.parseOffice(pdf, { ocr: false, outputErrorToConsole: false });
    assert.ok(parsed.toText().includes(marker));
  } finally { await browser.close(); }
});
