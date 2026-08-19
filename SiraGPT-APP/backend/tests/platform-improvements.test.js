'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const router = require('../src/routes/platform-improvements');
const {
  CATEGORIES,
  IMPROVEMENTS,
  summarizeImprovements,
  listImprovements,
  qualityProfileForPipeline,
  recommendImprovements,
} = require('../src/services/platform-improvements');
const { listPipelines } = require('../src/services/agents/pipeline-registry');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/platform-improvements', router);
  return app;
}

test('platform improvements catalog contains exactly 100 scoped improvements', () => {
  assert.equal(IMPROVEMENTS.length, 100);
  const ids = new Set();
  for (const improvement of IMPROVEMENTS) {
    assert.match(improvement.id, /^[a-z]+-\d{3}$/);
    assert.ok(CATEGORIES.includes(improvement.category), improvement.category);
    assert.ok(['p0', 'p1', 'p2', 'p3'].includes(improvement.phase), improvement.phase);
    assert.ok(['critical', 'high', 'medium'].includes(improvement.impact), improvement.impact);
    assert.ok(['s', 'm', 'l'].includes(improvement.effort), improvement.effort);
    assert.ok(Array.isArray(improvement.surfaces) && improvement.surfaces.length > 0);
    assert.ok(typeof improvement.acceptance === 'string' && improvement.acceptance.length > 10);
    assert.equal(ids.has(improvement.id), false, `duplicate ${improvement.id}`);
    ids.add(improvement.id);
  }
});

test('summary reports ten categories with ten improvements each', () => {
  const summary = summarizeImprovements();
  assert.equal(summary.total, 100);
  assert.equal(summary.categories.length, 10);
  for (const category of summary.categories) {
    assert.equal(summary.byCategory[category], 10, category);
  }
});

test('filters return the requested category and phase only', () => {
  const out = listImprovements({ category: 'scientific_search', phase: 'p1' });
  assert.equal(out.length, 10);
  assert.ok(out.every((x) => x.category === 'scientific_search'));
  assert.ok(out.every((x) => x.phase === 'p1'));
});

test('research pipeline quality profile prioritizes scientific search quality', () => {
  const profile = qualityProfileForPipeline('research-grounding');
  assert.ok(profile.categories.includes('scientific_search'));
  assert.ok(profile.checks.includes('doi_validation'));
  assert.ok(profile.checks.includes('nonexistent_reference_detection'));

  const recommended = recommendImprovements({ pipelineId: 'research-grounding', limit: 5 });
  assert.ok(recommended.some((x) => x.id === 'sci-011'));
});

test('presentation pipeline exposes PPT-specific checks and recommendations', () => {
  const profile = qualityProfileForPipeline('presentation');
  assert.ok(profile.categories.includes('presentations'));
  assert.ok(profile.checks.includes('prompt_fidelity'));
  assert.ok(profile.checks.includes('exact_slide_count'));

  const pipelines = listPipelines();
  const presentation = pipelines.find((p) => p.id === 'presentation');
  assert.ok(presentation.qualityProfile.checks.includes('editable_pptx'));
  assert.ok(presentation.recommendedImprovements.some((x) => x.id.startsWith('ppt-')));
});

test('GET /api/platform-improvements returns summary and filterable list', async () => {
  const res = await request(makeApp())
    .get('/api/platform-improvements?category=voice_audio&limit=3');
  assert.equal(res.status, 200);
  assert.equal(res.body.summary.total, 100);
  assert.equal(res.body.improvements.length, 3);
  assert.ok(res.body.improvements.every((x) => x.category === 'voice_audio'));
});

test('GET /api/platform-improvements/pipeline/:id returns profile and recommendations', async () => {
  const res = await request(makeApp())
    .get('/api/platform-improvements/pipeline/research-grounding?limit=4');
  assert.equal(res.status, 200);
  assert.equal(res.body.pipelineId, 'research-grounding');
  assert.ok(res.body.checks.includes('source_quality'));
  assert.equal(res.body.recommendedImprovements.length, 4);
});

test('GET /api/platform-improvements/:id returns one improvement or 404', async () => {
  const ok = await request(makeApp()).get('/api/platform-improvements/sci-020');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.title, 'Nonexistent article detection');

  const missing = await request(makeApp()).get('/api/platform-improvements/nope-999');
  assert.equal(missing.status, 404);
});
