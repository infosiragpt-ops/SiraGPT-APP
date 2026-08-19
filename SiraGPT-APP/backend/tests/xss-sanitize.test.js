'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const xssSanitizeMiddleware = require('../src/middleware/xss-sanitize');
const { sanitizeValue } = require('../src/middleware/xss-sanitize');

function makeReq(overrides = {}) {
  return {
    method: 'POST',
    query: {},
    params: {},
    body: {},
    ...overrides,
  };
}

describe('xss-sanitize middleware', () => {
  test('sanitizes body, query and route params', () => {
    const req = makeReq({
      query: { q: '<script>evil()</script>safe' },
      params: { id: '<|im_start|>abc' },
      body: {
        html: '<img src=x onerror="evil()">ok',
        link: '<a href="javascript:evil()">x</a>',
      },
    });
    let called = false;

    xssSanitizeMiddleware(req, {}, () => { called = true; });

    assert.equal(called, true);
    assert.equal(req.query.q, 'safe');
    assert.equal(req.params.id, 'abc');
    assert.equal(req.body.html, '<img src=x>ok');
    assert.equal(req.body.link, '<a >x</a>');
  });

  test('skips body sanitization for safe methods but still sanitizes query and params', () => {
    const req = makeReq({
      method: 'GET',
      query: { q: '<script>evil()</script>safe' },
      params: { id: '</prompt>abc' },
      body: { html: '<script>kept()</script>body' },
    });

    xssSanitizeMiddleware(req, {}, () => {});

    assert.equal(req.query.q, 'safe');
    assert.equal(req.params.id, 'abc');
    assert.equal(req.body.html, '<script>kept()</script>body');
  });

  test('leaves Buffer bodies untouched', () => {
    const buf = Buffer.from('<script>raw</script>');
    const req = makeReq({ body: buf });

    xssSanitizeMiddleware(req, {}, () => {});

    assert.equal(req.body, buf);
  });

  test('keeps code runner file payloads untouched', () => {
    const req = makeReq({
      originalUrl: '/api/code-runner/start',
      body: {
        files: [
          { path: 'index.html', content: '<div id="root"></div><script type="module" src="/src/main.jsx"></script>' },
        ],
      },
    });

    xssSanitizeMiddleware(req, {}, () => {});

    assert.equal(req.body.files[0].content, '<div id="root"></div><script type="module" src="/src/main.jsx"></script>');
  });
});

describe('sanitizeValue', () => {
  test('handles circular objects and arrays without stack overflow', () => {
    const obj = { html: '<script>evil()</script>safe' };
    obj.self = obj;
    const arr = ['<iframe src=x></iframe>ok'];
    arr.push(arr);
    obj.arr = arr;

    const out = sanitizeValue(obj);

    assert.equal(out.html, 'safe');
    assert.equal(out.self, '[circular]');
    assert.equal(out.arr[0], '<iframe src=x></iframe>ok');
    assert.equal(out.arr[1], '[circular]');
  });

  test('honors maxDepth option', () => {
    const out = sanitizeValue(
      {
        shallow: '<script>strip()</script>ok',
        nested: { tooDeep: '<script>kept()</script>value' },
      },
      { maxDepth: 1 },
    );

    assert.equal(out.shallow, 'ok');
    assert.equal(out.nested.tooDeep, '<script>kept()</script>value');
  });
});
