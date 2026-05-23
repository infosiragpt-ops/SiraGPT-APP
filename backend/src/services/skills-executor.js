'use strict';

const skillsRegistry = require('./skills-registry');
const autoFileBridge = require('./auto-file-bridge');
const deepDocumentAnalyzer = require('./deep-document-analyzer');
const activeMemory = require('./active-memory');

const HANDLERS = {
  deep_document_analysis: async (ctx) => {
    const text = String(ctx.content || ctx.text || '');
    if (!text.trim()) return { ok: false, error: 'content required' };
    const report = await deepDocumentAnalyzer.analyzeDeep(text, {
      filename: ctx.filename || 'document.txt',
      userId: ctx.userId,
    });
    return { ok: true, report };
  },
  auto_file_analysis: async (ctx) => {
    const content = String(ctx.content || '');
    if (!content.trim() || !ctx.userId) return { ok: false, error: 'content and userId required' };
    const result = await autoFileBridge.ingestPastedContent(ctx.userId, content, {
      filename: ctx.filename,
      prisma: ctx.prisma,
    });
    return { ok: true, result };
  },
  memory_enhanced_qa: async (ctx) => {
    const facts = activeMemory.recall(ctx.userId, ctx.query || '', { limit: ctx.limit || 10 });
    return { ok: true, facts };
  },
};

async function executeSkill(skillId, ctx = {}) {
  const skill = skillsRegistry.getSkill(skillId);
  if (!skill) {
    return { ok: false, error: `unknown_skill: ${skillId}` };
  }

  const prereq = skillsRegistry.verifyPrerequisites(skillId, ctx);
  if (prereq && prereq.ok === false) {
    return { ok: false, error: prereq.reason || prereq.missing || 'prerequisites_failed' };
  }

  const handler = HANDLERS[skill.id];
  if (!handler) {
    return { ok: false, error: `no_handler: ${skill.id}`, skill: skill.id };
  }

  try {
    const result = await handler({ ...ctx, skill });
    return { ok: true, skillId: skill.id, result };
  } catch (err) {
    return { ok: false, error: err?.message || String(err), skillId: skill.id };
  }
}

async function executeRecommendedSkills(intent, ctx = {}, opts = {}) {
  const limit = Math.max(1, Math.min(Number(opts.limit) || 2, 5));
  const recommended = skillsRegistry.recommendSkills(intent, ctx) || [];
  const slice = Array.isArray(recommended) ? recommended.slice(0, limit) : [];
  const results = [];
  for (const entry of slice) {
    const skillId = entry.skill?.id || entry.id || entry.skillId;
    if (!skillId) continue;
    results.push(await executeSkill(skillId, ctx));
  }
  return results;
}

module.exports = {
  HANDLERS,
  executeSkill,
  executeRecommendedSkills,
};
