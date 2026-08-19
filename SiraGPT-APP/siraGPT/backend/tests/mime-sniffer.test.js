'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { sniff, isMatch, SIGNATURES } = require('../src/utils/mime-sniffer');

const PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0]);
const JPEG = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 16]);
const GIF = Buffer.from('GIF89a');
const PDF = Buffer.from('%PDF-1.4\n');
const ZIP = Buffer.from([0x50, 0x4B, 0x03, 0x04, 0, 0, 0, 0]);
const WEBP = Buffer.concat([
  Buffer.from([0x52, 0x49, 0x46, 0x46]),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from([0x57, 0x45, 0x42, 0x50]),
]);
const XML = Buffer.from('<?xml version="1.0"?>');
const JSON_BUF = Buffer.from('   { "x": 1 }');
const ARR_JSON = Buffer.from('[1,2,3]');
const TEXT_BOM = Buffer.from([0xEF, 0xBB, 0xBF, 0x68, 0x69]);

describe('sniff — common formats', () => {
  test('PNG', () => assert.equal(sniff(PNG).mime, 'image/png'));
  test('JPEG', () => assert.equal(sniff(JPEG).mime, 'image/jpeg'));
  test('GIF', () => assert.equal(sniff(GIF).mime, 'image/gif'));
  test('PDF', () => assert.equal(sniff(PDF).mime, 'application/pdf'));
  test('ZIP', () => assert.equal(sniff(ZIP).mime, 'application/zip'));
  test('WEBP', () => assert.equal(sniff(WEBP).mime, 'image/webp'));
  test('XML', () => assert.equal(sniff(XML).mime, 'application/xml'));
});

describe('sniff — fallbacks', () => {
  test('UTF-8 BOM identifies as text/plain', () => {
    assert.equal(sniff(TEXT_BOM).mime, 'text/plain; charset=utf-8');
  });
  test('object JSON heuristic', () => {
    assert.equal(sniff(JSON_BUF).mime, 'application/json');
  });
  test('array JSON heuristic', () => {
    assert.equal(sniff(ARR_JSON).mime, 'application/json');
  });
});

describe('sniff — unknown / edge cases', () => {
  test('empty input → null', () => {
    assert.equal(sniff(Buffer.alloc(0)), null);
  });
  test('random bytes → null', () => {
    assert.equal(sniff(Buffer.from([0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42])), null);
  });
  test('non-buffer non-string → null', () => {
    assert.equal(sniff(42), null);
    assert.equal(sniff(null), null);
  });
  test('Uint8Array works', () => {
    assert.equal(sniff(new Uint8Array(PNG)).mime, 'image/png');
  });
  test('String input is UTF-8 decoded', () => {
    assert.equal(sniff('%PDF-1.4').mime, 'application/pdf');
  });
});

describe('isMatch', () => {
  test('matching mime → true', () => {
    assert.equal(isMatch(PNG, 'image/png'), true);
  });
  test('mismatching mime → false', () => {
    assert.equal(isMatch(PNG, 'image/jpeg'), false);
  });
});

describe('SIGNATURES export', () => {
  test('contains the documented entries', () => {
    const mimes = SIGNATURES.map((s) => s.mime);
    for (const expected of ['image/png', 'image/jpeg', 'application/pdf', 'application/zip']) {
      assert.ok(mimes.includes(expected), `missing ${expected}`);
    }
  });
});
