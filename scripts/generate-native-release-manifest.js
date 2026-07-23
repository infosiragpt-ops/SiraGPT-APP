#!/usr/bin/env node

const crypto = require("crypto")
const fs = require("fs")
const path = require("path")

const root = path.resolve(__dirname, "..")
const packageJsonPath = path.join(root, "package.json")
const metadataPath = path.join(root, "docs/store-submission/native-store-metadata.json")
const generatedNames = new Set([
  "native-release-manifest.json",
  "native-release-manifest.md",
  "SHA256SUMS.txt",
])

function usage() {
  return `Usage: node scripts/generate-native-release-manifest.js --dir=output/native-release [--out=path] [--markdown-out=path] [--checksums-out=path] [--release-tag=tag] [--git-sha=sha]

Generates a non-secret manifest and SHA256SUMS file for native release artifacts.`
}

function parseArgs(argv) {
  const args = {
    dir: "",
    out: "",
    markdownOut: "",
    checksumsOut: "",
    releaseTag: process.env.RELEASE_TAG || "",
    gitSha: process.env.GITHUB_SHA || "",
    help: false,
  }

  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") {
      args.help = true
    } else if (arg.startsWith("--dir=")) {
      args.dir = arg.slice("--dir=".length)
    } else if (arg.startsWith("--out=")) {
      args.out = arg.slice("--out=".length)
    } else if (arg.startsWith("--markdown-out=")) {
      args.markdownOut = arg.slice("--markdown-out=".length)
    } else if (arg.startsWith("--checksums-out=")) {
      args.checksumsOut = arg.slice("--checksums-out=".length)
    } else if (arg.startsWith("--release-tag=")) {
      args.releaseTag = arg.slice("--release-tag=".length)
    } else if (arg.startsWith("--git-sha=")) {
      args.gitSha = arg.slice("--git-sha=".length)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return args
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"))
}

function listFiles(dir) {
  const files = []

  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolutePath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        walk(absolutePath)
      } else if (entry.isFile() && !generatedNames.has(entry.name)) {
        files.push(absolutePath)
      }
    }
  }

  walk(dir)
  return files.sort((a, b) => a.localeCompare(b))
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256")
  hash.update(fs.readFileSync(filePath))
  return hash.digest("hex")
}

function classifyArtifact(relativePath) {
  const normalized = relativePath.replaceAll(path.sep, "/").toLowerCase()
  const extension = path.extname(normalized)
  const fileName = path.basename(normalized)
  const isUnder = (directory) => normalized.startsWith(`${directory}/`) || normalized.includes(`/${directory}/`)
  const isIosSimulatorZip = extension === ".zip"
    && /(?:^|[-_.])(?:ios[-_.].*simulator|simulator[-_.].*ios)(?:[-_.]|$)/.test(path.basename(normalized))
  const isDebugApk = extension === ".apk"
    && (isUnder("debug") || /(?:^|[-_.])debug(?:[-_.]|$)/.test(path.basename(normalized)))

  if (fileName === "android-upload-certificate-blocker.json") {
    return {
      platform: "android",
      kind: "play-upload-blocker-evidence",
    }
  }

  if (fileName === "android-upload-certificate-status.json") {
    return {
      platform: "android",
      kind: "play-upload-certificate-evidence",
    }
  }

  if (fileName.endsWith("-ios-device-build.json")) {
    return {
      platform: "ios",
      kind: "ios-device-build-evidence",
    }
  }

  if (extension === ".blockmap") {
    return {
      platform: isUnder("macos") ? "macos" : isUnder("windows") ? "windows" : "desktop",
      kind: "update-blockmap",
    }
  }

  if (isUnder("android") || extension === ".aab" || extension === ".apk") {
    return {
      platform: "android",
      kind: extension === ".aab"
        ? "play-aab"
        : extension === ".apk"
          ? (isDebugApk ? "debug-apk" : "release-apk")
          : "android-release-metadata",
    }
  }

  if (isUnder("ios") || extension === ".ipa" || isIosSimulatorZip) {
    return {
      platform: "ios",
      kind: extension === ".ipa"
        ? "app-store-ipa"
        : normalized.includes("simulator")
          ? "simulator-app-zip"
          : "ios-artifact",
    }
  }

  if (isUnder("macos") || extension === ".dmg" || normalized.endsWith("-mac.zip")) {
    return {
      platform: "macos",
      kind: extension === ".dmg" ? "dmg" : "zip",
    }
  }

  if (
    isUnder("windows")
    || extension === ".exe"
    || extension === ".appx"
    || fileName === "windows-store-package.json"
  ) {
    return {
      platform: "windows",
      kind: extension === ".appx"
        ? "microsoft-store-appx"
        : fileName === "windows-store-package.json"
          ? "microsoft-store-package-metadata"
          : normalized.includes("portable")
            ? "portable-exe"
            : "installer-exe",
    }
  }

  return {
    platform: "unknown",
    kind: extension ? extension.slice(1) : "artifact",
  }
}

function buildManifest(args) {
  const artifactsDir = path.resolve(root, args.dir)
  if (!fs.existsSync(artifactsDir) || !fs.statSync(artifactsDir).isDirectory()) {
    throw new Error(`Artifact directory not found: ${artifactsDir}`)
  }

  const artifactPaths = listFiles(artifactsDir)
  if (artifactPaths.length === 0) {
    throw new Error(`No release artifacts found in ${artifactsDir}`)
  }

  const packageJson = readJson(packageJsonPath)
  const metadata = readJson(metadataPath)
  const artifacts = artifactPaths.map((artifactPath) => {
    const relativePath = path.relative(artifactsDir, artifactPath).replaceAll(path.sep, "/")
    const stat = fs.statSync(artifactPath)
    const classification = classifyArtifact(relativePath)

    return {
      path: relativePath,
      fileName: path.basename(artifactPath),
      platform: classification.platform,
      kind: classification.kind,
      bytes: stat.size,
      sha256: sha256File(artifactPath),
    }
  })

  const platformCounts = artifacts.reduce((counts, artifact) => {
    counts[artifact.platform] = (counts[artifact.platform] || 0) + 1
    return counts
  }, {})

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    releaseTag: args.releaseTag || null,
    gitSha: args.gitSha || null,
    app: {
      name: metadata.app?.name || "Sira GPT",
      version: packageJson.version,
      runtimeUrl: metadata.app?.webRuntimeUrl || "https://siragpt.com",
      bundleIds: metadata.app?.bundleIds || {},
    },
    summary: {
      artifactCount: artifacts.length,
      totalBytes: artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0),
      platformCounts,
    },
    artifacts,
  }
}

function renderMarkdown(manifest) {
  const lines = []
  lines.push(`# SiraGPT Native Release ${manifest.releaseTag || ""}`.trim())
  lines.push("")
  lines.push(`Generated: ${manifest.generatedAt}`)
  lines.push(`Git SHA: \`${manifest.gitSha || "unknown"}\``)
  lines.push(`App version: \`${manifest.app.version}\``)
  lines.push(`Runtime URL: \`${manifest.app.runtimeUrl}\``)
  lines.push("")
  lines.push("This release manifest contains artifact names, sizes, platforms, and SHA-256 checksums only. It contains no signing secrets, certificates, keystores, provisioning profiles, API keys, or passwords.")
  lines.push("")
  lines.push("## Artifacts")
  lines.push("")
  lines.push("| Platform | Kind | File | Size | SHA-256 |")
  lines.push("| --- | --- | --- | ---: | --- |")
  for (const artifact of manifest.artifacts) {
    lines.push(`| ${artifact.platform} | ${artifact.kind} | \`${artifact.path}\` | ${artifact.bytes} | \`${artifact.sha256}\` |`)
  }
  lines.push("")
  lines.push("## Platform Counts")
  lines.push("")
  for (const [platform, count] of Object.entries(manifest.summary.platformCounts).sort()) {
    lines.push(`- ${platform}: ${count}`)
  }
  lines.push("")
  return `${lines.join("\n")}\n`
}

function renderChecksums(manifest) {
  const fileNames = new Set()
  const lines = manifest.artifacts.map((artifact) => {
    if (fileNames.has(artifact.fileName)) {
      throw new Error(`Duplicate release asset file name: ${artifact.fileName}`)
    }
    fileNames.add(artifact.fileName)
    return `${artifact.sha256}  ${artifact.fileName}`
  })

  return `${lines.join("\n")}\n`
}

function writeIfRequested(filePath, contents) {
  if (!filePath) return
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
  if (!args.dir) throw new Error("--dir is required")

  const manifest = buildManifest(args)
  const json = `${JSON.stringify(manifest, null, 2)}\n`
  const markdown = renderMarkdown(manifest)
  const checksums = renderChecksums(manifest)

  writeIfRequested(args.out, json)
  writeIfRequested(args.markdownOut, markdown)
  writeIfRequested(args.checksumsOut, checksums)

  process.stdout.write(json)
}

try {
  main()
} catch (error) {
  console.error(`generate-native-release-manifest: ${error.message}`)
  process.exit(1)
}
