require('dotenv').config();

// ── EventTarget listener cap ───────────────────────────────
// AbortSignals are shared across many concurrent operations
// (per-attempt LLM retries, tool calls inside long agent runs,
// token-bulkhead waiters, model-fallback-cascade) and a single
// long-running task can legitimately attach 10+ 'abort' listeners
// to the same parent signal. Node's default cap of 10 fires a
// `MaxListenersExceededWarning` even though every listener is
// removed on cleanup. Raise the EventTarget default to 30 so the
// noise stops; real leaks would grow unbounded and still warn.
try {
    const events = require('events');
    if (typeof events.setMaxListeners === 'function') {
        events.setMaxListeners(30);
    }
    events.EventEmitter.defaultMaxListeners = 30;
} catch { /* node <15 — ignore */ }

// ── Agent platform bootstrap ────────────────────────────────
// Initialises the new platform services (provider-registry,
// bulkhead pool, structured-logger, performance-tracer,
// sub-agent-orchestrator) before the server accepts traffic.
const { initAgentSystem } = require('./src/services/agents/agent-system');
initAgentSystem();

// ── Config validation (cycle 34) ───────────────────────────
// Validates required env vars per-environment (dev/staging/prod)
// and warns on common cross-field misconfigurations such as
// NODE_ENV=production with DATABASE_URL pointing to localhost.
// Runs BEFORE any service init so a misconfigured prod boot
// fails fast with a clear error.
const { validateConfigOrExit } = require('./src/utils/config-validator');
validateConfigOrExit(process.env);

// ── Startup validation ─────────────────────────────────────
// Catches placeholder secrets, missing required env vars, and
// dangerous configurations before the server accepts traffic.
// Blocking issues call process.exit(1); warnings are logged.
const { validateStartupEnvironment } = require('./src/utils/startup-validator');
validateStartupEnvironment(process.env, { failOnBlocking: true });

// ── Process-level error handlers ───────────────────────────
// Prevent the process from silently crashing on unhandled
// rejections or uncaught exceptions. In production, log and
// exit gracefully; in development, dump the stack.
// Throttle for transient Redis rejection logging — Upstash quota
// hits fire many rejections per second; we keep a single warn per
// minute and a suppressed-count so the log stays useful.
let _redisSwallowLastLog = 0;
let _redisSwallowSuppressed = 0;
const REDIS_SWALLOW_WINDOW_MS = 60_000;
process.on('unhandledRejection', (reason, promise) => {
    // Transient Redis errors (Upstash quota, connection blips, etc.)
    // surface here from BullMQ internals. Log as warning and keep
    // serving — the worker will retry once Redis recovers.
    let isTransientRedis = false;
    try {
        const { isTransientRedisError } = require('./src/services/agents/redis-resilience');
        isTransientRedis = isTransientRedisError(reason);
    } catch (_) { /* module not loaded yet — fall through to FATAL path */ }
    if (isTransientRedis) {
        _redisSwallowSuppressed += 1;
        const now = Date.now();
        if (now - _redisSwallowLastLog >= REDIS_SWALLOW_WINDOW_MS) {
            _redisSwallowLastLog = now;
            const extra = _redisSwallowSuppressed > 1 ? ` (+${_redisSwallowSuppressed - 1} suppressed in last 60s)` : '';
            const msg = reason && reason.message ? reason.message : String(reason);
            console.warn(`[redis] swallowed transient rejection${extra}:`, msg);
            _redisSwallowSuppressed = 0;
        }
        return;
    }
    const reasonStr =
        reason instanceof Error
            ? `${reason.name}: ${reason.message}${reason.stack ? '\n' + reason.stack : ''}`
            : String(reason);
    console.error('[FATAL] unhandledRejection:', reasonStr);
    // In production, log and continue (let PM2/Docker restart if
    // the process becomes unhealthy). In development, exit hard.
    if (process.env.NODE_ENV !== 'production') {
        process.exitCode = 1;
    }
});

process.on('uncaughtException', (error) => {
    console.error('[FATAL] uncaughtException:', error);
    // Always exit on uncaught exceptions — the process is in an
    // unknown state. PM2 / Docker will restart automatically.
    process.exitCode = 1;
    // Let the process exit naturally (don't force-kill) so pending
    // logs flush. Short timeout as a safety net.
    setTimeout(() => process.exit(1), 2000).unref();
});

const {
    getOpenTelemetryStatus,
    shutdownOpenTelemetry,
    startOpenTelemetry,
} = require('./src/services/observability/otel');
startOpenTelemetry();
const {
    captureException: captureSentryException,
    getSentryStatus,
    startSentry,
} = require('./src/services/observability/sentry');
startSentry();
const {
    getLangfuseStatus,
    shutdownLangfuse,
    startLangfuse,
} = require('./src/services/observability/langfuse');
startLangfuse();
const {
    getPostHogStatus,
    shutdownPostHog,
    startPostHog,
} = require('./src/services/observability/posthog');
startPostHog();

// ── Internal Orchestration Layer ───────────────────────────────
// Initialises the LLM Gateway (multi-provider with circuit breakers,
// semantic caching, Langfuse tracing), memory adapter (pgvector +
// long-term memory bridge), R2 artifact storage, LangGraph
// orchestrator, and AI bridge. These are attached to
// `app.locals.orchestration` so every route can access them.
// All modules are fail-soft: missing API keys or unavailable deps
// degrade gracefully rather than crashing the process.
let _orchestration = null;
function initOrchestration() {
    if (_orchestration) return _orchestration;
    try {
        const { LLMGateway } = require('./src/orchestration/llm-gateway');
        const { createLangGraphOrchestrator } = require('./src/orchestration/langgraph-engine');
        const { createMemoryAdapter } = require('./src/orchestration/memory-adapter');
        const { createR2ArtifactStorage } = require('./src/orchestration/r2-storage');
        const { attachSSEStream, createSSEReplayBuffer } = require('./src/orchestration/sse-stream');
        const { searchFreshContext, needsFreshWebContext } = require('./src/orchestration/web-search-tools');
        const { createAIBridge } = require('./src/orchestration/ai-bridge');

        const gateway = new LLMGateway();
        const memory = createMemoryAdapter();
        const r2 = createR2ArtifactStorage();
        const sseReplayBuffer = createSSEReplayBuffer();

        const orchestrator = createLangGraphOrchestrator({ gateway });

        const bridge = createAIBridge({
            gateway,
            memory,
            search: { searchFreshContext, needsFreshWebContext },
            sse: { attachSSEStream, buffer: sseReplayBuffer },
        });

        _orchestration = {
            gateway,
            orchestrator,
            memory,
            r2,
            bridge,
            sse: { attachSSEStream, createSSEReplayBuffer, buffer: sseReplayBuffer },
            search: { searchFreshContext, needsFreshWebContext },
            configured: {
                gateway: true,
                r2: r2.enabled,
                memory: true,
            },
        };
        console.log('[orchestration] LLM Gateway + LangGraph + Memory + R2 + SSE + AI Bridge initialised');
    } catch (err) {
        console.warn('[orchestration] initialisation failed (degraded mode):', err.message);
        _orchestration = {
            gateway: null,
            orchestrator: null,
            memory: null,
            r2: null,
            bridge: null,
            sse: null,
            search: null,
            configured: { gateway: false, r2: false, memory: false },
        };
    }
    return _orchestration;
}

// Patches Express 4.x to forward async rejections to the error
// handler automatically. Must be required BEFORE the express import.
require('express-async-errors');

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const passport = require('./src/config/passport');
const { bigintSerializerMiddleware } = require('./src/utils/bigint-serializer');

const prisma = require('./src/config/database');
const authRoutes = require('./src/routes/auth');
const chatRoutes = require('./src/routes/chats');
const fileRoutes = require('./src/routes/files');
const aiRoutes = require('./src/routes/ai');
const documentGenerateAiRoutes = require('./src/routes/generate-document');

const paymentRoutes = require('./src/routes/payments');
const adminRoutes = require('./src/routes/admin');
const adminQueuesRoutes = require('./src/routes/admin-queues');
const adminConnectionsRoutes = require('./src/routes/admin-connections');
const userRoutes = require('./src/routes/users');
const legalRoutes = require('./src/routes/legal');
const publicRoutes = require('./src/routes/public');
const downloadRoutes = require('./src/routes/download');
const elevenlabsRoutes = require('./src/routes/elevenlabs');
const searchRoutes = require('./src/routes/search');
const bookmarksRoutes = require('./src/routes/bookmarks');
const orgsRoutes = require('./src/routes/orgs');
const videoRoutes = require('./src/routes/video');
const gptsRoutes = require('./src/routes/gpts');
const libraryRoutes = require('./src/routes/library');
const apiProxyRoutes = require('./src/routes/api');
const gmailRoutes = require('./src/routes/gmail');
const spotifyRoutes = require('./src/routes/spotify');
const figmaRoutes = require('./src/routes/figma');
const { router: computerUseRoutes, initializeWebSocketServer } = require('./src/routes/computer-use');
const { initRealtimeServer, closeRealtimeServer } = require('./src/services/realtime/socket-server');
const thesisRoutes = require('./src/routes/thesis');
const researchRoutes = require('./src/routes/research');
const scientificSearchRoutes = require('./src/routes/scientific-search');
const researchAgentRoutes = require('./src/routes/research-agent');
const ragRoutes = require('./src/routes/rag');
const agentRoutes = require('./src/routes/agent');
const agentTaskRoutes = require('./src/routes/agent-task');
const agentBatchRoutes = require('./src/routes/agent-batch');
const seAgentsRoutes = require('./src/routes/se-agents');
const searchBrainRoutes = require('./src/routes/search-brain');
const searchBrainUniversalRoutes = require('./src/routes/search-brain-universal');
const { createUploadStaticAccessGuard } = require('./src/middleware/upload-static-access');
const searchAgenticRoutes = require('./src/routes/search-agentic');
const artifactsRoutes = require('./src/routes/artifacts');
const hooksRoutes = require('./src/routes/hooks');
const agentKeysRoutes = require('./src/routes/agent-keys');
const projectsRoutes = require('./src/routes/projects');
const marcoTeoricoRoutes = require('./src/routes/marco-teorico');
const projectDocumentsRoutes = require('./src/routes/project-documents');
const designRoutes = require('./src/routes/design');
const planRoutes = require('./src/routes/plan');
const computeRoutes = require('./src/routes/compute');
const mathRoutes = require('./src/routes/math');
const vizRoutes = require('./src/routes/viz');
const docRoutes = require('./src/routes/doc');
const artifactRoutes = require('./src/routes/artifact');
const enterpriseRoutes = require('./src/routes/enterprise');
const socialPostsRoutes = require('./src/routes/social-posts');
const githubCodexRoutes = require('./src/routes/github-codex');
const pushRoutes = require('./src/routes/push');
const coworkRoutes = require('./src/routes/cowork');
const orchestrationRoutes = require('./src/routes/orchestration');
const webhooksRoutes = require('./src/routes/webhooks');
const slackIntegrationRoutes = require('./src/routes/integrations/slack');
const { authenticateToken, requireAdmin, requireSuperAdmin } = require('./src/middleware/auth');
const scheduler = require('./src/services/scheduler/scheduler');
const { runAgent } = require('./src/services/agents/agent-entry');
const { recoverAgentTasksAfterBoot } = require('./src/services/agents/agent-task-boot-recovery');
const { startAgentTaskWorker, closeAgentTaskWorker } = require('./src/services/agents/agent-task-worker');
const { closeAgentTaskQueue } = require('./src/services/agents/agent-task-queue');
const alerting = require('./src/services/alerting');
const sloTracker = require('./src/services/slo-tracker');
const shutdownRegistry = require('./src/utils/shutdown');
const telemetryRoutes = require('./src/routes/telemetry');

const app = express();
const PORT = process.env.PORT || 5000;
app.set('trust proxy', 1)

// Security middleware. CSP defaults to report-only mode so a fresh
// deploy never breaks inline content; operators tighten the policy
// after observing reports for a few days. See csp-policy.js for the
// directive shape and the CSP_* env knobs.
const { resolveCspConfig, buildCspDirectives } = require('./src/middleware/csp-policy');
const cspConfig = resolveCspConfig(process.env);
// In development we skip CSP entirely to avoid breaking Next.js HMR /
// inline runtime that injects scripts on every reload. In production we
// honor the configured CSP (still report-only by default — see
// csp-policy.js). HSTS is opt-in to production because the dev server
// runs over plain http://localhost. frameguard 'deny' on top of the
// frame-ancestors CSP directive protects browsers that still honor the
// legacy X-Frame-Options header.
const isProduction = process.env.NODE_ENV === 'production';
const cspMiddlewareConfig = (() => {
    if (!cspConfig.enabled) return false;
    if (!isProduction && process.env.CSP_ENABLED !== '1' && process.env.CSP_ENABLED !== 'true') {
        // dev / test: skip CSP so HMR + Next.js eval'd chunks keep working
        return false;
    }
    return {
        directives: buildCspDirectives(cspConfig),
        reportOnly: cspConfig.reportOnly,
    };
})();
app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    contentSecurityPolicy: cspMiddlewareConfig,
    frameguard: { action: 'deny' },
    hidePoweredBy: true,
    hsts: isProduction ? {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true,
    } : false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

// Idempotency — Stripe-style replay support for POST/PUT/PATCH.
// Disabled by default (IDEMPOTENCY_ENABLED=true to activate).
// Mounted EARLY (after rate limit, before route handlers) so a
// replay short-circuits the heavy work. See idempotency.js for the
// tenant-scoping + 2xx-only caching contract.
const { idempotencyMiddleware } = require('./src/middleware/idempotency');
const idempotency = idempotencyMiddleware();

// Rate limiting — tiered by route sensitivity. See rate-limit-policy.js
// for the env-var parsing + defaults. Counters live in-process by
// design: the readiness probe gates traffic when Redis is unhealthy,
// so a Redis-backed counter would have a chicken-and-egg problem on
// cold start. When the platform moves to multi-instance horizontal
// scaling, swap to `rate-limit-redis` (small, Apache-2.0, vetted).
//
// Order matters in Express: more specific path prefixes are mounted
// FIRST so they can apply tighter budgets. The catch-all `/api/`
// limiter skips those route families to avoid double-counting a
// single request across two express-rate-limit instances.
//
// Bucketing key: see makeJwtAwareKeyGenerator in rate-limit-policy.js.
// Authenticated requests are bucketed by user-id (`user:<id>`); anon
// or invalid-token requests fall back to IP. This makes "PRO users
// get more headroom" actually mean something even for users behind
// shared NATs / corporate proxies, where IP-only bucketing collapsed
// every paying customer into one quota.
const {
    resolveRateLimitConfig,
    makeJwtAwareKeyGenerator,
    makeSuperAdminBypass,
} = require('./src/middleware/rate-limit-policy');
const { createRateLimitStore } = require('./src/middleware/rate-limit-store');
const rateLimitCfg = resolveRateLimitConfig(process.env);
const rateLimitKeyGenerator = makeJwtAwareKeyGenerator(process.env.JWT_SECRET);
// Super admins (verified via JWT claim `isSuperAdmin: true`) are
// exempt from every limiter. Operators need to investigate user
// reports without being throttled by the very protection they
// designed for end users. The bypass function is shared by all
// three tiers (auth / expensive / api) so the policy is uniform.
const skipForSuperAdmin = makeSuperAdminBypass(process.env.JWT_SECRET);

// Redis-backed shared counters when REDIS_URL is set; in-memory
// fallback for local dev / single-instance deploys. See
// rate-limit-store.js for the chicken-and-egg discussion. We log
// the resolved mode in the listen() callback so the operator can
// confirm at boot which store is active.
const rateLimitStoreInfo = createRateLimitStore(process.env);

// Common options shared across the three tiers — keyGenerator,
// fail-open posture, and modern RateLimit-* headers. Redis stores
// are created per limiter because express-rate-limit requires a
// distinct Store instance for each bucket.
const baseLimiterCommon = {
    keyGenerator: rateLimitKeyGenerator,
    standardHeaders: true,
    legacyHeaders: false,
    // If the Redis store throws (network blip, Redis restarting),
    // let the request through rather than 500-ing the API. Pair this
    // with operator alerts on the health probe — a sustained Redis
    // outage is a real incident, but a transient blip should not
    // break user-facing chat.
    passOnStoreError: true,
};

function makeLimiterCommon(bucket) {
    const options = { ...baseLimiterCommon };
    const prefixBase = process.env.RATE_LIMIT_REDIS_PREFIX || 'rl:';
    const bucketStoreInfo = createRateLimitStore(process.env, {
        prefix: `${prefixBase}${bucket}:`,
    });
    if (bucketStoreInfo.store) {
        options.store = bucketStoreInfo.store;
    }
    return options;
}

// Anti-bruteforce: login / register / password reset / OAuth callbacks.
const authLimiter = rateLimit({
    ...makeLimiterCommon('auth'),
    windowMs: rateLimitCfg.windowMs,
    max: rateLimitCfg.auth,
    skip: skipForSuperAdmin,
    message: 'Too many auth attempts, please try again later.',
});

// Expensive endpoints — agent task creation, RAG indexing, document
// generation. These spawn background workers and consume LLM tokens.
const expensiveLimiter = rateLimit({
    ...makeLimiterCommon('expensive'),
    windowMs: rateLimitCfg.windowMs,
    max: rateLimitCfg.expensive,
    skip: skipForSuperAdmin,
    message: 'Too many expensive operations, please slow down.',
});

// Default API limit — covers polling endpoints (model lists, plan
// status, history) without giving abuse scripts a free ride.
const apiLimiterSpecificPrefixes = [
    '/api/auth',
    '/api/agent',
    '/api/rag',
    '/api/document-ai',
];
const apiLimiter = rateLimit({
    ...makeLimiterCommon('api'),
    windowMs: rateLimitCfg.windowMs,
    max: rateLimitCfg.api,
    skip: (req) => {
        if (skipForSuperAdmin(req)) return true;
        return apiLimiterSpecificPrefixes.some((prefix) => req.originalUrl.startsWith(prefix));
    },
    message: 'Too many requests, please try again later.',
});

// CORS allowlist — resolved once at startup. See cors-policy.js for
// the fail-closed-in-production semantics and the localhost dev
// fallback. This must run before route rate-limiters so browser
// preflight requests receive Access-Control-* headers before any
// auth-specific middleware can short-circuit the response.
const { resolveAllowedOrigins, makeOriginCallback } = require('./src/middleware/cors-policy');
const ALLOWED_ORIGINS = resolveAllowedOrigins(process.env);
app.use(cors({
    origin: makeOriginCallback(ALLOWED_ORIGINS),
    credentials: true,
    optionsSuccessStatus: 200,
}));

app.use('/api/auth', authLimiter);
app.use('/api/agent', expensiveLimiter);
app.use('/api/rag', expensiveLimiter);
app.use('/api/document-ai', expensiveLimiter);
app.use('/api/ai/generate', expensiveLimiter);
app.use('/api/', apiLimiter);

// Idempotency runs AFTER rate-limit (so a flood of replays still
// costs the limiter quota). It is mounted scoped to the agent task
// and tool-call surfaces below — see app.use('/api/agent', idempotency)
// further down — so the body-hash check can read req.body which
// requires express.json to have parsed it first.

// Structured request logger — one JSON line per response. Mounted
// BEFORE body-parser so even malformed-body responses are logged. Also
// generates `req.id` if no upstream middleware set it.
const requestLogger = require('./src/middleware/request-logger');
app.use(requestLogger);

// HTTP metrics middleware — records siragpt_http_requests_total and
// siragpt_http_request_duration_seconds for every request except
// /metrics itself (to avoid scrape-induced cardinality).
const siraMetrics = require('./src/utils/metrics');
app.use((req, res, next) => {
    if (req.path === '/metrics') return next();
    const startNs = process.hrtime.bigint();
    res.on('finish', () => {
        try {
            const route = (req.route && req.route.path)
                || (req.baseUrl ? `${req.baseUrl}${req.route ? req.route.path : ''}` : '')
                || req.path
                || 'unmatched';
            const durSeconds = Number(process.hrtime.bigint() - startNs) / 1e9;
            siraMetrics.counter('siragpt_http_requests_total', {
                method: req.method,
                route,
                status: String(res.statusCode),
            });
            siraMetrics.observe('siragpt_http_request_duration_seconds', {
                method: req.method,
                route,
            }, durSeconds);
        } catch { /* never throw from instrumentation */ }
    });
    next();
});

// Body parsing middleware
app.use(compression({
    filter: (req, res) => {
        // Agar response 'text/event-stream' ya 'video/mp4' hai, to usse compress mat karo
        const contentType = res.getHeader('Content-Type');
        if (contentType === 'text/event-stream' || contentType === 'video/mp4') {
            return false;
        }
        // Baaki sab responses ko compress karo
        return compression.filter(req, res);
    }
}));
// Payload-size enforcement — rejects oversized requests BEFORE body-parser
// buffers the bytes. 1 MB JSON, 250 MB multipart (upload-heavy routes).
// Mounted early so oversized spam never reaches downstream handlers.
const validatePayloadSize = require('./src/middleware/validate-payload-size');
app.use(validatePayloadSize({ jsonBytes: 1 * 1024 * 1024, multipartBytes: 250 * 1024 * 1024 }));
app.use('/api/payments/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cookieParser());

// BigInt serialization middleware
app.use(bigintSerializerMiddleware);

// ── Input sanitizer (XSS + prompt injection) ─────────────────────
const { createInputSanitizer } = require('./src/middleware/input-sanitizer');
const inputSanitizerMode = process.env.SIRAGPT_INPUT_SANITIZER_MODE === 'block' ? 'block' : 'off';
app.use(createInputSanitizer({ mode: inputSanitizerMode }));

// ── Attach orchestration layer to app.locals ────────────────────
// Routes access orchestration via req.app.locals.orchestration.
// Initialised once at boot; lazy module loading means missing deps
// won't crash the process (degraded mode logged above).
const orchestration = initOrchestration();
app.locals.orchestration = orchestration;
app.locals.orchestrationInitialised = true;

// Session configuration for Google OAuth. With REDIS_URL set, sessions
// persist across PM2 restarts and survive multi-instance scaling.
// Without it, fall back to the in-process memory store (dev/CI only —
// in prod this drops every user's session on each backend reload).
const sessionConfig = {
    secret: process.env.SESSION_SECRET || 'your-session-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: process.env.NODE_ENV === 'production' },
};
if (process.env.REDIS_URL) {
    const RedisStore = require('connect-redis').default;
    const Redis = require('ioredis');
    const redisClient = new Redis(process.env.REDIS_URL, {
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
    });
    redisClient.on('error', (err) => {
        console.error('[session-store] Redis error:', err.message);
    });
    sessionConfig.store = new RedisStore({ client: redisClient, prefix: 'siragpt:sess:' });
}
app.use(session(sessionConfig));

// Passport middleware
app.use(passport.initialize());
app.use(passport.session());

// ── CSRF double-submit protection for cookie-auth routes ──────────
// Mounted AFTER cookie-parser + session + passport so cookies are
// readable and user context is available. Bearer-auth requests are
// auto-bypassed (browsers don't auto-send Authorization cross-origin).
// Disabled in test env via CSRF_DISABLED=1.
const { requireCsrf } = require('./src/middleware/csrf');
app.use('/api/auth', requireCsrf);
app.use('/api/users', requireCsrf);
app.use('/api/chats', requireCsrf);
app.use('/api/files', requireCsrf);
app.use('/api/projects', requireCsrf);
app.use('/api/payments', requireCsrf);
app.use('/api/bookmarks', requireCsrf);
app.use('/api/orgs', requireCsrf);
app.use('/api/library', requireCsrf);
app.use('/api/cowork', requireCsrf);
app.use('/api/thesis', requireCsrf);

// ── XSS / prompt-injection sanitization ──────────────────────────
// Recursively strips script tags, event handlers, and javascript: URIs
// from req.body, req.query and req.params. Runs AFTER body parsing so
// req.body is populated. Safe methods (GET/HEAD/OPTIONS) skip body
// sanitization but query/params are still cleaned.
const xssSanitize = require('./src/middleware/xss-sanitize');
app.use(xssSanitize);

// Logging
// Structured JSON logger runs in every environment and auto-attaches
// `req.id` for correlation; downstream code can use `req.log.info(...)`
// to inherit that id. Morgan stays in dev for the familiar coloured
// per-request line during local development.
const { logger, httpLogger } = require('./src/middleware/logger');
app.use(httpLogger);
// Pin req.id onto req.requestId / res.locals.requestId and echo it
// back as `X-Request-Id`. Must run *after* httpLogger so req.id is
// already populated, and *before* route handlers so the header is on
// every response (including errors).
const { requestIdMiddleware } = require('./src/middleware/request-id');
app.use(requestIdMiddleware);
const { otelRequestContextMiddleware } = require('./src/middleware/otel-request-context');
app.use(otelRequestContextMiddleware);
// RED method (Rate, Errors, Duration) per matched route. Sits after
// otel context so the active span is in scope and before route mounting
// so every endpoint is observed. Cost is one Map lookup + one histogram
// observation per response.
const { redMetricsMiddleware } = require('./src/middleware/red-metrics');
app.use(redMetricsMiddleware);

// SLO tracker — records per-endpoint counters used by /metrics. Must
// run after request-id/otel context (set above) so the matched route
// is available on res.on('finish').
app.use(sloTracker.middleware());

// ── Maintenance-mode middleware (ratchet 45) ────────────────────
// Reads SystemSettings.maintenance_mode and short-circuits every
// request with 503 when enabled. /health/* and /api/admin/* are
// bypassed so probes + super-admin toggle keep working.
const maintenanceMode = require('./src/middleware/maintenance-mode');
maintenanceMode.setPrisma(prisma);
app.use(maintenanceMode.maintenanceMiddleware({ prisma }));

if (process.env.NODE_ENV !== 'production') {
    app.use(morgan('dev'));
}

// Static files + hardened presentation downloads
const uploadsDir = path.join(__dirname, 'uploads');
const presentationsDir = path.join(uploadsDir, 'presentations');

app.get('/uploads/presentations/:filename/download', async (req, res) => {
    const filename = path.basename(req.params.filename || '');
    if (!filename || /[\\/]/.test(filename) || !/\.pptx$/i.test(filename)) {
        return res.status(400).json({ error: 'Invalid presentation filename' });
    }

    const filePath = path.join(presentationsDir, filename);
    if (!filePath.startsWith(presentationsDir + path.sep)) {
        return res.status(400).json({ error: 'Invalid presentation path' });
    }

    try {
        await fs.promises.access(filePath, fs.constants.R_OK);
        res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length, Content-Type');
        res.download(filePath, filename);
    } catch {
        res.status(404).json({ error: 'Presentation not found' });
    }
});

app.use('/uploads', createUploadStaticAccessGuard({ uploadsDir, prisma }));
app.use('/uploads', express.static(uploadsDir, {
    setHeaders: (res, filePath) => {
        res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length, Content-Type');
        if (/\.pptx$/i.test(filePath)) {
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
        }
    }
}));


// ── Health probes ───────────────────────────────────────────────
// Three endpoints for three different operational consumers:
//   /health        → composite (all checks + ops info). 503 when any
//                    critical check is unhealthy.
//   /health/live   → liveness (process up). Always 200 unless the
//                    process is past the point of being able to serve.
//   /health/ready  → readiness (DB + Redis + queue + process). Used
//                    by the load balancer / k8s readiness probe.
//
// A dedicated, lazy IORedis client is used only for the health probe
// so a flaky Redis can't poison the live BullMQ queue connection.
const {
    runLivenessCheck,
    runReadinessCheck,
    runFullHealthCheck,
    reportToHttpStatus,
} = require('./src/services/observability/health-check');

const coworkHealth = require('./src/services/cowork-health');

// ── Health-check result cache ──────────────────────────────
// Prevents /health and /health/ready from hammering the DB on
// every request when monitoring systems poll aggressively.
// Cache is TTL-based: stale entries trigger a fresh probe.
// Liveness (/health/live) is NEVER cached — it must always
// reflect the current process state.
const healthCache = new Map();
const HEALTH_CACHE_TTL_MS = parseInt(process.env.HEALTH_CACHE_TTL_MS || '5000', 10); // 5s default

async function getCachedOrFresh(cacheKey, fetcher) {
    const cached = healthCache.get(cacheKey);
    if (cached && (Date.now() - cached.at) < HEALTH_CACHE_TTL_MS) {
        return cached.report;
    }
    const report = await fetcher();
    healthCache.set(cacheKey, { at: Date.now(), report });
    // Prevent unbounded growth (should never exceed 2-3 entries in practice)
    if (healthCache.size > 10) {
        const now = Date.now();
        for (const [key, entry] of healthCache) {
            if ((now - entry.at) > HEALTH_CACHE_TTL_MS * 2) healthCache.delete(key);
        }
    }
    return report;
}

// Health cache is only used for probes that touch I/O (readiness,
// full health). Liveness is always fresh.

let _healthRedisClient = null;
function getHealthRedisClient() {
    if (!process.env.REDIS_URL) return null;
    if (_healthRedisClient) return _healthRedisClient;
    try {
        const IORedis = require('ioredis');
        _healthRedisClient = new IORedis(process.env.REDIS_URL, {
            lazyConnect: true,
            // Health check ping should not retry — a stuck Redis IS the
            // signal we want to surface. One attempt, fail fast.
            maxRetriesPerRequest: 1,
            enableReadyCheck: false,
            connectTimeout: 2000,
        });
        // Swallow background errors. The health probe will still observe
        // the connection state on the next ping().
        _healthRedisClient.on('error', () => {});
        return _healthRedisClient;
    } catch (_e) {
        return null;
    }
}

app.get('/health/live', (_req, res) => {
    const report = runLivenessCheck();
    res.status(reportToHttpStatus(report)).json(report);
});

app.get('/health/ready', async (_req, res) => {
    const report = await getCachedOrFresh('ready', () => runReadinessCheck({
        prisma,
        redis: getHealthRedisClient(),
        queue: null,
    }));
    res.status(reportToHttpStatus(report)).json(report);
});

app.get('/health', async (_req, res) => {
    const report = await getCachedOrFresh('full', () => runFullHealthCheck({
        prisma,
        redis: getHealthRedisClient(),
        queue: null,
        telemetry: getOpenTelemetryStatus(),
        sentry: getSentryStatus(),
        langfuse: getLangfuseStatus(),
        posthog: getPostHogStatus(),
        coworkHealth,
    }));
    res.status(reportToHttpStatus(report)).json(report);
});

// ── Prometheus metrics ──────────────────────────────────────────
// Single scrape endpoint for the entire process. Both SE-agent
// counters (registered in services/agents/metrics.js) and Sira
// pipeline counters (registered in services/sira/metrics.js — via
// require side-effect below) export through one renderer.
const observabilityMetrics = require('./src/services/agents/metrics');
require('./src/services/sira/metrics');

function isLocalMetricsCaller(req) {
    const ip = (req.ip || (req.socket && req.socket.remoteAddress) || '').toString();
    if (!ip) return false;
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true;
    return ip.startsWith('::ffff:127.');
}

function runMiddlewareChain(req, res, middlewares) {
    return new Promise((resolve, reject) => {
        let index = 0;
        const step = (err) => {
            if (err) return reject(err);
            if (res.headersSent) return resolve(false);
            if (index >= middlewares.length) return resolve(true);
            const middleware = middlewares[index++];
            try {
                middleware(req, res, step);
            } catch (error) {
                reject(error);
            }
        };
        step();
    });
}

async function guardMetricsAccess(req, res) {
    if (isLocalMetricsCaller(req)) return true;
    try {
        const allowed = await runMiddlewareChain(req, res, [authenticateToken, requireAdmin, requireSuperAdmin]);
        return Boolean(allowed) && !res.headersSent;
    } catch (err) {
        if (!res.headersSent) {
            res.status(500).json({ error: 'metrics auth failed', detail: err.message });
        }
        return false;
    }
}

async function renderPromMetrics(req, res) {
    const allowed = await guardMetricsAccess(req, res);
    if (!allowed) return;
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(observabilityMetrics.renderText());
}
app.get('/metrics', renderPromMetrics);
// Operator-facing alias under /internal/* — keeps the public surface
// area predictable when ops only allow-list the internal path through
// the ingress (and blackholes /metrics from the edge).
app.get('/internal/metrics', renderPromMetrics);

// ── Interactive API documentation ───────────────────────────────
// Renders the OpenAPI 3.1 spec (built by services/contracts/
// schema-registry.js) into Swagger UI at /api-docs. Default ON in
// non-production, OFF in production unless API_DOCS_ENABLED=true.
// See backend/src/routes/api-docs.js for the env-gate semantics
// and docs/api-docs.md for the operator runbook.
const { buildApiDocsRouter } = require('./src/routes/api-docs');
app.use('/api-docs', buildApiDocsRouter());
// Alias under /api/docs — same env-gate, same Swagger UI. Kept as a
// separate router instance so the two surfaces are independently
// observable in access logs / metrics (one router per mount point).
app.use('/api/docs', buildApiDocsRouter());

// ── /api/version ────────────────────────────────────────────────
// Small public probe returning frontend + backend semver, the git
// commit (env-injected or `git rev-parse` fallback), boot wall-clock
// and the node runtime. Mounted ABOVE the rate-limited /api/ block
// because it predates /api/auth/etc. and is intentionally cheap.
const versionRouter = require('./src/routes/version');
app.use('/api/version', versionRouter);

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/chats', chatRoutes);
app.use('/api/files', fileRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/admin/queues', adminQueuesRoutes);
app.use('/api/admin/connections', adminConnectionsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/users', userRoutes);
app.use('/api/legal', legalRoutes);
app.use('/api/public', publicRoutes);
app.use('/api/download', downloadRoutes);
app.use('/api/elevenlabs', elevenlabsRoutes);
app.use('/api/video', videoRoutes);
app.use('/api/search', searchAgenticRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/bookmarks', bookmarksRoutes);
app.use('/api/orgs', orgsRoutes);
app.use('/api/search-brain', searchBrainRoutes);
app.use('/api/search-brain/universal', searchBrainUniversalRoutes);
app.use('/api/gpts', gptsRoutes); // Add GPTs API routes
app.use('/api/library', libraryRoutes);
app.use('/api/proxy', apiProxyRoutes);
app.use('/api/gmail', gmailRoutes);
app.use('/api/spotify', spotifyRoutes);
app.use('/api/figma', figmaRoutes);
app.use('/api/computer-use', computerUseRoutes);
app.use('/api/thesis', thesisRoutes);
app.use('/api/research', researchRoutes);
app.use('/api/scientific-search', scientificSearchRoutes);
app.use('/api/research-agent', researchAgentRoutes);
app.use('/api/rag', ragRoutes);
// Idempotency is scoped to the surfaces that mutate durable state
// at real cost (LLM tokens, sandbox compute, queued workers): agent
// task creation and tool-call execution. Mount sits after body
// parsing so the middleware can fingerprint req.body for the 409
// "key reused with different body" check.
app.use('/api/agent', idempotency);
app.use('/api/agent', agentTaskRoutes);
app.use('/api/agent', agentBatchRoutes);
app.use('/api/agent', agentRoutes);
app.use('/api/se-agents', seAgentsRoutes);
app.use('/api/artifacts', artifactsRoutes);
app.use('/api/document-ai', documentGenerateAiRoutes);
app.use('/api/hooks', hooksRoutes);
app.use('/api/agent/keys', agentKeysRoutes);
app.use('/api/projects', projectsRoutes);
// Marco Teórico nested under project id — the router uses
// mergeParams:true to inherit :projectId from this mount path.
app.use('/api/projects/:projectId/marco-teorico', marcoTeoricoRoutes);
app.use('/api/projects/:projectId/documents', projectDocumentsRoutes);
app.use('/api/design', designRoutes);
app.use('/api/plan', planRoutes);
app.use('/api/compute', computeRoutes);
app.use('/api/math', mathRoutes);
app.use('/api/viz', vizRoutes);
app.use('/api/doc', docRoutes);
app.use('/api/artifact', artifactRoutes);
app.use('/api/enterprise', enterpriseRoutes);
app.use('/api/social-posts', socialPostsRoutes);
app.use('/api/codex/github', githubCodexRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/cowork', coworkRoutes);
app.use('/api/orchestration', orchestrationRoutes);
app.use('/api/webhooks', webhooksRoutes);
app.use('/api/integrations/slack', slackIntegrationRoutes);
app.use('/api/telemetry', telemetryRoutes);

// Dev-only Sentry smoke-test endpoint. The router itself rejects
// production traffic with a 404. Mounted unconditionally so tests can
// hit it without env-var dancing.
const { buildDevSentryRouter } = require('./src/routes/dev-sentry');
app.use('/api/__dev', buildDevSentryRouter());

// Passkey (WebAuthn) endpoints. Disabled until the operator sets
// WEBAUTHN_RP_ID + WEBAUTHN_ORIGIN AND flips
// WEBAUTHN_ENDPOINTS_ENABLED=true. Until then the router responds
// with a structured 404 + hint on every path. See backend/src/
// routes/webauthn.js + services/webauthn/ for the full surface.
const { buildWebAuthnRouter } = require('./src/routes/webauthn');
app.use('/api/webauthn', buildWebAuthnRouter());


// 404 handler — must come before the global error handler so unmatched
// routes flow through here, not into the error path.
app.use('*', (req, res) => {
    res.status(404).json({ error: 'Route not found' });
});

// Centralized error handling — single source of truth for shaping
// 4xx/5xx responses (Prisma, Stripe, ZodError, ValidationError,
// MulterError, payload-too-large). Always last middleware so any
// error thrown anywhere in the chain ends up here. The handler
// emits a one-line JSON record (reqId + err name/message/stack≤2KB)
// in addition to pino's structured log so the request-logger pipeline
// sees errored requests too.
const { globalErrorHandler: buildGlobalErrorHandler } = require('./src/middleware/error-handler');
app.use(buildGlobalErrorHandler({ logger, captureException: captureSentryException }));

function startServer() {
    prisma.connectDatabase();
    const server = app.listen(PORT, () => {
        const startInfo = {
            port: PORT,
            env: process.env.NODE_ENV || 'development',
            node: process.version,
            platform: process.platform,
            arch: process.arch,
            pid: process.pid,
            uptimeBase: process.uptime(),
            memoryRss: `${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB`,
            healthUrl: `http://localhost:${PORT}/health`,
            apiDocsUrl: `http://localhost:${PORT}/api-docs`,
            metricsUrl: `http://localhost:${PORT}/metrics`,
            allowedOrigins: ALLOWED_ORIGINS,
            rateLimitStore: rateLimitStoreInfo.mode,
            rateLimitStoreReason: rateLimitStoreInfo.reason,
            redisConfigured: Boolean(process.env.REDIS_URL),
            telemetryEnabled: process.env.OTEL_ENABLED === 'true',
            sentryConfigured: Boolean(process.env.SENTRY_DSN),
            langfuseConfigured: Boolean(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY),
            posthogConfigured: Boolean(process.env.POSTHOG_API_KEY),
            idempotencyEnabled: process.env.IDEMPOTENCY_ENABLED === 'true',
            planQuotasEnabled: process.env.PLAN_QUOTAS_ENFORCED !== 'false',
            corsAllowedOriginsCount: ALLOWED_ORIGINS.length,
            orchestration: {
                gateway: orchestration?.configured?.gateway ?? false,
                r2Storage: orchestration?.configured?.r2 ?? false,
                memory: orchestration?.configured?.memory ?? false,
            },
        };
        logger.info(startInfo, 'server_started');
        // Loud warning when production boots without an explicit CORS
        // allowlist. The fail-closed CORS callback will then reject
        // every browser request — surface this in the access log so
        // ops can spot the misconfig before users do.
        if (process.env.NODE_ENV === 'production' && ALLOWED_ORIGINS.length === 0) {
            logger.warn(
                { hint: 'set CORS_ORIGINS to a comma-separated allowlist' },
                'cors_allowlist_empty_in_production',
            );
        }
    });

    recoverAgentTasksAfterBoot({ logger });
    startAgentTaskWorker();

    // Apply any admin-curated provider keys (panel /admin/connections)
    // by overriding the corresponding process.env vars in this worker.
    // Fire-and-forget — DB may not be ready instantly; the catch logs.
    (async () => {
        try {
            const { applyAdminConnections } = require('./src/services/admin-connections-bridge');
            await applyAdminConnections();
        } catch (err) {
            logger.warn({ err: err.message }, 'admin_connections_bridge_boot_failed');
        }
    })();

    // Ratchet 44 — defense-in-depth: when prod has orgs with SSO
    // enabled, warn loudly if the matching upstream lib isn't
    // installed. SSO routes degrade via lazy-require, but this
    // surfaces the misconfig at startup. Fire-and-forget.
    (async () => {
        try {
            const { validateActiveSsoConfig } = require('./src/utils/sso-boot-validator');
            await validateActiveSsoConfig({ prisma, logger });
        } catch (err) {
            logger.warn({ err: err && err.message }, 'sso_boot_validator_failed');
        }
    })();

    // Initialize WebSocket server for Computer Use
    initializeWebSocketServer(server);

    // Initialize realtime WebSocket scaffolding (presence, typing, cursor)
    // Lives on a separate path (`/ws/realtime`) so it can't collide with
    // the computer-use socket above.
    try {
      initRealtimeServer(server, { logger });
    } catch (err) {
      logger.warn({ err: err.message }, 'realtime_socket_init_failed');
    }

    // Wire scheduler → agent: register the invoker so cron/webhook jobs
    // can run the agent without the scheduler module importing the agent
    // layer (which would circular-require via the skills registry).
    scheduler.setInvoker(runAgent);
    // Wire the error classifier so scheduled jobs get proper retry
    // decisions (rate-limited → backoff, quota-exhausted → no retry).
    // Inline require avoids circular dependencies at module load time.
    const { classifyTaskError } = require('./src/services/agents/agent-task-runner');
    scheduler.setJobClassifier(classifyTaskError);
    scheduler.start();

    // System cron — daily GDPR housekeeping (scrub @ 02:30 UTC,
    // hard-delete @ 03:00 UTC). Disabled in NODE_ENV=test or when
    // SYSTEM_CRON_ENABLED=false. Failures are isolated to the cron.
    try {
        const systemCron = require('./src/jobs/system-cron');
        systemCron.start({ logger });
        shutdownRegistry.register('system_cron_stop', () => {
            try { systemCron.stop(); } catch {}
        }, 5000);
    } catch (err) {
        logger.warn({ err: err && err.message }, 'system_cron_init_failed');
    }

    // ── Centralized graceful shutdown ──────────────────────────────
    // Each step has its own 5s timeout budget; the overall registry
    // enforces a 30s hard ceiling. Registration order matters: hooks
    // execute in reverse-LIFO, so `http_server_close` (registered
    // FIRST) runs LAST (after dependants are torn down).
    shutdownRegistry.configure({ logger });

    // 7. Last to register → first to run: stop accepting new connections.
    shutdownRegistry.register('http_server_close', () => new Promise((resolve) => {
        try { server.close(() => resolve()); } catch { resolve(); }
    }), 5000);

    // 6. Drain in-flight requests (best-effort, 5s budget per step;
    //    requests still in flight after the global 30s deadline are
    //    abandoned by the parent timeout).
    shutdownRegistry.register('drain_inflight_requests', async () => {
        // Express has no built-in inflight counter; we rely on
        // server.close() above to wait for keep-alive to drain. This
        // hook exists for symmetry + future write-behind/queue flush.
        await new Promise((r) => setTimeout(r, 250));
    }, 5000);

    // 5. Flush write-behind caches (cycle 31). Best-effort: tolerate
    //    missing modules so a partial deploy doesn't hang shutdown.
    shutdownRegistry.register('write_behind_cache_flush', async () => {
        try {
            const wb = require('./src/services/cache/write-behind');
            if (wb && typeof wb.flushAll === 'function') await wb.flushAll();
        } catch { /* module not present — skip */ }
    }, 5000);

    // 4. Close realtime WS server (cycle 24).
    shutdownRegistry.register('realtime_ws_close', () => {
        try { closeRealtimeServer(); } catch {}
    }, 5000);

    // 3. Close BullMQ workers + queue.
    shutdownRegistry.register('bullmq_workers_close', async () => {
        await Promise.allSettled([closeAgentTaskWorker(), closeAgentTaskQueue()]);
    }, 5000);

    // 2. Disconnect Prisma.
    shutdownRegistry.register('prisma_disconnect', async () => {
        try { if (typeof prisma.$disconnect === 'function') await prisma.$disconnect(); } catch {}
    }, 5000);

    // 1. Disconnect Redis (lazy health client + any others we own).
    shutdownRegistry.register('redis_disconnect', async () => {
        const c = (typeof getHealthRedisClient === 'function') ? getHealthRedisClient() : null;
        if (c && typeof c.quit === 'function') {
            try { await c.quit(); } catch {}
        }
    }, 5000);

    // Observability flush (telemetry exporters) — runs alongside DB/Redis
    // disconnect to recover any in-flight events.
    shutdownRegistry.register('observability_flush', async () => {
        const flushers = [
            shutdownOpenTelemetry(),
            shutdownLangfuse(),
            shutdownPostHog(),
        ];
        // Flush Langfuse traces from the orchestration gateway tracer too
        if (orchestration?.gateway?.tracer?.flush) {
            flushers.push(orchestration.gateway.tracer.flush());
        }
        await Promise.allSettled(flushers);
    }, 5000);

    // Scheduler stop — registered last (first to run) so cron jobs
    // can't enqueue new work during shutdown.
    shutdownRegistry.register('scheduler_stop', () => {
        try { scheduler.stop?.(); } catch {}
    }, 5000);

    async function shutdown(signal) {
        logger.info({ signal }, 'shutdown_signal_received');
        try {
            await shutdownRegistry.shutdown(signal);
        } catch (err) {
            logger.error({ err: err && err.message }, 'shutdown_registry_failure');
        }
        process.exit(0);
    }

    process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
    process.once('SIGINT', () => { void shutdown('SIGINT'); });

    // ── Alerting configuration ─────────────────────────────────────
    alerting.configure({ logger });

    // Memory monitor: every 30s, alert when heapUsed > 80% of heapTotal.
    // Dedup at the alerting layer ensures a sustained high-memory state
    // produces one Slack message per 5min, not 10.
    const memInterval = setInterval(() => {
        try {
            const m = process.memoryUsage();
            if (!m.heapTotal) return;
            const pct = (m.heapUsed / m.heapTotal) * 100;
            if (pct > 80) {
                Promise.resolve().then(() => alerting.notifyHighMemory(pct, {
                    heapUsedMb: Math.round(m.heapUsed / 1024 / 1024),
                    heapTotalMb: Math.round(m.heapTotal / 1024 / 1024),
                    rssMb: Math.round(m.rss / 1024 / 1024),
                })).catch(() => {});
            }
        } catch { /* never throw from monitor */ }
    }, 30_000);
    if (typeof memInterval.unref === 'function') memInterval.unref();

    // 5xx rate monitor: count successes vs 5xx over a sliding 1-minute
    // window and alert when the error rate exceeds 5%. We sample
    // every 60s; minimum 20 requests in the window to avoid false
    // positives from low-traffic dev environments.
    let _http5xxWindow = [];
    app.use((req, res, next) => {
        res.on('finish', () => {
            try {
                const t = Date.now();
                _http5xxWindow.push({ t, err: res.statusCode >= 500 && res.statusCode < 600 });
                if (_http5xxWindow.length > 5000) _http5xxWindow.splice(0, _http5xxWindow.length - 5000);
            } catch { /* ignore */ }
        });
        next();
    });
    const errInterval = setInterval(() => {
        try {
            const cutoff = Date.now() - 60_000;
            _http5xxWindow = _http5xxWindow.filter((e) => e.t >= cutoff);
            const total = _http5xxWindow.length;
            if (total < 20) return;
            const errs = _http5xxWindow.reduce((a, e) => a + (e.err ? 1 : 0), 0);
            const ratePct = (errs / total) * 100;
            if (ratePct > 5) {
                Promise.resolve().then(() => alerting.notifyHigh5xxRate(ratePct, {
                    windowSize: total,
                    errors: errs,
                })).catch(() => {});
            }
        } catch { /* never throw */ }
    }, 60_000);
    if (typeof errInterval.unref === 'function') errInterval.unref();

    return server;
}

if (require.main === module) {
    startServer();
}

module.exports = app;
module.exports.startServer = startServer;
