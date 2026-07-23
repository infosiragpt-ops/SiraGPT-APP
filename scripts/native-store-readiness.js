#!/usr/bin/env node

const fs = require("fs")
const path = require("path")

const root = path.resolve(__dirname, "..")
const metadataPath = path.join(root, "docs/store-submission/native-store-metadata.json")
const capacitorPath = path.join(root, "capacitor.config.ts")
const desktopPackagePath = path.join(root, "apps/desktop/package.json")
const privacyPolicyPath = path.join(root, "docs/legal/privacy-policy.md")
const iosInfoPlistPath = path.join(root, "ios/App/App/Info.plist")
const iosPrivacyManifestPath = path.join(root, "ios/App/App/PrivacyInfo.xcprivacy")
const iosProjectPath = path.join(root, "ios/App/App.xcodeproj/project.pbxproj")
const androidManifestPath = path.join(root, "android/app/src/main/AndroidManifest.xml")
const androidDebugManifestPath = path.join(root, "android/app/src/debug/AndroidManifest.xml")
const windowsAppxAssetsPath = path.join(root, "apps/desktop/assets/appx")

const STORE_LOCALE_KEYS = ["googlePlay", "appStoreConnect", "microsoftStore", "macos"]
const PLACEHOLDER_PATTERN = /\b(todo|tbd|lorem ipsum|placeholder|replace me)\b/i
const FORBIDDEN_SECRET_KEY_PATTERN = /(password|passphrase|private.?key|secret.?value|certificate.?base64|keystore.?base64)/i

function parseArgs(argv) {
  const args = {
    format: "markdown",
    out: "",
    jsonOut: "",
    checkUrls: false,
  }

  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") {
      args.help = true
    } else if (arg === "--json") {
      args.format = "json"
    } else if (arg === "--markdown") {
      args.format = "markdown"
    } else if (arg === "--check-urls") {
      args.checkUrls = true
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
  return `Usage: node scripts/native-store-readiness.js [--markdown|--json] [--out=path] [--json-out=path] [--check-urls]

Validates native identities, localized store copy, public policy URLs, privacy
declarations, and the non-secret owner-account boundary. --check-urls performs
live HTTP checks against the public SiraGPT pages.`
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8")
}

function readJson(filePath) {
  return JSON.parse(readText(filePath))
}

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, contents)
}

function getQuotedProperty(source, propertyName) {
  const pattern = new RegExp(`${propertyName}:\\s*["']([^"']+)["']`)
  const match = source.match(pattern)
  return match ? match[1] : null
}

function characterCount(value) {
  return Array.from(value || "").length
}

function plainTextIssues(value, { min = 1, max, field }) {
  const issues = []
  const length = characterCount(value)

  if (typeof value !== "string" || length < min) {
    issues.push(`${field} must contain at least ${min} character(s)`)
  }
  if (Number.isInteger(max) && length > max) {
    issues.push(`${field} exceeds ${max} characters (got ${length})`)
  }
  if (typeof value === "string" && /<[^>]+>/.test(value)) {
    issues.push(`${field} must be plain text without HTML`)
  }
  if (typeof value === "string" && PLACEHOLDER_PATTERN.test(value)) {
    issues.push(`${field} contains placeholder text`)
  }

  return issues
}

function findForbiddenSecretKeys(value, prefix = "") {
  if (!value || typeof value !== "object") return []
  const matches = []

  for (const [key, child] of Object.entries(value)) {
    const fullKey = prefix ? `${prefix}.${key}` : key
    if (FORBIDDEN_SECRET_KEY_PATTERN.test(key)) matches.push(fullKey)
    matches.push(...findForbiddenSecretKeys(child, fullKey))
  }

  return matches
}

function readPngDimensions(filePath) {
  const source = fs.readFileSync(filePath)
  const pngSignature = "89504e470d0a1a0a"
  if (source.length < 24 || source.subarray(0, 8).toString("hex") !== pngSignature) {
    throw new Error(`${path.relative(root, filePath)} is not a valid PNG file`)
  }
  return {
    width: source.readUInt32BE(16),
    height: source.readUInt32BE(20),
  }
}

function createReporter() {
  const checks = []

  function add(id, category, ok, message, details = {}) {
    checks.push({
      id,
      category,
      status: ok ? "ready" : "failed",
      message,
      ...details,
    })
  }

  return { checks, add }
}

function validateHttpsUrl(reporter, metadata, key) {
  const value = metadata.app?.[key]
  let url

  try {
    url = new URL(value)
  } catch {
    reporter.add(`url-${key}`, "public-urls", false, `app.${key} is not a valid URL`)
    return null
  }

  const valid = url.protocol === "https:" && !url.username && !url.password
  reporter.add(
    `url-${key}`,
    "public-urls",
    valid,
    valid ? `app.${key} uses HTTPS` : `app.${key} must be an HTTPS URL without embedded credentials`,
    { url: url.href },
  )
  return valid ? url : null
}

function validateIdentity(reporter, metadata) {
  const capacitorConfig = readText(capacitorPath)
  const desktopPackage = readJson(desktopPackagePath)
  const capacitorAppId = getQuotedProperty(capacitorConfig, "appId")
  const capacitorAppName = getQuotedProperty(capacitorConfig, "appName")
  const capacitorServerUrl = capacitorConfig.match(
    /const serverUrl\s*=\s*process\.env\.CAPACITOR_SERVER_URL\?\.trim\(\)\s*\|\|\s*["']([^"']+)["']/,
  )?.[1] || null
  const desktopAppId = desktopPackage.build?.appId
  const desktopProductName = desktopPackage.build?.productName

  const comparisons = [
    ["identity-android", "Android package", metadata.app?.bundleIds?.android, capacitorAppId],
    ["identity-ios", "iOS bundle", metadata.app?.bundleIds?.ios, capacitorAppId],
    ["identity-mobile-name", "Mobile app name", metadata.app?.name, capacitorAppName],
    ["identity-runtime", "Web runtime URL", metadata.app?.webRuntimeUrl, capacitorServerUrl],
    ["identity-macos", "macOS bundle", metadata.app?.bundleIds?.macos, desktopAppId],
    ["identity-windows", "Windows app ID", metadata.app?.bundleIds?.windows, desktopAppId],
    ["identity-desktop-name", "Desktop product name", metadata.app?.desktopProductName, desktopProductName],
  ]

  for (const [id, label, expected, actual] of comparisons) {
    reporter.add(
      id,
      "native-identity",
      Boolean(expected) && expected === actual,
      expected === actual ? `${label} matches ${actual}` : `${label} mismatch: metadata=${expected || "missing"} native=${actual || "missing"}`,
      { expected: expected || null, actual: actual || null },
    )
  }
}

function validateLocalization(reporter, metadata, localeKey, localization) {
  const prefix = `locale-${localeKey}`
  const fields = [
    ["appName", 2, 30],
    ["subtitle", 1, 30],
    ["shortDescription", 1, 80],
    ["fullDescription", 120, 4000],
    ["promotionalText", 1, 170],
    ["releaseNotes", 1, 500],
  ]

  for (const [field, min, max] of fields) {
    const issues = plainTextIssues(localization?.[field], { field: `${localeKey}.${field}`, min, max })
    reporter.add(
      `${prefix}-${field}`,
      "localized-copy",
      issues.length === 0,
      issues.length ? issues.join("; ") : `${localeKey}.${field} satisfies store limits`,
      { locale: localeKey, length: characterCount(localization?.[field]), max },
    )
  }

  const keywords = localization?.keywords
  const keywordIssues = []
  if (!Array.isArray(keywords) || keywords.length === 0 || keywords.length > 7) {
    keywordIssues.push("keywords must contain 1-7 unique terms")
  } else {
    const normalized = keywords.map((keyword) => String(keyword).trim().toLocaleLowerCase())
    if (new Set(normalized).size !== normalized.length) keywordIssues.push("keywords must be unique")
    if (keywords.some((keyword) => characterCount(String(keyword).trim()) < 3)) {
      keywordIssues.push("each keyword must contain at least 3 characters")
    }
    if (keywords.some((keyword) => String(keyword).toLocaleLowerCase().includes("sira gpt"))) {
      keywordIssues.push("keywords must not duplicate the app name")
    }
    const appleKeywordBytes = Buffer.byteLength(keywords.join(","), "utf8")
    if (appleKeywordBytes > 100) keywordIssues.push(`Apple keyword list exceeds 100 bytes (got ${appleKeywordBytes})`)
  }
  reporter.add(
    `${prefix}-keywords`,
    "localized-copy",
    keywordIssues.length === 0,
    keywordIssues.length ? keywordIssues.join("; ") : `${localeKey}.keywords satisfies Apple and Microsoft limits`,
    {
      locale: localeKey,
      count: Array.isArray(keywords) ? keywords.length : 0,
      appleBytes: Array.isArray(keywords) ? Buffer.byteLength(keywords.join(","), "utf8") : 0,
    },
  )

  const features = localization?.features
  const featureIssues = []
  if (!Array.isArray(features) || features.length === 0 || features.length > 20) {
    featureIssues.push("features must contain 1-20 items")
  } else {
    features.forEach((feature, index) => {
      featureIssues.push(...plainTextIssues(feature, {
        field: `${localeKey}.features[${index}]`,
        min: 1,
        max: 200,
      }))
    })
  }
  reporter.add(
    `${prefix}-features`,
    "localized-copy",
    featureIssues.length === 0,
    featureIssues.length ? featureIssues.join("; ") : `${localeKey}.features satisfies Microsoft Store limits`,
    { locale: localeKey, count: Array.isArray(features) ? features.length : 0 },
  )

  const storeLocales = localization?.storeLocales
  for (const storeKey of STORE_LOCALE_KEYS) {
    const value = storeLocales?.[storeKey]
    const valid = typeof value === "string" && /^[a-z]{2,3}(?:-[A-Z0-9]{2,4})?$/.test(value)
    reporter.add(
      `${prefix}-store-locale-${storeKey}`,
      "localized-copy",
      valid,
      valid ? `${localeKey} maps to ${storeKey}:${value}` : `${localeKey}.storeLocales.${storeKey} is missing or invalid`,
      { locale: localeKey, store: storeKey, value: value || null },
    )
  }
}

function validateLocalizations(reporter, metadata) {
  const copy = metadata.storeCopy || {}
  const localizations = copy.localizations || {}
  const expectedLocales = [
    metadata.app?.primaryLanguage,
    ...(metadata.app?.additionalLanguages || []),
  ].filter(Boolean)
  const actualLocales = Object.keys(localizations)
  const defaultLocale = copy.defaultLocale

  reporter.add(
    "locale-default",
    "localized-copy",
    Boolean(defaultLocale) && defaultLocale === metadata.app?.primaryLanguage && Boolean(localizations[defaultLocale]),
    defaultLocale === metadata.app?.primaryLanguage && localizations[defaultLocale]
      ? `Default locale ${defaultLocale} matches the primary language`
      : "storeCopy.defaultLocale must match app.primaryLanguage and have copy",
    { defaultLocale: defaultLocale || null, primaryLanguage: metadata.app?.primaryLanguage || null },
  )

  const localeSetMatches = expectedLocales.length === actualLocales.length
    && expectedLocales.every((locale) => actualLocales.includes(locale))
  reporter.add(
    "locale-coverage",
    "localized-copy",
    localeSetMatches,
    localeSetMatches
      ? `Localized copy covers ${expectedLocales.join(", ")}`
      : `Localized copy mismatch: expected ${expectedLocales.join(", ") || "none"}, got ${actualLocales.join(", ") || "none"}`,
    { expectedLocales, actualLocales },
  )

  for (const localeKey of expectedLocales) {
    if (localizations[localeKey]) validateLocalization(reporter, metadata, localeKey, localizations[localeKey])
  }

  for (const storeKey of STORE_LOCALE_KEYS) {
    const values = expectedLocales
      .map((localeKey) => localizations[localeKey]?.storeLocales?.[storeKey])
      .filter(Boolean)
    reporter.add(
      `locale-unique-${storeKey}`,
      "localized-copy",
      values.length === expectedLocales.length && new Set(values).size === values.length,
      values.length === expectedLocales.length && new Set(values).size === values.length
        ? `${storeKey} locale mappings are unique`
        : `${storeKey} locale mappings must be present and unique`,
      { values },
    )
  }
}

function validatePrivacyAndOwnerBoundary(reporter, metadata) {
  const privacyPolicy = readText(privacyPolicyPath)
  const supportEmail = metadata.app?.supportEmail || ""

  reporter.add(
    "support-email",
    "public-urls",
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(supportEmail),
    "Support email is configured",
    { email: supportEmail || null },
  )
  reporter.add(
    "privacy-source",
    "privacy",
    privacyPolicy.includes("Sira GPT") && privacyPolicy.includes("Política de Privacidad"),
    "Privacy policy source is present",
  )
  reporter.add(
    "privacy-tracking",
    "privacy",
    metadata.privacyDraft?.tracking === false,
    "Tracking declaration is explicit false",
  )
  reporter.add(
    "privacy-advertising",
    "privacy",
    metadata.privacyDraft?.thirdPartyAdvertising === false,
    "Third-party advertising declaration is explicit false",
  )
  reporter.add(
    "privacy-data-types",
    "privacy",
    Array.isArray(metadata.privacyDraft?.dataTypes) && metadata.privacyDraft.dataTypes.length >= 5,
    `Privacy draft declares ${metadata.privacyDraft?.dataTypes?.length || 0} data type(s)`,
  )

  const forbiddenKeys = findForbiddenSecretKeys(metadata)
  reporter.add(
    "owner-no-secret-values",
    "owner-security",
    forbiddenKeys.length === 0,
    forbiddenKeys.length
      ? `Metadata contains forbidden secret-value fields: ${forbiddenKeys.join(", ")}`
      : "Metadata contains no password, private-key, certificate, or secret-value fields",
  )
  reporter.add(
    "owner-password-rotation",
    "owner-security",
    metadata.ownerAccount?.status === "rotation-required-before-store-use",
    "Owner mailbox is explicitly marked for password rotation and MFA before store use",
  )
  reporter.add(
    "owner-platform-actions",
    "owner-security",
    Array.isArray(metadata.ownerAccount?.storePortals) && metadata.ownerAccount.storePortals.length === 4,
    `Owner handoff covers ${metadata.ownerAccount?.storePortals?.length || 0} platform portal(s)`,
  )

  const reviewAccess = metadata.reviewAccess
  const reviewAccessReady = reviewAccess?.requiresAuthentication === true
    && reviewAccess?.status === "owner-action-required"
    && reviewAccess?.credentialStorage === "vendor-console-only"
    && typeof reviewAccess?.instructions === "string"
    && reviewAccess.instructions.length >= 80
    && Array.isArray(reviewAccess?.requiredOwnerOutputs)
    && reviewAccess.requiredOwnerOutputs.length >= 4
    && Array.isArray(reviewAccess?.prohibitedLocations)
    && reviewAccess.prohibitedLocations.length >= 4
  reporter.add(
    "review-access-boundary",
    "owner-security",
    reviewAccessReady,
    reviewAccessReady
      ? "Reviewer access is documented as a vendor-console-only owner action"
      : "Reviewer access must define non-secret instructions and vendor-console-only credential storage",
  )

  const questionnaires = metadata.submissionQuestionnaires
  const questionnairesReady = questionnaires?.status === "owner-review-required"
    && typeof questionnaires?.answeringRule === "string"
    && questionnaires.answeringRule.length >= 100
    && Array.isArray(questionnaires?.googlePlay)
    && questionnaires.googlePlay.length >= 4
    && Array.isArray(questionnaires?.appStoreConnect)
    && questionnaires.appStoreConnect.length >= 4
    && Array.isArray(questionnaires?.microsoftPartnerCenter)
    && questionnaires.microsoftPartnerCenter.length >= 3
  reporter.add(
    "submission-questionnaires",
    "store-questionnaires",
    questionnairesReady,
    questionnairesReady
      ? "Vendor questionnaires are enumerated and explicitly require owner review against production"
      : "Store questionnaire handoff is incomplete",
  )
}

function hasPlistUsageDescription(source, key) {
  const pattern = new RegExp(
    `<key>${key}</key>\\s*<string>([^<]{12,})</string>`,
  )
  return pattern.test(source)
}

function validateNativePrivacyAndSecurity(reporter) {
  const iosInfoPlist = readText(iosInfoPlistPath)
  const iosPrivacyManifest = readText(iosPrivacyManifestPath)
  const iosProject = readText(iosProjectPath)
  const androidManifest = readText(androidManifestPath)
  const androidDebugManifest = readText(androidDebugManifestPath)

  const iosUsageDescriptions = [
    "NSCameraUsageDescription",
    "NSMicrophoneUsageDescription",
    "NSPhotoLibraryUsageDescription",
  ]
  const missingUsageDescriptions = iosUsageDescriptions.filter(
    (key) => !hasPlistUsageDescription(iosInfoPlist, key),
  )
  reporter.add(
    "ios-usage-descriptions",
    "native-privacy-security",
    missingUsageDescriptions.length === 0,
    missingUsageDescriptions.length === 0
      ? "iOS camera, microphone, and photo-library usage descriptions are explicit"
      : `iOS usage descriptions missing or too short: ${missingUsageDescriptions.join(", ")}`,
  )

  const requiredCollectedDataTypes = [
    "NSPrivacyCollectedDataTypeEmailAddress",
    "NSPrivacyCollectedDataTypeUserID",
    "NSPrivacyCollectedDataTypeOtherUserContent",
    "NSPrivacyCollectedDataTypePhotosorVideos",
    "NSPrivacyCollectedDataTypeAudioData",
    "NSPrivacyCollectedDataTypePurchaseHistory",
    "NSPrivacyCollectedDataTypeProductInteraction",
    "NSPrivacyCollectedDataTypeCrashData",
    "NSPrivacyCollectedDataTypePerformanceData",
    "NSPrivacyCollectedDataTypeOtherDiagnosticData",
  ]
  const missingCollectedDataTypes = requiredCollectedDataTypes.filter(
    (dataType) => !iosPrivacyManifest.includes(`<string>${dataType}</string>`),
  )
  const trackingFlags = iosPrivacyManifest.match(
    /<key>NSPrivacyCollectedDataTypeTracking<\/key>\s*<(true|false)\/>/g,
  ) || []
  const privacyManifestReady = iosPrivacyManifest.includes("<key>NSPrivacyCollectedDataTypes</key>")
    && missingCollectedDataTypes.length === 0
    && trackingFlags.length === requiredCollectedDataTypes.length
    && trackingFlags.every((entry) => entry.endsWith("<false/>"))
    && !iosPrivacyManifest.includes("<key>NSPrivacyTrackingDomains</key>")
  reporter.add(
    "ios-privacy-manifest",
    "native-privacy-security",
    privacyManifestReady,
    privacyManifestReady
      ? "iOS privacy manifest declares collected app data and disables tracking for every data type"
      : `iOS PrivacyInfo.xcprivacy is incomplete; missing data types: ${missingCollectedDataTypes.join(", ") || "none"}`,
  )

  const privacyResourceReferences = iosProject.match(/PrivacyInfo\.xcprivacy in Resources/g) || []
  reporter.add(
    "ios-privacy-manifest-bundled",
    "native-privacy-security",
    privacyResourceReferences.length >= 2,
    privacyResourceReferences.length >= 2
      ? "iOS privacy manifest is included in the app Resources phase"
      : "iOS PrivacyInfo.xcprivacy is not included in the app Resources phase",
    { references: privacyResourceReferences.length },
  )

  const androidBackupDisabled = /android:allowBackup="false"/.test(androidManifest)
    && /android:fullBackupContent="false"/.test(androidManifest)
  reporter.add(
    "android-backup-policy",
    "native-privacy-security",
    androidBackupDisabled,
    androidBackupDisabled
      ? "Android production manifest disables cloud/full backup of authenticated WebView state"
      : "Android production manifest must disable allowBackup and fullBackupContent",
  )

  const androidCleartextDisabled = /android:usesCleartextTraffic="false"/.test(androidManifest)
  const debugCleartextScoped = /android:usesCleartextTraffic="true"/.test(androidDebugManifest)
    && /tools:replace="android:usesCleartextTraffic"/.test(androidDebugManifest)
  reporter.add(
    "android-network-policy",
    "native-privacy-security",
    androidCleartextDisabled && debugCleartextScoped,
    androidCleartextDisabled && debugCleartextScoped
      ? "Android blocks cleartext traffic in production and scopes the local override to debug builds"
      : "Android cleartext policy must be disabled in production with a debug-only override",
  )

  const desktopPackage = readJson(desktopPackagePath)
  const appx = desktopPackage.build?.appx || {}
  const appxConfigurationReady = /^[A-Za-z0-9.-]{3,50}$/.test(appx.identityName || "")
    && /^CN=.+/i.test(appx.publisher || "")
    && /^([A-Za-z][A-Za-z0-9]*)(\.[A-Za-z][A-Za-z0-9]*)*$/.test(appx.applicationId || "")
    && Array.isArray(appx.capabilities)
    && appx.capabilities.includes("runFullTrust")
    && Array.isArray(appx.languages)
    && appx.languages.includes("es-PE")
    && appx.languages.includes("en-US")
  reporter.add(
    "windows-store-appx-config",
    "native-privacy-security",
    appxConfigurationReady,
    appxConfigurationReady
      ? "Windows Store AppX has a valid QA identity, full-trust capability, and Spanish/English languages"
      : "Windows Store AppX configuration is incomplete or invalid",
  )

  const expectedAppxAssets = [
    ["StoreLogo.png", 50, 50],
    ["Square44x44Logo.png", 44, 44],
    ["Square150x150Logo.png", 150, 150],
    ["Wide310x150Logo.png", 310, 150],
  ]
  const invalidAppxAssets = []
  for (const [fileName, width, height] of expectedAppxAssets) {
    const filePath = path.join(windowsAppxAssetsPath, fileName)
    if (!fs.existsSync(filePath)) {
      invalidAppxAssets.push(`${fileName}: missing`)
      continue
    }
    try {
      const dimensions = readPngDimensions(filePath)
      if (dimensions.width !== width || dimensions.height !== height) {
        invalidAppxAssets.push(`${fileName}: expected ${width}x${height}, got ${dimensions.width}x${dimensions.height}`)
      }
    } catch (error) {
      invalidAppxAssets.push(`${fileName}: ${error.message}`)
    }
  }
  reporter.add(
    "windows-store-appx-assets",
    "native-privacy-security",
    invalidAppxAssets.length === 0,
    invalidAppxAssets.length === 0
      ? "Windows Store AppX includes all four branded logo assets at exact required dimensions"
      : `Windows Store AppX assets are invalid: ${invalidAppxAssets.join("; ")}`,
  )
}

async function validateLiveUrls(reporter, metadata, urls) {
  for (const [key, url] of Object.entries(urls)) {
    if (!url) continue
    try {
      const response = await fetch(url, {
        headers: {
          accept: "text/html,application/xhtml+xml",
          "user-agent": "SiraGPT-Native-Store-Readiness/1.0",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(10000),
      })
      const contentType = response.headers.get("content-type") || ""
      const body = await response.text()
      const reachable = response.ok && contentType.includes("text/html") && body.length >= 500
      const contactOk = key !== "supportUrl" || body.toLocaleLowerCase().includes(metadata.app.supportEmail.toLocaleLowerCase())
      const valid = reachable && contactOk
      reporter.add(
        `live-${key}`,
        "live-public-urls",
        valid,
        valid
          ? `${key} is publicly reachable`
          : `${key} failed live validation (HTTP ${response.status}${contactOk ? "" : "; support email not found"})`,
        {
          requestedUrl: url,
          finalUrl: response.url,
          httpStatus: response.status,
          contentType,
          bodyBytes: Buffer.byteLength(body),
        },
      )
    } catch (error) {
      reporter.add(
        `live-${key}`,
        "live-public-urls",
        false,
        `${key} live validation failed: ${error.message}`,
        { requestedUrl: url },
      )
    }
  }
}

function buildReport(metadata, checks, checkUrls) {
  const failedChecks = checks.filter((check) => check.status === "failed")
  return {
    generatedAt: new Date().toISOString(),
    metadataVersion: metadata.version,
    metadataStatus: metadata.status,
    status: failedChecks.length === 0 ? "ready" : "blocked",
    distributionStatus: "owner-action-required",
    checkUrls,
    totals: {
      checks: checks.length,
      ready: checks.length - failedChecks.length,
      failed: failedChecks.length,
    },
    failedCheckIds: failedChecks.map((check) => check.id),
    localizations: Object.entries(metadata.storeCopy?.localizations || {}).map(([key, value]) => ({
      key,
      storeLocales: value.storeLocales,
    })),
    externalOwnerGates: Object.entries(metadata.platforms || {}).map(([platform, value]) => ({
      platform,
      actions: value.requiredAccountActions || [],
    })),
    checks,
  }
}

function renderMarkdown(report) {
  const lines = []
  lines.push("# SiraGPT Native Store Metadata Readiness")
  lines.push("")
  lines.push(`Generated: ${report.generatedAt}`)
  lines.push(`Metadata version: \`${report.metadataVersion}\``)
  lines.push(`Submission material status: \`${report.status}\``)
  lines.push(`Distribution status: \`${report.distributionStatus}\``)
  lines.push(`Live URL checks: \`${report.checkUrls ? "enabled" : "not-requested"}\``)
  lines.push("")
  lines.push("| Category | Check | Status | Detail |")
  lines.push("| --- | --- | --- | --- |")
  for (const check of report.checks) {
    lines.push(`| ${check.category} | ${check.id} | \`${check.status}\` | ${check.message.replaceAll("|", "\\|")} |`)
  }
  lines.push("")
  lines.push("## External Owner Gates")
  lines.push("")
  lines.push("These gates do not belong in the repository and remain required before store publication:")
  lines.push("")
  for (const platform of report.externalOwnerGates) {
    lines.push(`### ${platform.platform}`)
    lines.push("")
    for (const action of platform.actions) lines.push(`- ${action}`)
    lines.push("")
  }
  lines.push("No mailbox password, signing key, certificate, provisioning profile, API private key, or recovery code belongs in this report.")
  lines.push("")
  return `${lines.join("\n")}\n`
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(usage())
    return
  }

  const metadata = readJson(metadataPath)
  const reporter = createReporter()
  validateIdentity(reporter, metadata)

  const urls = {}
  for (const key of ["marketingUrl", "supportUrl", "privacyPolicyUrl", "termsUrl", "webRuntimeUrl"]) {
    const url = validateHttpsUrl(reporter, metadata, key)
    if (url) urls[key] = url.href
  }

  validateLocalizations(reporter, metadata)
  validatePrivacyAndOwnerBoundary(reporter, metadata)
  validateNativePrivacyAndSecurity(reporter)
  if (args.checkUrls) await validateLiveUrls(reporter, metadata, urls)

  const report = buildReport(metadata, reporter.checks, args.checkUrls)
  const json = `${JSON.stringify(report, null, 2)}\n`
  const markdown = renderMarkdown(report)

  if (args.out) writeFile(path.resolve(root, args.out), markdown)
  if (args.jsonOut) writeFile(path.resolve(root, args.jsonOut), json)
  process.stdout.write(args.format === "json" ? json : markdown)

  if (report.status !== "ready") process.exitCode = 1
}

main().catch((error) => {
  console.error(`native-store-readiness: ${error.message}`)
  process.exit(2)
})
