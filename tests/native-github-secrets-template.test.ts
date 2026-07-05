import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

describe("generate-native-github-secrets-template", () => {
  it("expands Android to include Google Play upload inputs", () => {
    const output = execFileSync("node", [
      "scripts/generate-native-github-secrets-template.js",
      "--platform=android",
    ], { encoding: "utf8" })

    assert.match(output, /ANDROID_KEYSTORE_PATH=/)
    assert.match(output, /ANDROID_KEYSTORE_PASSWORD=/)
    assert.match(output, /GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_PATH=/)
    assert.doesNotMatch(output, /IOS_SIGNING_CERTIFICATE_PATH=/)
    assert.doesNotMatch(output, /Siragpt2025/)
  })

  it("prints JSON metadata with names only", () => {
    const output = execFileSync("node", [
      "scripts/generate-native-github-secrets-template.js",
      "--platform=mobile",
      "--format=json",
    ], { encoding: "utf8" })
    const payload = JSON.parse(output)

    assert.deepEqual(payload.groups, ["android", "googleplay", "ios", "appstore"])
    assert.equal(payload.repo, "infosiragpt-ops/SiraGPT-APP")
    assert.ok(payload.inputs.some((input: { secret: string }) => input.secret === "APP_STORE_CONNECT_API_KEY_BASE64"))
    assert.ok(payload.commands.dryRun.includes("--dry-run"))
    assert.doesNotMatch(output, /PRIVATE KEY-----/)
    assert.doesNotMatch(output, /password['"]?\s*:/i)
  })

  it("writes a non-secret owner template file", () => {
    const dir = mkdtempSync(join(tmpdir(), "siragpt-native-secrets-template-"))
    const out = join(dir, "native-signing.env.example")

    try {
      execFileSync("node", [
        "scripts/generate-native-github-secrets-template.js",
        "--platform=desktop",
        `--out=${out}`,
      ], { encoding: "utf8" })
      const contents = readFileSync(out, "utf8")

      assert.match(contents, /MACOS_CERTIFICATE_PATH=/)
      assert.match(contents, /WINDOWS_CERTIFICATE_PATH=/)
      assert.match(contents, /APPLE_APP_SPECIFIC_PASSWORD=/)
      assert.doesNotMatch(contents, /ghp_[A-Za-z0-9_]+/)
      assert.doesNotMatch(contents, /sk-[A-Za-z0-9_-]{20,}/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
