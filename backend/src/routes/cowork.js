'use strict';

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { optionalAuth } = require('../middleware/optionalAuth');
const autoFileBridge = require('../services/auto-file-bridge');
const deepDocumentAnalyzer = require('../services/deep-document-analyzer');
const activeMemory = require('../services/active-memory');
const memoryMetrics = require('../services/memory-metrics');
const sessionManager = require('../services/session-manager');
const skillsRegistry = require('../services/skills-registry');
const coworkEngine = require('../services/cowork-engine');
const coworkHealth = require('../services/cowork-health');
const { createProgressStream, writeSSE, STAGES } = require('../services/cowork-progress-stream');
const { rateLimitMiddleware } = require('../services/rate-limiter');

const router = express.Router();

const coworkRateLimit = rateLimitMiddleware({ windowMs: 60000, maxRequests: 30 });
const analyzeDeepRateLimit = rateLimitMiddleware({ windowMs: 60000, maxRequests: 20 });
const memoryRateLimit = rateLimitMiddleware({ windowMs: 60000, maxRequests: 60 });

// Express parses repeated query keys (?intent=a&intent=b) as arrays and nested
// keys (?tags[x]=1) as objects. The skills registry expects plain strings, so
// coerce every query param to a single trimmed string at the route boundary —
// otherwise `.split`/string ops downstream throw on the unexpected shape.
function firstQueryString(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return firstQueryString(value[0]);
  return '';
}
function clampQueryLimit(value, fallback, max = 100) {
  const n = Number(firstQueryString(value));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

router.post('/auto-file', authenticateToken, coworkRateLimit, async (req, res) => {
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

router.post('/auto-file/batch', authenticateToken, coworkRateLimit, async (req, res) => {
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

router.post('/analyze-deep', authenticateToken, analyzeDeepRateLimit, async (req, res) => {
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

router.post('/analyze-deep/file/:fileId', authenticateToken, analyzeDeepRateLimit, async (req, res) => {
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

router.post('/memory', authenticateToken, memoryRateLimit, async (req, res) => {
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

router.post('/memory/recall', authenticateToken, memoryRateLimit, async (req, res) => {
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

// Full structured list of everything the system remembers about the user —
// powers a "ver toda mi memoria" management view (transparency + control).
router.get('/memory/all', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    // Read-only listing: don't bump accessCount just because the user opened
    // their memory view (that would skew tier auto-promotion).
    const entries = activeMemory.recall(userId, null, { limit, bump: false });
    const items = (Array.isArray(entries) ? entries : []).map((m) => ({
      id: m.id,
      fact: m.fact,
      category: m.category || 'general',
      tier: m.tier || 'short_term',
      polarity: m.metadata?.polarity || 'positive',
      confidence: typeof m.confidence === 'number' ? Number(m.confidence.toFixed(2)) : null,
      accessCount: m.accessCount || 0,
      createdAt: m.createdAt || null,
      lastAccessed: m.lastAccessed || null,
    }));
    res.json({ items, stats: activeMemory.getStats(userId) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Memory-system observability snapshot (counts + recall hit-rate).
router.get('/memory/metrics', authenticateToken, async (req, res) => {
  try {
    res.json(memoryMetrics.snapshot());
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

// Forget a single memory by id (scoped to the owning user). Powers the
// "Olvidar" action on each item in the MEMORIA panel.
router.delete('/memory/:id', authenticateToken, memoryRateLimit, async (req, res) => {
  try {
    const userId = req.user.id;
    const id = String(req.params.id || '');
    if (!id) return res.status(400).json({ error: 'id required' });
    const result = activeMemory.deleteById(userId, id);
    if (!result.removed) return res.status(404).json({ error: 'memory not found' });
    res.json({ ok: true, removed: result.removed, fact: result.fact });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/memory/promote/:entryId', authenticateToken, memoryRateLimit, async (req, res) => {
  try {
    const entry = activeMemory.promoteToLongTerm(req.params.entryId);
    if (!entry) return res.status(404).json({ error: 'entry not found' });
    res.json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/sessions', authenticateToken, coworkRateLimit, async (req, res) => {
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

router.post('/sessions/:sessionId/messages', authenticateToken, coworkRateLimit, async (req, res) => {
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
      limit: req.query.limit ? Math.min(Math.max(1, Number(req.query.limit) || 1), 500) : undefined,
      role: req.query.role,
    });
    res.json({ messages: history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/sessions/:sessionId/spawn', authenticateToken, coworkRateLimit, async (req, res) => {
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

router.post('/sessions/:sessionId/compact', authenticateToken, coworkRateLimit, async (req, res) => {
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

router.post('/sessions/:sessionId/reset', authenticateToken, coworkRateLimit, async (req, res) => {
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

router.post('/sessions/:sessionId/send', authenticateToken, coworkRateLimit, async (req, res) => {
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
      category: firstQueryString(req.query.category) || undefined,
      tag: firstQueryString(req.query.tag) || undefined,
      query: firstQueryString(req.query.query) || undefined,
      limit: req.query.limit !== undefined ? clampQueryLimit(req.query.limit, undefined) : undefined,
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
    const { hasDocuments, hasCode, needsResearch, needsAnalysis } = req.query;
    const intent = firstQueryString(req.query.intent);
    const tags = firstQueryString(req.query.tags);
    const skills = skillsRegistry.recommendSkills(intent, {
      hasDocuments: hasDocuments === 'true',
      hasCode: hasCode === 'true',
      needsResearch: needsResearch === 'true',
      needsAnalysis: needsAnalysis === 'true',
      // Cap the tag list — recommendSkills scores O(skills × tags), so an
      // unbounded comma string would be a CPU/memory amplification vector.
      tags: tags ? tags.split(',').slice(0, 50).map((t) => t.trim()).filter(Boolean) : [],
      userClearance: req.user?.plan?.toLowerCase() || 'public',
    });
    res.json({ skills });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/enrich', authenticateToken, coworkRateLimit, async (req, res) => {
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

router.get('/health', optionalAuth, async (req, res) => {
  try {
    const userId = req.user?.id || null;
    const report = await coworkHealth.runFullHealthCheck(userId);
    const status = report.ok ? 200 : report.status === 'degraded' ? 200 : 503;
    res.status(status).json(report);
  } catch (err) {
    res.status(503).json({ status: 'unhealthy', error: err.message });
  }
});

router.get('/health/ready', async (req, res) => {
  try {
    const report = await coworkHealth.runReadinessCheck();
    res.status(report.ok ? 200 : 503).json(report);
  } catch (err) {
    res.status(503).json({ status: 'not_ready', error: err.message });
  }
});

router.get('/health/live', (req, res) => {
  const report = coworkHealth.runLivenessCheck();
  res.json(report);
});

router.post('/analyze-stream', authenticateToken, coworkRateLimit, async (req, res) => {
  try {
    const { text, fileName, mimeType } = req.body;
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'text is required' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const userId = req.user.id;
    const progress = createProgressStream();
    writeSSE(res, progress);
    progress.start();

    try {
      progress.advance(STAGES.DETECTING_FORMAT, { format: autoFileBridge.detectContentType(text).format });

      progress.advance(STAGES.ANALYZING_DOMAIN);
      const domain = deepDocumentAnalyzer.detectDomain(text, fileName || '', mimeType || '');

      progress.advance(STAGES.EXTRACTING_ENTITIES);
      const entities = deepDocumentAnalyzer.extractEntities(text);

      progress.advance(STAGES.ASSESSING_RISKS, { entityCount: entities.length });
      const risks = deepDocumentAnalyzer.assessRisks(text, domain.primary, entities);

      progress.advance(STAGES.COMPUTING_QUALITY);
      const quality = deepDocumentAnalyzer.computeQualityMetrics(text, domain.primary, entities, risks);

      progress.advance(STAGES.BUILDING_STRUCTURE);
      const structure = deepDocumentAnalyzer.extractStructure(text);

      progress.advance(STAGES.FINALIZING);

      const result = {
        ok: true,
        domain,
        entities: entities.map(e => ({
          type: e.type,
          value: e.sensitivity === 'critical' ? e.redacted : e.value,
          sensitivity: e.sensitivity,
        })),
        piiSummary: {
          total: entities.length,
          critical: entities.filter(e => e.sensitivity === 'critical').length,
          high: entities.filter(e => e.sensitivity === 'high').length,
        },
        risks,
        quality,
        structure,
        autoTags: deepDocumentAnalyzer.generateAutoTags(text, domain, entities, []),
        summary: deepDocumentAnalyzer.buildAnalysisSummary
          ? `Domain: ${domain.primary} | Quality: ${quality.grade} (${quality.overall}/100) | Risk: ${risks.severity}`
          : '',
      };

      progress.complete(result);
    } catch (analysisErr) {
      progress.fail(analysisErr.message);
    }
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

const analysisPipeline = require('../services/analysis-pipeline');

router.post('/analyze-pro', authenticateToken, analyzeDeepRateLimit, async (req, res) => {
  try {
    const { text, fileName, mimeType, documents } = req.body;
    if (documents && Array.isArray(documents) && documents.length >= 2) {
      const result = analysisPipeline.runMultiDocumentAnalysis(documents);
      res.json(result);
      return;
    }
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'text or documents array is required' });
    }
    const result = analysisPipeline.runAnalysisPipeline(text, { fileName, mimeType });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/analyze-pro/stream', authenticateToken, analyzeDeepRateLimit, async (req, res) => {
  try {
    const { text, fileName, mimeType } = req.body;
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'text is required' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const userId = req.user.id;
    const { STAGES: S, STAGE_LABELS: L } = analysisPipeline;
    const send = (stage, data) => {
      try {
        res.write(`data: ${JSON.stringify({ type: 'stage', stage, label: L[stage] || stage, ...data })}\n\n`);
      } catch (_e) { /* client disconnected */ }
    };

    send(S.DETECTING_FORMAT, { format: analysisPipeline.smartPaste.detectContentType(text).format });
    send(S.DETECTING_DOMAIN, {});
    const domain = analysisPipeline.professionalAnalyzer.detectDomain(text, fileName, mimeType);
    send(S.EXTRACTING_ENTITIES, {});
    const entities = analysisPipeline.professionalAnalyzer.extractEntities(text);
    send(S.BUILDING_STRUCTURE, { entityCount: entities.length });
    const structure = analysisPipeline.professionalAnalyzer.extractStructure(text);
    send(S.ASSESSING_RISKS, { headings: structure.headings.length });
    const risks = analysisPipeline.professionalAnalyzer.assessRisks(text, domain.primary, entities);
    send(S.COMPUTING_QUALITY, { riskCount: risks.items.length, severity: risks.severity });
    const quality = analysisPipeline.professionalAnalyzer.computeQualityMetrics(text, domain.primary, entities, risks);
    send(S.BUILDING_DIMENSIONS, { grade: quality.grade, overall: quality.overall });
    const dimensions = analysisPipeline.professionalAnalyzer.buildDimensionReport(text, domain.primary, entities, structure);
    send(S.MAPPING_RISKS, { dimensionCount: dimensions.length });
    const riskMapping = analysisPipeline.professionalAnalyzer.buildRiskMapping(text, domain.primary, entities, risks);
    send(S.BUILDING_REPORT, { coverage: riskMapping.coveragePercent });
    const autoTags = analysisPipeline.professionalAnalyzer.generateAutoTags(text, domain.primary, entities, structure);

    const result = {
      ok: true,
      format: analysisPipeline.professionalAnalyzer.detectFormat(text),
      domain,
      entities: entities.map(e => ({
        type: e.type,
        value: e.sensitivity === 'critical' ? (e.value.slice(0, 3) + '****') : e.value,
        sensitivity: e.sensitivity,
        pii: e.pii,
      })),
      piiSummary: {
        total: entities.filter(e => e.pii).length,
        critical: entities.filter(e => e.sensitivity === 'critical').length,
        high: entities.filter(e => e.sensitivity === 'high').length,
      },
      structure: {
        headingCount: structure.headings.length,
        hasToc: structure.hasToc,
        wordCount: structure.wordCount,
      },
      risks,
      quality,
      dimensions,
      riskMapping,
      autoTags,
    };

    send(S.COMPLETE, {});
    res.write(`data: ${JSON.stringify({ type: 'result', ...result })}\n\n`);
    res.end();
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

// ── Intent Attribution Graph — decompose a prompt into atomic intent
// features, supernodes, reasoning circuits, anticipated next steps,
// hidden intents, and a calibrated confidence score. Inspired by
// Anthropic's attribution-graphs paper. Pure-local, no LLM call.
router.post('/intent-attribution-graph', optionalAuth, coworkRateLimit, async (req, res) => {
  try {
    const { prompt, attachments, includeBlock, includeFeatures, maxBlockChars } = req.body || {};
    if (typeof prompt !== 'string') {
      return res.status(400).json({ error: 'prompt (string) is required' });
    }
    if (prompt.length > 200_000) {
      return res.status(413).json({ error: 'prompt too large (max 200k chars)' });
    }
    const intentAttributionGraph = require('../services/intent-attribution-graph');
    const report = intentAttributionGraph.analyzeIntent(prompt, {
      attachments: Array.isArray(attachments) ? attachments : [],
    });
    const payload = {
      ok: true,
      empty: report.empty === true,
      language: report.language,
      stats: report.stats,
      supernodes: report.supernodes,
      circuits: report.circuits,
      plan: report.plan,
      hiddenIntents: report.hiddenIntents,
      confidence: report.confidence,
      topFeatures: report.topFeatures,
      durationMs: report.durationMs,
    };
    if (includeFeatures) {
      payload.features = report.features;
      payload.graph = report.graph;
    }
    if (includeBlock !== false) {
      payload.promptBlock = intentAttributionGraph.formatForPrompt(report, {
        maxChars: Number.isInteger(maxBlockChars) ? maxBlockChars : undefined,
      });
      payload.summary = intentAttributionGraph.compactSummary(report);
      payload.shouldClarify = intentAttributionGraph.shouldClarify(report);
    }
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Validate a candidate response against an intent report.
// Useful for frontend / agents to self-evaluate a draft response before
// sending it to the user. Returns coverage score, missing high-importance
// features, hidden-intent gaps, and remediation feedback.
router.post('/intent-attribution-graph/validate', optionalAuth, coworkRateLimit, async (req, res) => {
  try {
    const { prompt, response, attachments } = req.body || {};
    if (typeof prompt !== 'string' || typeof response !== 'string') {
      return res.status(400).json({ error: 'prompt and response (both strings) are required' });
    }
    if (prompt.length > 200_000 || response.length > 200_000) {
      return res.status(413).json({ error: 'input too large (max 200k chars each)' });
    }
    const intentAttributionGraph = require('../services/intent-attribution-graph');
    const report = intentAttributionGraph.analyzeIntent(prompt, {
      attachments: Array.isArray(attachments) ? attachments : [],
    });
    const validation = intentAttributionGraph.validateResponse(report, response);
    res.json({
      ok: true,
      report: {
        language: report.language,
        stats: report.stats,
        confidence: report.confidence,
        supernodes: report.supernodes,
        hiddenIntents: report.hiddenIntents,
      },
      validation,
      validationBlock: intentAttributionGraph.formatValidationBlock(validation),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
// Exposed for offline unit tests — see tests/cowork-query-coercion.test.js.
module.exports._internals = { firstQueryString, clampQueryLimit };
