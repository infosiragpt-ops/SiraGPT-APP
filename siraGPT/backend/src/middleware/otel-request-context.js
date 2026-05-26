const { context, trace } = require("@opentelemetry/api");

const TRACE_HEADER = "X-Trace-Id";

function getActiveSpan() {
  return trace.getSpan(context.active()) || null;
}

function readRequestId(req) {
  if (!req) return null;
  if (req.requestId) return String(req.requestId);
  if (req.id) return String(req.id);
  const raw = req.headers && req.headers["x-request-id"];
  return raw ? String(raw) : null;
}

function applyRequestTraceContext({ span, req, res } = {}) {
  if (!span || typeof span.setAttribute !== "function") return null;

  const requestId = readRequestId(req);
  if (requestId) {
    span.setAttribute("siragpt.request_id", requestId);
    span.setAttribute("http.request_id", requestId);
  }

  const authenticated = Boolean(req && req.user);
  span.setAttribute("siragpt.authenticated", authenticated);

  const spanContext = typeof span.spanContext === "function" ? span.spanContext() : null;
  const traceId = spanContext && spanContext.traceId ? String(spanContext.traceId) : null;
  if (traceId && res && typeof res.setHeader === "function" && !res.headersSent) {
    res.setHeader(TRACE_HEADER, traceId);
  }

  return { requestId, traceId, authenticated };
}

function otelRequestContextMiddleware(req, res, next) {
  try {
    applyRequestTraceContext({ span: getActiveSpan(), req, res });
  } catch (_err) {
    // Tracing metadata must never change request behavior.
  }
  next();
}

module.exports = {
  TRACE_HEADER,
  applyRequestTraceContext,
  getActiveSpan,
  otelRequestContextMiddleware,
  readRequestId,
};
