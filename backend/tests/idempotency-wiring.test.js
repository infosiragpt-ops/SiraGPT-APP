/**
 * idempotency-wiring — integration-level pin for the middleware as it
 * is actually mounted in index.js: an express app with json body
 * parsing followed by the middleware and a counting POST handler.
 * Covers the three client-visible retry behaviors:
 *   (i)   same key + same body → replayed body, handler ran once
 *   (ii)  same key + different body → 409, handler not re-run
 *   (iii) no key → handler runs normally every time
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const {
  idempotencyMiddleware,
  createInMemoryIdempotencyStore,
  REPLAY_HEADER,
} = require('../src/middleware/idempotency');

function buildApp({ store }) {
  const app = express();
  app.use(express.json());
  const mw = idempotencyMiddleware({
    store,
    env: { IDEMPOTENCY_ENABLED: 'true' },
  });
  let handlerRuns = 0;
  app.use('/api/generate', mw);
  app.post('/api/generate/word', (req, res) => {
    handlerRuns += 1;
    res.status(201).json({ ok: true, runs: handlerRuns });
  });
  app.post('/api/generate/stream', (req, res) => {
    handlerRuns += 1;
    res.setHeader('Content-Type', 'text/event-stream');
    res.write('data: chunk\n\n');
    res.end();
  });
  app.get('/api/generate/status', (req, res) => {
    res.json({ runs: handlerRuns });
  });
  app._handlerRuns = () => handlerRuns;
  return app;
}

describe('idempotency wiring — express integration', () => {
  test('same key + same body replays the first 2xx and runs the handler once', async () => {
    const app = buildApp({ store: createInMemoryIdempotencyStore() });
    const payload = { prompt: 'hello', model: 'gpt-4o' };

    const first = await request(app)
      .post('/api/generate/word')
      .set('Idempotency-Key', 'op-wire-1')
      .send(payload);
    assert.equal(first.status, 201);
    assert.equal(first.body.runs, 1);
    assert.equal(first.headers[REPLAY_HEADER.toLowerCase()], 'fresh');

    const replay = await request(app)
      .post('/api/generate/word')
      .set('Idempotency-Key', 'op-wire-1')
      .send(payload);
    assert.equal(replay.status, 201);
    assert.equal(replay.headers[REPLAY_HEADER.toLowerCase()], 'true');
    assert.deepEqual(replay.body, { ok: true, runs: 1 }, 'replayed body must be the captured one');
    assert.equal(app._handlerRuns(), 1, 'expensive handler must execute exactly once');
  });

  test('same key + different body returns 409 and does not run the handler again', async () => {
    const app = buildApp({ store: createInMemoryIdempotencyStore() });

    const first = await request(app)
      .post('/api/generate/word')
      .set('Idempotency-Key', 'op-wire-2')
      .send({ prompt: 'first' });
    assert.equal(first.status, 201);

    const mismatch = await request(app)
      .post('/api/generate/word')
      .set('Idempotency-Key', 'op-wire-2')
      .send({ prompt: 'second' });
    assert.equal(mismatch.status, 409);
    assert.equal(mismatch.body.error, 'idempotency-key-mismatch');
    assert.equal(app._handlerRuns(), 1);
  });

  test('no Idempotency-Key header passes through and runs the handler every time', async () => {
    const app = buildApp({ store: createInMemoryIdempotencyStore() });

    const a = await request(app).post('/api/generate/word').send({ prompt: 'a' });
    const b = await request(app).post('/api/generate/word').send({ prompt: 'a' });
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.equal(b.headers[REPLAY_HEADER.toLowerCase()], undefined);
    assert.equal(app._handlerRuns(), 2, 'un-keyed retries must run fresh');
  });

  test('GET requests are never intercepted even with a key', async () => {
    const app = buildApp({ store: createInMemoryIdempotencyStore() });
    const res = await request(app)
      .get('/api/generate/status')
      .set('Idempotency-Key', 'op-wire-3');
    assert.equal(res.status, 200);
    assert.equal(res.headers[REPLAY_HEADER.toLowerCase()], undefined);
  });

  test('SSE responses are not captured — retry runs the stream handler again', async () => {
    const app = buildApp({ store: createInMemoryIdempotencyStore() });

    const first = await request(app)
      .post('/api/generate/stream')
      .set('Idempotency-Key', 'op-wire-4');
    assert.equal(first.status, 200);

    const second = await request(app)
      .post('/api/generate/stream')
      .set('Idempotency-Key', 'op-wire-4');
    assert.equal(second.status, 200);
    assert.equal(app._handlerRuns(), 2, 'streaming responses must never be cached');
  });
});
