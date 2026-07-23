import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

describe("native store submission material", () => {
  it("validates localized copy against platform limits", () => {
    const report = JSON.parse(execFileSync("node", [
      "scripts/native-store-readiness.js",
      "--json",
    ], { encoding: "utf8" })) as {
      status: string
      distributionStatus: string
      failedCheckIds: string[]
      localizations: Array<{ key: string; storeLocales: Record<string, string> }>
      checks: Array<{ id: string; status: string; appleBytes?: number }>
    }

    assert.equal(report.status, "ready")
    assert.equal(report.distributionStatus, "owner-action-required")
    assert.deepEqual(report.failedCheckIds, [])
    assert.deepEqual(report.localizations.map((locale) => locale.key), ["es", "en"])
    assert.equal(report.localizations[0].storeLocales.googlePlay, "es-419")
    assert.equal(report.localizations[0].storeLocales.appStoreConnect, "es-MX")
    assert.ok(report.checks.every((check) => check.status === "ready"))
    for (const id of [
      "ios-usage-descriptions",
      "ios-privacy-manifest",
      "ios-privacy-manifest-bundled",
      "android-backup-policy",
      "android-network-policy",
      "windows-store-appx-config",
      "windows-store-appx-assets",
    ]) {
      assert.equal(report.checks.find((check) => check.id === id)?.status, "ready", id)
    }
    assert.ok(
      report.checks
        .filter((check) => check.id.endsWith("-keywords"))
        .every((check) => Number(check.appleBytes) <= 100),
    )
  })

  it("exports Spanish and English packets for every store", () => {
    const dir = mkdtempSync(join(tmpdir(), "siragpt-native-store-submission-"))

    try {
      const outDir = join(dir, "packet")
      const jsonOut = join(dir, "packet.json")
      execFileSync("node", [
        "scripts/generate-native-store-packet.js",
        "--require-ready",
        `--out-dir=${outDir}`,
        `--json-out=${jsonOut}`,
      ], { encoding: "utf8" })

      for (const file of [
        join(outDir, "google-play", "es-419", "short-description.txt"),
        join(outDir, "google-play", "en-US", "full-description.txt"),
        join(outDir, "app-store-connect", "es-MX", "keywords.txt"),
        join(outDir, "app-store-connect", "en-US", "promotional-text.txt"),
        join(outDir, "macos", "es-MX", "description.txt"),
        join(outDir, "macos", "en-US", "release-notes.txt"),
        join(outDir, "windows", "es-PE", "features.txt"),
        join(outDir, "windows", "en-US", "short-description.txt"),
      ]) {
        assert.ok(existsSync(file), `missing ${file}`)
        assert.ok(readFileSync(file, "utf8").trim().length > 0, `empty ${file}`)
      }

      const summary = JSON.parse(readFileSync(jsonOut, "utf8")) as {
        status: string
        app: { defaultLocale: string; locales: string[] }
        platforms: Array<{ platform: string; status: string; locales: string[] }>
      }
      assert.equal(summary.status, "ready")
      assert.equal(summary.app.defaultLocale, "es")
      assert.deepEqual(summary.app.locales, ["es", "en"])
      assert.equal(summary.platforms.length, 4)
      assert.ok(summary.platforms.every((platform) => platform.status === "ready"))
      assert.ok(summary.platforms.every((platform) => platform.locales.length === 2))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("validates exact Apple screenshot sizes and rejects alpha in Apple assets", () => {
    const report = JSON.parse(execFileSync("node", [
      "scripts/native-store-assets-readiness.js",
      "--json",
      "--require-ready",
    ], { encoding: "utf8" })) as {
      status: string
      platformReports: Array<{
        key: string
        checks: Array<{
          id: string
          status: string
          hasAlpha?: boolean | null
          files?: Array<{ dimensions: { width: number; height: number }; hasAlpha: boolean | null }>
        }>
      }>
    }

    assert.equal(report.status, "ready")
    const ios = report.platformReports.find((platform) => platform.key === "ios")
    const macos = report.platformReports.find((platform) => platform.key === "macos")
    assert.ok(ios)
    assert.ok(macos)
    assert.ok(ios.checks.every((check) => check.status === "ready"))
    assert.equal(ios.checks.find((check) => check.id === "ios-app-icon-1024")?.hasAlpha, false)
    assert.ok(
      ios.checks
        .flatMap((check) => check.files || [])
        .every((file) => file.hasAlpha === false),
    )
    assert.ok(
      macos.checks
        .flatMap((check) => check.files || [])
        .every((file) => file.hasAlpha === false),
    )
  })

  it("provides public support and canonical terms routes", () => {
    const metadata = JSON.parse(readFileSync("docs/store-submission/native-store-metadata.json", "utf8")) as {
      app: { supportUrl: string; termsUrl: string; supportEmail: string }
    }
    const supportSource = readFileSync("app/support/page.tsx", "utf8")
    const termsAliasSource = readFileSync("app/terms-of-service/page.tsx", "utf8")

    assert.equal(metadata.app.supportUrl, "https://siragpt.com/support")
    assert.equal(metadata.app.termsUrl, "https://siragpt.com/terms")
    assert.match(supportSource, new RegExp(metadata.app.supportEmail.replace(".", "\\.")))
    assert.match(termsAliasSource, /redirect\("\/terms"\)/)
  })
})
