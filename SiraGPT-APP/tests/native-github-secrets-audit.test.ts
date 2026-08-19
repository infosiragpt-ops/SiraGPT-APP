import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

const allNativeSecrets = [
  "ANDROID_KEYSTORE_BASE64",
  "ANDROID_KEYSTORE_PASSWORD",
  "ANDROID_KEY_ALIAS",
  "ANDROID_KEY_PASSWORD",
  "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64",
  "APPLE_TEAM_ID",
  "IOS_SIGNING_CERTIFICATE_BASE64",
  "IOS_SIGNING_CERTIFICATE_PASSWORD",
  "IOS_PROVISIONING_PROFILE_BASE64",
  "APP_STORE_CONNECT_API_KEY_ID",
  "APP_STORE_CONNECT_API_ISSUER_ID",
  "APP_STORE_CONNECT_API_KEY_BASE64",
  "MACOS_CERTIFICATE_BASE64",
  "MACOS_CERTIFICATE_PASSWORD",
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "WINDOWS_CERTIFICATE_BASE64",
  "WINDOWS_CERTIFICATE_PASSWORD",
]

function withMockGh(secretNames: string[], fn: (env: NodeJS.ProcessEnv) => void) {
  const dir = mkdtempSync(join(tmpdir(), "siragpt-gh-secrets-audit-"))

  try {
    const ghPath = join(dir, "gh")
    const output = secretNames.map((name) => `${name}\t2026-07-05T00:00:00Z`).join("\\n")
    writeFileSync(ghPath, `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "secret" ] && [ "$2" = "list" ]; then
  printf '%b' '${output}\\n'
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

describe("audit-native-github-secrets", () => {
  it("checks all groups when --only-required is used without --require", () => {
    withMockGh(allNativeSecrets, (env) => {
      const output = execFileSync("bash", [
        "scripts/audit-native-github-secrets.sh",
        "--repo=infosiragpt-ops/SiraGPT-APP",
        "--only-required",
      ], { encoding: "utf8", env })

      assert.match(output, /android: ready/)
      assert.match(output, /googleplay: ready/)
      assert.match(output, /ios: ready/)
      assert.match(output, /appstore: ready/)
      assert.match(output, /macos: ready/)
      assert.match(output, /windows: ready/)
      assert.doesNotMatch(output, /No groups selected/)
    })
  })
})
