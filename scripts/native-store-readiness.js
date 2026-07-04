#!/usr/bin/env node

const fs = require("fs")
const path = require("path")

const root = path.resolve(__dirname, "..")
const metadataPath = path.join(root, "docs/store-submission/native-store-metadata.json")
const capacitorPath = path.join(root, "capacitor.config.ts")
const desktopPackagePath = path.join(root, "apps/desktop/package.json")
const privacyPolicyPath = path.join(root, "docs/legal/privacy-policy.md")

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8")
}

function readJson(filePath) {
  return JSON.parse(readText(filePath))
}

function fail(message) {
  console.error(`store-readiness: ${message}`)
  process.exitCode = 1
}

function ok(message) {
  console.log(`ok: ${message}`)
}

function getQuotedProperty(source, propertyName) {
  const pattern = new RegExp(`${propertyName}:\\s*["']([^"']+)["']`)
  const match = source.match(pattern)
  return match ? match[1] : null
}

function requireHttpsUrl(metadata, key) {
  const value = metadata.app?.[key]
  if (!value) {
    fail(`missing app.${key}`)
    return
  }

  try {
    const url = new URL(value)
    if (url.protocol !== "https:") {
      fail(`app.${key} must be an https URL`)
      return
    }
    ok(`app.${key} is ${url.href}`)
  } catch {
    fail(`app.${key} is not a valid URL`)
  }
}

function requireEmail(metadata, key) {
  const value = metadata.app?.[key]
  if (!value) {
    fail(`missing app.${key}`)
    return
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    fail(`app.${key} is not a valid email address`)
    return
  }

  ok(`app.${key} is configured`)
}

function main() {
  const metadata = readJson(metadataPath)
  const capacitorConfig = readText(capacitorPath)
  const desktopPackage = readJson(desktopPackagePath)
  const privacyPolicy = readText(privacyPolicyPath)

  const capacitorAppId = getQuotedProperty(capacitorConfig, "appId")
  const capacitorAppName = getQuotedProperty(capacitorConfig, "appName")
  const capacitorServerUrl = capacitorConfig.includes("\"https://siragpt.com\"")
    ? "https://siragpt.com"
    : null
  const desktopAppId = desktopPackage.build?.appId
  const desktopProductName = desktopPackage.build?.productName

  if (metadata.app?.bundleIds?.android !== capacitorAppId) {
    fail(`android package mismatch: metadata=${metadata.app?.bundleIds?.android} capacitor=${capacitorAppId}`)
  } else {
    ok(`android package matches ${capacitorAppId}`)
  }

  if (metadata.app?.bundleIds?.ios !== capacitorAppId) {
    fail(`ios bundle mismatch: metadata=${metadata.app?.bundleIds?.ios} capacitor=${capacitorAppId}`)
  } else {
    ok(`ios bundle matches ${capacitorAppId}`)
  }

  if (metadata.app?.name !== capacitorAppName) {
    fail(`mobile app name mismatch: metadata=${metadata.app?.name} capacitor=${capacitorAppName}`)
  } else {
    ok(`mobile app name matches ${capacitorAppName}`)
  }

  if (metadata.app?.webRuntimeUrl !== capacitorServerUrl) {
    fail(`web runtime URL mismatch: metadata=${metadata.app?.webRuntimeUrl} capacitor=${capacitorServerUrl || "not detected"}`)
  } else {
    ok(`web runtime URL matches ${capacitorServerUrl}`)
  }

  if (metadata.app?.bundleIds?.macos !== desktopAppId) {
    fail(`macos bundle mismatch: metadata=${metadata.app?.bundleIds?.macos} desktop=${desktopAppId}`)
  } else {
    ok(`macos bundle matches ${desktopAppId}`)
  }

  if (metadata.app?.bundleIds?.windows !== desktopAppId) {
    fail(`windows app id mismatch: metadata=${metadata.app?.bundleIds?.windows} desktop=${desktopAppId}`)
  } else {
    ok(`windows app id matches ${desktopAppId}`)
  }

  if (metadata.app?.desktopProductName !== desktopProductName) {
    fail(`desktop product name mismatch: metadata=${metadata.app?.desktopProductName} desktop=${desktopProductName}`)
  } else {
    ok(`desktop product name matches ${desktopProductName}`)
  }

  for (const key of ["marketingUrl", "supportUrl", "privacyPolicyUrl", "termsUrl", "webRuntimeUrl"]) {
    requireHttpsUrl(metadata, key)
  }

  requireEmail(metadata, "supportEmail")

  const shortDescription = metadata.storeCopy?.shortDescription || ""
  if (shortDescription.length === 0 || shortDescription.length > 80) {
    fail(`shortDescription must be 1-80 chars for Google Play; current length=${shortDescription.length}`)
  } else {
    ok(`shortDescription length is ${shortDescription.length}`)
  }

  if (!privacyPolicy.includes("Sira GPT") || !privacyPolicy.includes("Política de Privacidad")) {
    fail("privacy policy file does not look like the published Sira GPT privacy policy")
  } else {
    ok("privacy policy source exists")
  }

  if (metadata.privacyDraft?.tracking !== false) {
    fail("privacyDraft.tracking must be explicit false until tracking is intentionally added and declared")
  } else {
    ok("privacy tracking draft is explicit false")
  }

  if (!Array.isArray(metadata.privacyDraft?.dataTypes) || metadata.privacyDraft.dataTypes.length < 4) {
    fail("privacyDraft.dataTypes is missing expected data declarations")
  } else {
    ok(`privacy draft has ${metadata.privacyDraft.dataTypes.length} data declarations`)
  }

  if (process.exitCode) {
    process.exit(process.exitCode)
  }
}

main()
