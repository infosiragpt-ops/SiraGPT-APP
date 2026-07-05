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
      latestSecretAudit: { status: string; diagnosis: string }
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
        platformArtifacts: Record<string, string[]>
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
          platformArtifacts: Record<string, string[]>
        }
        latestSignedPreflight: { run: string; sourceSha: string; status: string }
        latestSecretAudit: { status: string; diagnosis: string }
        latestVerifiedRuns: { docker?: string }
        platformPlans: Array<{ key: string; allSecrets: string[]; dryRunCommand: string }>
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
      assert.match(handoff.latestActionsDiagnostics.diagnosis, /Public repository Actions are enabled/)
      assert.equal(handoff.latestQaArtifactManifestRuns.status, status.latestQaArtifactManifestRuns.status)
      assert.equal(handoff.latestQaArtifactManifestRuns.mobileRun, status.latestQaArtifactManifestRuns.mobileRun)
      assert.equal(handoff.latestQaArtifactManifestRuns.desktopRun, status.latestQaArtifactManifestRuns.desktopRun)
      assert.deepEqual(handoff.latestQaArtifactManifestRuns.platformArtifacts.android, status.latestQaArtifactManifestRuns.platformArtifacts.android)
      assert.equal(handoff.latestSignedPreflight.run, status.latestSignedPreflight.run)
      assert.equal(handoff.latestSignedPreflight.sourceSha, status.latestSignedPreflight.sourceSha)
      assert.equal(handoff.latestSignedPreflight.status, status.latestSignedPreflight.status)
      assert.equal(handoff.latestSecretAudit.status, status.latestSecretAudit.status)
      assert.match(handoff.latestSecretAudit.diagnosis, /Public repository Actions are running/)
      assert.equal(handoff.latestVerifiedRuns.docker, status.latestVerifiedRuns.docker)
      assert.deepEqual(handoff.platformPlans.map((plan) => plan.key), ["android", "ios"])
      assert.ok(handoff.platformPlans[0].allSecrets.includes("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64"))
      assert.ok(handoff.platformPlans[1].allSecrets.includes("APP_STORE_CONNECT_API_KEY_BASE64"))
      assert.match(handoff.platformPlans[0].dryRunCommand, /--platform=android --dry-run/)

      for (const contents of [stdout, markdown, json]) {
        assert.doesNotMatch(contents, /BEGIN (RSA|OPENSSH|PRIVATE) KEY/)
        assert.doesNotMatch(contents, /sk-[A-Za-z0-9_-]{20,}/)
      }
      assert.match(markdown, /Do not use the normal mailbox password as native signing material/)
      assert.match(markdown, /Latest QA Artifact Manifest Verification/)
      assert.match(markdown, /Latest Native Artifact Validation/)
      assert.match(markdown, /Latest GitHub Actions Diagnostics/)
      assert.match(markdown, /Latest Signed Release Preflight/)
      assert.match(markdown, /Latest Secret-Name Audit/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
