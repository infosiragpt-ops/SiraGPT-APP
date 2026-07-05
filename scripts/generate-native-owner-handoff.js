#!/usr/bin/env node

const fs = require("fs")
const path = require("path")

const root = path.resolve(__dirname, "..")
const metadataPath = path.join(root, "docs/store-submission/native-store-metadata.json")
const statusPath = path.join(root, "docs/store-submission/native-release-status.json")
const defaultOut = "output/native-owner-handoff.md"
const defaultJsonOut = "output/native-owner-handoff.json"

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

const platforms = {
  android: {
    label: "Android / Google Play",
    metadataKey: "android",
    setupPlatform: "android",
    workflowPlatform: "android",
    releaseGroups: ["android"],
    uploadGroups: ["googleplay"],
    firstWorkflow: "Native signed release packages with platform=android, upload_android_google_play=true, android_play_track=qa, android_release_status=draft",
    ownerSummary: "Complete Google Play account verification, create the Play service account, and provide the Android upload key material.",
  },
  ios: {
    label: "iPhone / App Store Connect",
    metadataKey: "ios",
    setupPlatform: "ios",
    workflowPlatform: "ios",
    releaseGroups: ["ios"],
    uploadGroups: ["appstore"],
    firstWorkflow: "Native signed release packages with platform=ios and upload_ios_app_store_connect=true only when App Store Connect upload is approved",
    ownerSummary: "Complete Apple Developer/App Store Connect setup and provide iOS distribution signing assets plus API key material.",
  },
  macos: {
    label: "macOS",
    metadataKey: "macos",
    setupPlatform: "macos",
    workflowPlatform: "macos",
    releaseGroups: ["macos"],
    uploadGroups: [],
    firstWorkflow: "Native signed release packages with platform=macos and create_github_release=true",
    ownerSummary: "Provide Developer ID Application certificate and notarization credentials for public macOS distribution.",
  },
  windows: {
    label: "Windows",
    metadataKey: "windows",
    setupPlatform: "windows",
    workflowPlatform: "windows",
    releaseGroups: ["windows"],
    uploadGroups: [],
    firstWorkflow: "Native signed release packages with platform=windows and create_github_release=true",
    ownerSummary: "Provide a Windows code-signing certificate for public installer trust.",
  },
}

const aliases = {
  all: ["android", "ios", "macos", "windows"],
  mobile: ["android", "ios"],
  desktop: ["macos", "windows"],
  apple: ["ios", "macos"],
}

function usage() {
  return `Usage: node scripts/generate-native-owner-handoff.js [--repo=owner/name] [--platform=all|mobile|desktop|android|ios|macos|windows] [--out=path] [--json-out=path] [--json]

Generates a non-secret handoff packet for the account owner who must finish
store verification, signing credentials, and native release approval.`
}

function parseArgs(argv) {
  const args = {
    repo: "",
    platform: "all",
    out: defaultOut,
    jsonOut: defaultJsonOut,
    format: "markdown",
    help: false,
  }

  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") {
      args.help = true
    } else if (arg === "--json") {
      args.format = "json"
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

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"))
}

function unique(items) {
  return [...new Set(items)]
}

function expandPlatforms(value) {
  const requested = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
  const expanded = requested.length ? requested.flatMap((item) => aliases[item] || [item]) : aliases.all
  const unknown = expanded.filter((item) => !platforms[item])
  if (unknown.length) throw new Error(`Unknown platform: ${unknown.join(", ")}`)
  return unique(expanded)
}

function secretsForGroups(groups) {
  return unique(groups.flatMap((group) => secretGroups[group] || []))
}

function list(items) {
  if (!items.length) return "- none"
  return items.map((item) => `- ${item}`).join("\n")
}

function codeList(items) {
  return list(items.map((item) => `\`${item}\``))
}

function buildHandoff({ repo, selectedPlatforms, metadata, status }) {
  const actualRepo = repo || status.repo || "infosiragpt-ops/SiraGPT-APP"
  const platformPlans = selectedPlatforms.map((key) => {
    const platform = platforms[key]
    const metadataPlatform = metadata.platforms?.[platform.metadataKey] || {}
    const releaseSecrets = secretsForGroups(platform.releaseGroups)
    const uploadSecrets = secretsForGroups(platform.uploadGroups)
    const allSecrets = unique([...releaseSecrets, ...uploadSecrets])

    return {
      key,
      label: platform.label,
      ownerSummary: platform.ownerSummary,
      workflowPlatform: platform.workflowPlatform,
      setupPlatform: platform.setupPlatform,
      firstWorkflow: platform.firstWorkflow,
      accountActions: metadataPlatform.requiredAccountActions || [],
      releaseSecrets,
      uploadSecrets,
      allSecrets,
      dryRunCommand: `npm run native:github-secrets:setup -- --repo=${actualRepo} --platform=${platform.setupPlatform} --dry-run`,
      setupCommand: `npm run native:github-secrets:setup -- --repo=${actualRepo} --platform=${platform.setupPlatform}`,
      readinessCommand: `npm run native:readiness -- --require=${unique([...platform.releaseGroups, ...platform.uploadGroups]).join(",")} --only-required`,
    }
  })

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status: "owner-action-required",
    repo: actualRepo,
    trackerUrl: status.distributionTrackerUrl,
    app: {
      name: metadata.app?.name,
      supportEmail: metadata.app?.supportEmail,
      runtimeUrl: metadata.app?.webRuntimeUrl,
      privacyPolicyUrl: metadata.app?.privacyPolicyUrl,
      bundleIds: metadata.app?.bundleIds,
      category: metadata.app?.category,
    },
    latestQaRelease: status.latestQaRelease,
    latestVerifiedRuns: status.latestVerifiedRuns,
    latestQaArtifactManifestRuns: status.latestQaArtifactManifestRuns,
    latestTraceabilityCommit: status.latestTraceabilityCommit,
    latestActionsDiagnostics: status.latestActionsDiagnostics,
    latestSignedPreflight: status.latestSignedPreflight,
    latestSecretAudit: status.latestSecretAudit,
    platformPlans,
    forbiddenMaterials: [
      "normal email account password",
      "raw account password pasted into GitHub",
      "keystore/certificate/provisioning profile committed to Git",
      "API private key committed to Git",
      "screenshots or logs that expose session cookies or private tokens",
    ],
  }
}

function renderMarkdown(handoff) {
  const lines = []
  lines.push("# SiraGPT Native Store Owner Handoff")
  lines.push("")
  lines.push(`Generated: ${handoff.generatedAt}`)
  lines.push(`Status: \`${handoff.status}\``)
  lines.push(`Repository: \`${handoff.repo}\``)
  lines.push(`Tracker: ${handoff.trackerUrl}`)
  lines.push("")
  lines.push("This packet contains secret names and owner actions only. It must not contain passwords, certificates, keystores, provisioning profiles, API private keys, cookies, or recovery codes.")
  lines.push("")
  lines.push("## Current App Identity")
  lines.push("")
  lines.push(`- App name: \`${handoff.app.name}\``)
  lines.push(`- Runtime URL: \`${handoff.app.runtimeUrl}\``)
  lines.push(`- Support email: \`${handoff.app.supportEmail}\``)
  lines.push(`- Privacy policy: \`${handoff.app.privacyPolicyUrl}\``)
  lines.push(`- Android package: \`${handoff.app.bundleIds?.android}\``)
  lines.push(`- iOS bundle ID: \`${handoff.app.bundleIds?.ios}\``)
  lines.push(`- macOS bundle ID: \`${handoff.app.bundleIds?.macos}\``)
  lines.push(`- Windows app ID: \`${handoff.app.bundleIds?.windows}\``)
  lines.push("")
  lines.push("## Latest QA Download")
  lines.push("")
  lines.push(`- Release: \`${handoff.latestQaRelease.tag}\``)
  lines.push(`- URL: ${handoff.latestQaRelease.url}`)
  lines.push(`- Target SHA: \`${handoff.latestQaRelease.targetSha}\``)
  lines.push(`- Assets: ${handoff.latestQaRelease.assetCount}`)
  lines.push("")
  lines.push("Verified workflow runs:")
  lines.push("")
  lines.push(`- Mobile: \`${handoff.latestVerifiedRuns.mobile}\``)
  lines.push(`- Desktop: \`${handoff.latestVerifiedRuns.desktop}\``)
  lines.push(`- Readiness: \`${handoff.latestVerifiedRuns.readiness}\``)
  lines.push(`- CI: \`${handoff.latestVerifiedRuns.ci}\``)
  if (handoff.latestVerifiedRuns.docker) {
    lines.push(`- Docker: \`${handoff.latestVerifiedRuns.docker}\``)
  }
  lines.push("")
  if (handoff.latestQaArtifactManifestRuns?.status) {
    lines.push("## Latest QA Artifact Manifest Verification")
    lines.push("")
    lines.push(`- Checked: \`${handoff.latestQaArtifactManifestRuns.checkedAt}\``)
    lines.push(`- Source SHA: \`${handoff.latestQaArtifactManifestRuns.sourceSha}\``)
    lines.push(`- Mobile run: \`${handoff.latestQaArtifactManifestRuns.mobileRun}\``)
    lines.push(`- Desktop run: \`${handoff.latestQaArtifactManifestRuns.desktopRun}\``)
    lines.push(`- Status: \`${handoff.latestQaArtifactManifestRuns.status}\``)
    if (handoff.latestQaArtifactManifestRuns.diagnosis) {
      lines.push(`- Diagnosis: ${handoff.latestQaArtifactManifestRuns.diagnosis}`)
    }
    if (handoff.latestQaArtifactManifestRuns.platformArtifacts) {
      lines.push("")
      lines.push("Verified artifact files:")
      lines.push("")
      for (const [platform, files] of Object.entries(handoff.latestQaArtifactManifestRuns.platformArtifacts)) {
        lines.push(`- ${platform}: ${files.map((file) => `\`${file}\``).join(", ")}`)
      }
    }
    lines.push("")
  }
  if (handoff.latestTraceabilityCommit?.sha) {
    lines.push("## Latest Repository Validation")
    lines.push("")
    lines.push(`- SHA: \`${handoff.latestTraceabilityCommit.sha}\``)
    if (handoff.latestTraceabilityCommit.message) {
      lines.push(`- Commit: \`${handoff.latestTraceabilityCommit.message}\``)
    }
    lines.push("- Status: all current native, CI, and Docker workflows are green.")
    lines.push("")
  }
  if (handoff.latestActionsDiagnostics?.actionsEnabled !== undefined) {
    lines.push("## Latest GitHub Actions Diagnostics")
    lines.push("")
    lines.push(`- Checked: \`${handoff.latestActionsDiagnostics.checkedAt}\``)
    lines.push(`- Repository visibility: \`${handoff.latestActionsDiagnostics.repoVisibility}\``)
    lines.push(`- Private repository: \`${handoff.latestActionsDiagnostics.isPrivate}\``)
    lines.push(`- Actions enabled: \`${handoff.latestActionsDiagnostics.actionsEnabled}\``)
    lines.push(`- Allowed actions: \`${handoff.latestActionsDiagnostics.allowedActions}\``)
    lines.push(`- CI run: \`${handoff.latestActionsDiagnostics.ciRun}\``)
    lines.push(`- Native readiness run: \`${handoff.latestActionsDiagnostics.readinessRun}\``)
    if (handoff.latestActionsDiagnostics.officialBillingDocs) {
      lines.push(`- GitHub billing docs: ${handoff.latestActionsDiagnostics.officialBillingDocs}`)
    }
    if (handoff.latestActionsDiagnostics.diagnosis) {
      lines.push(`- Diagnosis: ${handoff.latestActionsDiagnostics.diagnosis}`)
    }
    lines.push("")
  }
  if (handoff.latestSignedPreflight?.run) {
    lines.push("## Latest Signed Release Preflight")
    lines.push("")
    lines.push(`- Run: \`${handoff.latestSignedPreflight.run}\``)
    lines.push(`- URL: ${handoff.latestSignedPreflight.url}`)
    lines.push(`- Status: \`${handoff.latestSignedPreflight.status}\``)
    lines.push(`- Platform: \`${handoff.latestSignedPreflight.platform}\``)
    lines.push(`- Release tag: \`${handoff.latestSignedPreflight.releaseTag}\``)
    if (handoff.latestSignedPreflight.notes) {
      lines.push(`- Notes: ${handoff.latestSignedPreflight.notes}`)
    }
    lines.push("")
  }
  if (handoff.latestSecretAudit?.status) {
    lines.push("## Latest Secret-Name Audit")
    lines.push("")
    lines.push(`- Checked: \`${handoff.latestSecretAudit.checkedAt}\``)
    lines.push(`- Status: \`${handoff.latestSecretAudit.status}\``)
    if (handoff.latestSecretAudit.diagnosis) {
      lines.push(`- Diagnosis: ${handoff.latestSecretAudit.diagnosis}`)
    }
    lines.push(`- Command: \`${handoff.latestSecretAudit.command}\``)
    lines.push("")
  }
  lines.push("## Security Boundary")
  lines.push("")
  lines.push("Do not use the normal mailbox password as native signing material. Native distribution requires dedicated store credentials, upload keys, certificates, provisioning profiles, API keys, and app-specific passwords stored only in vendor portals or GitHub Actions secrets.")
  lines.push("")
  lines.push("Never provide or commit:")
  lines.push("")
  lines.push(list(handoff.forbiddenMaterials))
  lines.push("")
  lines.push("## Platform Owner Actions")
  for (const platform of handoff.platformPlans) {
    lines.push("")
    lines.push(`### ${platform.label}`)
    lines.push("")
    lines.push(platform.ownerSummary)
    lines.push("")
    lines.push("Account/store actions:")
    lines.push("")
    lines.push(list(platform.accountActions))
    lines.push("")
    lines.push("GitHub Actions secrets to configure:")
    lines.push("")
    lines.push(codeList(platform.allSecrets))
    lines.push("")
    lines.push("Safe local dry-run:")
    lines.push("")
    lines.push("```bash")
    lines.push(platform.dryRunCommand)
    lines.push("```")
    lines.push("")
    lines.push("Upload secrets only from a trusted machine after setting the matching environment variables or file path variables:")
    lines.push("")
    lines.push("```bash")
    lines.push(platform.setupCommand)
    lines.push("```")
    lines.push("")
    lines.push("Readiness gate after secrets are added:")
    lines.push("")
    lines.push("```bash")
    lines.push(platform.readinessCommand)
    lines.push("```")
    lines.push("")
    lines.push(`First signed workflow target: ${platform.firstWorkflow}`)
  }
  lines.push("")
  lines.push("## Final Gates")
  lines.push("")
  lines.push("```bash")
  lines.push("npm run native:store:readiness")
  lines.push("npm run native:store:assets -- --require-ready")
  lines.push("npm run native:store:packet -- --require-ready")
  lines.push("npm run native:github-secrets:check")
  lines.push("npm run native:readiness:all")
  lines.push("```")
  lines.push("")
  lines.push("Run `Native signed release packages` only after the owner confirms the selected platform, release tag, upload target, and whether binaries should be transmitted to Google Play or App Store Connect.")
  lines.push("")
  return `${lines.join("\n")}\n`
}

function assertNoSecretLeak(text) {
  const forbidden = [
    /BEGIN (RSA|OPENSSH|PRIVATE) KEY/,
    /ghp_[A-Za-z0-9_]+/,
    /sk-[A-Za-z0-9_-]{20,}/,
    /xox[baprs]-[A-Za-z0-9-]+/,
  ]
  const hit = forbidden.find((pattern) => pattern.test(text))
  if (hit) throw new Error(`Generated handoff appears to contain secret-like material: ${hit}`)
}

function writeFile(filePath, contents) {
  const absolutePath = path.resolve(root, filePath)
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
  fs.writeFileSync(absolutePath, contents)
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(usage())
    return
  }

  const selectedPlatforms = expandPlatforms(args.platform)
  const metadata = readJson(metadataPath)
  const status = readJson(statusPath)
  const handoff = buildHandoff({
    repo: args.repo,
    selectedPlatforms,
    metadata,
    status,
  })

  const json = `${JSON.stringify(handoff, null, 2)}\n`
  const markdown = renderMarkdown(handoff)
  assertNoSecretLeak(json)
  assertNoSecretLeak(markdown)

  if (args.jsonOut) writeFile(args.jsonOut, json)
  if (args.out) writeFile(args.out, markdown)
  process.stdout.write(args.format === "json" ? json : markdown)
}

try {
  main()
} catch (error) {
  console.error(`generate-native-owner-handoff: ${error.message}`)
  process.exit(1)
}
