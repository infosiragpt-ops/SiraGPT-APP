/**
 * Tests for services/ppt-vector-backgrounds.js — PPT slide background
 * style applicators (modern / circles / gradient / geometric).
 *
 * We test by passing a fake `slide` that records every addShape call.
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const {
  addVectorBackground,
  backgroundStyles,
} = require('../src/services/ppt-vector-backgrounds');

const colors = {
  background: 'F0F0F0',
  accent: 'FF6600',
  secondary: '003366',
};

function fakeSlide() {
  const calls = [];
  return {
    calls,
    addShape(shape, opts) {
      calls.push({ shape, opts });
    },
  };
}

// ── module surface ────────────────────────────────────────────────

describe('module surface', () => {
  it('exports exactly { addVectorBackground, backgroundStyles }', () => {
    const mod = require('../src/services/ppt-vector-backgrounds');
    const keys = Object.keys(mod).sort();
    assert.deepEqual(keys, ['addVectorBackground', 'backgroundStyles']);
  });

  it('backgroundStyles has the 4 documented entries', () => {
    const keys = Object.keys(backgroundStyles).sort();
    assert.deepEqual(keys, ['circles', 'geometric', 'gradient', 'modern']);
  });

  it('every backgroundStyles entry is a function', () => {
    for (const fn of Object.values(backgroundStyles)) {
      assert.equal(typeof fn, 'function');
    }
  });
});

// ── addVectorBackground · base fill ───────────────────────────────

describe('addVectorBackground · base fill', () => {
  it('always lays down a 100% rect with the background color first', () => {
    const slide = fakeSlide();
    addVectorBackground(slide, 'modern', colors);
    const first = slide.calls[0];
    assert.equal(first.shape, 'rect');
    assert.equal(first.opts.x, 0);
    assert.equal(first.opts.y, 0);
    assert.equal(first.opts.w, '100%');
    assert.equal(first.opts.h, '100%');
    assert.equal(first.opts.fill.color, 'F0F0F0');
  });

  it('falls back to "modern" when style key is unknown', () => {
    const slide = fakeSlide();
    addVectorBackground(slide, 'no-such-style', colors);
    // modern adds 15 line shapes + 1 base rect = 16 calls.
    assert.equal(slide.calls.length, 16);
    // Lines should follow the base rect.
    for (let i = 1; i < 16; i++) {
      assert.equal(slide.calls[i].shape, 'line');
    }
  });

  it('falls back to "modern" when style is undefined', () => {
    const slide = fakeSlide();
    addVectorBackground(slide, undefined, colors);
    assert.equal(slide.calls.length, 16);
  });
});

// ── modern style ──────────────────────────────────────────────────

describe('backgroundStyles.modern', () => {
  it('adds exactly 15 line shapes', () => {
    const slide = fakeSlide();
    backgroundStyles.modern(slide, colors);
    assert.equal(slide.calls.length, 15);
    for (const c of slide.calls) {
      assert.equal(c.shape, 'line');
    }
  });

  it('lines use the accent color with 95 transparency and width 20', () => {
    const slide = fakeSlide();
    backgroundStyles.modern(slide, colors);
    for (const c of slide.calls) {
      assert.equal(c.opts.line.color, 'FF6600');
      assert.equal(c.opts.line.width, 20);
      assert.equal(c.opts.line.transparency, 95);
    }
  });

  it('lines are progressively offset on x (-2, -1, 0, 1, ..., 12)', () => {
    const slide = fakeSlide();
    backgroundStyles.modern(slide, colors);
    for (let i = 0; i < 15; i++) {
      assert.equal(slide.calls[i].opts.x, -2 + i);
    }
  });
});

// ── circles style ─────────────────────────────────────────────────

describe('backgroundStyles.circles', () => {
  it('adds exactly 4 ellipse shapes', () => {
    const slide = fakeSlide();
    backgroundStyles.circles(slide, colors);
    assert.equal(slide.calls.length, 4);
    for (const c of slide.calls) {
      assert.equal(c.shape, 'ellipse');
    }
  });

  it('circles use accent fill + secondary outline', () => {
    const slide = fakeSlide();
    backgroundStyles.circles(slide, colors);
    for (const c of slide.calls) {
      assert.equal(c.opts.fill.color, 'FF6600');
      assert.equal(c.opts.line.color, '003366');
    }
  });

  it('circle sizes are pinned: [1.5, 1, 1.2, 0.8]', () => {
    const slide = fakeSlide();
    backgroundStyles.circles(slide, colors);
    const sizes = slide.calls.map((c) => c.opts.w);
    assert.deepEqual(sizes, [1.5, 1, 1.2, 0.8]);
  });

  it('w and h are equal per circle (round, not oval)', () => {
    const slide = fakeSlide();
    backgroundStyles.circles(slide, colors);
    for (const c of slide.calls) {
      assert.equal(c.opts.w, c.opts.h);
    }
  });
});

// ── gradient style ────────────────────────────────────────────────

describe('backgroundStyles.gradient', () => {
  it('adds a single full-slide rect with gradient fill', () => {
    const slide = fakeSlide();
    backgroundStyles.gradient(slide, colors);
    assert.equal(slide.calls.length, 1);
    const c = slide.calls[0];
    assert.equal(c.shape, 'rect');
    assert.equal(c.opts.fill.type, 'gradient');
    assert.deepEqual(c.opts.fill.colors, ['F0F0F0', 'FF6600']);
    assert.equal(c.opts.fill.angle, 45);
  });

  it('gradient stops at full opacity → fully transparent (transparency [90, 100])', () => {
    const slide = fakeSlide();
    backgroundStyles.gradient(slide, colors);
    assert.deepEqual(slide.calls[0].opts.fill.transparency, [90, 100]);
  });

  it('gradient rect covers the whole slide (100% × 100%)', () => {
    const slide = fakeSlide();
    backgroundStyles.gradient(slide, colors);
    const c = slide.calls[0];
    assert.equal(c.opts.x, 0);
    assert.equal(c.opts.y, 0);
    assert.equal(c.opts.w, '100%');
    assert.equal(c.opts.h, '100%');
  });
});

// ── geometric style ──────────────────────────────────────────────

describe('backgroundStyles.geometric', () => {
  it('adds exactly 5 triangle shapes', () => {
    const slide = fakeSlide();
    backgroundStyles.geometric(slide, colors);
    assert.equal(slide.calls.length, 5);
    for (const c of slide.calls) {
      assert.equal(c.shape, 'triangle');
    }
  });

  it('triangles use accent color with 95% transparency', () => {
    const slide = fakeSlide();
    backgroundStyles.geometric(slide, colors);
    for (const c of slide.calls) {
      assert.equal(c.opts.fill.color, 'FF6600');
      assert.equal(c.opts.fill.transparency, 95);
    }
  });

  it('triangle positions are within slide bounds (0..10 × 0..5)', () => {
    const slide = fakeSlide();
    backgroundStyles.geometric(slide, colors);
    for (const c of slide.calls) {
      assert.ok(c.opts.x >= 0 && c.opts.x < 10);
      assert.ok(c.opts.y >= 0 && c.opts.y < 5);
    }
  });

  it('triangle sizes are within [0.5, 1.5)', () => {
    const slide = fakeSlide();
    backgroundStyles.geometric(slide, colors);
    for (const c of slide.calls) {
      assert.ok(c.opts.w >= 0.5 && c.opts.w < 1.5);
      assert.ok(c.opts.h >= 0.5 && c.opts.h < 1.5);
    }
  });

  it('triangle rotation is within [0, 360)', () => {
    const slide = fakeSlide();
    backgroundStyles.geometric(slide, colors);
    for (const c of slide.calls) {
      assert.ok(c.opts.rotate >= 0 && c.opts.rotate < 360);
    }
  });
});
