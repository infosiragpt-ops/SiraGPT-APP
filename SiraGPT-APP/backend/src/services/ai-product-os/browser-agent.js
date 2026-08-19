/**
 * browser-agent — typed wrapper for browser / "computer use" actions.
 *
 * The actual driver (Playwright / Puppeteer / OpenAI computer-use)
 * is injected by the caller. This module:
 *
 *   - declares the action vocabulary
 *   - validates arguments before dispatch
 *   - enforces safety policy (allow/deny domain lists, no captcha
 *     bypass, no auth wall bypass, screenshot evidence required for
 *     non-trivial actions)
 *   - records every action in an evidence trail with a stable id
 *
 * The intent is to make browser actions reviewable. A run produces a
 * structured timeline that can be replayed offline.
 *
 * Pure JS, deterministic dispatcher; the I/O is the driver's job.
 */

const ACTIONS = Object.freeze([
  "navigate",     // { url }
  "click",        // { selector }
  "type",         // { selector, text }
  "press",        // { key }
  "select",       // { selector, value }
  "wait_for",     // { selector, timeout_ms? }
  "extract_text", // { selector }
  "extract_table",// { selector }
  "screenshot",   // { full_page? }
  "scroll",       // { y? | selector? }
  "go_back",
  "go_forward",
  "reload",
  "close",
]);

const SCHEMA = {
  navigate:      ["url"],
  click:         ["selector"],
  type:          ["selector", "text"],
  press:         ["key"],
  select:        ["selector", "value"],
  wait_for:      ["selector"],
  extract_text:  ["selector"],
  extract_table: ["selector"],
  screenshot:    [],
  scroll:        [],
  go_back:       [],
  go_forward:    [],
  reload:        [],
  close:         [],
};

// Default safety policy — users override at runtime.
const DEFAULT_POLICY = Object.freeze({
  allowDomains: [],            // [] = allow all (still subject to deny)
  denyDomains: ["accounts.google.com", "login.microsoftonline.com", "appleid.apple.com"],
  forbidden_action_patterns: [
    /captcha/i, /recaptcha/i, /hcaptcha/i, /paywall/i,
  ],
  require_screenshot_on: ["navigate", "click", "extract_text", "extract_table"],
  max_steps: 80,
});

function createBrowserAgent({ driver, policy = DEFAULT_POLICY } = {}) {
  if (!driver || typeof driver.run !== "function") {
    throw new Error("browser-agent: driver { run(action, args) } required");
  }
  const trail = [];
  let stepCount = 0;

  async function run(action, args = {}) {
    if (!ACTIONS.includes(action)) {
      throw mkErr("unknown_action", `unknown action "${action}"`);
    }
    if (stepCount >= policy.max_steps) {
      throw mkErr("max_steps_exceeded", `step budget ${policy.max_steps} exhausted`);
    }
    validateArgs(action, args);
    enforcePolicy(action, args, policy);

    stepCount += 1;
    const stepId = `step_${stepCount.toString(16).padStart(4, "0")}`;
    const startedAt = new Date().toISOString();
    let result;
    let error = null;
    try {
      result = await driver.run(action, args);
    } catch (err) {
      error = { code: err.code || "driver_error", message: err.message || String(err) };
    }
    const screenshot = (policy.require_screenshot_on.includes(action) && !error)
      ? await safeScreenshot(driver)
      : null;
    const record = {
      step_id: stepId,
      action,
      args,
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      ok: error === null,
      error,
      screenshot_id: screenshot ? screenshot.id : null,
      result_summary: error ? null : summarize(action, result),
    };
    trail.push(record);
    if (error) throw mkErr(error.code, error.message);
    return { record, result, screenshot };
  }

  function getTrail() { return [...trail]; }
  function reset() { trail.length = 0; stepCount = 0; }

  function exportEvidence() {
    return {
      step_count: stepCount,
      trail: getTrail(),
      generated_at: new Date().toISOString(),
    };
  }

  return { run, getTrail, reset, exportEvidence, ACTIONS };
}

function validateArgs(action, args) {
  const required = SCHEMA[action] || [];
  for (const k of required) {
    if (typeof args[k] === "undefined" || args[k] === null || args[k] === "") {
      throw mkErr("invalid_args", `action "${action}" requires "${k}"`);
    }
  }
  if (action === "navigate") {
    try {
      const u = new URL(args.url);
      if (!/^https?:$/.test(u.protocol)) throw new Error("only http(s) supported");
    } catch (_e) {
      throw mkErr("invalid_url", "navigate.url must be a valid http(s) URL");
    }
  }
}

function enforcePolicy(action, args, policy) {
  const url = args.url || "";
  const text = args.text || "";
  // forbidden patterns in text input (e.g. user-supplied OTP / captcha attempt)
  for (const re of policy.forbidden_action_patterns || []) {
    if (re.test(text) || re.test(action)) {
      throw mkErr("policy_violation", `forbidden pattern matched: ${re.source}`);
    }
  }
  if (action === "navigate") {
    let host = "";
    try { host = new URL(url).host; } catch (_e) { return; }
    if ((policy.denyDomains || []).some(d => host === d || host.endsWith(`.${d}`))) {
      throw mkErr("policy_violation", `domain "${host}" is in deny list`);
    }
    if ((policy.allowDomains || []).length > 0 && !policy.allowDomains.some(d => host === d || host.endsWith(`.${d}`))) {
      throw mkErr("policy_violation", `domain "${host}" not in allow list`);
    }
  }
}

async function safeScreenshot(driver) {
  if (typeof driver.screenshot === "function") {
    try {
      const out = await driver.screenshot({ full_page: false });
      return out || null;
    } catch (_e) {
      return null;
    }
  }
  return null;
}

function summarize(action, result) {
  if (!result) return null;
  if (action === "extract_text" && typeof result.text === "string") return { text_len: result.text.length };
  if (action === "extract_table" && Array.isArray(result.rows)) return { rows: result.rows.length, cols: result.rows[0]?.length || 0 };
  if (action === "navigate" && result.url) return { url: result.url, status: result.status || null };
  return Object.keys(result).slice(0, 6).reduce((m, k) => { m[k] = typeof result[k] === "string" ? result[k].slice(0, 120) : result[k]; return m; }, {});
}

function mkErr(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

module.exports = {
  createBrowserAgent,
  ACTIONS,
  DEFAULT_POLICY,
};
