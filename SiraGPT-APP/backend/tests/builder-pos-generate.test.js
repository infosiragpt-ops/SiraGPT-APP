'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { briefFromPrompt, presetEntities } = require('../src/services/builder/brief-from-prompt');
const { scaffoldFromBrief } = require('../src/services/builder/scaffold');
const { buildLiveApp, posConfig } = require('../src/services/builder/live-app');

/** Pull the runtime <script> body (the multi-line one, not the data blob). */
function runtimeScript(html) {
  const m = html.match(/<script>\n([\s\S]*?)\n<\/script>/);
  return m ? m[1] : null;
}

test('preset: punto de venta prompt yields a real store data model', () => {
  const ents = presetEntities('crea un sistema de ventas de ropa como punto de venta');
  const names = ents.map((e) => e.name);
  assert.deepEqual(names, ['Producto', 'Venta', 'Cliente']);
  // clothing refine adds size + colour to the product.
  assert.deepEqual(ents[0].fields, ['nombre', 'precio', 'stock', 'talla', 'color']);
});

test('preset: non-clothing store keeps a generic product', () => {
  const ents = presetEntities('una tienda de abarrotes');
  assert.deepEqual(ents[0].fields, ['nombre', 'precio', 'stock', 'categoria']);
});

test('presets fire only as a fallback — explicit "con X y Y" wins', () => {
  // Explicit extraction must take precedence over any domain preset.
  const brief = briefFromPrompt('Sistema de barbería con clientes y turnos');
  assert.deepEqual(brief.dataEntities.map((e) => e.name), ['Cliente', 'Turno']);
});

test('presets never hijack the bare "negocio" → Registro fallback', () => {
  const brief = briefFromPrompt('Quiero una app para mi negocio');
  assert.equal(brief.dataEntities.length, 1);
  assert.equal(brief.dataEntities[0].name, 'Registro');
});

test('preset returns [] when no domain matches', () => {
  assert.deepEqual(presetEntities('una herramienta para tomar notas'), []);
});

test('client scaffold mode emits a self-contained app (no bundler/db files)', () => {
  const brief = briefFromPrompt('crea un sistema de ventas de ropa como punto de venta');
  const { files } = scaffoldFromBrief(brief, { mode: 'client' });
  const paths = files.map((f) => f.path).sort();
  assert.deepEqual(paths, ['README.md', 'index.html', 'preview.html']);
  // The render gate (isNodeBundlerProject) keys off package.json — it must be absent.
  assert.ok(!files.some((f) => /package\.json$/.test(f.path)), 'no package.json');
  assert.ok(!files.some((f) => /schema\.prisma$/.test(f.path)), 'no prisma schema');
  assert.ok(!files.some((f) => f.path === '.env.example'), 'no .env.example');
});

test('default (fullstack) scaffold mode is unchanged — ships the project files', () => {
  const brief = briefFromPrompt('crea un sistema de ventas de ropa como punto de venta');
  const { files } = scaffoldFromBrief(brief);
  assert.ok(files.some((f) => /package\.json$/.test(f.path)), 'fullstack keeps package.json');
  assert.ok(files.some((f) => f.path === 'index.html'), 'fullstack still has the live app');
});

test('posConfig detects a store and maps the right fields', () => {
  const cfg = posConfig([
    { name: 'Producto', fields: [{ name: 'nombre' }, { name: 'precio' }, { name: 'stock' }, { name: 'talla' }] },
    { name: 'Venta', fields: [{ name: 'cliente' }, { name: 'fecha' }, { name: 'total' }] },
    { name: 'Cliente', fields: [{ name: 'nombre' }] },
  ]);
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.productKey, 'Producto');
  assert.equal(cfg.priceField, 'precio');
  assert.equal(cfg.stockField, 'stock');
  assert.equal(cfg.nameField, 'nombre');
  assert.equal(cfg.saleKey, 'Venta');
  assert.equal(cfg.saleTotalField, 'total');
});

test('posConfig stays disabled without a product+price model', () => {
  assert.equal(posConfig([{ name: 'Cliente', fields: [{ name: 'nombre' }] }]).enabled, false);
  // a product entity with no price field can't total a sale.
  assert.equal(
    posConfig([{ name: 'Producto', fields: [{ name: 'nombre' }, { name: 'descripcion' }] }]).enabled,
    false,
  );
});

test('buildLiveApp renders a POS screen for a store brief', () => {
  const brief = briefFromPrompt('crea un sistema de ventas de ropa como punto de venta');
  const html = buildLiveApp(brief);
  assert.match(html, /^<!doctype html>/i);
  assert.ok(html.includes('Punto de venta'), 'POS screen wired into the app');
  assert.ok(html.includes('"enabled":true'), 'POS enabled in the injected data');
  // runtime must remain valid JS.
  const script = runtimeScript(html);
  assert.doesNotThrow(() => new Function(script)); // eslint-disable-line no-new-func
});

test('buildLiveApp leaves POS disabled for a non-store brief', () => {
  const brief = briefFromPrompt('Sistema de barbería con clientes y turnos');
  const html = buildLiveApp(brief);
  assert.ok(html.includes('"enabled":false'), 'POS disabled for non-store model');
  const script = runtimeScript(html);
  assert.doesNotThrow(() => new Function(script)); // eslint-disable-line no-new-func
});
