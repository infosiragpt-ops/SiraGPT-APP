#!/usr/bin/env node

const groups = {
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

function parseRequiredGroups(argv) {
  const requireArg = argv.find((arg) => arg.startsWith("--require="))
  if (!requireArg) return []
  return requireArg
    .slice("--require=".length)
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
}

function isPresent(name) {
  return Boolean(process.env[name] && process.env[name].trim())
}

function printGroup(name, secretNames) {
  const missing = secretNames.filter((secretName) => !isPresent(secretName))
  const status = missing.length === 0 ? "ready" : "missing"
  console.log(`${name}: ${status}`)

  if (missing.length > 0) {
    console.log(`  missing: ${missing.join(", ")}`)
  }

  return missing
}

function main() {
  const requiredGroups = parseRequiredGroups(process.argv.slice(2))
  const unknownGroups = requiredGroups.filter((name) => !groups[name])

  if (unknownGroups.length > 0) {
    console.error(`Unknown release group: ${unknownGroups.join(", ")}`)
    process.exit(2)
  }

  const missingByGroup = new Map()

  for (const [name, secretNames] of Object.entries(groups)) {
    const missing = printGroup(name, secretNames)
    missingByGroup.set(name, missing)
  }

  const failedRequiredGroups = requiredGroups.filter((name) => {
    const missing = missingByGroup.get(name) || []
    return missing.length > 0
  })

  if (failedRequiredGroups.length > 0) {
    console.error(`Required release groups are incomplete: ${failedRequiredGroups.join(", ")}`)
    process.exit(1)
  }
}

main()
