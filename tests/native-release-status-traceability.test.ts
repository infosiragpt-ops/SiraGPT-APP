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
    mobile: string
    desktop: string
    ci: string
    readiness: string
  }
  latestCurrentProductionValidation: {
    checkedAt: string
    sourceSha: string
    sourceCommit: string
    status: string
    ciRun: string
    readinessRun: string
    mobileRun: string
    desktopRun: string
    platforms: Record<string, { artifact: string; expectedFiles: string[] }>
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
    mobileRun: string
    desktopRun: string
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
  it("keeps the latest owner packet and current wrapper validation traceable", () => {
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

    assert.equal(status.latestCurrentProductionValidation.status, "green-current-production-main-unsigned-wrapper-builds")
    assert.match(status.latestCurrentProductionValidation.sourceSha, /^[a-f0-9]{40}$/)
    assert.equal(status.latestCurrentProductionValidation.ciRun, status.latestVerifiedRuns.ci)
    assert.equal(status.latestCurrentProductionValidation.readinessRun, status.latestVerifiedRuns.readiness)
    assert.equal(status.latestCurrentProductionValidation.mobileRun, status.latestVerifiedRuns.mobile)
    assert.equal(status.latestCurrentProductionValidation.desktopRun, status.latestVerifiedRuns.desktop)
    assert.equal(status.latestActionsDiagnostics.ciRun, status.latestVerifiedRuns.ci)
    assert.equal(status.latestActionsDiagnostics.readinessRun, status.latestVerifiedRuns.readiness)
    assert.equal(status.latestActionsDiagnostics.mobileRun, status.latestVerifiedRuns.mobile)
    assert.equal(status.latestActionsDiagnostics.desktopRun, status.latestVerifiedRuns.desktop)

    for (const key of ["android", "ios", "macos", "windows"]) {
      assert.ok(status.latestCurrentProductionValidation.platforms[key], `missing ${key} validation`)
      assert.ok(status.latestCurrentProductionValidation.platforms[key].artifact)
      assert.ok(status.latestCurrentProductionValidation.platforms[key].expectedFiles.includes("native-release-manifest.json"))
      assert.ok(status.latestCurrentProductionValidation.platforms[key].expectedFiles.includes("native-release-manifest.md"))
      assert.ok(status.latestCurrentProductionValidation.platforms[key].expectedFiles.includes("SHA256SUMS.txt"))
    }

    assert.equal(status.latestQaRelease.assetCount, status.latestQaRelease.artifacts.length)
    assert.ok(status.latestQaRelease.artifacts.includes(status.latestOwnerPacket.zipName))
    assert.ok(status.latestQaRelease.artifacts.includes(status.latestOwnerPacket.checksumName))
    assert.ok(status.latestQaArtifactManifestRuns.releaseAssets.includes(status.latestOwnerPacket.zipName))
    assert.ok(status.latestQaArtifactManifestRuns.releaseAssets.includes(status.latestOwnerPacket.checksumName))

    assert.ok(Date.parse(status.latestSecretAudit.checkedAt) <= Date.parse(status.updatedAt))
    assert.equal(status.latestSecretAudit.status, "blocked-missing-native-signing-secrets")

    for (const value of [
      status.latestTraceabilityCommit.message,
      status.latestCurrentProductionValidation.sourceCommit,
      status.latestOwnerPacket.sourceCommit,
      status.latestOwnerPacket.zipName,
      status.latestOwnerPacket.checksumName,
    ]) {
      assert.doesNotMatch(value, /Siragpt\d+/i)
    }
  })
})
