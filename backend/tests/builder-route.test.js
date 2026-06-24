'use strict';

/**
 * Tests for /api/builder/intake/* — the Builder E1 intake endpoints.
 *
 * We mount the builder router on a tiny Express app and stub the auth
 * middleware (via the require cache) so authenticateToken always passes.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const { mockResolvedModule } = require('./http-test-utils');
const { ProjectBriefSchema, QuestionCardSchema, COVERAGE_DIMENSIONS } = require('../src/services/builder/contracts');

// Stub auth BEFORE the builder router loads it.
const authPath = require.resolve('../src/middleware/auth');
const authStub = {
  authenticateToken(req, _res, next) {
    req.user = { id: 'u-1' };
    next();
  },
};
const restoreAuth = mockResolvedModule(authPath, authStub);

const builderRoutes = require('../src/routes/builder');
const { hydrateSession } = builderRoutes;

after(() => restoreAuth());

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/builder', builderRoutes);
  return app;
}

test('GET /intake/questions returns one valid card per dimension', async () => {
  const res = await request(buildApp()).get('/api/builder/intake/questions');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.dimensions, COVERAGE_DIMENSIONS);
  assert.equal(res.body.questions.length, COVERAGE_DIMENSIONS.length);
  for (const card of res.body.questions) {
    assert.equal(QuestionCardSchema.safeParse(card).success, true);
  }
});

test('POST /intake/step with empty body returns the first question', async () => {
  const res = await request(buildApp()).post('/api/builder/intake/step').send({});
  assert.equal(res.status, 200);
  assert.equal(res.body.complete, false);
  assert.equal(res.body.coverage.ratio, 0);
  assert.equal(res.body.nextQuestion.dimension, COVERAGE_DIMENSIONS[0]);
});

test('POST /intake/step records an answer and advances coverage', async () => {
  const res = await request(buildApp())
    .post('/api/builder/intake/step')
    .send({ answer: { dimension: 'purpose', value: 'Vender cursos' } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.coverage.covered, ['purpose']);
  assert.equal(res.body.nextQuestion.dimension, 'platform');
});

test('POST /intake/step rejects an unknown dimension', async () => {
  const res = await request(buildApp())
    .post('/api/builder/intake/step')
    .send({ answer: { dimension: 'budget', value: 'x' } });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'validation_failed');
});

test('POST /intake/brief returns 400 with missing dimensions when incomplete', async () => {
  const res = await request(buildApp())
    .post('/api/builder/intake/brief')
    .send({ session: { answers: { purpose: 'algo' } } });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'intake_incomplete');
  assert.ok(res.body.missing.includes('platform'));
});

test('full happy path: step through all dimensions then build the brief', async () => {
  const app = buildApp();
  const steps = [
    { dimension: 'purpose', value: 'Vender cursos online' },
    { dimension: 'platform', value: 'web' },
    { dimension: 'coreFeatures', value: 'pagos, búsqueda' },
    { dimension: 'dataEntities', value: 'Usuario, Curso' },
    { dimension: 'style', value: 'minimalista' },
    { dimension: 'audience', value: 'estudiantes' },
  ];
  let session = {};
  for (const answer of steps) {
    const res = await request(app).post('/api/builder/intake/step').send({ session, answer });
    assert.equal(res.status, 200);
    session = res.body.session;
  }
  // Last step should report completion.
  const done = await request(app).post('/api/builder/intake/step').send({ session });
  assert.equal(done.body.complete, true);
  assert.equal(done.body.nextQuestion, null);

  const briefRes = await request(app)
    .post('/api/builder/intake/brief')
    .send({ session, openQuestions: ['¿idioma?'] });
  assert.equal(briefRes.status, 200);
  assert.equal(ProjectBriefSchema.safeParse(briefRes.body.brief).success, true);
  assert.equal(briefRes.body.brief.platform, 'web');
  assert.deepEqual(briefRes.body.brief.openQuestions, ['¿idioma?']);
});

test('hydrateSession ignores unknown keys and resists prototype pollution', () => {
  const session = hydrateSession({
    answers: { purpose: 'ok', __proto__: { polluted: true }, notADimension: 'x' },
  });
  assert.deepEqual(Object.keys(session.answers), ['purpose']);
  assert.equal({}.polluted, undefined);
});
