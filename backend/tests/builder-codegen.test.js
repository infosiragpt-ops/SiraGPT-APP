'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  codegenFromBrief,
  pascalCase,
  camelCase,
  kebabCase,
  tsType,
  editableFields,
  jsxText,
} = require('../src/services/builder/codegen');
const { scaffoldFromBrief } = require('../src/services/builder/scaffold');

function makeBrief(overrides = {}) {
  return {
    purpose: 'Gestionar inventario de una ferretería',
    platform: 'web',
    audience: 'dueños de ferreterías',
    coreFeatures: ['Registro de productos', 'Búsqueda', 'Reportes'],
    dataEntities: [
      { name: 'Producto', fields: ['nombre', 'precio', 'stock', 'activo'] },
      { name: 'Proveedor', fields: ['nombre', 'email'] },
    ],
    style: { theme: 'oscuro', refs: [] },
    integrations: [],
    constraints: '',
    openQuestions: [],
    ...overrides,
  };
}

function fileMap(files) {
  return new Map(files.map((f) => [f.path, f]));
}

// ── naming helpers ────────────────────────────────────────────────
test('naming helpers normalise messy names', () => {
  assert.equal(pascalCase('order items'), 'OrderItems');
  assert.equal(camelCase('Order Items'), 'orderItems');
  assert.equal(kebabCase('Order Items'), 'order-items');
  assert.equal(kebabCase('Producto'), 'producto');
  assert.equal(pascalCase(''), 'Model');
  assert.equal(kebabCase('!!!'), 'item');
});

test('tsType maps blueprint field types and editableFields drops id/timestamps', () => {
  assert.equal(tsType('integer'), 'number');
  assert.equal(tsType('decimal'), 'number');
  assert.equal(tsType('boolean'), 'boolean');
  assert.equal(tsType('email'), 'string');
  assert.equal(tsType('unknown'), 'string');
  const fields = [
    { name: 'id', type: 'id' },
    { name: 'nombre', type: 'string' },
    { name: 'createdAt', type: 'datetime' },
  ];
  const editable = editableFields(fields);
  assert.deepEqual(editable.map((f) => f.name), ['nombre']);
});

// ── web codegen ───────────────────────────────────────────────────
test('web codegen emits a runnable Next.js project skeleton', () => {
  const { files, generated } = codegenFromBrief(makeBrief());
  assert.equal(generated, true);
  const map = fileMap(files);
  for (const p of [
    'package.json',
    'tsconfig.json',
    'next.config.mjs',
    'app/globals.css',
    'app/layout.tsx',
    'app/page.tsx',
    'components/site-nav.tsx',
    'lib/store.ts',
  ]) {
    assert.ok(map.has(p), `expected file ${p}`);
  }
});

test('package.json is valid JSON with Next.js deps', () => {
  const { files } = codegenFromBrief(makeBrief());
  const pkg = JSON.parse(fileMap(files).get('package.json').content);
  assert.ok(pkg.dependencies.next, 'has next dependency');
  assert.ok(pkg.dependencies.react, 'has react dependency');
  assert.equal(pkg.scripts.dev, 'next dev');
  assert.ok(pkg.devDependencies.typescript, 'has typescript');
});

test('tsconfig.json is valid JSON with the @/* path alias', () => {
  const { files } = codegenFromBrief(makeBrief());
  const cfg = JSON.parse(fileMap(files).get('tsconfig.json').content);
  assert.deepEqual(cfg.compilerOptions.paths['@/*'], ['./*']);
  assert.equal(cfg.compilerOptions.jsx, 'preserve');
});

test('each entity yields a CRUD API route + a list/create page', () => {
  const { files } = codegenFromBrief(makeBrief());
  const map = fileMap(files);
  for (const slug of ['producto', 'proveedor']) {
    const route = map.get(`app/api/${slug}/route.ts`);
    const page = map.get(`app/${slug}/page.tsx`);
    assert.ok(route, `route for ${slug}`);
    assert.ok(page, `page for ${slug}`);
    assert.match(route.content, /export async function GET/);
    assert.match(route.content, /export async function POST/);
    assert.match(page.content, /"use client";/);
    assert.match(page.content, /export default function/);
  }
});

test('API route coerces numeric/boolean fields to their types', () => {
  const { files } = codegenFromBrief(makeBrief());
  const route = fileMap(files).get('app/api/producto/route.ts').content;
  // precio (decimal) + stock (integer) → Number(...); activo (boolean) → Boolean(...)
  assert.match(route, /precio: Number\(/);
  assert.match(route, /stock: Number\(/);
  assert.match(route, /activo: Boolean\(/);
  // id + createdAt are server-managed → never coerced from the body
  assert.doesNotMatch(route, /\bid: (String|Number|Boolean)\(/);
});

test('generated home page lists the core features', () => {
  const { files } = codegenFromBrief(makeBrief());
  const home = fileMap(files).get('app/page.tsx').content;
  assert.match(home, /Registro de productos/);
  assert.match(home, /Funcionalidades/);
});

// ── landing platform ──────────────────────────────────────────────
test('landing platform generates a single page, no entity CRUD', () => {
  const { files, generated } = codegenFromBrief(makeBrief({ platform: 'landing' }));
  assert.equal(generated, true);
  const map = fileMap(files);
  assert.ok(map.has('app/page.tsx'));
  assert.ok(!map.has('lib/store.ts'), 'no store on a landing page');
  for (const path of map.keys()) {
    assert.ok(!path.startsWith('app/api/'), `landing should not emit API route: ${path}`);
  }
});

// ── out-of-slice platforms ────────────────────────────────────────
test('mobile/desktop are out of slice → no code, generated=false', () => {
  for (const platform of ['mobile', 'desktop']) {
    const { files, generated } = codegenFromBrief(makeBrief({ platform }));
    assert.equal(generated, false, `${platform} should not generate code`);
    assert.equal(files.length, 0);
  }
});

// ── determinism ───────────────────────────────────────────────────
test('codegen is deterministic — same brief → byte-identical files', () => {
  const a = codegenFromBrief(makeBrief());
  const b = codegenFromBrief(makeBrief());
  assert.equal(a.files.length, b.files.length);
  for (let i = 0; i < a.files.length; i++) {
    assert.equal(a.files[i].path, b.files[i].path);
    assert.equal(a.files[i].content, b.files[i].content);
  }
});

// ── escaping / injection safety ───────────────────────────────────
test('jsxText neutralises tag and expression characters', () => {
  const out = jsxText('</script>{evil}<b>');
  assert.doesNotMatch(out, /<\/script>/);
  assert.doesNotMatch(out, /\{evil\}/);
  assert.match(out, /&lt;/);
  assert.match(out, /&#123;/);
});

test('malicious brief text cannot break out of JSX in the home page', () => {
  const { files } = codegenFromBrief(
    makeBrief({ purpose: '</h1><script>alert(1)</script>', coreFeatures: ['{process.env}'] }),
  );
  const home = fileMap(files).get('app/page.tsx').content;
  assert.doesNotMatch(home, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(home, /\{process\.env\}/);
});

// ── scaffold integration ──────────────────────────────────────────
test('scaffoldFromBrief now includes real code alongside the starters', () => {
  const { files } = scaffoldFromBrief(makeBrief());
  const map = fileMap(files);
  // starters still present
  assert.ok(map.has('preview.html'));
  assert.ok(map.has('README.md'));
  // real code now present too
  assert.ok(map.has('package.json'));
  assert.ok(map.has('app/page.tsx'));
  assert.ok(map.has('app/api/producto/route.ts'));
});

test('scaffold keeps starters-only for out-of-slice platforms', () => {
  const { files } = scaffoldFromBrief(makeBrief({ platform: 'desktop' }));
  const map = fileMap(files);
  assert.ok(map.has('preview.html'), 'starters present');
  assert.ok(!map.has('app/page.tsx'), 'no Next.js code for desktop');
});
