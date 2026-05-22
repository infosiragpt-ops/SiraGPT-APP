#!/usr/bin/env node

const fs = require("node:fs")
const path = require("node:path")

const DEFAULT_FRONTEND_URL = "http://127.0.0.1:3000"
const DEFAULT_API_URL = "http://127.0.0.1:5000"
const CI_SUMMARY_SCHEMA_VERSION = 1
const LOCAL_CHAT_PROFILES = {
  default: {},
  fast: { timeoutMs: 750 },
  ci: { timeoutMs: 1000, strictEnv: true },
}
const LOCAL_CHAT_CHECKS = [
  {
    name: "local_env",
    requiredByDefault: false,
    description: "Detecta configuracion local de API sin imprimir valores.",
  },
  {
    name: "frontend_routes",
    requiredByDefault: true,
    description: "Verifica /auth/login y /chat en el frontend local.",
  },
  {
    name: "backend_auth",
    requiredByDefault: true,
    description: "Verifica /health/live y /health/ready en el backend local.",
  },
]

function normalizeUrl(rawUrl, fallback) {
  const trimmed = String(rawUrl || "").trim()
  const target = trimmed || fallback
  const withProtocol = /^https?:\/\//i.test(target) ? target : `http://${target}`
  const parsed = new URL(withProtocol)
  parsed.hash = ""
  parsed.search = ""
  return parsed.toString().replace(/\/+$/, "")
}

function sanitizeUrlForOutput(rawUrl) {
  if (!rawUrl) return ""
  try {
    const parsed = new URL(String(rawUrl))
    parsed.username = ""
    parsed.password = ""
    return parsed.toString().replace(/\/+$/, "")
  } catch {
    return String(rawUrl).replace(/\/\/[^:\s/@]+:[^@\s/]+@/g, "//<user>:<password>@")
  }
}

function parsePositiveInteger(rawValue, optionName) {
  const value = Number(rawValue)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${optionName} must be a positive integer`)
  }
  return value
}

function applyReadinessProfile(args) {
  const profileName = args.profile || "default"
  const profile = LOCAL_CHAT_PROFILES[profileName]
  if (!profile) throw new Error(`Unknown profile: ${profileName}`)
  return {
    ...args,
    timeoutMs: Number.isFinite(args.timeoutMs) ? args.timeoutMs : profile.timeoutMs,
    strictEnv: args.strictEnv || profile.strictEnv === true,
  }
}

function formatJson(value, compact = false) {
  return JSON.stringify(value, null, compact ? 0 : 2)
}

function printJson(value, compact = false) {
  console.log(formatJson(value, compact))
}

async function probe(url, options = {}) {
  const startedAtMs = Date.now()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 3000)
  try {
    const response = await fetch(url, {
      method: options.method || "GET",
      headers: options.headers,
      body: options.body,
      redirect: "manual",
      signal: controller.signal,
    })
    const body = options.readBody === false ? "" : await response.text().catch(() => "")
    return {
      status: response.status,
      ok: response.status >= 200 && response.status < 400,
      bodyBytes: body.length,
      durationMs: Math.max(0, Date.now() - startedAtMs),
      failures: [],
    }
  } catch (error) {
    return {
      status: null,
      ok: false,
      bodyBytes: 0,
      durationMs: Math.max(0, Date.now() - startedAtMs),
      failures: [error?.name === "AbortError" ? "timeout" : "request_error"],
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function checkFrontend(baseUrl, options = {}) {
  const routes = []
  for (const routePath of ["/auth/login", "/chat"]) {
    const result = await probe(`${baseUrl}${routePath}`, { timeoutMs: options.timeoutMs })
    routes.push({
      path: routePath,
      status: result.status,
      ok: result.ok && result.bodyBytes > 0,
      durationMs: result.durationMs,
      failures: result.ok && result.bodyBytes > 0 ? [] : [...result.failures, ...(result.bodyBytes === 0 ? ["empty_body"] : [])],
    })
  }
  return {
    name: "frontend_routes",
    ok: routes.every((route) => route.ok),
    required: true,
    baseUrl,
    durationMs: routes.reduce((total, route) => total + (route.durationMs || 0), 0),
    routes,
  }
}

async function checkBackend(baseUrl, options = {}) {
  const endpoints = []
  for (const endpointPath of ["/health/live", "/health/ready"]) {
    const result = await probe(`${baseUrl}${endpointPath}`, { readBody: false, timeoutMs: options.timeoutMs })
    endpoints.push({
      path: endpointPath,
      status: result.status,
      ok: result.status === 200,
      durationMs: result.durationMs,
      failures: result.status === 200 ? [] : [...result.failures, "status_unreachable"],
    })
  }
  const loginEmail = options.env?.SIRAGPT_TEST_EMAIL || ""
  const loginPassword = options.env?.SIRAGPT_TEST_PASSWORD || ""
  if (options.requireLogin === true) {
    if (!loginEmail || !loginPassword) {
      endpoints.push({
        path: "/api/auth/login",
        status: null,
        ok: false,
        required: true,
        durationMs: 0,
        failures: ["missing_credentials"],
      })
    } else {
      const result = await probe(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: loginEmail, password: loginPassword }),
        readBody: false,
        timeoutMs: options.timeoutMs,
      })
      endpoints.push({
        path: "/api/auth/login",
        status: result.status,
        ok: result.ok,
        required: true,
        durationMs: result.durationMs,
        failures: result.ok ? [] : [...result.failures, "login_failed"],
      })
    }
  } else {
    endpoints.push({
      path: "/api/auth/login",
      status: null,
      ok: true,
      required: false,
      skipped: true,
      durationMs: 0,
      failures: [],
    })
  }
  return {
    name: "backend_auth",
    ok: endpoints.filter((endpoint) => endpoint.required !== false && endpoint.skipped !== true).every((endpoint) => endpoint.ok),
    required: true,
    baseUrl,
    durationMs: endpoints.reduce((total, endpoint) => total + (endpoint.durationMs || 0), 0),
    endpoints,
  }
}

function parseEnvFile(raw) {
  const entries = {}
  for (const line of String(raw || "").split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const separator = trimmed.indexOf("=")
    if (separator <= 0) continue
    const key = trimmed.slice(0, separator).trim()
    const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "")
    entries[key] = value
  }
  return entries
}

function readLocalEnv(cwd = process.cwd()) {
  const envPath = path.join(cwd, ".env.local")
  if (!fs.existsSync(envPath)) return {}
  return parseEnvFile(fs.readFileSync(envPath, "utf8"))
}

function envPresence(env, fileEnv, key) {
  if (Object.prototype.hasOwnProperty.call(env, key) && String(env[key] || "").length > 0) {
    return { key, present: true, source: "process" }
  }
  if (Object.prototype.hasOwnProperty.call(fileEnv, key) && String(fileEnv[key] || "").length > 0) {
    return { key, present: true, source: ".env.local" }
  }
  return { key, present: false, source: "" }
}

function checkLocalEnv(env = process.env, options = {}) {
  const fileEnv = options.fileEnv || readLocalEnv(options.cwd || process.cwd())
  const variables = [
    envPresence(env, fileEnv, "NEXT_PUBLIC_API_URL"),
    envPresence(env, fileEnv, "SIRAGPT_LOCAL_API_URL"),
  ]
  return {
    name: "local_env",
    ok: variables.some((variable) => variable.present),
    required: options.required === true,
    durationMs: 0,
    variables,
  }
}

function firstFailureForCheck(check) {
  if (!check || check.ok) return ""
  if (check.name === "local_env") return "missing_local_api_env"
  if (check.name === "frontend_routes") {
    const route = (check.routes || []).find((item) => !item.ok)
    if (!route) return "frontend_unavailable"
    return `${route.path}:${(route.failures || []).join("|") || route.status || "failed"}`
  }
  if (check.name === "backend_auth") {
    const endpoint = (check.endpoints || []).find((item) => !item.ok)
    if (!endpoint) return "backend_unavailable"
    return `${endpoint.path}:${(endpoint.failures || []).join("|") || endpoint.status || "failed"}`
  }
  return "failed"
}

function compactCheck(check) {
  const compact = {
    name: check.name,
    ok: Boolean(check.ok),
    required: Boolean(check.required),
  }
  if (Number.isFinite(check.durationMs)) compact.durationMs = check.durationMs
  return compact
}

function resolveHealthCode(summary) {
  if (summary?.ok) return "ready"
  const failedChecks = (summary?.checks || []).filter((check) => check.required && !check.ok).map((check) => check.name)
  if (failedChecks.includes("local_env")) return "env_missing"
  if (failedChecks.includes("frontend_routes")) return "frontend_down"
  if (failedChecks.includes("backend_auth")) return "backend_down"
  return "blocked"
}

function statusForProbe(item) {
  return Number.isFinite(item?.status) ? item.status : null
}

function latencyProbe(checkName, item) {
  if (!Number.isFinite(item?.durationMs)) return null
  return {
    check: checkName,
    probe: String(item.path || item.name || checkName),
    durationMs: item.durationMs,
    ok: Boolean(item.ok),
    status: statusForProbe(item),
  }
}

function collectLatencyProbes(summary) {
  const probes = []
  for (const check of summary?.checks || []) {
    const items = check.name === "frontend_routes"
      ? check.routes || []
      : check.name === "backend_auth"
        ? (check.endpoints || []).filter((endpoint) => endpoint.skipped !== true)
        : []
    for (const item of items) {
      const probeItem = latencyProbe(check.name, item)
      if (probeItem) probes.push(probeItem)
    }
    if (items.length === 0 && check.name !== "local_env") {
      const probeItem = latencyProbe(check.name, check)
      if (probeItem) probes.push(probeItem)
    }
  }
  return probes
}

function buildLatencySummary(summary) {
  const probes = collectLatencyProbes(summary)
  let slowestProbe = null
  for (const probeItem of probes) {
    if (!slowestProbe || probeItem.durationMs > slowestProbe.durationMs) slowestProbe = probeItem
  }
  return {
    totalDurationMs: Number.isFinite(summary?.durationMs) ? summary.durationMs : undefined,
    probeCount: probes.length,
    slowestProbe,
    probes,
  }
}

function buildReadinessCiSummary(summary) {
  const checks = summary.checks.map(compactCheck)
  const failedRequiredChecks = checks.filter((check) => check.required && !check.ok).map((check) => check.name)
  const warnings = checks.filter((check) => !check.required && !check.ok).map((check) => check.name)
  const failureSummary = {}
  for (const check of summary.checks) {
    const failure = firstFailureForCheck(check)
    if (failure) failureSummary[check.name] = failure
  }
  return {
    schemaVersion: CI_SUMMARY_SCHEMA_VERSION,
    ok: Boolean(summary.ok),
    status: summary.ok ? "ok" : "blocked",
    healthCode: resolveHealthCode(summary),
    durationMs: Number.isFinite(summary.durationMs) ? summary.durationMs : undefined,
    frontendUrl: sanitizeUrlForOutput(summary.frontendUrl),
    apiUrl: sanitizeUrlForOutput(summary.apiUrl),
    primaryFailure: failedRequiredChecks[0] || "",
    totalChecks: checks.length,
    failedRequiredCount: failedRequiredChecks.length,
    warningCount: warnings.length,
    failedRequiredChecks,
    warnings,
    failureSummary,
    latencySummary: buildLatencySummary(summary),
    checks,
  }
}

async function runReadiness(options = {}) {
  const startedAtMs = Date.now()
  const env = options.env || process.env
  const frontendUrl = normalizeUrl(options.frontendUrl || env.SIRAGPT_LOCAL_FRONTEND_URL, DEFAULT_FRONTEND_URL)
  const apiUrl = normalizeUrl(options.apiUrl || env.SIRAGPT_LOCAL_API_URL, DEFAULT_API_URL)
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : undefined
  const checks = [
    checkLocalEnv(env, { cwd: options.cwd, required: options.strictEnv === true }),
    await checkFrontend(frontendUrl, { timeoutMs }),
    await checkBackend(apiUrl, { timeoutMs, requireLogin: options.requireLogin === true, env }),
  ]
  return {
    ok: checks.filter((check) => check.required).every((check) => check.ok),
    durationMs: Math.max(0, Date.now() - startedAtMs),
    frontendUrl,
    apiUrl,
    checks,
  }
}

function formatCheck(check) {
  if (check.name === "frontend_routes") return `${check.ok ? "✓" : "✗"} frontend ${sanitizeUrlForOutput(check.baseUrl)}`
  if (check.name === "backend_auth") return `${check.ok ? "✓" : "✗"} backend ${sanitizeUrlForOutput(check.baseUrl)}`
  return `${check.ok ? "✓" : "~"} ${check.name}`
}

function parseArgs(argv) {
  const args = { json: false, compactJson: false, frontendUrl: "", apiUrl: "", profile: "default", requireLogin: false, strictEnv: false, timeoutMs: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--json" || arg === "--summary-json") args.json = true
    else if (arg === "--compact-json") {
      args.json = true
      args.compactJson = true
    }
    else if (arg === "--frontend-url") args.frontendUrl = argv[++index] || ""
    else if (arg === "--api-url") args.apiUrl = argv[++index] || ""
    else if (arg === "--profile") args.profile = argv[++index] || ""
    else if (arg === "--require-login") args.requireLogin = true
    else if (arg === "--strict-env") args.strictEnv = true
    else if (arg === "--timeout-ms") args.timeoutMs = parsePositiveInteger(argv[++index], "--timeout-ms")
    else if (arg === "--help") args.help = true
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return applyReadinessProfile(args)
}

async function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.help) {
    console.log([
      "Usage:",
      "  npm run smoke:local-chat",
      "  npm run smoke:local-chat -- --summary-json",
      "  npm run smoke:local-chat -- --compact-json",
      "  npm run smoke:local-chat -- --profile fast",
      "  npm run smoke:local-chat -- --require-login",
      "  npm run smoke:local-chat -- --strict-env --timeout-ms 1000",
      "",
      "Options:",
      `  --profile <name>  Probe profile: ${Object.keys(LOCAL_CHAT_PROFILES).join(", ")}`,
      "  --compact-json    Print compact single-line JSON",
      "  --require-login   Probe /api/auth/login with SIRAGPT_TEST_EMAIL and SIRAGPT_TEST_PASSWORD",
      "  --timeout-ms <n>  Timeout for each local probe",
      "  --strict-env      Treat missing local API env as blocking",
    ].join("\n"))
    return 0
  }
  const summary = await runReadiness(args)
  if (args.json) printJson(buildReadinessCiSummary(summary), args.compactJson)
  else {
    console.log("SiraGPT local chat readiness")
    for (const check of summary.checks) console.log(formatCheck(check))
  }
  return summary.ok ? 0 : 1
}

if (require.main === module) {
  runCli().then((code) => process.exit(code)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(2)
  })
}

module.exports = {
  DEFAULT_API_URL,
  DEFAULT_FRONTEND_URL,
  CI_SUMMARY_SCHEMA_VERSION,
  LOCAL_CHAT_CHECKS,
  LOCAL_CHAT_PROFILES,
  applyReadinessProfile,
  buildLatencySummary,
  buildReadinessCiSummary,
  checkBackend,
  checkFrontend,
  checkLocalEnv,
  collectLatencyProbes,
  envPresence,
  firstFailureForCheck,
  compactCheck,
  formatCheck,
  normalizeUrl,
  parseArgs,
  parsePositiveInteger,
  parseEnvFile,
  formatJson,
  probe,
  printJson,
  readLocalEnv,
  resolveHealthCode,
  runReadiness,
  sanitizeUrlForOutput,
}
