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
  extractFeatures,
  extractTheme,
  singularize,
} = require('../src/services/builder/brief-from-prompt');

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
});

test('POST /generate rejects an empty prompt with 400', async () => {
  const res = await request(buildApp()).post('/api/builder/generate').send({ prompt: '' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'validation_failed');
});
