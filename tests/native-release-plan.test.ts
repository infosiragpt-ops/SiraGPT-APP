import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { describe, it } from "node:test"

const nativeSecretNames = [
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

function nativeSecretEnv(values: Record<string, string> = {}) {
  const env = { ...process.env }
  for (const name of nativeSecretNames) {
    delete env[name]
  }
  return {
    ...env,
    ...values,
  }
}

describe("native-release-plan", () => {
  it("explains that public Actions and signed native releases are separate gates", () => {
    const output = execFileSync("node", [
      "scripts/native-release-plan.js",
      "--secret-source=env",
      "--platform=all",
    ], { encoding: "utf8", env: nativeSecretEnv() })

    assert.match(output, /Actions vs Signed Release Diagnosis/)
    assert.match(output, /Public repository Actions and native signing are separate gates/)
    assert.match(output, /Signed release status: `blocked-missing-signing-secrets`/)
    assert.match(output, /Release Gate Summary/)
    assert.match(output, /Gate status: `owner-action-required`/)
    assert.match(output, /Workflow: `Native signed release packages`/)
    assert.match(output, /Blocked platforms: `android`, `ios`, `macos`, `windows`/)
    assert.match(output, /GitHub Actions can run CI and QA workflows in the public repository/)
    assert.match(output, /Configure the missing native signing and store-upload secret names/)
    assert.match(output, /`android_release_status`: `draft`/)
    assert.doesNotMatch(output, /NORMAL_MAILBOX_PASSWORD_SHOULD_NOT_APPEAR/)
  })

  it("reports ready status from environment presence without printing secret values", () => {
    const envValues = Object.fromEntries(
      nativeSecretNames.map((name) => [name, `DO_NOT_LEAK_${name}`]),
    )
    const output = execFileSync("node", [
      "scripts/native-release-plan.js",
      "--secret-source=env",
      "--platform=all",
      "--json",
    ], { encoding: "utf8", env: nativeSecretEnv(envValues) })
    const plan = JSON.parse(output) as {
      status: string
      statusReason: string
      releaseGateSummary: { status: string; readyPlatforms: string[]; blockedPlatforms: string[] }
      actionsVsSigningDiagnosis: { signedReleaseStatus: string }
      missingSecrets: string[]
    }

    assert.equal(plan.status, "ready")
    assert.equal(plan.statusReason, "all-native-signing-secrets-configured")
    assert.equal(plan.releaseGateSummary.status, "ready-to-run-signed-release")
    assert.deepEqual(plan.releaseGateSummary.readyPlatforms, ["android", "ios", "macos", "windows"])
    assert.deepEqual(plan.releaseGateSummary.blockedPlatforms, [])
    assert.equal(plan.actionsVsSigningDiagnosis.signedReleaseStatus, "ready-to-run")
    assert.deepEqual(plan.missingSecrets, [])
    assert.doesNotMatch(output, /DO_NOT_LEAK_/)
  })
})
