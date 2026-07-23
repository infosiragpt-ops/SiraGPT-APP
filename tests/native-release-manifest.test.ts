import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
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
        "ios/SiraGPT-ios-simulator-app.zip",
        "ios/SiraGPT.ipa",
        "SiraGPT-flat-ios-simulator-app.zip",
        "macos/SiraGPT-arm64.dmg",
        "macos/SiraGPT-arm64-mac.zip",
        "macos/SiraGPT-arm64.dmg.blockmap",
        "windows/SiraGPT-Setup-x64.exe",
        "windows/SiraGPT-x64-portable.exe",
        "windows/SiraGPT-Setup-x64.exe.blockmap",
      ]

      for (const file of files) {
        const absolute = join(dir, file)
        mkdirSync(join(absolute, ".."), { recursive: true })
        writeFileSync(absolute, `artifact:${file}`)
      }

      const output = execFileSync("node", [
        "scripts/generate-native-release-manifest.js",
        `--dir=${dir}`,
        "--release-tag=test-native",
        "--git-sha=test-sha",
      ], { encoding: "utf8" })
      const manifest = JSON.parse(output) as {
        summary: { platformCounts: Record<string, number | undefined> }
        artifacts: Array<{ path: string; platform: string; kind: string }>
      }

      assert.equal(manifest.summary.platformCounts.android, 2)
      assert.equal(manifest.summary.platformCounts.ios, 3)
      assert.equal(manifest.summary.platformCounts.macos, 3)
      assert.equal(manifest.summary.platformCounts.windows, 3)
      assert.equal(manifest.summary.platformCounts.unknown, undefined)

      const simulator = manifest.artifacts.find((artifact) => artifact.path.includes("ios-simulator"))
      assert.ok(simulator)
      assert.equal(simulator.platform, "ios")
      assert.equal(simulator.kind, "simulator-app-zip")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
