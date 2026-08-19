'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-tailwind');
const { extractTailwind, buildTailwindForFiles, renderTailwindBlock, _internal } = engine;
const { classifyUtility, parseVariants } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractTailwind('').total, 0);
  assert.equal(extractTailwind(null).total, 0);
});

test('non-Tailwind text returns empty', () => {
  const r = extractTailwind('Just regular HTML without class attributes');
  assert.equal(r.total, 0);
});

test('classifyUtility: spacing / color / layout', () => {
  assert.equal(classifyUtility('p-4'), 'spacing');
  assert.equal(classifyUtility('mx-2'), 'spacing');
  assert.equal(classifyUtility('bg-blue-500'), 'color');
  assert.equal(classifyUtility('text-red-700'), 'color');
  assert.equal(classifyUtility('flex'), 'layout');
  assert.equal(classifyUtility('grid'), 'layout');
});

test('classifyUtility: sizing / typography / border', () => {
  assert.equal(classifyUtility('w-full'), 'sizing');
  assert.equal(classifyUtility('font-bold'), 'typography');
  assert.equal(classifyUtility('text-xl'), 'typography');
  assert.equal(classifyUtility('rounded-lg'), 'border');
  assert.equal(classifyUtility('border-2'), 'border');
});

test('classifyUtility: transition / transform / effect', () => {
  assert.equal(classifyUtility('transition-colors'), 'transition');
  assert.equal(classifyUtility('rotate-90'), 'transform');
  assert.equal(classifyUtility('shadow-lg'), 'effect');
});

test('parseVariants: hover:bg-red-500', () => {
  const { variants, base } = parseVariants('hover:bg-red-500');
  assert.deepEqual(variants, ['hover']);
  assert.equal(base, 'bg-red-500');
});

test('parseVariants: md:hover:p-4', () => {
  const { variants, base } = parseVariants('md:hover:p-4');
  assert.deepEqual(variants, ['md', 'hover']);
  assert.equal(base, 'p-4');
});

test('detects basic utility classes', () => {
  const r = extractTailwind('<div class="p-4 mx-2 bg-blue-500 text-white flex">');
  assert.ok(r.entries.some((e) => e.name === 'p-4' && e.kind === 'spacing'));
  assert.ok(r.entries.some((e) => e.name === 'bg-blue-500' && e.kind === 'color'));
  assert.ok(r.entries.some((e) => e.name === 'flex' && e.kind === 'layout'));
});

test('detects classes in className= (JSX)', () => {
  const r = extractTailwind('<div className="rounded-lg shadow-md">');
  assert.ok(r.entries.some((e) => e.name === 'rounded-lg'));
  assert.ok(r.entries.some((e) => e.name === 'shadow-md'));
});

test('counts responsive prefixes', () => {
  const r = extractTailwind('<div class="md:p-4 lg:p-6 2xl:p-8">');
  assert.ok(r.totals.responsive >= 3);
});

test('counts variant prefixes (hover/focus/dark)', () => {
  const r = extractTailwind('<div class="hover:bg-red-500 focus:ring-2 dark:bg-gray-900">');
  assert.ok(r.totals.variant >= 3);
});

test('detects classes in clsx()', () => {
  const r = extractTailwind('const c = clsx("p-4", "bg-blue-500", { "text-red-500": isError });');
  assert.ok(r.entries.some((e) => e.name === 'p-4'));
  assert.ok(r.entries.some((e) => e.name === 'bg-blue-500'));
});

test('detects classes in cn() helper', () => {
  const r = extractTailwind('const c = cn("flex items-center", "gap-4");');
  assert.ok(r.entries.some((e) => e.name === 'flex'));
});

test('detects arbitrary values [123px] / [#fff]', () => {
  const r = extractTailwind('<div class="w-[123px] bg-[#ff0000]">');
  assert.ok(r.entries.some((e) => /\[123px\]/.test(e.name)));
});

test('dedupes identical classes', () => {
  const r = extractTailwind('<div class="p-4 p-4 p-4">');
  assert.equal(r.entries.filter((e) => e.name === 'p-4').length, 1);
});

test('caps entries per file', () => {
  let text = '<div class="';
  for (let i = 0; i < 40; i++) text += `p-${i} m-${i} `;
  text += '">';
  const r = extractTailwind(text);
  assert.ok(r.entries.length <= 24);
});

test('counts class groups', () => {
  const r = extractTailwind('<div class="p-4"> <span className="m-2">');
  assert.equal(r.totals.classGroup, 2);
});

test('buildTailwindForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.tsx', extractedText: '<div className="p-4">' },
    { name: 'b.tsx', extractedText: '<div className="flex gap-2">' },
  ];
  const r = buildTailwindForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderTailwindBlock returns markdown when entries exist', () => {
  const files = [{ name: 'Page.tsx', extractedText: '<div class="p-4 bg-blue-500">' }];
  const r = buildTailwindForFiles(files);
  const md = renderTailwindBlock(r);
  assert.match(md, /^## TAILWIND/);
});

test('renderTailwindBlock empty when nothing surfaces', () => {
  assert.equal(renderTailwindBlock({ perFile: [] }), '');
  assert.equal(renderTailwindBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildTailwindForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '<div class="p-4">' },
  ]);
  assert.equal(r.perFile.length, 1);
});
