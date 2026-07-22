'use strict';

const express = require('express');
const {
  listImprovements,
  getImprovement,
  summarizeImprovements,
  qualityProfileForPipeline,
  recommendImprovements,
} = require('../services/platform-improvements');

const router = express.Router();

router.get('/', (req, res) => {
  const { category, phase, surface, limit } = req.query || {};
  return res.json({
    summary: summarizeImprovements(),
    improvements: listImprovements({ category, phase, surface, limit }),
  });
});

router.get('/summary', (_req, res) => {
  return res.json(summarizeImprovements());
});

router.get('/pipeline/:pipelineId', (req, res) => {
  const { pipelineId } = req.params;
  return res.json({
    ...qualityProfileForPipeline(pipelineId),
    recommendedImprovements: recommendImprovements({
      pipelineId,
      phase: req.query.phase,
      limit: req.query.limit || 10,
    }),
  });
});

router.get('/:id', (req, res) => {
  const improvement = getImprovement(req.params.id);
  if (!improvement) return res.status(404).json({ error: 'improvement_not_found' });
  return res.json(improvement);
});

module.exports = router;
