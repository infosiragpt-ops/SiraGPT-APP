import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

function cleanNativeEnv(values: Record<string, string> = {}) {
  const env = { ...process.env }
  for (const name of nativeSecretNames) {
    delete env[name]
  }
  return {
    ...env,
    PLATFORM: "all",
    RELEASE_TAG: "native-v0.4.3-test",
    GITHUB_REPOSITORY: "infosiragpt-ops/SiraGPT-APP",
    GITHUB_SHA: "abc123456789",
    GITHUB_RUN_ID: "12345",
    GITHUB_SERVER_URL: "https://github.com",
    UPLOAD_IOS_APP_STORE_CONNECT: "false",
    UPLOAD_ANDROID_GOOGLE_PLAY: "false",
    ANDROID_RELEASE_STATUS: "draft",
    ANDROID_USER_FRACTION: "",
    ...values,
  }
}

function runPreflight(env: NodeJS.ProcessEnv) {
  try {
    return {
      status: 0,
      stdout: execFileSync("node", ["scripts/native-release-preflight-summary.js"], {
        encoding: "utf8",
        env,
      }),
    }
  } catch (error) {
    const execError = error as { status?: number; stdout?: Buffer | string }
    return {
      status: execError.status ?? 1,
      stdout: execError.stdout?.toString() || "",
    }
  }
}

describe("native-release-preflight-summary", () => {
  it("is wired into the signed native release workflow", () => {
    const workflow = readFileSync(".github/workflows/native-release.yml", "utf8")
    const preflightStep = workflow.slice(workflow.indexOf("- name: Validate selected signing secrets"))

    assert.match(preflightStep, /RELEASE_TAG:\s*\$\{\{\s*inputs\.release_tag\s*\}\}/)
    assert.match(preflightStep, /npm run native:version:check/)
    assert.match(preflightStep, /npm run native:release:preflight/)
    assert.doesNotMatch(preflightStep, /npm run native:readiness -- --require="\$groups"/)
  })

  it("writes an actionable missing-secret summary without secret values", () => {
    const dir = mkdtempSync(join(tmpdir(), "siragpt-native-preflight-"))
    const summaryPath = join(dir, "summary.md")

    try {
      const result = runPreflight(cleanNativeEnv({
        GITHUB_STEP_SUMMARY: summaryPath,
      }))
      const summary = readFileSync(summaryPath, "utf8")

      assert.equal(result.status, 1)
      assert.match(result.stdout, /native-signed-preflight-status=blocked-missing-signing-secrets/)
      assert.match(summary, /Status: `blocked-missing-signing-secrets`/)
      assert.match(summary, /GitHub Actions is running this workflow/)
      assert.match(summary, /`ANDROID_KEYSTORE_BASE64`/)
      assert.match(summary, /`IOS_SIGNING_CERTIFICATE_BASE64`/)
      assert.match(summary, /`MACOS_CERTIFICATE_BASE64`/)
      assert.match(summary, /`WINDOWS_CERTIFICATE_BASE64`/)
      assert.doesNotMatch(summary, /DO_NOT_LEAK/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("passes when selected platform secrets are present without printing values", () => {
    const dir = mkdtempSync(join(tmpdir(), "siragpt-native-preflight-ready-"))
    const summaryPath = join(dir, "summary.md")

    try {
      const result = runPreflight(cleanNativeEnv({
        PLATFORM: "android",
        GITHUB_STEP_SUMMARY: summaryPath,
        ANDROID_KEYSTORE_BASE64: "DO_NOT_LEAK_KEYSTORE",
        ANDROID_KEYSTORE_PASSWORD: "DO_NOT_LEAK_STORE_PASSWORD",
        ANDROID_KEY_ALIAS: "DO_NOT_LEAK_ALIAS",
        ANDROID_KEY_PASSWORD: "DO_NOT_LEAK_KEY_PASSWORD",
      }))
      const summary = readFileSync(summaryPath, "utf8")

      assert.equal(result.status, 0)
      assert.match(result.stdout, /native-signed-preflight-status=ready-to-run/)
      assert.match(summary, /Status: `ready-to-run`/)
      assert.match(summary, /\| `android` \| `ready` \| none \|/)
      assert.doesNotMatch(result.stdout, /DO_NOT_LEAK/)
      assert.doesNotMatch(summary, /DO_NOT_LEAK/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("reports invalid upload input before platform jobs are launched", () => {
    const dir = mkdtempSync(join(tmpdir(), "siragpt-native-preflight-invalid-"))
    const summaryPath = join(dir, "summary.md")

    try {
      const result = runPreflight(cleanNativeEnv({
        PLATFORM: "windows",
        UPLOAD_ANDROID_GOOGLE_PLAY: "true",
        GITHUB_STEP_SUMMARY: summaryPath,
      }))
      const summary = readFileSync(summaryPath, "utf8")

      assert.equal(result.status, 2)
      assert.match(result.stdout, /native-signed-preflight-status=invalid-workflow-input/)
      assert.match(summary, /upload_android_google_play requires platform android or all/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
