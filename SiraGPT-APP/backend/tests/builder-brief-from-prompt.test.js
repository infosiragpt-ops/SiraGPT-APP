'use strict';

/**
 * Tests for builder/brief-from-prompt — the LLM-free one-shot path that turns a
 * single free-text description into a validated ProjectBrief, plus the
 * /api/builder/generate route that scaffolds runnable files from it.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const { mockResolvedModule } = require('./http-test-utils');
const { ProjectBriefSchema } = require('../src/services/builder/contracts');
const {
  briefFromPrompt,
  extractEntities,
  extractExactDisplayText,
  extractFeatures,
  extractTheme,
  normalisePurposeText,
  singularize,
} = require('../src/services/builder/brief-from-prompt');
const { scaffoldFromBrief } = require('../src/services/builder/scaffold');

test('briefFromPrompt produces a valid ProjectBrief', () => {
  const brief = briefFromPrompt('Sistema de barbería con clientes y turnos');
  assert.equal(ProjectBriefSchema.safeParse(brief).success, true);
});

test('extractEntities pulls and singularises a "con X y Y" list', () => {
  const ents = extractEntities('Sistema de barbería con clientes y turnos');
  const names = ents.map((e) => e.name);
  assert.deepEqual(names, ['Cliente', 'Turno']);
});

test('extracted entities get sensible default fields (real form inputs)', () => {
  const brief = briefFromPrompt('App con productos y pedidos');
  const producto = brief.dataEntities.find((e) => e.name === 'Producto');
  const pedido = brief.dataEntities.find((e) => e.name === 'Pedido');
  assert.ok(producto.fields.includes('precio'));
  assert.ok(pedido.fields.includes('total'));
});

test('entity extraction stops before color/style instructions', () => {
  const brief = briefFromPrompt('Software para bodas con clientes, eventos, invitados y pagos color #FF0000');
  const names = brief.dataEntities.map((e) => e.name);
  assert.deepEqual(names, ['Cliente', 'Evento', 'Invitado', 'Pago']);
  assert.equal(brief.style.theme, 'moderno #FF0000');
});

test('entity extraction ignores stack words and reads operation lists', () => {
  const brief = briefFromPrompt(
    'Crea una app full-stack profesional llamada Agentic Compile V2 para operaciones: dashboard, clientes, tickets, formulario para crear cliente, backend API con rutas Next, Prisma/Postgres y README',
  );
  const names = brief.dataEntities.map((e) => e.name);
  assert.deepEqual(names, ['Cliente', 'Ticket']);
  assert.ok(!names.includes('Prisma'));
  assert.ok(!names.includes('Postgre'));
  assert.ok(!names.includes('Readme'));
  assert.ok(!names.includes('Next'));
});

test('exact display text instructions are preserved as constraints', () => {
  const prompt = 'La pantalla principal debe mostrar el texto exacto AGENTIC_COMPILE_V3_READY cuando compile.';
  const brief = briefFromPrompt(prompt);
  assert.equal(extractExactDisplayText(prompt), 'AGENTIC_COMPILE_V3_READY');
  assert.equal(brief.constraints, 'Texto exacto en pantalla principal: AGENTIC_COMPILE_V3_READY');
});

test('no extractable entities → a generic Registro entity (never an empty app)', () => {
  const brief = briefFromPrompt('Quiero una app para mi negocio');
  assert.equal(brief.dataEntities.length, 1);
  assert.equal(brief.dataEntities[0].name, 'Registro');
  assert.ok(brief.dataEntities[0].fields.length > 0);
});

test('platform is inferred, defaulting to web', () => {
  assert.equal(briefFromPrompt('Una app de escritorio con tareas').platform, 'desktop');
  assert.equal(briefFromPrompt('Landing one-page para mi marca').platform, 'landing');
  assert.equal(briefFromPrompt('Gestor de inventario con productos').platform, 'web');
  assert.equal(briefFromPrompt('Quiero una app para mi negocio').platform, 'web');
});

test('landing prompts strip builder intent from purpose and audience', () => {
  const prompt = 'Landing one-page para quiero que construyas una web de venta de autos';
  const brief = briefFromPrompt(prompt);
  assert.equal(brief.platform, 'landing');
  assert.equal(brief.purpose, 'Venta de autos');
  assert.equal(brief.audience, '');
  assert.deepEqual(brief.coreFeatures, ['Inventario destacado', 'Cotización rápida', 'Financiamiento y contacto']);
  assert.equal(brief.style.theme, 'moderno #FF0000');
  assert.equal(normalisePurposeText(prompt), 'Venta de autos');
});

test('landing scaffold renders a real automotive sales page, not the raw prompt', () => {
  const brief = briefFromPrompt('Landing one-page para quiero que construyas una web de venta de autos');
  const { files } = scaffoldFromBrief(brief);
  const index = files.find((f) => f.path === 'index.html');
  assert.ok(index, 'index.html must be present');
  assert.match(index.content, /AutoPrime/);
  assert.match(index.content, /Solicitar cotización/);
  assert.match(index.content, /Inventario/);
  assert.doesNotMatch(index.content, /quiero que construyas/i);
  assert.doesNotMatch(index.content, /Landing one-page para quiero/i);
});

test('theme is derived from style cues', () => {
  assert.equal(extractTheme('un dashboard oscuro y editorial'), 'oscuro');
  assert.equal(extractTheme('algo minimalista'), 'minimalista');
  assert.equal(extractTheme('sin pistas de estilo'), 'moderno');
  assert.equal(extractTheme('landing minimalista color #FF0000'), 'minimalista #FF0000');
});

test('features map auth/payments keywords', () => {
  const feats = extractFeatures('app con login y pagos');
  assert.ok(feats.includes('Autenticación de usuarios'));
  assert.ok(feats.includes('Pagos'));
});

test('singularize drops a trailing s but leaves short/ss words', () => {
  assert.equal(singularize('clientes'), 'cliente');
  assert.equal(singularize('turnos'), 'turno');
  assert.equal(singularize('mes'), 'mes'); // len <= 3 untouched
});

test('briefFromPrompt rejects an empty prompt', () => {
  assert.throws(() => briefFromPrompt('   '), /empty/);
});

test('briefFromPrompt is deterministic (same prompt → identical brief)', () => {
  const a = briefFromPrompt('Sistema de barbería con clientes y turnos');
  const b = briefFromPrompt('Sistema de barbería con clientes y turnos');
  assert.deepEqual(a, b);
});

// ---- route: POST /api/builder/generate -----------------------------------

const authPath = require.resolve('../src/middleware/auth');
const restoreAuth = mockResolvedModule(authPath, {
  authenticateToken(req, _res, next) {
    req.user = { id: 'u-1' };
    next();
  },
});
const builderRoutes = require('../src/routes/builder');
after(() => restoreAuth());

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/builder', builderRoutes);
  return app;
}

test('POST /generate returns brief + blueprint + runnable files', async () => {
  const res = await request(buildApp())
    .post('/api/builder/generate')
    .send({ prompt: 'Sistema de barbería con clientes y turnos' });
  assert.equal(res.status, 200);
  assert.equal(ProjectBriefSchema.safeParse(res.body.brief).success, true);
  assert.ok(res.body.blueprint);
  const index = res.body.files.find((f) => f.path === 'index.html');
  assert.ok(index, 'index.html must be present');
  assert.match(index.content, /<!doctype html>/i);
  const paths = res.body.files.map((f) => f.path);
  assert.ok(paths.includes('package.json'), 'full-stack project must include package.json');
  assert.ok(paths.includes('prisma/schema.prisma'), 'data apps must include Prisma schema');
  assert.ok(paths.includes('docker-compose.yml'), 'data apps must include local Postgres compose file');
  assert.ok(paths.includes('.env.example'), 'data apps must include env template');
  assert.ok(paths.includes('app/api/cliente/route.ts'), 'Cliente API route must be generated');
  assert.ok(paths.includes('app/cliente/page.tsx'), 'Cliente CRUD page must be generated');
});

test('POST /generate rejects an empty prompt with 400', async () => {
  const res = await request(buildApp()).post('/api/builder/generate').send({ prompt: '' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'validation_failed');
});
