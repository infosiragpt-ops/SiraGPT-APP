require('dotenv').config();

// ── Agent platform bootstrap ────────────────────────────────
// Initialises the new platform services (provider-registry,
// bulkhead pool, structured-logger, performance-tracer,
// sub-agent-orchestrator) before the server accepts traffic.
const { initAgentSystem } = require('./src/services/agents/agent-system');
initAgentSystem();

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
process.on('unhandledRejection', (reason, promise) => {
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
const userRoutes = require('./src/routes/users');
const publicRoutes = require('./src/routes/public');
const downloadRoutes = require('./src/routes/download');
const elevenlabsRoutes = require('./src/routes/elevenlabs');
const searchRoutes = require('./src/routes/search');
const videoRoutes = require('./src/routes/video');
const gptsRoutes = require('./src/routes/gpts');
const libraryRoutes = require('./src/routes/library');
const apiProxyRoutes = require('./src/routes/api');
const gmailRoutes = require('./src/routes/gmail');
const spotifyRoutes = require('./src/routes/spotify');
const figmaRoutes = require('./src/routes/figma');
const { router: computerUseRoutes, initializeWebSocketServer } = require('./src/routes/computer-use');
const thesisRoutes = require('./src/routes/thesis');
const researchRoutes = require('./src/routes/research');
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
const scheduler = require('./src/services/scheduler/scheduler');
const { runAgent } = require('./src/services/agents/agent-entry');
const { recoverAgentTasksAfterBoot } = require('./src/services/agents/agent-task-boot-recovery');
const { startAgentTaskWorker, closeAgentTaskWorker } = require('./src/services/agents/agent-task-worker');
const { closeAgentTaskQueue } = require('./src/services/agents/agent-task-queue');

const app = express();
const PORT = process.env.PORT || 5000;
app.set('trust proxy', 1)

// Security middleware. CSP defaults to report-only mode so a fresh
// deploy never breaks inline content; operators tighten the policy
// after observing reports for a few days. See csp-policy.js for the
// directive shape and the CSP_* env knobs.
const { resolveCspConfig, buildCspDirectives } = require('./src/middleware/csp-policy');
const cspConfig = resolveCspConfig(process.env);
app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    contentSecurityPolicy: cspConfig.enabled ? {
        directives: buildCspDirectives(cspConfig),
        reportOnly: cspConfig.reportOnly,
    } : false,
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
app.use('/api/', apiLimiter);

// Idempotency runs AFTER rate-limit (so a flood of replays still
// costs the limiter quota). It is mounted scoped to the agent task
// and tool-call surfaces below — see app.use('/api/agent', idempotency)
// further down — so the body-hash check can read req.body which
// requires express.json to have parsed it first.

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
app.use('/api/payments/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cookieParser());

// BigInt serialization middleware
app.use(bigintSerializerMiddleware);

// Session configuration for Google OAuth
app.use(session({
    secret: process.env.SESSION_SECRET || 'your-session-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: process.env.NODE_ENV === 'production' }
}));

// Passport middleware
app.use(passport.initialize());
app.use(passport.session());

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

function renderPromMetrics(_req, res) {
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

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/chats', chatRoutes);
app.use('/api/files', fileRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/admin/queues', adminQueuesRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/users', userRoutes);
app.use('/api/public', publicRoutes);
app.use('/api/download', downloadRoutes);
app.use('/api/elevenlabs', elevenlabsRoutes);
app.use('/api/video', videoRoutes);
app.use('/api/search', searchAgenticRoutes);
app.use('/api/search', searchRoutes);
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

// Passkey (WebAuthn) endpoints. Disabled until the operator sets
// WEBAUTHN_RP_ID + WEBAUTHN_ORIGIN AND flips
// WEBAUTHN_ENDPOINTS_ENABLED=true. Until then the router responds
// with a structured 404 + hint on every path. See backend/src/
// routes/webauthn.js + services/webauthn/ for the full surface.
const { buildWebAuthnRouter } = require('./src/routes/webauthn');
app.use('/api/webauthn', buildWebAuthnRouter());


// Error handling middleware
app.use((err, req, res, next) => {
    // Use the request-bound logger so the error correlates with the
    // request id already emitted in the access log. Falls back to the
    // module-level logger if pino-http didn't run for some reason
    // (e.g. error thrown before middleware chain attached).
    const log = req.log || logger;
    log.error(
        { err, status: err.status || 500 },
        'request_failed',
    );
    captureSentryException(err, {
        req,
        tags: {
            surface: 'express_error_handler',
            status: err.status || 500,
        },
    });

    if (err.type === 'entity.too.large') {
        return res.status(413).json({ error: 'File too large' });
    }

    if (err instanceof multer.MulterError || /^Tipo no permitido:/i.test(err.message || '')) {
        return res.status(400).json({
            error: err.message || 'Upload validation failed',
            code: err.code || 'upload_validation_failed',
        });
    }

    res.status(err.status || 500).json({
        error: process.env.NODE_ENV === 'production'
            ? 'Internal server error'
            : err.message
    });
});

// 404 handler
app.use('*', (req, res) => {
    res.status(404).json({ error: 'Route not found' });
});

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

    // Initialize WebSocket server for Computer Use
    initializeWebSocketServer(server);

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

    async function shutdown(signal) {
        logger.info({ signal }, 'shutdown_initiated');
        try { scheduler.stop?.(); } catch {}
        await Promise.allSettled([
            closeAgentTaskWorker(),
            closeAgentTaskQueue(),
            new Promise((resolve) => server.close(resolve)),
            shutdownOpenTelemetry(),
            // Drain any in-flight langfuse events; safe no-op if disabled.
            shutdownLangfuse(),
            // Drain any in-flight posthog events; safe no-op if disabled.
            shutdownPostHog(),
        ]);
        process.exit(0);
    }

    process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
    process.once('SIGINT', () => { void shutdown('SIGINT'); });
    return server;
}

if (require.main === module) {
    startServer();
}

module.exports = app;
module.exports.startServer = startServer;
