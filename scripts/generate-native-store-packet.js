#!/usr/bin/env node

const fs = require("fs")
const path = require("path")

const root = path.resolve(__dirname, "..")
const metadataPath = path.join(root, "docs/store-submission/native-store-metadata.json")
const assetsPath = path.join(root, "docs/store-submission/native-store-assets.json")
const defaultOutDir = "output/native-store-submission-packet"
const defaultJsonOut = "output/native-store-submission-packet.json"

function parseArgs(argv) {
  const args = {
    outDir: defaultOutDir,
    jsonOut: defaultJsonOut,
    requireReady: false,
  }

  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") {
      args.help = true
    } else if (arg === "--require-ready") {
      args.requireReady = true
    } else if (arg.startsWith("--out-dir=")) {
      args.outDir = arg.slice("--out-dir=".length)
    } else if (arg.startsWith("--json-out=")) {
      args.jsonOut = arg.slice("--json-out=".length)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return args
}

function usage() {
  return `Usage: node scripts/generate-native-store-packet.js [--out-dir=path] [--json-out=path] [--require-ready]

Creates a non-secret native store submission packet for Android, iPhone, macOS,
and Windows. It copies public listing assets and writes platform-specific text,
metadata, privacy, and account-action checklists.`
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"))
}

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, contents)
}

function copyFile(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.copyFileSync(source, destination)
}

function removeDir(directory) {
  fs.rmSync(directory, { recursive: true, force: true })
}

function rel(filePath) {
  return path.relative(root, filePath).replaceAll(path.sep, "/")
}

function getMatchingFiles(directory, pattern) {
  const absoluteDir = path.resolve(root, directory)
  if (!fs.existsSync(absoluteDir)) return []
  const matcher = new RegExp(pattern)
  return fs.readdirSync(absoluteDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && matcher.test(entry.name))
    .map((entry) => path.join(absoluteDir, entry.name))
    .sort()
}

function collectAssetsForPlatform(platformKey, assetsManifest) {
  const platform = assetsManifest.platforms?.[platformKey]
  if (!platform) throw new Error(`Missing asset manifest platform: ${platformKey}`)

  const files = []
  const missing = []

  for (const asset of platform.requiredAssets || []) {
    const absolutePath = path.resolve(root, asset.path)
    if (fs.existsSync(absolutePath)) {
      files.push({ id: asset.id, label: asset.label, path: absolutePath, stage: asset.stage || "store-listing" })
    } else {
      missing.push(`${asset.label}: ${asset.path}`)
    }
  }

  for (const collection of platform.requiredCollections || []) {
    const matches = getMatchingFiles(collection.directory, collection.pattern)
    if (matches.length < (collection.minCount || 1)) {
      missing.push(`${collection.label}: expected ${collection.minCount || 1}, found ${matches.length}`)
    }
    for (const match of matches) {
      files.push({ id: collection.id, label: collection.label, path: match, stage: collection.stage || "store-listing" })
    }
  }

  return { files, missing }
}

function copyAssets(files, destinationDir) {
  const copied = []
  for (const file of files) {
    const destination = path.join(destinationDir, path.basename(file.path))
    copyFile(file.path, destination)
    copied.push({
      id: file.id,
      label: file.label,
      source: rel(file.path),
      packetPath: rel(destination),
      stage: file.stage,
    })
  }
  return copied
}

function list(items) {
  if (!items.length) return "- none"
  return items.map((item) => `- ${item}`).join("\n")
}

function renderDataSafety(metadata) {
  const privacy = metadata.privacyDraft
  const lines = []
  lines.push("# Privacy And Data Declaration Draft")
  lines.push("")
  lines.push(`Tracking: ${privacy.tracking ? "yes" : "no"}`)
  lines.push(`Third-party advertising: ${privacy.thirdPartyAdvertising ? "yes" : "no"}`)
  lines.push(`Encryption in transit: ${privacy.encryptionInTransit ? "yes" : "no"}`)
  lines.push(`Account deletion / privacy request URL: ${privacy.accountDeletionRequest}`)
  lines.push("")
  lines.push("## Declared Data Types")
  lines.push("")
  for (const dataType of privacy.dataTypes || []) {
    lines.push(`### ${dataType.name}`)
    lines.push("")
    lines.push(`- Collected: ${dataType.collected ? "yes" : "no"}`)
    lines.push(`- Linked to user: ${dataType.linkedToUser ? "yes" : "no"}`)
    lines.push(`- Purposes: ${(dataType.purposes || []).join(", ")}`)
    lines.push("")
  }
  lines.push("Review this draft against the final production SDK/provider list before submitting to any store.")
  lines.push("")
  return lines.join("\n")
}

function getLocalizationEntries(metadata) {
  const copy = metadata.storeCopy || {}
  const expectedKeys = [
    metadata.app?.primaryLanguage,
    ...(metadata.app?.additionalLanguages || []),
  ].filter(Boolean)

  return expectedKeys.map((localeKey) => {
    const value = copy.localizations?.[localeKey]
    if (!value) throw new Error(`Missing store copy localization: ${localeKey}`)
    return { localeKey, value, primary: localeKey === copy.defaultLocale }
  })
}

function baseListing(metadata, platformKey, localization, storeLocaleKey = platformKey) {
  const app = metadata.app
  const copy = localization.value
  const storeLocale = copy.storeLocales?.[storeLocaleKey]
  if (!storeLocale) {
    throw new Error(`Missing ${storeLocaleKey} store locale for ${localization.localeKey}`)
  }

  return {
    localeKey: localization.localeKey,
    storeLocale,
    primary: localization.primary,
    appName: copy.appName,
    desktopProductName: app.desktopProductName,
    platform: platformKey,
    category: app.category,
    primaryLanguage: app.primaryLanguage,
    additionalLanguages: app.additionalLanguages,
    supportEmail: app.supportEmail,
    supportUrl: app.supportUrl,
    marketingUrl: app.marketingUrl,
    privacyPolicyUrl: app.privacyPolicyUrl,
    termsUrl: app.termsUrl,
    runtimeUrl: app.webRuntimeUrl,
    subtitle: copy.subtitle,
    shortDescription: copy.shortDescription,
    fullDescription: copy.fullDescription,
    promotionalText: copy.promotionalText,
    releaseNotes: copy.releaseNotes,
    keywords: copy.keywords,
    features: copy.features,
  }
}

function platformAccountActions(metadata, platformKey) {
  return metadata.platforms?.[platformKey]?.requiredAccountActions || []
}

function renderPlatformMarkdown(title, listing, localizations, assets, actions, extraLines = []) {
  const lines = []
  lines.push(`# ${title}`)
  lines.push("")
  lines.push("This packet is non-secret. Do not add passwords, certificates, keystores, provisioning profiles, API keys, or app-specific passwords here.")
  lines.push("")
  lines.push("## Listing Copy")
  lines.push("")
  lines.push(`- App name: ${listing.appName}`)
  if (listing.subtitle) lines.push(`- Subtitle: ${listing.subtitle}`)
  lines.push(`- Primary locale: ${listing.storeLocale}`)
  lines.push(`- Available locales: ${localizations.map((item) => item.storeLocale).join(", ")}`)
  lines.push(`- Category: ${listing.category}`)
  lines.push(`- Support URL: ${listing.supportUrl}`)
  lines.push(`- Privacy policy: ${listing.privacyPolicyUrl}`)
  lines.push(`- Terms: ${listing.termsUrl}`)
  lines.push(`- Support email: ${listing.supportEmail}`)
  lines.push("")
  lines.push("Short description:")
  lines.push("")
  lines.push(listing.shortDescription)
  lines.push("")
  lines.push("Full description:")
  lines.push("")
  lines.push(listing.fullDescription)
  lines.push("")
  lines.push("Keywords:")
  lines.push("")
  lines.push(list((listing.keywords || []).map((keyword) => `\`${keyword}\``)))
  lines.push("")
  lines.push("## Assets")
  lines.push("")
  lines.push(list(assets.map((asset) => `${asset.label}: \`${asset.packetPath}\``)))
  lines.push("")
  lines.push("## Account / Store Actions")
  lines.push("")
  lines.push(list(actions))
  if (extraLines.length) {
    lines.push("")
    lines.push(...extraLines)
  }
  lines.push("")
  return lines.join("\n")
}

function writeTextBundle(baseDir, files) {
  for (const [name, value] of Object.entries(files)) {
    writeFile(path.join(baseDir, name), `${value.trim()}\n`)
  }
}

function createAndroidPacket(metadata, assetsManifest, outDir) {
  const localizations = getLocalizationEntries(metadata).map((localization) => ({
    ...baseListing(metadata, "android", localization, "googlePlay"),
    packageName: metadata.platforms.android.packageName,
    trackFirstTarget: metadata.platforms.android.trackFirstTarget,
    binaryType: metadata.platforms.android.binaryType,
  }))
  const listing = localizations.find((item) => item.primary) || localizations[0]
  const { files, missing } = collectAssetsForPlatform("android", assetsManifest)
  const platformDir = path.join(outDir, "google-play")
  const copiedAssets = copyAssets(files, path.join(platformDir, "assets"))
  const actions = platformAccountActions(metadata, "android")

  for (const localizedListing of localizations) {
    writeTextBundle(path.join(platformDir, localizedListing.storeLocale), {
      "title.txt": localizedListing.appName,
      "short-description.txt": localizedListing.shortDescription,
      "full-description.txt": localizedListing.fullDescription,
      "release-notes.txt": localizedListing.releaseNotes,
    })
  }
  writeFile(path.join(platformDir, "data-safety.md"), renderDataSafety(metadata))
  writeFile(path.join(platformDir, "listing.json"), `${JSON.stringify({ listing, localizations, actions, assets: copiedAssets }, null, 2)}\n`)
  writeFile(
    path.join(platformDir, "README.md"),
    renderPlatformMarkdown("Google Play Submission Packet", listing, localizations, copiedAssets, actions, [
      "## Binary",
      "",
      `- Expected binary type: \`${listing.binaryType}\``,
      `- First target track: \`${listing.trackFirstTarget}\``,
      `- Package name: \`${listing.packageName}\``,
    ]),
  )

  return {
    platform: "android",
    packetPath: rel(platformDir),
    status: missing.length ? "blocked" : "ready",
    missing,
    locales: localizations.map((item) => item.storeLocale),
    assets: copiedAssets,
  }
}

function createIosPacket(metadata, assetsManifest, outDir) {
  const localizations = getLocalizationEntries(metadata).map((localization) => ({
    ...baseListing(metadata, "ios", localization, "appStoreConnect"),
    bundleId: metadata.platforms.ios.bundleId,
    binaryType: metadata.platforms.ios.binaryType,
  }))
  const listing = localizations.find((item) => item.primary) || localizations[0]
  const { files, missing } = collectAssetsForPlatform("ios", assetsManifest)
  const platformDir = path.join(outDir, "app-store-connect")
  const copiedAssets = copyAssets(files, path.join(platformDir, "assets"))
  const actions = platformAccountActions(metadata, "ios")

  for (const localizedListing of localizations) {
    writeTextBundle(path.join(platformDir, localizedListing.storeLocale), {
      "name.txt": localizedListing.appName,
      "subtitle.txt": localizedListing.subtitle,
      "keywords.txt": localizedListing.keywords.join(","),
      "description.txt": localizedListing.fullDescription,
      "promotional-text.txt": localizedListing.promotionalText,
      "release-notes.txt": localizedListing.releaseNotes,
      "support-url.txt": localizedListing.supportUrl,
      "privacy-policy-url.txt": localizedListing.privacyPolicyUrl,
    })
  }
  writeFile(path.join(platformDir, "app-privacy.md"), renderDataSafety(metadata))
  writeFile(path.join(platformDir, "listing.json"), `${JSON.stringify({ listing, localizations, actions, assets: copiedAssets }, null, 2)}\n`)
  writeFile(
    path.join(platformDir, "README.md"),
    renderPlatformMarkdown("App Store Connect Submission Packet", listing, localizations, copiedAssets, actions, [
      "## Binary",
      "",
      `- Expected binary type: \`${listing.binaryType}\``,
      `- Bundle ID: \`${listing.bundleId}\``,
    ]),
  )

  return {
    platform: "ios",
    packetPath: rel(platformDir),
    status: missing.length ? "blocked" : "ready",
    missing,
    locales: localizations.map((item) => item.storeLocale),
    assets: copiedAssets,
  }
}

function createMacosPacket(metadata, assetsManifest, outDir) {
  const localizations = getLocalizationEntries(metadata).map((localization) => ({
    ...baseListing(metadata, "macos", localization, "macos"),
    bundleId: metadata.platforms.macos.bundleId,
    distribution: metadata.platforms.macos.distribution,
  }))
  const listing = localizations.find((item) => item.primary) || localizations[0]
  const { files, missing } = collectAssetsForPlatform("macos", assetsManifest)
  const platformDir = path.join(outDir, "macos")
  const copiedAssets = copyAssets(files, path.join(platformDir, "assets"))
  const actions = platformAccountActions(metadata, "macos")

  for (const localizedListing of localizations) {
    writeTextBundle(path.join(platformDir, localizedListing.storeLocale), {
      "name.txt": localizedListing.appName,
      "subtitle.txt": localizedListing.subtitle,
      "description.txt": localizedListing.fullDescription,
      "release-notes.txt": localizedListing.releaseNotes,
      "support-url.txt": localizedListing.supportUrl,
      "privacy-policy-url.txt": localizedListing.privacyPolicyUrl,
    })
  }
  writeFile(path.join(platformDir, "listing.json"), `${JSON.stringify({ listing, localizations, actions, assets: copiedAssets }, null, 2)}\n`)
  writeFile(
    path.join(platformDir, "README.md"),
    renderPlatformMarkdown("macOS Distribution Packet", listing, localizations, copiedAssets, actions, [
      "## Distribution",
      "",
      `- Bundle ID: \`${listing.bundleId}\``,
      `- Distribution target: ${listing.distribution}`,
      "- This packet does not prove notarization. The signed DMG/ZIP must still pass Gatekeeper validation after Developer ID signing and Apple notarization.",
    ]),
  )

  return {
    platform: "macos",
    packetPath: rel(platformDir),
    status: missing.length ? "blocked" : "ready",
    missing,
    locales: localizations.map((item) => item.storeLocale),
    assets: copiedAssets,
  }
}

function createWindowsPacket(metadata, assetsManifest, outDir) {
  const localizations = getLocalizationEntries(metadata).map((localization) => ({
    ...baseListing(metadata, "windows", localization, "microsoftStore"),
    appId: metadata.platforms.windows.appId,
    distribution: metadata.platforms.windows.distribution,
  }))
  const listing = localizations.find((item) => item.primary) || localizations[0]
  const { files, missing } = collectAssetsForPlatform("windows", assetsManifest)
  const platformDir = path.join(outDir, "windows")
  const copiedAssets = copyAssets(files, path.join(platformDir, "assets"))
  const actions = platformAccountActions(metadata, "windows")

  for (const localizedListing of localizations) {
    writeTextBundle(path.join(platformDir, localizedListing.storeLocale), {
      "name.txt": localizedListing.appName,
      "short-description.txt": localizedListing.shortDescription,
      "description.txt": localizedListing.fullDescription,
      "features.txt": localizedListing.features.join("\n"),
      "release-notes.txt": localizedListing.releaseNotes,
      "support-url.txt": localizedListing.supportUrl,
      "privacy-policy-url.txt": localizedListing.privacyPolicyUrl,
    })
  }
  writeFile(path.join(platformDir, "listing.json"), `${JSON.stringify({ listing, localizations, actions, assets: copiedAssets }, null, 2)}\n`)
  writeFile(
    path.join(platformDir, "README.md"),
    renderPlatformMarkdown("Windows Distribution Packet", listing, localizations, copiedAssets, actions, [
      "## Distribution",
      "",
      `- App ID: \`${listing.appId}\``,
      `- Distribution target: ${listing.distribution}`,
      "- This packet does not prove SmartScreen trust. The installer and portable EXE still need a Windows code-signing certificate.",
    ]),
  )

  return {
    platform: "windows",
    packetPath: rel(platformDir),
    status: missing.length ? "blocked" : "ready",
    missing,
    locales: localizations.map((item) => item.storeLocale),
    assets: copiedAssets,
  }
}

function renderIndex(metadata, summary) {
  const lines = []
  lines.push("# SiraGPT Native Store Submission Packet")
  lines.push("")
  lines.push(`Generated: ${summary.generatedAt}`)
  lines.push(`Status: \`${summary.status}\``)
  lines.push("")
  lines.push("This directory contains only public submission material. It must never contain passwords, certificates, keystores, provisioning profiles, API keys, app-specific passwords, or account recovery information.")
  lines.push("")
  lines.push("## Native Identity")
  lines.push("")
  lines.push(`- App name: \`${metadata.app.name}\``)
  lines.push(`- Support email: \`${metadata.app.supportEmail}\``)
  lines.push(`- Runtime URL: \`${metadata.app.webRuntimeUrl}\``)
  lines.push(`- Android package: \`${metadata.app.bundleIds.android}\``)
  lines.push(`- iOS bundle ID: \`${metadata.app.bundleIds.ios}\``)
  lines.push(`- macOS bundle ID: \`${metadata.app.bundleIds.macos}\``)
  lines.push(`- Windows app ID: \`${metadata.app.bundleIds.windows}\``)
  lines.push("")
  lines.push("## Platform Packets")
  lines.push("")
  lines.push("| Platform | Status | Packet |")
  lines.push("| --- | --- | --- |")
  for (const platform of summary.platforms) {
    lines.push(`| ${platform.platform} | \`${platform.status}\` | \`${platform.packetPath}\` |`)
  }
  lines.push("")
  lines.push("## Remaining External Gates")
  lines.push("")
  lines.push("The submission packet does not replace account-owner actions or signing credentials. Signed distribution still requires Google Play verification/upload key, Apple Developer certificates/profiles/App Store Connect keys, Apple notarization credentials, and Windows code-signing credentials.")
  lines.push("")
  return lines.join("\n")
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(usage())
    return
  }

  const metadata = readJson(metadataPath)
  const assetsManifest = readJson(assetsPath)
  const outDir = path.resolve(root, args.outDir)
  const generatedAt = new Date().toISOString()

  removeDir(outDir)
  fs.mkdirSync(outDir, { recursive: true })

  const platforms = [
    createAndroidPacket(metadata, assetsManifest, outDir),
    createIosPacket(metadata, assetsManifest, outDir),
    createMacosPacket(metadata, assetsManifest, outDir),
    createWindowsPacket(metadata, assetsManifest, outDir),
  ]
  const blocked = platforms.filter((platform) => platform.status !== "ready")
  const summary = {
    generatedAt,
    status: blocked.length ? "blocked" : "ready",
    app: {
      name: metadata.app.name,
      supportEmail: metadata.app.supportEmail,
      webRuntimeUrl: metadata.app.webRuntimeUrl,
      bundleIds: metadata.app.bundleIds,
      defaultLocale: metadata.storeCopy.defaultLocale,
      locales: Object.keys(metadata.storeCopy.localizations || {}),
    },
    outputDirectory: rel(outDir),
    platforms,
  }

  writeFile(
    path.join(outDir, "review-access.json"),
    `${JSON.stringify(metadata.reviewAccess, null, 2)}\n`,
  )
  writeFile(
    path.join(outDir, "submission-questionnaires.json"),
    `${JSON.stringify(metadata.submissionQuestionnaires, null, 2)}\n`,
  )
  writeFile(path.join(outDir, "README.md"), renderIndex(metadata, summary))
  writeFile(path.resolve(root, args.jsonOut), `${JSON.stringify(summary, null, 2)}\n`)

  console.log(`native-store-packet: ${summary.status}`)
  console.log(`native-store-packet: wrote ${rel(outDir)}`)

  if (args.requireReady && summary.status !== "ready") {
    process.exit(1)
  }
}

try {
  main()
} catch (error) {
  console.error(`native-store-packet: ${error.message}`)
  process.exit(2)
}
