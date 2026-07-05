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
        zipPath: string
        checksumSha256: string
      }
      assert.equal(summary.status, "owner-action-required")
      assert.equal(summary.repository, "infosiragpt-ops/SiraGPT-APP")
      assert.equal(summary.packetSourceSha, "6a3d4efc370212f6e1d53944c4fbb5fa58374866")
      assert.match(summary.checksumSha256, /^[a-f0-9]{64}$/)
      assert.ok(existsSync(zipOut))
      assert.ok(existsSync(checksumOut))
      assert.match(readFileSync(checksumOut, "utf8"), new RegExp(`^${summary.checksumSha256}\\s+packet\\.zip\\n$`))

      const manifest = JSON.parse(readFileSync(join(outDir, "PACKET-MANIFEST.json"), "utf8")) as {
        qaBinaryTargetSha: string
        included: string[]
      }
      assert.equal(manifest.qaBinaryTargetSha, "0fb0493464b841c11924e9ff9a087209fb8d25dd")
      assert.ok(manifest.included.includes("native-store-submission-packet/"))
      assert.ok(existsSync(join(outDir, "native-store-submission-packet", "google-play", "README.md")))
      assert.ok(existsSync(join(outDir, "native-store-submission-packet", "app-store-connect", "README.md")))

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
