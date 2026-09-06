import test from 'node:test';
import assert from 'node:assert/strict';
import { DocumentMetrics } from '../src/modules/doc-sandbox/observability/metrics';
import type { StoredDocumentJob } from '../src/modules/doc-sandbox/queue/repository';
// Exercise the real backend registry; no mocked validator, provider or exporter.
const registry = require('../src/utils/metrics');
const metrics = new DocumentMetrics(registry);
function reset(): void {
  for (const [name, family] of registry.registry) if (name.startsWith('siragpt_doc_')) family.series.clear();
}
function values(name: string): number[] { return [...registry.registry.get(name).series.values()]; }
function snapshot(overrides: Partial<StoredDocumentJob> = {}): StoredDocumentJob {
  return { id: 'synthetic-job', userId: 'synthetic-user', status: 'queued', admissionReady: true,
    mode: 'preserve', engine: 'anthropic', modelTier: 'mechanical', instructionsKey: 'not-exported',
    requestedModel: 'fixture-mechanical', tokenBudget: 1000,
    inputKeys: [], outputKeys: [], editPlanKey: null, editPlanHash: null, validationReportKey: null,
    errorCode: null, usage: {}, costUsd: '0', maxCostUsd: '1', costReservations: [],
    purgedKeys: [], storageKeys: [], attempts: 0, fence: 0, leaseToken: null, leaseExpiresAt: null,
    eventSeq: 0, sessionRef: null, providerFiles: [], providerContainers: [], cleanupPending: false,
    cleanupNotBefore: null, parentJobId: null, promptVersion: 'fixture', createdAt: new Date(0),
    startedAt: null, finishedAt: null, expiresAt: new Date(600_000), deletedAt: null, ...overrides };
}
test('operational exporter records executed validations but not inapplicable levels', () => {
  reset(); metrics.validation(1, true, true); metrics.validation(3, false, false); metrics.validation(9, true, true);
  assert.deepEqual(values('siragpt_doc_validation_total'), [1]);
  assert.deepEqual(registry.registry.get('siragpt_doc_validation_total').labels, ['level', 'passed']);
});
test('no new attempt cannot duplicate observed terminal counters', () => {
  reset(); const before = snapshot({ attempts: 1 });
  metrics.completed(before, snapshot({ attempts: 1, status: 'done' }));
  assert.deepEqual(values('siragpt_doc_jobs_total'), []);
});
test('validation retry increments rollback but never terminal job counter', () => {
  reset(); metrics.completed(snapshot(), snapshot({ attempts: 1, status: 'queued', errorCode: 'E_VALIDATION' }));
  assert.deepEqual(values('siragpt_doc_rollbacks_total'), [1]);
  assert.deepEqual(values('siragpt_doc_jobs_total'), []);
});
test('timeout records a terminal failure without exposing unknown cost as zero', () => {
  reset(); metrics.completed(snapshot(), snapshot({ attempts: 1, status: 'failed', errorCode: 'E_TIMEOUT',
    usage: { costUsd: null }, finishedAt: new Date(5000) }));
  assert.deepEqual(values('siragpt_doc_jobs_total'), [1]);
  assert.deepEqual(values('siragpt_doc_timeouts_total'), [1]);
  assert.deepEqual(values('siragpt_doc_cost_usd'), []);
});
test('an unsettled reservation is excluded from cost histograms', () => {
  reset(); metrics.completed(snapshot(), snapshot({ attempts: 1, status: 'cancelled', costUsd: '0.2',
    costReservations: [{ requestId: 'request', attempt: 1, reservedUsd: '0.5', actualUsd: null }] }));
  assert.deepEqual(values('siragpt_doc_cost_usd'), []);
});
test('known cost and phase duration are recorded without tenant/job metric labels', () => {
  reset(); metrics.phase('validating', 2); metrics.active(1);
  metrics.completed(snapshot(), snapshot({ attempts: 1, status: 'done', costUsd: '0.2', finishedAt: new Date(10_000) }));
  assert.equal(registry.registry.get('siragpt_doc_cost_usd').series.values().next().value.sum, 0.2);
  for (const [name, family] of registry.registry) if (name.startsWith('siragpt_doc_')) {
    assert.ok(!family.labels.includes('userId') && !family.labels.includes('jobId'));
    assert.ok(!JSON.stringify([...family.series.keys()]).includes('synthetic'));
  }
});
