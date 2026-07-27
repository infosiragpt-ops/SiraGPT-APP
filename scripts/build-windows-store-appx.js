#!/usr/bin/env node

const childProcess = require("child_process")
const crypto = require("crypto")
const fs = require("fs")
const path = require("path")

const root = path.resolve(__dirname, "..")
const desktopPackagePath = path.join(root, "apps/desktop/package.json")
const desktopPackage = JSON.parse(fs.readFileSync(desktopPackagePath, "utf8"))
const outputDir = path.join(root, "output/desktop")
const requiredStoreVariables = [
  "WINDOWS_STORE_IDENTITY_NAME",
  "WINDOWS_STORE_PUBLISHER",
  "WINDOWS_STORE_PUBLISHER_DISPLAY_NAME",
  "WINDOWS_STORE_APPLICATION_ID",
]

function value(name) {
  return String(process.env[name] || "").trim()
}

function resolvePackageMode() {
  const requested = value("WINDOWS_STORE_PACKAGE_MODE").toLowerCase() || "auto"
  if (!["auto", "qa", "store"].includes(requested)) {
    throw new Error("WINDOWS_STORE_PACKAGE_MODE must be auto, qa, or store")
  }

  const configured = requiredStoreVariables.filter((name) => value(name))
  if (requested === "store" && configured.length !== requiredStoreVariables.length) {
    const missing = requiredStoreVariables.filter((name) => !value(name))
    throw new Error(`Store mode requires repository variables: ${missing.join(", ")}`)
  }
  if (requested === "auto" && configured.length > 0 && configured.length !== requiredStoreVariables.length) {
    const missing = requiredStoreVariables.filter((name) => !value(name))
    throw new Error(`Partial Microsoft Store identity is unsafe; missing: ${missing.join(", ")}`)
  }

  return requested === "store" || (requested === "auto" && configured.length === requiredStoreVariables.length)
    ? "store"
    : "qa"
}

function resolveIdentity(mode) {
  const defaults = desktopPackage.build?.appx || {}
  const identity = mode === "store"
    ? {
        identityName: value("WINDOWS_STORE_IDENTITY_NAME"),
        publisher: value("WINDOWS_STORE_PUBLISHER"),
        publisherDisplayName: value("WINDOWS_STORE_PUBLISHER_DISPLAY_NAME"),
        applicationId: value("WINDOWS_STORE_APPLICATION_ID"),
      }
    : {
        identityName: defaults.identityName,
        publisher: defaults.publisher,
        publisherDisplayName: defaults.publisherDisplayName,
        applicationId: defaults.applicationId,
      }

  if (!/^[A-Za-z0-9.-]{3,50}$/.test(identity.identityName || "")) {
    throw new Error("Windows Store identity name must contain 3-50 letters, numbers, periods, or hyphens")
  }
  if (!/^([A-Za-z][A-Za-z0-9]*)(\.[A-Za-z][A-Za-z0-9]*)*$/.test(identity.applicationId || "")) {
    throw new Error("Windows Store application ID must contain dot-separated alphanumeric fields beginning with a letter")
  }
  if (!/^CN=.+/i.test(identity.publisher || "")) {
    throw new Error("Windows Store publisher must be the exact Partner Center distinguished name beginning with CN=")
  }
  if (!identity.publisherDisplayName || identity.publisherDisplayName.length > 256) {
    throw new Error("Windows Store publisher display name must contain 1-256 characters")
  }

  return identity
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")
}

function findBuiltAppx() {
  const candidates = fs.readdirSync(outputDir)
    .filter((name) => /^SiraGPT-Store-.*\.appx$/i.test(name))
    .map((name) => ({
      name,
      path: path.join(outputDir, name),
      mtimeMs: fs.statSync(path.join(outputDir, name)).mtimeMs,
    }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
  if (candidates.length === 0) throw new Error("electron-builder did not produce a Windows Store AppX package")
  return candidates[0]
}

function run() {
  if (process.platform !== "win32") {
    throw new Error("Windows Store AppX packaging must run on Windows 10/11 or Windows Server")
  }

  const mode = resolvePackageMode()
  const identity = resolveIdentity(mode)
  fs.mkdirSync(outputDir, { recursive: true })
  for (const name of fs.readdirSync(outputDir)) {
    if (/^SiraGPT-Store-.*\.appx$/i.test(name)) fs.rmSync(path.join(outputDir, name))
  }

  const cliPath = require.resolve("electron-builder/out/cli/cli.js")
  const args = [
    cliPath,
    "--projectDir",
    "apps/desktop",
    "--win",
    "appx",
    "--x64",
    "--publish",
    "never",
    `--config.appx.identityName=${identity.identityName}`,
    `--config.appx.publisher=${identity.publisher}`,
    `--config.appx.publisherDisplayName=${identity.publisherDisplayName}`,
    `--config.appx.applicationId=${identity.applicationId}`,
  ]
  const childEnv = {
    ...process.env,
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
    CSC_LINK: "",
    CSC_KEY_PASSWORD: "",
    WIN_CSC_LINK: "",
    WIN_CSC_KEY_PASSWORD: "",
  }

  process.stdout.write(`Building ${mode === "store" ? "Partner Center" : "QA"} AppX package with unsigned Store handoff semantics\n`)
  const result = childProcess.spawnSync(process.execPath, args, {
    cwd: root,
    env: childEnv,
    stdio: "inherit",
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status || 1)

  const appx = findBuiltAppx()
  const metadata = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceSha: value("GITHUB_SHA") || null,
    appVersion: desktopPackage.version,
    packageMode: mode,
    storeSubmissionReady: mode === "store",
    installableDirectly: false,
    signature: "unsigned-microsoft-store-handoff",
    package: {
      fileName: appx.name,
      bytes: fs.statSync(appx.path).size,
      sha256: sha256(appx.path),
      architecture: "x64",
    },
    identity,
    requiredOwnerAction: mode === "store"
      ? "Upload to the reserved Partner Center app; Microsoft Store applies the distribution signature during certification."
      : "Reserve the app in Partner Center and configure all four WINDOWS_STORE_* repository variables before building a submission package.",
  }
  const metadataPath = path.join(outputDir, "windows-store-package.json")
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`)
  process.stdout.write(`Windows Store package: ${path.relative(root, appx.path)}\n`)
  process.stdout.write(`Package metadata: ${path.relative(root, metadataPath)}\n`)
}

try {
  run()
} catch (error) {
  console.error(`build-windows-store-appx: ${error.message}`)
  process.exit(1)
}
