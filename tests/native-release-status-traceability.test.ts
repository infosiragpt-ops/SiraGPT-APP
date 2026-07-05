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
    signedPreflightRun: string
  }
  latestSignedPreflight: {
    run: string
    url: string
    sourceSha: string
    status: string
    platform: string
    artifact: {
      id: string
      name: string
      expired: boolean
      verifiedFiles: string[]
    }
    summarySignals: {
      status: string
      platform: string
      missingSecrets: string
    }
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
    const currentWrapperShortSha = status.latestCurrentProductionValidation.sourceSha.slice(0, 7)

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
    assert.equal(status.latestActionsDiagnostics.ciRun, status.latestTraceabilityCommit.validatedManagementRuns.ci)
    assert.equal(
      status.latestActionsDiagnostics.readinessRun,
      status.latestTraceabilityCommit.validatedManagementRuns.readiness,
    )
    assert.equal(status.latestActionsDiagnostics.mobileRun, status.latestVerifiedRuns.mobile)
    assert.equal(status.latestActionsDiagnostics.desktopRun, status.latestVerifiedRuns.desktop)
    assert.equal(status.latestActionsDiagnostics.signedPreflightRun, status.latestSignedPreflight.run)

    assert.match(status.latestSignedPreflight.run, /^\d+$/)
    assert.match(status.latestSignedPreflight.url, /\/actions\/runs\/\d+$/)
    assert.match(status.latestSignedPreflight.sourceSha, /^[a-f0-9]{40}$/)
    assert.equal(status.latestSignedPreflight.status, "blocked-missing-signing-secrets")
    assert.equal(status.latestSignedPreflight.platform, "all")
    assert.equal(status.latestSignedPreflight.artifact.name, "siragpt-native-signed-release-preflight")
    assert.match(status.latestSignedPreflight.artifact.id, /^\d+$/)
    assert.equal(status.latestSignedPreflight.artifact.expired, false)
    assert.ok(status.latestSignedPreflight.artifact.verifiedFiles.includes("preflight.md"))
    assert.ok(status.latestSignedPreflight.artifact.verifiedFiles.includes("preflight.json"))
    assert.equal(
      status.latestSignedPreflight.summarySignals.status,
      "native-signed-preflight-status=blocked-missing-signing-secrets",
    )
    assert.equal(status.latestSignedPreflight.summarySignals.platform, "native-signed-preflight-platform=all")
    assert.equal(status.latestSignedPreflight.summarySignals.missingSecrets, "native-signed-preflight-missing-secrets=14")

    for (const key of ["android", "ios", "macos", "windows"]) {
      assert.ok(status.latestCurrentProductionValidation.platforms[key], `missing ${key} validation`)
      assert.ok(status.latestCurrentProductionValidation.platforms[key].artifact)
      assert.ok(status.latestCurrentProductionValidation.platforms[key].expectedFiles.includes("native-release-manifest.json"))
      assert.ok(status.latestCurrentProductionValidation.platforms[key].expectedFiles.includes("native-release-manifest.md"))
      assert.ok(status.latestCurrentProductionValidation.platforms[key].expectedFiles.includes("SHA256SUMS.txt"))
    }

    assert.ok(
      status.latestCurrentProductionValidation.platforms.android.expectedFiles.includes(
        `SiraGPT-${currentWrapperShortSha}-debug.apk`,
      ),
    )
    assert.ok(
      status.latestCurrentProductionValidation.platforms.android.expectedFiles.includes(
        `SiraGPT-${currentWrapperShortSha}-unsigned-release.aab`,
      ),
    )
    assert.ok(
      status.latestCurrentProductionValidation.platforms.ios.expectedFiles.includes(
        `SiraGPT-${currentWrapperShortSha}-ios-simulator-app.zip`,
      ),
    )

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
      status.latestSignedPreflight.artifact.name,
    ]) {
      assert.doesNotMatch(value, /Siragpt\d+/i)
    }
  })
})
