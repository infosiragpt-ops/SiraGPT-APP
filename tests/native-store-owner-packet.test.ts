import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

describe("generate-native-store-owner-packet", () => {
  it("creates a non-secret store owner packet with zip and checksum", () => {
    const dir = mkdtempSync(join(tmpdir(), "siragpt-native-store-owner-packet-"))

    try {
      const outDir = join(dir, "packet")
      const zipOut = join(dir, "packet.zip")
      const checksumOut = join(dir, "packet.zip.sha256")
      const stdout = execFileSync("node", [
        "scripts/generate-native-store-owner-packet.js",
        "--repo=infosiragpt-ops/SiraGPT-APP",
        "--secret-source=env",
        "--source-sha=6a3d4efc370212f6e1d53944c4fbb5fa58374866",
        "--source-commit=docs(native): update owner handoff traceability",
        `--out-dir=${outDir}`,
        `--zip-out=${zipOut}`,
        `--checksum-out=${checksumOut}`,
        "--json",
      ], { encoding: "utf8" })

      const summary = JSON.parse(stdout) as {
        status: string
        repository: string
        packetSourceSha: string
        latestSignedPreflight: { run: string; sourceSha: string; status: string }
        zipPath: string
        checksumSha256: string
      }
      assert.equal(summary.status, "owner-action-required")
      assert.equal(summary.repository, "infosiragpt-ops/SiraGPT-APP")
      assert.equal(summary.packetSourceSha, "6a3d4efc370212f6e1d53944c4fbb5fa58374866")
      assert.equal(summary.latestSignedPreflight.run, "28728938916")
      assert.equal(summary.latestSignedPreflight.sourceSha, "5970953f4c72a3f39850ac679a5d9b7f3a939c49")
      assert.equal(summary.latestSignedPreflight.status, "blocked-missing-signing-secrets")
      assert.match(summary.checksumSha256, /^[a-f0-9]{64}$/)
      assert.ok(existsSync(zipOut))
      assert.ok(existsSync(checksumOut))
      assert.match(readFileSync(checksumOut, "utf8"), new RegExp(`^${summary.checksumSha256}\\s+packet\\.zip\\n$`))

      const manifest = JSON.parse(readFileSync(join(outDir, "PACKET-MANIFEST.json"), "utf8")) as {
        qaBinaryTargetSha: string
        latestOwnerPacket: { sourceSha: string; zipName: string }
        latestSignedPreflight: { run: string; sourceSha: string }
        included: string[]
      }
      assert.equal(manifest.qaBinaryTargetSha, "0fb0493464b841c11924e9ff9a087209fb8d25dd")
      assert.equal(manifest.latestOwnerPacket.sourceSha, "ffb2f79076b4807f32f898e8b1b8ec60ca56844d")
      assert.equal(manifest.latestOwnerPacket.zipName, "SiraGPT-native-store-owner-packet-ffb2f790.zip")
      assert.equal(manifest.latestSignedPreflight.run, "28728938916")
      assert.equal(manifest.latestSignedPreflight.sourceSha, "5970953f4c72a3f39850ac679a5d9b7f3a939c49")
      assert.ok(manifest.included.includes("native-store-submission-packet/"))
      assert.ok(manifest.included.includes("native-signing-templates/"))
      assert.ok(existsSync(join(outDir, "native-store-submission-packet", "google-play", "README.md")))
      assert.ok(existsSync(join(outDir, "native-store-submission-packet", "app-store-connect", "README.md")))
      assert.ok(existsSync(join(outDir, "native-signing-templates", "all.env.example")))
      assert.ok(existsSync(join(outDir, "native-signing-templates", "mobile.env.example")))
      assert.ok(existsSync(join(outDir, "native-signing-templates", "desktop.env.example")))
      assert.ok(existsSync(join(outDir, "native-signing-templates", "android.env.example")))
      assert.ok(existsSync(join(outDir, "native-signing-templates", "ios.env.example")))
      assert.ok(existsSync(join(outDir, "native-signing-templates", "macos.env.example")))
      assert.ok(existsSync(join(outDir, "native-signing-templates", "windows.env.example")))
      assert.match(readFileSync(join(outDir, "native-signing-templates", "all.env.example"), "utf8"), /ANDROID_KEYSTORE_PATH=/)
      assert.match(readFileSync(join(outDir, "native-signing-templates", "all.env.example"), "utf8"), /WINDOWS_CERTIFICATE_PATH=/)
      assert.doesNotMatch(readFileSync(join(outDir, "native-signing-templates", "all.env.example"), "utf8"), /Siragpt2025/)

      for (const file of [
        join(outDir, "README.md"),
        join(outDir, "PACKET-MANIFEST.json"),
        join(outDir, "native-owner-handoff.md"),
        join(outDir, "native-release-plan.md"),
      ]) {
        const contents = readFileSync(file, "utf8")
        assert.doesNotMatch(contents, /BEGIN (RSA|OPENSSH|PRIVATE) KEY/)
        assert.doesNotMatch(contents, /ghp_[A-Za-z0-9_]+/)
        assert.doesNotMatch(contents, /sk-[A-Za-z0-9_-]{20,}/)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
