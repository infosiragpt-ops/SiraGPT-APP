import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { describe, it } from "node:test"
import path from "node:path"

const recovery = require(path.join(
  process.cwd(),
  "scripts/local-chat-recovery.js",
))
const readiness = require(path.join(
  process.cwd(),
  "scripts/local-chat-readiness.js",
))

describe("local chat recovery doctor", () => {
  it("recommends frontend and backend recovery commands from failed checks", () => {
    const actions = recovery.recommendRecoveryActions({
      ok: false,
      checks: [
        { name: "frontend_routes", ok: false, required: true },
        { name: "backend_auth", ok: false, required: true, endpoints: [{ path: "/health/live", ok: false }] },
      ],
    })

    assert.deepEqual(actions.map((action: { id: string }) => action.id), [
      "frontend_dev_server",
      "backend_dev_server",
    ])
    assert.match(actions[0].command, /npm run dev -- -H 127\.0\.0\.1 -p 3000/)
    assert.match(actions[1].command, /cd backend && npm run dev/)
  })

  it("redacts secrets in markdown reports", () => {
    const report = recovery.formatMarkdownReport({
      ok: false,
      frontendUrl: "http://127.0.0.1:3000",
      apiUrl: "http://127.0.0.1:5000",
      checks: [{ name: "backend_auth", ok: false, required: true }],
    }, [
      {
        id: "login_credentials",
        title: "Credenciales",
        command: "SIRAGPT_TEST_PASSWORD=super-secret-password curl -H 'Authorization: Bearer abc123'",
      },
    ])

    assert.match(report, /SIRAGPT_TEST_PASSWORD=<password>/)
    assert.match(report, /Bearer <token>/)
    assert.equal(report.includes("super-secret-password"), false)
    assert.equal(report.includes("abc123"), false)
  })

  it("redacts URL credentials and npm tokens in reports", () => {
    const report = recovery.formatMarkdownReport({
      ok: false,
      frontendUrl: "http://127.0.0.1:3000",
      apiUrl: "http://127.0.0.1:5000",
      checks: [{ name: "backend_auth", ok: false, required: true }],
    }, [
      {
        id: "dependency_probe",
        title: "Dependency probe",
        command: "curl https://user:secret-pass@example.com && NPM_TOKEN=npm_secret npm ping",
      },
    ])

    assert.match(report, /https:\/\/<user>:<password>@example\.com/)
    assert.match(report, /NPM_TOKEN=<token>/)
    assert.equal(report.includes("secret-pass"), false)
    assert.equal(report.includes("npm_secret"), false)
  })

  it("writes markdown diagnostics to a caller-controlled path", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "siragpt-report-"))
    const reportPath = path.join(directory, "diagnostics.md")
    const writtenPath = recovery.writeReportFile(reportPath, "# Safe report")

    assert.equal(writtenPath, reportPath)
    assert.equal(readFileSync(reportPath, "utf8"), "# Safe report\n")
  })

  it("cleans only old local diagnostics reports from the target directory", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "siragpt-clean-reports-"))
    const oldReport = path.join(directory, "siragpt-local-chat-diagnostics-old.md")
    const freshReport = path.join(directory, "siragpt-local-chat-diagnostics-fresh.md")
    const unrelatedReport = path.join(directory, "other-report.md")
    writeFileSync(oldReport, "old")
    writeFileSync(freshReport, "fresh")
    writeFileSync(unrelatedReport, "unrelated")

    const nowMs = Date.UTC(2026, 4, 22, 12)
    fsUtimes(oldReport, new Date(nowMs - 48 * 60 * 60 * 1000))
    fsUtimes(freshReport, new Date(nowMs - 60 * 60 * 1000))
    fsUtimes(unrelatedReport, new Date(nowMs - 48 * 60 * 60 * 1000))

    const removed = recovery.cleanupOldReports({ directory, maxAgeHours: 24, nowMs })

    assert.deepEqual(removed, [oldReport])
    assert.equal(existsSync(oldReport), false)
    assert.equal(existsSync(freshReport), true)
    assert.equal(existsSync(unrelatedReport), true)
  })

  it("resolves differentiated exit codes for local failure classes", () => {
    assert.equal(recovery.resolveRecoveryExitCode({ ok: true, checks: [] }), recovery.RECOVERY_EXIT_CODES.ok)
    assert.equal(recovery.resolveRecoveryExitCode({
      ok: false,
      checks: [{ name: "local_env", ok: false, required: true }],
    }), recovery.RECOVERY_EXIT_CODES.localEnv)
    assert.equal(recovery.resolveRecoveryExitCode({
      ok: false,
      checks: [{ name: "frontend_routes", ok: false, required: true }],
    }), recovery.RECOVERY_EXIT_CODES.frontend)
    assert.equal(recovery.resolveRecoveryExitCode({
      ok: false,
      checks: [{ name: "backend_auth", ok: false, required: true, endpoints: [{ path: "/health/live", ok: false }] }],
    }), recovery.RECOVERY_EXIT_CODES.backend)
  })

  it("documents CLI options, security guarantees and exit codes in help output", () => {
    const help = recovery.usage()

    assert.match(help, /--summary-json/)
    assert.match(help, /--strict-env/)
    assert.match(help, /--timeout-ms <n>/)
    assert.match(help, /--write-report \[path\]/)
    assert.match(help, /--max-report-age-hours <n>/)
    assert.match(help, /31\s+frontend routes unavailable/)
    assert.match(help, /32\s+backend health unavailable/)
    assert.match(help, /Reports redact passwords and bearer tokens/)
  })

  it("detects local .env.local presence without leaking values", () => {
    const fileEnv = readiness.parseEnvFile("NEXT_PUBLIC_API_URL=http://127.0.0.1:5000/api\n")
    const check = readiness.checkLocalEnv({}, { fileEnv, required: true })

    assert.equal(check.ok, true)
    assert.equal(check.required, true)
    assert.deepEqual(check.variables[0], {
      key: "NEXT_PUBLIC_API_URL",
      present: true,
      source: ".env.local",
    })
    assert.equal(JSON.stringify(check).includes("127.0.0.1:5000/api"), false)
  })

  it("marks required login probe blocked when test credentials are missing", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response("", { status: 200 })) as typeof fetch
    try {
      const check = await readiness.checkBackend("http://127.0.0.1:5000", {
        requireLogin: true,
        env: {},
      })
      const loginEndpoint = check.endpoints.find((endpoint: { path: string }) => endpoint.path === "/api/auth/login")

      assert.equal(check.ok, false)
      assert.equal(loginEndpoint.ok, false)
      assert.equal(loginEndpoint.required, true)
      assert.deepEqual(loginEndpoint.failures, ["missing_credentials"])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("probes login with explicit test credentials without storing secrets in results", async () => {
    const originalFetch = globalThis.fetch
    const calls: Array<{ url: string; options: RequestInit }> = []
    globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
      calls.push({ url: String(url), options: options || {} })
      return new Response("", { status: 200 })
    }) as typeof fetch
    try {
      const check = await readiness.checkBackend("http://127.0.0.1:5000", {
        requireLogin: true,
        env: {
          SIRAGPT_TEST_EMAIL: "admin@example.com",
          SIRAGPT_TEST_PASSWORD: "super-secret-password",
        },
      })
      const loginCall = calls.find((call) => call.url.endsWith("/api/auth/login"))

      assert.equal(check.ok, true)
      assert.equal(loginCall?.options.method, "POST")
      assert.equal(String(loginCall?.options.body).includes("super-secret-password"), true)
      assert.equal(JSON.stringify(check).includes("super-secret-password"), false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("includes a stable schema version in compact CI summaries", () => {
    const summary = readiness.buildReadinessCiSummary({
      ok: false,
      frontendUrl: "http://127.0.0.1:3000",
      apiUrl: "http://127.0.0.1:5000",
      checks: [{ name: "backend_auth", ok: false, required: true }],
    })
    const recoverySummary = recovery.buildRecoveryCiSummary({
      ok: false,
      frontendUrl: "http://127.0.0.1:3000",
      apiUrl: "http://127.0.0.1:5000",
      checks: [{ name: "backend_auth", ok: false, required: true }],
    })

    assert.equal(readiness.CI_SUMMARY_SCHEMA_VERSION, 1)
    assert.equal(summary.schemaVersion, 1)
    assert.equal(recoverySummary.schemaVersion, 1)
  })

  it("includes primary failure and action fields for automation summaries", () => {
    const recoverySummary = recovery.buildRecoveryCiSummary({
      ok: false,
      frontendUrl: "http://127.0.0.1:3000",
      apiUrl: "http://127.0.0.1:5000",
      checks: [
        { name: "local_env", ok: false, required: false },
        { name: "frontend_routes", ok: true, required: true },
        { name: "backend_auth", ok: false, required: true, endpoints: [{ path: "/health/live", ok: false }] },
      ],
    })

    assert.equal(recoverySummary.primaryFailure, "backend_auth")
    assert.equal(recoverySummary.primaryAction, "backend_dev_server")
    assert.equal(recoverySummary.healthCode, "backend_down")
    assert.equal(recoverySummary.exitCode, recovery.RECOVERY_EXIT_CODES.backend)
    assert.deepEqual(recoverySummary.warnings, ["local_env"])
  })

  it("includes timing counters and sanitized URLs in compact summaries", () => {
    const summary = readiness.buildReadinessCiSummary({
      ok: false,
      durationMs: 42,
      frontendUrl: "http://frontend-user:frontend-pass@127.0.0.1:3000",
      apiUrl: "http://api-user:api-pass@127.0.0.1:5000",
      checks: [
        { name: "local_env", ok: false, required: false, durationMs: 0 },
        {
          name: "frontend_routes",
          ok: true,
          required: true,
          durationMs: 12,
          routes: [{ path: "/chat", ok: true, status: 200, durationMs: 12 }],
        },
        {
          name: "backend_auth",
          ok: false,
          required: true,
          durationMs: 30,
          endpoints: [{ path: "/health/live", ok: false, status: 503, durationMs: 30 }],
        },
      ],
    })

    assert.equal(summary.durationMs, 42)
    assert.equal(summary.overallStatus, "blocked")
    assert.equal(summary.totalChecks, 3)
    assert.deepEqual(summary.statusCounts, { ok: 1, warning: 1, blocked: 1 })
    assert.equal(summary.failedRequiredCount, 1)
    assert.equal(summary.warningCount, 1)
    assert.equal(summary.checks[1].durationMs, 12)
    assert.equal(summary.latencySummary.probeCount, 2)
    assert.deepEqual(summary.latencySummary.slowestProbe, {
      check: "backend_auth",
      probe: "/health/live",
      durationMs: 30,
      ok: false,
      status: 503,
    })
    assert.equal(summary.frontendUrl, "http://127.0.0.1:3000")
    assert.equal(summary.apiUrl, "http://127.0.0.1:5000")
    assert.equal(JSON.stringify(summary).includes("frontend-pass"), false)
    assert.equal(JSON.stringify(summary).includes("api-pass"), false)
  })

  it("normalizes check statuses and minimal status summaries", () => {
    assert.equal(readiness.checkStatus({ ok: true, required: true }), "ok")
    assert.equal(readiness.checkStatus({ ok: false, required: false }), "warning")
    assert.equal(readiness.checkStatus({ ok: false, required: true }), "blocked")
    assert.equal(readiness.overallStatusFromCounts({ ok: 2, warning: 1, blocked: 0 }), "warning")

    const status = recovery.buildStatusSummary({
      schemaVersion: 1,
      ok: false,
      overallStatus: "blocked",
      healthCode: "backend_down",
      primaryFailure: "backend_auth",
      primaryAction: "backend_dev_server",
      exitCode: 32,
      failedRequiredCount: 1,
      warningCount: 0,
      actions: [{ command: "SIRAGPT_TEST_PASSWORD=secret" }],
    })

    assert.deepEqual(status, {
      schemaVersion: 1,
      ok: false,
      overallStatus: "blocked",
      healthCode: "backend_down",
      primaryFailure: "backend_auth",
      primaryAction: "backend_dev_server",
      exitCode: 32,
      failedRequiredCount: 1,
      warningCount: 0,
    })
  })

  it("includes compact failure summaries and action details", () => {
    const recoverySummary = recovery.buildRecoveryCiSummary({
      ok: false,
      frontendUrl: "http://127.0.0.1:3000",
      apiUrl: "http://127.0.0.1:5000",
      checks: [
        {
          name: "backend_auth",
          ok: false,
          required: true,
          endpoints: [{ path: "/health/live", ok: false, failures: ["request_error"] }],
        },
      ],
    })

    assert.equal(recoverySummary.failureSummary.backend_auth, "/health/live:request_error")
    assert.equal(recoverySummary.actionCount, 1)
    assert.equal(recoverySummary.actions[0].detail.includes("127.0.0.1:5000"), true)
  })

  it("sanitizes compact actions and builds an actions-only summary", () => {
    const recoverySummary = recovery.buildRecoveryCiSummary({
      ok: false,
      frontendUrl: "http://127.0.0.1:3000",
      apiUrl: "http://127.0.0.1:5000",
      checks: [{ name: "backend_auth", ok: false, required: true }],
    }, [
      {
        id: "secret_action",
        title: "Secret action",
        command: "SIRAGPT_TEST_PASSWORD=super-secret npm run smoke:local-chat",
        detail: "safe detail",
      },
    ])
    const actionsSummary = recovery.buildActionsSummary(recoverySummary)

    assert.equal(recoverySummary.actionCount, 1)
    assert.equal(recoverySummary.actions[0].remediationCode, "LOCAL_UNKNOWN_ACTION")
    assert.equal(recoverySummary.actions[0].severity, "medium")
    assert.equal(recoverySummary.actions[0].category, "unknown")
    assert.equal(recoverySummary.actions[0].sourceCheck, "unknown")
    assert.equal(recoverySummary.actions[0].priorityScore, 50)
    assert.equal(recoverySummary.actions[0].command, "SIRAGPT_TEST_PASSWORD=<password> npm run smoke:local-chat")
    assert.equal(JSON.stringify(actionsSummary).includes("super-secret"), false)
    assert.deepEqual(Object.keys(actionsSummary), [
      "schemaVersion",
      "ok",
      "overallStatus",
      "healthCode",
      "primaryAction",
      "actionCount",
      "actions",
    ])
  })

  it("adds stable remediation metadata to known recovery actions", () => {
    const recoverySummary = recovery.buildRecoveryCiSummary({
      ok: false,
      frontendUrl: "http://127.0.0.1:3000",
      apiUrl: "http://127.0.0.1:5000",
      checks: [{ name: "backend_auth", ok: false, required: true, endpoints: [{ path: "/health/live", ok: false }] }],
    })
    const backendAction = recoverySummary.actions.find((action: { id: string }) => action.id === "backend_dev_server")

    assert.equal(backendAction.remediationCode, "LOCAL_BACKEND_START")
    assert.equal(backendAction.severity, "critical")
    assert.equal(backendAction.category, "backend")
    assert.equal(backendAction.sourceCheck, "backend_auth")
    assert.equal(backendAction.priorityScore, 100)
    assert.equal(recoverySummary.highestPriorityScore, 100)
    assert.deepEqual(recoverySummary.highestPriorityActions, ["backend_dev_server"])
  })

  it("exposes a remediation catalog without secrets or probes", () => {
    const catalog = recovery.buildRemediationCatalog()

    assert.equal(catalog.schemaVersion, 1)
    assert.deepEqual(catalog.actions.find((action: { id: string }) => action.id === "local_env_file"), {
      id: "local_env_file",
      remediationCode: "LOCAL_ENV_CONFIG",
      severity: "medium",
      category: "configuration",
      sourceCheck: "local_env",
      priorityScore: 50,
    })
    assert.equal(JSON.stringify(catalog).includes("password"), false)
  })

  it("builds a sanitized check/action diagnostics matrix", () => {
    const recoverySummary = recovery.buildRecoveryCiSummary({
      ok: false,
      frontendUrl: "http://127.0.0.1:3000",
      apiUrl: "http://127.0.0.1:5000",
      checks: [
        { name: "local_env", ok: true, required: false },
        { name: "backend_auth", ok: false, required: true, endpoints: [{ path: "/health/live", ok: false }] },
      ],
    }, [
      {
        id: "backend_dev_server",
        title: "Levantar backend local",
        command: "SIRAGPT_TEST_PASSWORD=super-secret cd backend && npm run dev",
        detail: "safe detail",
      },
      {
        id: "unknown_action",
        title: "Unknown",
        command: "SIRAGPT_TEST_PASSWORD=super-secret npm run probe",
        detail: "safe unknown",
      },
    ])
    const matrix = recovery.buildDiagnosticsMatrix(recoverySummary)

    assert.equal(matrix.healthCode, "backend_down")
    assert.equal(matrix.checks.find((check: { name: string }) => check.name === "backend_auth").actions[0].id, "backend_dev_server")
    assert.equal(matrix.checks.find((check: { name: string }) => check.name === "backend_auth").actions[0].command, "SIRAGPT_TEST_PASSWORD=<password> cd backend && npm run dev")
    assert.equal(matrix.unmappedActions[0].sourceCheck, "unknown")
    assert.equal(JSON.stringify(matrix).includes("super-secret"), false)
  })

  it("summarizes remediation impact by category and severity", () => {
    const recoverySummary = recovery.buildRecoveryCiSummary({
      ok: false,
      frontendUrl: "http://127.0.0.1:3000",
      apiUrl: "http://127.0.0.1:5000",
      checks: [
        { name: "frontend_routes", ok: false, required: true },
        { name: "backend_auth", ok: false, required: true, endpoints: [{ path: "/health/live", ok: false }] },
      ],
    })
    const impact = recovery.buildActionImpactSummary(recoverySummary)

    assert.equal(impact.actionCount, 2)
    assert.equal(impact.criticalActionCount, 2)
    assert.equal(impact.byCategory.frontend, 1)
    assert.equal(impact.byCategory.backend, 1)
    assert.equal(impact.bySeverity.critical, 2)
    assert.deepEqual(impact.categories.find((category: { name: string }) => category.name === "backend").actions[0], {
      id: "backend_dev_server",
      remediationCode: "LOCAL_BACKEND_START",
      sourceCheck: "backend_auth",
      priorityScore: 100,
    })
    assert.equal(JSON.stringify(impact).includes("npm run dev"), false)
  })

  it("builds a command-free priority summary for triage", () => {
    const recoverySummary = recovery.buildRecoveryCiSummary({
      ok: false,
      frontendUrl: "http://127.0.0.1:3000",
      apiUrl: "http://127.0.0.1:5000",
      checks: [
        { name: "local_env", ok: false, required: false },
        { name: "backend_auth", ok: false, required: true, endpoints: [{ path: "/health/live", ok: false }] },
      ],
    })
    const priority = recovery.buildPrioritySummary(recoverySummary)

    assert.equal(priority.highestPriorityScore, 100)
    assert.deepEqual(priority.highestPriorityActions, ["backend_dev_server"])
    assert.equal(priority.actions.find((action: { id: string }) => action.id === "local_env_file").priorityScore, 50)
    assert.equal(JSON.stringify(priority).includes("cd backend"), false)
  })

  it("builds a sanitized next-action summary from highest priority", () => {
    const recoverySummary = recovery.buildRecoveryCiSummary({
      ok: false,
      frontendUrl: "http://127.0.0.1:3000",
      apiUrl: "http://127.0.0.1:5000",
      checks: [{ name: "backend_auth", ok: false, required: true, endpoints: [{ path: "/health/live", ok: false }] }],
    }, [
      {
        id: "local_env_file",
        title: "Env",
        command: "SIRAGPT_TEST_PASSWORD=super-secret printf env",
        detail: "medium",
      },
      {
        id: "backend_dev_server",
        title: "Backend",
        command: "SIRAGPT_TEST_PASSWORD=super-secret cd backend && npm run dev",
        detail: "critical",
      },
    ])
    const nextAction = recovery.buildNextActionSummary(recoverySummary)

    assert.equal(nextAction.nextAction.id, "backend_dev_server")
    assert.equal(nextAction.nextAction.priorityScore, 100)
    assert.equal(nextAction.nextAction.command, "SIRAGPT_TEST_PASSWORD=<password> cd backend && npm run dev")
    assert.equal(nextAction.reason, "backend_auth:critical:100")
    assert.equal(JSON.stringify(nextAction).includes("super-secret"), false)
  })

  it("builds a sanitized execution plan ordered by priority", () => {
    const recoverySummary = recovery.buildRecoveryCiSummary({
      ok: false,
      frontendUrl: "http://127.0.0.1:3000",
      apiUrl: "http://127.0.0.1:5000",
      checks: [
        { name: "local_env", ok: false, required: false },
        { name: "backend_auth", ok: false, required: true, endpoints: [{ path: "/health/live", ok: false }] },
      ],
    }, [
      {
        id: "local_env_file",
        title: "Env",
        command: "SIRAGPT_TEST_PASSWORD=super-secret printf env",
        detail: "medium",
      },
      {
        id: "backend_dev_server",
        title: "Backend",
        command: "SIRAGPT_TEST_PASSWORD=super-secret cd backend && npm run dev",
        detail: "critical",
      },
    ])
    const plan = recovery.buildActionExecutionPlan(recoverySummary)

    assert.equal(plan.stepCount, 2)
    assert.equal(plan.steps[0].step, 1)
    assert.equal(plan.steps[0].id, "backend_dev_server")
    assert.equal(plan.steps[1].step, 2)
    assert.equal(plan.steps[1].id, "local_env_file")
    assert.equal(plan.steps[0].command, "SIRAGPT_TEST_PASSWORD=<password> cd backend && npm run dev")
    assert.equal(JSON.stringify(plan).includes("super-secret"), false)
  })

  it("builds a stable diagnostic fingerprint without commands", () => {
    assert.equal(recovery.stableJsonStringify({ b: 1, a: { d: 2, c: 3 } }), "{\"a\":{\"c\":3,\"d\":2},\"b\":1}")

    const recoverySummary = recovery.buildRecoveryCiSummary({
      ok: false,
      frontendUrl: "http://127.0.0.1:3000",
      apiUrl: "http://127.0.0.1:5000",
      checks: [{ name: "backend_auth", ok: false, required: true, endpoints: [{ path: "/health/live", ok: false }] }],
    }, [
      {
        id: "backend_dev_server",
        title: "Backend",
        command: "SIRAGPT_TEST_PASSWORD=super-secret cd backend && npm run dev",
        detail: "critical",
      },
    ])
    const fingerprint = recovery.buildFingerprintSummary(recoverySummary)

    assert.match(recoverySummary.diagnosticHash, /^[a-f0-9]{64}$/)
    assert.equal(fingerprint.algorithm, "sha256")
    assert.equal(fingerprint.hashInputVersion, 1)
    assert.equal(fingerprint.diagnosticHash, recoverySummary.diagnosticHash)
    assert.equal(JSON.stringify(fingerprint).includes("cd backend"), false)
    assert.equal(JSON.stringify(fingerprint).includes("super-secret"), false)
  })

  it("compares current diagnostics with a sanitized baseline snapshot", () => {
    const baselineSummary = recovery.buildRecoveryCiSummary({
      ok: false,
      frontendUrl: "http://127.0.0.1:3000",
      apiUrl: "http://127.0.0.1:5000",
      checks: [
        { name: "backend_auth", ok: false, required: true, endpoints: [{ path: "/health/live", ok: false }] },
      ],
    })
    const currentSummary = recovery.buildRecoveryCiSummary({
      ok: false,
      frontendUrl: "http://127.0.0.1:3000",
      apiUrl: "http://127.0.0.1:5000",
      checks: [
        { name: "frontend_routes", ok: false, required: true },
        { name: "backend_auth", ok: false, required: true, endpoints: [{ path: "/health/live", ok: false }] },
      ],
    })
    const comparison = recovery.buildBaselineComparison(currentSummary, recovery.buildBaselineSnapshot(baselineSummary))

    assert.equal(comparison.baselinePresent, true)
    assert.equal(comparison.comparisonStatus, "changed")
    assert.equal(comparison.changed, true)
    assert.equal(comparison.changeClassification, "regression")
    assert.equal(comparison.regressionCount, 2)
    assert.equal(comparison.actionDelta.added.some((action: { id: string }) => action.id === "frontend_dev_server"), true)
    assert.equal(comparison.actionRegressions.some((action: { id: string }) => action.id === "frontend_dev_server"), true)
    assert.deepEqual(comparison.checkStatusChanges.find((change: { name: string }) => change.name === "frontend_routes"), {
      name: "frontend_routes",
      required: true,
      baselineStatus: "missing",
      currentStatus: "blocked",
    })
    assert.equal(JSON.stringify(comparison).includes("npm run dev"), false)
  })

  it("summarizes baseline trend as improvement when checks recover", () => {
    const baselineSummary = recovery.buildRecoveryCiSummary({
      ok: false,
      frontendUrl: "http://127.0.0.1:3000",
      apiUrl: "http://127.0.0.1:5000",
      checks: [
        { name: "backend_auth", ok: false, required: true, endpoints: [{ path: "/health/live", ok: false }] },
      ],
    })
    const currentSummary = recovery.buildRecoveryCiSummary({
      ok: true,
      frontendUrl: "http://127.0.0.1:3000",
      apiUrl: "http://127.0.0.1:5000",
      checks: [
        { name: "backend_auth", ok: true, required: true },
      ],
    })
    const trend = recovery.buildBaselineTrendSummary(currentSummary, recovery.buildBaselineSnapshot(baselineSummary))

    assert.equal(recovery.statusRank("ok") > recovery.statusRank("blocked"), true)
    assert.equal(trend.changeClassification, "improvement")
    assert.equal(trend.improvementCount, 2)
    assert.equal(trend.regressionCount, 0)
    assert.equal(trend.checkImprovements.some((change: { name: string }) => change.name === "backend_auth"), true)
    assert.equal(trend.actionImprovements.some((action: { id: string }) => action.id === "backend_dev_server"), true)
  })

  it("reads and writes sanitized baseline files", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "siragpt-baseline-"))
    const baselinePath = path.join(directory, "baseline.json")
    const summary = recovery.buildRecoveryCiSummary({
      ok: false,
      frontendUrl: "http://127.0.0.1:3000",
      apiUrl: "http://127.0.0.1:5000",
      checks: [{ name: "backend_auth", ok: false, required: true }],
    }, [
      {
        id: "secret_action",
        title: "Secret",
        command: "SIRAGPT_TEST_PASSWORD=super-secret npm run dev",
        detail: "safe",
      },
    ])

    const writtenPath = recovery.writeBaselineFile(baselinePath, summary)
    const read = recovery.readBaselineFile(baselinePath)
    const missing = recovery.readBaselineFile(path.join(directory, "missing.json"))

    assert.equal(writtenPath, baselinePath)
    assert.equal(read.found, true)
    assert.equal(read.snapshot.baselineVersion, 1)
    assert.equal(read.snapshot.actions[0].id, "secret_action")
    assert.equal(JSON.stringify(read.snapshot).includes("super-secret"), false)
    assert.equal(JSON.stringify(read.snapshot).includes("npm run dev"), false)
    assert.equal(missing.found, false)
    assert.equal(missing.snapshot, null)
  })

  it("appends sanitized diagnostic history and summarizes previous runs", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "siragpt-history-"))
    const historyPath = path.join(directory, "history.jsonl")
    const previousSummary = recovery.buildRecoveryCiSummary({
      ok: false,
      frontendUrl: "http://127.0.0.1:3000",
      apiUrl: "http://127.0.0.1:5000",
      checks: [{ name: "backend_auth", ok: false, required: true }],
    }, [
      {
        id: "secret_action",
        title: "Secret",
        command: "SIRAGPT_TEST_PASSWORD=super-secret npm run dev",
        detail: "safe",
      },
    ])
    const currentSummary = recovery.buildRecoveryCiSummary({
      ok: true,
      frontendUrl: "http://127.0.0.1:3000",
      apiUrl: "http://127.0.0.1:5000",
      checks: [{ name: "backend_auth", ok: true, required: true }],
    })

    recovery.appendHistoryEntry(historyPath, previousSummary)
    recovery.appendHistoryEntry(historyPath, currentSummary)
    const history = recovery.readHistoryFile(historyPath)
    const summary = recovery.buildHistorySummary(currentSummary, history.entries)
    const missing = recovery.readHistoryFile(path.join(directory, "missing.jsonl"))

    assert.equal(history.found, true)
    assert.equal(history.entries.length, 2)
    assert.equal(summary.entryCount, 2)
    assert.equal(summary.seenCurrentHash, true)
    assert.equal(summary.previousHash, previousSummary.diagnosticHash)
    assert.equal(summary.previousHealthCode, previousSummary.healthCode)
    assert.equal(JSON.stringify(history.entries).includes("super-secret"), false)
    assert.equal(JSON.stringify(history.entries).includes("npm run dev"), false)
    assert.equal(missing.found, false)
    assert.deepEqual(missing.entries, [])
  })

  it("formats markdown with primary failure and primary action", () => {
    const report = recovery.formatMarkdownReport({
      ok: false,
      frontendUrl: "http://127.0.0.1:3000",
      apiUrl: "http://127.0.0.1:5000",
      checks: [
        { name: "frontend_routes", ok: true, required: true },
        {
          name: "backend_auth",
          ok: false,
          required: true,
          endpoints: [{ path: "/health/live", ok: false, durationMs: 34 }],
        },
      ],
    })

    assert.match(report, /Primary failure: backend_auth/)
    assert.match(report, /Primary action: backend_dev_server/)
    assert.match(report, /Overall status: blocked/)
    assert.match(report, /Health code: backend_down/)
    assert.match(report, /Diagnostic hash: [a-f0-9]{64}/)
    assert.match(report, /Exit code: 32/)
    assert.match(report, /Highest priority: 100 \(backend_dev_server\)/)
    assert.match(report, /Slowest probe: backend_auth \/health\/live 34ms/)
    assert.match(report, /\| backend_auth \/health\/live \| 34ms \| blocked \|/)
    assert.match(report, /Check\/action matrix/)
    assert.match(report, /\| backend_auth \| blocked \| backend_dev_server \(LOCAL_BACKEND_START\) \|/)
    assert.match(report, /Action impact/)
    assert.match(report, /\| Category \| backend \| 1 \| backend_dev_server \|/)
    assert.match(report, /\| Severity \| critical \| 1 \| backend_dev_server \|/)
    assert.match(report, /Next action/)
    assert.match(report, /\| backend_dev_server \| LOCAL_BACKEND_START \| 100 \| backend_auth \| `cd backend && npm run dev` \|/)
    assert.match(report, /Execution plan/)
    assert.match(report, /\| 1 \| backend_dev_server \| 100 \| `cd backend && npm run dev` \|/)
    assert.match(report, /\| backend_dev_server \| LOCAL_BACKEND_START \| critical \| backend \| 100 \| Levantar backend local \| `cd backend && npm run dev` \|/)
  })

  it("redacts URL credentials in human readiness check lines", () => {
    const line = readiness.formatCheck({
      name: "frontend_routes",
      ok: false,
      baseUrl: "http://user:secret@127.0.0.1:3000",
    })

    assert.match(line, /http:\/\/127\.0\.0\.1:3000/)
    assert.equal(line.includes("secret"), false)
  })

  it("extracts ports and builds listener diagnostics without network probes", () => {
    const diagnostics = readiness.buildPortDiagnostics("http://127.0.0.1:3000", "https://api.local", {
      inspectPort: (port: number) => ({
        port,
        listening: port === 3000,
        processCount: port === 3000 ? 1 : 0,
        commands: port === 3000 ? ["node"] : [],
      }),
    })

    assert.equal(readiness.portFromUrl("http://127.0.0.1:3000"), 3000)
    assert.equal(readiness.portFromUrl("https://api.local"), 443)
    assert.equal(diagnostics.frontend.listening, true)
    assert.equal(diagnostics.api.port, 443)
  })

  it("includes optional port diagnostics in JSON and markdown reports", () => {
    const summary = {
      ok: false,
      frontendUrl: "http://127.0.0.1:3000",
      apiUrl: "http://127.0.0.1:5000",
      portDiagnostics: {
        frontend: { port: 3000, listening: true, processCount: 1, commands: ["node"] },
        api: { port: 5000, listening: false, processCount: 0, commands: [] },
      },
      checks: [{ name: "backend_auth", ok: false, required: true }],
    }
    const compact = readiness.buildReadinessCiSummary(summary)
    const report = recovery.formatMarkdownReport(summary)

    assert.equal(compact.portDiagnostics.frontend.port, 3000)
    assert.match(report, /Port diagnostics/)
    assert.match(report, /\| frontend \| 3000 \| yes \| node \|/)
    assert.match(report, /\| api \| 5000 \| no \| none \|/)
  })

  it("sanitizes process commands before diagnostics output", () => {
    const sanitized = readiness.sanitizeProcessCommand("NPM_TOKEN=npm_secret SIRAGPT_TEST_PASSWORD=super-secret node server.js")

    assert.match(sanitized, /NPM_TOKEN=<token>/)
    assert.match(sanitized, /SIRAGPT_TEST_PASSWORD=<password>/)
    assert.equal(sanitized.includes("npm_secret"), false)
    assert.equal(sanitized.includes("super-secret"), false)
  })

  it("parses timeout and strict env flags", () => {
    const readinessArgs = readiness.parseArgs(["--strict-env", "--timeout-ms", "750", "--require-login", "--compact-json", "--inspect-ports"])
    const recoveryArgs = recovery.parseArgs([
      "--strict-env",
      "--timeout-ms",
      "750",
      "--quiet",
      "--require-login",
      "--compact-json",
      "--inspect-ports",
      "--status-json",
      "--actions-json",
      "--matrix-json",
      "--impact-json",
      "--priority-json",
      "--next-action-json",
      "--plan-json",
      "--fingerprint-json",
      "--baseline-json",
      "tmp/custom-baseline.json",
      "--baseline-trend-json",
      "--history-json",
      "tmp/history.jsonl",
      "--write-baseline",
      "tmp/write-baseline.json",
      "--write-history",
      "tmp/write-history.jsonl",
      "--remediation-catalog-json",
    ])

    assert.equal(readinessArgs.strictEnv, true)
    assert.equal(readinessArgs.timeoutMs, 750)
    assert.equal(recoveryArgs.strictEnv, true)
    assert.equal(recoveryArgs.timeoutMs, 750)
    assert.equal(recoveryArgs.quiet, true)
    assert.equal(readinessArgs.requireLogin, true)
    assert.equal(recoveryArgs.requireLogin, true)
    assert.equal(readinessArgs.compactJson, true)
    assert.equal(recoveryArgs.compactJson, true)
    assert.equal(readinessArgs.inspectPorts, true)
    assert.equal(recoveryArgs.inspectPorts, true)
    assert.equal(recoveryArgs.summaryJson, true)
    assert.equal(recoveryArgs.statusJson, true)
    assert.equal(recoveryArgs.actionsJson, true)
    assert.equal(recoveryArgs.matrixJson, true)
    assert.equal(recoveryArgs.impactJson, true)
    assert.equal(recoveryArgs.priorityJson, true)
    assert.equal(recoveryArgs.nextActionJson, true)
    assert.equal(recoveryArgs.planJson, true)
    assert.equal(recoveryArgs.fingerprintJson, true)
    assert.equal(recoveryArgs.baselineJson, true)
    assert.equal(recoveryArgs.baselineTrendJson, true)
    assert.equal(recoveryArgs.baselinePath, "tmp/custom-baseline.json")
    assert.equal(recoveryArgs.historyJson, true)
    assert.equal(recoveryArgs.historyPath, "tmp/history.jsonl")
    assert.equal(recoveryArgs.writeBaseline, "tmp/write-baseline.json")
    assert.equal(recoveryArgs.writeHistory, "tmp/write-history.jsonl")
    assert.equal(recoveryArgs.remediationCatalogJson, true)
  })

  it("formats compact JSON for CI log consumers", () => {
    const compact = readiness.formatJson({ healthCode: "backend_down", failedRequiredCount: 1 }, true)
    const pretty = readiness.formatJson({ healthCode: "backend_down", failedRequiredCount: 1 }, false)

    assert.equal(compact, "{\"healthCode\":\"backend_down\",\"failedRequiredCount\":1}")
    assert.equal(compact.includes("\n"), false)
    assert.equal(pretty.includes("\n"), true)
  })

  it("applies named local probe profiles with explicit timeout precedence", () => {
    const fastReadinessArgs = readiness.parseArgs(["--profile", "fast"])
    const ciRecoveryArgs = recovery.parseArgs(["--profile", "ci"])
    const overrideArgs = recovery.parseArgs(["--profile", "fast", "--timeout-ms", "1250"])

    assert.equal(fastReadinessArgs.timeoutMs, 750)
    assert.equal(ciRecoveryArgs.timeoutMs, 1000)
    assert.equal(ciRecoveryArgs.strictEnv, true)
    assert.equal(overrideArgs.timeoutMs, 1250)
  })

  it("rejects invalid numeric options and unknown profiles", () => {
    assert.throws(() => readiness.parseArgs(["--timeout-ms", "abc"]), /--timeout-ms must be a positive integer/)
    assert.throws(() => recovery.parseArgs(["--max-report-age-hours", "0"]), /--max-report-age-hours must be a positive integer/)
    assert.throws(() => recovery.parseArgs(["--profile", "slow"]), /Unknown profile: slow/)
  })

  it("exposes an exit-code JSON map without secrets", () => {
    assert.equal(recovery.RECOVERY_EXIT_CODE_LABELS[0], "ready")
    assert.equal(recovery.RECOVERY_EXIT_CODE_LABELS[32], "backend_down")
    assert.equal(JSON.stringify(recovery.RECOVERY_EXIT_CODE_LABELS).includes("password"), false)
  })

  it("exposes a stable local check catalog without probes", () => {
    assert.equal(Array.isArray(readiness.LOCAL_CHAT_CHECKS), true)
    assert.deepEqual(readiness.LOCAL_CHAT_CHECKS.map((check: { name: string }) => check.name), [
      "local_env",
      "frontend_routes",
      "backend_auth",
    ])
    assert.equal(JSON.stringify(readiness.LOCAL_CHAT_CHECKS).includes("password"), false)
  })

  it("documents quiet mode, exit-code JSON and examples in help output", () => {
    const help = recovery.usage()

    assert.match(help, /--quiet/)
    assert.match(help, /--exit-codes-json/)
    assert.match(help, /--list-checks-json/)
    assert.match(help, /--status-json/)
    assert.match(help, /--actions-json/)
    assert.match(help, /--matrix-json/)
    assert.match(help, /--impact-json/)
    assert.match(help, /--priority-json/)
    assert.match(help, /--next-action-json/)
    assert.match(help, /--plan-json/)
    assert.match(help, /--fingerprint-json/)
    assert.match(help, /--baseline-json/)
    assert.match(help, /--baseline-trend-json/)
    assert.match(help, /--history-json/)
    assert.match(help, /--write-baseline/)
    assert.match(help, /--write-history/)
    assert.match(help, /--remediation-catalog-json/)
    assert.match(help, /--profile <name>/)
    assert.match(help, /--compact-json/)
    assert.match(help, /--inspect-ports/)
    assert.match(help, /--require-login/)
    assert.match(help, /Examples:/)
    assert.match(help, /npm --silent run doctor:local-chat:ci/)
    assert.match(help, /npm --silent run doctor:local-chat:status/)
    assert.match(help, /npm --silent run doctor:local-chat:actions/)
    assert.match(help, /npm --silent run doctor:local-chat:matrix/)
    assert.match(help, /npm --silent run doctor:local-chat:impact/)
    assert.match(help, /npm --silent run doctor:local-chat:priority/)
    assert.match(help, /npm --silent run doctor:local-chat:next-action/)
    assert.match(help, /npm --silent run doctor:local-chat:plan/)
    assert.match(help, /npm --silent run doctor:local-chat:fingerprint/)
    assert.match(help, /npm --silent run doctor:local-chat:baseline/)
    assert.match(help, /npm --silent run doctor:local-chat:baseline-trend/)
    assert.match(help, /npm --silent run doctor:local-chat:history/)
    assert.match(help, /npm --silent run doctor:local-chat:remediations/)
    assert.match(help, /npm --silent run doctor:local-chat:compact/)
    assert.match(help, /--inspect-ports --markdown/)
    assert.match(help, /SIRAGPT_TEST_EMAIL=admin@example\.com/)
    assert.match(help, /--quiet --profile fast/)
    assert.match(help, /--summary-json --timeout-ms 1000/)
  })

  it("registers dedicated local diagnostic package scripts", () => {
    const packageJson = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8"))

    assert.equal(packageJson.scripts["smoke:local-chat:json"], "node scripts/local-chat-readiness.js --summary-json")
    assert.equal(packageJson.scripts["smoke:local-chat:compact"], "node scripts/local-chat-readiness.js --compact-json")
    assert.equal(packageJson.scripts["smoke:local-chat:ci"], "node scripts/local-chat-readiness.js --summary-json --profile ci")
    assert.equal(packageJson.scripts["smoke:local-chat:login"], "node scripts/local-chat-readiness.js --summary-json --require-login")
    assert.equal(packageJson.scripts["doctor:local-chat:compact"], "node scripts/local-chat-recovery.js --compact-json")
    assert.equal(packageJson.scripts["doctor:local-chat:report"], "node scripts/local-chat-recovery.js --write-report --markdown")
    assert.equal(packageJson.scripts["doctor:local-chat:quiet"], "node scripts/local-chat-recovery.js --quiet --profile fast")
    assert.equal(packageJson.scripts["doctor:local-chat:ports"], "node scripts/local-chat-recovery.js --summary-json --inspect-ports")
    assert.equal(packageJson.scripts["doctor:local-chat:status"], "node scripts/local-chat-recovery.js --status-json --compact-json")
    assert.equal(packageJson.scripts["doctor:local-chat:actions"], "node scripts/local-chat-recovery.js --actions-json --compact-json")
    assert.equal(packageJson.scripts["doctor:local-chat:matrix"], "node scripts/local-chat-recovery.js --matrix-json --compact-json")
    assert.equal(packageJson.scripts["doctor:local-chat:impact"], "node scripts/local-chat-recovery.js --impact-json --compact-json")
    assert.equal(packageJson.scripts["doctor:local-chat:priority"], "node scripts/local-chat-recovery.js --priority-json --compact-json")
    assert.equal(packageJson.scripts["doctor:local-chat:next-action"], "node scripts/local-chat-recovery.js --next-action-json --compact-json")
    assert.equal(packageJson.scripts["doctor:local-chat:plan"], "node scripts/local-chat-recovery.js --plan-json --compact-json")
    assert.equal(packageJson.scripts["doctor:local-chat:fingerprint"], "node scripts/local-chat-recovery.js --fingerprint-json --compact-json")
    assert.equal(packageJson.scripts["doctor:local-chat:baseline"], "node scripts/local-chat-recovery.js --baseline-json --compact-json")
    assert.equal(packageJson.scripts["doctor:local-chat:baseline-trend"], "node scripts/local-chat-recovery.js --baseline-trend-json --compact-json")
    assert.equal(packageJson.scripts["doctor:local-chat:baseline:write"], "node scripts/local-chat-recovery.js --write-baseline --fingerprint-json --compact-json")
    assert.equal(packageJson.scripts["doctor:local-chat:history"], "node scripts/local-chat-recovery.js --history-json --compact-json")
    assert.equal(packageJson.scripts["doctor:local-chat:history:write"], "node scripts/local-chat-recovery.js --write-history --fingerprint-json --compact-json")
    assert.equal(packageJson.scripts["doctor:local-chat:remediations"], "node scripts/local-chat-recovery.js --remediation-catalog-json --compact-json")
    assert.equal(packageJson.scripts["doctor:local-chat:ci"], "node scripts/local-chat-recovery.js --summary-json --profile ci")
    assert.equal(packageJson.scripts["doctor:local-chat:checks"], "node scripts/local-chat-recovery.js --list-checks-json")
    assert.equal(packageJson.scripts["doctor:local-chat:login"], "node scripts/local-chat-recovery.js --summary-json --require-login")
  })
})

function fsUtimes(filePath: string, date: Date) {
  const { utimesSync } = require("node:fs")
  utimesSync(filePath, date, date)
}
