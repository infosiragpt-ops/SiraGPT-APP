'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const sr = require('../src/services/attribution-skill-recommender');

describe('attribution-skill-recommender', () => {
  test('empty prompt → no primary recommendation', () => {
    const r = sr.recommend({ prompt: '' });
    assert.equal(r.primary, null);
  });

  test('PDF request → recommends document_pipeline.generate_pdf', () => {
    const r = sr.recommend({ prompt: 'crea un PDF con los KPIs del trimestre' });
    assert.equal(r.primary?.id, 'document_pipeline.generate_pdf');
  });

  test('Excel request → recommends generate_xlsx', () => {
    const r = sr.recommend({ prompt: 'genera un excel con las ventas mensuales' });
    assert.equal(r.primary?.id, 'document_pipeline.generate_xlsx');
  });

  test('Slides request → recommends generate_pptx', () => {
    const r = sr.recommend({ prompt: 'arma una presentación de slides para el board' });
    assert.equal(r.primary?.id, 'document_pipeline.generate_pptx');
  });

  test('Code-fix request → recommends agent.task', () => {
    const r = sr.recommend({ prompt: 'arregla el bug en backend/src/routes/auth.js' });
    assert.equal(r.primary?.id, 'agent.task');
  });

  test('Mermaid diagram request → recommends visual_media.create_mermaid_diagram', () => {
    const r = sr.recommend({ prompt: 'dibuja un diagrama mermaid del flujo' });
    assert.equal(r.primary?.id, 'visual_media.create_mermaid_diagram');
  });

  test('Email request → recommends gmail.compose', () => {
    const r = sr.recommend({ prompt: 'redacta un correo y envíalo por gmail al cliente Acme con el resumen' });
    assert.equal(r.primary?.id, 'gmail.compose');
  });

  test('Scientific search request → recommends scientific_search', () => {
    const r = sr.recommend({ prompt: 'busca en pubmed los últimos papers sobre attention mechanisms' });
    assert.equal(r.primary?.id, 'scientific_search');
  });

  test('buildRecommendationBlock returns content', () => {
    const r = sr.recommend({ prompt: 'crea un PDF con los KPIs' });
    const block = sr.buildRecommendationBlock(r);
    assert.match(block, /SUGGESTED SKILL/);
  });

  test('additionalSkills extend the catalogue at runtime', () => {
    const r = sr.recommend({
      prompt: 'analiza este podcast en spotify',
      additionalSkills: [{
        id: 'spotify.analyze',
        triggers: { cues: [/\bspotify\b/i, /\bpodcast\b/i] },
        rationale: 'Custom Spotify analysis skill.',
      }],
    });
    assert.equal(r.primary?.id, 'spotify.analyze');
  });
});
