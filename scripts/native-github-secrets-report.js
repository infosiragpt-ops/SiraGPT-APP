#!/usr/bin/env node

const childProcess = require("child_process")
const fs = require("fs")
const path = require("path")

const defaultRepo = process.env.GITHUB_REPOSITORY || "infosiragpt-ops/SiraGPT-APP"

const secretGroups = {
  android: [
    "ANDROID_KEYSTORE_BASE64",
    "ANDROID_KEYSTORE_PASSWORD",
    "ANDROID_KEY_ALIAS",
    "ANDROID_KEY_PASSWORD",
  ],
  googleplay: [
    "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64",
  ],
  ios: [
    "APPLE_TEAM_ID",
    "IOS_SIGNING_CERTIFICATE_BASE64",
    "IOS_SIGNING_CERTIFICATE_PASSWORD",
    "IOS_PROVISIONING_PROFILE_BASE64",
  ],
  appstore: [
    "APP_STORE_CONNECT_API_KEY_ID",
    "APP_STORE_CONNECT_API_ISSUER_ID",
    "APP_STORE_CONNECT_API_KEY_BASE64",
  ],
  macos: [
    "MACOS_CERTIFICATE_BASE64",
    "MACOS_CERTIFICATE_PASSWORD",
    "APPLE_TEAM_ID",
    "APPLE_ID",
    "APPLE_APP_SPECIFIC_PASSWORD",
  ],
  windows: [
    "WINDOWS_CERTIFICATE_BASE64",
    "WINDOWS_CERTIFICATE_PASSWORD",
  ],
}

const aliases = {
  all: ["android", "googleplay", "ios", "appstore", "macos", "windows"],
  mobile: ["android", "googleplay", "ios", "appstore"],
  desktop: ["macos", "windows"],
  apple: ["ios", "appstore", "macos"],
}

function usage() {
  return `Usage: node scripts/native-github-secrets-report.js [--repo=owner/name] [--groups=all|mobile|desktop|apple|android,ios,...] [--source=github|env] [--out=path] [--json-out=path] [--json] [--require-ready]

Generates a non-secret report of native signing/store GitHub Actions secret names.
It never reads or prints secret values.`
}

function parseArgs(argv) {
  const args = {
    repo: defaultRepo,
    groups: "all",
    source: "github",
    format: "markdown",
    out: "",
    jsonOut: "",
    requireReady: false,
    help: false,
  }

  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") {
      args.help = true
    } else if (arg === "--json") {
      args.format = "json"
    } else if (arg === "--markdown") {
      args.format = "markdown"
    } else if (arg === "--require-ready") {
      args.requireReady = true
    } else if (arg.startsWith("--repo=")) {
      args.repo = arg.slice("--repo=".length)
    } else if (arg.startsWith("--groups=")) {
      args.groups = arg.slice("--groups=".length)
    } else if (arg.startsWith("--source=")) {
      args.source = arg.slice("--source=".length)
    } else if (arg.startsWith("--out=")) {
      args.out = arg.slice("--out=".length)
    } else if (arg.startsWith("--json-out=")) {
      args.jsonOut = arg.slice("--json-out=".length)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (!["github", "env"].includes(args.source)) {
    throw new Error(`Unknown source: ${args.source}`)
  }

  return args
}

function unique(items) {
  return [...new Set(items)]
}

function expandGroups(value) {
  const requested = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)

  const expanded = requested.length > 0
    ? requested.flatMap((item) => aliases[item] || [item])
    : aliases.all

  const unknown = expanded.filter((item) => !secretGroups[item])
  if (unknown.length > 0) {
    throw new Error(`Unknown secret group: ${unknown.join(", ")}`)
  }

  return unique(expanded)
}

function listGithubSecrets(repo) {
  try {
    const output = childProcess.execFileSync("gh", [
      "secret",
      "list",
      "--repo",
      repo,
      "--json",
      "name,updatedAt",
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
    const parsed = JSON.parse(output)
    return {
      sourceStatus: "available",
      configuredRepositorySecrets: parsed
        .map((item) => item.name)
        .filter(Boolean)
        .sort(),
      error: "",
    }
  } catch (error) {
    return {
      sourceStatus: "unavailable",
      configuredRepositorySecrets: [],
      error: error.stderr?.toString().trim() || error.message,
    }
  }
}

function listEnvSecrets() {
  return {
    sourceStatus: "available",
    configuredRepositorySecrets: unique(Object.values(secretGroups).flat())
      .filter((name) => Boolean(process.env[name] && process.env[name].trim()))
      .sort(),
    error: "",
  }
}

function getConfiguredSecrets({ repo, source }) {
  return source === "env" ? listEnvSecrets() : listGithubSecrets(repo)
}

function buildReport({ repo, groups, source }) {
  const configured = getConfiguredSecrets({ repo, source })
  const configuredSet = new Set(configured.configuredRepositorySecrets)
  const canAudit = configured.sourceStatus === "available"
  const groupReports = groups.map((group) => {
    const requiredSecrets = secretGroups[group]
    const configuredSecrets = requiredSecrets.filter((name) => configuredSet.has(name))
    const missingSecrets = canAudit
      ? requiredSecrets.filter((name) => !configuredSet.has(name))
      : requiredSecrets
    return {
      group,
      status: canAudit && missingSecrets.length === 0 ? "ready" : "missing",
      requiredSecrets,
      configuredSecrets,
      missingSecrets,
    }
  })
  const missingRequiredSecrets = unique(groupReports.flatMap((group) => group.missingSecrets)).sort()
  const requiredSecretNames = unique(groupReports.flatMap((group) => group.requiredSecrets)).sort()

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    repo,
    source,
    sourceStatus: configured.sourceStatus,
    status: canAudit && missingRequiredSecrets.length === 0 ? "ready" : "blocked-missing-native-signing-secrets",
    configuredRepositorySecrets: configured.configuredRepositorySecrets,
    configuredNativeSecrets: requiredSecretNames.filter((name) => configuredSet.has(name)),
    requiredSecretNames,
    missingRequiredSecrets,
    missingRequiredGroups: groupReports
      .filter((group) => group.missingSecrets.length > 0)
      .map((group) => group.group),
    groups: groupReports,
    error: configured.error,
  }
}

function codeList(items) {
  if (items.length === 0) return "`none`"
  return items.map((item) => `\`${item}\``).join(", ")
}

function renderMarkdown(report) {
  const lines = []
  lines.push("# Native GitHub Secrets Report")
  lines.push("")
  lines.push(`Generated: ${report.generatedAt}`)
  lines.push(`Repository: \`${report.repo}\``)
  lines.push(`Source: \`${report.source}\``)
  lines.push(`Status: \`${report.status}\``)
  lines.push("")
  lines.push("This report contains only GitHub Actions secret names and readiness states. It does not read or print secret values.")
  lines.push("")
  lines.push("## Summary")
  lines.push("")
  lines.push(`- Configured repository secret names: ${codeList(report.configuredRepositorySecrets)}`)
  lines.push(`- Configured native secret names: ${codeList(report.configuredNativeSecrets)}`)
  lines.push(`- Missing native secret names: ${codeList(report.missingRequiredSecrets)}`)
  lines.push(`- Missing groups: ${codeList(report.missingRequiredGroups)}`)
  lines.push("")
  lines.push("## Groups")
  lines.push("")
  lines.push("| Group | Status | Configured | Missing |")
  lines.push("| --- | --- | --- | --- |")
  for (const group of report.groups) {
    lines.push(`| \`${group.group}\` | \`${group.status}\` | ${codeList(group.configuredSecrets)} | ${codeList(group.missingSecrets)} |`)
  }
  lines.push("")
  lines.push("## Next Commands")
  lines.push("")
  lines.push("```bash")
  lines.push(`npm run native:github-secrets:template -- --platform=all --out=output/native-signing.env.example`)
  lines.push(`npm run native:github-secrets:setup -- --repo=${report.repo} --platform=all --dry-run`)
  lines.push(`npm run native:github-secrets:setup -- --repo=${report.repo} --platform=all`)
  lines.push(`npm run native:github-secrets:report -- --repo=${report.repo} --require-ready`)
  lines.push("```")
  lines.push("")
  return lines.join("\n")
}

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, contents)
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(usage())
    return
  }

  const groups = expandGroups(args.groups)
  const report = buildReport({ repo: args.repo, groups, source: args.source })
  const json = `${JSON.stringify(report, null, 2)}\n`
  const markdown = renderMarkdown(report)

  if (args.jsonOut) writeFile(args.jsonOut, json)
  if (args.out) writeFile(args.out, markdown)
  process.stdout.write(args.format === "json" ? json : markdown)

  if (args.requireReady && report.status !== "ready") {
    process.exitCode = 1
  }
}

try {
  main()
} catch (error) {
  console.error(`native-github-secrets-report: ${error.message}`)
  process.exit(2)
}
