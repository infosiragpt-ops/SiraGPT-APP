/**
 * budget — per-user token cost ledger + rate limiting for SE agents.
 *
 * What it tracks per user:
 *   - Hourly tokens (rolls at top of each hour)
 *   - Daily tokens (rolls at UTC midnight)
 *   - Total requests (hour + day)
 *
 * Configuration via env vars so ops can tune without redeploy:
 *   BUDGET_DAILY_TOKENS_DEFAULT  — total tokens/day/user (default 2,000,000)
 *   BUDGET_HOURLY_TOKENS_DEFAULT — hourly cap (default 500,000)
 *   BUDGET_RPM_DEFAULT           — requests per minute cap (default 60)
 *
 * Per-tier overrides can be wired later; for now every user gets the
 * default. Tiered caps are a trivial extension: just key by user.tier.
 *
 * Cost model: the tool-layer charges APPROXIMATE tokens — we use
 * agent-core's stats.approxPromptTokens + approxCompletionTokens. Dollar
 * cost is left to the caller (price varies by model) — we surface
 * tokens, they map to USD.
 *
 * All state is in-memory keyed by userId. For multi-instance deploys
 * this needs to swap to Redis; see roadmap. Cleared when the process
 * restarts — we accept the reset because (a) budgets are a soft cap,
 * (b) absolute accuracy isn't worth a Redis dependency in a single-
 * instance deploy.
 */

const { getRequestId } = require('../../middleware/request-id');

const MAX_TOKEN_CAP = 1_000_000_000_000;
const MAX_RPM_CAP = 100_000;
const MAX_LEDGER_USERS = parsePositiveInt(process.env.BUDGET_MAX_LEDGER_USERS, 10_000, 1, 1_000_000);
const MAX_RPM_LOG_ENTRIES = parsePositiveInt(process.env.BUDGET_MAX_RPM_LOG_ENTRIES, 10_000, 1, 1_000_000);
const MAX_USER_ID_LENGTH = 128;

const DAILY_TOKENS = parsePositiveInt(process.env.BUDGET_DAILY_TOKENS_DEFAULT, 2_000_000, 1, MAX_TOKEN_CAP);
const HOURLY_TOKENS = parsePositiveInt(process.env.BUDGET_HOURLY_TOKENS_DEFAULT, 500_000, 1, MAX_TOKEN_CAP);
const RPM = parsePositiveInt(process.env.BUDGET_RPM_DEFAULT, 60, 1, MAX_RPM_CAP);

// userId → { windows: {...}, requestLog: number[] (timestamps ms) }
const ledger = new Map();

function now() { return Date.now(); }

function parsePositiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.min(Math.floor(n), max);
}

function normalizeCap(value, fallback, max) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function normalizeUserId(userId) {
  if (Array.isArray(userId)) return normalizeUserId(userId[0]);
  if (userId === undefined || userId === null) return null;
  const id = String(userId).trim();
  if (!id || id.length > MAX_USER_ID_LENGTH) return null;
  if (/[\u0000-\u001f\u007f]/.test(id)) return null;
  return id;
}

function normalizeTokens(tokens) {
  const n = Number(tokens);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), MAX_TOKEN_CAP);
}

function normalizeCaps(caps = {}) {
  return {
    daily: normalizeCap(caps.daily, DAILY_TOKENS, MAX_TOKEN_CAP),
    hourly: normalizeCap(caps.hourly, HOURLY_TOKENS, MAX_TOKEN_CAP),
    rpm: normalizeCap(caps.rpm, RPM, MAX_RPM_CAP),
  };
}

function currentHour() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}-${d.getUTCHours()}`;
}

function currentDay() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

function getOrInit(userId) {
  const id = normalizeUserId(userId);
  if (!id) throw new TypeError('budget userId must be a non-empty header-safe value');

  let rec = ledger.get(id);
  if (!rec) {
    evictIfFull();
    rec = {
      hourWindow: currentHour(),
      dayWindow: currentDay(),
      hourTokens: 0,
      dayTokens: 0,
      hourRequests: 0,
      dayRequests: 0,
      rpmLog: [], // rolling-window timestamps
    };
    ledger.set(id, rec);
  }
  return rec;
}

function evictIfFull() {
  if (ledger.size < MAX_LEDGER_USERS) return;
  const oldestKey = ledger.keys().next().value;
  if (oldestKey !== undefined) ledger.delete(oldestKey);
}

function rollWindows(rec) {
  const h = currentHour();
  const d = currentDay();
  if (rec.hourWindow !== h) {
    rec.hourWindow = h;
    rec.hourTokens = 0;
    rec.hourRequests = 0;
  }
  if (rec.dayWindow !== d) {
    rec.dayWindow = d;
    rec.dayTokens = 0;
    rec.dayRequests = 0;
  }
}

function pruneRpmLog(rec, t = now()) {
  rec.rpmLog = rec.rpmLog.filter(ts => Number.isFinite(ts) && t - ts < 60_000);
  if (rec.rpmLog.length > MAX_RPM_LOG_ENTRIES) {
    rec.rpmLog = rec.rpmLog.slice(rec.rpmLog.length - MAX_RPM_LOG_ENTRIES);
  }
}

/**
 * Check if this call is allowed. Returns { allowed: true } or
 * { allowed: false, reason: '<human>', retryAfterMs: number }.
 *
 * Caller should call this BEFORE starting the agent run. Tokens are
 * charged via record() after the run reports actual usage.
 */
function checkAllowed(userId, { caps } = {}) {
  const c = normalizeCaps(caps);
  const rec = getOrInit(userId);
  rollWindows(rec);

  if (c.daily === 0) {
    return {
      allowed: false,
      reason: 'daily token budget (0) exceeded',
      retryAfterMs: msUntilMidnightUTC(),
    };
  }
  if (rec.dayTokens >= c.daily) {
    return {
      allowed: false,
      reason: `daily token budget (${c.daily}) exceeded`,
      retryAfterMs: msUntilMidnightUTC(),
    };
  }
  if (c.hourly === 0) {
    return {
      allowed: false,
      reason: 'hourly token budget (0) exceeded',
      retryAfterMs: msUntilNextHour(),
    };
  }
  if (rec.hourTokens >= c.hourly) {
    return {
      allowed: false,
      reason: `hourly token budget (${c.hourly}) exceeded`,
      retryAfterMs: msUntilNextHour(),
    };
  }

  // Rolling-minute rate limit.
  const t = now();
  pruneRpmLog(rec, t);
  if (c.rpm === 0) {
    return {
      allowed: false,
      reason: '0 requests per minute exceeded',
      retryAfterMs: 60_000,
    };
  }
  if (rec.rpmLog.length >= c.rpm) {
    const oldest = rec.rpmLog[0];
    return {
      allowed: false,
      reason: `${c.rpm} requests per minute exceeded`,
      retryAfterMs: Math.max(1000, 60_000 - (t - oldest || 0)),
    };
  }

  return { allowed: true };
}

/**
 * Record actual consumption AFTER a run completes. `tokens` is the sum
 * of agent-core stats.approxPromptTokens + approxCompletionTokens.
 */
function record(userId, { tokens = 0 } = {}) {
  const rec = getOrInit(userId);
  rollWindows(rec);
  const safeTokens = normalizeTokens(tokens);
  rec.hourTokens = Math.min(MAX_TOKEN_CAP, rec.hourTokens + safeTokens);
  rec.dayTokens = Math.min(MAX_TOKEN_CAP, rec.dayTokens + safeTokens);
  rec.hourRequests += 1;
  rec.dayRequests += 1;
  const t = now();
  pruneRpmLog(rec, t);
  rec.rpmLog.push(t);
  if (rec.rpmLog.length > MAX_RPM_LOG_ENTRIES) {
    rec.rpmLog = rec.rpmLog.slice(rec.rpmLog.length - MAX_RPM_LOG_ENTRIES);
  }
}

function msUntilMidnightUTC() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return next.getTime() - now.getTime();
}
function msUntilNextHour() {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(now.getUTCHours() + 1, 0, 0, 0);
  return next.getTime() - now.getTime();
}

function getUsage(userId) {
  const id = normalizeUserId(userId);
  if (!id) return { dayTokens: 0, hourTokens: 0, dayRequests: 0, hourRequests: 0 };
  const rec = ledger.get(id);
  if (!rec) return { dayTokens: 0, hourTokens: 0, dayRequests: 0, hourRequests: 0 };
  rollWindows(rec);
  return {
    dayTokens: rec.dayTokens,
    hourTokens: rec.hourTokens,
    dayRequests: rec.dayRequests,
    hourRequests: rec.hourRequests,
  };
}

function _reset() { ledger.clear(); }

/**
 * Express middleware factory. Use on routes that run agents.
 *   router.post('/expensive', budgetMiddleware(), handler)
 * The middleware does a pre-check; after the handler finishes, it does
 * NOT auto-record — the handler is expected to call record() with the
 * real token count from result.stats. We don't overcharge on pre-check.
 */
function budgetMiddleware(caps) {
  return (req, res, next) => {
    const uid = normalizeUserId(req.user?.id);
    if (!uid) return next(); // auth middleware should have caught this
    const check = checkAllowed(uid, { caps });
    if (!check.allowed) {
      const retryAfterSec = Math.max(1, Math.ceil(check.retryAfterMs / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      const requestId = getRequestId(req);
      return res.status(429).json({
        ok: false,
        error: 'rate_limited',
        code: 'agent_budget_limited',
        reason: check.reason,
        retryAfterMs: check.retryAfterMs,
        retryAfterSec,
        ...(requestId ? { requestId } : {}),
      });
    }
    next();
  };
}

module.exports = {
  checkAllowed,
  record,
  getUsage,
  budgetMiddleware,
  _reset,
  DAILY_TOKENS,
  HOURLY_TOKENS,
  RPM,
  MAX_LEDGER_USERS,
  MAX_RPM_LOG_ENTRIES,
  MAX_USER_ID_LENGTH,
};
