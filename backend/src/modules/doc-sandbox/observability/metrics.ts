import type { StoredDocumentJob } from '../queue/repository';

export interface MetricsRegistry {
  registerCounter(name: string, options: { help: string; labels: string[] }): void;
  registerGauge(name: string, options: { help: string; labels: string[] }): void;
  registerHistogram(name: string, options: { help: string; labels: string[]; buckets: number[] }): void;
  counter(name: string, labels: Record<string, string>, delta?: number): void;
  gauge(name: string, labels: Record<string, string>, value: number): void;
  observe(name: string, labels: Record<string, string>, value: number): void;
}
/** Operational aggregates only. Postgres, not Prometheus, is the cost ledger. */
export class DocumentMetrics {
  constructor(private readonly metrics: MetricsRegistry) {
    metrics.registerCounter('siragpt_doc_attempts_total', { help: 'Document attempts observed by workers', labels: ['status'] });
    metrics.registerCounter('siragpt_doc_jobs_total', { help: 'Document terminal transitions observed by workers', labels: ['status'] });
    metrics.registerCounter('siragpt_doc_timeouts_total', { help: 'Document job timeouts', labels: [] });
    metrics.registerCounter('siragpt_doc_rollbacks_total', { help: 'Document validation retries from pristine input', labels: [] });
    metrics.registerCounter('siragpt_doc_validation_total', { help: 'Executed independent validation levels', labels: ['level', 'passed'] });
    metrics.registerHistogram('siragpt_doc_phase_seconds', { help: 'Observed document phase duration', labels: ['phase'], buckets: [1, 5, 10, 30, 60, 120, 300, 600] });
    metrics.registerHistogram('siragpt_doc_job_seconds', { help: 'End to end duration of observed completed jobs', labels: ['status'], buckets: [5, 15, 30, 60, 120, 300, 600, 1800, 3600] });
    metrics.registerHistogram('siragpt_doc_cost_usd', { help: 'Recorded job cost, may be estimated or incomplete; DB ledger is authoritative', labels: ['status'], buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 100] });
    metrics.registerGauge('siragpt_doc_worker_active', { help: 'Active document workers in this process', labels: [] });
  }
  active(count: number): void { this.metrics.gauge('siragpt_doc_worker_active', {}, count); }
  phase(phase: 'inspecting' | 'planning' | 'editing' | 'validating', seconds: number): void {
    this.metrics.observe('siragpt_doc_phase_seconds', { phase }, seconds);
  }
  validation(level: number, passed: boolean, applicable: boolean): void {
    if (!applicable || !Number.isInteger(level) || level < 1 || level > 4) return;
    this.metrics.counter('siragpt_doc_validation_total', { level: String(level), passed: String(passed) });
  }
  completed(before: StoredDocumentJob, after: StoredDocumentJob): void {
    if (after.attempts <= before.attempts) return;
    const status = ['queued', 'done', 'failed', 'cancelled'].includes(after.status) ? after.status : 'interrupted';
    this.metrics.counter('siragpt_doc_attempts_total', { status });
    if (after.status === 'queued' && after.errorCode === 'E_VALIDATION') this.metrics.counter('siragpt_doc_rollbacks_total', {});
    if (after.errorCode === 'E_TIMEOUT') this.metrics.counter('siragpt_doc_timeouts_total', {});
    if (!['done', 'failed', 'cancelled'].includes(after.status)) return;
    this.metrics.counter('siragpt_doc_jobs_total', { status });
    if (after.finishedAt) this.metrics.observe('siragpt_doc_job_seconds', { status }, Math.max(0, (after.finishedAt.getTime() - after.createdAt.getTime()) / 1000));
    if (after.usage.costUsd !== null && !after.costReservations.some((item) => item.actualUsd === null)) {
      this.metrics.observe('siragpt_doc_cost_usd', { status }, Number(after.costUsd));
    }
  }
}
