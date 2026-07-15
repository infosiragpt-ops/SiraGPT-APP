const { execFileSync } = require("node:child_process")
const path = require("node:path")

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return

  const appName = context.packager.appInfo.productFilename
  const infoPlist = path.join(context.appOutDir, `${appName}.app`, "Contents", "Info.plist")

  // electron-builder injects NSAllowsArbitraryLoads=true for Electron apps.
  // Override it after packaging and before signing/notarization.
  execFileSync("/usr/bin/plutil", [
    "-replace",
    "NSAppTransportSecurity.NSAllowsArbitraryLoads",
    "-bool",
    "NO",
    infoPlist,
  ])

  const value = execFileSync("/usr/bin/plutil", [
    "-extract",
    "NSAppTransportSecurity.NSAllowsArbitraryLoads",
    "raw",
    infoPlist,
  ], { encoding: "utf8" }).trim()

  if (value !== "false") {
    throw new Error(`Failed to harden NSAppTransportSecurity: ${value}`)
  }
}
