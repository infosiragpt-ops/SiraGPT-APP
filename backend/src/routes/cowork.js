'use strict';

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { optionalAuth } = require('../middleware/optionalAuth');
const autoFileBridge = require('../services/auto-file-bridge');
const deepDocumentAnalyzer = require('../services/deep-document-analyzer');
const activeMemory = require('../services/active-memory');
const sessionManager = require('../services/session-manager');
const skillsRegistry = require('../services/skills-registry');
const coworkEngine = require('../services/cowork-engine');

const router = express.Router();

router.post('/auto-file', authenticateToken, async (req, res) => {
  try {
    const { content, fileName } = req.body;
    if (!content || typeof content !== 'string') {
      return res.status(400).json({ error: 'content is required' });
    }
    const userId = req.user.id;
    const result = await autoFileBridge.ingestPastedContent(userId, content, { fileName });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/auto-file/batch', authenticateToken, async (req, res) => {
  try {
    const { files } = req.body;
    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: 'files array is required' });
    }
    const userId = req.user.id;
    const results = await autoFileBridge.ingestDroppedFiles(userId, files);
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/auto-files', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const files = await autoFileBridge.getAutoFilesForChat(userId, {}, req.query);
    res.json({ files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/analyze-deep', authenticateToken, async (req, res) => {
  try {
    const { text, fileName, mimeType } = req.body;
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'text is required' });
    }
    const userId = req.user.id;
    const result = await deepDocumentAnalyzer.analyzeDeep(text, {
      userId,
      fileName: fileName || '',
      mimeType: mimeType || '',
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/analyze-deep/file/:fileId', authenticateToken, async (req, res) => {
  try {
    const { fileId } = req.params;
    const prisma = require('../config/database');
    const file = await prisma.file.findFirst({
      where: { id: fileId, userId: req.user.id },
    });
    if (!file) return res.status(404).json({ error: 'file not found' });
    if (!file.extractedText) return res.status(400).json({ error: 'file has no extracted text' });

    const result = await deepDocumentAnalyzer.analyzeDeep(file.extractedText, {
      userId: req.user.id,
      fileName: file.originalName,
      mimeType: file.mimeType,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/memory', authenticateToken, async (req, res) => {
  try {
    const { fact, category, tags, confidence, source } = req.body;
    if (!fact || typeof fact !== 'string') {
      return res.status(400).json({ error: 'fact is required' });
    }
    const userId = req.user.id;
    const entry = activeMemory.createMemoryEntry(userId, fact, {
      category: category || 'general',
      tags: tags || [],
      confidence: confidence || 0.7,
      source: source || 'manual',
    });
    res.json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/memory/recall', authenticateToken, async (req, res) => {
  try {
    const { query, limit, tier, category } = req.body;
    const userId = req.user.id;
    const results = activeMemory.recall(userId, query, { limit, tier, category });
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/memory', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const context = activeMemory.getMemoryContext(userId, { limit: 50 });
    const stats = activeMemory.getStats(userId);
    res.json({ context, stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/memory', authenticateToken, async (req, res) => {
  try {
    const { query } = req.body;
    const userId = req.user.id;
    if (query) {
      const result = activeMemory.forget(userId, query);
      res.json(result);
    } else {
      const result = activeMemory.clearUserMemory(userId);
      res.json(result);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/memory/promote/:entryId', authenticateToken, async (req, res) => {
  try {
    const entry = activeMemory.promoteToLongTerm(req.params.entryId);
    if (!entry) return res.status(404).json({ error: 'entry not found' });
    res.json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/sessions', authenticateToken, async (req, res) => {
  try {
    const { label, model, provider, tags, metadata } = req.body;
    const userId = req.user.id;
    const session = sessionManager.createSession(userId, {
      label,
      model,
      provider,
      tags,
      metadata,
    });
    res.json(session);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/sessions', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const sessions = sessionManager.listSessions(userId, {
      limit: req.query.limit,
      tag: req.query.tag,
    });
    const stats = sessionManager.getSessionStats(userId);
    res.json({ sessions, stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/sessions/:sessionId', authenticateToken, async (req, res) => {
  try {
    const session = sessionManager.getSession(req.params.sessionId);
    if (!session || session.userId !== req.user.id) {
      return res.status(404).json({ error: 'session not found' });
    }
    res.json(session);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/sessions/:sessionId/messages', authenticateToken, async (req, res) => {
  try {
    const { role, content, tokens, metadata } = req.body;
    const session = sessionManager.getSession(req.params.sessionId);
    if (!session || session.userId !== req.user.id) {
      return res.status(404).json({ error: 'session not found' });
    }
    const msg = sessionManager.addMessage(req.params.sessionId, {
      role,
      content,
      tokens,
      metadata,
    });
    res.json(msg);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/sessions/:sessionId/history', authenticateToken, async (req, res) => {
  try {
    const session = sessionManager.getSession(req.params.sessionId);
    if (!session || session.userId !== req.user.id) {
      return res.status(404).json({ error: 'session not found' });
    }
    const history = sessionManager.getHistory(req.params.sessionId, {
      after: req.query.after,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      role: req.query.role,
    });
    res.json({ messages: history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/sessions/:sessionId/spawn', authenticateToken, async (req, res) => {
  try {
    const { label, model, provider, metadata } = req.body;
    const session = sessionManager.getSession(req.params.sessionId);
    if (!session || session.userId !== req.user.id) {
      return res.status(404).json({ error: 'session not found' });
    }
    const child = sessionManager.spawnSession(req.params.sessionId, req.user.id, {
      label,
      model,
      provider,
      metadata,
    });
    res.json(child);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/sessions/:sessionId/compact', authenticateToken, async (req, res) => {
  try {
    const { summary, keepFirst, keepLast } = req.body;
    const session = sessionManager.getSession(req.params.sessionId);
    if (!session || session.userId !== req.user.id) {
      return res.status(404).json({ error: 'session not found' });
    }
    const result = sessionManager.compactSession(req.params.sessionId, {
      summary,
      keepFirst,
      keepLast,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/sessions/:sessionId/reset', authenticateToken, async (req, res) => {
  try {
    const session = sessionManager.getSession(req.params.sessionId);
    if (!session || session.userId !== req.user.id) {
      return res.status(404).json({ error: 'session not found' });
    }
    const result = sessionManager.resetSession(req.params.sessionId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/sessions/:sessionId/send', authenticateToken, async (req, res) => {
  try {
    const { targetSessionId, content, role } = req.body;
    if (!targetSessionId || !content) {
      return res.status(400).json({ error: 'targetSessionId and content are required' });
    }
    const source = sessionManager.getSession(req.params.sessionId);
    const target = sessionManager.getSession(targetSessionId);
    if (!source || source.userId !== req.user.id) {
      return res.status(404).json({ error: 'source session not found' });
    }
    if (!target || target.userId !== req.user.id) {
      return res.status(404).json({ error: 'target session not found' });
    }
    const msg = sessionManager.sendToSession(req.params.sessionId, targetSessionId, {
      content,
      role: role || 'user',
    });
    res.json(msg);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/skills', optionalAuth, (req, res) => {
  try {
    const skills = skillsRegistry.listSkills({
      category: req.query.category,
      tag: req.query.tag,
      query: req.query.query,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      clearance: req.user?.plan?.toLowerCase() || 'public',
    });
    const categories = skillsRegistry.getCategories();
    const tags = skillsRegistry.getTags();
    res.json({ skills, categories, tags });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/skills/recommend', optionalAuth, (req, res) => {
  try {
    const { intent, hasDocuments, hasCode, needsResearch, needsAnalysis, tags } = req.query;
    const skills = skillsRegistry.recommendSkills(intent, {
      hasDocuments: hasDocuments === 'true',
      hasCode: hasCode === 'true',
      needsResearch: needsResearch === 'true',
      needsAnalysis: needsAnalysis === 'true',
      tags: tags ? tags.split(',') : [],
      userClearance: req.user?.plan?.toLowerCase() || 'public',
    });
    res.json({ skills });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/enrich', authenticateToken, async (req, res) => {
  try {
    const { content, chatId, model } = req.body;
    if (!content || typeof content !== 'string') {
      return res.status(400).json({ error: 'content is required' });
    }
    const userId = req.user.id;
    const result = await coworkEngine.enrichAIRequest(userId, content, {
      chatId,
      model,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
