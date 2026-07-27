'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { buildRouteTestApp, installAuthSessionMock, reloadModule } = require('./http-test-utils');

describe('scientific-search /review route', () => {
  let auth;
  let restoreSearch;

  beforeEach(() => {
    auth = installAuthSessionMock();
    // Stub the network search so the route runs the literature-review engine
    // fully offline + deterministically. buildLiteratureReview reads
    // scientificSearch.search at call time, so patching the cached module works.
    const ss = require('../src/services/scientific-search');
    const original = ss.search;
    ss.search = async () => ({
      papers: [{
        source: 'arxiv', doi: '10.1/a',
        title: 'Administrative management and public sector performance',
        authors: [{ name: 'María García' }, { name: 'John Smith' }],
        year: 2021, venue: 'Journal of Public Administration', citations: 40,
        openAccess: true, pdfUrl: 'http://pdf/a',
        abstract: 'We analysed administrative management in 100 institutions. Results show performance increased by 18% (p<0.05) with better management.',
      }],
      errors: [], providers: ['arxiv'],
    });
    restoreSearch = () => { ss.search = original; };
  });

  afterEach(() => {
    restoreSearch();
    auth.restore();
  });

  function app() {
    return buildRouteTestApp('/api/scientific-search', reloadModule('../src/routes/scientific-search'));
  }

  test('requires authentication', async () => {
    const res = await request(app())
      .post('/api/scientific-search/review')
      .send({ query: 'gestión administrativa' });
    assert.equal(res.status, 401);
  });

  test('validates query length (2-500 chars)', async () => {
    const res = await request(app())
      .post('/api/scientific-search/review')
      .set('Authorization', auth.authHeader)
      .send({ query: 'x' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'validation_failed');
  });

  test('returns a full literature review deliverable', async () => {
    const res = await request(app())
      .post('/api/scientific-search/review')
      .set('Authorization', auth.authHeader)
      .send({ query: 'búscame artículos de la gestión administrativa' });

    assert.equal(res.status, 200);
    assert.equal(res.body.query.language, 'es');
    assert.equal(res.body.papers.length, 1);
    assert.ok(res.body.report.includes('Revisión de literatura'));
    assert.equal(res.body.bibliography.apa.length, 1);
    assert.equal(res.body.bibliography.ieee.length, 1);
    assert.equal(res.body.bibliography.mla.length, 1);
    assert.ok(res.body.synthesis.stats.count === 1);
    assert.ok(Array.isArray(res.body.meta.providers));
  });

  test('accepts a structured SPIDER protocol and returns the audit trail', async () => {
    const res = await request(app())
      .post('/api/scientific-search/review')
      .set('Authorization', auth.authHeader)
      .send({
        query: 'revisión sistemática sobre adopción de IA',
        resolveDois: false,
        protocol: {
          framework: 'spider',
          fields: { sample: 'docentes', phenomenon: 'adopción de IA', design: 'entrevistas' },
          inclusionCriteria: ['educación superior'],
        },
      });
    assert.equal(res.status, 200);
    assert.equal(res.body.protocol.framework, 'spider');
    assert.ok(res.body.protocol.searchExpression.includes('"docentes"'));
    assert.ok(Array.isArray(res.body.screeningDecisions));
    assert.equal(res.body.prisma.scope.includes('metadata'), true);
  });

  test('downloads an auditable Markdown protocol with decisions and PRISMA diagram', async () => {
    const res = await request(app())
      .post('/api/scientific-search/review/export')
      .set('Authorization', auth.authHeader)
      .send({
        query: 'revisión sistemática PICO; Población: funcionarios; Intervención: gestión administrativa; Comparación: práctica habitual; Resultado: desempeño',
        resolveDois: false,
      });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/markdown/);
    assert.match(res.headers['content-disposition'], /^attachment; filename=/);
    assert.match(res.text, /## Estrategia de búsqueda/);
    assert.match(res.text, /```mermaid/);
    assert.match(res.text, /## Decisiones de cribado/);
  });

  test('refuses protocol export for a non-systematic request', async () => {
    const res = await request(app())
      .post('/api/scientific-search/review/export')
      .set('Authorization', auth.authHeader)
      .send({ query: 'gestión administrativa', resolveDois: false });
    assert.equal(res.status, 422);
    assert.equal(res.body.error, 'systematic_protocol_required');
  });

  test('assesses full text with risk-of-bias evidence and GRADE effects', async () => {
    const fullText = `${'Randomized controlled trial methods. '.repeat(20)} Allocation concealment was used. Intention-to-treat analysis. Validated outcome scale. The protocol was registered. n=800. RR=0.75, 95% CI 0.65 to 0.86.`;
    const res = await request(app())
      .post('/api/scientific-search/review/assess')
      .set('Authorization', auth.authHeader)
      .send({ studies: [{ paper: { id: 'p1', title: 'Randomized controlled trial', studyType: 'rct' }, fullText }] });
    assert.equal(res.status, 200);
    assert.equal(res.body.meta.scope, 'full_text');
    assert.equal(res.body.studies[0].riskOfBias.basis, 'full_text_domain_assessment');
    assert.equal(res.body.studies[0].effects.estimates[0].measure, 'RR');
    assert.equal(res.body.certainty.level, 'high');
  });
});
