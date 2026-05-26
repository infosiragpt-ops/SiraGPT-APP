/**
 * express-instrumentation.js
 *
 * Automatic Express instrumentation for observability:
 * - Request/response timing
 * - Error tracking
 * - Request correlation IDs
 * - Performance metrics
 */

const crypto = require('crypto');

class ExpressInstrumentation {
  constructor(opts = {}) {
    this.opts = {
      enableCorrelationId: opts.enableCorrelationId !== false,
      enableRequestTiming: opts.enableRequestTiming !== false,
      enableErrorTracking: opts.enableErrorTracking !== false,
      correlationIdHeader: opts.correlationIdHeader || 'x-request-id',
      slowRequestMs: opts.slowRequestMs || 1000,
      ...opts,
    };

    this.metrics = {
      requestsTotal: 0,
      requestsSuccess: 0,
      requestsError: 0,
      totalLatencyMs: [],
      errorsByStatus: {},
    };
  }

  /**
   * Express middleware to add instrumentation
   */
  middleware() {
    return (req, res, next) => {
      // Generate or propagate correlation ID
      if (this.opts.enableCorrelationId) {
        const headerId = this.opts.correlationIdHeader.toLowerCase();
        req.correlationId =
          req.get(headerId) || `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
        res.setHeader(this.opts.correlationIdHeader, req.correlationId);
      }

      // Start timing
      if (this.opts.enableRequestTiming) {
        req.startTime = Date.now();
      }

      // Override res.json and res.send to track completion
      const originalJson = res.json.bind(res);
      const originalSend = res.send.bind(res);

      res.json = function (data) {
        this.recordMetrics(req, res, data);
        return originalJson(data);
      };

      res.send = function (data) {
        this.recordMetrics(req, res, data);
        return originalSend(data);
      };

      next();
    };
  }

  /**
   * Record request metrics
   */
  recordMetrics(req, res, data) {
    const inst = this;
    this.metrics.requestsTotal++;

    if (this.opts.enableRequestTiming) {
      const elapsed = Date.now() - req.startTime;
      this.metrics.totalLatencyMs.push(elapsed);

      if (elapsed > this.opts.slowRequestMs) {
        console.warn(`[SLOW] ${req.method} ${req.path} took ${elapsed}ms`);
      }
    }

    if (res.statusCode >= 400) {
      this.metrics.requestsError++;
      this.metrics.errorsByStatus[res.statusCode] = (this.metrics.errorsByStatus[res.statusCode] || 0) + 1;
    } else {
      this.metrics.requestsSuccess++;
    }
  }

  /**
   * Error handler middleware
   */
  errorHandler() {
    return (err, req, res, next) => {
      if (this.opts.enableErrorTracking) {
        console.error(`[ERROR] ${req.correlationId || 'no-id'} ${err.message}`);
        this.metrics.requestsError++;
      }

      res.status(err.status || 500).json({
        error: err.message,
        correlationId: req.correlationId,
      });
    };
  }

  /**
   * Get metrics snapshot
   */
  getMetrics() {
    const latencies = this.metrics.totalLatencyMs;
    const sorted = [...latencies].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)] || 0;
    const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
    const p99 = sorted[Math.floor(sorted.length * 0.99)] || 0;

    return {
      requestsTotal: this.metrics.requestsTotal,
      requestsSuccess: this.metrics.requestsSuccess,
      requestsError: this.metrics.requestsError,
      errorsByStatus: this.metrics.errorsByStatus,
      latency: {
        p50,
        p95,
        p99,
        avg: latencies.length > 0 ? latencies.reduce((a, b) => a + b) / latencies.length : 0,
      },
    };
  }

  /**
   * Reset metrics
   */
  reset() {
    this.metrics = {
      requestsTotal: 0,
      requestsSuccess: 0,
      requestsError: 0,
      totalLatencyMs: [],
      errorsByStatus: {},
    };
  }
}

module.exports = ExpressInstrumentation;
