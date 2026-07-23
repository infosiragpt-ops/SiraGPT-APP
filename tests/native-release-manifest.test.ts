import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

describe("generate-native-release-manifest", () => {
  it("classifies flat native release folders by platform", () => {
    const dir = mkdtempSync(join(tmpdir(), "siragpt-native-manifest-"))

    try {
      const files = [
        "android/SiraGPT-debug.apk",
        "android/SiraGPT-play-upload.aab",
        "SiraGPT-f99a790.apk",
        "android-upload-certificate-blocker.json",
        "android-upload-certificate-status.json",
        "ios/SiraGPT-ios-simulator-app.zip",
        "ios/SiraGPT.ipa",
        "SiraGPT-flat-ios-simulator-app.zip",
        "SiraGPT-flat-ios-device-build.json",
        "macos/SiraGPT-arm64.dmg",
        "macos/SiraGPT-arm64-mac.zip",
        "macos/SiraGPT-arm64.dmg.blockmap",
        "windows/SiraGPT-Setup-x64.exe",
        "windows/SiraGPT-x64-portable.exe",
        "windows/SiraGPT-Setup-x64.exe.blockmap",
        "windows/SiraGPT-Store-0.4.4-x64.appx",
        "windows-store-package.json",
      ]

      for (const file of files) {
        const absolute = join(dir, file)
        mkdirSync(join(absolute, ".."), { recursive: true })
        writeFileSync(absolute, `artifact:${file}`)
      }

      const checksumsPath = join(dir, "SHA256SUMS.txt")
      const output = execFileSync("node", [
        "scripts/generate-native-release-manifest.js",
        `--dir=${dir}`,
        `--checksums-out=${checksumsPath}`,
        "--release-tag=test-native",
        "--git-sha=test-sha",
      ], { encoding: "utf8" })
      const manifest = JSON.parse(output) as {
        summary: { platformCounts: Record<string, number | undefined> }
        artifacts: Array<{ path: string; platform: string; kind: string }>
      }

      assert.equal(manifest.summary.platformCounts.android, 5)
      assert.equal(manifest.summary.platformCounts.ios, 4)
      assert.equal(manifest.summary.platformCounts.macos, 3)
      assert.equal(manifest.summary.platformCounts.windows, 5)
      assert.equal(manifest.summary.platformCounts.unknown, undefined)

      const simulator = manifest.artifacts.find((artifact) => artifact.path.includes("ios-simulator"))
      assert.ok(simulator)
      assert.equal(simulator.platform, "ios")
      assert.equal(simulator.kind, "simulator-app-zip")

      const debugApk = manifest.artifacts.find((artifact) => artifact.path.endsWith("SiraGPT-debug.apk"))
      assert.ok(debugApk)
      assert.equal(debugApk.kind, "debug-apk")

      const releaseApk = manifest.artifacts.find((artifact) => artifact.path === "SiraGPT-f99a790.apk")
      assert.ok(releaseApk)
      assert.equal(releaseApk.kind, "release-apk")

      const androidBlocker = manifest.artifacts.find((artifact) => artifact.path === "android-upload-certificate-blocker.json")
      assert.ok(androidBlocker)
      assert.equal(androidBlocker.platform, "android")
      assert.equal(androidBlocker.kind, "play-upload-blocker-evidence")

      const androidCertificateStatus = manifest.artifacts.find(
        (artifact) => artifact.path === "android-upload-certificate-status.json",
      )
      assert.ok(androidCertificateStatus)
      assert.equal(androidCertificateStatus.platform, "android")
      assert.equal(androidCertificateStatus.kind, "play-upload-certificate-evidence")

      const iosDeviceBuild = manifest.artifacts.find((artifact) => artifact.path === "SiraGPT-flat-ios-device-build.json")
      assert.ok(iosDeviceBuild)
      assert.equal(iosDeviceBuild.platform, "ios")
      assert.equal(iosDeviceBuild.kind, "ios-device-build-evidence")

      const storeAppx = manifest.artifacts.find((artifact) => artifact.path.endsWith(".appx"))
      assert.ok(storeAppx)
      assert.equal(storeAppx.kind, "microsoft-store-appx")

      const storeMetadata = manifest.artifacts.find((artifact) => artifact.path.endsWith("windows-store-package.json"))
      assert.ok(storeMetadata)
      assert.equal(storeMetadata.kind, "microsoft-store-package-metadata")

      const checksums = readFileSync(checksumsPath, "utf8")
      assert.match(checksums, /  SiraGPT-debug\.apk$/m)
      assert.doesNotMatch(checksums, /  android\/SiraGPT-debug\.apk$/m)
      assert.ok(checksums.trim().split("\n").every((line) => !line.split(/\s{2}/)[1]?.includes("/")))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rejects duplicate file names that GitHub Releases would flatten", () => {
    const dir = mkdtempSync(join(tmpdir(), "siragpt-native-manifest-"))

    try {
      for (const file of ["android/SiraGPT.aab", "archive/SiraGPT.aab"]) {
        const absolute = join(dir, file)
        mkdirSync(join(absolute, ".."), { recursive: true })
        writeFileSync(absolute, `artifact:${file}`)
      }

      const result = spawnSync("node", [
        "scripts/generate-native-release-manifest.js",
        `--dir=${dir}`,
        `--checksums-out=${join(dir, "SHA256SUMS.txt")}`,
      ], { encoding: "utf8" })

      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /Duplicate release asset file name: SiraGPT\.aab/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
