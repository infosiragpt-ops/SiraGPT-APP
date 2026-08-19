'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-css-anim');
const { extractCssAnim, buildCssAnimForFiles, renderCssAnimBlock, _internal } = engine;
const { isCssAnimLike } = _internal;

const CSS_FIXTURE = `@keyframes fadeIn {
  from { opacity: 0; }
  to   { opacity: 1; }
}

@keyframes slide {
  0%   { transform: translateX(-100%); }
  100% { transform: translateX(0); }
}

.fade {
  animation-name: fadeIn;
  animation-duration: 0.5s;
  animation-timing-function: ease-in-out;
  animation-iteration-count: infinite;
  animation-fill-mode: forwards;
}

.button {
  animation: slide 2s cubic-bezier(0.4, 0, 0.2, 1) infinite;
  transition: transform 200ms ease-out;
}

.card {
  transition-property: background-color, opacity;
  transition-duration: 300ms;
}

@media (max-width: 768px) {
  .button { font-size: 14px; }
}

@media (prefers-reduced-motion: reduce) {
  .fade { animation: none; }
}

@supports (display: grid) {
  .layout { display: grid; }
}

@container (min-width: 400px) {
  .card { padding: 1rem; }
}
`;

test('empty / non-string tolerated', () => {
  assert.equal(extractCssAnim('').total, 0);
  assert.equal(extractCssAnim(null).total, 0);
});

test('non-CSS text returns empty', () => {
  const r = extractCssAnim('Just regular text without CSS markers');
  assert.equal(r.total, 0);
});

test('isCssAnimLike heuristic', () => {
  assert.ok(isCssAnimLike('@keyframes spin {}'));
  assert.ok(isCssAnimLike('animation-name: x'));
  assert.ok(!isCssAnimLike('plain text'));
});

test('detects @keyframes declarations', () => {
  const r = extractCssAnim(CSS_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'keyframes' && e.name === 'fadeIn'));
  assert.ok(r.entries.some((e) => e.kind === 'keyframes' && e.name === 'slide'));
});

test('detects animation-name', () => {
  const r = extractCssAnim(CSS_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'animation' && e.name === 'fadeIn'));
});

test('detects animation shorthand with duration', () => {
  const r = extractCssAnim(CSS_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'animation' && e.name === 'slide' && /2s/.test(e.detail || '')));
});

test('detects animation-duration / transition-duration', () => {
  const r = extractCssAnim(CSS_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'duration' && e.name === 'animation-duration'));
  assert.ok(r.entries.some((e) => e.kind === 'duration' && e.name === 'transition-duration'));
});

test('detects timing functions (cubic-bezier / ease-out)', () => {
  const r = extractCssAnim(CSS_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'timing' && /cubic-bezier/.test(e.name)));
  assert.ok(r.entries.some((e) => e.kind === 'timing' && /ease-out|ease-in-out/.test(e.name)));
});

test('detects transition-property', () => {
  const r = extractCssAnim(CSS_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'transition' && /property:/.test(e.name)));
});

test('detects @media queries', () => {
  const r = extractCssAnim(CSS_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'media' && /max-width/.test(e.name)));
});

test('detects prefers-reduced-motion', () => {
  const r = extractCssAnim(CSS_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'prefersReduced' && e.name === 'reduce'));
});

test('detects @supports', () => {
  const r = extractCssAnim(CSS_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'supports'));
});

test('detects @container queries', () => {
  const r = extractCssAnim(CSS_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'container'));
});

test('detects animation-iteration-count infinite', () => {
  const r = extractCssAnim(CSS_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'iteration' && e.name === 'infinite'));
});

test('detects animation-fill-mode forwards', () => {
  const r = extractCssAnim(CSS_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'fillMode' && e.name === 'forwards'));
});

test('dedupes identical keyframes', () => {
  const r = extractCssAnim('@keyframes a {} @keyframes a {}');
  assert.equal(r.entries.filter((e) => e.kind === 'keyframes' && e.name === 'a').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += `@keyframes k${i} {} `;
  const r = extractCssAnim(text);
  assert.ok(r.entries.length <= 22);
});

test('counts totals by kind', () => {
  const r = extractCssAnim(CSS_FIXTURE);
  assert.ok(r.totals.keyframes >= 2);
  assert.ok(r.totals.media >= 1);
});

test('buildCssAnimForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.css', extractedText: '@keyframes a {}' },
    { name: 'b.css', extractedText: '@keyframes b {}' },
  ];
  const r = buildCssAnimForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderCssAnimBlock returns markdown when entries exist', () => {
  const files = [{ name: 'anim.css', extractedText: CSS_FIXTURE }];
  const r = buildCssAnimForFiles(files);
  const md = renderCssAnimBlock(r);
  assert.match(md, /^## CSS ANIMATIONS/);
});

test('renderCssAnimBlock empty when nothing surfaces', () => {
  assert.equal(renderCssAnimBlock({ perFile: [] }), '');
  assert.equal(renderCssAnimBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildCssAnimForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: CSS_FIXTURE },
  ]);
  assert.equal(r.perFile.length, 1);
});
