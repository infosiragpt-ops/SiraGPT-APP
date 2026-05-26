'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const c = require('../src/utils/color');

describe('parseHex', () => {
  test('6-char form', () => {
    assert.deepEqual(c.parseHex('#ff8000'), { r: 255, g: 128, b: 0, a: 1 });
  });
  test('3-char shorthand expands', () => {
    assert.deepEqual(c.parseHex('#f00'), { r: 255, g: 0, b: 0, a: 1 });
  });
  test('8-char with alpha', () => {
    const r = c.parseHex('#ff000080');
    assert.equal(r.r, 255);
    assert.ok(Math.abs(r.a - 0.5) < 0.01);
  });
  test('null on bad input', () => {
    assert.equal(c.parseHex('#zzz'), null);
    assert.equal(c.parseHex(null), null);
  });
});

describe('parseRgb / parseHsl / parseColor', () => {
  test('rgb() works', () => {
    assert.deepEqual(c.parseRgb('rgb(10, 20, 30)'), { r: 10, g: 20, b: 30, a: 1 });
  });
  test('rgba() with alpha', () => {
    const r = c.parseRgb('rgba(255,0,0,0.25)');
    assert.equal(r.a, 0.25);
  });
  test('hsl(0, 100%, 50%) → red', () => {
    const r = c.parseHsl('hsl(0, 100%, 50%)');
    assert.equal(r.r, 255);
    assert.equal(r.g, 0);
    assert.equal(r.b, 0);
  });
  test('parseColor auto-detects', () => {
    assert.ok(c.parseColor('#fff'));
    assert.ok(c.parseColor('rgb(0,0,0)'));
    assert.ok(c.parseColor('hsl(120, 100%, 50%)'));
    assert.equal(c.parseColor('garbage'), null);
  });
});

describe('toHex', () => {
  test('round-trip rgb', () => {
    assert.equal(c.toHex({ r: 255, g: 128, b: 0 }), '#ff8000');
  });
  test('alpha < 1 emits 8-char', () => {
    assert.equal(c.toHex({ r: 255, g: 0, b: 0, a: 0.5 }), '#ff000080');
  });
  test('throws on missing channels', () => {
    assert.throws(() => c.toHex({}), TypeError);
  });
});

describe('rgbToHsl / hslToRgb', () => {
  test('round-trip on primaries', () => {
    for (const rgb of [{ r: 255, g: 0, b: 0 }, { r: 0, g: 255, b: 0 }, { r: 0, g: 0, b: 255 }]) {
      const hsl = c.rgbToHsl(rgb);
      const back = c.hslToRgb(hsl);
      assert.equal(back.r, rgb.r);
      assert.equal(back.g, rgb.g);
      assert.equal(back.b, rgb.b);
    }
  });
});

describe('relativeLuminance + contrastRatio', () => {
  test('white luminance ≈ 1, black ≈ 0', () => {
    assert.ok(Math.abs(c.relativeLuminance({ r: 255, g: 255, b: 255 }) - 1) < 0.001);
    assert.equal(c.relativeLuminance({ r: 0, g: 0, b: 0 }), 0);
  });
  test('black-on-white contrast = 21', () => {
    assert.equal(Math.round(c.contrastRatio('#000', '#fff')), 21);
  });
  test('order-independent', () => {
    assert.equal(c.contrastRatio('#fff', '#000'), c.contrastRatio('#000', '#fff'));
  });
  test('throws on unparseable color', () => {
    assert.throws(() => c.contrastRatio('garbage', '#fff'), TypeError);
  });
});

describe('passes (WCAG)', () => {
  test('AA normal needs ≥ 4.5', () => {
    assert.equal(c.passes(4.5), true);
    assert.equal(c.passes(4.49), false);
  });
  test('AAA normal needs ≥ 7.0', () => {
    assert.equal(c.passes(7.0, 'AAA'), true);
    assert.equal(c.passes(6.99, 'AAA'), false);
  });
  test('large text relaxes thresholds', () => {
    assert.equal(c.passes(3.0, 'AA', 'large'), true);
    assert.equal(c.passes(4.5, 'AAA', 'large'), true);
  });
});
