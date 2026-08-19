#!/usr/bin/env node

const fs = require("fs")
const path = require("path")

const root = path.resolve(__dirname, "..")
const defaultManifestPath = path.join(root, "docs/store-submission/native-store-assets.json")

function parseArgs(argv) {
  const args = {
    manifest: defaultManifestPath,
    format: "markdown",
    out: "",
    jsonOut: "",
    requireReady: false,
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
    } else if (arg.startsWith("--manifest=")) {
      args.manifest = path.resolve(root, arg.slice("--manifest=".length))
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
  return `Usage: node scripts/native-store-assets-readiness.js [--manifest=path] [--markdown|--json] [--out=path] [--json-out=path] [--require-ready]

Validates public native store assets for Android, iPhone, macOS, and Windows.
The default mode prints a blocked/ready report and exits 0. Use --require-ready
when a release job must fail until every required store asset exists.`
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"))
}

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, contents)
}

function relativePath(filePath) {
  return path.relative(root, filePath).replaceAll(path.sep, "/")
}

function normalizeExtension(filePath) {
  return path.extname(filePath).slice(1).toLowerCase()
}

function listFilesRecursive(directory) {
  if (!fs.existsSync(directory)) return []
  const entries = fs.readdirSync(directory, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(fullPath))
    } else if (entry.isFile()) {
      files.push(fullPath)
    }
  }

  return files
}

function readPngInfo(filePath) {
  const buffer = fs.readFileSync(filePath)
  const signature = "89504e470d0a1a0a"
  if (buffer.length < 26 || buffer.subarray(0, 8).toString("hex") !== signature) {
    throw new Error("invalid PNG signature")
  }

  const colorType = buffer[25]
  let hasTransparencyChunk = false
  let offset = 8
  while (offset + 12 <= buffer.length) {
    const chunkLength = buffer.readUInt32BE(offset)
    const chunkType = buffer.subarray(offset + 4, offset + 8).toString("ascii")
    if (chunkType === "tRNS") hasTransparencyChunk = true
    offset += 12 + chunkLength
    if (chunkType === "IEND") break
  }

  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    hasAlpha: colorType === 4 || colorType === 6 || hasTransparencyChunk,
  }
}

function readJpegInfo(filePath) {
  const buffer = fs.readFileSync(filePath)
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    throw new Error("invalid JPEG signature")
  }

  let offset = 2
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1
      continue
    }

    const marker = buffer[offset + 1]
    const length = buffer.readUInt16BE(offset + 2)
    const isStartOfFrame = [
      0xc0,
      0xc1,
      0xc2,
      0xc3,
      0xc5,
      0xc6,
      0xc7,
      0xc9,
      0xca,
      0xcb,
      0xcd,
      0xce,
      0xcf,
    ].includes(marker)

    if (isStartOfFrame) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
        hasAlpha: false,
      }
    }

    offset += 2 + length
  }

  throw new Error("JPEG dimensions not found")
}

function readImageInfo(filePath, format) {
  if (format === "png") return readPngInfo(filePath)
  if (format === "jpg" || format === "jpeg") return readJpegInfo(filePath)
  return null
}

function validateDimensions(actual, expected) {
  if (!expected || !actual) return []
  const issues = []

  if (Number.isInteger(expected.width) && actual.width !== expected.width) {
    issues.push(`expected width ${expected.width}, got ${actual.width}`)
  }
  if (Number.isInteger(expected.height) && actual.height !== expected.height) {
    issues.push(`expected height ${expected.height}, got ${actual.height}`)
  }
  if (Number.isInteger(expected.minWidth) && actual.width < expected.minWidth) {
    issues.push(`expected width >= ${expected.minWidth}, got ${actual.width}`)
  }
  if (Number.isInteger(expected.minHeight) && actual.height < expected.minHeight) {
    issues.push(`expected height >= ${expected.minHeight}, got ${actual.height}`)
  }
  if (Number.isInteger(expected.maxWidth) && actual.width > expected.maxWidth) {
    issues.push(`expected width <= ${expected.maxWidth}, got ${actual.width}`)
  }
  if (Number.isInteger(expected.maxHeight) && actual.height > expected.maxHeight) {
    issues.push(`expected height <= ${expected.maxHeight}, got ${actual.height}`)
  }
  if (Array.isArray(expected.allowedSizes) && expected.allowedSizes.length > 0) {
    const allowed = expected.allowedSizes.some(
      (size) => size.width === actual.width && size.height === actual.height,
    )
    if (!allowed) {
      issues.push(
        `expected one of ${expected.allowedSizes.map((size) => `${size.width}x${size.height}`).join(", ")}, got ${actual.width}x${actual.height}`,
      )
    }
  }

  return issues
}

function validateAsset(platformKey, asset, required) {
  const filePath = path.resolve(root, asset.path)
  const result = {
    type: "asset",
    platform: platformKey,
    id: asset.id,
    label: asset.label,
    stage: asset.stage || "store-listing",
    required,
    path: relativePath(filePath),
    status: "ready",
    format: asset.format || normalizeExtension(filePath),
    sizeBytes: 0,
    dimensions: null,
    hasAlpha: null,
    issues: [],
  }

  if (!fs.existsSync(filePath)) {
    result.status = required ? "missing" : "optional-missing"
    result.issues.push("file is missing")
    return result
  }

  const stat = fs.statSync(filePath)
  if (!stat.isFile()) {
    result.status = "failed"
    result.issues.push("path is not a file")
    return result
  }

  result.sizeBytes = stat.size
  const expectedFormat = asset.format
  const actualFormat = normalizeExtension(filePath)

  if (expectedFormat && expectedFormat !== actualFormat) {
    result.status = "failed"
    result.issues.push(`expected .${expectedFormat}, got .${actualFormat}`)
  }

  if (Number.isInteger(asset.minBytes) && stat.size < asset.minBytes) {
    result.status = "failed"
    result.issues.push(`expected at least ${asset.minBytes} bytes, got ${stat.size}`)
  }

  try {
    const imageInfo = readImageInfo(filePath, expectedFormat || actualFormat)
    result.dimensions = imageInfo ? { width: imageInfo.width, height: imageInfo.height } : null
    result.hasAlpha = imageInfo?.hasAlpha ?? null
    result.issues.push(...validateDimensions(result.dimensions, asset.dimensions))
    if (asset.allowAlpha === false && result.hasAlpha === true) {
      result.issues.push("alpha/transparency is not allowed")
    }
  } catch (error) {
    if (asset.dimensions || asset.allowAlpha === false) result.issues.push(error.message)
  }

  if (result.issues.length > 0 && result.status === "ready") {
    result.status = "failed"
  }

  return result
}

function validateCollection(platformKey, collection, required) {
  const directory = path.resolve(root, collection.directory)
  const pattern = new RegExp(collection.pattern)
  const files = listFilesRecursive(directory)
    .filter((filePath) => pattern.test(path.relative(directory, filePath).replaceAll(path.sep, "/")))
    .sort()

  const result = {
    type: "collection",
    platform: platformKey,
    id: collection.id,
    label: collection.label,
    stage: collection.stage || "store-listing",
    required,
    directory: relativePath(directory),
    pattern: collection.pattern,
    minCount: collection.minCount || 1,
    count: files.length,
    status: "ready",
    files: [],
    issues: [],
  }

  if (!fs.existsSync(directory)) {
    result.status = required ? "missing" : "optional-missing"
    result.issues.push("directory is missing")
    return result
  }

  if (files.length < result.minCount) {
    result.status = required ? "missing" : "optional-missing"
    result.issues.push(`expected at least ${result.minCount} matching file(s), got ${files.length}`)
  }

  const allowedFormats = new Set(collection.formats || [])
  for (const filePath of files) {
    const format = normalizeExtension(filePath)
    const fileResult = {
      path: relativePath(filePath),
      format,
      sizeBytes: fs.statSync(filePath).size,
      dimensions: null,
      hasAlpha: null,
      issues: [],
    }

    if (allowedFormats.size > 0 && !allowedFormats.has(format)) {
      fileResult.issues.push(`format .${format} is not allowed`)
    }

    try {
      const imageInfo = readImageInfo(filePath, format)
      fileResult.dimensions = imageInfo ? { width: imageInfo.width, height: imageInfo.height } : null
      fileResult.hasAlpha = imageInfo?.hasAlpha ?? null
      fileResult.issues.push(...validateDimensions(fileResult.dimensions, collection.dimensions))
      if (collection.allowAlpha === false && fileResult.hasAlpha === true) {
        fileResult.issues.push("alpha/transparency is not allowed")
      }
    } catch (error) {
      fileResult.issues.push(error.message)
    }

    if (fileResult.issues.length > 0) {
      result.status = "failed"
      result.issues.push(`${fileResult.path}: ${fileResult.issues.join("; ")}`)
    }

    result.files.push(fileResult)
  }

  return result
}

function createReport(manifest) {
  const generatedAt = new Date().toISOString()
  const platformReports = Object.entries(manifest.platforms || {}).map(([platformKey, platform]) => {
    const requiredAssets = (platform.requiredAssets || []).map((asset) => validateAsset(platformKey, asset, true))
    const optionalAssets = (platform.optionalAssets || []).map((asset) => validateAsset(platformKey, asset, false))
    const requiredCollections = (platform.requiredCollections || []).map((collection) => validateCollection(platformKey, collection, true))
    const optionalCollections = (platform.optionalCollections || []).map((collection) => validateCollection(platformKey, collection, false))
    const checks = [
      ...requiredAssets,
      ...optionalAssets,
      ...requiredCollections,
      ...optionalCollections,
    ]
    const requiredChecks = checks.filter((check) => check.required)
    const missing = requiredChecks.filter((check) => check.status === "missing")
    const failed = requiredChecks.filter((check) => check.status === "failed")
    const ready = missing.length === 0 && failed.length === 0

    return {
      key: platformKey,
      label: platform.label || platformKey,
      status: ready ? "ready" : "blocked",
      requiredCount: requiredChecks.length,
      readyCount: requiredChecks.filter((check) => check.status === "ready").length,
      missingCount: missing.length,
      failedCount: failed.length,
      optionalMissingCount: checks.filter((check) => check.status === "optional-missing").length,
      checks,
    }
  })

  const blockedPlatforms = platformReports.filter((platform) => platform.status !== "ready")

  return {
    generatedAt,
    manifestVersion: manifest.version,
    manifestStatus: manifest.status,
    status: blockedPlatforms.length === 0 ? "ready" : "blocked",
    blockedPlatforms: blockedPlatforms.map((platform) => platform.key),
    platformReports,
  }
}

function formatIssues(check) {
  if (!check.issues.length) return "ready"
  return check.issues.join("; ")
}

function renderMarkdown(report) {
  const lines = []
  lines.push("# SiraGPT Native Store Asset Readiness")
  lines.push("")
  lines.push(`Generated: ${report.generatedAt}`)
  lines.push(`Manifest version: \`${report.manifestVersion}\``)
  lines.push(`Manifest status: \`${report.manifestStatus}\``)
  lines.push(`Status: \`${report.status}\``)
  lines.push("")
  lines.push("This report checks public store-listing assets and packaged app icons only. It contains no signing credentials, certificates, keystores, API keys, or passwords.")
  lines.push("")
  lines.push("## Platform Summary")
  lines.push("")
  lines.push("| Platform | Status | Required ready | Missing | Failed | Optional missing |")
  lines.push("| --- | --- | ---: | ---: | ---: | ---: |")
  for (const platform of report.platformReports) {
    lines.push(`| ${platform.label} | \`${platform.status}\` | ${platform.readyCount}/${platform.requiredCount} | ${platform.missingCount} | ${platform.failedCount} | ${platform.optionalMissingCount} |`)
  }
  lines.push("")
  lines.push("## Required Gaps")
  const gaps = report.platformReports.flatMap((platform) => (
    platform.checks
      .filter((check) => check.required && check.status !== "ready")
      .map((check) => `- ${platform.label}: ${check.label} (${check.id}) - ${formatIssues(check)}`)
  ))
  lines.push(gaps.length ? gaps.join("\n") : "- none")
  lines.push("")
  lines.push("## Detail")
  for (const platform of report.platformReports) {
    lines.push("")
    lines.push(`### ${platform.label}`)
    lines.push("")
    lines.push("| Check | Stage | Status | Path / Directory | Notes |")
    lines.push("| --- | --- | --- | --- | --- |")
    for (const check of platform.checks) {
      const target = check.type === "collection" ? `${check.directory}/${check.pattern}` : check.path
      const notes = check.type === "collection"
        ? `${formatIssues(check)}; count=${check.count}/${check.minCount}`
        : formatIssues(check)
      lines.push(`| ${check.label} | ${check.stage} | \`${check.status}\` | \`${target}\` | ${notes} |`)
    }
  }
  lines.push("")
  lines.push("## Next Asset Commands")
  lines.push("")
  lines.push("```bash")
  lines.push("npm run native:store:assets")
  lines.push("npm run native:store:assets -- --require-ready")
  lines.push("```")
  lines.push("")
  return `${lines.join("\n")}\n`
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(usage())
    return
  }

  const manifest = readJson(args.manifest)
  const report = createReport(manifest)
  const json = `${JSON.stringify(report, null, 2)}\n`
  const markdown = renderMarkdown(report)

  if (args.jsonOut) writeFile(path.resolve(root, args.jsonOut), json)
  if (args.out) writeFile(path.resolve(root, args.out), markdown)

  process.stdout.write(args.format === "json" ? json : markdown)

  if (args.requireReady && report.status !== "ready") {
    process.exit(1)
  }
}

try {
  main()
} catch (error) {
  console.error(`native-store-assets-readiness: ${error.message}`)
  process.exit(2)
}
