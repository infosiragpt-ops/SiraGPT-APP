'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { parseDataUri, buildDataUri, isDataUri } = require('../src/utils/data-uri');

describe('parseDataUri', () => {
  test('text/plain default when mime omitted', () => {
    const r = parseDataUri('data:,Hello%20world');
    assert.equal(r.mime, 'text/plain');
    assert.equal(r.data.toString('utf8'), 'Hello world');
    assert.equal(r.base64, false);
  });

  test('image/png base64', () => {
    const r = parseDataUri('data:image/png;base64,iVBORw0KGgo=');
    assert.equal(r.mime, 'image/png');
    assert.equal(r.base64, true);
    assert.ok(Buffer.isBuffer(r.data));
    assert.equal(r.data.length, 8);
  });

  test('parameters captured', () => {
    const r = parseDataUri('data:text/plain;charset=utf-8,Hi');
    assert.equal(r.parameters.charset, 'utf-8');
    assert.equal(r.data.toString('utf8'), 'Hi');
  });

  test('null on bad input', () => {
    assert.equal(parseDataUri(null), null);
    assert.equal(parseDataUri('not a data uri'), null);
    assert.equal(parseDataUri('data:no-comma'), null);
  });
});

describe('buildDataUri', () => {
  test('Buffer + default mime + base64', () => {
    const r = buildDataUri({ data: Buffer.from('hi') });
    assert.match(r, /^data:application\/octet-stream;base64,/);
  });

  test('mime + base64 round-trip', () => {
    const enc = buildDataUri({ mime: 'image/png', data: Buffer.from([0x89, 0x50, 0x4E, 0x47]) });
    const back = parseDataUri(enc);
    assert.equal(back.mime, 'image/png');
    assert.equal(back.data.length, 4);
    assert.equal(back.data[0], 0x89);
  });

  test('non-base64 mode URL-encodes', () => {
    const enc = buildDataUri({ mime: 'text/plain', data: 'Hello world', base64: false });
    assert.match(enc, /^data:text\/plain,Hello%20world$/);
  });

  test('parameters round-trip', () => {
    const enc = buildDataUri({
      mime: 'text/plain', parameters: { charset: 'utf-8' }, data: 'Hi', base64: false,
    });
    const back = parseDataUri(enc);
    assert.equal(back.parameters.charset, 'utf-8');
    assert.equal(back.data.toString('utf8'), 'Hi');
  });

  test('Uint8Array + string inputs accepted', () => {
    assert.match(buildDataUri({ data: new Uint8Array([1, 2, 3]) }), /^data:/);
    assert.match(buildDataUri({ data: 'plain' }), /^data:/);
  });

  test('rejects unsupported data types', () => {
    assert.throws(() => buildDataUri({ data: 42 }), TypeError);
    assert.throws(() => buildDataUri({ data: null }), TypeError);
  });
});

describe('isDataUri', () => {
  test('positive examples', () => {
    assert.equal(isDataUri('data:,x'), true);
    assert.equal(isDataUri('data:image/png;base64,abc'), true);
  });
  test('negative examples', () => {
    assert.equal(isDataUri('https://x.com/data'), false);
    assert.equal(isDataUri('data:no-comma'), false);
    assert.equal(isDataUri(null), false);
  });
});
