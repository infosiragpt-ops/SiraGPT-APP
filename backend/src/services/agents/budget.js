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

const DAILY_TOKENS = parseInt(process.env.BUDGET_DAILY_TOKENS_DEFAULT || '2000000', 10);
const HOURLY_TOKENS = parseInt(process.env.BUDGET_HOURLY_TOKENS_DEFAULT || '500000', 10);
const RPM = parseInt(process.env.BUDGET_RPM_DEFAULT || '60', 10);

// userId → { windows: {...}, requestLog: number[] (timestamps ms) }
const ledger = new Map();

function now() { return Date.now(); }

function currentHour() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}-${d.getUTCHours()}`;
}

function currentDay() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

function getOrInit(userId) {
  let rec = ledger.get(userId);
  if (!rec) {
    rec = {
      hourWindow: currentHour(),
      dayWindow: currentDay(),
      hourTokens: 0,
      dayTokens: 0,
      hourRequests: 0,
      dayRequests: 0,
      rpmLog: [], // rolling-window timestamps
    };
    ledger.set(userId, rec);
  }
  return rec;
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

/**
 * Check if this call is allowed. Returns { allowed: true } or
 * { allowed: false, reason: '<human>', retryAfterMs: number }.
 *
 * Caller should call this BEFORE starting the agent run. Tokens are
 * charged via record() after the run reports actual usage.
 */
function checkAllowed(userId, { caps } = {}) {
  const c = {
    daily: caps?.daily ?? DAILY_TOKENS,
    hourly: caps?.hourly ?? HOURLY_TOKENS,
    rpm: caps?.rpm ?? RPM,
  };
  const rec = getOrInit(userId);
  rollWindows(rec);

  if (rec.dayTokens >= c.daily) {
    return {
      allowed: false,
      reason: `daily token budget (${c.daily}) exceeded`,
      retryAfterMs: msUntilMidnightUTC(),
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
  rec.rpmLog = rec.rpmLog.filter(ts => t - ts < 60_000);
  if (rec.rpmLog.length >= c.rpm) {
    const oldest = rec.rpmLog[0];
    return {
      allowed: false,
      reason: `${c.rpm} requests per minute exceeded`,
      retryAfterMs: Math.max(1000, 60_000 - (t - oldest)),
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
  rec.hourTokens += tokens;
  rec.dayTokens += tokens;
  rec.hourRequests += 1;
  rec.dayRequests += 1;
  rec.rpmLog.push(now());
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
  const rec = ledger.get(userId);
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
    const uid = req.user?.id;
    if (!uid) return next(); // auth middleware should have caught this
    const check = checkAllowed(uid, { caps });
    if (!check.allowed) {
      res.setHeader('Retry-After', Math.ceil(check.retryAfterMs / 1000));
      return res.status(429).json({ error: 'rate_limited', reason: check.reason, retryAfterMs: check.retryAfterMs });
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
};
