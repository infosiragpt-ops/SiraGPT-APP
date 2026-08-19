const { resourceFromAttributes } = require("@opentelemetry/resources");
const { isMetricsRequest } = require("./metrics-paths");

const DEFAULT_SERVICE_NAME = "siragpt-backend";

let sdk = null;
let state = {
  configured: false,
  requested: false,
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
  const requested = !sdkDisabled && (hasExplicitToggle ? isTruthy(env.OTEL_ENABLED) : hasEndpoint);
  const enabled = requested;
  const serviceName = env.OTEL_SERVICE_NAME || DEFAULT_SERVICE_NAME;
  const deploymentEnvironment = env.OTEL_DEPLOYMENT_ENVIRONMENT || env.NODE_ENV || "development";

  if (!enabled) {
    return {
      configured: hasExplicitToggle || hasEndpoint,
      requested,
      enabled: false,
      serviceName,
      exporter: "none",
      reason: sdkDisabled ? "otel_sdk_disabled" : "otel_not_enabled",
    };
  }

  if (tracesExporter === "none") {
    return {
      configured: true,
      requested: false,
      enabled: false,
      serviceName,
      exporter: "none",
      reason: "otel_traces_exporter_none",
    };
  }

  if (tracesExporter !== "otlp") {
    return {
      configured: true,
      requested,
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
      requested,
      enabled: false,
      serviceName,
      exporter: "otlp-http",
      reason: "missing_otlp_trace_endpoint",
    };
  }

  return {
    configured: true,
    requested: true,
    enabled: true,
    serviceName,
    exporter: "otlp-http",
    endpoint,
    resourceAttributes: buildResourceAttributes({ env, serviceName, deploymentEnvironment }),
    reason: "ready",
  };
}

// Resolve the OTel sampler from env. Mirrors the OTel-spec env vars so
// ops can dial sampling globally without code changes.
//
//   OTEL_TRACES_SAMPLER       = always_on | always_off | traceidratio |
//                               parentbased_always_on (default) |
//                               parentbased_always_off |
//                               parentbased_traceidratio
//   OTEL_TRACES_SAMPLER_ARG   = ratio in [0, 1] for ratio-based samplers
//
// Defaulting to parentbased_always_on preserves today's behavior (sample
// every root span) while still respecting upstream sampling decisions
// when our service is downstream of an already-sampled trace.
function resolveSampler(env = process.env) {
  const raw = String(env.OTEL_TRACES_SAMPLER || 'parentbased_always_on')
    .trim()
    .toLowerCase();
  const arg = Number.parseFloat(env.OTEL_TRACES_SAMPLER_ARG);
  const ratio = Number.isFinite(arg) ? Math.min(Math.max(arg, 0), 1) : 1;

  let sdkTrace;
  try {
    sdkTrace = require('@opentelemetry/sdk-trace-base');
  } catch (_err) {
    return { sampler: null, kind: raw, ratio };
  }

  const {
    AlwaysOnSampler,
    AlwaysOffSampler,
    ParentBasedSampler,
    TraceIdRatioBasedSampler,
  } = sdkTrace;

  switch (raw) {
    case 'always_on':
      return { sampler: new AlwaysOnSampler(), kind: raw, ratio: 1 };
    case 'always_off':
      return { sampler: new AlwaysOffSampler(), kind: raw, ratio: 0 };
    case 'traceidratio':
      return { sampler: new TraceIdRatioBasedSampler(ratio), kind: raw, ratio };
    case 'parentbased_always_off':
      return {
        sampler: new ParentBasedSampler({ root: new AlwaysOffSampler() }),
        kind: raw,
        ratio: 0,
      };
    case 'parentbased_traceidratio':
      return {
        sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(ratio) }),
        kind: raw,
        ratio,
      };
    case 'parentbased_always_on':
    default:
      return {
        sampler: new ParentBasedSampler({ root: new AlwaysOnSampler() }),
        kind: 'parentbased_always_on',
        ratio: 1,
      };
  }
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
        return (
          isMetricsRequest(req) ||
          url.startsWith("/health")
        );
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
    requested: config.requested,
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

    const samplerConfig = resolveSampler(env);
    sdk = new NodeSDK({
      resource: resourceFromAttributes(config.resourceAttributes),
      traceExporter: new OTLPTraceExporter({ url: config.endpoint }),
      ...(samplerConfig.sampler ? { sampler: samplerConfig.sampler } : {}),
      instrumentations: [getNodeAutoInstrumentations(createInstrumentationConfig())],
    });
    state.sampler = samplerConfig.kind;
    state.samplerRatio = samplerConfig.ratio;

    sdk.start();
    state = {
      configured: true,
      requested: true,
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
      requested: true,
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
    requested: Boolean(state.requested),
    enabled: Boolean(state.enabled),
    started: Boolean(state.started),
    service_name: state.serviceName || DEFAULT_SERVICE_NAME,
    exporter: state.exporter || "none",
    reason: state.reason || "unknown",
  };

  if (state.error) details.error = state.error;
  if (state.sampler) {
    details.sampler = state.sampler;
    if (typeof state.samplerRatio === 'number') details.sampler_ratio = state.samplerRatio;
  }
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
  resolveSampler,
  shutdownOpenTelemetry,
  startOpenTelemetry,
};
