const { resourceFromAttributes } = require("@opentelemetry/resources");

const DEFAULT_SERVICE_NAME = "siragpt-backend";

let sdk = null;
let state = {
  configured: false,
  enabled: false,
  started: false,
  serviceName: DEFAULT_SERVICE_NAME,
  exporter: "none",
  reason: "not_started",
};

function isTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

function isFalsey(value) {
  return /^(0|false|no|off)$/i.test(String(value || "").trim());
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function resolveOtlpTraceEndpoint(env = process.env) {
  if (nonEmpty(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT)) {
    return env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT.trim();
  }

  if (!nonEmpty(env.OTEL_EXPORTER_OTLP_ENDPOINT)) return null;

  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT.trim().replace(/\/+$/, "");
  return /\/v1\/traces$/i.test(base) ? base : `${base}/v1/traces`;
}

function resolveOpenTelemetryConfig(env = process.env) {
  const sdkDisabled = isTruthy(env.OTEL_SDK_DISABLED);
  const hasExplicitToggle = nonEmpty(env.OTEL_ENABLED);
  const hasEndpoint = Boolean(resolveOtlpTraceEndpoint(env));
  const tracesExporter = String(env.OTEL_TRACES_EXPORTER || "otlp").trim().toLowerCase();
  const enabled = !sdkDisabled && (hasExplicitToggle ? isTruthy(env.OTEL_ENABLED) : hasEndpoint);
  const serviceName = env.OTEL_SERVICE_NAME || DEFAULT_SERVICE_NAME;
  const deploymentEnvironment = env.OTEL_DEPLOYMENT_ENVIRONMENT || env.NODE_ENV || "development";

  if (!enabled) {
    return {
      configured: hasExplicitToggle || hasEndpoint,
      enabled: false,
      serviceName,
      exporter: "none",
      reason: sdkDisabled ? "otel_sdk_disabled" : "otel_not_enabled",
    };
  }

  if (tracesExporter === "none") {
    return {
      configured: true,
      enabled: false,
      serviceName,
      exporter: "none",
      reason: "otel_traces_exporter_none",
    };
  }

  if (tracesExporter !== "otlp") {
    return {
      configured: true,
      enabled: false,
      serviceName,
      exporter: tracesExporter,
      reason: "unsupported_trace_exporter",
    };
  }

  const endpoint = resolveOtlpTraceEndpoint(env);
  if (!endpoint) {
    return {
      configured: true,
      enabled: false,
      serviceName,
      exporter: "otlp-http",
      reason: "missing_otlp_trace_endpoint",
    };
  }

  return {
    configured: true,
    enabled: true,
    serviceName,
    exporter: "otlp-http",
    endpoint,
    resourceAttributes: buildResourceAttributes({ env, serviceName, deploymentEnvironment }),
    reason: "ready",
  };
}

function buildResourceAttributes({ env = process.env, serviceName = DEFAULT_SERVICE_NAME, deploymentEnvironment } = {}) {
  const attrs = {
    "service.name": serviceName,
    "service.namespace": env.OTEL_SERVICE_NAMESPACE || "siragpt",
    "deployment.environment": deploymentEnvironment || env.NODE_ENV || "development",
    "process.runtime.name": "nodejs",
    "process.runtime.version": process.version,
  };

  if (nonEmpty(env.npm_package_version)) {
    attrs["service.version"] = env.npm_package_version.trim();
  }

  if (nonEmpty(env.HOSTNAME)) {
    attrs["host.name"] = env.HOSTNAME.trim();
  }

  return attrs;
}

function createInstrumentationConfig() {
  return {
    "@opentelemetry/instrumentation-fs": { enabled: false },
    "@opentelemetry/instrumentation-dns": { enabled: false },
    "@opentelemetry/instrumentation-http": {
      ignoreIncomingRequestHook: (req) => {
        const url = typeof req?.url === "string" ? req.url : "";
        return url === "/metrics" || url.startsWith("/health");
      },
    },
    "@opentelemetry/instrumentation-pino": { enabled: true },
    "@opentelemetry/instrumentation-express": { enabled: true },
    "@opentelemetry/instrumentation-ioredis": { enabled: true },
    "@opentelemetry/instrumentation-pg": { enabled: true },
    "@opentelemetry/instrumentation-undici": { enabled: true },
    "@opentelemetry/instrumentation-openai": { enabled: true },
  };
}

function startOpenTelemetry({ env = process.env, logger = console } = {}) {
  if (sdk || state.started) return getOpenTelemetryStatus();

  const config = resolveOpenTelemetryConfig(env);
  state = {
    configured: config.configured,
    enabled: config.enabled,
    started: false,
    serviceName: config.serviceName,
    exporter: config.exporter,
    reason: config.reason,
  };

  if (!config.enabled) return getOpenTelemetryStatus();

  try {
    const { NodeSDK } = require("@opentelemetry/sdk-node");
    const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
    const { getNodeAutoInstrumentations } = require("@opentelemetry/auto-instrumentations-node");

    sdk = new NodeSDK({
      resource: resourceFromAttributes(config.resourceAttributes),
      traceExporter: new OTLPTraceExporter({ url: config.endpoint }),
      instrumentations: [getNodeAutoInstrumentations(createInstrumentationConfig())],
    });

    sdk.start();
    state = {
      configured: true,
      enabled: true,
      started: true,
      serviceName: config.serviceName,
      exporter: config.exporter,
      reason: "started",
    };

    logger.info?.(
      {
        serviceName: config.serviceName,
        exporter: config.exporter,
      },
      "OpenTelemetry tracing started",
    );
  } catch (err) {
    const message = err && err.message ? String(err.message) : "unknown";
    state = {
      configured: true,
      enabled: true,
      started: false,
      serviceName: config.serviceName,
      exporter: config.exporter,
      reason: "start_failed",
      error: message.slice(0, 240),
    };
    logger.warn?.({ err: message }, "OpenTelemetry tracing failed to start");
    if (isTruthy(env.OTEL_FAIL_FAST)) throw err;
  }

  return getOpenTelemetryStatus();
}

async function shutdownOpenTelemetry() {
  if (!sdk) return getOpenTelemetryStatus();

  try {
    await sdk.shutdown();
    state = {
      ...state,
      started: false,
      reason: "shutdown",
    };
  } finally {
    sdk = null;
  }

  return getOpenTelemetryStatus();
}

function getOpenTelemetryStatus() {
  const details = {
    configured: Boolean(state.configured),
    enabled: Boolean(state.enabled),
    started: Boolean(state.started),
    service_name: state.serviceName || DEFAULT_SERVICE_NAME,
    exporter: state.exporter || "none",
    reason: state.reason || "unknown",
  };

  if (state.error) details.error = state.error;
  return details;
}

module.exports = {
  DEFAULT_SERVICE_NAME,
  buildResourceAttributes,
  createInstrumentationConfig,
  getOpenTelemetryStatus,
  isFalsey,
  isTruthy,
  resolveOpenTelemetryConfig,
  resolveOtlpTraceEndpoint,
  shutdownOpenTelemetry,
  startOpenTelemetry,
};
