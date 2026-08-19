"use strict";

const { createTrace } = require("./tracing");

class Runnable {
  constructor({ name, invoke, stream = null, inputSchema = null, outputSchema = null, config = {} } = {}) {
    if (!name || typeof name !== "string") {
      throw new Error("Runnable requires a stable name");
    }
    if (typeof invoke !== "function") {
      throw new Error(`Runnable "${name}" requires invoke(input, context)`);
    }
    this.name = name;
    this._invoke = invoke;
    this._stream = stream;
    this.inputSchema = inputSchema;
    this.outputSchema = outputSchema;
    this.config = Object.freeze({ ...config });
  }

  async invoke(input, context = {}) {
    const trace = ensureTrace(context);
    trace.emit("runnable.start", {
      name: this.name,
      input_schema: Boolean(this.inputSchema),
      output_schema: Boolean(this.outputSchema),
    });
    try {
      const output = await this._invoke(input, { ...context, trace });
      trace.emit("runnable.end", { name: this.name, ok: true });
      return output;
    } catch (err) {
      trace.emit("runnable.error", {
        name: this.name,
        message: err && err.message ? err.message : String(err),
        code: err && err.code ? err.code : "runnable_error",
      });
      throw err;
    }
  }

  async *stream(input, context = {}) {
    if (typeof this._stream === "function") {
      yield* this._stream(input, context);
      return;
    }
    yield await this.invoke(input, context);
  }

  async batch(inputs, context = {}) {
    if (!Array.isArray(inputs)) {
      throw new Error(`Runnable "${this.name}" batch() expects an array`);
    }
    const concurrency = Math.max(1, Number(context.concurrency || this.config.concurrency || 4));
    const results = new Array(inputs.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, inputs.length) }, async () => {
      while (next < inputs.length) {
        const index = next++;
        results[index] = await this.invoke(inputs[index], context);
      }
    });
    await Promise.all(workers);
    return results;
  }

  pipe(nextRunnable) {
    const left = this;
    const right = asRunnable(nextRunnable);
    return new Runnable({
      name: `${left.name}|${right.name}`,
      invoke: async (input, context) => right.invoke(await left.invoke(input, context), context),
    });
  }

  withConfig(config = {}) {
    return new Runnable({
      name: this.name,
      invoke: (input, context = {}) => this.invoke(input, { ...context, config: { ...(context.config || {}), ...config } }),
      stream: (input, context = {}) => this.stream(input, { ...context, config: { ...(context.config || {}), ...config } }),
      inputSchema: this.inputSchema,
      outputSchema: this.outputSchema,
      config: { ...this.config, ...config },
    });
  }

  withRetry({ maxRetries = 2, retryOn = null, backoffMs = 10 } = {}) {
    const runnable = this;
    return new Runnable({
      name: `${runnable.name}.retry`,
      invoke: async (input, context = {}) => {
        const trace = ensureTrace(context);
        let lastError = null;
        for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
          try {
            trace.emit("runnable.retry.attempt", { name: runnable.name, attempt });
            return await runnable.invoke(input, context);
          } catch (err) {
            lastError = err;
            const shouldRetry = typeof retryOn === "function" ? retryOn(err) : true;
            if (!shouldRetry || attempt >= maxRetries) break;
            await sleep(backoffMs * Math.max(1, attempt + 1));
          }
        }
        throw lastError;
      },
    });
  }

  withFallbacks(fallbacks = []) {
    const primary = this;
    const fallbackRunnables = fallbacks.map(asRunnable);
    return new Runnable({
      name: `${primary.name}.fallbacks`,
      invoke: async (input, context = {}) => {
        const trace = ensureTrace(context);
        const chain = [primary, ...fallbackRunnables];
        let lastError = null;
        for (const candidate of chain) {
          try {
            trace.emit("runnable.fallback.try", { name: primary.name, candidate: candidate.name });
            return await candidate.invoke(input, context);
          } catch (err) {
            lastError = err;
            trace.emit("runnable.fallback.failed", {
              name: primary.name,
              candidate: candidate.name,
              message: err && err.message ? err.message : String(err),
            });
          }
        }
        throw lastError;
      },
    });
  }

  getGraph() {
    return {
      type: "runnable",
      name: this.name,
      input_schema: this.inputSchema,
      output_schema: this.outputSchema,
      config: this.config,
    };
  }
}

function runnable(name, fn, options = {}) {
  return new Runnable({ name, invoke: fn, ...options });
}

function sequence(name, steps) {
  const normalized = steps.map(asRunnable);
  return new Runnable({
    name,
    invoke: async (input, context = {}) => {
      let state = input;
      for (const step of normalized) {
        state = await step.invoke(state, context);
      }
      return state;
    },
    config: { graph: normalized.map((step) => step.getGraph()) },
  });
}

function parallel(name, branches) {
  const entries = Object.entries(branches).map(([key, value]) => [key, asRunnable(value)]);
  return new Runnable({
    name,
    invoke: async (input, context = {}) => {
      const out = {};
      await Promise.all(entries.map(async ([key, step]) => {
        out[key] = await step.invoke(input, context);
      }));
      return out;
    },
    config: { graph: entries.map(([key, step]) => ({ key, ...step.getGraph() })) },
  });
}

function asRunnable(value) {
  if (value instanceof Runnable) return value;
  if (typeof value === "function") return runnable(value.name || "anonymous", value);
  throw new Error("Expected Runnable or function");
}

function ensureTrace(context = {}) {
  if (context.trace && typeof context.trace.emit === "function") return context.trace;
  const created = createTrace({ metadata: context.metadata || {} });
  context.trace = created;
  return created;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  Runnable,
  runnable,
  sequence,
  parallel,
  asRunnable,
  ensureTrace,
};
