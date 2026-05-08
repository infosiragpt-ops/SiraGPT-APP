'use strict';

/**
 * Cache metrics — counters + p50/p95 lookup latency tracker.
 *
 * Internal implementation (no prom-client dep). Exposes a snapshot()
 * method that returns a flat object usable by /metrics endpoints, plus
 * a toPromText() formatter for prom-style scraping if needed.
 *
 * Latency is sampled into a fixed-size reservoir (1024 entries) — keeps
 * memory bounded under load and approximates the true distribution well
 * enough for hit-path SLOs.
 */

const RESERVOIR_SIZE = 1024;

class CacheMetrics {
  constructor() {
    this._reset();
  }

  _reset() {
    this.l1Hits = 0;
    this.l2Hits = 0;
    this.semanticHits = 0;
    this.misses = 0;
    this.l1Evictions = 0;
    this.l2Errors = 0;
    this.bypasses = 0;
    this.sets = 0;
    this._lat = []; // microseconds
    this._latIdx = 0;
    // Per-policy hit/miss counters (cache_hit_ratio_by_policy). Policies
    // appear lazily — anything observed via record*ByPolicy creates a slot.
    this._byPolicy = Object.create(null);
  }

  _policySlot(policy) {
    const key = typeof policy === 'string' && policy.length > 0 ? policy : 'unknown';
    if (!this._byPolicy[key]) {
      this._byPolicy[key] = { hits: 0, misses: 0 };
    }
    return this._byPolicy[key];
  }

  recordHitByPolicy(policy) { this._policySlot(policy).hits += 1; }
  recordMissByPolicy(policy) { this._policySlot(policy).misses += 1; }

  hitRatioByPolicy() {
    const out = {};
    for (const [policy, c] of Object.entries(this._byPolicy)) {
      const total = c.hits + c.misses;
      out[policy] = total === 0 ? 0 : c.hits / total;
    }
    return out;
  }

  recordL1Hit() { this.l1Hits += 1; }
  recordL2Hit() { this.l2Hits += 1; }
  recordSemanticHit() { this.semanticHits += 1; }
  recordMiss() { this.misses += 1; }
  recordL1Eviction() { this.l1Evictions += 1; }
  recordL2Error() { this.l2Errors += 1; }
  recordBypass() { this.bypasses += 1; }
  recordSet() { this.sets += 1; }

  recordLookupLatency(microseconds) {
    if (!Number.isFinite(microseconds) || microseconds < 0) return;
    if (this._lat.length < RESERVOIR_SIZE) {
      this._lat.push(microseconds);
      return;
    }
    // Reservoir sampling: replace random slot to keep distribution.
    const idx = Math.floor(Math.random() * (this._latIdx + 1));
    this._latIdx += 1;
    if (idx < RESERVOIR_SIZE) this._lat[idx] = microseconds;
  }

  _percentile(p) {
    if (this._lat.length === 0) return 0;
    const sorted = this._lat.slice().sort((a, b) => a - b);
    const rank = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[rank];
  }

  hitRatio() {
    const hits = this.l1Hits + this.l2Hits + this.semanticHits;
    const total = hits + this.misses;
    return total === 0 ? 0 : hits / total;
  }

  snapshot() {
    return {
      l1_hits: this.l1Hits,
      l2_hits: this.l2Hits,
      semantic_hits: this.semanticHits,
      misses: this.misses,
      hit_ratio: this.hitRatio(),
      l1_evictions: this.l1Evictions,
      l2_errors: this.l2Errors,
      bypasses: this.bypasses,
      sets: this.sets,
      lookup_p50_us: this._percentile(50),
      lookup_p95_us: this._percentile(95),
      lookup_samples: this._lat.length,
      cache_hit_ratio_by_policy: this.hitRatioByPolicy(),
      cache_counts_by_policy: Object.fromEntries(
        Object.entries(this._byPolicy).map(([p, c]) => [p, { hits: c.hits, misses: c.misses }]),
      ),
    };
  }

  toPromText(name = 'sira_cache') {
    const s = this.snapshot();
    const lines = [
      `# HELP ${name}_hits_total Cache hits by tier`,
      `# TYPE ${name}_hits_total counter`,
      `${name}_hits_total{tier="l1"} ${s.l1_hits}`,
      `${name}_hits_total{tier="l2"} ${s.l2_hits}`,
      `${name}_hits_total{tier="semantic"} ${s.semantic_hits}`,
      `# HELP ${name}_misses_total Cache misses`,
      `# TYPE ${name}_misses_total counter`,
      `${name}_misses_total ${s.misses}`,
      `# HELP ${name}_evictions_total L1 evictions`,
      `# TYPE ${name}_evictions_total counter`,
      `${name}_evictions_total ${s.l1_evictions}`,
      `# HELP ${name}_l2_errors_total L2 store errors`,
      `# TYPE ${name}_l2_errors_total counter`,
      `${name}_l2_errors_total ${s.l2_errors}`,
      `# HELP ${name}_bypasses_total Cache lookups skipped by policy`,
      `# TYPE ${name}_bypasses_total counter`,
      `${name}_bypasses_total ${s.bypasses}`,
      `# HELP ${name}_lookup_microseconds Lookup latency`,
      `# TYPE ${name}_lookup_microseconds summary`,
      `${name}_lookup_microseconds{quantile="0.5"} ${s.lookup_p50_us}`,
      `${name}_lookup_microseconds{quantile="0.95"} ${s.lookup_p95_us}`,
    ];
    const policyRatios = s.cache_hit_ratio_by_policy || {};
    const policyKeys = Object.keys(policyRatios);
    if (policyKeys.length > 0) {
      lines.push(
        `# HELP ${name}_hit_ratio_by_policy Hit ratio per eviction policy`,
        `# TYPE ${name}_hit_ratio_by_policy gauge`,
      );
      for (const p of policyKeys) {
        lines.push(`${name}_hit_ratio_by_policy{policy="${p}"} ${policyRatios[p]}`);
      }
    }
    return lines.join('\n');
  }

  reset() { this._reset(); }
}

module.exports = { CacheMetrics };
