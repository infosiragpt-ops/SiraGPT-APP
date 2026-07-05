import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

type NativeReleaseStatus = {
  updatedAt: string
  latestQaRelease: {
    assetCount: number
    artifacts: string[]
  }
  latestQaArtifactManifestRuns: {
    releaseAssets: string[]
  }
  latestVerifiedRuns: {
    ci: string
    readiness: string
  }
  latestTraceabilityCommit: {
    sha: string
    message: string
    validatedManagementSha: string
    validatedManagementCommit: string
    validatedManagementRuns: {
      ci: string
      readiness: string
    }
  }
  latestActionsDiagnostics: {
    ciRun: string
    readinessRun: string
  }
  latestOwnerPacket: {
    sourceSha: string
    sourceCommit: string
    zipName: string
    checksumName: string
    checksumSha256: string
  }
  latestSecretAudit: {
    checkedAt: string
    status: string
  }
}

describe("native release status traceability", () => {
  it("keeps the latest owner packet aligned with the current green management commit", () => {
    const status = JSON.parse(
      readFileSync("docs/store-submission/native-release-status.json", "utf8"),
    ) as NativeReleaseStatus
    const shortSha = status.latestTraceabilityCommit.sha.slice(0, 8)

    assert.equal(status.latestTraceabilityCommit.sha, status.latestTraceabilityCommit.validatedManagementSha)
    assert.equal(status.latestTraceabilityCommit.message, status.latestTraceabilityCommit.validatedManagementCommit)
    assert.equal(status.latestOwnerPacket.sourceSha, status.latestTraceabilityCommit.sha)
    assert.equal(status.latestOwnerPacket.sourceCommit, status.latestTraceabilityCommit.message)
    assert.equal(status.latestOwnerPacket.zipName, `SiraGPT-native-store-owner-packet-${shortSha}.zip`)
    assert.equal(status.latestOwnerPacket.checksumName, `SiraGPT-native-store-owner-packet-${shortSha}.zip.sha256`)
    assert.match(status.latestOwnerPacket.checksumSha256, /^[a-f0-9]{64}$/)

    assert.equal(status.latestVerifiedRuns.ci, status.latestTraceabilityCommit.validatedManagementRuns.ci)
    assert.equal(status.latestVerifiedRuns.readiness, status.latestTraceabilityCommit.validatedManagementRuns.readiness)
    assert.equal(status.latestActionsDiagnostics.ciRun, status.latestVerifiedRuns.ci)
    assert.equal(status.latestActionsDiagnostics.readinessRun, status.latestVerifiedRuns.readiness)

    assert.equal(status.latestQaRelease.assetCount, status.latestQaRelease.artifacts.length)
    assert.ok(status.latestQaRelease.artifacts.includes(status.latestOwnerPacket.zipName))
    assert.ok(status.latestQaRelease.artifacts.includes(status.latestOwnerPacket.checksumName))
    assert.ok(status.latestQaArtifactManifestRuns.releaseAssets.includes(status.latestOwnerPacket.zipName))
    assert.ok(status.latestQaArtifactManifestRuns.releaseAssets.includes(status.latestOwnerPacket.checksumName))

    assert.equal(status.latestSecretAudit.checkedAt, status.updatedAt)
    assert.equal(status.latestSecretAudit.status, "blocked-missing-native-signing-secrets")

    for (const value of [
      status.latestTraceabilityCommit.message,
      status.latestOwnerPacket.sourceCommit,
      status.latestOwnerPacket.zipName,
      status.latestOwnerPacket.checksumName,
    ]) {
      assert.doesNotMatch(value, /Siragpt\d+/i)
    }
  })
})
