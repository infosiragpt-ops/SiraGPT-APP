const EventEmitter = require('events');

class AgentResilienceManager extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = {
      ...opts,
      maxRetries: positiveInt(opts.maxRetries, 3),
      initialBackoffMs: positiveInt(opts.initialBackoffMs, 100),
      maxBackoffMs: positiveInt(opts.maxBackoffMs, 30000),
      jitterFactor: boundedNumber(opts.jitterFactor, 0.1, 0, 1),
      circuitBreakerThreshold: positiveInt(opts.circuitBreakerThreshold, 5),
      circuitBreakerResetMs: positiveInt(opts.circuitBreakerResetMs, 60000),
      requestTimeoutMs: positiveInt(opts.requestTimeoutMs, 30000),
    };

    this.circuitBreakers = new Map();
    this.metrics = {
      retries: 0,
      circuitBreaks: 0,
      timeouts: 0,
      successes: 0,
    };
  }

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
          this.emit('retry:attempt', { name, attempt, backoffMs, error: err?.message || String(err) });
          await this.sleep(backoffMs);
        }
      }
    }

    this.emit('retry:exhausted', { name, error: lastError?.message || String(lastError) });
    throw lastError;
  }

  calculateBackoff(attempt) {
    const exponential = Math.min(
      this.opts.initialBackoffMs * Math.pow(2, attempt),
      this.opts.maxBackoffMs,
    );
    const jitter = exponential * this.opts.jitterFactor * Math.random();
    return Math.round(exponential + jitter);
  }

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
      breaker.recordFailure(breaker.state === 'HALF_OPEN');
      if (breaker.state === 'OPEN') {
        this.emit('circuit:open', { name, threshold: this.opts.circuitBreakerThreshold });
      }
      throw err;
    }
  }

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
          breaker.openedAt = null;
        },

        recordFailure: (forceOpen = false) => {
          const breaker = this.circuitBreakers.get(name);
          breaker.failures++;
          breaker.lastFailureTime = Date.now();

          if (forceOpen || breaker.failures >= this.opts.circuitBreakerThreshold) {
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

  async withTimeout(promise, timeoutMs, onTimeout) {
    let timeoutId;
    const timeout = positiveInt(timeoutMs, this.opts.requestTimeoutMs);

    return new Promise((resolve, reject) => {
      let settled = false;
      timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.metrics.timeouts++;
        if (onTimeout) onTimeout();
        reject(new Error(`Operation timed out after ${timeout}ms`));
      }, timeout);

      Promise.resolve(promise).then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          resolve(value);
        },
        (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          reject(err);
        },
      );
    });
  }

  createResourcePool(maxConcurrent) {
    const limit = positiveInt(maxConcurrent, 1);
    const pool = {
      active: 0,
      queue: [],
      maxConcurrent: limit,

      async acquire(fn) {
        if (typeof fn !== 'function') {
          throw new TypeError('resource pool acquire requires a function');
        }
        return new Promise((resolve, reject) => {
          pool.queue.push({ fn, resolve, reject });
          pool.drain();
        });
      },

      drain() {
        while (pool.active < pool.maxConcurrent && pool.queue.length > 0) {
          const task = pool.queue.shift();
          pool.active++;
          Promise.resolve()
            .then(task.fn)
            .then(task.resolve, task.reject)
            .finally(() => {
              pool.active--;
              pool.drain();
            });
          }
      },
    };

    return pool;
  }

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

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  resetMetrics() {
    this.metrics = {
      retries: 0,
      circuitBreaks: 0,
      timeouts: 0,
      successes: 0,
    };
  }

  resetCircuitBreaker(name) {
    if (this.circuitBreakers.has(name)) {
      this.circuitBreakers.delete(name);
    }
  }
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function boundedNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

module.exports = AgentResilienceManager;
