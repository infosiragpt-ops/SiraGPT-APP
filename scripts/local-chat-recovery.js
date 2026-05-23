#!/usr/bin/env node

const fs = require("node:fs")
const path = require("node:path")
const crypto = require("node:crypto")
const {
  CI_SUMMARY_SCHEMA_VERSION,
  LOCAL_CHAT_CHECKS,
  LOCAL_CHAT_PROFILES,
  applyReadinessProfile,
  buildReadinessCiSummary,
  parsePositiveInteger,
  printJson,
  runReadiness,
} = require("./local-chat-readiness.js")

const DEFAULT_REPORT_PATH = "tmp/siragpt-local-chat-diagnostics.md"
const DEFAULT_REPORT_MAX_AGE_HOURS = 168
const REPORT_FILE_PREFIX = "siragpt-local-chat-diagnostics"
const RECOVERY_EXIT_CODES = {
  ok: 0,
  blocked: 1,
  frontend: 31,
  backend: 32,
  credentials: 33,
  packageScripts: 34,
  localEnv: 35,
}
const RECOVERY_EXIT_CODE_LABELS = {
  [RECOVERY_EXIT_CODES.ok]: "ready",
  [RECOVERY_EXIT_CODES.blocked]: "blocked_unknown",
  [RECOVERY_EXIT_CODES.frontend]: "frontend_down",
  [RECOVERY_EXIT_CODES.backend]: "backend_down",
  [RECOVERY_EXIT_CODES.credentials]: "credentials_missing",
  [RECOVERY_EXIT_CODES.packageScripts]: "package_scripts_missing",
  [RECOVERY_EXIT_CODES.localEnv]: "local_env_missing",
}
const RECOVERY_SEVERITY_PRIORITY = {
  critical: 100,
  high: 80,
  medium: 50,
  low: 25,
  info: 0,
}
const RECOVERY_ACTION_CATALOG = {
  frontend_dev_server: {
    remediationCode: "LOCAL_FRONTEND_START",
    severity: "critical",
    category: "frontend",
    sourceCheck: "frontend_routes",
  },
  backend_dev_server: {
    remediationCode: "LOCAL_BACKEND_START",
    severity: "critical",
    category: "backend",
    sourceCheck: "backend_auth",
  },
  login_credentials: {
    remediationCode: "LOCAL_LOGIN_CREDENTIALS",
    severity: "high",
    category: "auth",
    sourceCheck: "backend_auth",
  },
  local_env_file: {
    remediationCode: "LOCAL_ENV_CONFIG",
    severity: "medium",
    category: "configuration",
    sourceCheck: "local_env",
  },
  ready: {
    remediationCode: "LOCAL_READY",
    severity: "info",
    category: "none",
    sourceCheck: "none",
  },
}

function hasFailedCheck(summary, name) {
  return (summary?.checks || []).some((check) => check.name === name && !check.ok)
}

function hasFailedRequiredCheck(summary, name) {
  return (summary?.checks || []).some((check) => check.name === name && check.required && !check.ok)
}

function checkByName(summary, name) {
  return (summary?.checks || []).find((check) => check.name === name) || null
}

function failedBackendHealth(summary) {
  const backend = checkByName(summary, "backend_auth")
  if (!backend || backend.ok) return false
  return (backend.endpoints || []).some((endpoint) => endpoint.path?.startsWith("/health/") && !endpoint.ok)
}

function missingLoginCredentials(summary) {
  const backend = checkByName(summary, "backend_auth")
  if (!backend || backend.ok) return false
  return (backend.endpoints || []).some((endpoint) => endpoint.path === "/api/auth/login" && endpoint.failures?.includes("missing_credentials"))
}

function recommendRecoveryActions(summary) {
  const actions = []
  if (hasFailedCheck(summary, "frontend_routes")) {
    actions.push({
      id: "frontend_dev_server",
      title: "Levantar frontend local",
      command: "npm run dev -- -H 127.0.0.1 -p 3000",
      detail: "Debe responder /auth/login y /chat en 127.0.0.1:3000.",
    })
  }
  if (failedBackendHealth(summary)) {
    actions.push({
      id: "backend_dev_server",
      title: "Levantar backend local",
      command: "cd backend && npm run dev",
      detail: "Debe responder /health/live y /health/ready en 127.0.0.1:5000.",
    })
  }
  if (missingLoginCredentials(summary)) {
    actions.push({
      id: "login_credentials",
      title: "Probar login con credenciales explicitas",
      command: "SIRAGPT_TEST_EMAIL=admin@example.com SIRAGPT_TEST_PASSWORD=<password> npm run smoke:local-chat -- --require-login",
      detail: "El doctor no imprime passwords ni tokens; usa variables de entorno temporales.",
    })
  }
  if (hasFailedCheck(summary, "local_env")) {
    actions.push({
      id: "local_env_file",
      title: "Configurar API local del frontend",
      command: "printf 'NEXT_PUBLIC_API_URL=http://127.0.0.1:5000/api\\n' > .env.local",
      detail: "El doctor solo reporta presencia de variables; no imprime valores reales de entorno.",
    })
  }
  if (actions.length === 0) {
    actions.push({
      id: "ready",
      title: "Entorno listo",
      command: "npm run smoke:local-chat",
      detail: "No hay acciones de recuperacion pendientes.",
    })
  }
  return actions
}

function resolveRecoveryExitCode(summary) {
  if (summary?.ok) return RECOVERY_EXIT_CODES.ok
  if (hasFailedRequiredCheck(summary, "package_scripts")) return RECOVERY_EXIT_CODES.packageScripts
  if (hasFailedRequiredCheck(summary, "local_env")) return RECOVERY_EXIT_CODES.localEnv
  if (hasFailedRequiredCheck(summary, "frontend_routes")) return RECOVERY_EXIT_CODES.frontend
  if (failedBackendHealth(summary)) return RECOVERY_EXIT_CODES.backend
  if (missingLoginCredentials(summary)) return RECOVERY_EXIT_CODES.credentials
  return RECOVERY_EXIT_CODES.blocked
}

function formatRecoveryReport(summary, actions = recommendRecoveryActions(summary)) {
  const lines = ["SiraGPT local chat recovery", `readiness=${summary?.ok ? "ok" : "blocked"}`]
  for (const action of actions) {
    lines.push(`- ${action.title}: ${action.command}`)
    lines.push(`  ${action.detail}`)
  }
  return lines.join("\n")
}

function sanitizeCommandForReport(command) {
  return String(command || "")
    .replace(/(https?:\/\/)([^:\s/@]+):([^@\s/]+)@/gi, "$1<user>:<password>@")
    .replace(/(SIRAGPT_TEST_PASSWORD=)(?:"[^"]*"|'[^']*'|\S+)/g, "$1<password>")
    .replace(/(NPM_TOKEN=)(?:"[^"]*"|'[^']*'|\S+)/g, "$1<token>")
    .replace(/(Authorization:\s*Bearer\s+)[^\s|]+/gi, "$1<token>")
}

function normalizeForStableJson(value) {
  if (Array.isArray(value)) return value.map(normalizeForStableJson)
  if (!value || typeof value !== "object") return value
  return Object.keys(value).sort().reduce((normalized, key) => {
    normalized[key] = normalizeForStableJson(value[key])
    return normalized
  }, {})
}

function stableJsonStringify(value) {
  return JSON.stringify(normalizeForStableJson(value))
}

function priorityScoreForSeverity(severity) {
  return RECOVERY_SEVERITY_PRIORITY[severity] ?? RECOVERY_SEVERITY_PRIORITY.medium
}

function enrichRecoveryAction(action) {
  const metadata = RECOVERY_ACTION_CATALOG[action.id] || {
    remediationCode: "LOCAL_UNKNOWN_ACTION",
    severity: "medium",
    category: "unknown",
    sourceCheck: "unknown",
  }
  return {
    ...action,
    ...metadata,
    priorityScore: priorityScoreForSeverity(metadata.severity),
  }
}

function buildRemediationCatalog() {
  return {
    schemaVersion: CI_SUMMARY_SCHEMA_VERSION,
    actions: Object.entries(RECOVERY_ACTION_CATALOG).map(([id, metadata]) => ({
      id,
      ...metadata,
      priorityScore: priorityScoreForSeverity(metadata.severity),
    })),
  }
}

function escapeMarkdownCell(value) {
  return String(value || "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ")
}

function buildRecoveryCiSummary(summary, actions = recommendRecoveryActions(summary)) {
  const compact = buildReadinessCiSummary(summary)
  const compactActions = actions.map(enrichRecoveryAction).map((action) => ({
    id: action.id,
    remediationCode: action.remediationCode,
    severity: action.severity,
    category: action.category,
    sourceCheck: action.sourceCheck,
    priorityScore: action.priorityScore,
    title: action.title,
    command: sanitizeCommandForReport(action.command),
    detail: action.detail,
  }))
  const highestPriorityScore = Math.max(0, ...compactActions.map((action) => action.priorityScore))
  const recoverySummary = {
    ...compact,
    exitCode: resolveRecoveryExitCode(summary),
    primaryAction: compactActions[0]?.id || "",
    actionCount: compactActions.length,
    highestPriorityScore,
    highestPriorityActions: compactActions.filter((action) => action.priorityScore === highestPriorityScore).map((action) => action.id),
    actions: compactActions,
  }
  return {
    ...recoverySummary,
    diagnosticHash: buildDiagnosticFingerprint(recoverySummary).diagnosticHash,
  }
}

function buildActionsSummary(compactSummary) {
  return {
    schemaVersion: compactSummary.schemaVersion,
    ok: compactSummary.ok,
    overallStatus: compactSummary.overallStatus,
    healthCode: compactSummary.healthCode,
    primaryAction: compactSummary.primaryAction,
    actionCount: compactSummary.actionCount,
    actions: compactSummary.actions,
  }
}

function compactMatrixAction(action) {
  return {
    id: action.id,
    remediationCode: action.remediationCode,
    severity: action.severity,
    category: action.category,
    priorityScore: action.priorityScore,
    title: action.title,
    command: sanitizeCommandForReport(action.command),
    detail: action.detail,
  }
}

function buildDiagnosticsMatrix(compactSummary) {
  const checks = compactSummary?.checks || []
  const checkNames = new Set(checks.map((check) => check.name))
  const actionsByCheck = new Map()
  const unmappedActions = []
  for (const action of compactSummary?.actions || []) {
    const sourceCheck = action.sourceCheck || "unknown"
    const matrixAction = compactMatrixAction(action)
    if (checkNames.has(sourceCheck)) {
      const mappedActions = actionsByCheck.get(sourceCheck) || []
      mappedActions.push(matrixAction)
      actionsByCheck.set(sourceCheck, mappedActions)
    } else if (sourceCheck !== "none") {
      unmappedActions.push({
        sourceCheck,
        ...matrixAction,
      })
    }
  }
  return {
    schemaVersion: compactSummary.schemaVersion,
    ok: compactSummary.ok,
    overallStatus: compactSummary.overallStatus,
    healthCode: compactSummary.healthCode,
    primaryFailure: compactSummary.primaryFailure,
    primaryAction: compactSummary.primaryAction,
    checks: checks.map((check) => ({
      name: check.name,
      required: Boolean(check.required),
      status: check.status,
      actions: actionsByCheck.get(check.name) || [],
    })),
    unmappedActions,
  }
}

function actionImpactRef(action) {
  return {
    id: action.id,
    remediationCode: action.remediationCode,
    sourceCheck: action.sourceCheck || "unknown",
    priorityScore: action.priorityScore,
  }
}

function addActionImpactBucket(buckets, key, action) {
  const bucketName = key || "unknown"
  const bucket = buckets.get(bucketName) || {
    name: bucketName,
    count: 0,
    actions: [],
  }
  bucket.count += 1
  bucket.actions.push(actionImpactRef(action))
  buckets.set(bucketName, bucket)
}

function buildActionImpactSummary(compactSummary) {
  const severityBuckets = new Map()
  const categoryBuckets = new Map()
  for (const action of compactSummary?.actions || []) {
    addActionImpactBucket(severityBuckets, action.severity, action)
    addActionImpactBucket(categoryBuckets, action.category, action)
  }
  const severities = Array.from(severityBuckets.values())
  const categories = Array.from(categoryBuckets.values())
  return {
    schemaVersion: compactSummary.schemaVersion,
    ok: compactSummary.ok,
    overallStatus: compactSummary.overallStatus,
    healthCode: compactSummary.healthCode,
    primaryAction: compactSummary.primaryAction,
    actionCount: compactSummary.actionCount,
    criticalActionCount: severityBuckets.get("critical")?.count || 0,
    bySeverity: Object.fromEntries(severities.map((bucket) => [bucket.name, bucket.count])),
    byCategory: Object.fromEntries(categories.map((bucket) => [bucket.name, bucket.count])),
    severities,
    categories,
  }
}

function buildPrioritySummary(compactSummary) {
  return {
    schemaVersion: compactSummary.schemaVersion,
    ok: compactSummary.ok,
    overallStatus: compactSummary.overallStatus,
    healthCode: compactSummary.healthCode,
    primaryAction: compactSummary.primaryAction,
    actionCount: compactSummary.actionCount,
    highestPriorityScore: compactSummary.highestPriorityScore,
    highestPriorityActions: compactSummary.highestPriorityActions,
    actions: (compactSummary.actions || []).map((action) => ({
      id: action.id,
      remediationCode: action.remediationCode,
      severity: action.severity,
      category: action.category,
      sourceCheck: action.sourceCheck,
      priorityScore: action.priorityScore,
    })),
  }
}

function compactNextAction(action) {
  if (!action) return null
  return {
    id: action.id,
    remediationCode: action.remediationCode,
    severity: action.severity,
    category: action.category,
    sourceCheck: action.sourceCheck,
    priorityScore: action.priorityScore,
    title: action.title,
    command: sanitizeCommandForReport(action.command),
    detail: action.detail,
  }
}

function buildNextActionSummary(compactSummary) {
  const actions = compactSummary?.actions || []
  const highestPriorityScore = compactSummary?.highestPriorityScore ?? 0
  const nextAction = actions.find((action) => action.priorityScore === highestPriorityScore) || actions[0] || null
  return {
    schemaVersion: compactSummary.schemaVersion,
    ok: compactSummary.ok,
    overallStatus: compactSummary.overallStatus,
    healthCode: compactSummary.healthCode,
    primaryFailure: compactSummary.primaryFailure,
    primaryAction: compactSummary.primaryAction,
    actionCount: compactSummary.actionCount,
    highestPriorityScore,
    nextAction: compactNextAction(nextAction),
    reason: nextAction ? `${nextAction.sourceCheck}:${nextAction.severity}:${nextAction.priorityScore}` : "no_action",
  }
}

function buildActionExecutionPlan(compactSummary) {
  const steps = (compactSummary?.actions || [])
    .map((action, index) => ({
      originalIndex: index,
      action,
    }))
    .sort((left, right) => {
      if (right.action.priorityScore !== left.action.priorityScore) {
        return right.action.priorityScore - left.action.priorityScore
      }
      return left.originalIndex - right.originalIndex
    })
    .map(({ action }, index) => ({
      step: index + 1,
      id: action.id,
      remediationCode: action.remediationCode,
      severity: action.severity,
      category: action.category,
      sourceCheck: action.sourceCheck,
      priorityScore: action.priorityScore,
      title: action.title,
      command: sanitizeCommandForReport(action.command),
      detail: action.detail,
    }))
  return {
    schemaVersion: compactSummary.schemaVersion,
    ok: compactSummary.ok,
    overallStatus: compactSummary.overallStatus,
    healthCode: compactSummary.healthCode,
    primaryAction: compactSummary.primaryAction,
    actionCount: compactSummary.actionCount,
    stepCount: steps.length,
    steps,
  }
}

function buildDiagnosticFingerprint(compactSummary) {
  const payload = {
    schemaVersion: compactSummary.schemaVersion,
    ok: compactSummary.ok,
    overallStatus: compactSummary.overallStatus,
    healthCode: compactSummary.healthCode,
    primaryFailure: compactSummary.primaryFailure,
    checks: (compactSummary.checks || []).map((check) => ({
      name: check.name,
      required: Boolean(check.required),
      status: check.status,
    })),
    actions: (compactSummary.actions || []).map((action) => ({
      id: action.id,
      remediationCode: action.remediationCode,
      severity: action.severity,
      category: action.category,
      sourceCheck: action.sourceCheck,
      priorityScore: action.priorityScore,
    })),
  }
  return {
    schemaVersion: compactSummary.schemaVersion,
    algorithm: "sha256",
    hashInputVersion: 1,
    diagnosticHash: crypto.createHash("sha256").update(stableJsonStringify(payload)).digest("hex"),
  }
}

function buildFingerprintSummary(compactSummary) {
  return {
    ...buildDiagnosticFingerprint(compactSummary),
    ok: compactSummary.ok,
    overallStatus: compactSummary.overallStatus,
    healthCode: compactSummary.healthCode,
    primaryFailure: compactSummary.primaryFailure,
    primaryAction: compactSummary.primaryAction,
    actionCount: compactSummary.actionCount,
  }
}

function buildStatusSummary(compactSummary) {
  return {
    schemaVersion: compactSummary.schemaVersion,
    ok: compactSummary.ok,
    overallStatus: compactSummary.overallStatus,
    healthCode: compactSummary.healthCode,
    primaryFailure: compactSummary.primaryFailure,
    primaryAction: compactSummary.primaryAction,
    exitCode: compactSummary.exitCode,
    failedRequiredCount: compactSummary.failedRequiredCount,
    warningCount: compactSummary.warningCount,
  }
}

function formatMarkdownReport(summary, actions = recommendRecoveryActions(summary)) {
  const compact = buildRecoveryCiSummary(summary, actions)
  const lines = [
    "# SiraGPT local chat diagnostics",
    "",
    `- Status: ${compact.status}`,
    `- Overall status: ${compact.overallStatus}`,
    `- Frontend: ${compact.frontendUrl || "unknown"}`,
    `- API: ${compact.apiUrl || "unknown"}`,
    `- Health code: ${compact.healthCode || "unknown"}`,
    `- Diagnostic hash: ${compact.diagnosticHash || "none"}`,
    `- Exit code: ${compact.exitCode}`,
    `- Slowest probe: ${compact.latencySummary?.slowestProbe ? `${compact.latencySummary.slowestProbe.check} ${compact.latencySummary.slowestProbe.probe} ${compact.latencySummary.slowestProbe.durationMs}ms` : "none"}`,
    `- Failed required checks: ${compact.failedRequiredChecks.length ? compact.failedRequiredChecks.join(", ") : "none"}`,
    `- Primary failure: ${compact.primaryFailure || "none"}`,
    `- Primary action: ${compact.primaryAction || "none"}`,
    `- Highest priority: ${compact.highestPriorityScore} (${compact.highestPriorityActions.length ? compact.highestPriorityActions.join(", ") : "none"})`,
    `- Warnings: ${compact.warnings.length ? compact.warnings.join(", ") : "none"}`,
    "",
    "## Checks",
    "",
    "| Check | Required | Status |",
    "| --- | --- | --- |",
  ]
  for (const check of compact.checks) {
    lines.push(`| ${escapeMarkdownCell(check.name)} | ${check.required ? "yes" : "no"} | ${check.status} |`)
  }
  const diagnosticsMatrix = buildDiagnosticsMatrix(compact)
  lines.push("", "## Check/action matrix", "", "| Check | Status | Actions |", "| --- | --- | --- |")
  for (const check of diagnosticsMatrix.checks) {
    const actionLabels = check.actions.length
      ? check.actions.map((action) => `${action.id} (${action.remediationCode})`).join(", ")
      : "none"
    lines.push(`| ${escapeMarkdownCell(check.name)} | ${check.status} | ${escapeMarkdownCell(actionLabels)} |`)
  }
  const impactSummary = buildActionImpactSummary(compact)
  lines.push("", "## Action impact", "", "| Type | Name | Count | Actions |", "| --- | --- | --- | --- |")
  for (const category of impactSummary.categories) {
    lines.push(`| Category | ${escapeMarkdownCell(category.name)} | ${category.count} | ${escapeMarkdownCell(category.actions.map((action) => action.id).join(", ") || "none")} |`)
  }
  for (const severity of impactSummary.severities) {
    lines.push(`| Severity | ${escapeMarkdownCell(severity.name)} | ${severity.count} | ${escapeMarkdownCell(severity.actions.map((action) => action.id).join(", ") || "none")} |`)
  }
  const nextActionSummary = buildNextActionSummary(compact)
  lines.push("", "## Next action", "", "| ID | Code | Priority | Source check | Command |", "| --- | --- | --- | --- | --- |")
  if (nextActionSummary.nextAction) {
    lines.push(`| ${escapeMarkdownCell(nextActionSummary.nextAction.id)} | ${escapeMarkdownCell(nextActionSummary.nextAction.remediationCode)} | ${nextActionSummary.nextAction.priorityScore} | ${escapeMarkdownCell(nextActionSummary.nextAction.sourceCheck)} | \`${escapeMarkdownCell(nextActionSummary.nextAction.command)}\` |`)
  } else {
    lines.push("| none | none | 0 | none | none |")
  }
  const executionPlan = buildActionExecutionPlan(compact)
  lines.push("", "## Execution plan", "", "| Step | ID | Priority | Command |", "| --- | --- | --- | --- |")
  for (const step of executionPlan.steps) {
    lines.push(`| ${step.step} | ${escapeMarkdownCell(step.id)} | ${step.priorityScore} | \`${escapeMarkdownCell(step.command)}\` |`)
  }
  if (compact.latencySummary?.probeCount) {
    lines.push("", "## Probe latency", "", "| Probe | Duration | Status |", "| --- | --- | --- |")
    for (const probe of compact.latencySummary.probes) {
      lines.push(`| ${escapeMarkdownCell(`${probe.check} ${probe.probe}`)} | ${probe.durationMs}ms | ${probe.ok ? "ok" : "blocked"} |`)
    }
  }
  if (compact.portDiagnostics) {
    lines.push("", "## Port diagnostics", "", "| Target | Port | Listening | Processes |", "| --- | --- | --- | --- |")
    for (const [target, diagnostic] of Object.entries(compact.portDiagnostics)) {
      lines.push(`| ${escapeMarkdownCell(target)} | ${diagnostic.port} | ${diagnostic.listening ? "yes" : "no"} | ${escapeMarkdownCell((diagnostic.commands || []).join(", ") || "none")} |`)
    }
  }
  lines.push("", "## Recommended actions", "", "| ID | Code | Severity | Category | Priority | Title | Command | Detail |", "| --- | --- | --- | --- | --- | --- | --- | --- |")
  for (const action of compact.actions) {
    lines.push(`| ${escapeMarkdownCell(action.id)} | ${escapeMarkdownCell(action.remediationCode)} | ${escapeMarkdownCell(action.severity)} | ${escapeMarkdownCell(action.category)} | ${action.priorityScore} | ${escapeMarkdownCell(action.title)} | \`${escapeMarkdownCell(action.command)}\` | ${escapeMarkdownCell(action.detail)} |`)
  }
  return lines.join("\n")
}

function resolveReportPath(rawPath = DEFAULT_REPORT_PATH, cwd = process.cwd()) {
  const targetPath = String(rawPath || DEFAULT_REPORT_PATH)
  return path.isAbsolute(targetPath) ? targetPath : path.join(cwd, targetPath)
}

function writeReportFile(filePath, contents) {
  const resolvedPath = resolveReportPath(filePath)
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true })
  fs.writeFileSync(resolvedPath, contents.endsWith("\n") ? contents : `${contents}\n`, "utf8")
  return resolvedPath
}

function cleanupOldReports(options = {}) {
  const cwd = options.cwd || process.cwd()
  const directory = options.directory ? resolveReportPath(options.directory, cwd) : path.dirname(resolveReportPath(DEFAULT_REPORT_PATH, cwd))
  const maxAgeHours = Number.isFinite(options.maxAgeHours) ? options.maxAgeHours : DEFAULT_REPORT_MAX_AGE_HOURS
  const maxAgeMs = Number.isFinite(options.maxAgeMs) ? options.maxAgeMs : maxAgeHours * 60 * 60 * 1000
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now()
  if (!fs.existsSync(directory)) return []
  const removed = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    if (!entry.name.startsWith(REPORT_FILE_PREFIX) || !entry.name.endsWith(".md")) continue
    const filePath = path.join(directory, entry.name)
    if (nowMs - fs.statSync(filePath).mtimeMs <= maxAgeMs) continue
    fs.unlinkSync(filePath)
    removed.push(filePath)
  }
  return removed
}

function parseArgs(argv) {
  const args = {
    json: false,
    summaryJson: false,
    statusJson: false,
    actionsJson: false,
    matrixJson: false,
    impactJson: false,
    priorityJson: false,
    nextActionJson: false,
    planJson: false,
    fingerprintJson: false,
    remediationCatalogJson: false,
    markdown: false,
    quiet: false,
    compactJson: false,
    exitCodesJson: false,
    listChecksJson: false,
    writeReport: "",
    cleanOldReports: false,
    maxReportAgeHours: DEFAULT_REPORT_MAX_AGE_HOURS,
    profile: "default",
    inspectPorts: false,
    requireLogin: false,
    strictEnv: false,
    timeoutMs: undefined,
    frontendUrl: "",
    apiUrl: "",
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--json") args.json = true
    else if (arg === "--summary-json") args.summaryJson = true
    else if (arg === "--status-json") args.statusJson = true
    else if (arg === "--actions-json") args.actionsJson = true
    else if (arg === "--matrix-json") args.matrixJson = true
    else if (arg === "--impact-json") args.impactJson = true
    else if (arg === "--priority-json") args.priorityJson = true
    else if (arg === "--next-action-json") args.nextActionJson = true
    else if (arg === "--plan-json") args.planJson = true
    else if (arg === "--fingerprint-json") args.fingerprintJson = true
    else if (arg === "--remediation-catalog-json") args.remediationCatalogJson = true
    else if (arg === "--compact-json") {
      args.summaryJson = true
      args.compactJson = true
    }
    else if (arg === "--markdown") args.markdown = true
    else if (arg === "--quiet") args.quiet = true
    else if (arg === "--exit-codes-json") args.exitCodesJson = true
    else if (arg === "--list-checks-json") args.listChecksJson = true
    else if (arg === "--write-report") {
      const nextArg = argv[index + 1]
      if (nextArg && !nextArg.startsWith("--")) {
        args.writeReport = nextArg
        index += 1
      } else {
        args.writeReport = DEFAULT_REPORT_PATH
      }
    } else if (arg === "--clean-old-reports") args.cleanOldReports = true
    else if (arg === "--max-report-age-hours") args.maxReportAgeHours = parsePositiveInteger(argv[++index], "--max-report-age-hours")
    else if (arg === "--profile") args.profile = argv[++index] || ""
    else if (arg === "--inspect-ports") args.inspectPorts = true
    else if (arg === "--require-login") args.requireLogin = true
    else if (arg === "--strict-env") args.strictEnv = true
    else if (arg === "--timeout-ms") args.timeoutMs = parsePositiveInteger(argv[++index], "--timeout-ms")
    else if (arg === "--frontend-url") args.frontendUrl = argv[++index] || ""
    else if (arg === "--api-url") args.apiUrl = argv[++index] || ""
    else if (arg === "--help") args.help = true
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return applyReadinessProfile(args)
}

function usage() {
  return [
    "Usage:",
    "  npm run doctor:local-chat",
    "  npm run doctor:local-chat -- --json",
    "  npm run doctor:local-chat -- --summary-json",
    "  npm run doctor:local-chat -- --status-json",
    "  npm run doctor:local-chat -- --actions-json",
    "  npm run doctor:local-chat -- --matrix-json",
    "  npm run doctor:local-chat -- --impact-json",
    "  npm run doctor:local-chat -- --priority-json",
    "  npm run doctor:local-chat -- --next-action-json",
    "  npm run doctor:local-chat -- --plan-json",
    "  npm run doctor:local-chat -- --fingerprint-json",
    "  npm run doctor:local-chat -- --remediation-catalog-json",
    "  npm run doctor:local-chat -- --compact-json",
    "  npm run doctor:local-chat -- --markdown",
    "  npm run doctor:local-chat -- --write-report",
    "  npm run doctor:local-chat -- --clean-old-reports",
    "  npm run doctor:local-chat -- --quiet",
    "  npm run doctor:local-chat -- --inspect-ports",
    "  npm run doctor:local-chat -- --require-login",
    "  npm run doctor:local-chat -- --exit-codes-json",
    "  npm run doctor:local-chat -- --list-checks-json",
    "",
    "Options:",
    "  --frontend-url <url>          Override local frontend URL",
    "  --api-url <url>               Override local backend API URL",
    "  --timeout-ms <n>              Timeout for each local probe",
    `  --profile <name>             Probe profile: ${Object.keys(LOCAL_CHAT_PROFILES).join(", ")}`,
    "  --inspect-ports              Include best-effort local listener diagnostics",
    "  --require-login              Probe /api/auth/login with SIRAGPT_TEST_EMAIL and SIRAGPT_TEST_PASSWORD",
    "  --strict-env                  Treat missing local API env as blocking",
    "  --summary-json                Print compact CI-safe JSON",
    "  --status-json                 Print minimal status JSON",
    "  --actions-json                Print recommended actions JSON",
    "  --matrix-json                 Print check/action matrix JSON",
    "  --impact-json                 Print remediation impact summary JSON",
    "  --priority-json               Print remediation priority summary JSON",
    "  --next-action-json            Print next best remediation action JSON",
    "  --plan-json                   Print ordered remediation execution plan JSON",
    "  --fingerprint-json            Print stable diagnostic fingerprint JSON",
    "  --remediation-catalog-json    Print remediation action catalog without running probes",
    "  --compact-json                Print compact single-line CI-safe JSON",
    "  --markdown                    Print sanitized Markdown diagnostics",
    "  --quiet                       Print only healthCode and primaryAction",
    "  --exit-codes-json             Print exit-code map without running probes",
    "  --list-checks-json            Print local check catalog without running probes",
    `  --write-report [path]         Write sanitized Markdown report; default ${DEFAULT_REPORT_PATH}`,
    `  --clean-old-reports           Remove old ${REPORT_FILE_PREFIX}*.md files from tmp`,
    `  --max-report-age-hours <n>    Retention for cleanup; default ${DEFAULT_REPORT_MAX_AGE_HOURS}`,
    "",
    "Exit codes:",
    `  ${RECOVERY_EXIT_CODES.ok}   ready`,
    `  ${RECOVERY_EXIT_CODES.blocked}   blocked by unknown local readiness failure`,
    `  ${RECOVERY_EXIT_CODES.frontend}  frontend routes unavailable`,
    `  ${RECOVERY_EXIT_CODES.backend}  backend health unavailable`,
    `  ${RECOVERY_EXIT_CODES.credentials}  explicit login credentials missing`,
    `  ${RECOVERY_EXIT_CODES.packageScripts}  required package scripts missing`,
    `  ${RECOVERY_EXIT_CODES.localEnv}  local API environment missing`,
    "",
    "Security:",
    "  Reports redact passwords and bearer tokens; env values are reported by presence only.",
    "",
    "Examples:",
    "  npm --silent run doctor:local-chat:ci",
    "  npm --silent run doctor:local-chat:status",
    "  npm --silent run doctor:local-chat:actions",
    "  npm --silent run doctor:local-chat:matrix",
    "  npm --silent run doctor:local-chat:impact",
    "  npm --silent run doctor:local-chat:priority",
    "  npm --silent run doctor:local-chat:next-action",
    "  npm --silent run doctor:local-chat:plan",
    "  npm --silent run doctor:local-chat:fingerprint",
    "  npm --silent run doctor:local-chat:remediations",
    "  npm --silent run doctor:local-chat:compact",
    "  npm run doctor:local-chat -- --inspect-ports --markdown",
    "  SIRAGPT_TEST_EMAIL=admin@example.com SIRAGPT_TEST_PASSWORD=<password> npm run doctor:local-chat -- --require-login",
    "  npm run doctor:local-chat -- --quiet --profile fast",
    "  npm run doctor:local-chat -- --summary-json --timeout-ms 1000",
    "  npm run doctor:local-chat -- --write-report tmp/siragpt-local-chat-diagnostics.md",
  ].join("\n")
}

async function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.help) {
    console.log(usage())
    return 0
  }
  if (args.exitCodesJson) {
    printJson(RECOVERY_EXIT_CODE_LABELS, args.compactJson)
    return 0
  }
  if (args.listChecksJson) {
    printJson({
      schemaVersion: CI_SUMMARY_SCHEMA_VERSION,
      profiles: Object.keys(LOCAL_CHAT_PROFILES),
      checks: LOCAL_CHAT_CHECKS,
    }, args.compactJson)
    return 0
  }
  if (args.remediationCatalogJson) {
    printJson(buildRemediationCatalog(), args.compactJson)
    return 0
  }
  const summary = await runReadiness(args)
  const actions = recommendRecoveryActions(summary)
  const markdownReport = args.markdown || args.writeReport ? formatMarkdownReport(summary, actions) : ""
  const compactSummary = buildRecoveryCiSummary(summary, actions)
  let removedReports = []
  if (args.cleanOldReports) removedReports = cleanupOldReports({ maxAgeHours: args.maxReportAgeHours })
  if (args.quiet) console.log(`${compactSummary.healthCode} ${compactSummary.primaryAction || "none"}`)
  else if (args.markdown) console.log(markdownReport)
  else if (args.statusJson) printJson(buildStatusSummary(compactSummary), args.compactJson)
  else if (args.actionsJson) printJson(buildActionsSummary(compactSummary), args.compactJson)
  else if (args.matrixJson) printJson(buildDiagnosticsMatrix(compactSummary), args.compactJson)
  else if (args.impactJson) printJson(buildActionImpactSummary(compactSummary), args.compactJson)
  else if (args.priorityJson) printJson(buildPrioritySummary(compactSummary), args.compactJson)
  else if (args.nextActionJson) printJson(buildNextActionSummary(compactSummary), args.compactJson)
  else if (args.planJson) printJson(buildActionExecutionPlan(compactSummary), args.compactJson)
  else if (args.fingerprintJson) printJson(buildFingerprintSummary(compactSummary), args.compactJson)
  else if (args.summaryJson) printJson(compactSummary, args.compactJson)
  else if (args.json) printJson({ ok: summary.ok, actions }, args.compactJson)
  else console.log(formatRecoveryReport(summary, actions))
  if (args.writeReport) console.error(`report_written=${writeReportFile(args.writeReport, markdownReport || formatMarkdownReport(summary, actions))}`)
  if (args.cleanOldReports) console.error(`reports_removed=${removedReports.length}`)
  return resolveRecoveryExitCode(summary)
}

if (require.main === module) {
  runCli().then((code) => process.exit(code)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(2)
  })
}

module.exports = {
  DEFAULT_REPORT_MAX_AGE_HOURS,
  DEFAULT_REPORT_PATH,
  RECOVERY_EXIT_CODES,
  RECOVERY_EXIT_CODE_LABELS,
  RECOVERY_ACTION_CATALOG,
  RECOVERY_SEVERITY_PRIORITY,
  REPORT_FILE_PREFIX,
  buildRecoveryCiSummary,
  buildActionImpactSummary,
  buildActionsSummary,
  buildActionExecutionPlan,
  buildDiagnosticFingerprint,
  buildDiagnosticsMatrix,
  buildFingerprintSummary,
  buildNextActionSummary,
  buildPrioritySummary,
  buildRemediationCatalog,
  buildStatusSummary,
  cleanupOldReports,
  escapeMarkdownCell,
  failedBackendHealth,
  formatMarkdownReport,
  formatRecoveryReport,
  hasFailedRequiredCheck,
  enrichRecoveryAction,
  missingLoginCredentials,
  parseArgs,
  recommendRecoveryActions,
  resolveRecoveryExitCode,
  resolveReportPath,
  sanitizeCommandForReport,
  stableJsonStringify,
  usage,
  writeReportFile,
}
