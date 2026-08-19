'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const cowork = require('../src/services/cowork-health');
const prisma = require('../src/config/database');
const {
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
} = cowork;

// Save the real $queryRaw so we can stub it per test.
const realQueryRaw = prisma.$queryRaw;

test.beforeEach(() => {
  prisma.$queryRaw = async () => [{ '?column?': 1 }];
});
test.afterEach(() => {
  prisma.$queryRaw = realQueryRaw;
});

test('exports the documented surface', () => {
  for (const fn of [
    runFullHealthCheck, runReadinessCheck, runLivenessCheck,
    checkPrisma, checkRAG, checkActiveMemory, checkSessionManager,
    checkSkillsRegistry, checkAutoFileBridge, checkDeepDocumentAnalyzer,
  ]) {
    assert.equal(typeof fn, 'function');
  }
});

test('checkPrisma reports ok when $queryRaw resolves', async () => {
  const out = await checkPrisma();
  assert.equal(out.ok, true);
  assert.equal(typeof out.latencyMs, 'number');
});

test('checkPrisma reports failure when $queryRaw throws', async () => {
  prisma.$queryRaw = async () => { throw new Error('db down'); };
  const out = await checkPrisma();
  assert.equal(out.ok, false);
  assert.match(out.error, /db down/);
});

test('checkRAG reports ok and bubbles up stats from rag-service', async () => {
  const out = await checkRAG();
  assert.equal(out.ok, true);
  // stats may include collections/chunks counts depending on registry state
  assert.equal(typeof out, 'object');
});

test('checkActiveMemory reports ok with entry counters', () => {
  const out = checkActiveMemory('__test__user__');
  assert.equal(out.ok, true);
  assert.equal(typeof out.entries, 'number');
  assert.equal(typeof out.longTerm, 'number');
  assert.equal(typeof out.shortTerm, 'number');
});

test('checkSessionManager reports ok with active session count', () => {
  const out = checkSessionManager();
  assert.equal(out.ok, true);
  assert.equal(typeof out.activeSessions, 'number');
});

test('checkSkillsRegistry reports ok with totals + category count', () => {
  const out = checkSkillsRegistry();
  assert.equal(out.ok, true);
  assert.equal(typeof out.totalSkills, 'number');
  assert.equal(typeof out.categories, 'number');
});

test('checkAutoFileBridge reports ok with paste length bounds', () => {
  const out = checkAutoFileBridge();
  assert.equal(out.ok, true);
  assert.equal(typeof out.minPasteLength, 'number');
  assert.equal(typeof out.maxPasteLength, 'number');
  assert.ok(out.maxPasteLength >= out.minPasteLength);
});

test('checkDeepDocumentAnalyzer reports ok with domain + entity counts', () => {
  const out = checkDeepDocumentAnalyzer();
  assert.equal(out.ok, true);
  assert.ok(out.domains > 0);
  assert.ok(out.entityPatterns > 0);
});

test('runFullHealthCheck returns "healthy" when every check passes', async () => {
  const report = await runFullHealthCheck('__test__user__');
  assert.equal(report.ok, true);
  assert.equal(report.status, 'healthy');
  assert.deepEqual(report.failedChecks, []);
  assert.equal(typeof report.timestamp, 'string');
  // Per-check entries must all be present
  for (const key of ['database', 'rag', 'activeMemory', 'sessionManager', 'skillsRegistry', 'autoFileBridge', 'deepDocumentAnalyzer', 'documentIntelligence']) {
    assert.ok(key in report.checks, `expected ${key} in checks`);
  }
});

test('runFullHealthCheck returns "degraded" when exactly one check fails', async () => {
  prisma.$queryRaw = async () => { throw new Error('db down'); };
  const report = await runFullHealthCheck('__test__user__');
  assert.equal(report.ok, false);
  assert.equal(report.status, 'degraded');
  assert.deepEqual(report.failedChecks, ['database']);
});

test('runReadinessCheck reports ready when DB responds', async () => {
  const report = await runReadinessCheck();
  assert.equal(report.ok, true);
  assert.equal(report.status, 'ready');
  assert.equal(report.checks.database.ok, true);
});

test('runReadinessCheck reports not_ready when DB fails', async () => {
  prisma.$queryRaw = async () => { throw new Error('db down'); };
  const report = await runReadinessCheck();
  assert.equal(report.ok, false);
  assert.equal(report.status, 'not_ready');
});

test('runLivenessCheck always returns alive + uptime + timestamp', () => {
  const report = runLivenessCheck();
  assert.equal(report.ok, true);
  assert.equal(report.status, 'alive');
  assert.equal(typeof report.uptime, 'number');
  assert.ok(report.uptime >= 0);
  assert.equal(typeof report.timestamp, 'string');
});
