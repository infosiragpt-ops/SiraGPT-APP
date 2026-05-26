/**
 * owasp-asvs — structured OWASP Application Security Verification
 * Standard (ASVS) v4.0.3 Level-1 controls. Each control is a
 * declarative descriptor the Security Governance Layer evaluates
 * against a deliverable (a generated app, an API surface, a code
 * diff) before the ReleaseController signs off.
 *
 * The catalogue here intentionally covers the most commonly
 * applicable L1 controls for a backend + web deliverable. The
 * point is NOT to restate the whole ASVS — it is to give the
 * agent a concrete, testable checklist with the same JSON shape
 * the Agentic QA Board understands.
 *
 * Source of control texts: OWASP ASVS v4.0.3 (MIT License).
 * https://owasp.org/www-project-application-security-verification-standard/
 *
 * How it integrates:
 *   - Each control has an optional `evaluator` function. If the
 *     caller supplies a `context` (files, config, manifests, etc.)
 *     and the control declares an evaluator, `evaluateAsvs` runs it
 *     and collects a pass/fail finding.
 *   - Controls without an evaluator become manual-review findings
 *     with severity=info when the caller has nothing to feed them,
 *     so the SecurityReport shows they're acknowledged but not yet
 *     auto-checkable.
 *   - The aggregated output fits ValidationFabric.aggregate()
 *     directly — no adapter layer needed.
 */

// ─── Catalogue ──────────────────────────────────────────────────────────

const ASVS_CONTROLS = [
  // V2 — Authentication
  {
    id: "V2.1.1",
    category: "V2 Authentication",
    text: "Verify that user set passwords are at least 12 characters in length.",
    severity: "high",
    evaluator: ({ passwordPolicy } = {}) => {
      if (!passwordPolicy) return { skipped: "no passwordPolicy in context" };
      return { ok: (passwordPolicy.minLength || 0) >= 12, detail: `minLength=${passwordPolicy.minLength}` };
    },
  },
  {
    id: "V2.2.1",
    category: "V2 Authentication",
    text: "Verify that anti-automation controls are effective at mitigating breached credential testing.",
    severity: "high",
    evaluator: ({ rateLimits, captcha } = {}) => ({
      ok: Boolean((rateLimits && rateLimits.login) || captcha),
      detail: rateLimits?.login ? "login rate limit present" : captcha ? "captcha present" : "no anti-automation",
    }),
  },
  {
    id: "V2.7.1",
    category: "V2 Authentication",
    text: "Verify that one-time verifier codes do not rely on SMS as the primary factor when higher assurance is required.",
    severity: "medium",
  },

  // V4 — Access Control
  {
    id: "V4.1.1",
    category: "V4 Access Control",
    text: "Verify that the application enforces access control rules on a trusted service layer, never on the client.",
    severity: "critical",
    evaluator: ({ authMiddleware } = {}) => ({
      ok: Boolean(authMiddleware && authMiddleware.serverSide === true),
      detail: authMiddleware?.serverSide ? "server-side auth middleware detected" : "missing server-side auth",
    }),
  },
  {
    id: "V4.1.3",
    category: "V4 Access Control",
    text: "Verify that the principle of least privilege exists — users should only be able to access resources they own or have been granted.",
    severity: "high",
    evaluator: ({ rbac } = {}) => ({
      ok: Boolean(rbac && (rbac.policyEngine || Array.isArray(rbac.roles))),
      detail: rbac ? "rbac config present" : "no rbac config in context",
    }),
  },

  // V5 — Validation, Sanitization & Encoding
  {
    id: "V5.1.3",
    category: "V5 Validation",
    text: "Verify that all input (HTTP, HTML, GraphQL, CSV/XLSX) is validated against a positive list using server-side schema.",
    severity: "critical",
    evaluator: ({ inputValidators } = {}) => ({
      ok: Boolean(inputValidators && inputValidators.positiveSchema === true),
      detail: inputValidators?.positiveSchema ? "positive schema validators present" : "no positive schema detected",
    }),
  },
  {
    id: "V5.3.4",
    category: "V5 Validation",
    text: "Verify that data selection or database queries use parameterised queries, stored procedures, or ORM to protect against SQL injection.",
    severity: "critical",
    evaluator: ({ sqlGovernance } = {}) => ({
      ok: Boolean(sqlGovernance && sqlGovernance.parameterisedOnly === true),
      detail: sqlGovernance?.parameterisedOnly ? "SQL governance enforces parameterised-only" : "no SQL governance in context",
    }),
  },
  {
    id: "V5.3.3",
    category: "V5 Validation",
    text: "Verify that context-aware output encoding is used, especially for HTML, JavaScript and URLs, to prevent XSS.",
    severity: "critical",
    evaluator: ({ outputEncoding } = {}) => ({
      ok: Boolean(outputEncoding && outputEncoding.contextAware === true),
      detail: outputEncoding?.contextAware ? "context-aware encoding present" : "no encoding config",
    }),
  },

  // V7 — Error Handling & Logging
  {
    id: "V7.1.1",
    category: "V7 Errors & Logging",
    text: "Verify that the application does not log credentials, session tokens, or tokens that can be used to hijack or impersonate.",
    severity: "high",
    evaluator: ({ logRedaction } = {}) => ({
      ok: Boolean(logRedaction && logRedaction.secretsMasked === true),
      detail: logRedaction?.secretsMasked ? "secrets are masked in logs" : "no log redaction policy",
    }),
  },
  {
    id: "V7.4.1",
    category: "V7 Errors & Logging",
    text: "Verify that errors, and particularly error-handling code paths, do not expose sensitive information (stack traces, SQL, file paths).",
    severity: "high",
  },

  // V8 — Data Protection
  {
    id: "V8.1.1",
    category: "V8 Data Protection",
    text: "Verify that sensitive data is sent to the server only in HTTP headers (Authorization) or body, never URL parameters, and never logged.",
    severity: "high",
  },
  {
    id: "V8.3.1",
    category: "V8 Data Protection",
    text: "Verify that sensitive data is not cached in stores such as browser cache, local storage, or session storage without explicit control.",
    severity: "medium",
  },

  // V9 — Communications
  {
    id: "V9.1.1",
    category: "V9 Communications",
    text: "Verify that all encrypted connections to external systems use TLS 1.2 or higher with strong cipher suites.",
    severity: "critical",
    evaluator: ({ tls } = {}) => ({
      ok: tls ? Number(tls.minVersion) >= 1.2 : false,
      detail: tls ? `minVersion=${tls.minVersion}` : "no TLS config in context",
    }),
  },

  // V13 — API & Web Service Verification
  {
    id: "V13.1.3",
    category: "V13 API",
    text: "Verify API URLs do not expose sensitive information such as API keys, session tokens, etc.",
    severity: "high",
  },
  {
    id: "V13.2.1",
    category: "V13 API",
    text: "Verify that enabled RESTful HTTP methods are a valid choice for the user or action (POST does not replace GET, etc.).",
    severity: "medium",
  },

  // V14 — Configuration
  {
    id: "V14.2.1",
    category: "V14 Configuration",
    text: "Verify that all components are up to date, preferably using a dependency checker during build or compile time.",
    severity: "high",
    evaluator: ({ dependencyAudit } = {}) => ({
      ok: Boolean(dependencyAudit && dependencyAudit.lastRunOk === true),
      detail: dependencyAudit?.lastRunOk ? `audit passed at ${dependencyAudit.lastRunAt || "unknown"}` : "no recent audit",
    }),
  },
];

// ─── Evaluator ──────────────────────────────────────────────────────────

/**
 * @param {object} args
 * @param {object} [args.context] — arbitrary context passed to each evaluator
 * @param {string[]} [args.onlyControls] — restrict evaluation to these ids
 * @param {string[]} [args.skipControls]
 * @returns {{
 *   ok: boolean,                       // true when NO evaluator returned ok:false
 *   findings: Array<{severity,code,detail}>,
 *   evaluated: number,
 *   passed: number,
 *   failed: number,
 *   manual: number,
 * }}
 */
function evaluateAsvs({ context = {}, onlyControls, skipControls } = {}) {
  const findings = [];
  let evaluated = 0, passed = 0, failed = 0, manual = 0;
  const only = Array.isArray(onlyControls) && onlyControls.length > 0 ? new Set(onlyControls) : null;
  const skip = new Set(Array.isArray(skipControls) ? skipControls : []);

  for (const ctrl of ASVS_CONTROLS) {
    if (only && !only.has(ctrl.id)) continue;
    if (skip.has(ctrl.id)) continue;
    if (typeof ctrl.evaluator !== "function") {
      manual++;
      findings.push({
        severity: "info",
        code: `asvs_${ctrl.id}_manual`,
        detail: `${ctrl.id} [${ctrl.category}] requires manual review: ${ctrl.text}`,
      });
      continue;
    }
    evaluated++;
    let result;
    try { result = ctrl.evaluator(context); }
    catch (err) { result = { ok: false, detail: `evaluator threw: ${err.message}` }; }
    if (result && result.skipped) {
      findings.push({ severity: "info", code: `asvs_${ctrl.id}_skipped`, detail: `${ctrl.id} skipped: ${result.skipped}` });
      continue;
    }
    if (result && result.ok) {
      passed++;
      continue;
    }
    failed++;
    findings.push({
      severity: ctrl.severity || "medium",
      code: `asvs_${ctrl.id}`,
      detail: `${ctrl.id} [${ctrl.category}] FAILED: ${ctrl.text}${result?.detail ? ` — ${result.detail}` : ""}`,
    });
  }

  return {
    ok: failed === 0,
    findings,
    evaluated,
    passed,
    failed,
    manual,
  };
}

function listControls() {
  return ASVS_CONTROLS.map(c => ({ id: c.id, category: c.category, severity: c.severity, hasEvaluator: typeof c.evaluator === "function" }));
}

function countByCategory() {
  const counts = {};
  for (const c of ASVS_CONTROLS) counts[c.category] = (counts[c.category] || 0) + 1;
  return counts;
}

module.exports = {
  ASVS_CONTROLS,
  evaluateAsvs,
  listControls,
  countByCategory,
};
