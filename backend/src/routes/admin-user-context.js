'use strict';

/**
 * admin-user-context.js — operator endpoint to audit what siraGPT
 * "knows" about a given user. Aggregates explicit profile, inferred
 * profile, long-term memory facts, recent chats, and a health snapshot
 * into a single read-only JSON payload.
 *
 * Mount: app.use('/api/admin/user-context', router)
 * Auth: bearer plus the mount-aware declarative admin route policy.
 */

const express = require('express');
const prisma = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const requireAdminRoutePermission = require('../services/admin-route-policy');
const { loadInferredProfile } = require('../services/user-profile-inference');

const router = express.Router();
router.use(authenticateToken, requireAdminRoutePermission);

// Kept as a pure compatibility helper for existing unit consumers. Runtime
// authorization is handled by requireAdminRoutePermission above.
function requireAdminReadable(req, res, next) {
  try {
    if (req.user && (req.user.isSuperAdmin || req.user.isAdmin)) return next();
    // Token-scoped access (api-key issued through admin clearance).
    if (req.user && Array.isArray(req.user.scopes) && req.user.scopes.includes('admin:read')) return next();
  } catch (_err) { /* fall through to 403 */ }
  return res.status(403).json({ error: 'forbidden: admin:read required' });
}

function sanitizeUserProfile(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    plan: user.plan || null,
    locale: user.locale || null,
    preferredTone: user.preferredTone || null,
    customInstructions: user.customInstructions || null,
    createdAt: user.createdAt instanceof Date ? user.createdAt.toISOString() : user.createdAt,
    lastActiveAt: user.lastActiveAt instanceof Date ? user.lastActiveAt.toISOString() : user.lastActiveAt,
  };
}

function summarizeMemoryFacts(facts) {
  if (!Array.isArray(facts)) return { count: 0, byCategory: {}, topFacts: [] };
  const byCategory = {};
  for (const f of facts) {
    const cat = (f && f.category) || 'knowledge';
    byCategory[cat] = (byCategory[cat] || 0) + 1;
  }
  const topFacts = facts.slice(0, 20).map((f) => ({
    text: typeof f.content === 'string' ? f.content : (typeof f.text === 'string' ? f.text : ''),
    category: f.category || 'knowledge',
    importance: Number(f.importance_score || f.importance || 0),
    confidence: Number(f.confidence || 0),
    accessCount: Number(f.access_count || f.accessCount || 0),
    lastAccessedAt: f.last_accessed_at || f.lastAccessedAt || null,
  })).filter((x) => x.text);
  return { count: facts.length, byCategory, topFacts };
}

async function loadMemoryFacts(userId) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT content, category, importance_score, confidence, access_count, last_accessed_at
       FROM user_memories
       WHERE user_id = $1
       ORDER BY importance_score DESC, last_accessed_at DESC
       LIMIT 200`,
      userId,
    );
    return Array.isArray(rows) ? rows : [];
  } catch (_err) {
    return [];
  }
}

async function loadRecentChats(userId, limit = 5) {
  try {
    const chats = await prisma.chat.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      take: limit,
      select: {
        id: true, title: true, createdAt: true, updatedAt: true,
        _count: { select: { messages: true } },
      },
    });
    return chats.map((c) => ({
      id: c.id,
      title: c.title,
      messageCount: c?._count?.messages || 0,
      createdAt: c.createdAt instanceof Date ? c.createdAt.toISOString() : c.createdAt,
      updatedAt: c.updatedAt instanceof Date ? c.updatedAt.toISOString() : c.updatedAt,
    }));
  } catch (_err) {
    return [];
  }
}

function buildHealth({ explicit, inferred, memorySummary, recentChats }) {
  const hasExplicit = Boolean(explicit && (explicit.preferredTone || explicit.customInstructions || explicit.locale));
  const hasInferred = Boolean(inferred);
  const memoryFactsCount = memorySummary?.count || 0;
  const lastInferredAt = (inferred && inferred.lastUpdatedAt) || null;
  const confidenceScore = inferred ? Number(inferred.confidence || 0) : 0;
  const totalKnownTraits =
    (hasExplicit ? 1 : 0)
    + (hasInferred ? 1 : 0)
    + Math.min(1, memoryFactsCount / 10)
    + Math.min(1, (recentChats?.length || 0) / 3);
  // Normalize to 0-1 by dividing by the max possible (4).
  const overallScore = Math.min(1, totalKnownTraits / 4);
  return {
    memoryFactsCount,
    hasExplicitProfile: hasExplicit,
    hasInferredProfile: hasInferred,
    lastInferredAt,
    confidenceScore,
    recentChatCount: recentChats?.length || 0,
    overallContextScore: Number(overallScore.toFixed(3)),
  };
}

router.get('/:userId/audit', async (req, res) => {
  const { userId } = req.params;
  if (!userId || typeof userId !== 'string' || userId.length < 4) {
    return res.status(400).json({ error: 'invalid userId' });
  }
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true, email: true, name: true, plan: true, locale: true,
        preferredTone: true, customInstructions: true, settings: true,
        createdAt: true, lastActiveAt: true,
      },
    });
    if (!user) return res.status(404).json({ error: 'user not found' });

    const explicit = sanitizeUserProfile(user);
    const inferred = loadInferredProfile(user);
    const memoryFacts = await loadMemoryFacts(userId);
    const memorySummary = summarizeMemoryFacts(memoryFacts);
    const recentChats = await loadRecentChats(userId, 5);
    const health = buildHealth({ explicit, inferred, memorySummary, recentChats });

    return res.json({
      schema_version: 'sira.user_context_audit.v1',
      userId,
      generatedAt: new Date().toISOString(),
      explicitProfile: explicit,
      inferredProfile: inferred || null,
      memory: memorySummary,
      recentChats,
      health,
    });
  } catch (err) {
    console.error('[admin-user-context] audit failed:', err && err.message);
    return res.status(500).json({ error: 'failed to build user context audit' });
  }
});

module.exports = {
  router,
  __test: {
    sanitizeUserProfile,
    summarizeMemoryFacts,
    buildHealth,
    requireAdminReadable,
  },
};
