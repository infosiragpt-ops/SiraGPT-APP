/**
 * agent-resilience-hardening.js
 * 
 * Hardens SiraGPT agent system with resilience patterns from OpenClaw:
 * - Exponential backoff with jitter
 * - Circuit breaker for external calls
 * - Timeout guards with cleanup
 * - Resource pooling
 * - Observability hooks
 */

const EventEmitter = require('events');

class AgentResilienceManager extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = {
      maxRetries: opts.maxRetries || 3,
      initialBackoffMs: opts.initialBackoffMs || 100,
      maxBackoffMs: opts.maxBackoffMs || 30000,
      jitterFactor: opts.jitterFactor || 0.1,
      circuitBreakerThreshold: opts.circuitBreakerThreshold || 5,
      circuitBreakerResetMs: opts.circuitBreakerResetMs || 60000,
      requestTimeoutMs: opts.requestTimeoutMs || 30000,
      ...opts,
    };

    this.circuitBreakers = new Map();
    this.metrics = {
      retries: 0,
      circuitBreaks: 0,
      timeouts: 0,
      successes: 0,
    };
  }

  /**
   * Retry with exponential backoff + jitter
   */
  async retryWithBackoff(fn, name = 'operation') {
    let lastError;
    
    for (let attempt = 0; attempt < this.opts.maxRetries; attempt++) {
      try {
        const result = await fn();
        if (attempt > 0) {
          this.metrics.successes++;
          this.emit('retry:success', { name, attempt });
        }
        return result;
      } catch (err) {
        lastError = err;
        this.metrics.retries++;
        
        if (attempt < this.opts.maxRetries - 1) {
          const backoffMs = this.calculateBackoff(attempt);
          this.emit('retry:attempt', { name, attempt, backoffMs, error: err.message });
          await this.sleep(backoffMs);
        }
      }
    }

    this.emit('retry:exhausted', { name, error: lastError.message });
    throw lastError;
  }

  /**
   * Calculate backoff with jitter
   */
  calculateBackoff(attempt) {
    const exponential = Math.min(
      this.opts.initialBackoffMs * Math.pow(2, attempt),
      this.opts.maxBackoffMs
    );
    const jitter = exponential * this.opts.jitterFactor * Math.random();
    return exponential + jitter;
  }

  /**
   * Circuit breaker pattern for external calls
   */
  async callWithCircuitBreaker(name, fn) {
    const breaker = this.getOrCreateCircuitBreaker(name);
    
    if (breaker.state === 'OPEN') {
      this.metrics.circuitBreaks++;
      throw new Error(`Circuit breaker OPEN for ${name}`);
    }

    try {
      const result = await fn();
      breaker.recordSuccess();
      return result;
    } catch (err) {
      breaker.recordFailure();
      if (breaker.state === 'OPEN') {
        this.emit('circuit:open', { name, threshold: this.opts.circuitBreakerThreshold });
      }
      throw err;
    }
  }

  /**
   * Get or create circuit breaker
   */
  getOrCreateCircuitBreaker(name) {
    if (!this.circuitBreakers.has(name)) {
      this.circuitBreakers.set(name, {
        state: 'CLOSED',
        failures: 0,
        lastFailureTime: null,
        openedAt: null,
        
        recordSuccess: () => {
          const breaker = this.circuitBreakers.get(name);
          breaker.failures = 0;
          breaker.state = 'CLOSED';
        },
        
        recordFailure: () => {
          const breaker = this.circuitBreakers.get(name);
          breaker.failures++;
          breaker.lastFailureTime = Date.now();
          
          if (breaker.failures >= this.opts.circuitBreakerThreshold) {
            breaker.state = 'OPEN';
            breaker.openedAt = Date.now();
          }
        },
        
        checkReset: () => {
          const breaker = this.circuitBreakers.get(name);
          if (
            breaker.state === 'OPEN' &&
            Date.now() - breaker.openedAt > this.opts.circuitBreakerResetMs
          ) {
            breaker.state = 'HALF_OPEN';
            breaker.failures = 0;
            this.emit('circuit:half-open', { name });
          }
        },
      });
    }
    
    const breaker = this.circuitBreakers.get(name);
    breaker.checkReset();
    return breaker;
  }

  /**
   * Timeout guard with cleanup
   */
  async withTimeout(promise, timeoutMs, onTimeout) {
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        const timeoutId = setTimeout(() => {
          this.metrics.timeouts++;
          if (onTimeout) onTimeout();
          reject(new Error(`Operation timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        
        // Cleanup timer on resolution
        promise.finally(() => clearTimeout(timeoutId));
      }),
    ]);
  }

  /**
   * Async resource pool (e.g., for concurrent tool calls)
   */
  createResourcePool(maxConcurrent) {
    const pool = {
      active: new Set(),
      queue: [],
      maxConcurrent,
      
      async acquire(fn) {
        if (pool.active.size >= pool.maxConcurrent) {
          return new Promise(resolve => {
            pool.queue.push(fn);
          }).then(async result => result);
        }

        const id = Symbol('resource');
        pool.active.add(id);

        try {
          return await fn();
        } finally {
          pool.active.delete(id);
          const nextFn = pool.queue.shift();
          if (nextFn) {
            const result = await pool.acquire(nextFn);
            // Resolve the pending promise
          }
        }
      },
    };

    return pool;
  }

  /**
   * Metrics snapshot
   */
  getMetrics() {
    const breakers = {};
    for (const [name, breaker] of this.circuitBreakers.entries()) {
      breakers[name] = {
        state: breaker.state,
        failures: breaker.failures,
      };
    }

    return {
      ...this.metrics,
      circuitBreakers: breakers,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Helper: sleep
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Reset metrics
   */
  resetMetrics() {
    this.metrics = {
      retries: 0,
      circuitBreaks: 0,
      timeouts: 0,
      successes: 0,
    };
  }

  /**
   * Reset specific circuit breaker
   */
  resetCircuitBreaker(name) {
    if (this.circuitBreakers.has(name)) {
      this.circuitBreakers.delete(name);
    }
  }
}

module.exports = AgentResilienceManager;
