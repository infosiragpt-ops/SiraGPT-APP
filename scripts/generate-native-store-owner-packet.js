#!/usr/bin/env node

const childProcess = require("child_process")
const crypto = require("crypto")
const fs = require("fs")
const path = require("path")

const root = path.resolve(__dirname, "..")
const defaultRepo = process.env.GITHUB_REPOSITORY || "infosiragpt-ops/SiraGPT-APP"
const defaultReleaseTag = "native-qa-v0.4.3-0fb0493"

function usage() {
  return `Usage: node scripts/generate-native-store-owner-packet.js [--repo=owner/name] [--secret-source=env|github] [--out-dir=path] [--zip-out=path] [--checksum-out=path] [--source-sha=sha] [--source-commit=text] [--release-tag=tag] [--json] [--skip-zip]

Creates a non-secret native store + owner packet for Android, iPhone, macOS, and Windows.
It includes store-listing assets, platform submission folders, owner handoff,
release plan, a manifest, and optionally a ZIP plus SHA-256 checksum.`
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
    releaseTag: defaultReleaseTag,
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
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (!["env", "github"].includes(args.secretSource)) {
    throw new Error(`Unknown secret source: ${args.secretSource}`)
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
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    packetName: "SiraGPT native store + owner packet",
    repository: args.repo,
    packetSourceSha: sourceSha,
    packetSourceCommit: sourceCommit,
    releaseTag: args.releaseTag,
    releaseUrl: `https://github.com/${args.repo}/releases/tag/${args.releaseTag}`,
    qaBinaryTargetSha: releaseStatus.latestQaRelease?.targetSha,
    latestQaRelease: releaseStatus.latestQaRelease,
    latestVerifiedRuns: releaseStatus.latestVerifiedRuns,
    latestTraceabilityCommit: releaseStatus.latestTraceabilityCommit,
    latestSignedPreflight: releaseStatus.latestSignedPreflight,
    outputDirectory: relative(outDir),
    included: [
      "native-store-submission-packet/",
      "native-store-submission-packet.json",
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
- Latest signed preflight: ${manifest.latestSignedPreflight?.url || "not recorded"}

This ZIP contains public store submission material and owner-action checklists for Android, iPhone, macOS, and Windows. It contains secret names only, not secret values. Do not add passwords, keystores, certificates, provisioning profiles, API private keys, cookies, recovery codes, or app-specific password values to this packet.

## Start Here

1. Open \`native-store-submission-packet/README.md\` for platform listing material.
2. Open \`native-owner-handoff.md\` for owner actions and GitHub secret names.
3. Open \`native-release-plan.md\` for missing signing/upload secret groups.
4. Use \`PACKET-MANIFEST.json\` to verify the packet source SHA and release references.

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
  runNpmScript("native:release:handoff", [
    `--repo=${args.repo}`,
    `--out=${relative(path.join(outDir, "native-owner-handoff.md"))}`,
    `--json-out=${relative(path.join(outDir, "native-owner-handoff.json"))}`,
  ])
  runNpmScript("native:release:plan", [
    `--repo=${args.repo}`,
    `--secret-source=${args.secretSource}`,
    `--out=${relative(path.join(outDir, "native-release-plan.md"))}`,
    `--json-out=${relative(path.join(outDir, "native-release-plan.json"))}`,
  ])

  const releaseStatus = readJson(path.join(root, "docs/store-submission/native-release-status.json"))
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
