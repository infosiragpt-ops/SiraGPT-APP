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
const memoryDocument = require('../services/memory-document');
const longTermMemory = require('../services/long-term-memory');

const router = express.Router();

router.use(authenticateToken);

function getUserId(req) {
  return req.user?.id || req.userId || null;
}

// Read the full document (entries + rendered markdown + stats).
router.get('/', (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });
  try {
    return res.json(memoryDocument.getDocument(userId));
  } catch (err) {
    req.log?.error?.({ err }, 'memory: read failed');
    return res.status(500).json({ error: 'memory_read_failed' });
  }
});

// Keyword search over the document.
router.get('/search', (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });
  const q = String(req.query.q || '').trim();
  try {
    return res.json({ query: q, results: memoryDocument.search(userId, q) });
  } catch (err) {
    req.log?.error?.({ err }, 'memory: search failed');
    return res.status(500).json({ error: 'memory_search_failed' });
  }
});

// Add a manual memory entry.
router.post('/', (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });
  const { text, category } = req.body || {};
  if (!text || typeof text !== 'string' || text.trim().length < 2) {
    return res.status(400).json({ error: 'text_required' });
  }
  try {
    const entry = memoryDocument.addEntry(userId, { text, category });
    return res.status(201).json({ entry });
  } catch (err) {
    req.log?.error?.({ err }, 'memory: add failed');
    return res.status(400).json({ error: err.message || 'memory_add_failed' });
  }
});

// Edit an existing entry.
router.patch('/:id', (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });
  const { text, category } = req.body || {};
  try {
    const entry = memoryDocument.updateEntry(userId, req.params.id, { text, category });
    if (!entry) return res.status(404).json({ error: 'not_found' });
    return res.json({ entry });
  } catch (err) {
    req.log?.error?.({ err }, 'memory: update failed');
    return res.status(400).json({ error: err.message || 'memory_update_failed' });
  }
});

// Delete one entry.
router.delete('/:id', (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });
  try {
    const ok = memoryDocument.deleteEntry(userId, req.params.id);
    if (!ok) return res.status(404).json({ error: 'not_found' });
    return res.json({ ok: true });
  } catch (err) {
    req.log?.error?.({ err }, 'memory: delete failed');
    return res.status(500).json({ error: 'memory_delete_failed' });
  }
});

// Clear the entire document AND the user's learned vector facts so the
// "forget me" action is honoured across both stores. This is a privacy
// action: if EITHER store fails to clear we must NOT report full success,
// otherwise the user is told they were forgotten while learned facts
// remain recallable. On partial failure we surface a non-2xx + a body
// describing exactly which store was cleared.
router.delete('/', async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });

  let documentCleared = false;
  try {
    memoryDocument.clear(userId);
    documentCleared = true;
  } catch (err) {
    req.log?.error?.({ err }, 'memory: document clear failed');
    return res.status(500).json({
      error: 'memory_clear_failed',
      documentCleared: false,
      vectorCleared: false,
    });
  }

  try {
    await longTermMemory.clearUserMemory(userId);
  } catch (vecErr) {
    req.log?.error?.({ err: vecErr }, 'memory: vector clear failed (document cleared)');
    return res.status(500).json({
      error: 'memory_vector_clear_failed',
      partial: true,
      documentCleared,
      vectorCleared: false,
    });
  }

  return res.json({ ok: true, documentCleared, vectorCleared: true });
});

module.exports = router;
