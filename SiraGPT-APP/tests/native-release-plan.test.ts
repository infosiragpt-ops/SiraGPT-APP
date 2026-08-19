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
    assert.match(output, /Signed package status: `blocked-missing-signing-secrets`/)
    assert.match(output, /Store upload status: `blocked-missing-store-upload-secrets`/)
    assert.match(output, /Release Gate Summary/)
    assert.match(output, /Gate status: `owner-action-required`/)
    assert.match(output, /Workflow: `Native signed release packages`/)
    assert.match(output, /End-to-end blocked: `android`, `ios`, `macos`, `windows`/)
    assert.match(output, /Signed-package blocked: `android`, `ios`, `macos`, `windows`/)
    assert.match(output, /`upload_android_google_play`: `false`/)
    assert.match(output, /GitHub Actions can run CI and QA workflows in the public repository/)
    assert.match(output, /Configure the missing platform-signing secret names/)
    assert.match(output, /`android_release_status`: `draft`/)
    assert.match(output, /Alternative Store package: unsigned AppX with exact Partner Center identity/)
    assert.match(output, /`WINDOWS_STORE_IDENTITY_NAME`/)
    assert.match(output, /AppX builds do not require the Windows EXE signing certificate/)
    assert.doesNotMatch(output, /NORMAL_MAILBOX_PASSWORD_SHOULD_NOT_APPEAR/)
  })

  it("keeps signed Android package generation ready when only Play upload is blocked", () => {
    const androidSigningValues = Object.fromEntries(
      nativeSecretNames
        .filter((name) => name.startsWith("ANDROID_"))
        .map((name) => [name, `DO_NOT_LEAK_${name}`]),
    )
    const output = execFileSync("node", [
      "scripts/native-release-plan.js",
      "--secret-source=env",
      "--platform=android",
      "--json",
    ], { encoding: "utf8", env: nativeSecretEnv(androidSigningValues) })
    const plan = JSON.parse(output) as {
      status: string
      releaseGateSummary: {
        readyPlatforms: string[]
        signedPackageReadyPlatforms: string[]
        storeUploadBlockedPlatforms: string[]
      }
      actionsVsSigningDiagnosis: {
        signedReleaseStatus: string
        storeUploadStatus: string
      }
      missingSigningSecrets: string[]
      missingStoreUploadSecrets: string[]
      platformPlans: Array<{
        artifactWorkflowInputs: Record<string, string>
        storeWorkflowInputs: Record<string, string>
      }>
    }

    assert.equal(plan.status, "blocked")
    assert.deepEqual(plan.releaseGateSummary.readyPlatforms, [])
    assert.deepEqual(plan.releaseGateSummary.signedPackageReadyPlatforms, ["android"])
    assert.deepEqual(plan.releaseGateSummary.storeUploadBlockedPlatforms, ["android"])
    assert.equal(plan.actionsVsSigningDiagnosis.signedReleaseStatus, "ready-to-run")
    assert.equal(plan.actionsVsSigningDiagnosis.storeUploadStatus, "blocked-missing-store-upload-secrets")
    assert.deepEqual(plan.missingSigningSecrets, [])
    assert.deepEqual(plan.missingStoreUploadSecrets, ["GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64"])
    assert.equal(plan.platformPlans[0].artifactWorkflowInputs.upload_android_google_play, "false")
    assert.equal(plan.platformPlans[0].storeWorkflowInputs.upload_android_google_play, "true")
    assert.doesNotMatch(output, /DO_NOT_LEAK_/)
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
      actionsVsSigningDiagnosis: { signedReleaseStatus: string; storeUploadStatus: string }
      missingSecrets: string[]
    }

    assert.equal(plan.status, "ready")
    assert.equal(plan.statusReason, "all-selected-signing-and-store-upload-secrets-configured")
    assert.equal(plan.releaseGateSummary.status, "ready-to-run-signed-release")
    assert.deepEqual(plan.releaseGateSummary.readyPlatforms, ["android", "ios", "macos", "windows"])
    assert.deepEqual(plan.releaseGateSummary.blockedPlatforms, [])
    assert.equal(plan.actionsVsSigningDiagnosis.signedReleaseStatus, "ready-to-run")
    assert.equal(plan.actionsVsSigningDiagnosis.storeUploadStatus, "ready-to-run-draft-upload")
    assert.deepEqual(plan.missingSecrets, [])
    assert.doesNotMatch(output, /DO_NOT_LEAK_/)
  })
})
