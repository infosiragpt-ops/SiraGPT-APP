'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  checkApp,
  formatObservation,
  screenshotContentBlock,
} = require('../src/services/codex/browser-check');

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
