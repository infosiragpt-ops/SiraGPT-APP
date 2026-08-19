/**
 * scraper-policy — compliance gate over a caller-supplied scraper
 * config. Rejects configurations that attempt to:
 *
 *   - Solve or bypass CAPTCHAs
 *   - Evade paywalls / geo walls / age gates
 *   - Scrape authenticated content using stolen / scripted creds
 *   - Hide the agent behind an opaque / rotating User-Agent
 *   - Ignore robots.txt / rate limits
 *
 * The gate is *pure*: it takes a config object and returns a list
 * of findings in the ValidationFabric SecurityReport shape. The
 * orchestrator decides what to do (block at hard-block policy,
 * surface to HITL for manual approval, etc.).
 *
 * The point is to make compliance violations EXPLICIT in code so no
 * prompt-engineered agent can "improvise" around them.
 */

const BANNED_CONFIG_KEYS = new Set([
  "captcha_bypass", "captchaBypass", "solve_captcha", "solveCaptcha",
  "paywall_bypass", "paywallBypass", "bypass_auth", "bypassAuth",
  "cookie_injection", "cookieInjection",
  "rotate_fingerprint", "rotateFingerprint",
  "impersonate_browser_fingerprint",
  "ignore_robots", "ignoreRobots",
  "disable_rate_limit", "disableRateLimit",
]);

const BANNED_VALUE_PATTERNS = [
  // regex tested against stringified values
  /\b2captcha\b/i,
  /\bdeathbycaptcha\b/i,
  /\bcapsolver\b/i,
  /\banticaptcha\b/i,
  /\brecaptcha[-_]?solver\b/i,
  /\bhcaptcha[-_]?solver\b/i,
  /\bbypass[-_]?paywall\b/i,
  /\bcookie[-_]?jar[-_]?stolen\b/i,
  /\bcredential[-_]?stuffing\b/i,
];

const SUSPICIOUS_UA_PATTERNS = [
  /^$/,
  /^.{0,5}$/,                       // too short to identify anyone
  /Mozilla\/5\.0$/,                 // truncated UA
  /selenium|puppeteer|playwright-stealth/i, // automation-concealment
  // Raw HTTP-client tool names — caller forgot to set a real UA
  /^(curl|wget|python-requests|requests|axios|go-http-client|java|php|okhttp|http-client|urllib|libwww-perl|libcurl)(?:\/?\d[\w.]*)?$/i,
];

/**
 * @param {object} config — arbitrary scraper config (flat or nested)
 * @returns {{ ok: boolean, findings: Array<{severity, code, detail}> }}
 */
function reviewScraperPolicy(config) {
  const findings = [];
  if (!config || typeof config !== "object") {
    findings.push({ severity: "high", code: "no_config", detail: "scraper-policy: no config supplied" });
    return { ok: false, findings };
  }

  // 1. Banned keys anywhere in the tree
  const walk = (node, path) => {
    if (node == null) return;
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${path}[${i}]`)); return; }
    if (typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        if (BANNED_CONFIG_KEYS.has(k)) {
          findings.push({
            severity: "critical",
            code: "banned_compliance_flag",
            detail: `${path ? `${path}.` : ""}${k} is a compliance-banned flag; never enable CAPTCHA/paywall/auth/rate-limit bypass.`,
          });
        }
        walk(v, path ? `${path}.${k}` : k);
      }
      return;
    }
    if (typeof node === "string") {
      for (const rx of BANNED_VALUE_PATTERNS) {
        if (rx.test(node)) {
          findings.push({
            severity: "critical",
            code: "banned_value_token",
            detail: `${path}: value matches banned token ${rx.source}.`,
          });
        }
      }
    }
  };
  walk(config, "");

  // 2. Required compliance keys MUST be positive
  if (config.respect_robots !== true && config.respectRobots !== true) {
    findings.push({ severity: "high", code: "respect_robots_not_set", detail: "Scraper config must set respect_robots:true explicitly." });
  }
  if (config.respect_rate_limit === false || config.respectRateLimit === false) {
    findings.push({ severity: "critical", code: "rate_limit_disabled", detail: "respect_rate_limit:false is not allowed — the crawler would overwhelm the target." });
  }

  // 3. User-Agent must be transparent and identifying
  const ua = config.user_agent || config.userAgent || "";
  for (const rx of SUSPICIOUS_UA_PATTERNS) {
    if (rx.test(String(ua))) {
      findings.push({
        severity: "high",
        code: "opaque_user_agent",
        detail: `User-Agent "${ua}" is missing, truncated, or tries to conceal automation. Use a transparent string like "sira-gpt-crawler/1.0 (+https://siragpt.io/bot)".`,
      });
      break;
    }
  }
  // UA should contain either a contact URL (+https://...) or a mailto.
  if (ua && !/(\+https?:\/\/|mailto:)/.test(String(ua))) {
    findings.push({
      severity: "medium",
      code: "user_agent_no_contact",
      detail: "User-Agent should include a contact URL or email so the operator can reach you.",
    });
  }

  // 4. Required scraper metadata
  const missingMeta = [];
  if (!config.project_name && !config.projectName) missingMeta.push("project_name");
  if (!config.owner_contact && !config.ownerContact) missingMeta.push("owner_contact");
  if (!config.purpose) missingMeta.push("purpose");
  if (missingMeta.length) {
    findings.push({
      severity: "medium",
      code: "incomplete_metadata",
      detail: `Config is missing identity metadata: ${missingMeta.join(", ")}. Required for audit trail.`,
    });
  }

  // 5. URL allowlist / denylist sanity
  const allow = Array.isArray(config.allow_hosts) ? config.allow_hosts : (config.allowHosts || []);
  const deny = Array.isArray(config.deny_paths) ? config.deny_paths : (config.denyPaths || []);
  if (!Array.isArray(allow) || allow.length === 0) {
    findings.push({
      severity: "medium",
      code: "no_allowlist",
      detail: "allow_hosts is empty — the crawler will accept any host. Set an explicit allowlist.",
    });
  }
  if (!Array.isArray(deny)) {
    findings.push({ severity: "low", code: "deny_paths_not_array", detail: "deny_paths should be an array of path prefixes." });
  }

  return {
    ok: findings.every(f => f.severity !== "critical" && f.severity !== "high"),
    findings,
  };
}

module.exports = {
  reviewScraperPolicy,
  BANNED_CONFIG_KEYS,
  BANNED_VALUE_PATTERNS,
  SUSPICIOUS_UA_PATTERNS,
};
