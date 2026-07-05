#!/usr/bin/env node

const childProcess = require("child_process")
const fs = require("fs")
const path = require("path")

const root = path.resolve(__dirname, "..")
const metadataPath = path.join(root, "docs/store-submission/native-store-metadata.json")
const defaultRepo = process.env.GITHUB_REPOSITORY || "infosiragpt-ops/SiraGPT-APP"

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

const platforms = {
  android: {
    label: "Android",
    metadataKey: "android",
    workflowPlatform: "android",
    artifact: "signed Google Play upload .aab",
    releaseGroups: ["android"],
    storeGroups: ["googleplay"],
  },
  ios: {
    label: "iPhone / iOS",
    metadataKey: "ios",
    workflowPlatform: "ios",
    artifact: "signed App Store .ipa",
    releaseGroups: ["ios"],
    storeGroups: ["appstore"],
  },
  macos: {
    label: "macOS",
    metadataKey: "macos",
    workflowPlatform: "macos",
    artifact: "signed and notarized .dmg/.zip",
    releaseGroups: ["macos"],
    storeGroups: [],
  },
  windows: {
    label: "Windows",
    metadataKey: "windows",
    workflowPlatform: "windows",
    artifact: "signed NSIS installer and portable .exe",
    releaseGroups: ["windows"],
    storeGroups: [],
  },
}

const platformAliases = {
  all: Object.keys(platforms),
  mobile: ["android", "ios"],
  desktop: ["macos", "windows"],
  apple: ["ios", "macos"],
}

const secretSources = new Set(["github", "env"])

function parseArgs(argv) {
  const args = {
    repo: defaultRepo,
    platform: "all",
    format: "markdown",
    out: "",
    jsonOut: "",
    requireReady: false,
    secretSource: "github",
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
    } else if (arg.startsWith("--secret-source=")) {
      args.secretSource = arg.slice("--secret-source=".length)
    } else if (arg.startsWith("--repo=")) {
      args.repo = arg.slice("--repo=".length)
    } else if (arg.startsWith("--platform=")) {
      args.platform = arg.slice("--platform=".length)
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
  return `Usage: node scripts/native-release-plan.js [--repo=owner/name] [--platform=all|mobile|desktop|android|ios|macos|windows] [--secret-source=github|env] [--markdown|--json] [--out=path] [--json-out=path] [--require-ready]

Creates a non-secret native release management plan for Mac, Windows, iPhone, and Android.
It can query GitHub Actions secret names through gh or inspect selected environment-variable presence, but it never prints secret values.`
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"))
}

function unique(items) {
  return [...new Set(items)]
}

function expandPlatforms(input) {
  const names = input
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)

  const expanded = names.length > 0
    ? names.flatMap((name) => platformAliases[name] || [name])
    : platformAliases.all

  const unknown = expanded.filter((name) => !platforms[name])
  if (unknown.length > 0) {
    throw new Error(`Unknown platform: ${unknown.join(", ")}`)
  }

  return unique(expanded)
}

function listGithubSecrets(repo) {
  try {
    const output = childProcess.execFileSync("gh", ["secret", "list", "--repo", repo], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })

    const names = output
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/)[0])
      .filter(Boolean)

    return {
      status: "available",
      names,
      error: "",
    }
  } catch (error) {
    return {
      status: "unavailable",
      names: [],
      error: error.stderr?.toString().trim() || error.message,
    }
  }
}

function listEnvironmentSecrets() {
  const names = unique(Object.values(secretGroups).flat())
    .filter((name) => Boolean(process.env[name] && process.env[name].trim()))

  return {
    source: "env",
    status: "available",
    names,
    error: "",
  }
}

function listSecrets({ repo, source }) {
  if (!secretSources.has(source)) {
    throw new Error(`Unknown secret source: ${source}`)
  }

  if (source === "env") {
    return listEnvironmentSecrets()
  }

  return {
    source: "github",
    ...listGithubSecrets(repo),
  }
}

function secretsForGroups(groups) {
  return unique(groups.flatMap((group) => secretGroups[group] || []))
}

function secretStatus(secretNames, presentNames, canAudit) {
  if (!canAudit) {
    return {
      ready: false,
      present: [],
      missing: secretNames,
      status: "unknown",
    }
  }

  const present = secretNames.filter((name) => presentNames.includes(name))
  const missing = secretNames.filter((name) => !presentNames.includes(name))
  return {
    ready: missing.length === 0,
    present,
    missing,
    status: missing.length === 0 ? "ready" : "missing",
  }
}

function createPlan({ repo, selectedPlatforms, metadata, secrets }) {
  const canAudit = secrets.status === "available"
  const generatedAt = new Date().toISOString()
  const platformPlans = selectedPlatforms.map((name) => {
    const platform = platforms[name]
    const releaseSecrets = secretsForGroups(platform.releaseGroups)
    const storeSecrets = secretsForGroups(platform.storeGroups)
    const allSecrets = unique([...releaseSecrets, ...storeSecrets])
    const metadataPlatform = metadata.platforms?.[platform.metadataKey] || {}

    return {
      key: name,
      label: platform.label,
      workflowPlatform: platform.workflowPlatform,
      artifact: platform.artifact,
      releaseGroups: platform.releaseGroups,
      storeGroups: platform.storeGroups,
      releaseSecrets: secretStatus(releaseSecrets, secrets.names, canAudit),
      storeUploadSecrets: secretStatus(storeSecrets, secrets.names, canAudit),
      allSecrets: secretStatus(allSecrets, secrets.names, canAudit),
      accountActions: metadataPlatform.requiredAccountActions || [],
    }
  })

  const missingSecrets = unique(platformPlans.flatMap((platform) => platform.allSecrets.missing))
  const ready = canAudit && missingSecrets.length === 0
  const statusReason = !canAudit
    ? "secret-audit-unavailable"
    : ready
      ? "all-native-signing-secrets-configured"
      : "missing-native-signing-or-store-upload-secrets"
  const signedReleaseStatus = ready
    ? "ready-to-run"
    : "blocked-missing-signing-secrets"

  return {
    generatedAt,
    repo,
    status: ready ? "ready" : "blocked",
    statusReason,
    actionsVsSigningDiagnosis: {
      publicRepoActionsGate: "separate-from-native-signing",
      signedReleaseStatus,
      message: ready
        ? "GitHub Actions can run the signed release workflow when the owner approves the selected platform and release target."
        : "GitHub Actions can run CI and QA workflows in the public repository, but signed native release package jobs still require the missing GitHub Actions secret names below.",
      nextOwnerAction: ready
        ? "Run Native signed release packages with the selected platform and upload flags."
        : "Configure the missing native signing and store-upload secret names as GitHub Actions secrets from a trusted machine.",
    },
    githubSecretAudit: {
      source: secrets.source,
      status: secrets.status,
      error: secrets.error,
      presentCount: secrets.names.length,
    },
    app: {
      name: metadata.app?.name,
      desktopProductName: metadata.app?.desktopProductName,
      supportEmail: metadata.app?.supportEmail,
      webRuntimeUrl: metadata.app?.webRuntimeUrl,
      bundleIds: metadata.app?.bundleIds,
    },
    platformPlans,
    missingSecrets,
  }
}

function formatList(items) {
  if (!items.length) return "- none"
  return items.map((item) => `- ${item}`).join("\n")
}

function formatSecretCommands(repo, secrets) {
  if (!secrets.length) return "# none"
  return secrets
    .map((secret) => `gh secret set ${secret} --repo ${repo}`)
    .join("\n")
}

function renderMarkdown(plan) {
  const lines = []
  lines.push("# SiraGPT Native Release Management Plan")
  lines.push("")
  lines.push(`Generated: ${plan.generatedAt}`)
  lines.push(`Repository: \`${plan.repo}\``)
  lines.push(`Status: \`${plan.status}\``)
  lines.push(`Status reason: \`${plan.statusReason}\``)
  lines.push(`Secret audit source: \`${plan.githubSecretAudit.source}\``)
  lines.push("")
  lines.push("This plan contains secret names only. It must never include passwords, certificates, keystores, provisioning profiles, API private keys, or app-specific passwords.")
  lines.push("")
  lines.push("## Actions vs Signed Release Diagnosis")
  lines.push("")
  lines.push("- Public repository Actions and native signing are separate gates.")
  lines.push(`- Signed release status: \`${plan.actionsVsSigningDiagnosis.signedReleaseStatus}\``)
  lines.push(`- Diagnosis: ${plan.actionsVsSigningDiagnosis.message}`)
  lines.push(`- Next owner action: ${plan.actionsVsSigningDiagnosis.nextOwnerAction}`)
  lines.push("")
  lines.push("## Native Identity")
  lines.push("")
  lines.push(`- App name: \`${plan.app.name}\``)
  lines.push(`- Desktop product: \`${plan.app.desktopProductName}\``)
  lines.push(`- Support email: \`${plan.app.supportEmail}\``)
  lines.push(`- Runtime URL: \`${plan.app.webRuntimeUrl}\``)
  lines.push(`- Android package: \`${plan.app.bundleIds?.android}\``)
  lines.push(`- iOS bundle ID: \`${plan.app.bundleIds?.ios}\``)
  lines.push(`- macOS bundle ID: \`${plan.app.bundleIds?.macos}\``)
  lines.push(`- Windows app ID: \`${plan.app.bundleIds?.windows}\``)
  lines.push("")
  lines.push("## Platform Matrix")
  lines.push("")
  lines.push("| Platform | Signed artifact | Workflow input | GitHub secret status |")
  lines.push("| --- | --- | --- | --- |")
  for (const platform of plan.platformPlans) {
    lines.push(`| ${platform.label} | ${platform.artifact} | \`${platform.workflowPlatform}\` | \`${platform.allSecrets.status}\` |`)
  }
  lines.push("")
  lines.push("## Missing GitHub Actions Secrets")
  lines.push("")
  if (plan.githubSecretAudit.status !== "available") {
    lines.push(`GitHub secret audit unavailable: ${plan.githubSecretAudit.error || "unknown error"}`)
    lines.push("")
  }
  lines.push(formatList(plan.missingSecrets.map((secret) => `\`${secret}\``)))
  lines.push("")
  lines.push("## Safe Secret Upload Commands")
  lines.push("")
  lines.push("Run these commands only from a trusted machine. Paste each real value interactively when GitHub CLI prompts for it; do not paste values into this document.")
  lines.push("")
  lines.push("```bash")
  lines.push(formatSecretCommands(plan.repo, plan.missingSecrets))
  lines.push("```")
  lines.push("")
  lines.push("## Platform Details")
  for (const platform of plan.platformPlans) {
    lines.push("")
    lines.push(`### ${platform.label}`)
    lines.push("")
    lines.push(`- Signed artifact: ${platform.artifact}`)
    lines.push(`- Workflow input: \`${platform.workflowPlatform}\``)
    lines.push(`- Release secret groups: ${platform.releaseGroups.map((group) => `\`${group}\``).join(", ") || "none"}`)
    lines.push(`- Store upload secret groups: ${platform.storeGroups.map((group) => `\`${group}\``).join(", ") || "none"}`)
    lines.push(`- Missing secrets: ${platform.allSecrets.missing.length ? platform.allSecrets.missing.map((secret) => `\`${secret}\``).join(", ") : "none"}`)
    lines.push("")
    lines.push("Account/store actions:")
    lines.push(formatList(platform.accountActions))
  }
  lines.push("")
  lines.push("## Next Verification Commands")
  lines.push("")
  lines.push("```bash")
  lines.push("npm run native:store:readiness")
  lines.push("npm run native:github-secrets:audit")
  lines.push("npm run native:github-secrets:check")
  lines.push("npm run native:readiness:all")
  lines.push("```")
  lines.push("")
  lines.push("When all required secrets are configured, run GitHub Actions -> Native signed release packages and choose the matching platform.")
  lines.push("")
  return `${lines.join("\n")}\n`
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

  const selectedPlatforms = expandPlatforms(args.platform)
  const metadata = readJson(metadataPath)
  const secrets = listSecrets({
    repo: args.repo,
    source: args.secretSource,
  })
  const plan = createPlan({
    repo: args.repo,
    selectedPlatforms,
    metadata,
    secrets,
  })

  const json = `${JSON.stringify(plan, null, 2)}\n`
  const markdown = renderMarkdown(plan)

  if (args.jsonOut) writeFile(path.resolve(root, args.jsonOut), json)
  if (args.out) writeFile(path.resolve(root, args.out), markdown)

  process.stdout.write(args.format === "json" ? json : markdown)

  if (args.requireReady && plan.status !== "ready") {
    process.exit(1)
  }
}

try {
  main()
} catch (error) {
  console.error(`native-release-plan: ${error.message}`)
  process.exit(2)
}
