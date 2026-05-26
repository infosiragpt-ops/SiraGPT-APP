/**
 * agent-telemetry.js
 *
 * Agent system telemetry, observability, and structured logging inspired by OpenClaw patterns.
 * Exports metrics, traces, and audit events for monitoring and debugging.
 */

class AgentTelemetry {
  constructor(opts = {}) {
    this.opts = {
      enableTracing: opts.enableTracing !== false,
      enableMetrics: opts.enableMetrics !== false,
      sampleRate: opts.sampleRate || 1.0,
      maxSpanDepth: opts.maxSpanDepth || 32,
      maxEventSize: opts.maxEventSize || 10000,
      ...opts,
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

  /**
   * Start a tracing span
   */
  startSpan(name, attributes = {}) {
    if (!this.shouldSample()) return { end: () => {} };

    const spanId = this.generateId();
    const parentSpan = this.getActiveSpan();
    const depth = parentSpan ? (parentSpan.depth || 0) + 1 : 0;

    if (depth > this.opts.maxSpanDepth) {
      return { end: () => {} }; // Drop if too deep
    }

    const span = {
      id: spanId,
      name,
      parentId: parentSpan?.id,
      startTime: Date.now(),
      attributes,
      depth,
      events: [],
    };

    this.spans.set(spanId, span);
    return {
      end: (result, error) => this.endSpan(spanId, result, error),
      addEvent: (eventName, eventAttrs) => this.addSpanEvent(spanId, eventName, eventAttrs),
      addAttribute: (key, value) => (span.attributes[key] = value),
    };
  }

  /**
   * End a span
   */
  endSpan(spanId, result, error) {
    const span = this.spans.get(spanId);
    if (!span) return;

    span.endTime = Date.now();
    span.duration = span.endTime - span.startTime;
    span.result = result;
    span.error = error;

    this.emitEvent('span.end', {
      spanId,
      name: span.name,
      duration: span.duration,
      error: error?.message,
    });
  }

  /**
   * Add event to active span
   */
  addSpanEvent(spanId, eventName, attributes) {
    const span = this.spans.get(spanId);
    if (!span) return;

    span.events.push({
      name: eventName,
      timestamp: Date.now(),
      attributes,
    });
  }

  /**
   * Record agent run
   */
  recordAgentRun(agentId, taskId, result) {
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

  /**
   * Record tool invocation
   */
  recordToolInvocation(toolName, args, result) {
    this.metrics.toolInvocations++;

    if (result.error) {
      this.metrics.toolErrors++;
    } else {
      this.metrics.toolLatencyMs.push(result.durationMs);
    }

    this.emitEvent('tool.invocation', {
      toolName,
      argsSize: JSON.stringify(args).length,
      resultSize: JSON.stringify(result).length,
      error: result.error?.message,
      duration: result.durationMs,
    });
  }

  /**
   * Emit event for logging/monitoring
   */
  emitEvent(eventType, data) {
    if (!this.shouldSample()) return;

    const event = {
      timestamp: Date.now(),
      type: eventType,
      data,
    };

    // Limit event size
    const eventSize = JSON.stringify(event).length;
    if (eventSize > this.opts.maxEventSize) {
      event.data = { truncated: true, originalSize: eventSize };
    }

    this.events.push(event);

    // Keep sliding window of last 1000 events
    if (this.events.length > 1000) {
      this.events.shift();
    }
  }

  /**
   * Get active span
   */
  getActiveSpan() {
    for (const span of this.spans.values()) {
      if (!span.endTime) return span;
    }
    return null;
  }

  /**
   * Get metrics snapshot
   */
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

  /**
   * Get traces (all spans)
   */
  getTraces() {
    const traces = [];
    
    for (const span of this.spans.values()) {
      if (!span.parentId) {
        traces.push(this.buildTraceTree(span));
      }
    }

    return traces;
  }

  /**
   * Build trace tree
   */
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

  /**
   * Get events
   */
  getEvents() {
    return [...this.events];
  }

  /**
   * Clear old data
   */
  prune(maxAge = 3600000) {
    const now = Date.now();
    
    for (const [spanId, span] of this.spans.entries()) {
      if (now - span.startTime > maxAge) {
        this.spans.delete(spanId);
      }
    }

    this.events = this.events.filter(e => now - e.timestamp <= maxAge);
  }

  /**
   * Export data for observability platform
   */
  export() {
    return {
      timestamp: new Date().toISOString(),
      metrics: this.getMetrics(),
      traces: this.getTraces(),
      events: this.getEvents().slice(-100), // Last 100 events
    };
  }

  /**
   * Helper: calculate percentile
   */
  percentile(values, p) {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.ceil(sorted.length * p) - 1;
    return sorted[Math.max(0, index)];
  }

  /**
   * Helper: generate ID
   */
  generateId() {
    return `span-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  }

  /**
   * Helper: decide whether to sample
   */
  shouldSample() {
    return Math.random() < this.opts.sampleRate;
  }

  /**
   * Reset telemetry
   */
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

module.exports = AgentTelemetry;
