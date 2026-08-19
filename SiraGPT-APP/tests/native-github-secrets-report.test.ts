import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

function withMockGh(secretNames: string[], fn: (env: NodeJS.ProcessEnv) => void) {
  const dir = mkdtempSync(join(tmpdir(), "siragpt-native-github-secrets-report-"))

  try {
    const ghPath = join(dir, "gh")
    const json = JSON.stringify(secretNames.map((name) => ({ name, updatedAt: "2026-07-05T00:00:00Z" })))
    writeFileSync(ghPath, `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "secret" ] && [ "$2" = "list" ]; then
  printf '%s\\n' '${json}'
  exit 0
fi
echo "unexpected gh invocation: $*" >&2
exit 2
`)
    chmodSync(ghPath, 0o755)

    fn({
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("native-github-secrets-report", () => {
  it("reports missing native signing groups without secret values", () => {
    withMockGh(["VPS_HOST", "VPS_PORT"], (env) => {
      const output = execFileSync("node", [
        "scripts/native-github-secrets-report.js",
        "--repo=infosiragpt-ops/SiraGPT-APP",
        "--json",
      ], {
        encoding: "utf8",
        env,
      })
      const report = JSON.parse(output) as {
        status: string
        configuredRepositorySecrets: string[]
        missingRequiredGroups: string[]
        missingRequiredSecrets: string[]
      }
      assert.equal(report.status, "blocked-missing-native-signing-secrets")
      assert.deepEqual(report.configuredRepositorySecrets, ["VPS_HOST", "VPS_PORT"])
      assert.deepEqual(report.missingRequiredGroups, ["android", "googleplay", "ios", "appstore", "macos", "windows"])
      assert.ok(report.missingRequiredSecrets.includes("ANDROID_KEYSTORE_BASE64"))
      assert.doesNotMatch(output, /BEGIN (RSA|OPENSSH|PRIVATE) KEY/)
    })
  })

  it("writes markdown and json report files when requested", () => {
    withMockGh([
      "ANDROID_KEYSTORE_BASE64",
      "ANDROID_KEYSTORE_PASSWORD",
      "ANDROID_KEY_ALIAS",
      "ANDROID_KEY_PASSWORD",
    ], (env) => {
      const dir = mkdtempSync(join(tmpdir(), "siragpt-native-github-secrets-report-out-"))
      try {
        const markdownOut = join(dir, "native-secrets.md")
        const jsonOut = join(dir, "native-secrets.json")
        const output = execFileSync("node", [
          "scripts/native-github-secrets-report.js",
          "--groups=android",
          `--out=${markdownOut}`,
          `--json-out=${jsonOut}`,
        ], {
          encoding: "utf8",
          env,
        })
        assert.match(output, /Status: `ready`/)
        assert.ok(existsSync(markdownOut))
        assert.ok(existsSync(jsonOut))
        assert.equal(JSON.parse(readFileSync(jsonOut, "utf8")).status, "ready")
        assert.match(readFileSync(markdownOut, "utf8"), /`android`/)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })
})
