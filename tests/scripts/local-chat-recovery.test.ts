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
    assert.equal(summary.totalChecks, 3)
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
    assert.equal(recoverySummary.actions[0].detail.includes("127.0.0.1:5000"), true)
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
    assert.match(report, /Health code: backend_down/)
    assert.match(report, /Exit code: 32/)
    assert.match(report, /Slowest probe: backend_auth \/health\/live 34ms/)
    assert.match(report, /\| backend_auth \/health\/live \| 34ms \| blocked \|/)
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

  it("parses timeout and strict env flags", () => {
    const readinessArgs = readiness.parseArgs(["--strict-env", "--timeout-ms", "750", "--require-login", "--compact-json"])
    const recoveryArgs = recovery.parseArgs(["--strict-env", "--timeout-ms", "750", "--quiet", "--require-login", "--compact-json"])

    assert.equal(readinessArgs.strictEnv, true)
    assert.equal(readinessArgs.timeoutMs, 750)
    assert.equal(recoveryArgs.strictEnv, true)
    assert.equal(recoveryArgs.timeoutMs, 750)
    assert.equal(recoveryArgs.quiet, true)
    assert.equal(readinessArgs.requireLogin, true)
    assert.equal(recoveryArgs.requireLogin, true)
    assert.equal(readinessArgs.compactJson, true)
    assert.equal(recoveryArgs.compactJson, true)
    assert.equal(recoveryArgs.summaryJson, true)
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
    assert.match(help, /--profile <name>/)
    assert.match(help, /--compact-json/)
    assert.match(help, /--require-login/)
    assert.match(help, /Examples:/)
    assert.match(help, /npm --silent run doctor:local-chat:ci/)
    assert.match(help, /npm --silent run doctor:local-chat:compact/)
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
    assert.equal(packageJson.scripts["doctor:local-chat:ci"], "node scripts/local-chat-recovery.js --summary-json --profile ci")
    assert.equal(packageJson.scripts["doctor:local-chat:checks"], "node scripts/local-chat-recovery.js --list-checks-json")
    assert.equal(packageJson.scripts["doctor:local-chat:login"], "node scripts/local-chat-recovery.js --summary-json --require-login")
  })
})

function fsUtimes(filePath: string, date: Date) {
  const { utimesSync } = require("node:fs")
  utimesSync(filePath, date, date)
}
