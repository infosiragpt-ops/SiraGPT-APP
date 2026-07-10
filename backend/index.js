require('./src/config/load-env').loadEnvFiles();

// Install shutdown ownership before heavy startup so Windows IPC requests (and
// Unix signals) cannot be lost while services are still being required.
let earlyShutdownRequest = null;
let dispatchShutdownRequest = null;
function queueShutdownRequest({ reason, signal, desiredExitCode = 0 }) {
    const request = {
        reason: String(reason || signal || 'shutdown'),
        signal: signal === 'SIGINT' ? 'SIGINT' : 'SIGTERM',
        desiredExitCode,
    };
    if (dispatchShutdownRequest) {
        dispatchShutdownRequest(request);
    } else if (!earlyShutdownRequest) {
        earlyShutdownRequest = request;
    }
}
process.once('SIGTERM', () => {
    queueShutdownRequest({ reason: 'SIGTERM', signal: 'SIGTERM', desiredExitCode: 0 });
});
process.once('SIGINT', () => {
    queueShutdownRequest({ reason: 'SIGINT', signal: 'SIGINT', desiredExitCode: 0 });
});
process.on('message', (message) => {
    if (!message || message.type !== 'siragpt:shutdown') return;
    queueShutdownRequest({
        reason: message.reason,
        signal: message.signal,
        desiredExitCode: message.desiredExitCode,
    });
});

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
// Capture the issue list so /health can re-surface lingering config problems
// at runtime (see startupEnvResult snapshot near the health route below).
const startupEnvIssues = validateStartupEnvironment(process.env, { failOnBlocking: true });

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

// Silence PromiseRejectionHandledWarning. Node emits this when a
// promise is rejected synchronously but its `.catch` handler is
// attached on a later tick. In Sira this fires on transient Redis
// rejections that the resilience layer catches asynchronously —
// the rejection IS handled, just not in the same tick. The warning
// is cosmetic noise; the actual error path is already covered by
// the `unhandledRejection` handler above for genuine issues.
process.on('warning', (warning) => {
    if (warning && warning.name === 'PromiseRejectionHandledWarning') return;
    // Re-emit other warnings through the default formatter so we
    // don't accidentally hide deprecations or memory warnings.
    console.warn(`[node-warning] ${warning.name}: ${warning.message}`);
});

// Silence BullMQ's recurring "IMPORTANT! Eviction policy is X. It
// should be 'noeviction'" warning. BullMQ emits this via console.warn
// on every Redis connection establish. Our Upstash plan uses an
// optimistic-volatile policy that works fine for our queue payloads
// (jobs are persisted in Postgres; Redis is just the dispatcher).
// We summarise once per process and then drop subsequent emissions
// so the log stays readable. If queue reliability degrades, the real
// signal is `unhandledRejection` Redis failures, which we already
// log via the resilience layer above.
const _origConsoleWarn = console.warn.bind(console);
let _upstashEvictionLogged = false;
console.warn = (...args) => {
    try {
        const first = args[0];
        if (typeof first === 'string' && first.includes('Eviction policy is')) {
            if (_upstashEvictionLogged) return;
            _upstashEvictionLogged = true;
            _origConsoleWarn('[redis] suppressing recurring eviction-policy warning from BullMQ (Upstash plan uses optimistic-volatile; safe for our workload).');
            return;
        }
    } catch (_) { /* fall through to original */ }
    _origConsoleWarn(...args);
};

// Collapse multi-line object/array dumps in console.log to one-line
// JSON. Node's default `console.log(obj)` uses util.inspect, which
// produces multi-line pretty-printed output like:
//     {
//       analysisId: "cmpfp17xy000b1edujr4ghoz3",
//       ordinal: 16,
//       ...
//     }
// In our deployed Replit log pipeline each line is prefixed with
// `[backend]`, so a 20-key object explodes into 22 noisy log lines
// that are hard to scan and hard to grep. By forcing one-line JSON
// for non-primitive args we keep one log event per call, preserving
// the data but making it greppable. Strings, numbers, booleans, and
// Error instances are formatted as-is so stack traces still render.
const _origConsoleLog = console.log.bind(console);
const _formatLogArg = (arg) => {
    if (arg === null || arg === undefined) return String(arg);
    const t = typeof arg;
    if (t === 'string' || t === 'number' || t === 'boolean' || t === 'bigint') return String(arg);
    if (arg instanceof Error) return arg.stack || `${arg.name}: ${arg.message}`;
    try {
        // Compact JSON; cap size so accidental dumps of huge buffers
        // don't blow up the log line. Circular refs fall through to
        // util.inspect via the catch below.
        const s = JSON.stringify(arg);
        if (s === undefined) return String(arg);
        return s.length > 4000 ? s.slice(0, 4000) + '…[truncated]' : s;
    } catch (_) {
        try { return require('util').inspect(arg, { depth: 3, breakLength: Infinity, compact: true }); }
        catch (_e) { return String(arg); }
    }
};
console.log = (...args) => {
    if (args.length === 0) { _origConsoleLog(); return; }
    _origConsoleLog(args.map(_formatLogArg).join(' '));
};
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
const _sentryBootStatus = startSentry();
// Log Sentry init result so it is visible in startup logs and health checks.
// sentryConfigured=true means SENTRY_DSN is set and @sentry/node is active;
// any uncaught exception or explicit captureException() call will be forwarded
// to the configured Sentry project from this point onwards.
{
    const _s = _sentryBootStatus;
    if (_s.enabled && _s.started) {
        console.log(`[sentry] active — env=${_s.environment} traces=${_s.traces_sample_rate} profiling=${_s.profiling_loaded}`);
    } else if (_s.configured && !_s.enabled) {
        console.log('[sentry] configured but disabled (set SENTRY_ENABLED=true to activate)');
    } else {
        console.log('[sentry] not active — set SENTRY_DSN in Replit Secrets to enable error monitoring');
    }
}
const {
    getLangfuseStatus,
    shutdownLangfuse,
    startLangfuse,
    scoreTrace: langfuseScoreTrace,
} = require('./src/services/observability/langfuse');
startLangfuse();
// PR-7: wire misunderstanding-signals to the real Langfuse sink so
// every implicit signal (regenerate, abandon, correction, dislike,
// manual_edit) appears as a "score" on its associated trace. Best-effort:
// the sink swallows all errors and noops when Langfuse is disabled.
try {
    const __misSignals = require('./src/services/agents/misunderstanding-signals');
    __misSignals.setLangfuseSink({ scoreTrace: langfuseScoreTrace });
} catch (_misWireErr) { /* noop — telemetry must never block boot */ }
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
const { createPoolAutoscaler } = require('./src/db/pool-autoscaler');
let poolAutoscaler = null;

function getPoolAutoscalerState() {
    return poolAutoscaler ? poolAutoscaler.getState() : null;
}

function startDatabasePoolAutoscaler(env = process.env) {
    const enabled = ['1', 'true', 'yes', 'on'].includes(
        String(env.DATABASE_POOL_AUTOSCALE_ENABLED || '').trim().toLowerCase()
    );
    if (!enabled) return null;
    const capacity = prisma.poolMetrics?.snapshot?.()?.capacity;
    if (capacity?.observable === false) {
        logger?.info?.(
            { reason: capacity.reason || 'pool_capacity_unobservable' },
            '[db.pool.autoscale] advisory loop disabled because pool capacity is unobservable'
        );
        return null;
    }
    if (!poolAutoscaler) {
        poolAutoscaler = createPoolAutoscaler({
            metrics: prisma.poolMetrics,
            intervalMs: env.DATABASE_POOL_AUTOSCALE_INTERVAL_MS,
            minLimit: env.DATABASE_POOL_AUTOSCALE_MIN,
            maxLimit: env.DATABASE_POOL_AUTOSCALE_MAX,
            coldSamplesRequired: env.DATABASE_POOL_AUTOSCALE_COLD_SAMPLES,
            // Deliberately omit `apply`: Prisma cannot resize a live pool, so
            // production runs this policy as a recommendation engine only.
            logger: (level, message, meta) => {
                try {
                    const method = typeof logger?.[level] === 'function' ? logger[level] : logger?.info;
                    method?.call(logger, meta || {}, message);
                } catch { /* observability must never block lifecycle */ }
            },
        });
    }
    poolAutoscaler.start();
    return poolAutoscaler;
}

const authRoutes = require('./src/routes/auth');
const chatRoutes = require('./src/routes/chats');
const fileRoutes = require('./src/routes/files');
const documentCollectionRoutes = require('./src/routes/document-collections');
const appshotsRoutes = require('./src/routes/appshots');
const aiRoutes = require('./src/routes/ai');
const aiFailoverHealthRoutes = require('./src/routes/ai-failover-health');
const documentGenerateAiRoutes = require('./src/routes/generate-document');

const paymentRoutes = require('./src/routes/payments');
const adminRoutes = require('./src/routes/admin');
const adminQueuesRoutes = require('./src/routes/admin-queues');
const adminConnectionsRoutes = require('./src/routes/admin-connections');
const adminUserContextRoutes = require('./src/routes/admin-user-context');
const plansRoutes = require('./src/routes/plans');
const creditsRoutes = require('./src/routes/credits');
const paraphraseRoutes = require('./src/routes/paraphrase');
const freeIaRoutes = require('./src/routes/free-ia');
const rbacRoutes = require('./src/routes/rbac');
const imagesRoutes = require('./src/routes/images');
const videoProviderStatusRoutes = require('./src/routes/video-provider-status');
const userRoutes = require('./src/routes/users');
const legalRoutes = require('./src/routes/legal');
const publicRoutes = require('./src/routes/public');
const publishingRoutes = require('./src/routes/publishing');
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
const {
    router: computerUseRoutes,
    initializeWebSocketServer,
    closeComputerUseWebSocketServer,
} = require('./src/routes/computer-use');
const { initRealtimeServer, closeRealtimeServer } = require('./src/services/realtime/socket-server');
const thesisRoutes = require('./src/routes/thesis');
const thesisEngineRoutes = require('./src/routes/thesis-engine');
const voiceGrokRoutes = require('./src/routes/voice-grok');
const researchRoutes = require('./src/routes/research');
const scientificSearchRoutes = require('./src/routes/scientific-search');
const answerRoutes = require('./src/routes/answer');
const builderRoutes = require('./src/routes/builder');
const githubSearchRoutes = require('./src/routes/github-search');
const githubRoutes = require('./src/routes/github');
const workspaceRunner = require('./src/services/github/workspace-runner.service');
const hostingRoutes = require('./src/routes/hosting');
const xSearchRoutes = require('./src/routes/x-search');
const accountingRoutes = require('./src/routes/accounting');
const linkPreviewRoutes = require('./src/routes/link-preview');
const adminSecurityRoutes = require('./src/routes/admin/security');
const adminSettingsRoutes = require('./src/routes/admin/settings');
const adminReportsRoutes = require('./src/routes/admin/reports');
const docAgentRoutes = require('./src/routes/doc-agent');
const opencodeRoutes = require('./src/routes/opencode');
const codeRunnerRoutes = require('./src/routes/code-runner');
const researchAgentRoutes = require('./src/routes/research-agent');
const goalsRoutes = require('./src/routes/goals');
const sandboxRoutes = require('./src/routes/sandbox');
const intentRoutes = require('./src/routes/intent');
const circuitAttributionRoutes = require('./src/routes/circuit-attribution');
const attributionExplainerRoutes = require('./src/routes/attribution-explainer');
const attributionToolkitRoutes = require('./src/routes/attribution-toolkit');
const uploadMiddleware = require('./src/middleware/upload');
const attributionStackRoutes = require('./src/routes/attribution-stack');
const ragRoutes = require('./src/routes/rag');
const agentRoutes = require('./src/routes/agent');
const agentTaskRoutes = require('./src/routes/agent-task');
const agentRunsRoutes = require('./src/routes/agent-runs');
const agentBatchRoutes = require('./src/routes/agent-batch');
const agentHarnessRoutes = require('./src/routes/agent-harness');
const seAgentsRoutes = require('./src/routes/se-agents');
const searchBrainRoutes = require('./src/routes/search-brain');
const searchBrainUniversalRoutes = require('./src/routes/search-brain-universal');
const { createUploadStaticAccessGuard, createUploadR2Fallback } = require('./src/middleware/upload-static-access');
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
const codexRunsRoutes = require('./src/routes/codex-runs');
const codexV2Routes = require('./src/routes/codex');
const deploymentsRoutes = require('./src/routes/deployments');
const telegramRoutes = require('./src/routes/telegram');
const pushRoutes = require('./src/routes/push');
const coworkRoutes = require('./src/routes/cowork');
const memoryRoutes = require('./src/routes/memory');
const contextIntelligenceRoutes = require('./src/routes/context-intelligence');
const orchestrationRoutes = require('./src/routes/orchestration');
const hermesRoutes = require('./src/routes/hermes');
const webhooksRoutes = require('./src/routes/webhooks');
const slackIntegrationRoutes = require('./src/routes/integrations/slack');
const {
    authenticateToken,
    requireAdmin,
    shutdownWriteBehindCache,
} = require('./src/middleware/auth');
const scheduler = require('./src/services/scheduler/scheduler');
const { runAgent } = require('./src/services/agents/agent-entry');
const { recoverAgentTasksAfterBoot } = require('./src/services/agents/agent-task-boot-recovery');
const { startAgentTaskWorker, closeAgentTaskWorker } = require('./src/services/agents/agent-task-worker');
const { closeAgentTaskQueue } = require('./src/services/agents/agent-task-queue');
const { closeChatRunQueue } = require('./src/services/chat-run-queue');
const { startGoalWorker, closeGoalWorker } = require('./src/services/goal-worker');
const { closeGoalQueue } = require('./src/services/goal-queue');
const { recoverGoalRunsAfterBoot, stopGoalRecovery } = require('./src/services/goal-boot-recovery');
const { startGoalCleanup, stopGoalCleanup } = require('./src/services/goal-cleanup');
// Codex Agent V2 run engine (feature 05). startCodexWorker self-gates on the
// CODEX_AGENT_V2 flag (no-op when off), so it's always safe to call.
const { startCodexWorker, closeCodexWorker, closeCodexQueue } = require('./src/services/codex/run-queue');
const { startDocumentCollectionWorker, closeDocumentCollectionWorker, closeDocumentCollectionQueue } = require('./src/services/document-collection-queue');
const { recoverCodexRunsAfterBoot } = require('./src/services/codex/boot-recovery');
const { logCodexConfig } = require('./src/services/codex/config-validator');
const { validate: validateAttributionConfig } = require('./src/services/attribution-config-validator');
const alerting = require('./src/services/alerting');
const sloTracker = require('./src/services/slo-tracker');
const shutdownRegistry = require('./src/utils/shutdown');
const telemetryRoutes = require('./src/routes/telemetry');

const app = express();
const PORT = process.env.PORT || 5000;
// Bind host. In development the workflow passes HOST=127.0.0.1 so the backend
// listens on loopback only — it is reached exclusively via the Next.js /api
// proxy (BACKEND_INTERNAL_URL=http://localhost:5050). Loopback binding keeps
// Replit's automatic port detection from exposing 5050 as a second external
// port, which would break the single-external-port Reserved VM deploy. When
// HOST is unset (production `npm start`) it falls back to 0.0.0.0 as before.
const HOST = process.env.HOST || '0.0.0.0';
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
const globalCors = cors({
    origin: makeOriginCallback(ALLOWED_ORIGINS),
    credentials: true,
    optionsSuccessStatus: 200,
});
const CODE_RUNNER_TOKEN_APP_PATH_RE = /^\/api\/code-runner\/[a-zA-Z0-9_-]+\/[a-fA-F0-9]+\/app(?:\/|$)/;
app.use((req, res, next) => {
    // Sandboxed /code preview iframes have an opaque origin, so browser module
    // requests for Vite assets arrive with `Origin: null`. The runner route is
    // already protected by a run-scoped path token and sets its own narrowly
    // scoped CORS headers. Let those requests reach the proxy instead of being
    // rejected by the global credentialed app CORS policy.
    const path = req.path || req.originalUrl || '';
    if (CODE_RUNNER_TOKEN_APP_PATH_RE.test(path)) return next();
    return globalCors(req, res, next);
});

app.use('/api/auth', authLimiter);
app.use('/api/agent', expensiveLimiter);
app.use('/api/rag', expensiveLimiter);
app.use('/api/document-ai', expensiveLimiter);
app.use('/api/ai/generate', expensiveLimiter);
// Autonomous research loop (planner→search→browser→vision LLM) and the
// scientific-search fan-out (10-16 external APIs in parallel per call) are
// per-request amplifiers — gate them at the stricter expensive tier so one
// authed user can't run up LLM cost or get the platform IP banned by upstream
// indices (Crossref/OpenAlex/…).
app.use('/api/research-agent', expensiveLimiter);
app.use('/api/scientific-search', expensiveLimiter);
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
// shared scrape paths (to avoid scrape-induced self-observation).
const siraMetrics = require('./src/utils/metrics');
const {
    classifyRequestClass,
    classifyStatusClass,
    isMetricsRequest,
    matchedRouteLabel,
} = require('./src/services/observability/metrics-paths');
app.use((req, res, next) => {
    if (isMetricsRequest(req)) return next();
    const startNs = process.hrtime.bigint();
    res.on('finish', () => {
        try {
            const route = matchedRouteLabel(req);
            const requestClass = classifyRequestClass(req, res);
            const statusClass = classifyStatusClass(res.statusCode);
            const durSeconds = Number(process.hrtime.bigint() - startNs) / 1e9;
            siraMetrics.counter('siragpt_http_requests_total', {
                method: req.method,
                route,
                status: String(res.statusCode),
                request_class: requestClass,
            });
            siraMetrics.counter('siragpt_http_slo_requests_total', {
                request_class: requestClass,
                status_class: statusClass,
            });
            siraMetrics.observe('siragpt_http_request_duration_seconds', {
                method: req.method,
                route,
                request_class: requestClass,
            }, durSeconds);
            siraMetrics.observe('siragpt_http_slo_request_duration_seconds', {
                request_class: requestClass,
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
    const { reconnectDelay, isTransientRedisError, createThrottledLogger } = require('./src/services/agents/redis-resilience');
    const _sessionRedisThrottle = createThrottledLogger(60_000);
    const redisClient = new Redis(process.env.REDIS_URL, {
        // Never timeout individual commands — let them queue until the
        // connection is re-established so an outage doesn't log out all users.
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        connectTimeout: 5000,
        // Keep retrying with capped exponential backoff so a transient
        // Redis outage (Upstash quota reset, failover, etc.) self-heals.
        retryStrategy: reconnectDelay,
    });
    redisClient.on('error', (err) => {
        if (isTransientRedisError(err)) {
            _sessionRedisThrottle(() => console.warn('[session-store] transient Redis error (sessions using cookie fallback):', err.message));
        } else {
            console.error('[session-store] Redis error:', err.message);
        }
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
app.use('/api/document-collections', requireCsrf);
// Pairing is cookie-auth, so it needs CSRF; capture is bearer-only and is
// mounted without CSRF below. Path-level matching keeps the protection tight.
app.use('/api/appshots/pair', requireCsrf);
// Sessions management (list + revoke) is cookie-auth too — same threat
// model as /pair, so it gets the same CSRF gate. /capture stays exempt.
app.use('/api/appshots/sessions', requireCsrf);
app.use('/api/projects', requireCsrf);
app.use('/api/payments', requireCsrf);
app.use('/api/bookmarks', requireCsrf);
app.use('/api/orgs', requireCsrf);
app.use('/api/library', requireCsrf);
app.use('/api/cowork', requireCsrf);
app.use('/api/memory', requireCsrf);
app.use('/api/context-intelligence', requireCsrf);
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
const uploadsDir = uploadMiddleware.uploadDir || path.join(__dirname, 'uploads');
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
// When the binary is not on local disk (R2-backed / scaled deploys), redirect
// to a short-lived signed R2 URL. Runs only for authorized requests (the
// access guard above already enforced ownership).
app.use('/uploads', createUploadR2Fallback());


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
const coworkHealth = require('./src/services/cowork-health');

// ── Startup-environment snapshot ───────────────────────────
// Captured once at module load by validateStartupEnvironment (see top of
// file). Surfaced in the full /health report so the broader config validator
// findings (missing/placeholder secrets, malformed URLs, out-of-range numeric
// settings) stay visible at runtime instead of vanishing into boot logs.
const startupEnvResult = {
    checked: true,
    issues: Array.isArray(startupEnvIssues) ? startupEnvIssues : [],
};

// Build and mount the health endpoints. The route handlers (and the boot-time
// OAuth/startup-env snapshot threading they perform) live in a dedicated,
// dependency-injected module so they can be exercised end-to-end by a test
// without booting the whole server. `startServer` later calls
// `healthRoutes.setOAuthBootResult(...)` to feed in the boot-time OAuth result.
const { createHealthRoutes } = require('./src/routes/health-routes');
const {
    defaultQueueHealthProbe,
    defaultQueueRegistry,
} = require('./src/services/queues/queue-registry');
const healthRoutes = createHealthRoutes({
    prisma,
    queueRegistry: defaultQueueRegistry,
    queueHealthProbe: defaultQueueHealthProbe,
    coworkHealth,
    getOpenTelemetryStatus,
    getSentryStatus,
    getLangfuseStatus,
    getPostHogStatus,
    poolMetrics: prisma.poolMetrics,
    getPoolAutoscalerState,
    startupEnv: startupEnvResult,
});
healthRoutes.register(app);

// Internal probe registry + rolling history. This is deliberately separate
// from the public /health contract above: /internal/health/* uses the existing
// Probe/ProbeScheduler system for operator history and SLO aggregation.
// The Redis adapter delegates to healthRoutes' lazy client, so both health
// surfaces share one connection instead of creating another IORedis instance.
const { createHealthSystem } = require('./src/health/mount');
const internalHealthSystem = createHealthSystem({
    prisma,
    redisClient: process.env.REDIS_URL
        ? {
            ping: async () => {
                const client = healthRoutes.getHealthRedisClient();
                if (!client || typeof client.ping !== 'function') {
                    throw new Error('health Redis client is unavailable');
                }
                return client.ping();
            },
        }
        : null,
    logger,
    env: process.env,
});
internalHealthSystem.mount(app);

// ── Prometheus metrics ──────────────────────────────────────────
// Single protected scrape handler for process, utility, SE-agent, Sira,
// cognitive, and Free-IA metrics. The exposition module owns all registry
// registration so direct formatter calls and HTTP scrapes are identical.
const {
    configureDatabasePoolMetrics,
    metricsHandler,
} = require('./src/services/observability/metrics-exposition');
configureDatabasePoolMetrics({
    snapshot: () => prisma.poolMetrics.snapshot(),
    recommendation: getPoolAutoscalerState,
});
app.get('/metrics', metricsHandler);
// Operator-facing alias under /internal/* — keeps the public surface
// area predictable when ops only allow-list the internal path through
// the ingress (and blackholes /metrics from the edge).
app.get('/internal/metrics', metricsHandler);

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
app.use('/api/document-collections', documentCollectionRoutes);
// Appshots — Chrome extension capture endpoints. /pair uses cookie auth and
// is protected by the global requireCsrf list (see ~/api/auth section above),
// /capture uses bearer-only auth and is intentionally CSRF-exempt.
app.use('/api/appshots', appshotsRoutes);
// Read-only failover/key-pool/key-health diagnostics. Mounted BEFORE the
// generic /api/ai router so /api/ai/failover/* takes precedence. GET-only.
app.use('/api/ai/failover', aiFailoverHealthRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/admin/queues', adminQueuesRoutes);
app.use('/api/admin/connections', adminConnectionsRoutes);
app.use('/api/admin/user-context', adminUserContextRoutes.router);
app.use('/api/admin/plans', plansRoutes.adminRouter);
app.use('/api/plans', plansRoutes);
app.use('/api/admin/credits', creditsRoutes.adminRouter);
app.use('/api/credits', creditsRoutes);
app.use('/api/admin/goals', goalsRoutes.adminRouter);
app.use('/api/paraphrase', paraphraseRoutes);
app.use('/api/free-ia', freeIaRoutes);
// AI proxy for GENERATED apps (SiraGPT Apps): public by design (preview apps
// carry no auth), free-tier model only, strict per-IP rate limit inside.
app.use('/api/apps-ai', require('./src/routes/apps-ai').buildAppsAiRouter());
// Persistent key-value store for GENERATED apps (journals/trackers/leaderboards):
// public by design, per-IP rate-limited + size/count-capped inside. Its own
// json parser so the mount stands alone regardless of global body-parser order.
app.use('/api/apps-kv', express.json({ limit: '256kb' }), require('./src/routes/apps-kv').buildAppsKvRouter());
app.use('/api/admin/rbac', rbacRoutes.adminRouter);
app.use('/api/rbac', rbacRoutes);
app.use('/api/images', imagesRoutes);
app.use('/api/video/provider', videoProviderStatusRoutes);
app.use('/api/admin/security', adminSecurityRoutes);
app.use('/api/admin/settings', adminSettingsRoutes);
app.use('/api/admin/reports', adminReportsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/users', userRoutes);
app.use('/api/legal', legalRoutes);
app.use('/api/public', publicRoutes);
// Deployment control plane: authn + admin only. The POST actions can dispatch
// GitHub workflows (republish) with server-side tokens, so this must never be
// reachable by unauthenticated or non-admin callers.
app.use('/api/publishing', authenticateToken, requireAdmin, publishingRoutes);
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
app.use('/api/thesis', thesisEngineRoutes);
app.use('/api/voice/grok', voiceGrokRoutes);
app.use('/api/research', researchRoutes);
app.use('/api/scientific-search', scientificSearchRoutes);
app.use('/api/answer', answerRoutes);
app.use('/api/builder', builderRoutes);
app.use('/api/github-search', githubSearchRoutes);
app.use('/api/github', githubRoutes);
app.use('/api/hosting', hostingRoutes);
app.use('/api/x-search', xSearchRoutes);
app.use('/api/accounting', accountingRoutes);
app.use('/api/link-preview', linkPreviewRoutes);
app.use('/api/doc-agent', docAgentRoutes);
app.use('/api/opencode', opencodeRoutes);
app.use('/api/code-runner', codeRunnerRoutes);
app.use('/api/research-agent', researchAgentRoutes);
app.use('/api/goals', goalsRoutes);
app.use('/api/sandbox', sandboxRoutes);
app.use('/api/intent', intentRoutes);
app.use('/api/circuit-attribution', circuitAttributionRoutes);
app.use('/api/attribution-explainer', attributionExplainerRoutes);
app.use('/api/attribution-toolkit', attributionToolkitRoutes);
app.use('/api/attribution-stack', attributionStackRoutes);
app.use('/api/rag', ragRoutes);
// Idempotency is scoped to the surfaces that mutate durable state
// at real cost (LLM tokens, sandbox compute, queued workers): agent
// task creation and tool-call execution. Mount sits after body
// parsing so the middleware can fingerprint req.body for the 409
// "key reused with different body" check.
app.use('/api/agent', idempotency);
app.use('/api/agent', agentTaskRoutes);
// Observability read surface: full step trace of one agent run by trace_id.
app.use('/api/agent-runs', agentRunsRoutes);
app.use('/api/agent', agentBatchRoutes);
app.use('/api/agent', agentRoutes);
// Agent harness (Phase 1): interactive tool-permission decisions + external
// MCP server registration for the chat agent.
app.use('/api/agent', agentHarnessRoutes);
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
app.use('/api/codex', codexRunsRoutes);
// Codex Agent V2 (flag CODEX_AGENT_V2). Mounted AFTER codex-runs so the legacy
// /runs flow keeps priority; V2 lives under /health + /projects/* (and F2 run
// routes scoped per project). Flag off ⇒ every V2 route except /health is 404.
app.use('/api/codex', codexV2Routes);
// Deployments / Publishing (flag DEPLOYMENTS_V2). Bearer-auth, CSRF-exempt like
// codex; flag off ⇒ every route except /health is 404.
app.use('/api/deployments', deploymentsRoutes);
// Telegram remote control for dev agents. CSRF-exempt (external POST gated by a
// secret-token header) and fully inert unless TELEGRAM_BOT_TOKEN is set.
app.use('/api/telegram', telegramRoutes);
try {
    const tgControl = require('./src/services/telegram/telegram-control');
    const tgCfg = tgControl.getTelegramConfig();
    if (tgCfg.enabled && !tgCfg.webhookSecret) {
        console.warn('[telegram] TELEGRAM_BOT_TOKEN is set without TELEGRAM_WEBHOOK_SECRET — the /api/telegram/webhook endpoint will reject all requests (fail closed). Set TELEGRAM_WEBHOOK_SECRET to enable it.');
    }
    if (tgCfg.enabled && tgCfg.webhookUrl) {
        tgControl
            .setTelegramWebhook(tgCfg)
            .then((r) => console.log(r.ok ? '[telegram] webhook registered' : '[telegram] setWebhook failed'))
            .catch(() => { });
    }
} catch {
    /* telegram is optional */
}
app.use('/api/push', pushRoutes);
app.use('/api/cowork', coworkRoutes);
app.use('/api/memory', memoryRoutes);
app.use('/api/context-intelligence', contextIntelligenceRoutes);
app.use('/api/orchestration', orchestrationRoutes);
app.use('/api/hermes', hermesRoutes);
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

async function startServer() {
    // ── Google OAuth configuration check ───────────────────────
    // Run before app.listen so a broken OAuth config is caught
    // before the server accepts any traffic. In production, critical
    // issues (localhost callback, malformed base URL, host mismatch)
    // are treated as blocking failures and halt startup with a clear
    // error message. In non-production environments, the same checks
    // run but only emit warnings — the server still starts.
    try {
        const { validateOAuthCallbackUrl } = require('./src/utils/oauth-callback-boot-validator');
        const oauthResult = validateOAuthCallbackUrl({ logger });
        // Snapshot the result so /health can re-surface it at runtime.
        // setOAuthBootResult stores only the monitoring-relevant fields
        // (shouldBlock is a boot-time-only directive and never reaches a
        // running server) and the live /health route reads this snapshot.
        healthRoutes.setOAuthBootResult(oauthResult);
        if (oauthResult.shouldBlock) {
            logger.error(
                {
                    issues: oauthResult.issues,
                    hint:
                        'Google OAuth is misconfigured. The server will not start in production ' +
                        'with a broken OAuth configuration. Fix the issues listed above and restart.',
                },
                'oauth_config_boot_check_failed',
            );
            console.error('[FATAL] Google OAuth configuration is invalid — aborting startup.');
            console.error(`[FATAL] Issues: ${oauthResult.issues.join(', ')}`);
            console.error('[FATAL] Check GOOGLE_AUTH_BASE_URL, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and related redirect URI secrets.');
            // Exit synchronously so app.listen is never reached.
            // process.exit flushes stdio in Node ≥ 18; the exitCode is set
            // first as a belt-and-braces fallback in case exit is deferred
            // by a signal trap elsewhere in the process.
            process.exitCode = 1;
            process.exit(1);
            return; // unreachable — guards static analysis / linters
        }
    } catch (err) {
        logger.warn({ err: err && err.message }, 'oauth_callback_boot_validator_failed');
    }

    // Await the database connection (with its built-in retry/backoff) BEFORE
    // binding the port. Previously connectDatabase() was fire-and-forget, so
    // app.listen() accepted traffic while Prisma was still mid-handshake — the
    // first requests then raced an unconnected client and surfaced as
    // `P1011: Error opening a TLS connection: unexpected EOF`. Awaiting closes
    // that window; healthy boots are unaffected (connect resolves on attempt 1,
    // and connectDatabase still process.exit(1)s if all retries are exhausted).
    await prisma.connectDatabase();

    // Forensic trail: now that the DB is up, audit every agent-tool
    // permission decision (allow / deny / always-allow / timeout). Non-fatal.
    try {
      require('./src/services/agent-harness/permission-manager').enablePermissionAudit();
    } catch (_) { /* permission audit is best-effort */ }

    const server = app.listen(PORT, HOST, () => {
        // --- HTTP timeouts ---------------------------------------------------
        // The Next.js front-end proxies every /api/* call to this Express
        // process over a keep-alive HTTP connection. Node's default
        // `server.keepAliveTimeout` is 5 s, which is SHORTER than the idle
        // window the proxy's upstream agent holds the socket open for.
        // When the proxy then re-uses a socket the backend has silently
        // closed, the next write races the FIN and surfaces as
        // `ECONNRESET` / "socket hang up" in the Next.js logs (most
        // visible on long endpoints like /api/ai/generate-image).
        //
        // Fix:
        //   - keepAliveTimeout: 2 min, comfortably longer than any
        //     upstream-agent idle window we've observed.
        //   - headersTimeout: must be STRICTLY > keepAliveTimeout (Node
        //     enforces this; otherwise the socket can close while still
        //     waiting for the next request line and throw HPE_INVALID_*).
        //   - requestTimeout: 5 min, so legitimately slow endpoints
        //     (image generation has its own 200 s ceiling, file uploads,
        //     model warm-ups) don't get cut off mid-flight.
        server.keepAliveTimeout = 120_000;
        server.headersTimeout = 125_000;
        server.requestTimeout = 300_000;
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
        // SECURITY: the CSRF stateless-header fallback (csrf.js) is only safe
        // while CORS rejects unknown origins — a wildcard origin with
        // credentials would let any site send X-CSRF-Token cross-site and
        // bypass CSRF. Loudly flag this dangerous combo in production.
        if (process.env.NODE_ENV === 'production' && ALLOWED_ORIGINS.includes('*')) {
            logger.warn(
                { hint: 'replace CORS_ORIGINS=* with an explicit allowlist; wildcard + credentials defeats CSRF protection' },
                'cors_wildcard_origin_in_production_csrf_risk',
            );
        }
    });

    // Sampling is a runtime lifecycle concern: never start timers merely by
    // importing index.js in tests or tooling.
    internalHealthSystem.startScheduler();
    defaultQueueHealthProbe.start().catch((err) => {
        logger.warn({ err: err && err.message }, 'queue_metrics_refresh_start_failed');
    });
    startDatabasePoolAutoscaler();

    recoverAgentTasksAfterBoot({ logger });
    recoverGoalRunsAfterBoot({ logger });
    startGoalCleanup({ logger });
    startAgentTaskWorker();
    startGoalWorker();
    // Codex V2: validate config, recover interrupted runs, then start the worker
    // (all no-op when the flag is off). Fire-and-forget recovery never throws.
    try { logCodexConfig(process.env, logger); } catch { /* never blocks boot */ }
    // Attribution stack config coherence check (CLAUDE.md mandates running it on
    // boot). Warnings only — never blocks boot.
    try {
      const attrReport = validateAttributionConfig(process.env);
      if (!attrReport.ok || attrReport.warnings.length) {
        logger.warn({ failures: attrReport.failures, warnings: attrReport.warnings, checked: attrReport.checked }, 'attribution_config_validation');
      }
    } catch { /* never blocks boot */ }
    recoverCodexRunsAfterBoot().catch((err) => logger.warn({ err: err.message }, 'codex_boot_recovery_failed'));
    startCodexWorker();
    startDocumentCollectionWorker();

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

    try {
        const { bootHermesRuntime } = require('./src/services/agents/hermes-runtime');
        bootHermesRuntime();
        logger.info('hermes_runtime_booted');
    } catch (err) {
        logger.warn({ err: err && err.message }, 'hermes_runtime_boot_failed');
    }

    // System cron — daily GDPR housekeeping (scrub @ 02:30 UTC,
    // hard-delete @ 03:00 UTC). Disabled in NODE_ENV=test or when
    // SYSTEM_CRON_ENABLED=false. Failures are isolated to the cron.
    try {
        const systemCron = require('./src/jobs/system-cron');
        systemCron.start({ logger });
        shutdownRegistry.register('system_cron_stop', () => {
            try { systemCron.stop(); } catch { }
        }, 5000);
    } catch (err) {
        logger.warn({ err: err && err.message }, 'system_cron_init_failed');
    }

    // ── Centralized graceful shutdown ──────────────────────────────
    // Each step has its own 5s timeout budget; the overall registry
    // enforces a 30s hard ceiling. Production uses an explicit dependency
    // order; callers that do not configure one retain reverse-LIFO behavior.
    shutdownRegistry.configure({
        logger,
        executionOrder: shutdownRegistry.PRODUCTION_SHUTDOWN_ORDER,
    });

    shutdownRegistry.register('database_pool_autoscaler_stop', () => {
        poolAutoscaler?.stop();
    }, 5000);

    // Stop accepting new HTTP connections before draining in-flight work.
    shutdownRegistry.register('http_server_close', () => new Promise((resolve) => {
        try { server.close(() => resolve()); } catch { resolve(); }
    }), 5000);

    // Drain in-flight requests (best-effort, 5s budget per step;
    //    requests still in flight after the global 30s deadline are
    //    abandoned by the parent timeout).
    shutdownRegistry.register('drain_inflight_requests', async () => {
        // Express has no built-in inflight counter; we rely on
        // server.close() above to wait for keep-alive to drain. This
        // hook exists for symmetry + future write-behind/queue flush.
        await new Promise((r) => setTimeout(r, 250));
    }, 5000);

    // Flush and stop the auth-owned write-behind cache, if it was used.
    shutdownRegistry.register(
        'write_behind_cache_flush',
        () => shutdownWriteBehindCache(),
        5000,
    );

    shutdownRegistry.register('workspace_runner_stop', async () => {
        await workspaceRunner.stopAll();
    }, 5000);

    // Close both WebSocket servers and their clients before HTTP shutdown.
    shutdownRegistry.register(
        'realtime_ws_close',
        () => closeRealtimeServer(),
        5000,
    );
    shutdownRegistry.register(
        'computer_use_ws_close',
        () => closeComputerUseWebSocketServer(),
        5000,
    );

    // Close BullMQ workers + queue.
    shutdownRegistry.register('bullmq_workers_close', async () => {
        try { stopGoalRecovery(); } catch { }
        try { stopGoalCleanup(); } catch { }
        await Promise.allSettled([
            closeAgentTaskWorker(),
            closeAgentTaskQueue(),
            closeChatRunQueue(),
            closeGoalWorker(),
            closeGoalQueue(),
            closeCodexWorker(),
            closeCodexQueue(),
            closeDocumentCollectionWorker(),
            closeDocumentCollectionQueue(),
        ]);
    }, 5000);

    shutdownRegistry.register(
        'queue_health_probe_close',
        () => healthRoutes.closeQueueHealthProbe(),
        5000,
    );

    // Disconnect Prisma after write-behind and observability flushes.
    shutdownRegistry.register('prisma_disconnect', async () => {
        try { if (typeof prisma.$disconnect === 'function') await prisma.$disconnect(); } catch { }
    }, 5000);

    // Disconnect Redis last (lazy health client + any others we own).
    shutdownRegistry.register('redis_disconnect', async () => {
        try { await healthRoutes.closeHealthRedisClient(); } catch { }
    }, 5000);

    // Flush telemetry exporters before disconnecting persistence clients.
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

    // Scheduler stop runs first so jobs cannot enqueue new work.
    shutdownRegistry.register('scheduler_stop', () => {
        try { internalHealthSystem.stopScheduler(); } catch { }
        try { defaultQueueHealthProbe.stop(); } catch { }
        try { scheduler.stop?.(); } catch { }
        try {
            const { shutdownHermesRuntime } = require('./src/services/agents/hermes-runtime');
            shutdownHermesRuntime();
        } catch { }
    }, 5000);

    let shutdownPromise = null;
    function shutdown(reason, requestedExitCode = 0) {
        if (shutdownPromise) return shutdownPromise;
        const parsedExitCode = Number(requestedExitCode);
        const exitCode = Number.isInteger(parsedExitCode) && parsedExitCode >= 0
            ? Math.min(parsedExitCode, 255)
            : 1;
        shutdownPromise = (async () => {
            logger.info({ reason, exitCode }, 'shutdown_signal_received');
            try {
                await shutdownRegistry.shutdown(reason);
            } catch (err) {
                logger.error({ err: err && err.message }, 'shutdown_registry_failure');
            }
            process.exit(exitCode);
        })();
        return shutdownPromise;
    }

    dispatchShutdownRequest = (request) => {
        void shutdown(request.reason, request.desiredExitCode);
    };
    if (earlyShutdownRequest) {
        const request = earlyShutdownRequest;
        earlyShutdownRequest = null;
        dispatchShutdownRequest(request);
    }

    // ── Alerting configuration ─────────────────────────────────────
    alerting.configure({ logger });

    // Memory monitor: every 30s, alert when heapUsed > 85% of the V8
    // heap *limit* (max-old-space-size), NOT current allocated heap.
    //
    // The old implementation compared against `heapTotal`, which is the
    // currently-reserved heap (grows lazily). With --max-old-space-size=2048
    // this fired false alarms at "90%" when actually using ~12% of the
    // real limit, because Node had only reserved 266 MB so far. The
    // honest metric is `heapUsed / heap_size_limit`.
    //
    // Dedup at the alerting layer ensures a sustained high-memory state
    // produces one Slack message per 5 min, not 10.
    const v8 = require('v8');
    const memInterval = setInterval(() => {
        try {
            const m = process.memoryUsage();
            const heapLimit = v8.getHeapStatistics().heap_size_limit;
            if (!heapLimit) return;
            const pct = (m.heapUsed / heapLimit) * 100;
            if (pct > 85) {
                Promise.resolve().then(() => alerting.notifyHighMemory(pct, {
                    heapUsedMb: Math.round(m.heapUsed / 1024 / 1024),
                    heapLimitMb: Math.round(heapLimit / 1024 / 1024),
                    heapTotalMb: Math.round(m.heapTotal / 1024 / 1024),
                    rssMb: Math.round(m.rss / 1024 / 1024),
                })).catch(() => { });
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
                })).catch(() => { });
            }
        } catch { /* never throw */ }
    }, 60_000);
    if (typeof errInterval.unref === 'function') errInterval.unref();

    return server;
}

if (require.main === module) {
    startServer().catch((err) => {
        console.error('Fatal startup error:', err);
        process.exit(1);
    });
}

module.exports = app;
module.exports.startServer = startServer;
