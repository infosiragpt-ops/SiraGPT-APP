'use strict';

/**
 * /api/memory — management surface for the per-user memory DOCUMENT.
 *
 * The document is auto-populated by the chat pipeline
 * (long-term-memory.extractFactsAsync → memory-document.recordFacts);
 * these routes let the user (and, via GET, any LLM) read, search, edit
 * and clear it.
 *
 *   GET    /api/memory          → { entries, markdown, stats }
 *   GET    /api/memory/search   → { results }            (?q=)
 *   POST   /api/memory          → { entry }              ({ text, category })
 *   PATCH  /api/memory/:id      → { entry }              ({ text?, category? })
 *   DELETE /api/memory/:id      → { ok }
 *   DELETE /api/memory          → { ok }                 (clears document + vector facts)
 */

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const vault = require('../services/memory/vault');
const consolidation = require('../services/memory/consolidation');
const longTermMemory = require('../services/long-term-memory');

const router = express.Router();

router.use(authenticateToken);

function getUserId(req) {
  return req.user?.id || req.userId || null;
}

// Read the full document (entries + rendered markdown + stats).
router.get('/', async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });
  try {
    return res.json(await vault.getDocument(userId));
  } catch (err) {
    return res.status(500).json({ error: 'memory_unavailable', detail: err && err.message });
  }
});

// The always-loaded index exactly as the model sees it (for the settings UI).
router.get('/index', async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });
  const block = await vault.buildIndexBlock(userId, { tools: false });
  return res.json({ block, stats: await vault.stats(userId) });
});

router.get('/topics/:topic', async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });
  return res.json(await vault.readTopic(userId, req.params.topic, { limit: 200 }));
});

// grep first; vector rung only when the corpus is large.
router.get('/search', async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ query: q, results: [] });
  const out = await vault.search(userId, q, { limit: 20 });
  return res.json({ query: q, mode: out.mode, results: out.results });
});

router.post('/', async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });
  const { text, category, topic } = req.body || {};
  const r = await vault.write(userId, { text, topic: topic || category, source: 'manual', importance: 0.7, confidence: 1 });
  if (!r.ok) return res.status(400).json({ error: r.error });
  return res.status(201).json({ entry: r.entry, created: r.created });
});

router.patch('/:id', async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });
  const { text, category, topic } = req.body || {};
  const r = await vault.update(userId, req.params.id, { text, topic: topic || category });
  if (!r.ok) return res.status(r.error === 'not_found' ? 404 : 400).json({ error: r.error });
  return res.json({ entry: r.entry });
});

router.delete('/:id', async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });
  const r = await vault.forget(userId, req.params.id);
  if (!r.ok) return res.status(404).json({ error: r.error || 'not_found' });
  return res.json({ ok: true });
});

// Wipe everything — a PRIVACY action: vault + legacy document + vector store.
// Fails closed: partial clears are reported as such, never as success.
router.delete('/', async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });

  let documentCleared = false;
  try {
    // eslint-disable-next-line global-require
    require('../services/memory-document').clear(userId);
    documentCleared = true;
  } catch (err) {
    req.log?.error?.({ err }, 'memory: document clear failed');
    return res.status(500).json({ error: 'memory_clear_failed', documentCleared: false, vectorCleared: false });
  }

  try {
    // clearUserMemory wipes the vault (Postgres) + vector store together.
    await longTermMemory.clearUserMemory(userId);
  } catch (vecErr) {
    req.log?.error?.({ err: vecErr }, 'memory: vector clear failed (document cleared)');
    return res.status(500).json({ error: 'memory_vector_clear_failed', partial: true, documentCleared, vectorCleared: false });
  }

  return res.json({ ok: true, documentCleared, vectorCleared: true });
});

// ── consolidation ("dreaming") — reviewable and reversible ────────────────
router.get('/consolidation', async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });
  return res.json({ enabled: consolidation.isEnabled(), reports: await consolidation.listReports(userId) });
});

router.post('/consolidation/run', async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });
  const r = await consolidation.consolidateUser(userId, { force: true });
  if (!r.ok) return res.status(503).json({ error: r.error || r.skipped || 'consolidation_failed' });
  return res.json({ ok: true, skipped: r.skipped || null, report: r.report || null });
});

router.post('/consolidation/:id/revert', async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });
  const r = await consolidation.revert(userId, req.params.id);
  if (!r.ok) return res.status(r.error === 'not_found' ? 404 : 409).json({ error: r.error });
  return res.json({ ok: true, restored: r.restored, report: r.report });
});

module.exports = router;
