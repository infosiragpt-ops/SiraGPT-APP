const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildResourceAttributes,
  resolveOpenTelemetryConfig,
  resolveOtlpTraceEndpoint,
} = require("../src/services/observability/otel");
const {
  TRACE_HEADER,
  applyRequestTraceContext,
  readRequestId,
} = require("../src/middleware/otel-request-context");

describe("OpenTelemetry config", () => {
  test("stays disabled by default when no endpoint or toggle is present", () => {
    const config = resolveOpenTelemetryConfig({});
    assert.equal(config.enabled, false);
    assert.equal(config.requested, false);
    assert.equal(config.reason, "otel_not_enabled");
    assert.equal(config.serviceName, "siragpt-backend");
  });

  test("derives the OTLP traces endpoint from the generic OTLP endpoint", () => {
    assert.equal(
      resolveOtlpTraceEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" }),
      "http://collector:4318/v1/traces",
    );
    assert.equal(
      resolveOtlpTraceEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318/v1/traces" }),
      "http://collector:4318/v1/traces",
    );
  });

  test("enables OTLP HTTP tracing when a trace endpoint is configured", () => {
    const config = resolveOpenTelemetryConfig({
      NODE_ENV: "production",
      OTEL_SERVICE_NAME: "siragpt-api",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://otel.example.com/v1/traces",
    });

    assert.equal(config.enabled, true);
    assert.equal(config.requested, true);
    assert.equal(config.exporter, "otlp-http");
    assert.equal(config.endpoint, "https://otel.example.com/v1/traces");
    assert.equal(config.resourceAttributes["service.name"], "siragpt-api");
    assert.equal(config.resourceAttributes["deployment.environment"], "production");
  });

  test("respects explicit disable even when endpoint exists", () => {
    const config = resolveOpenTelemetryConfig({
      OTEL_ENABLED: "false",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://otel.example.com/v1/traces",
    });
    assert.equal(config.enabled, false);
    assert.equal(config.requested, false);
    assert.equal(config.reason, "otel_not_enabled");
  });

  test("records explicit tracing intent when endpoint config is missing", () => {
    const config = resolveOpenTelemetryConfig({
      OTEL_ENABLED: "true",
    });
    assert.equal(config.configured, true);
    assert.equal(config.requested, true);
    assert.equal(config.enabled, false);
    assert.equal(config.reason, "missing_otlp_trace_endpoint");
  });

  test("marks unsupported exporters as configured but not enabled", () => {
    const config = resolveOpenTelemetryConfig({
      OTEL_ENABLED: "true",
      OTEL_TRACES_EXPORTER: "console",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://otel.example.com/v1/traces",
    });
    assert.equal(config.enabled, false);
    assert.equal(config.requested, true);
    assert.equal(config.reason, "unsupported_trace_exporter");
    assert.equal(config.exporter, "console");
  });

  test("builds privacy-safe resource attributes", () => {
    const attrs = buildResourceAttributes({
      env: {
        NODE_ENV: "test",
        OTEL_SERVICE_NAMESPACE: "sira",
        npm_package_version: "1.2.3",
      },
      serviceName: "siragpt-backend",
    });

    assert.equal(attrs["service.name"], "siragpt-backend");
    assert.equal(attrs["service.namespace"], "sira");
    assert.equal(attrs["service.version"], "1.2.3");
    assert.equal(attrs["deployment.environment"], "test");
    assert.ok(!Object.keys(attrs).some((key) => /key|token|secret/i.test(key)));
  });
});

describe("OpenTelemetry request context middleware helpers", () => {
  test("reads canonical request id from middleware fields before headers", () => {
    assert.equal(readRequestId({ requestId: "req-a", id: "req-b", headers: { "x-request-id": "req-c" } }), "req-a");
    assert.equal(readRequestId({ id: "req-b", headers: { "x-request-id": "req-c" } }), "req-b");
    assert.equal(readRequestId({ headers: { "x-request-id": "req-c" } }), "req-c");
  });

  test("pins request id and trace id without exposing user payloads", () => {
    const attrs = {};
    const headers = {};
    const fakeSpan = {
      setAttribute(key, value) {
        attrs[key] = value;
      },
      spanContext() {
        return { traceId: "0123456789abcdef0123456789abcdef" };
      },
    };

    const result = applyRequestTraceContext({
      span: fakeSpan,
      req: { requestId: "req_123", user: { id: "user_999" } },
      res: {
        headersSent: false,
        setHeader(key, value) {
          headers[key] = value;
        },
      },
    });

    assert.deepEqual(result, {
      requestId: "req_123",
      traceId: "0123456789abcdef0123456789abcdef",
      authenticated: true,
    });
    assert.equal(attrs["siragpt.request_id"], "req_123");
    assert.equal(attrs["http.request_id"], "req_123");
    assert.equal(attrs["siragpt.authenticated"], true);
    assert.equal(headers[TRACE_HEADER], "0123456789abcdef0123456789abcdef");
    assert.ok(!Object.keys(attrs).includes("user.id"));
  });
});
