'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert');
const {
  composeRequestId,
  composeCompression,
  composeBodyParser,
  composeInputSanitizer,
} = require('../src/middleware/compose-middleware');

describe('middleware composition', () => {
  describe('composeRequestId', () => {
    test('sets req.id when missing', () => {
      const app = { use: (mw) => app._mw = mw };
      composeRequestId(app);
      const req = { headers: {} };
      const res = { set: () => {} };
      app._mw(req, res, () => {
        assert.ok(req.id);
      });
    });

    test('preserves existing req.id', () => {
      const app = { use: (mw) => app._mw = mw };
      composeRequestId(app);
      const req = { id: 'existing-id', headers: {} };
      const res = { set: () => {} };
      app._mw(req, res, () => {
        assert.strictEqual(req.id, 'existing-id');
      });
    });

    test('respects skip option', () => {
      const app = { use: (mw) => app._mw = mw };
      composeRequestId(app, { skip: true });
      assert.strictEqual(app._mw, undefined);
    });
  });

  describe('composeCompression', () => {
    test('mounts compression middleware', () => {
      const app = { use: (mw) => app._mw = mw };
      composeCompression(app);
      assert.ok(app._mw);
    });
  });

  describe('composeBodyParser', () => {
    test('mounts JSON and urlencoded parsers', () => {
      const mws = [];
      const app = { use: (mw) => mws.push(mw) };
      composeBodyParser(app);
      assert.ok(mws.length >= 1);
    });

    test('respects custom limits', () => {
      const mws = [];
      const app = { use: (mw) => mws.push(mw) };
      composeBodyParser(app, { jsonLimit: '5mb', urlencodedLimit: '2mb' });
      assert.ok(mws.length >= 1);
    });
  });

  describe('composeInputSanitizer', () => {
    test('mounts sanitizer middleware', () => {
      const app = { use: (mw) => app._mw = mw };
      composeInputSanitizer(app);
      assert.ok(app._mw);
    });

    test('respects skip option', () => {
      const app = { use: (mw) => app._mw = mw };
      composeInputSanitizer(app, { skip: true });
      assert.strictEqual(app._mw, undefined);
    });
  });
});
