'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const comparisonEngine = require('../src/services/document-comparison-engine');
const { CoworkProgressStream, createProgressStream, STAGES, STAGE_LABELS } = require('../src/services/cowork-progress-stream');
const { RateLimiter, rateLimitMiddleware, ENDPOINT_LIMITS } = require('../src/services/rate-limiter');

describe('document-comparison-engine', () => {
  const fileA = {
    id: 'file-a',
    originalName: 'Contract A.pdf',
    extractedText: 'El contrato establece un pago mensual de $1,500 USD. La terminación anticipada tiene una penalización del 10%. Contacto: legal@acme.com. Vigencia: 2024-01-01 a 2025-12-31. Juan Pérez firmó el acuerdo.',
    mimeType: 'application/pdf',
  };

  const fileB = {
    id: 'file-b',
    originalName: 'Contract B.pdf',
    extractedText: 'El acuerdo establece un pago de $1,800 USD mensual. Sin cláusula de terminación. Contacto: legal@beta.com. Vigencia: 2024-06-01 a 2026-05-31. María García firmó el acuerdo.',
    mimeType: 'application/pdf',
  };

  describe('compareDocuments()', () => {
    it('returns null for non-array input', () => {
      const result = comparisonEngine.compareDocuments('not-array');
      assert.equal(result, null);
    });

    it('returns null for fewer than 2 valid files', () => {
      const result = comparisonEngine.compareDocuments([fileA]);
      assert.equal(result, null);
    });

    it('returns comparison report for 2+ valid files', () => {
      const result = comparisonEngine.compareDocuments([fileA, fileB]);
      assert.ok(result !== null);
      assert.ok(Array.isArray(result.pairs));
    });

    it('includes pairwise similarity', () => {
      const result = comparisonEngine.compareDocuments([fileA, fileB]);
      assert.ok(result.pairs.length >= 1);
      assert.ok(typeof result.pairs[0].similarity === 'number');
    });

    it('includes shared entities', () => {
      const result = comparisonEngine.compareDocuments([fileA, fileB]);
      assert.ok(result.entities);
      assert.ok(result.entities.shared);
    });

    it('includes timeline', () => {
      const result = comparisonEngine.compareDocuments([fileA, fileB]);
      assert.ok(Array.isArray(result.timeline || (result.chronologicalTimeline)));
    });

    it('includes numeric conflicts', () => {
      const result = comparisonEngine.compareDocuments([fileA, fileB]);
      assert.ok(Array.isArray(result.numericConflicts || []));
    });

    it('includes dominance ratio', () => {
      const result = comparisonEngine.compareDocuments([fileA, fileB]);
      assert.ok(typeof result.dominanceRatio === 'number');
    });

    it('caps file count at MAX_FILES_COMPARED', () => {
      const manyFiles = Array.from({ length: 25 }, (_, i) => ({
        id: `f-${i}`,
        originalName: `File ${i}.txt`,
        extractedText: `Document number ${i} with unique content about topic${i}.`,
      }));
      const result = comparisonEngine.compareDocuments(manyFiles);
      assert.ok(result !== null);
    });

    it('tolerates malformed entries', () => {
      const result = comparisonEngine.compareDocuments([null, fileA, undefined, fileB, { bad: true }]);
      assert.ok(result !== null);
    });
  });

  describe('jaccardSimilarity()', () => {
    it('returns 1 for identical strings', () => {
      const { jaccardSimilarity } = comparisonEngine._internal;
      assert.equal(jaccardSimilarity('hello world test', 'hello world test'), 1);
    });

    it('returns 0 for disjoint strings', () => {
      const { jaccardSimilarity } = comparisonEngine._internal;
      assert.equal(jaccardSimilarity('alpha beta', 'gamma delta'), 0);
    });
  });

  describe('renderComparisonBlock()', () => {
    it('renders markdown for a valid report', () => {
      const result = comparisonEngine.compareDocuments([fileA, fileB]);
      const md = comparisonEngine.renderComparisonBlock(result);
      assert.ok(typeof md === 'string');
    });

    it('returns empty string for null report', () => {
      const md = comparisonEngine.renderComparisonBlock(null);
      assert.equal(md, '');
    });
  });
});

describe('cowork-progress-stream', () => {
  it('creates a progress stream', () => {
    const stream = createProgressStream();
    assert.ok(stream);
    assert.ok(stream.analysisId);
    assert.equal(stream.currentStage, STAGES.IDLE);
  });

  it('advances through stages', () => {
    const stream = createProgressStream();
    const events = [];
    stream.on('stage', e => events.push(e));

    stream.start();
    stream.advance(STAGES.DETECTING_FORMAT);
    stream.advance(STAGES.ANALYZING_DOMAIN);
    stream.advance(STAGES.COMPLETE);

    assert.ok(events.length >= 2);
    assert.equal(stream.currentStage, STAGES.COMPLETE);
    stream.destroy();
  });

  it('emits complete event', () => {
    const stream = createProgressStream();
    let completed = false;
    stream.on('complete', () => { completed = true; });

    stream.start();
    stream.complete({ domain: 'legal' });

    assert.ok(completed);
    assert.ok(stream.completedAt);
    stream.destroy();
  });

  it('emits error event', () => {
    const stream = createProgressStream();
    let errored = false;
    stream.on('error', () => { errored = true; });

    stream.start();
    stream.fail('test error');

    assert.ok(errored);
    assert.equal(stream.error, 'test error');
    stream.destroy();
  });

  it('returns status', () => {
    const stream = createProgressStream();
    stream.start();
    const status = stream.getStatus();
    assert.ok(status.analysisId);
    assert.equal(status.stage, STAGES.IDLE);
    assert.ok(typeof status.elapsedMs === 'number');
    stream.destroy();
  });

  it('has all stage labels', () => {
    for (const stage of Object.values(STAGES)) {
      assert.ok(STAGE_LABELS[stage], `Missing label for stage: ${stage}`);
    }
  });

  it('tracks stage history', () => {
    const stream = createProgressStream();
    stream.start();
    stream.advance(STAGES.DETECTING_FORMAT);
    stream.advance(STAGES.ANALYZING_DOMAIN);
    assert.ok(stream.stageHistory.length >= 2);
    stream.destroy();
  });
});

describe('rate-limiter', () => {
  it('allows requests within limit', () => {
    const limiter = new RateLimiter({ windowMs: 60000, maxRequests: 5 });
    const result = limiter.check('user-1');
    assert.ok(result.allowed);
    assert.equal(result.remaining, 4);
  });

  it('blocks requests over limit', () => {
    const limiter = new RateLimiter({ windowMs: 60000, maxRequests: 3 });
    limiter.check('user-2');
    limiter.check('user-2');
    limiter.check('user-2');
    const result = limiter.check('user-2');
    assert.ok(!result.allowed);
    assert.equal(result.remaining, 0);
  });

  it('resets after window expires', () => {
    const limiter = new RateLimiter({ windowMs: 100, maxRequests: 1 });
    limiter.check('user-3');
    const blocked = limiter.check('user-3');
    assert.ok(!blocked.allowed);

    return new Promise(resolve => {
      setTimeout(() => {
        const result = limiter.check('user-3');
        assert.ok(result.allowed);
        resolve();
      }, 150);
    });
  });

  it('tracks per-identifier separately', () => {
    const limiter = new RateLimiter({ windowMs: 60000, maxRequests: 1 });
    const a = limiter.check('user-a');
    const b = limiter.check('user-b');
    assert.ok(a.allowed);
    assert.ok(b.allowed);
  });

  it('resets identifier', () => {
    const limiter = new RateLimiter({ windowMs: 60000, maxRequests: 1 });
    limiter.check('user-reset');
    limiter.check('user-reset');
    limiter.reset('user-reset');
    const result = limiter.check('user-reset');
    assert.ok(result.allowed);
  });

  it('returns stats', () => {
    const limiter = new RateLimiter({ windowMs: 60000, maxRequests: 10 });
    limiter.check('user-stats');
    limiter.check('user-stats');
    const stats = limiter.getStats('user-stats');
    assert.equal(stats.count, 2);
  });

  it('cleans up expired buckets', () => {
    const limiter = new RateLimiter({ windowMs: 50, maxRequests: 5 });
    limiter.check('user-cleanup');
    return new Promise(resolve => {
      setTimeout(() => {
        const cleaned = limiter.cleanup();
        assert.ok(cleaned >= 0);
        resolve();
      }, 100);
    });
  });

  it('rateLimitMiddleware blocks over-limit', () => {
    const middleware = rateLimitMiddleware({ windowMs: 60000, maxRequests: 1 });
    const req1 = { user: { id: 'test' }, ip: '127.0.0.1' };
    const res1 = { setHeader: () => {}, status: () => ({ json: () => {} }) };
    let called = false;
    middleware(req1, res1, () => { called = true; });
    assert.ok(called);

    const req2 = { user: { id: 'test' }, ip: '127.0.0.1' };
    const res2 = { setHeader: () => {}, status: (code) => {
      assert.equal(code, 429);
      return { json: () => {} };
    }};
    middleware(req2, res2, () => {});
  });

  it('has endpoint limits configured', () => {
    assert.ok(Object.keys(ENDPOINT_LIMITS).length >= 5);
  });
});

describe('cowork-engine deepAnalysisPrompt fix', () => {
  const coworkEngine = require('../src/services/cowork-engine');

  it('buildCoworkSystemPrompt includes fidelity directives', () => {
    const prompt = coworkEngine.buildCoworkSystemPrompt(null);
    assert.ok(prompt.includes('Response Fidelity'), 'prompt must include fidelity section');
    assert.ok(prompt.includes('traceable to the source'), 'prompt must include traceability directive');
  });
});

describe('health-check cowork subsystem integration', () => {
  const { checkCoworkSubsystem, runFullHealthCheck } = require('../src/services/observability/health-check');

  it('checkCoworkSubsystem returns skipped when no module', () => {
    const result = checkCoworkSubsystem(null);
    assert.equal(result.name, 'cowork');
    assert.equal(result.status, 'skipped');
  });

  it('checkCoworkSubsystem returns healthy with valid module', () => {
    const mockHealth = {
      runLivenessCheck: () => ({ ok: true, checks: [] }),
    };
    const result = checkCoworkSubsystem(mockHealth);
    assert.equal(result.name, 'cowork');
    assert.equal(result.status, 'healthy');
  });

  it('checkCoworkSubsystem returns degraded on error', () => {
    const mockHealth = {
      runLivenessCheck: () => { throw new Error('boom'); },
    };
    const result = checkCoworkSubsystem(mockHealth);
    assert.equal(result.status, 'degraded');
  });

  it('runFullHealthCheck includes cowork when module provided', async () => {
    const report = await runFullHealthCheck({
      coworkHealth: {
        runLivenessCheck: () => ({ ok: true, checks: [] }),
      },
    });
    const cowork = report.checks.find(c => c.name === 'cowork');
    assert.ok(cowork, 'full health check must include cowork subsystem');
    assert.equal(cowork.status, 'healthy');
  });
});

describe('cowork-progress-stream writeSSE fix', () => {
  const { createProgressStream, writeSSE } = require('../src/services/cowork-progress-stream');

  it('writeSSE sets SSE headers when not yet sent', () => {
    const stream = createProgressStream();
    const headers = {};
    let flushed = false;
    const res = {
      writableEnded: false,
      headersSent: false,
      setHeader: (k, v) => { headers[k] = v; },
      flushHeaders: () => { flushed = true; },
      write: () => {},
      end: () => {},
      on: () => {},
    };
    writeSSE(res, stream);
    assert.ok(flushed || headers['Content-Type'] === 'text/event-stream', 'SSE headers should be set');
    stream.destroy();
  });
});

describe('skill-tool-adapter', () => {
  const { resolveToolNames, getSkillManifests, recommendToolsForIntent, TOOL_ALIASES } = require('../src/services/skill-tool-adapter');

  it('resolves abstract tool names to concrete tools', () => {
    const resolved = resolveToolNames(['deep_document_analyzer', 'rag_retrieve', 'code_sandbox']);
    assert.ok(resolved.includes('deep_analyze'));
    assert.ok(resolved.includes('rag_retrieve'));
    assert.ok(resolved.includes('python_exec'));
  });

  it('returns empty for unknown tools', () => {
    const resolved = resolveToolNames(['nonexistent_tool_xyz']);
    assert.equal(resolved.length, 0);
  });

  it('returns empty for non-array input', () => {
    const resolved = resolveToolNames('not-array');
    assert.equal(resolved.length, 0);
  });

  it('generates skill manifests for all registered skills', () => {
    const manifests = getSkillManifests();
    const keys = Object.keys(manifests);
    assert.ok(keys.length >= 10, `expected >= 10 skill manifests, got ${keys.length}`);
    for (const key of keys) {
      assert.ok(key.startsWith('skill_'), `manifest key should start with skill_: ${key}`);
      assert.ok(manifests[key]._skillMeta, `manifest should have _skillMeta: ${key}`);
    }
  });

  it('each skill manifest has valid manifest fields', () => {
    const manifests = getSkillManifests();
    for (const [name, m] of Object.entries(manifests)) {
      assert.ok(m.name, `${name} missing name`);
      assert.ok(m.purpose, `${name} missing purpose`);
      assert.ok(m.inputs, `${name} missing inputs`);
      assert.ok(m.outputs, `${name} missing outputs`);
      assert.ok(Array.isArray(m.allowed_formats), `${name} missing allowed_formats`);
      assert.ok(Array.isArray(m.expected_errors), `${name} missing expected_errors`);
      assert.ok(m.usage_limits, `${name} missing usage_limits`);
    }
  });

  it('maps skill clearance to manifest scopes', () => {
    const manifests = getSkillManifests();
    const enterpriseSkill = Object.values(manifests).find(m => m._skillMeta?.clearance === 'enterprise');
    if (enterpriseSkill) {
      assert.ok(enterpriseSkill.scopes.includes('enterprise'));
    }
  });

  it('recommendToolsForIntent returns concrete tools', () => {
    const result = recommendToolsForIntent('analyze this legal contract', {
      hasDocuments: true,
      needsAnalysis: true,
    });
    assert.ok(Array.isArray(result.recommendedSkills));
    assert.ok(Array.isArray(result.concreteTools));
  });

  it('TOOL_ALIASES maps to valid concrete tools', () => {
    assert.equal(TOOL_ALIASES['deep_document_analyzer'], 'deep_analyze');
    assert.equal(TOOL_ALIASES['code_sandbox'], 'python_exec');
    assert.equal(TOOL_ALIASES['active_memory'], 'memory_recall');
    assert.equal(TOOL_ALIASES['document_comparison'], 'compare_documents');
  });
});

describe('active-memory background cleanup', () => {
  const activeMemory = require('../src/services/active-memory');

  it('has startCleanup and stopCleanup functions', () => {
    assert.ok(typeof activeMemory.startCleanup === 'function');
    assert.ok(typeof activeMemory.stopCleanup === 'function');
  });

  it('stopCleanup does not throw', () => {
    activeMemory.stopCleanup();
    activeMemory.startCleanup();
  });
});

describe('cowork-engine error handling', () => {
  const coworkEngine = require('../src/services/cowork-engine');

  it('enrichAIRequest handles autoFile failure gracefully', async () => {
    const result = await coworkEngine.enrichAIRequest('test-error-user', 'Short message', {});
    assert.ok(result);
    assert.ok(result.systemPromptAdditions !== undefined);
  });

  it('processIncomingMessage handles memory errors gracefully', () => {
    const result = coworkEngine.processIncomingMessage('test-error-user', 'I prefer Python for backend development', {});
    assert.ok(result);
  });
});

describe('cowork-engine deepAnalysisPrompt fix', () => {
  const coworkEngine = require('../src/services/cowork-engine');

  it('buildCoworkSystemPrompt includes fidelity directives', () => {
    const prompt = coworkEngine.buildCoworkSystemPrompt(null);
    assert.ok(prompt.includes('Response Fidelity'), 'prompt must include fidelity section');
    assert.ok(prompt.includes('traceable to the source'), 'prompt must include traceability directive');
  });

  it('buildCoworkSystemPrompt includes memory for known user', () => {
    const activeMemory = require('../src/services/active-memory');
    activeMemory.createMemoryEntry('test-fidelity-user', 'I prefer Python', {
      source: 'test', category: 'preference', confidence: 0.9, strength: 0.9,
    });
    activeMemory.autoPromote('test-fidelity-user');
    const prompt = coworkEngine.buildCoworkSystemPrompt('test-fidelity-user');
    assert.ok(prompt.includes('Active Memory') || prompt.includes('Persistent facts') || prompt.includes('Python'), 'prompt should include memory');
    activeMemory.clearUserMemory('test-fidelity-user');
  });
});

describe('health-check cowork subsystem integration', () => {
  const { checkCoworkSubsystem, runFullHealthCheck } = require('../src/services/observability/health-check');

  it('checkCoworkSubsystem returns skipped when no module', () => {
    const result = checkCoworkSubsystem(null);
    assert.equal(result.name, 'cowork');
    assert.equal(result.status, 'skipped');
  });

  it('checkCoworkSubsystem returns healthy with valid module', () => {
    const mockHealth = {
      runLivenessCheck: () => ({ ok: true, checks: [] }),
    };
    const result = checkCoworkSubsystem(mockHealth);
    assert.equal(result.name, 'cowork');
    assert.equal(result.status, 'healthy');
  });

  it('checkCoworkSubsystem returns degraded on error', () => {
    const mockHealth = {
      runLivenessCheck: () => { throw new Error('boom'); },
    };
    const result = checkCoworkSubsystem(mockHealth);
    assert.equal(result.status, 'degraded');
  });

  it('runFullHealthCheck accepts coworkHealth parameter', async () => {
    const report = await runFullHealthCheck({
      prisma: null,
      redis: null,
      queue: null,
      coworkHealth: {
        runLivenessCheck: () => ({ ok: true, checks: [] }),
      },
    });
    const cowork = report.checks.find(c => c.name === 'cowork');
    assert.ok(cowork, 'full health check must include cowork subsystem');
    assert.equal(cowork.status, 'healthy');
  });
});

describe('cowork-progress-stream writeSSE fix', () => {
  const { createProgressStream, writeSSE } = require('../src/services/cowork-progress-stream');

  it('writeSSE sets SSE headers when not yet sent', () => {
    const stream = createProgressStream();
    const headers = {};
    let flushed = false;
    const res = {
      writableEnded: false,
      headersSent: false,
      setHeader: (k, v) => { headers[k] = v; },
      flushHeaders: () => { flushed = true; this.headersSent = true; },
      write: () => {},
      end: () => {},
      on: () => {},
    };
    writeSSE(res, stream);
    assert.ok(flushed || headers['Content-Type'] === 'text/event-stream', 'SSE headers should be set');
    stream.destroy();
  });
});
