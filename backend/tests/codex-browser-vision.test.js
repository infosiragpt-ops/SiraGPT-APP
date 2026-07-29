'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const browserCheck = require('../src/services/codex/browser-check');
const {
  checkApp,
  formatObservation,
  screenshotContentBlock,
  buildVisionObservation,
} = browserCheck;

function fakeBrowser({ screenshotImpl }) {
  const state = { screenshotCalls: [], viewport: null };
  const puppeteerImpl = {
    launch: async () => ({
      newPage: async () => ({
        setViewport: async (viewport) => { state.viewport = viewport; },
        on: () => {},
        goto: async () => {},
        evaluate: async () => ({ title: 'Preview', rootChars: 180, overlay: null }),
        screenshot: async (options) => {
          state.screenshotCalls.push(options);
          return screenshotImpl(options);
        },
      }),
      close: async () => {},
    }),
  };
  return { puppeteerImpl, state };
}

test('browser vision: bounded data URL becomes Anthropic and OpenRouter content blocks', async () => {
  const pixels = Buffer.from('mock-jpeg-pixels');
  const { puppeteerImpl, state } = fakeBrowser({
    screenshotImpl: () => pixels,
  });
  const result = await checkApp({
    url: 'http://preview.test',
    settleMs: 1,
    captureScreenshot: true,
    maxScreenshotBytes: 1_000,
    puppeteerImpl,
  });

  assert.equal(result.ok, true);
  assert.equal(result.screenshot.mediaType, 'image/jpeg');
  assert.ok(result.screenshot.byteLength <= 1_000);
  assert.equal(result.screenshot.dataUrl, `data:image/jpeg;base64,${pixels.toString('base64')}`);
  assert.deepEqual(state.viewport, { width: 1280, height: 720, deviceScaleFactor: 1 });
  assert.equal(state.screenshotCalls[0].fullPage, false);

  const anthropic = formatObservation(result, 'http://preview.test', {
    supportsVision: true,
    provider: 'Anthropic',
  });
  assert.ok(Array.isArray(anthropic));
  assert.equal(anthropic[0].type, 'text');
  assert.deepEqual(anthropic[1], {
    type: 'image',
    source: {
      type: 'base64',
      media_type: 'image/jpeg',
      data: pixels.toString('base64'),
    },
  });

  const openRouter = formatObservation(result, 'http://preview.test', {
    supportsVision: true,
    provider: 'OpenRouter',
  });
  assert.deepEqual(openRouter[1], {
    type: 'image_url',
    image_url: { url: result.screenshot.dataUrl },
  });

  const textOnly = formatObservation(result, 'http://preview.test', {
    supportsVision: false,
    provider: 'Anthropic',
  });
  assert.equal(typeof textOnly, 'string');
  assert.match(textOnly, /Render OK/);
});

test('browser vision: an oversized screenshot is omitted and falls back to text', async () => {
  const { puppeteerImpl, state } = fakeBrowser({
    screenshotImpl: () => Buffer.alloc(256, 1),
  });
  const result = await checkApp({
    url: 'http://preview.test',
    settleMs: 1,
    captureScreenshot: true,
    maxScreenshotBytes: 80,
    puppeteerImpl,
  });

  assert.equal(result.ok, true, 'la visión opcional no invalida el gate DOM');
  assert.equal(result.screenshot, undefined);
  assert.match(result.screenshotUnavailable, /^screenshot_too_large:/);
  assert.equal(state.screenshotCalls.length, 3, 'reduce calidad antes de degradar');

  const observation = formatObservation(result, 'http://preview.test', {
    supportsVision: true,
    provider: 'Anthropic',
  });
  assert.equal(typeof observation, 'string');
  assert.match(observation, /Captura visual no disponible/);
});

test('browser vision: viewport failure preserves the text browser check', async () => {
  let screenshotCalled = false;
  const puppeteerImpl = {
    launch: async () => ({
      newPage: async () => ({
        setViewport: async () => { throw new Error('viewport unsupported'); },
        on: () => {},
        goto: async () => {},
        evaluate: async () => ({ title: 'Preview', rootChars: 90, overlay: null }),
        screenshot: async () => {
          screenshotCalled = true;
          return Buffer.from('pixels');
        },
      }),
      close: async () => {},
    }),
  };
  const result = await checkApp({
    url: 'http://preview.test',
    settleMs: 1,
    captureScreenshot: true,
    puppeteerImpl,
  });

  assert.equal(result.ok, true);
  assert.equal(screenshotCalled, false);
  assert.match(result.screenshotUnavailable, /^viewport_failed:/);
  assert.match(formatObservation(result, 'http://preview.test'), /Render OK/);
});

test('browser vision: rejects malformed data URLs instead of emitting invalid model content', () => {
  assert.equal(screenshotContentBlock('not-a-data-url', 'anthropic'), null);
});

test('browser vision: quality degrades until the capture fits under the cap', async () => {
  const big = Buffer.alloc(2_000, 7);
  const small = Buffer.from('tiny-jpeg');
  const { puppeteerImpl, state } = fakeBrowser({
    screenshotImpl: () => (state.screenshotCalls.length <= 1 ? big : small),
  });
  const result = await checkApp({
    url: 'http://preview.test',
    settleMs: 1,
    captureScreenshot: true,
    maxScreenshotBytes: 200,
    puppeteerImpl,
  });

  assert.equal(result.ok, true);
  assert.ok(result.screenshot, 'una calidad menor que cabe se conserva');
  assert.equal(result.screenshot.dataUrl, `data:image/jpeg;base64,${small.toString('base64')}`);
  assert.ok(result.screenshot.byteLength <= 200);
  assert.equal(result.screenshotUnavailable, undefined);
  assert.ok(state.screenshotCalls.length >= 2, 'reintenta con calidad menor');
  const qualities = state.screenshotCalls.map((c) => c.quality);
  for (let i = 1; i < qualities.length; i += 1) {
    assert.ok(qualities[i] < qualities[i - 1], 'cada reintento baja la calidad');
  }
});

test('browser vision: a throwing screenshot never breaks the check — screenshot stays null', async () => {
  const { puppeteerImpl } = fakeBrowser({
    screenshotImpl: () => { throw new Error('gpu crashed'); },
  });
  const result = await checkApp({
    url: 'http://preview.test',
    settleMs: 1,
    captureScreenshot: true,
    puppeteerImpl,
  });

  assert.equal(result.ok, true, 'el fallo de captura no invalida el chequeo DOM');
  assert.equal(result.screenshot, undefined);
  assert.match(result.screenshotUnavailable, /^screenshot_failed:gpu crashed/);
  assert.equal(result.rendered, true);
});

test('buildVisionObservation: vision-capable model gets Anthropic content blocks', async () => {
  const pixels = Buffer.from('vision-pixels');
  const { puppeteerImpl } = fakeBrowser({ screenshotImpl: () => pixels });
  const result = await checkApp({
    url: 'http://preview.test',
    settleMs: 1,
    captureScreenshot: true,
    puppeteerImpl,
  });

  const blocks = buildVisionObservation({
    result,
    modelSupportsVision: true,
    url: 'http://preview.test',
  });
  assert.ok(Array.isArray(blocks));
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, 'text');
  assert.match(blocks[0].text, /Render OK/);
  assert.deepEqual(blocks[1], {
    type: 'image',
    source: {
      type: 'base64',
      media_type: 'image/jpeg',
      data: pixels.toString('base64'),
    },
  });
});

test('buildVisionObservation: text-only model or missing screenshot keeps the string contract', async () => {
  const pixels = Buffer.from('vision-pixels');
  const { puppeteerImpl } = fakeBrowser({ screenshotImpl: () => pixels });
  const withShot = await checkApp({
    url: 'http://preview.test',
    settleMs: 1,
    captureScreenshot: true,
    puppeteerImpl,
  });

  const textOnly = buildVisionObservation({
    result: withShot,
    modelSupportsVision: false,
    url: 'http://preview.test',
  });
  assert.equal(typeof textOnly, 'string');
  assert.match(textOnly, /Render OK/);

  const { puppeteerImpl: noShotImpl } = fakeBrowser({ screenshotImpl: () => Buffer.from('x') });
  const withoutShot = await checkApp({
    url: 'http://preview.test',
    settleMs: 1,
    captureScreenshot: false,
    puppeteerImpl: noShotImpl,
  });
  const noScreenshot = buildVisionObservation({
    result: withoutShot,
    modelSupportsVision: true,
    url: 'http://preview.test',
  });
  assert.equal(typeof noScreenshot, 'string');
  assert.match(noScreenshot, /Render OK/);

  const degenerate = buildVisionObservation({ result: null, modelSupportsVision: true });
  assert.equal(typeof degenerate, 'string');
  assert.match(degenerate, /No pude abrir la app/);
});

test('browser vision: previous module exports remain present and typed', () => {
  assert.equal(typeof browserCheck.checkApp, 'function');
  assert.equal(typeof browserCheck.captureBoundedScreenshot, 'function');
  assert.equal(typeof browserCheck.screenshotContentBlock, 'function');
  assert.equal(typeof browserCheck.formatObservation, 'function');
  assert.equal(typeof browserCheck.formatReport, 'function');
  assert.equal(typeof browserCheck.devUrlFor, 'function');
  assert.equal(typeof browserCheck.chromiumExecutablePath, 'function');
  assert.equal(typeof browserCheck.buildVisionObservation, 'function');
  assert.equal(typeof browserCheck.DEFAULT_MAX_SCREENSHOT_BYTES, 'number');
  assert.equal(typeof browserCheck.ABSOLUTE_MAX_SCREENSHOT_BYTES, 'number');
});
