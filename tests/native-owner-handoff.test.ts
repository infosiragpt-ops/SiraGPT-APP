import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

describe("generate-native-owner-handoff", () => {
  it("generates a non-secret mobile owner handoff", () => {
    const dir = mkdtempSync(join(tmpdir(), "siragpt-native-handoff-"))
    const status = JSON.parse(readFileSync("docs/store-submission/native-release-status.json", "utf8")) as {
      latestQaRelease: { tag: string; targetSha: string }
      latestTraceabilityCommit: { sha: string }
      latestSignedPreflight: { run: string; sourceSha: string; status: string }
      latestHistoricalSignedAndroidRelease?: {
        tag: string
        sourceSha: string
        status: string
        playUploadCompatible: boolean
      }
      latestSecretAudit: { status: string; diagnosis: string }
      distributionMilestone: {
        title: string
        url: string
        openIssues: number
        closedIssues: number
        issues: Array<{ number: number; title: string; url: string; scope: string }>
      }
      latestActionsDiagnostics: {
        repoVisibility: string
        isPrivate: boolean
        actionsEnabled: boolean
        allowedActions: string
        ciRun: string
        readinessRun: string
        diagnosis: string
      }
      latestQaArtifactManifestRuns: {
        status: string
        mobileRun: string
        desktopRun: string
        workflowPlatformArtifacts: Record<string, string[]>
        publicReleasePlatformArtifacts: Record<string, string[]>
      }
      latestVerifiedRuns: { docker?: string }
    }

    try {
      const mdOut = join(dir, "handoff.md")
      const jsonOut = join(dir, "handoff.json")
      const stdout = execFileSync("node", [
        "scripts/generate-native-owner-handoff.js",
        "--platform=mobile",
        "--repo=infosiragpt-ops/SiraGPT-APP",
        `--out=${mdOut}`,
        `--json-out=${jsonOut}`,
        "--json",
      ], { encoding: "utf8" })

      const handoff = JSON.parse(stdout) as {
        status: string
        latestQaRelease: { tag: string; targetSha: string }
        latestTraceabilityCommit: { sha: string }
        latestActionsDiagnostics: {
          repoVisibility: string
          isPrivate: boolean
          actionsEnabled: boolean
          allowedActions: string
          ciRun: string
          readinessRun: string
          diagnosis: string
        }
        latestQaArtifactManifestRuns: {
          status: string
          mobileRun: string
          desktopRun: string
          workflowPlatformArtifacts: Record<string, string[]>
          publicReleasePlatformArtifacts: Record<string, string[]>
        }
        latestSignedPreflight: { run: string; sourceSha: string; status: string }
        latestHistoricalSignedAndroidRelease?: {
          tag: string
          sourceSha: string
          status: string
          playUploadCompatible: boolean
        }
        latestSecretAudit: { status: string; diagnosis: string }
        distributionMilestone: {
          title: string
          url: string
          openIssues: number
          closedIssues: number
          issues: Array<{ number: number; title: string; url: string; scope: string }>
        }
        latestVerifiedRuns: { docker?: string }
        ownerAccount: {
          email: string
          status: string
          requiredSecurityActions: string[]
          storePortals: Array<{ platform: string; portal: string; requiredOutput: string }>
        }
        platformPlans: Array<{
          key: string
          allSecrets: string[]
          dryRunCommand: string
          uploadDryRunCommand: string
          uploadSetupCommand: string
        }>
      }
      const markdown = readFileSync(mdOut, "utf8")
      const json = readFileSync(jsonOut, "utf8")

      assert.equal(handoff.status, "owner-action-required")
      assert.equal(handoff.latestQaRelease.tag, status.latestQaRelease.tag)
      assert.equal(handoff.latestQaRelease.targetSha, status.latestQaRelease.targetSha)
      assert.equal(handoff.latestTraceabilityCommit.sha, status.latestTraceabilityCommit.sha)
      assert.equal(handoff.latestActionsDiagnostics.repoVisibility, "PUBLIC")
      assert.equal(handoff.latestActionsDiagnostics.isPrivate, false)
      assert.equal(handoff.latestActionsDiagnostics.actionsEnabled, true)
      assert.equal(handoff.latestActionsDiagnostics.allowedActions, "all")
      assert.equal(handoff.latestActionsDiagnostics.ciRun, status.latestActionsDiagnostics.ciRun)
      assert.equal(handoff.latestActionsDiagnostics.readinessRun, status.latestActionsDiagnostics.readinessRun)
      assert.match(handoff.latestActionsDiagnostics.diagnosis, /GitHub Actions are enabled and green/)
      assert.match(handoff.latestActionsDiagnostics.diagnosis, /certificate mismatch/)
      assert.equal(handoff.latestQaArtifactManifestRuns.status, status.latestQaArtifactManifestRuns.status)
      assert.equal(handoff.latestQaArtifactManifestRuns.mobileRun, status.latestQaArtifactManifestRuns.mobileRun)
      assert.equal(handoff.latestQaArtifactManifestRuns.desktopRun, status.latestQaArtifactManifestRuns.desktopRun)
      assert.deepEqual(
        handoff.latestQaArtifactManifestRuns.workflowPlatformArtifacts.android,
        status.latestQaArtifactManifestRuns.workflowPlatformArtifacts.android,
      )
      assert.deepEqual(
        handoff.latestQaArtifactManifestRuns.publicReleasePlatformArtifacts.android,
        status.latestQaArtifactManifestRuns.publicReleasePlatformArtifacts.android,
      )
      assert.equal(handoff.latestSignedPreflight.run, status.latestSignedPreflight.run)
      assert.equal(handoff.latestSignedPreflight.sourceSha, status.latestSignedPreflight.sourceSha)
      assert.equal(handoff.latestSignedPreflight.status, status.latestSignedPreflight.status)
      if (status.latestHistoricalSignedAndroidRelease) {
        assert.equal(
          handoff.latestHistoricalSignedAndroidRelease?.tag,
          status.latestHistoricalSignedAndroidRelease.tag,
        )
        assert.equal(
          handoff.latestHistoricalSignedAndroidRelease?.sourceSha,
          status.latestHistoricalSignedAndroidRelease.sourceSha,
        )
        assert.equal(
          handoff.latestHistoricalSignedAndroidRelease?.status,
          status.latestHistoricalSignedAndroidRelease.status,
        )
        assert.equal(handoff.latestHistoricalSignedAndroidRelease?.playUploadCompatible, false)
      }
      assert.equal(handoff.latestSecretAudit.status, status.latestSecretAudit.status)
      assert.match(
        handoff.latestSecretAudit.diagnosis,
        /Android package-signing|Native app signing|native signing|deployment secrets only/,
      )
      assert.match(handoff.latestSecretAudit.diagnosis, /not compatible with the current Google Play/)
      assert.equal(handoff.distributionMilestone.title, status.distributionMilestone.title)
      assert.equal(handoff.distributionMilestone.url, status.distributionMilestone.url)
      assert.equal(handoff.distributionMilestone.openIssues, 5)
      assert.equal(handoff.distributionMilestone.closedIssues, 0)
      assert.deepEqual(
        handoff.distributionMilestone.issues.map((issue) => issue.number),
        [4, 5, 6, 7, 8],
      )
      assert.ok(handoff.distributionMilestone.issues.some((issue) => issue.scope === "android-googleplay"))
      assert.ok(handoff.distributionMilestone.issues.some((issue) => issue.scope === "ios-appstore"))
      assert.ok(handoff.distributionMilestone.issues.some((issue) => issue.scope === "macos"))
      assert.ok(handoff.distributionMilestone.issues.some((issue) => issue.scope === "windows"))
      assert.equal(handoff.latestVerifiedRuns.docker, status.latestVerifiedRuns.docker)
      assert.equal(handoff.ownerAccount.email, "infosiragpt@gmail.com")
      assert.equal(handoff.ownerAccount.status, "rotation-required-before-store-use")
      assert.ok(handoff.ownerAccount.requiredSecurityActions.some((action) => action.includes("Rotate the mailbox password")))
      assert.ok(handoff.ownerAccount.storePortals.some((portal) => portal.platform === "Android / Google Play"))
      assert.ok(handoff.ownerAccount.storePortals.some((portal) => portal.platform === "iPhone / App Store Connect"))
      assert.deepEqual(handoff.platformPlans.map((plan) => plan.key), ["android", "ios"])
      assert.ok(handoff.platformPlans[0].allSecrets.includes("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64"))
      assert.ok(handoff.platformPlans[1].allSecrets.includes("APP_STORE_CONNECT_API_KEY_BASE64"))
      assert.match(handoff.platformPlans[0].dryRunCommand, /--platform=android --dry-run/)
      assert.match(handoff.platformPlans[0].uploadDryRunCommand, /--platform=googleplay --dry-run/)
      assert.match(handoff.platformPlans[1].uploadSetupCommand, /--platform=appstore/)

      for (const contents of [stdout, markdown, json]) {
        assert.doesNotMatch(contents, /BEGIN (RSA|OPENSSH|PRIVATE) KEY/)
        assert.doesNotMatch(contents, /sk-[A-Za-z0-9_-]{20,}/)
        assert.doesNotMatch(contents, /Siragpt\d+/i)
      }
      assert.match(markdown, /Store Owner Account/)
      assert.match(markdown, /Owner mailbox: `infosiragpt@gmail.com`/)
      assert.match(markdown, /Rotate the mailbox password before using it for store-console setup/)
      assert.match(markdown, /mailbox password must never be copied into GitHub Actions secrets/)
      assert.match(markdown, /Do not use the normal mailbox password as native signing material/)
      assert.match(markdown, /Latest QA Artifact Manifest Verification/)
      assert.match(markdown, /Latest GitHub Actions Diagnostics/)
      assert.match(markdown, /Latest Signed Release Preflight/)
      assert.match(markdown, /Historical Signed Android Release \(Not Play-Compatible\)/)
      assert.match(markdown, /Play upload compatible: `false`/)
      assert.match(markdown, /Latest Secret-Name Audit/)
      assert.match(markdown, /Distribution Work Queue/)
      assert.match(markdown, /Native Store Distribution v0\.4\.4/)
      assert.match(markdown, /#5 Android \/ Google Play publishing owner actions/)
      assert.match(markdown, /#6 iPhone \/ App Store Connect signing and upload owner actions/)
      assert.match(markdown, /#7 macOS Developer ID signing and notarization owner actions/)
      assert.match(markdown, /#8 Windows code signing and Microsoft Store owner actions/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
