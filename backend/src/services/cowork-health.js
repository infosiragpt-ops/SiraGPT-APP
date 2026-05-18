'use strict';

const activeMemory = require('./active-memory');
const sessionManager = require('./session-manager');
const skillsRegistry = require('./skills-registry');
const autoFileBridge = require('./auto-file-bridge');
const deepDocumentAnalyzer = require('./deep-document-analyzer');
const documentIntelligence = require('./document-intelligence');
const rag = require('./rag-service');
const prisma = require('../config/database');

const CHECK_TIMEOUT_MS = 5000;

async function checkPrisma() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true, latencyMs: 0 };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function checkRAG() {
  try {
    const stats = rag.getStats ? rag.getStats() : { collections: 0 };
    return { ok: true, ...stats };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function checkActiveMemory(userId) {
  try {
    const stats = activeMemory.getStats(userId || '__system__');
    return { ok: true, entries: stats.total, longTerm: stats.longTerm, shortTerm: stats.shortTerm };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function checkSessionManager() {
  try {
    const stats = sessionManager.getSessionStats('__system__');
    return { ok: true, activeSessions: stats.activeSessions };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function checkSkillsRegistry() {
  try {
    const stats = skillsRegistry.getStats();
    return { ok: true, totalSkills: stats.totalSkills, categories: Object.keys(stats.categories).length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function checkAutoFileBridge() {
  try {
    return { ok: true, minPasteLength: autoFileBridge.MIN_PASTE_LENGTH, maxPasteLength: autoFileBridge.MAX_PASTE_LENGTH };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function checkDeepDocumentAnalyzer() {
  try {
    const domains = Object.keys(deepDocumentAnalyzer.DOMAIN_RULES);
    return { ok: true, domains: domains.length, entityPatterns: deepDocumentAnalyzer.ENTITY_PATTERNS.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function checkDocumentIntelligence() {
  return { ok: true, note: 'document-intelligence loaded' };
}

async function runFullHealthCheck(userId) {
  const checks = {};

  checks.database = await checkPrisma();
  checks.rag = await checkRAG();
  checks.activeMemory = checkActiveMemory(userId);
  checks.sessionManager = checkSessionManager();
  checks.skillsRegistry = checkSkillsRegistry();
  checks.autoFileBridge = checkAutoFileBridge();
  checks.deepDocumentAnalyzer = checkDeepDocumentAnalyzer();
  checks.documentIntelligence = checkDocumentIntelligence();

  const allOk = Object.values(checks).every(c => c.ok);
  const failedChecks = Object.entries(checks).filter(([_, c]) => !c.ok).map(([name]) => name);

  return {
    status: allOk ? 'healthy' : failedChecks.length === 1 ? 'degraded' : 'unhealthy',
    ok: allOk,
    checks,
    failedChecks,
    timestamp: new Date().toISOString(),
  };
}

async function runReadinessCheck() {
  try {
    const db = await checkPrisma();
    return {
      status: db.ok ? 'ready' : 'not_ready',
      ok: db.ok,
      checks: { database: db },
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    return {
      status: 'not_ready',
      ok: false,
      error: err.message,
      timestamp: new Date().toISOString(),
    };
  }
}

async function runLivenessCheck() {
  return {
    status: 'alive',
    ok: true,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  };
}

module.exports = {
  runFullHealthCheck,
  runReadinessCheck,
  runLivenessCheck,
  checkPrisma,
  checkRAG,
  checkActiveMemory,
  checkSessionManager,
  checkSkillsRegistry,
  checkAutoFileBridge,
  checkDeepDocumentAnalyzer,
};
