'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { classifyTaskError } = require('../src/utils/task-error-classifier');
const workspaceIdempotency = require('../src/services/agents/workspace-idempotency');
const searchCache = require('../src/services/scientific-search-cache');
const intentRagGate = require('../src/services/document-intent-rag-gate');
const { resolveTaskPolicy } = require('../src/services/ai-product-os/litellm-task-policy');
const { requireDurableArtifactStorage } = require('../src/orchestration/artifact-storage-policy');
const researchRunStore = require('../src/services/research-run-store');
const refreshRotation = require('../src/services/auth/refresh-token-rotation');

describe('internal improvements suite', () => {
  it('classifyTaskError marks unknown as non-retryable', () => {
    const c = classifyTaskError(new Error('weird one-off glitch'));
    assert.equal(c.retryable, false);
    assert.equal(c.reason, 'unknown');
  });

  it('classifyTaskError still retries rate limits', () => {
    const c = classifyTaskError(Object.assign(new Error('rate limit'), { statusCode: 429 }));
    assert.equal(c.retryable, true);
    assert.equal(c.reason, 'rate-limited');
  });

  it('workspace idempotency dedupes active workflows', () => {
    const userId = 'user_test_1';
    const goal = 'Build Codex workspace orchestration for thesis';
    workspaceIdempotency.registerWorkflow(userId, goal, null, {
      taskId: 'task_a',
      jobId: 'job_a',
      status: 'queued',
    });
    const existing = workspaceIdempotency.findExistingWorkflow(userId, goal, null);
    assert.ok(existing);
    assert.equal(existing.taskId, 'task_a');
  });

  it('scientific search cache returns hits', () => {
    searchCache.clear();
    const payload = { papers: [{ title: 'A' }], errors: [], providers: ['arxiv'] };
    searchCache.set('quantum dots', { limit: 5 }, payload);
    const hit = searchCache.get('quantum dots', { limit: 5 });
    assert.ok(hit);
    assert.equal(hit.papers[0].title, 'A');
    assert.equal(hit._cache.hit, true);
  });

  it('intent rag gate filters low-relevance sources', () => {
    const sources = [
      { fileId: 'f1', source: 'f1' },
      { fileId: 'f2', source: 'f2' },
      { fileId: 'f3', source: 'f3' },
    ];
    const intent = {
      perDocument: [
        { fileId: 'f1', relevanceScore: 0.9, role: 'primary' },
        { fileId: 'f2', relevanceScore: 0.2 },
        { fileId: 'f3', relevanceScore: 0.8 },
      ],
    };
    const gated = intentRagGate.rankSources(sources, intent);
    assert.ok(gated.gated);
    assert.ok(gated.sources.length >= 1);
    assert.ok(gated.sources.some((s) => s.fileId === 'f1'));
  });

  it('litellm task policy disables fallbacks for orchestrator', () => {
    const p = resolveTaskPolicy('agent.orchestrator');
    assert.equal(p.allow_fallbacks, false);
    assert.ok(p.preferred_models.length > 0);
  });

  it('artifact storage policy is lenient outside production', () => {
    const p = requireDurableArtifactStorage({ NODE_ENV: 'test' });
    assert.equal(p.ok, true);
  });

  it('research run store persists events', () => {
    const id = researchRunStore.createRunId('topic');
    researchRunStore.saveRun({ id, query: 'topic', status: 'running', events: [] });
    researchRunStore.appendEvent(id, { type: 'phase', phase: 'search' });
    const loaded = researchRunStore.loadRun(id);
    assert.equal(loaded.events.length, 1);
  });

  it('refresh token rotation validates versions', () => {
    const prev = process.env.SIRAGPT_REFRESH_TOKEN_ROTATION;
    process.env.SIRAGPT_REFRESH_TOKEN_ROTATION = '1';
    const issued = refreshRotation.issueRefreshPayload('user_x');
    assert.ok(issued.familyId);
    const ok = refreshRotation.validateRefresh(issued.familyId, issued.version);
    assert.equal(ok.ok, true);
    const bad = refreshRotation.validateRefresh(issued.familyId, issued.version);
    assert.equal(bad.ok, false);
    process.env.SIRAGPT_REFRESH_TOKEN_ROTATION = prev;
  });
});
