#!/usr/bin/env node

const childProcess = require("child_process")
const crypto = require("crypto")
const fs = require("fs")
const path = require("path")

const root = path.resolve(__dirname, "..")
const defaultRepo = process.env.GITHUB_REPOSITORY || "infosiragpt-ops/SiraGPT-APP"

function usage() {
  return `Usage: node scripts/generate-native-store-owner-packet.js [--repo=owner/name] [--secret-source=env|github] [--out-dir=path] [--zip-out=path] [--checksum-out=path] [--source-sha=sha] [--source-commit=text] [--release-tag=tag] [--qa-mobile-run=id] [--qa-desktop-run=id] [--qa-ci-run=id] [--json] [--skip-zip]

Creates a non-secret native store + owner packet for Android, iPhone, macOS, and Windows.
It includes store-listing assets, platform submission folders, owner handoff,
release plan, a manifest, and optionally a ZIP plus SHA-256 checksum.
When --release-tag is explicit, its QA binary target is bound to --source-sha.`
}

function parseArgs(argv) {
  const args = {
    repo: defaultRepo,
    secretSource: "env",
    outDir: "",
    zipOut: "",
    checksumOut: "",
    sourceSha: "",
    sourceCommit: "",
    releaseTag: "",
    releaseTagExplicit: false,
    qaMobileRun: "",
    qaDesktopRun: "",
    qaCiRun: "",
    format: "markdown",
    skipZip: false,
    help: false,
  }

  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") {
      args.help = true
    } else if (arg === "--json") {
      args.format = "json"
    } else if (arg === "--skip-zip") {
      args.skipZip = true
    } else if (arg.startsWith("--repo=")) {
      args.repo = arg.slice("--repo=".length)
    } else if (arg.startsWith("--secret-source=")) {
      args.secretSource = arg.slice("--secret-source=".length)
    } else if (arg.startsWith("--out-dir=")) {
      args.outDir = arg.slice("--out-dir=".length)
    } else if (arg.startsWith("--zip-out=")) {
      args.zipOut = arg.slice("--zip-out=".length)
    } else if (arg.startsWith("--checksum-out=")) {
      args.checksumOut = arg.slice("--checksum-out=".length)
    } else if (arg.startsWith("--source-sha=")) {
      args.sourceSha = arg.slice("--source-sha=".length)
    } else if (arg.startsWith("--source-commit=")) {
      args.sourceCommit = arg.slice("--source-commit=".length)
    } else if (arg.startsWith("--release-tag=")) {
      args.releaseTag = arg.slice("--release-tag=".length)
      args.releaseTagExplicit = true
    } else if (arg.startsWith("--qa-mobile-run=")) {
      args.qaMobileRun = arg.slice("--qa-mobile-run=".length)
    } else if (arg.startsWith("--qa-desktop-run=")) {
      args.qaDesktopRun = arg.slice("--qa-desktop-run=".length)
    } else if (arg.startsWith("--qa-ci-run=")) {
      args.qaCiRun = arg.slice("--qa-ci-run=".length)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (!["env", "github"].includes(args.secretSource)) {
    throw new Error(`Unknown secret source: ${args.secretSource}`)
  }
  if (!args.releaseTagExplicit && (args.qaMobileRun || args.qaDesktopRun || args.qaCiRun)) {
    throw new Error("QA workflow run IDs require an explicit --release-tag")
  }

  return args
}

function exec(command, args, options = {}) {
  return childProcess.execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  })
}

function gitValue(args, fallback) {
  try {
    return exec("git", args).trim()
  } catch {
    return fallback
  }
}

function shortSha(sha) {
  return (sha || "unknown").slice(0, 8)
}

function resolveRelative(filePath) {
  return path.resolve(root, filePath)
}

function rm(filePath) {
  fs.rmSync(filePath, { recursive: true, force: true })
}

function mkdir(filePath) {
  fs.mkdirSync(filePath, { recursive: true })
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"))
}

function writeFile(filePath, contents) {
  mkdir(path.dirname(filePath))
  fs.writeFileSync(filePath, contents)
}

function relative(filePath) {
  return path.relative(root, filePath).replaceAll(path.sep, "/")
}

function runNpmScript(scriptName, extraArgs) {
  exec("npm", ["run", scriptName, "--", ...extraArgs], {
    stdio: ["ignore", "pipe", "inherit"],
  })
}

function createManifest({ args, sourceSha, sourceCommit, outDir, releaseStatus }) {
  const qaRelease = args.releaseTagExplicit
    ? {
        tag: args.releaseTag,
        url: `https://github.com/${args.repo}/releases/tag/${args.releaseTag}`,
        targetSha: sourceSha,
        provenance: "explicit-packet-source",
      }
    : releaseStatus.latestQaRelease
  const latestVerifiedRuns = args.releaseTagExplicit
    ? {
        ...(args.qaMobileRun ? { mobile: args.qaMobileRun } : {}),
        ...(args.qaDesktopRun ? { desktop: args.qaDesktopRun } : {}),
        ...(args.qaCiRun ? { ci: args.qaCiRun } : {}),
      }
    : releaseStatus.latestVerifiedRuns
  const latestTraceabilityCommit = args.releaseTagExplicit
    ? {
        sourceSha,
        sha: sourceSha,
        message: sourceCommit || "Explicit QA release provenance",
        note: "The packet release and supplied workflow runs are bound to this exact source SHA.",
      }
    : releaseStatus.latestTraceabilityCommit
  const ownerPacket = !args.releaseTagExplicit && releaseStatus.latestOwnerPacket
    ? {
        sourceSha: releaseStatus.latestOwnerPacket.sourceSha,
        sourceCommit: releaseStatus.latestOwnerPacket.sourceCommit,
        zipName: releaseStatus.latestOwnerPacket.zipName,
        zipUrl: releaseStatus.latestOwnerPacket.zipUrl,
        checksumName: releaseStatus.latestOwnerPacket.checksumName,
        checksumUrl: releaseStatus.latestOwnerPacket.checksumUrl,
        uploadedAt: releaseStatus.latestOwnerPacket.uploadedAt,
      }
    : null

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    packetName: "SiraGPT native store + owner packet",
    repository: args.repo,
    packetSourceSha: sourceSha,
    packetSourceCommit: sourceCommit,
    releaseTag: args.releaseTag,
    releaseUrl: qaRelease?.url || `https://github.com/${args.repo}/releases/tag/${args.releaseTag}`,
    qaBinaryTargetSha: qaRelease?.targetSha || sourceSha,
    latestQaRelease: qaRelease,
    latestVerifiedRuns,
    latestTraceabilityCommit,
    distributionMilestone: releaseStatus.distributionMilestone,
    latestOwnerPacket: ownerPacket,
    latestSignedPreflight: args.releaseTagExplicit ? null : releaseStatus.latestSignedPreflight,
    outputDirectory: relative(outDir),
    included: [
      "native-store-submission-packet/",
      "native-signing-templates/",
      "native-store-submission-packet.json",
      "native-store-metadata-report.md",
      "native-store-metadata-report.json",
      "native-store-assets-report.md",
      "native-store-assets-report.json",
      "native-owner-handoff.md",
      "native-owner-handoff.json",
      "native-release-plan.md",
      "native-release-plan.json",
    ],
    securityBoundary: "This packet contains public listing assets, secret names, and account-owner actions only. It must not contain passwords, keystores, certificates, provisioning profiles, API private keys, cookies, recovery codes, or app-specific password values.",
    status: "owner-action-required",
  }
}

function renderReadme(manifest) {
  return `# SiraGPT Native Store + Owner Packet

Generated: ${manifest.generatedAt}

- Repository: \`${manifest.repository}\`
- Packet source SHA: \`${manifest.packetSourceSha}\`
- QA release: ${manifest.releaseUrl}
- QA binary target SHA: \`${manifest.qaBinaryTargetSha}\`
${manifest.latestOwnerPacket?.zipUrl ? `- Prior recorded owner packet: ${manifest.latestOwnerPacket.zipUrl}` : ""}
${manifest.latestSignedPreflight?.url ? `- Prior recorded signed preflight: ${manifest.latestSignedPreflight.url}` : ""}
- Distribution milestone: ${manifest.distributionMilestone?.url || "not recorded"}

This ZIP contains public store submission material and owner-action checklists for Android, iPhone, macOS, and Windows. It contains secret names only, not secret values. Do not add passwords, keystores, certificates, provisioning profiles, API private keys, cookies, recovery codes, or app-specific password values to this packet.

## Start Here

1. Open \`native-store-metadata-report.md\` for localized copy and public metadata validation.
2. Open \`native-store-submission-packet/README.md\` for platform listing material.
3. Open \`native-owner-handoff.md\` for owner actions and GitHub secret names.
4. Open \`native-release-plan.md\` for missing signing/upload secret groups.
5. Open \`native-signing-templates/all.env.example\` on the trusted owner machine to prepare local signing input variables.
6. Use \`PACKET-MANIFEST.json\` to verify the packet source SHA and release references.

Status: \`${manifest.status}\`
`
}

function assertNoSecretLeak(directory) {
  const forbidden = [
    /BEGIN (RSA|OPENSSH|PRIVATE) KEY/,
    /ghp_[A-Za-z0-9_]+/,
    /github_pat_[A-Za-z0-9_]+/,
    /sk-[A-Za-z0-9_-]{20,}/,
    /xox[baprs]-[A-Za-z0-9-]+/,
    /AKIA[0-9A-Z]{16}/,
  ]

  const stack = [directory]
  while (stack.length) {
    const current = stack.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(fullPath)
      } else if (entry.isFile()) {
        const data = fs.readFileSync(fullPath)
        if (data.includes(0)) continue
        const text = data.toString("utf8")
        const hit = forbidden.find((pattern) => pattern.test(text))
        if (hit) {
          throw new Error(`Generated packet appears to contain secret-like material in ${relative(fullPath)}: ${hit}`)
        }
      }
    }
  }
}

function zipDirectory(outDir, zipOut) {
  const parent = path.dirname(outDir)
  const base = path.basename(outDir)
  rm(zipOut)
  exec("zip", ["-qr", zipOut, base], {
    cwd: parent,
    stdio: ["ignore", "pipe", "inherit"],
  })
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256")
  hash.update(fs.readFileSync(filePath))
  return hash.digest("hex")
}

function generateSigningTemplate({ args, outDir, platform, format, name }) {
  exec("node", [
    "scripts/generate-native-github-secrets-template.js",
    `--repo=${args.repo}`,
    `--platform=${platform}`,
    `--format=${format}`,
    `--out=${relative(path.join(outDir, "native-signing-templates", name))}`,
  ], {
    stdio: ["ignore", "pipe", "inherit"],
  })
}

function generateSigningTemplates({ args, outDir }) {
  const templates = [
    ["all", "env", "all.env.example"],
    ["all", "markdown", "README.md"],
    ["mobile", "env", "mobile.env.example"],
    ["desktop", "env", "desktop.env.example"],
    ["android", "env", "android.env.example"],
    ["ios", "env", "ios.env.example"],
    ["macos", "env", "macos.env.example"],
    ["windows", "env", "windows.env.example"],
  ]

  for (const [platform, format, name] of templates) {
    generateSigningTemplate({ args, outDir, platform, format, name })
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(usage())
    return
  }

  const sourceSha = args.sourceSha || process.env.GITHUB_SHA || gitValue(["rev-parse", "HEAD"], "unknown")
  const sourceCommit = args.sourceCommit || gitValue(["show", "-s", "--format=%s", sourceSha], "")
  const slug = shortSha(sourceSha)
  const outDir = resolveRelative(args.outDir || `output/native-store-owner-packet-${slug}`)
  const zipOut = resolveRelative(args.zipOut || `output/SiraGPT-native-store-owner-packet-${slug}.zip`)
  const checksumOut = resolveRelative(args.checksumOut || `${zipOut}.sha256`)

  rm(outDir)
  mkdir(outDir)

  runNpmScript("native:store:readiness", [
    `--out=${relative(path.join(outDir, "native-store-metadata-report.md"))}`,
    `--json-out=${relative(path.join(outDir, "native-store-metadata-report.json"))}`,
  ])
  runNpmScript("native:store:assets", [
    "--require-ready",
    `--out=${relative(path.join(outDir, "native-store-assets-report.md"))}`,
    `--json-out=${relative(path.join(outDir, "native-store-assets-report.json"))}`,
  ])
  runNpmScript("native:store:packet", [
    "--require-ready",
    `--out-dir=${relative(path.join(outDir, "native-store-submission-packet"))}`,
    `--json-out=${relative(path.join(outDir, "native-store-submission-packet.json"))}`,
  ])
  const handoffArgs = [
    `--repo=${args.repo}`,
    `--out=${relative(path.join(outDir, "native-owner-handoff.md"))}`,
    `--json-out=${relative(path.join(outDir, "native-owner-handoff.json"))}`,
  ]
  if (args.releaseTagExplicit) {
    handoffArgs.push(
      `--qa-release-tag=${args.releaseTag}`,
      `--qa-source-sha=${sourceSha}`,
    )
    if (args.qaMobileRun) handoffArgs.push(`--qa-mobile-run=${args.qaMobileRun}`)
    if (args.qaDesktopRun) handoffArgs.push(`--qa-desktop-run=${args.qaDesktopRun}`)
    if (args.qaCiRun) handoffArgs.push(`--qa-ci-run=${args.qaCiRun}`)
  }
  runNpmScript("native:release:handoff", handoffArgs)
  runNpmScript("native:release:plan", [
    `--repo=${args.repo}`,
    `--secret-source=${args.secretSource}`,
    `--out=${relative(path.join(outDir, "native-release-plan.md"))}`,
    `--json-out=${relative(path.join(outDir, "native-release-plan.json"))}`,
  ])
  generateSigningTemplates({ args, outDir })

  const releaseStatus = readJson(path.join(root, "docs/store-submission/native-release-status.json"))
  args.releaseTag = args.releaseTag || releaseStatus.latestQaRelease?.tag || "native-qa-unset"
  const manifest = createManifest({ args, sourceSha, sourceCommit, outDir, releaseStatus })
  writeFile(path.join(outDir, "PACKET-MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`)
  writeFile(path.join(outDir, "README.md"), renderReadme(manifest))

  assertNoSecretLeak(outDir)

  const result = {
    ...manifest,
    zipPath: args.skipZip ? "" : relative(zipOut),
    checksumPath: args.skipZip ? "" : relative(checksumOut),
    checksumSha256: "",
  }

  if (!args.skipZip) {
    zipDirectory(outDir, zipOut)
    const checksum = sha256File(zipOut)
    writeFile(checksumOut, `${checksum}  ${path.basename(zipOut)}\n`)
    result.checksumSha256 = checksum
  }

  process.stdout.write(args.format === "json"
    ? `${JSON.stringify(result, null, 2)}\n`
    : `native-store-owner-packet: ${relative(outDir)}\n${args.skipZip ? "" : `native-store-owner-packet-zip: ${relative(zipOut)}\nnative-store-owner-packet-sha256: ${result.checksumSha256}\n`}`)
}

try {
  main()
} catch (error) {
  console.error(`native-store-owner-packet: ${error.message}`)
  process.exit(1)
}
