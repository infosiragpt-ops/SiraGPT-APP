#!/usr/bin/env node

const fs = require("fs")
const path = require("path")

const root = path.resolve(__dirname, "..")
const metadataPath = path.join(root, "docs/store-submission/native-store-metadata.json")
const capacitorPath = path.join(root, "capacitor.config.ts")
const desktopPackagePath = path.join(root, "apps/desktop/package.json")
const privacyPolicyPath = path.join(root, "docs/legal/privacy-policy.md")

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
