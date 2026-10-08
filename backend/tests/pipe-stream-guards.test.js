'use strict';

/**
 * Every route that pipes an upstream / file stream to the response must attach
 * an 'error' listener BEFORE piping (`pipeStreamToResponse`). A bare
 * `stream.pipe(res)` turns an asynchronous 'error' on the source (dev server
 * restarted mid-proxy, cache file unlinked, R2 body reset) into an unhandled
 * 'error' event → `uncaughtException` → process.exit(1): one failed download
 * took the whole backend down. Audit 2026-10-08.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { Readable } = require('node:stream');
const express = require('express');

const { pipeStreamToResponse } = require('../src/utils/pipe-stream-to-response');

const ROUTES = path.join(__dirname, '..', 'src', 'routes');
const read = (name) => fs.readFileSync(path.join(ROUTES, name), 'latin1');

async function withServer(handler, fn) {
  const app = express();
  app.get('/stream', handler);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    await fn(`http://127.0.0.1:${server.address().port}/stream`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8'), truncated: false }));
      res.on('aborted', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8'), truncated: true }));
      res.on('error', reject);
    }).on('error', (err) => {
      // A destroyed response surfaces here (ECONNRESET / socket hang up).
      resolve({ status: null, text: '', truncated: true, error: err.code || err.message });
    });
  });
}

function trackUncaught() {
  const seen = [];
  const onUncaught = (err) => seen.push(err);
  process.on('uncaughtException', onUncaught);
  return { seen, stop: () => process.off('uncaughtException', onUncaught) };
}

test('a web ReadableStream that errors before the first byte yields 500, not a crash', async () => {
  const tracker = trackUncaught();
  try {
    await withServer((req, res) => {
      const upstreamBody = new ReadableStream({
        pull(controller) { controller.error(new Error('upstream reset')); },
      });
      const body = Readable.fromWeb(upstreamBody);
      res.on('close', () => { if (!res.writableEnded) body.destroy(); });
      return pipeStreamToResponse(body, res, 'test-proxy');
    }, async (url) => {
      const res = await get(url);
      assert.equal(res.status, 500);
      assert.match(res.text, /Stream error/);
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(tracker.seen.length, 0, 'no uncaughtException escaped');
  } finally {
    tracker.stop();
  }
});

test('a stream that errors after headers were flushed truncates only that response', async () => {
  const tracker = trackUncaught();
  try {
    await withServer((req, res) => {
      let pushed = false;
      const source = new Readable({
        read() {
          if (!pushed) { pushed = true; this.push('partial-'); return; }
          setImmediate(() => this.destroy(new Error('cache file unlinked')));
        },
      });
      res.setHeader('Content-Type', 'application/octet-stream');
      return pipeStreamToResponse(source, res, 'test-file');
    }, async (url) => {
      const res = await get(url);
      assert.ok(res.truncated || res.status === 200, 'the client sees a cut response, the process survives');
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(tracker.seen.length, 0, 'no uncaughtException escaped');
  } finally {
    tracker.stop();
  }
});

test('no route pipes a raw stream to the response without the guard', () => {
  const expectations = {
    'code-runner.js': ['code-runner-proxy'],
    'github.js': ['workspace-proxy'],
    'thesis.js': ['thesis-preview', 'thesis-preview'],
    'rlhf.js': ['rlhf-export-remote', 'rlhf-export'],
    'agent-task.js': ['agent-task-preview-pdf'],
    'voice-studio.js': ['voice-studio-subtitles'],
  };
  for (const [file, labels] of Object.entries(expectations)) {
    const src = read(file);
    assert.match(src, /require\('\.\.\/utils\/pipe-stream-to-response'\)/, `${file} imports the guard`);
    for (const label of labels) {
      assert.ok(src.includes(`pipeStreamToResponse(`) && src.includes(`'${label}'`), `${file} pipes with label ${label}`);
    }
    assert.doesNotMatch(src, /Readable\.fromWeb\([^)]*\)\.pipe\(res\)/, `${file}: no bare fromWeb().pipe(res)`);
    assert.doesNotMatch(src, /createReadStream\([^)]*\)\.pipe\(res\)/, `${file}: no bare createReadStream().pipe(res)`);
    assert.doesNotMatch(src, /^\s*(?:file)?[sS]tream\.pipe\(res\);?\s*$/m, `${file}: no bare stream.pipe(res)`);
  }
  // Proxies destroy the upstream body when the client goes away mid-response.
  for (const file of ['code-runner.js', 'github.js']) {
    assert.match(read(file), /res\.on\('close', \(\) => \{ if \(!res\.writableEnded\) body\.destroy\(\); \}\);/, `${file} releases the upstream body on client close`);
  }
});
