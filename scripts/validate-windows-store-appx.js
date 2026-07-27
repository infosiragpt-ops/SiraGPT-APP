#!/usr/bin/env node

const crypto = require("crypto")
const fs = require("fs")
const path = require("path")
const AdmZip = require("adm-zip")
const { DOMParser } = require("@xmldom/xmldom")

const root = path.resolve(__dirname, "..")
const outputDir = path.join(root, "output/desktop")

function parseArgs(argv) {
  const args = {
    file: "",
    metadata: path.join(outputDir, "windows-store-package.json"),
    json: false,
  }
  for (const arg of argv) {
    if (arg === "--json") args.json = true
    else if (arg.startsWith("--file=")) args.file = path.resolve(root, arg.slice("--file=".length))
    else if (arg.startsWith("--metadata=")) args.metadata = path.resolve(root, arg.slice("--metadata=".length))
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return args
}

function findAppx(explicitPath) {
  if (explicitPath) return explicitPath
  const metadata = JSON.parse(fs.readFileSync(path.join(outputDir, "windows-store-package.json"), "utf8"))
  return path.join(outputDir, metadata.package.fileName)
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")
}

function firstElement(document, localName) {
  const elements = document.getElementsByTagName("*")
  for (let index = 0; index < elements.length; index += 1) {
    if (elements[index].localName === localName || elements[index].nodeName === localName) return elements[index]
  }
  return null
}

function hasCapability(document, name) {
  const elements = document.getElementsByTagName("*")
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index]
    if ((element.localName === "Capability" || element.nodeName.endsWith(":Capability"))
      && element.getAttribute("Name") === name) return true
  }
  return false
}

function run() {
  const args = parseArgs(process.argv.slice(2))
  const metadata = JSON.parse(fs.readFileSync(args.metadata, "utf8"))
  const appxPath = findAppx(args.file)
  const zip = new AdmZip(appxPath)
  const manifestEntry = zip.getEntry("AppxManifest.xml")
  if (!manifestEntry) throw new Error("AppxManifest.xml is missing")

  const manifest = manifestEntry.getData().toString("utf8")
  const document = new DOMParser().parseFromString(manifest, "application/xml")
  if (document.getElementsByTagName("parsererror").length > 0) throw new Error("AppxManifest.xml is not valid XML")

  const identity = firstElement(document, "Identity")
  const application = firstElement(document, "Application")
  const checks = [
    ["block-map", Boolean(zip.getEntry("AppxBlockMap.xml")), "AppxBlockMap.xml is present"],
    ["identity-name", identity?.getAttribute("Name") === metadata.identity.identityName, "Identity.Name matches package metadata"],
    ["identity-publisher", identity?.getAttribute("Publisher") === metadata.identity.publisher, "Identity.Publisher matches package metadata"],
    ["architecture", identity?.getAttribute("ProcessorArchitecture") === "x64", "ProcessorArchitecture is x64"],
    ["application-id", application?.getAttribute("Id") === metadata.identity.applicationId, "Application.Id matches package metadata"],
    ["executable", Boolean(application?.getAttribute("Executable")), "Application executable is declared"],
    ["run-full-trust", hasCapability(document, "runFullTrust"), "runFullTrust capability is declared"],
    ["store-logo", Boolean(zip.getEntry("assets/StoreLogo.png")), "StoreLogo.png is packaged"],
    ["square-44-logo", Boolean(zip.getEntry("assets/Square44x44Logo.png")), "Square44x44Logo.png is packaged"],
    ["square-150-logo", Boolean(zip.getEntry("assets/Square150x150Logo.png")), "Square150x150Logo.png is packaged"],
    ["wide-logo", Boolean(zip.getEntry("assets/Wide310x150Logo.png")), "Wide310x150Logo.png is packaged"],
    ["unsigned-store-handoff", !zip.getEntry("AppxSignature.p7x"), "Package is intentionally unsigned for Microsoft Store handoff"],
    ["sha256", sha256(appxPath) === metadata.package.sha256, "Package checksum matches metadata"],
    ["mode", ["qa", "store"].includes(metadata.packageMode), "Package mode is explicit"],
  ].map(([id, ok, message]) => ({ id, status: ok ? "ready" : "failed", message }))
  const failed = checks.filter((check) => check.status === "failed")
  const report = {
    status: failed.length === 0 ? "ready" : "failed",
    packageMode: metadata.packageMode,
    storeSubmissionReady: metadata.storeSubmissionReady === true,
    package: path.relative(root, appxPath),
    checks,
  }

  process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : [
    `Windows AppX validation: ${report.status}`,
    `Mode: ${report.packageMode}`,
    `Store submission identity ready: ${report.storeSubmissionReady}`,
    ...checks.map((check) => `- ${check.id}: ${check.status} (${check.message})`),
    "",
  ].join("\n"))
  if (failed.length > 0) process.exitCode = 1
}

try {
  run()
} catch (error) {
  console.error(`validate-windows-store-appx: ${error.message}`)
  process.exit(1)
}
