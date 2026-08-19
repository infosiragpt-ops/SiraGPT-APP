'use strict';

/**
 * document-otel.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects OpenTelemetry SDK usage:
 *
 *   - Tracer:        trace.getTracer / context.with / SpanKind / startActiveSpan
 *   - Span ops:      setAttribute / setAttributes / addEvent / recordException /
 *                    setStatus / updateName / end / isRecording
 *   - SpanKind:      INTERNAL / CLIENT / SERVER / PRODUCER / CONSUMER
 *   - SpanStatus:    UNSET / OK / ERROR
 *   - Semantic attrs: SEMATTRS_HTTP_METHOD / SemanticAttributes.HTTP_URL / etc.
 *   - Metrics:       getMeter / createCounter / createHistogram / createUpDownCounter
 *   - Resources:     Resource.default / resourceFromAttributes / detectResources
 *   - Propagators:   inject / extract / W3CTraceContextPropagator / BaggagePropagator
 *   - Instrumentations: HttpInstrumentation / ExpressInstrumentation / etc.
 *
 * Public API:
 *   extractOtel(text)             → { entries, totals, total }
 *   buildOtelForFiles(files)      → { perFile, aggregate, totals }
 *   renderOtelBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 24;
const MAX_AGGREGATE = 30;
const MAX_BLOCK_CHARS = 5000;

const TRACER_RE = /\b(?:trace|tracer|context)\.(getTracer|getActiveSpan|setSpan|getSpan|with|startActiveSpan|startSpan)\s*\(/g;
const SPAN_OP_RE = /\.(setAttribute|setAttributes|addEvent|recordException|setStatus|updateName|end|isRecording|spanContext)\s*\(/g;
const KIND_RE = /\bSpanKind\.(INTERNAL|CLIENT|SERVER|PRODUCER|CONSUMER)\b/g;
const STATUS_RE = /\bSpanStatusCode\.(UNSET|OK|ERROR)\b/g;
const SEMANTIC_ATTR_RE = /\b(?:SemanticAttributes|SEMATTRS_)([A-Z][A-Z0-9_]{2,80})\b/g;
const METER_RE = /\b(?:meter|metrics|m)\.(getMeter|createCounter|createHistogram|createGauge|createUpDownCounter|createObservableCounter|createObservableGauge|createObservableUpDownCounter)\s*\(/g;
const RESOURCE_RE = /\b(?:Resource|resourceFromAttributes|detectResources|defaultResource)\.?(default|fromAttributes|empty|merge)?\s*\(/g;
const PROPAGATOR_RE = /\bnew\s+(W3CTraceContextPropagator|W3CBaggagePropagator|JaegerPropagator|B3Propagator|OTTracePropagator|CompositePropagator)\b/g;
const INSTRUMENTATION_RE = /\bnew\s+([A-Z][a-zA-Z]{2,40}Instrumentation)\s*\(/g;
const ATTRIBUTE_KEY_RE = /["'](http\.method|http\.url|http\.status_code|http\.scheme|http\.target|http\.host|http\.flavor|http\.user_agent|net\.peer\.name|net\.peer\.port|net\.host\.name|db\.system|db\.statement|db\.operation|messaging\.system|messaging\.destination|rpc\.system|rpc\.service|rpc\.method|service\.name|service\.version|deployment\.environment|cloud\.provider|cloud\.region|cloud\.availability_zone)["']/g;

function isOtelLike(body) {
  return /@opentelemetry\/|\btrace\.(getTracer|getActiveSpan|startSpan|startActiveSpan)|\bSpanKind\.|\bSpanStatusCode\.|\bSemanticAttributes|\bSEMATTRS_/.test(body);
}

function extractOtel(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  if (!isOtelLike(body)) {
    return { entries: [], totals: {}, total: 0 };
  }
  const seen = new Set();
  const entries = [];
  const totals = {
    tracer: 0, spanOp: 0, kind: 0, status: 0,
    semanticAttr: 0, meter: 0, resource: 0,
    propagator: 0, instrumentation: 0, attrKey: 0,
  };

  function push(kind, name, detail) {
    const sig = `${kind}:${name}:${detail || ''}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    entries.push({ kind, name, detail });
    if (totals[kind] != null) totals[kind] += 1;
  }

  TRACER_RE.lastIndex = 0;
  let m;
  while ((m = TRACER_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push('tracer', m[1], null);
  }
  if (entries.length < MAX_PER_FILE) {
    SPAN_OP_RE.lastIndex = 0;
    while ((m = SPAN_OP_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('spanOp', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    KIND_RE.lastIndex = 0;
    while ((m = KIND_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('kind', `SpanKind.${m[1]}`, null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    STATUS_RE.lastIndex = 0;
    while ((m = STATUS_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('status', `SpanStatusCode.${m[1]}`, null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    SEMANTIC_ATTR_RE.lastIndex = 0;
    while ((m = SEMANTIC_ATTR_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('semanticAttr', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    METER_RE.lastIndex = 0;
    while ((m = METER_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('meter', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    PROPAGATOR_RE.lastIndex = 0;
    while ((m = PROPAGATOR_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('propagator', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    INSTRUMENTATION_RE.lastIndex = 0;
    while ((m = INSTRUMENTATION_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('instrumentation', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    ATTRIBUTE_KEY_RE.lastIndex = 0;
    while ((m = ATTRIBUTE_KEY_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('attrKey', m[1], null);
    }
  }

  return { entries, totals, total: entries.length };
}

function buildOtelForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = {
    tracer: 0, spanOp: 0, kind: 0, status: 0,
    semanticAttr: 0, meter: 0, resource: 0,
    propagator: 0, instrumentation: 0, attrKey: 0,
  };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractOtel(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.kind}:${e.name}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      if (totals[e.kind] != null) totals[e.kind] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderOtelBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## OPENTELEMETRY'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 14)) {
      lines.push(`- [${e.kind}] \`${e.name}\``);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractOtel,
  buildOtelForFiles,
  renderOtelBlock,
  _internal: { isOtelLike },
};
