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
    artifactWorkflowInputs: {
      platform: "android",
      create_github_release: "true",
      upload_android_google_play: "false",
    },
    storeWorkflowInputs: {
      platform: "android",
      create_github_release: "true",
      upload_android_google_play: "true",
      android_play_track: "qa",
      android_release_status: "draft",
    },
  },
  ios: {
    label: "iPhone / iOS",
    metadataKey: "ios",
    workflowPlatform: "ios",
    artifact: "signed App Store .ipa",
    releaseGroups: ["ios"],
    storeGroups: ["appstore"],
    artifactWorkflowInputs: {
      platform: "ios",
      create_github_release: "true",
      upload_ios_app_store_connect: "false",
    },
    storeWorkflowInputs: {
      platform: "ios",
      create_github_release: "true",
      upload_ios_app_store_connect: "true",
    },
  },
  macos: {
    label: "macOS",
    metadataKey: "macos",
    workflowPlatform: "macos",
    artifact: "signed and notarized .dmg/.zip",
    releaseGroups: ["macos"],
    storeGroups: [],
    artifactWorkflowInputs: {
      platform: "macos",
      create_github_release: "true",
    },
    storeWorkflowInputs: null,
  },
  windows: {
    label: "Windows",
    metadataKey: "windows",
    workflowPlatform: "windows",
    artifact: "signed NSIS installer and portable .exe",
    storePackageArtifact: "unsigned AppX with exact Partner Center identity; Microsoft Store signs it during certification",
    storePackageWorkflow: "Native desktop builds",
    storePackageVariables: [
      "WINDOWS_STORE_IDENTITY_NAME",
      "WINDOWS_STORE_PUBLISHER",
      "WINDOWS_STORE_PUBLISHER_DISPLAY_NAME",
      "WINDOWS_STORE_APPLICATION_ID",
    ],
    releaseGroups: ["windows"],
    storeGroups: [],
    artifactWorkflowInputs: {
      platform: "windows",
      create_github_release: "true",
    },
    storeWorkflowInputs: null,
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
      artifactWorkflowInputs: platform.artifactWorkflowInputs,
      storeWorkflowInputs: platform.storeWorkflowInputs,
      storePackageArtifact: platform.storePackageArtifact || null,
      storePackageWorkflow: platform.storePackageWorkflow || null,
      storePackageVariables: platform.storePackageVariables || [],
    }
  })

  const missingSigningSecrets = unique(platformPlans.flatMap((platform) => platform.releaseSecrets.missing))
  const missingStoreUploadSecrets = unique(platformPlans.flatMap((platform) => platform.storeUploadSecrets.missing))
  const missingSecrets = unique(platformPlans.flatMap((platform) => platform.allSecrets.missing))
  const ready = canAudit && missingSecrets.length === 0
  const readyPlatforms = platformPlans
    .filter((platform) => platform.allSecrets.ready)
    .map((platform) => platform.key)
  const blockedPlatforms = platformPlans
    .filter((platform) => !platform.allSecrets.ready)
    .map((platform) => platform.key)
  const signedPackageReadyPlatforms = platformPlans
    .filter((platform) => platform.releaseSecrets.ready)
    .map((platform) => platform.key)
  const signedPackageBlockedPlatforms = platformPlans
    .filter((platform) => !platform.releaseSecrets.ready)
    .map((platform) => platform.key)
  const storePlatforms = platformPlans.filter((platform) => platform.storeGroups.length > 0)
  const storeUploadReadyPlatforms = storePlatforms
    .filter((platform) => platform.allSecrets.ready)
    .map((platform) => platform.key)
  const storeUploadBlockedPlatforms = storePlatforms
    .filter((platform) => !platform.allSecrets.ready)
    .map((platform) => platform.key)
  const storeUploadNotApplicablePlatforms = platformPlans
    .filter((platform) => platform.storeGroups.length === 0)
    .map((platform) => platform.key)
  const statusReason = !canAudit
    ? "secret-audit-unavailable"
    : ready
      ? "all-selected-signing-and-store-upload-secrets-configured"
      : "missing-native-signing-or-store-upload-secrets"
  const signedReleaseStatus = signedPackageReadyPlatforms.length === platformPlans.length
    ? "ready-to-run"
    : signedPackageReadyPlatforms.length > 0
      ? "partially-ready"
      : "blocked-missing-signing-secrets"
  const storeUploadStatus = storePlatforms.length === 0
    ? "not-applicable"
    : storeUploadReadyPlatforms.length === storePlatforms.length
      ? "ready-to-run-draft-upload"
      : storeUploadReadyPlatforms.length > 0
        ? "partially-ready"
        : "blocked-missing-store-upload-secrets"

  return {
    generatedAt,
    repo,
    status: ready ? "ready" : "blocked",
    statusReason,
    releaseGateSummary: {
      status: ready ? "ready-to-run-signed-release" : "owner-action-required",
      readyPlatforms,
      blockedPlatforms,
      signedPackageReadyPlatforms,
      signedPackageBlockedPlatforms,
      storeUploadReadyPlatforms,
      storeUploadBlockedPlatforms,
      storeUploadNotApplicablePlatforms,
      workflow: "Native signed release packages",
      firstSafeUploadMode: "create GitHub Release plus draft/internal store upload only after owner confirmation",
    },
    actionsVsSigningDiagnosis: {
      publicRepoActionsGate: "separate-from-native-signing",
      signedReleaseStatus,
      storeUploadStatus,
      message: signedPackageReadyPlatforms.length > 0
        ? `Signed package generation is ready for ${signedPackageReadyPlatforms.join(", ")}. Store upload remains a separate gate and must not block artifact-only releases.`
        : "GitHub Actions can run CI and QA workflows in the public repository, but signed native package jobs still require the missing signing secret names below.",
      nextOwnerAction: missingSigningSecrets.length > 0
        ? "Configure the missing platform-signing secret names from a trusted machine; store-upload credentials can be added independently."
        : missingStoreUploadSecrets.length > 0
          ? "Signed packages can be generated now. Configure store-upload credentials only after the owner completes the vendor portal prerequisites."
          : "Run Native signed release packages with the selected platform; enable store upload only for a verified draft/internal target.",
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
    missingSigningSecrets,
    missingStoreUploadSecrets,
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
  lines.push(`- Signed package status: \`${plan.actionsVsSigningDiagnosis.signedReleaseStatus}\``)
  lines.push(`- Store upload status: \`${plan.actionsVsSigningDiagnosis.storeUploadStatus}\``)
  lines.push(`- Diagnosis: ${plan.actionsVsSigningDiagnosis.message}`)
  lines.push(`- Next owner action: ${plan.actionsVsSigningDiagnosis.nextOwnerAction}`)
  lines.push("")
  lines.push("## Release Gate Summary")
  lines.push("")
  lines.push(`- Gate status: \`${plan.releaseGateSummary.status}\``)
  lines.push(`- Workflow: \`${plan.releaseGateSummary.workflow}\``)
  lines.push(`- End-to-end ready: ${plan.releaseGateSummary.readyPlatforms.length ? plan.releaseGateSummary.readyPlatforms.map((platform) => `\`${platform}\``).join(", ") : "none"}`)
  lines.push(`- End-to-end blocked: ${plan.releaseGateSummary.blockedPlatforms.length ? plan.releaseGateSummary.blockedPlatforms.map((platform) => `\`${platform}\``).join(", ") : "none"}`)
  lines.push(`- Signed-package ready: ${plan.releaseGateSummary.signedPackageReadyPlatforms.length ? plan.releaseGateSummary.signedPackageReadyPlatforms.map((platform) => `\`${platform}\``).join(", ") : "none"}`)
  lines.push(`- Signed-package blocked: ${plan.releaseGateSummary.signedPackageBlockedPlatforms.length ? plan.releaseGateSummary.signedPackageBlockedPlatforms.map((platform) => `\`${platform}\``).join(", ") : "none"}`)
  lines.push(`- Store-upload ready: ${plan.releaseGateSummary.storeUploadReadyPlatforms.length ? plan.releaseGateSummary.storeUploadReadyPlatforms.map((platform) => `\`${platform}\``).join(", ") : "none"}`)
  lines.push(`- Store-upload blocked: ${plan.releaseGateSummary.storeUploadBlockedPlatforms.length ? plan.releaseGateSummary.storeUploadBlockedPlatforms.map((platform) => `\`${platform}\``).join(", ") : "none"}`)
  lines.push(`- Store upload not applicable: ${plan.releaseGateSummary.storeUploadNotApplicablePlatforms.length ? plan.releaseGateSummary.storeUploadNotApplicablePlatforms.map((platform) => `\`${platform}\``).join(", ") : "none"}`)
  lines.push(`- First safe upload mode: ${plan.releaseGateSummary.firstSafeUploadMode}`)
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
  lines.push("| Platform | Signed artifact | Workflow input | Package signing | Store upload |")
  lines.push("| --- | --- | --- | --- | --- |")
  for (const platform of plan.platformPlans) {
    const storeStatus = platform.storeGroups.length ? platform.allSecrets.status : "not-applicable"
    lines.push(`| ${platform.label} | ${platform.artifact} | \`${platform.workflowPlatform}\` | \`${platform.releaseSecrets.status}\` | \`${storeStatus}\` |`)
  }
  lines.push("")
  lines.push("## Missing Package-Signing Secrets")
  lines.push("")
  lines.push(formatList(plan.missingSigningSecrets.map((secret) => `\`${secret}\``)))
  lines.push("")
  lines.push("## Missing Store-Upload Secrets")
  lines.push("")
  lines.push(formatList(plan.missingStoreUploadSecrets.map((secret) => `\`${secret}\``)))
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
    lines.push(`- Missing package-signing secrets: ${platform.releaseSecrets.missing.length ? platform.releaseSecrets.missing.map((secret) => `\`${secret}\``).join(", ") : "none"}`)
    lines.push(`- Missing store-upload secrets: ${platform.storeUploadSecrets.missing.length ? platform.storeUploadSecrets.missing.map((secret) => `\`${secret}\``).join(", ") : "none"}`)
    lines.push("- Artifact-only workflow inputs:")
    for (const [name, value] of Object.entries(platform.artifactWorkflowInputs)) {
      lines.push(`  - \`${name}\`: \`${value}\``)
    }
    if (platform.storeWorkflowInputs) {
      lines.push("- Draft/internal store-upload inputs (only after owner verification):")
      for (const [name, value] of Object.entries(platform.storeWorkflowInputs)) {
        lines.push(`  - \`${name}\`: \`${value}\``)
      }
    }
    if (platform.storePackageArtifact) {
      lines.push(`- Alternative Store package: ${platform.storePackageArtifact}`)
      lines.push(`- Store package workflow: \`${platform.storePackageWorkflow}\``)
      lines.push(`- Required non-secret Partner Center variables: ${platform.storePackageVariables.map((name) => `\`${name}\``).join(", ")}`)
      lines.push("- Microsoft Store AppX builds do not require the Windows EXE signing certificate; exact reserved identity values remain an owner/account gate.")
    }
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
  lines.push("Run artifact-only releases as soon as that platform's signing group is ready. Enable store upload only after the corresponding vendor portal and upload secret group are verified.")
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
