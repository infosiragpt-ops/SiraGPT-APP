'use strict';

/**
 * Tests for the validate-payload-size middleware. We avoid spinning up a
 * full HTTP server where possible — most behaviour is observable via the
 * Content-Length short-circuit, which only needs req-like / res-like
 * shims. The streaming branch DOES need a real socket, so we cover that
 * with one in-process http.Server test.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { EventEmitter } = require('node:events');

const validatePayloadSize = require('../src/middleware/validate-payload-size');

function makeRes() {
  const headers = {};
  const res = {
    statusCode: 200,
    headersSent: false,
    headers,
    _json: null,
    setHeader(key, value) { headers[String(key).toLowerCase()] = value; },
    getHeader(key) { return headers[String(key).toLowerCase()]; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this._json = payload; this.headersSent = true; return this; },
  };
  return res;
}

function makeReq({ method = 'POST', contentType, contentLength, requestId, id, headers = {} } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = { ...headers };
  if (contentType !== undefined) req.headers['content-type'] = contentType;
  if (contentLength !== undefined) req.headers['content-length'] = String(contentLength);
  if (requestId !== undefined) req.headers['x-request-id'] = requestId;
  if (id !== undefined) req.id = id;
  req.pause = () => {};
  return req;
}

describe('validate-payload-size — header short-circuit', () => {
  test('passes through GET requests regardless of headers', () => {
    const mw = validatePayloadSize({ jsonBytes: 10 });
    const req = makeReq({ method: 'GET', contentType: 'application/json', contentLength: 9_999 });
    const res = makeRes();
    let called = false;
    mw(req, res, () => { called = true; });
    assert.equal(called, true);
    assert.equal(res.statusCode, 200);
  });

  test('passes through unrelated content types (text/plain)', () => {
    const mw = validatePayloadSize({ jsonBytes: 10 });
    const req = makeReq({ contentType: 'text/plain', contentLength: 9_999 });
    const res = makeRes();
    let called = false;
    mw(req, res, () => { called = true; });
    assert.equal(called, true);
  });

  test('rejects JSON over the limit with 413 + structured envelope', () => {
    const mw = validatePayloadSize({ jsonBytes: 1024 });
    const req = makeReq({ contentType: 'application/json', contentLength: 2048, requestId: 'req-payload-1' });
    const res = makeRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 413);
    assert.equal(res._json.code, 'payload.too_large');
    assert.equal(res._json.message, 'Payload too large');
    assert.equal(res._json.kind, 'json');
    assert.equal(res._json.limit, 1024);
    assert.equal(res._json.received, 2048);
    assert.equal(res._json.requestId, 'req-payload-1');
    assert.equal(res.getHeader('Cache-Control'), 'no-store');
    assert.equal(res.getHeader('X-Content-Type-Options'), 'nosniff');
  });

  test('rejects multipart over the limit', () => {
    const mw = validatePayloadSize({ multipartBytes: 1024 });
    const req = makeReq({
      contentType: 'multipart/form-data; boundary=----x',
      contentLength: 5000,
    });
    const res = makeRes();
    mw(req, res, () => { throw new Error('next should not be called'); });
    assert.equal(res.statusCode, 413);
    assert.equal(res._json.kind, 'multipart');
  });

  test('accepts JSON at exactly the limit', () => {
    const mw = validatePayloadSize({ jsonBytes: 1024 });
    const req = makeReq({ contentType: 'application/json', contentLength: 1024 });
    const res = makeRes();
    let called = false;
    mw(req, res, () => { called = true; });
    assert.equal(called, true);
  });

  test('accepts JSON+vendor mime (application/vnd.foo+json)', () => {
    const mw = validatePayloadSize({ jsonBytes: 10 });
    const req = makeReq({ contentType: 'application/vnd.foo+json', contentLength: 5 });
    const res = makeRes();
    let called = false;
    mw(req, res, () => { called = true; });
    assert.equal(called, true);
  });

  test('trims content-type before classifying it', () => {
    const mw = validatePayloadSize({ jsonBytes: 10 });
    const req = makeReq({ contentType: '  application/json; charset=utf-8  ', contentLength: 5 });
    const res = makeRes();
    let called = false;
    mw(req, res, () => { called = true; });
    assert.equal(called, true);
  });

  test('rejects malformed Content-Length before body parsing', () => {
    const calls = [];
    const mw = validatePayloadSize({ jsonBytes: 1024, onReject: (_req, info) => calls.push(info) });
    const req = makeReq({
      contentType: 'application/json',
      headers: { 'content-length': '12.5', 'x-request-id': 'req-invalid-length' },
    });
    const res = makeRes();
    let nextCalled = false;

    mw(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 400);
    assert.equal(res._json.code, 'payload.invalid_content_length');
    assert.equal(res._json.error, 'Invalid Content-Length');
    assert.equal(res._json.received, null);
    assert.equal(res._json.requestId, 'req-invalid-length');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].stage, 'header-invalid');
    assert.equal(calls[0].requestId, 'req-invalid-length');
  });

  test('does not include an unsafe request id in payload rejection body', () => {
    const mw = validatePayloadSize({ jsonBytes: 8 });
    const req = makeReq({
      contentType: 'application/json',
      contentLength: 100,
      requestId: 'bad\r\nx-owned: 1',
    });
    const res = makeRes();

    mw(req, res, () => {});

    assert.equal(res.statusCode, 413);
    assert.equal(res._json.requestId, undefined);
  });

  test('limit=0 disables the branch (opt-out)', () => {
    const mw = validatePayloadSize({ jsonBytes: 0 });
    const req = makeReq({ contentType: 'application/json', contentLength: 99_999_999 });
    const res = makeRes();
    let called = false;
    mw(req, res, () => { called = true; });
    assert.equal(called, true);
  });

  test('onReject fires with stage=header when Content-Length oversize', () => {
    const calls = [];
    const mw = validatePayloadSize({ jsonBytes: 8, onReject: (req, info) => calls.push(info) });
    const req = makeReq({ contentType: 'application/json', contentLength: 100, requestId: 'req-reject-metric' });
    mw(req, makeRes(), () => {});
    assert.equal(calls.length, 1);
    assert.equal(calls[0].stage, 'header');
    assert.equal(calls[0].limit, 8);
    assert.equal(calls[0].requestId, 'req-reject-metric');
  });
});

describe('validate-payload-size — defaults', () => {
  test('defaults are 1MB JSON / 10MB multipart', () => {
    assert.equal(validatePayloadSize.DEFAULT_JSON_BYTES, 1024 * 1024);
    assert.equal(validatePayloadSize.DEFAULT_MULTIPART_BYTES, 10 * 1024 * 1024);
  });

  test('classifyContentType is exported and correct', () => {
    const c = validatePayloadSize.classifyContentType;
    assert.equal(c('application/json'), 'json');
    assert.equal(c('application/json; charset=utf-8'), 'json');
    assert.equal(c(' application/json; charset=utf-8 '), 'json');
    assert.equal(c('application/ld+json'), 'json');
    assert.equal(c('multipart/form-data; boundary=x'), 'multipart');
    assert.equal(c('text/plain'), 'other');
    assert.equal(c(''), 'other');
    assert.equal(c(undefined), 'other');
  });

  test('parseContentLength handles bad input', () => {
    const p = validatePayloadSize.parseContentLength;
    assert.equal(Number.isNaN(p(undefined)), true);
    assert.equal(Number.isNaN(p('')), true);
    assert.equal(Number.isNaN(p('not-a-number')), true);
    assert.equal(Number.isNaN(p('-5')), true);
    assert.equal(Number.isNaN(p('1.5')), true);
    assert.equal(p('123'), 123);
    assert.equal(p(' 123 '), 123);
    assert.equal(p('1024'), 1024);
  });

  test('isMalformedContentLength distinguishes missing from invalid values', () => {
    const f = validatePayloadSize.isMalformedContentLength;
    assert.equal(f(undefined), false);
    assert.equal(f(''), false);
    assert.equal(f('123'), false);
    assert.equal(f(' 123 '), false);
    assert.equal(f('12.5'), true);
    assert.equal(f('-1'), true);
    assert.equal(f(String(Number.MAX_SAFE_INTEGER + 1)), true);
  });
});

describe('validate-payload-size — streaming guard (no Content-Length)', () => {
  test('rejects with 413 when streamed body exceeds cap', async () => {
    const mw = validatePayloadSize({ jsonBytes: 64 });
    // Use a tiny express app so res.status/res.json work as in real use.
    const app = express();
    app.post('/', mw, (req, res) => {
      let total = 0;
      req.on('data', (c) => { total += c.length; });
      req.on('end', () => {
        if (!res.headersSent) res.json({ total });
      });
    });
    const server = http.createServer(app);

    await new Promise((resolve) => server.listen(0, resolve));
    try {
      const { port } = server.address();
      const result = await new Promise((resolve, reject) => {
        const r = http.request(
          {
            hostname: '127.0.0.1',
            port,
            method: 'POST',
            path: '/',
            headers: {
              'content-type': 'application/json',
              // Force chunked transfer (no Content-Length) so the streaming
              // path is exercised.
              'transfer-encoding': 'chunked',
            },
          },
          (res) => {
            let buf = '';
            res.on('data', (c) => { buf += c; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
          },
        );
        r.on('error', reject);
        // Write 256 bytes of garbage to exceed the 64-byte cap.
        r.write(Buffer.alloc(256, 0x41));
        r.end();
      });

      assert.equal(result.status, 413);
      const parsed = JSON.parse(result.body);
      assert.equal(parsed.code, 'payload.too_large');
      assert.equal(parsed.kind, 'json');
      assert.equal(parsed.limit, 64);
      assert.ok(parsed.received >= 64);
      assert.equal(result.headers['cache-control'], 'no-store');
      assert.equal(result.headers['x-content-type-options'], 'nosniff');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
