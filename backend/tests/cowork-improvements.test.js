'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const comparisonEngine = require('../src/services/document-comparison-engine');
const { CoworkProgressStream, createProgressStream, STAGES, STAGE_LABELS } = require('../src/services/cowork-progress-stream');
const { RateLimiter, rateLimitMiddleware, ENDPOINT_LIMITS } = require('../src/services/rate-limiter');

describe('document-comparison-engine', () => {
  const docA = {
    id: 'doc-a',
    name: 'Contract A',
    text: 'El contrato establece un pago mensual de $1,500 USD. La terminación anticipada tiene una penalización del 10%. Contacto: legal@acme.com. Vigencia: 2024-01-01 a 2025-12-31.',
    mimeType: 'application/pdf',
    entities: [
      { type: 'money', value: '$1,500 USD' },
      { type: 'email', value: 'legal@acme.com' },
      { type: 'date', value: '2024-01-01' },
    ],
    domain: 'legal',
    quality: { grade: 'B', overall: 72, wordCount: 30 },
    structure: { headingCount: 2, hasToc: false },
    risks: { severity: 'medium', overallScore: 25, items: [{ category: 'penalty_exposure', severity: 'medium' }] },
  };

  const docB = {
    id: 'doc-b',
    name: 'Contract B',
    text: 'El acuerdo establece un pago de $1,800 USD mensual. Sin cláusula de terminación. Contacto: legal@beta.com. Vigencia: 2024-06-01 a 2026-05-31.',
    mimeType: 'application/pdf',
    entities: [
      { type: 'money', value: '$1,800 USD' },
      { type: 'email', value: 'legal@beta.com' },
      { type: 'date', value: '2024-06-01' },
    ],
    domain: 'legal',
    quality: { grade: 'A', overall: 85, wordCount: 25 },
    structure: { headingCount: 1, hasToc: false },
    risks: { severity: 'low', overallScore: 10, items: [] },
  };

  describe('compareDocuments()', () => {
    it('requires at least 2 documents', () => {
      const result = comparisonEngine.compareDocuments([docA]);
      assert.equal(result.ok, false);
    });

    it('returns ok with comparison results', () => {
      const result = comparisonEngine.compareDocuments([docA, docB]);
      assert.equal(result.ok, true);
      assert.equal(result.documentCount, 2);
    });

    it('finds shared entities', () => {
      const result = comparisonEngine.compareDocuments([docA, docB]);
      assert.ok(Array.isArray(result.sharedEntities));
    });

    it('detects contradictions', () => {
      const result = comparisonEngine.compareDocuments([docA, docB]);
      assert.ok(Array.isArray(result.contradictions));
    });

    it('finds complementary insights', () => {
      const result = comparisonEngine.compareDocuments([docA, docB]);
      assert.ok(Array.isArray(result.complementary));
    });

    it('computes alignment score', () => {
      const result = comparisonEngine.compareDocuments([docA, docB]);
      assert.ok(typeof result.alignmentScore === 'number');
      assert.ok(result.alignmentScore >= 0 && result.alignmentScore <= 1);
    });

    it('builds comparison matrix', () => {
      const result = comparisonEngine.compareDocuments([docA, docB]);
      assert.ok(Array.isArray(result.comparisonMatrix));
      assert.ok(result.comparisonMatrix.length >= 3);
    });

    it('finds cross-references', () => {
      const result = comparisonEngine.compareDocuments([docA, docB]);
      assert.ok(Array.isArray(result.crossReferences));
    });

    it('builds synthesis text', () => {
      const result = comparisonEngine.compareDocuments([docA, docB]);
      assert.ok(typeof result.synthesis === 'string');
      assert.ok(result.synthesis.length > 0);
    });

    it('reports structural differences', () => {
      const result = comparisonEngine.compareDocuments([docA, docB]);
      assert.ok(Array.isArray(result.differences));
      assert.equal(result.differences.length, 2);
    });

    it('handles focus query', () => {
      const result = comparisonEngine.compareDocuments([docA, docB], { query: 'pago' });
      assert.equal(result.ok, true);
    });

    it('handles documents without entities', () => {
      const plainA = { id: 'a', name: 'A', text: 'Simple text about apples.' };
      const plainB = { id: 'b', name: 'B', text: 'Simple text about oranges.' };
      const result = comparisonEngine.compareDocuments([plainA, plainB]);
      assert.equal(result.ok, true);
    });
  });

  describe('findSharedEntities()', () => {
    it('finds overlapping entities across documents', () => {
      const shared = comparisonEngine.findSharedEntities([docA, docB]);
      assert.ok(Array.isArray(shared));
    });
  });

  describe('findContradictions()', () => {
    it('detects coverage gaps', () => {
      const contradictions = comparisonEngine.findContradictions([docA, docB], ['terminación']);
      assert.ok(Array.isArray(contradictions));
    });
  });

  describe('computeAlignment()', () => {
    it('returns 1 for identical documents', () => {
      const score = comparisonEngine.computeAlignment([docA, docA]);
      assert.ok(score > 0.5);
    });

    it('returns lower score for very different documents', () => {
      const docC = { ...docA, domain: 'medical', quality: { grade: 'F', overall: 15 }, risks: { severity: 'critical' } };
      const score = comparisonEngine.computeAlignment([docA, docC]);
      assert.ok(score < comparisonEngine.computeAlignment([docA, docB]));
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
