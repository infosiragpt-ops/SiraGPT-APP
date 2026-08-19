class AgentTelemetry {
  constructor(opts = {}) {
    this.opts = {
      ...opts,
      enableTracing: opts.enableTracing !== false,
      enableMetrics: opts.enableMetrics !== false,
      sampleRate: clamp(Number(opts.sampleRate ?? 1.0), 0, 1),
      maxSpanDepth: positiveInt(opts.maxSpanDepth, 32),
      maxEventSize: positiveInt(opts.maxEventSize, 10000),
      maxEvents: positiveInt(opts.maxEvents, 1000),
    };

    this.spans = new Map();
    this.events = [];
    this.metrics = {
      agentRuns: 0,
      toolInvocations: 0,
      toolErrors: 0,
      agentLatencyMs: [],
      toolLatencyMs: [],
      taskCompletions: 0,
      taskFailures: 0,
    };
    this.startTime = Date.now();
  }

  startSpan(name, attributes = {}, parentId = null) {
    if (!this.opts.enableTracing) return noopSpan();
    if (!this.shouldSample()) return noopSpan();

    const spanId = this.generateId();
    const explicitParentId = parentId || attributes.parentSpanId || attributes.parentId || null;
    const parentSpan = explicitParentId ? this.spans.get(explicitParentId) : this.getActiveSpan();
    const depth = parentSpan ? (parentSpan.depth || 0) + 1 : 0;

    if (depth > this.opts.maxSpanDepth) {
      return noopSpan();
    }

    const span = {
      id: spanId,
      name,
      parentId: parentSpan?.id,
      startTime: Date.now(),
      attributes: sanitizePayload(attributes),
      depth,
      events: [],
    };

    this.spans.set(spanId, span);
    return {
      end: (result, error) => this.endSpan(spanId, result, error),
      addEvent: (eventName, eventAttrs) => this.addSpanEvent(spanId, eventName, eventAttrs),
      addAttribute: (key, value) => {
        span.attributes[key] = sanitizePayload({ [key]: value })[key];
      },
      spanId,
    };
  }

  endSpan(spanId, result, error) {
    const span = this.spans.get(spanId);
    if (!span) return;

    span.endTime = Date.now();
    span.duration = span.endTime - span.startTime;
    span.result = sanitizePayload(result);
    span.error = normalizeError(error);

    this.emitEvent('span.end', {
      spanId,
      name: span.name,
      duration: span.duration,
      error: span.error?.message,
    });
  }

  addSpanEvent(spanId, eventName, attributes) {
    const span = this.spans.get(spanId);
    if (!span) return;

    span.events.push({
      name: eventName,
      timestamp: Date.now(),
      attributes: sanitizePayload(attributes),
    });
  }

  recordAgentRun(agentId, taskId, result) {
    if (!this.opts.enableMetrics) return;
    this.metrics.agentRuns++;

    if (result.success) {
      this.metrics.taskCompletions++;
      this.metrics.agentLatencyMs.push(result.durationMs);
    } else {
      this.metrics.taskFailures++;
    }

    this.emitEvent('agent.run', {
      agentId,
      taskId,
      success: result.success,
      duration: result.durationMs,
      toolsCalled: result.toolsCalled?.length || 0,
    });
  }

  recordToolInvocation(toolName, args, result) {
    if (!this.opts.enableMetrics) return;
    this.metrics.toolInvocations++;

    if (result.error) {
      this.metrics.toolErrors++;
    } else {
      this.metrics.toolLatencyMs.push(result.durationMs);
    }

    this.emitEvent('tool.invocation', {
      toolName,
      argsSize: jsonSize(args),
      resultSize: jsonSize(result),
      error: normalizeError(result.error)?.message,
      duration: result.durationMs,
    });
  }

  emitEvent(eventType, data) {
    if (!this.shouldSample()) return;

    const event = {
      timestamp: Date.now(),
      type: eventType,
      data: sanitizePayload(data),
    };

    const eventSize = JSON.stringify(event).length;
    if (eventSize > this.opts.maxEventSize) {
      event.data = { truncated: true, originalSize: eventSize };
    }

    this.events.push(event);

    while (this.events.length > this.opts.maxEvents) {
      this.events.shift();
    }
  }

  getActiveSpan() {
    const spans = [...this.spans.values()].reverse();
    for (const span of spans) {
      if (!span.endTime) return span;
    }
    return null;
  }

  getMetrics() {
    const latency = this.metrics.agentLatencyMs;
    const toolLatency = this.metrics.toolLatencyMs;

    return {
      agentRuns: this.metrics.agentRuns,
      toolInvocations: this.metrics.toolInvocations,
      toolErrors: this.metrics.toolErrors,
      taskCompletions: this.metrics.taskCompletions,
      taskFailures: this.metrics.taskFailures,
      uptime: Date.now() - this.startTime,
      latency: {
        agentP50: this.percentile(latency, 0.5),
        agentP95: this.percentile(latency, 0.95),
        agentP99: this.percentile(latency, 0.99),
        toolP50: this.percentile(toolLatency, 0.5),
        toolP95: this.percentile(toolLatency, 0.95),
      },
    };
  }

  getTraces() {
    const traces = [];

    for (const span of this.spans.values()) {
      if (!span.parentId) {
        traces.push(this.buildTraceTree(span));
      }
    }

    return traces;
  }

  buildTraceTree(span) {
    const children = [];

    for (const potentialChild of this.spans.values()) {
      if (potentialChild.parentId === span.id) {
        children.push(this.buildTraceTree(potentialChild));
      }
    }

    return {
      id: span.id,
      name: span.name,
      duration: span.duration,
      startTime: span.startTime,
      error: span.error?.message,
      attributes: span.attributes,
      events: span.events,
      children,
    };
  }

  getEvents() {
    return [...this.events];
  }

  prune(maxAge = 3600000) {
    const now = Date.now();

    for (const [spanId, span] of this.spans.entries()) {
      if (now - span.startTime > maxAge) {
        this.spans.delete(spanId);
      }
    }

    this.events = this.events.filter(e => now - e.timestamp <= maxAge);
  }

  export() {
    return {
      timestamp: new Date().toISOString(),
      metrics: this.getMetrics(),
      traces: this.getTraces(),
      events: this.getEvents().slice(-100), // Last 100 events
    };
  }

  percentile(values, p) {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.ceil(sorted.length * p) - 1;
    return sorted[Math.max(0, index)];
  }

  generateId() {
    return `span-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  }

  shouldSample() {
    return Math.random() < this.opts.sampleRate;
  }

  reset() {
    this.spans.clear();
    this.events = [];
    this.metrics = {
      agentRuns: 0,
      toolInvocations: 0,
      toolErrors: 0,
      agentLatencyMs: [],
      toolLatencyMs: [],
      taskCompletions: 0,
      taskFailures: 0,
    };
    this.startTime = Date.now();
  }
}

const SENSITIVE_KEY_RE = /(token|secret|password|authorization|cookie|apikey|api_key|credential)/i;

function noopSpan() {
  return {
    end: () => {},
    addEvent: () => {},
    addAttribute: () => {},
    spanId: null,
  };
}

function sanitizePayload(value, seen = new WeakSet()) {
  if (value == null) return value;
  if (value instanceof Error) return normalizeError(value);
  if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 500)}...` : value;
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizePayload(item, seen));
  }

  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (SENSITIVE_KEY_RE.test(key)) {
      out[key] = '[REDACTED]';
    } else {
      out[key] = sanitizePayload(raw, seen);
    }
  }
  return out;
}

function normalizeError(error) {
  if (!error) return null;
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { message: String(error) };
}

function jsonSize(value) {
  try {
    return JSON.stringify(sanitizePayload(value)).length;
  } catch {
    return 0;
  }
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return max;
  return Math.min(max, Math.max(min, value));
}

module.exports = AgentTelemetry;
