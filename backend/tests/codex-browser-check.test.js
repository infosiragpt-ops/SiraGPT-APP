'use strict';

/**
 * codex/browser-check — offline unit tests (injectable fake puppeteer).
 *
 * Covers: dev URL derivation (explicit env / runner-host fallback / default),
 * chromium path resolution, the checkApp happy path, runtime-error capture
 * (pageerror + console.error + overlay + blank root), unavailable degradation,
 * report formatting, and the browser_check tool contract (dev-server gate).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const bc = require('../src/services/codex/browser-check');
const buildTools = require('../src/services/codex/build-tools');

test('devUrlFor: explicit env wins, runner host fallback, localhost default', () => {
  assert.equal(bc.devUrlFor({ CODE_RUNNER_DEV_URL: 'http://runner:9999' }, 5173), 'http://runner:5173');
  assert.equal(bc.devUrlFor({ CODE_RUNNER_URL: 'http://runner:4097' }, 5173), 'http://runner:5173');
  assert.equal(bc.devUrlFor({}, 5173), 'http://localhost:5173');
});

test('chromiumExecutablePath: puppeteer env, playwright fallback, undefined', () => {
  assert.equal(bc.chromiumExecutablePath({ PUPPETEER_EXECUTABLE_PATH: '/a' }), '/a');
  assert.equal(bc.chromiumExecutablePath({ PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: '/b' }), '/b');
  assert.equal(bc.chromiumExecutablePath({}), undefined);
});

function fakePuppeteer({ snapshot, fire = [] } = {}) {
  return {
    launch: async () => ({
      newPage: async () => {
        const handlers = {};
        return {
          on: (evt, cb) => { handlers[evt] = cb; },
          goto: async () => {
            for (const [evt, payload] of fire) {
              if (evt === 'console') {
                const p = typeof payload === 'object' ? payload : { text: payload };
                handlers.console?.({
                  type: () => 'error',
                  text: () => p.text,
                  ...(p.url ? { location: () => ({ url: p.url }) } : {}),
                });
              }
              else if (evt === 'pageerror') handlers.pageerror?.(new Error(payload));
              else if (evt === 'requestfailed') handlers.requestfailed?.({ url: () => payload, failure: () => ({ errorText: 'ERR' }) });
            }
          },
          evaluate: async () => snapshot,
        };
      },
      close: async () => {},
    }),
  };
}

test('checkApp: healthy render → ok', async () => {
  const r = await bc.checkApp({
    url: 'http://x:5173',
    settleMs: 1,
    puppeteerImpl: fakePuppeteer({ snapshot: { title: 'Mi App', rootChars: 240, overlay: null } }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.rendered, true);
  assert.match(bc.formatReport(r, 'http://x:5173'), /Render OK/);
});

test('checkApp: blank root + exception + overlay → not ok, all reported', async () => {
  const r = await bc.checkApp({
    url: 'http://x:5173',
    settleMs: 1,
    puppeteerImpl: fakePuppeteer({
      snapshot: { title: '', rootChars: 0, overlay: 'Failed to resolve import "./Nope"' },
      fire: [['pageerror', 'Cannot read properties of undefined'], ['console', 'boom'], ['requestfailed', 'http://x/bundle.js']],
    }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.rendered, false);
  assert.equal(r.errors.length, 3);
  const report = bc.formatReport(r, 'http://x:5173');
  assert.match(report, /#root está VACÍO/);
  assert.match(report, /Overlay de error de Vite/);
  assert.match(report, /Cannot read properties/);
});

test('checkApp: favicon/map request failures are ignored', async () => {
  const r = await bc.checkApp({
    url: 'http://x:5173',
    settleMs: 1,
    puppeteerImpl: fakePuppeteer({
      snapshot: { title: 't', rootChars: 10, overlay: null },
      fire: [['requestfailed', 'http://x/favicon.ico'], ['requestfailed', 'http://x/app.js.map']],
    }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.errors.length, 0);
});

test('checkApp: favicon console 404 is noise; real resource errors carry their URL', async () => {
  const r = await bc.checkApp({
    url: 'http://x:5173',
    settleMs: 1,
    puppeteerImpl: fakePuppeteer({
      snapshot: { title: 't', rootChars: 10, overlay: null },
      fire: [
        ['console', { text: 'Failed to load resource: the server responded with a status of 404 (Not Found)', url: 'http://x/favicon.ico' }],
        ['console', { text: 'Failed to load resource: the server responded with a status of 404 (Not Found)', url: 'http://x/src/data.json' }],
      ],
    }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /src\/data\.json/);
});

test('checkApp: launch failure degrades to unavailable (never throws)', async () => {
  const r = await bc.checkApp({
    url: 'http://x:5173',
    puppeteerImpl: { launch: async () => { throw new Error('no chromium'); } },
  });
  assert.equal(r.unavailable, true);
  assert.match(bc.formatReport(r, 'x'), /No pude abrir la app/);
});

test('browser_check tool: gates on dev-server readiness', async () => {
  const tool = buildTools.getTool('browser_check');
  const runner = {
    devStatus: async () => ({ running: true, ready: false, error: 'boot loop', project: 'p1' }),
    startDev: async () => {},
  };
  const out = await tool.execute({ waitMs: 2000 }, { runner, project: 'p1' });
  assert.equal(out.isError, true);
  assert.match(out.observation, /no llegó a estar listo/);
});

test('browser_check tool: registered with web kind', () => {
  const entry = buildTools.toolRegistry().find((t) => t.name === 'browser_check');
  assert.ok(entry);
  assert.equal(buildTools.TOOLS.browser_check.kind, 'web');
});
