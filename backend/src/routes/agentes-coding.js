'use strict';

/**
 * Agentes de codificación — plano de control mínimo (Fase 1).
 *
 * Contrato de flag (igual que Codex V2): con AGENTES_CODING_V2 apagado,
 * TODAS las rutas responden 404 salvo /health, que siempre es 200 para que
 * el frontend decida si muestra la experiencia IDE. Sin ETag + no-store:
 * un 304 con cuerpo viejo dejaría la UI clavada en el flujo antiguo.
 * Fase 1 solo expone salud + manifiesto de capacidades; sesiones,
 * sandbox, harness y git llegan en las fases 2-4 (docs/oss-catalog.md).
 */

const express = require('express');
const { isAgentesCodingV2Enabled } = require('../services/agentes-coding/flags');

const router = express.Router();

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
}

router.get('/health', (_req, res) => {
  const body = JSON.stringify({ ok: true, enabled: isAgentesCodingV2Enabled(), phase: 1 });
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
  });
  res.end(body);
});

router.use((req, res, next) => {
  if (!isAgentesCodingV2Enabled()) return res.status(404).json({ error: 'not_found' });
  next();
});

// Fase 1: manifiesto estático de capacidades (sin sesiones ni ejecución).
router.get('/capabilities', (_req, res) => {
  noStore(res);
  res.json({
    ok: true,
    enabled: true,
    capabilities: ['sandbox', 'harness', 'editor', 'terminal', 'diff-review', 'preview', 'git', 'deploy'],
    status: 'phase-1-scaffold',
  });
});

module.exports = router;
