/**
 * request-logger.test.js — tests for the structured access log middleware.
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { buildRequestLogger } = require('../src/middleware/request-logger');

function mockReq(over = {}) {
  return Object.assign({
    method: 'GET',
    url: '/api/x?y=1',
    originalUrl: '/api/x?y=1',
    headers: { 'user-agent': 'jest/1.0', 'x-forwarded-for': '1.2.3.4' },
    socket: { remoteAddress: '1.2.3.4' },
    ip: '1.2.3.4',
  }, over);
}

function mockRes() {
  const ee = new EventEmitter();
  ee.statusCode = 200;
  return ee;
}

describe('request-logger middleware', () => {
  test('calls next() synchronously', () => {
    let called = false;
    const mw = buildRequestLogger({ logger: () => {} });
    mw(mockReq(), mockRes(), () => { called = true; });
    assert.equal(called, true);
  });

  test('emits one JSON-shaped payload on response finish', () => {
    const captured = [];
    const mw = buildRequestLogger({ logger: (p) => captured.push(p), now: () => 1000 });
    const req = mockReq();
    const res = mockRes();
    mw(req, res, () => {});
    res.emit('finish');
    assert.equal(captured.length, 1);
    const p = captured[0];
    assert.equal(p.level, 'info');
    assert.equal(p.method, 'GET');
    assert.equal(p.path, '/api/x');
    assert.equal(p.status, 200);
    assert.equal(p.ip, '1.2.3.4');
    assert.equal(p.ua, 'jest/1.0');
    assert.ok(typeof p.reqId === 'string' && p.reqId.length > 0);
    assert.ok(typeof p.ts === 'string');
  });

  test('strips query string from path', () => {
    const captured = [];
    const mw = buildRequestLogger({ logger: (p) => captured.push(p) });
    const req = mockReq({ originalUrl: '/api/foo?x=1&y=2' });
    const res = mockRes();
    mw(req, res, () => {});
    res.emit('finish');
    assert.equal(captured[0].path, '/api/foo');
  });

  test('reuses an existing req.id instead of regenerating', () => {
    const captured = [];
    const mw = buildRequestLogger({ logger: (p) => captured.push(p) });
    const req = mockReq();
    req.id = 'preset-id-123';
    const res = mockRes();
    mw(req, res, () => {});
    res.emit('finish');
    assert.equal(captured[0].reqId, 'preset-id-123');
  });

  test('generates a UUID-shaped req.id when none is set', () => {
    const captured = [];
    const mw = buildRequestLogger({ logger: (p) => captured.push(p) });
    const req = mockReq();
    const res = mockRes();
    mw(req, res, () => {});
    res.emit('finish');
    const id = captured[0].reqId;
    assert.ok(id.length >= 16, `reqId looks too short: ${id}`);
  });

  test('records userId from req.user when authenticated', () => {
    const captured = [];
    const mw = buildRequestLogger({ logger: (p) => captured.push(p) });
    const req = mockReq();
    req.user = { id: 'user-42' };
    const res = mockRes();
    mw(req, res, () => {});
    res.emit('finish');
    assert.equal(captured[0].userId, 'user-42');
  });

  test('userId is null when unauthenticated', () => {
    const captured = [];
    const mw = buildRequestLogger({ logger: (p) => captured.push(p) });
    mw(mockReq(), Object.assign(mockRes(), {}), () => {});
    const res = mockRes();
    mw(mockReq(), res, () => {});
    res.emit('finish');
    assert.equal(captured[captured.length - 1].userId, null);
  });

  test('only emits once even if both finish and close fire', () => {
    const captured = [];
    const mw = buildRequestLogger({ logger: (p) => captured.push(p) });
    const res = mockRes();
    mw(mockReq(), res, () => {});
    res.emit('finish');
    res.emit('close');
    assert.equal(captured.length, 1);
  });

  test('records 5xx status correctly', () => {
    const captured = [];
    const mw = buildRequestLogger({ logger: (p) => captured.push(p) });
    const res = mockRes();
    res.statusCode = 503;
    mw(mockReq(), res, () => {});
    res.emit('finish');
    assert.equal(captured[0].status, 503);
  });

  test('durMs is computed from now() delta', () => {
    const captured = [];
    let t = 1000;
    const mw = buildRequestLogger({ logger: (p) => captured.push(p), now: () => t });
    const res = mockRes();
    mw(mockReq(), res, () => {});
    t = 1042;
    res.emit('finish');
    assert.equal(captured[0].durMs, 42);
  });

  test('never throws when logger throws', () => {
    const mw = buildRequestLogger({ logger: () => { throw new Error('boom'); } });
    const res = mockRes();
    assert.doesNotThrow(() => {
      mw(mockReq(), res, () => {});
      res.emit('finish');
    });
  });

  test('default export is a usable middleware', () => {
    const def = require('../src/middleware/request-logger');
    assert.equal(typeof def, 'function');
  });

  test('falls back to socket.remoteAddress when ip is missing', () => {
    const captured = [];
    const mw = buildRequestLogger({ logger: (p) => captured.push(p) });
    const req = mockReq();
    delete req.ip;
    delete req.headers['x-forwarded-for'];
    req.socket = { remoteAddress: '9.9.9.9' };
    const res = mockRes();
    mw(req, res, () => {});
    res.emit('finish');
    assert.equal(captured[0].ip, '9.9.9.9');
  });

  test('handles missing user-agent header gracefully', () => {
    const captured = [];
    const mw = buildRequestLogger({ logger: (p) => captured.push(p) });
    const req = mockReq();
    delete req.headers['user-agent'];
    const res = mockRes();
    mw(req, res, () => {});
    res.emit('finish');
    assert.equal(captured[0].ua, '');
  });
});
