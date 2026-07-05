#!/usr/bin/env node

const fs = require("fs")
const path = require("path")

const secretGroups = {
  android: [
    "ANDROID_KEYSTORE_BASE64",
    "ANDROID_KEYSTORE_PASSWORD",
    "ANDROID_KEY_ALIAS",
    "ANDROID_KEY_PASSWORD",
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
  googleplay: [
    "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64",
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

function isPresent(name) {
  return Boolean(process.env[name] && process.env[name].trim())
}

function unique(items) {
  return [...new Set(items)]
}

function selectedGroups(platform) {
  switch (platform) {
    case "all":
      return ["android", "ios", "macos", "windows"]
    case "android":
    case "ios":
    case "macos":
    case "windows":
      return [platform]
    default:
      return []
  }
}

function parseArgs(argv) {
  const args = {
    out: "",
    jsonOut: "",
    help: false,
  }

  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") {
      args.help = true
    } else if (arg.startsWith("--out=")) {
      args.out = arg.slice("--out=".length)
    } else if (arg.startsWith("--json-out=")) {
      args.jsonOut = arg.slice("--json-out=".length)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return args
}

function usage() {
  return `Usage: node scripts/native-release-preflight-summary.js [--out=path] [--json-out=path]

Validates selected signed native release workflow inputs and secret presence.
It writes secret names only and never prints secret values.`
}

function evaluatePreflight(env) {
  const platform = env.PLATFORM || "all"
  const uploadIos = env.UPLOAD_IOS_APP_STORE_CONNECT === "true"
  const uploadAndroid = env.UPLOAD_ANDROID_GOOGLE_PLAY === "true"
  const androidReleaseStatus = env.ANDROID_RELEASE_STATUS || "draft"
  const androidUserFraction = env.ANDROID_USER_FRACTION || ""
  const groups = selectedGroups(platform)
  const inputErrors = []

  if (groups.length === 0) {
    inputErrors.push(`Unknown platform: ${platform}`)
  }
  if (uploadIos && platform !== "ios" && platform !== "all") {
    inputErrors.push("upload_ios_app_store_connect requires platform ios or all")
  }
  if (uploadAndroid && platform !== "android" && platform !== "all") {
    inputErrors.push("upload_android_google_play requires platform android or all")
  }
  if (uploadAndroid && androidReleaseStatus === "inProgress" && !androidUserFraction) {
    inputErrors.push("android_user_fraction is required when android_release_status is inProgress")
  }
  if (uploadAndroid && androidReleaseStatus !== "inProgress" && androidUserFraction) {
    inputErrors.push("android_user_fraction is only valid when android_release_status is inProgress")
  }

  if (uploadIos) groups.push("appstore")
  if (uploadAndroid) groups.push("googleplay")

  const uniqueGroups = unique(groups)
  const groupResults = uniqueGroups.map((group) => {
    const secrets = secretGroups[group] || []
    const missing = secrets.filter((secretName) => !isPresent(secretName))
    return {
      group,
      status: missing.length === 0 ? "ready" : "missing",
      missing,
    }
  })
  const missingGroups = groupResults.filter((result) => result.missing.length > 0)
  const status = inputErrors.length > 0
    ? "invalid-workflow-input"
    : missingGroups.length > 0
      ? "blocked-missing-signing-secrets"
      : "ready-to-run"

  return {
    status,
    platform,
    releaseTag: env.RELEASE_TAG || "",
    repository: env.GITHUB_REPOSITORY || "",
    gitSha: env.GITHUB_SHA || "",
    runUrl: env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
      ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
      : "",
    uploadIos,
    uploadAndroid,
    androidReleaseStatus,
    androidUserFractionProvided: Boolean(androidUserFraction),
    inputErrors,
    groupResults,
    missingSecrets: unique(missingGroups.flatMap((result) => result.missing)),
  }
}

function formatMissing(missing) {
  return missing.length > 0 ? missing.map((name) => `\`${name}\``).join(", ") : "none"
}

function renderMarkdown(result) {
  const lines = []
  lines.push("# Signed Native Release Preflight")
  lines.push("")
  lines.push(`Status: \`${result.status}\``)
  lines.push(`Repository: \`${result.repository || "unknown"}\``)
  lines.push(`Platform input: \`${result.platform}\``)
  lines.push(`Release tag: \`${result.releaseTag || "not-set"}\``)
  lines.push(`Git SHA: \`${result.gitSha || "unknown"}\``)
  if (result.runUrl) {
    lines.push(`Run URL: ${result.runUrl}`)
  }
  lines.push("")
  lines.push("This preflight validates secret presence only. It never prints secret values, certificates, keystores, provisioning profiles, API private keys, app-specific passwords, cookies, or mailbox passwords.")
  lines.push("")
  lines.push("## Diagnosis")
  lines.push("")
  if (result.status === "ready-to-run") {
    lines.push("All selected signing/upload secret names are present. The workflow can continue to the selected platform package jobs.")
  } else if (result.status === "invalid-workflow-input") {
    lines.push("The workflow inputs are invalid. Correct the inputs and run the workflow again.")
  } else {
    lines.push("GitHub Actions is running this workflow. Signed native package generation is blocked only because the selected platform signing/upload secrets are missing.")
  }
  lines.push("")
  lines.push("## Required Secret Groups")
  lines.push("")
  lines.push("| Group | Status | Missing secret names |")
  lines.push("| --- | --- | --- |")
  for (const group of result.groupResults) {
    lines.push(`| \`${group.group}\` | \`${group.status}\` | ${formatMissing(group.missing)} |`)
  }
  lines.push("")
  if (result.inputErrors.length > 0) {
    lines.push("## Input Errors")
    lines.push("")
    for (const error of result.inputErrors) {
      lines.push(`- ${error}`)
    }
    lines.push("")
  }
  lines.push("## Safe Next Steps")
  lines.push("")
  if (result.status === "ready-to-run") {
    lines.push("- Let this workflow continue and inspect the signed artifacts before release/upload.")
  } else {
    lines.push("- Generate the blank owner template with `npm run native:github-secrets:template`.")
    lines.push("- Load real platform material from a trusted machine with `npm run native:github-secrets:setup -- --platform=<platform>`.")
    lines.push("- Re-run `Native signed release packages` only after the owner confirms the platform, release tag, and upload flags.")
  }
  lines.push("")
  lines.push("Do not use a normal email password as native signing material.")
  lines.push("")
  return `${lines.join("\n")}\n`
}

function writeSummary(markdown) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY
  if (!summaryPath) return
  fs.appendFileSync(summaryPath, markdown)
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

  const result = evaluatePreflight(process.env)
  const markdown = renderMarkdown(result)
  const json = `${JSON.stringify(result, null, 2)}\n`

  writeSummary(markdown)
  if (args.out) writeFile(args.out, markdown)
  if (args.jsonOut) writeFile(args.jsonOut, json)

  console.log(`native-signed-preflight-status=${result.status}`)
  console.log(`native-signed-preflight-platform=${result.platform}`)
  console.log(`native-signed-preflight-missing-secrets=${result.missingSecrets.length}`)

  if (result.status === "invalid-workflow-input") {
    process.exit(2)
  }
  if (result.status !== "ready-to-run") {
    process.exit(1)
  }
}

if (require.main === module) {
  main()
}

module.exports = {
  evaluatePreflight,
  renderMarkdown,
}
