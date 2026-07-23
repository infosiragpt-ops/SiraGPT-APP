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
  distributionMilestone: {
    title: string
    url: string
    status: string
    openIssues: number
    closedIssues: number
    issues: Array<{
      number: number
      title: string
      url: string
      scope: string
    }>
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
  latestSignedAndroidRelease: {
    tag: string
    url: string
    run: string
    runUrl: string
    sourceSha: string
    status: string
    createGithubRelease: boolean
    googlePlayUpload: string
    aab: {
      name: string
      kind: string
      size: number
      sha256: string
    }
    releaseAssets: string[]
    verification: string
  }
  latestOwnerPacket: {
    sourceSha: string
    sourceCommit: string
    releaseTag: string
    zipName: string
    zipUrl: string
    checksumName: string
    checksumUrl: string
    checksumSha256: string
  }
  latestSecretAudit: {
    checkedAt: string
    status: string
  }
}

describe("native release status traceability", () => {
  it("keeps the latest signed Android release, owner packet, and current wrapper validation traceable", () => {
    const status = JSON.parse(
      readFileSync("docs/store-submission/native-release-status.json", "utf8"),
    ) as NativeReleaseStatus
    const signedAndroidShortSha = status.latestSignedAndroidRelease.sourceSha.slice(0, 7)
    const currentWrapperShortSha = status.latestCurrentProductionValidation.sourceSha.slice(0, 7)
    const ownerPacketStem = status.latestOwnerPacket.zipName
      .replace(/^SiraGPT-native-store-owner-packet-/, "")
      .replace(/\.zip$/, "")

    assert.equal(status.latestTraceabilityCommit.sha, status.latestTraceabilityCommit.validatedManagementSha)
    assert.equal(status.latestTraceabilityCommit.message, status.latestTraceabilityCommit.validatedManagementCommit)
    assert.equal(status.distributionMilestone.title, "Native Store Distribution v0.4.4")
    assert.match(status.distributionMilestone.url, /\/milestone\/1$/)
    assert.equal(status.distributionMilestone.status, "open")
    assert.equal(status.distributionMilestone.openIssues, 5)
    assert.equal(status.distributionMilestone.closedIssues, 0)
    assert.deepEqual(
      status.distributionMilestone.issues.map((issue) => issue.number),
      [4, 5, 6, 7, 8],
    )
    assert.deepEqual(
      status.distributionMilestone.issues.map((issue) => issue.scope),
      ["parent-tracker", "android-googleplay", "ios-appstore", "macos", "windows"],
    )
    for (const issue of status.distributionMilestone.issues) {
      assert.match(issue.url, new RegExp(`/issues/${issue.number}$`))
      assert.ok(issue.title.length > 0)
    }

    assert.match(status.latestSignedAndroidRelease.tag, /^native-android-signed-/)
    assert.match(status.latestSignedAndroidRelease.url, /\/releases\/tag\/native-android-signed-/)
    assert.match(status.latestSignedAndroidRelease.run, /^\d+$/)
    assert.match(status.latestSignedAndroidRelease.runUrl, /\/actions\/runs\/\d+$/)
    assert.match(status.latestSignedAndroidRelease.sourceSha, /^[a-f0-9]{40}$/)
    assert.equal(status.latestSignedAndroidRelease.status, "verified-signed-android-aab")
    assert.equal(status.latestSignedAndroidRelease.createGithubRelease, true)
    assert.equal(status.latestSignedAndroidRelease.googlePlayUpload, "skipped-owner-service-account-missing")
    assert.equal(status.latestSignedAndroidRelease.aab.name, `SiraGPT-${signedAndroidShortSha}.aab`)
    assert.equal(status.latestSignedAndroidRelease.aab.kind, "play-aab")
    assert.ok(status.latestSignedAndroidRelease.aab.size > 0)
    assert.match(status.latestSignedAndroidRelease.aab.sha256, /^[a-f0-9]{64}$/)
    assert.ok(status.latestSignedAndroidRelease.releaseAssets.includes(status.latestSignedAndroidRelease.aab.name))
    assert.ok(status.latestSignedAndroidRelease.releaseAssets.includes("SHA256SUMS.txt"))
    assert.ok(status.latestSignedAndroidRelease.releaseAssets.includes("native-release-manifest.json"))
    assert.ok(status.latestSignedAndroidRelease.releaseAssets.includes("preflight.json"))
    assert.match(status.latestSignedAndroidRelease.verification, /OK/)

    assert.equal(status.latestOwnerPacket.sourceSha, status.latestSignedAndroidRelease.sourceSha)
    assert.equal(status.latestOwnerPacket.releaseTag, status.latestSignedAndroidRelease.tag)
    assert.match(ownerPacketStem, /^[a-f0-9]{7,8}$/)
    assert.ok(status.latestOwnerPacket.sourceSha.startsWith(ownerPacketStem))
    assert.equal(status.latestOwnerPacket.zipName, `SiraGPT-native-store-owner-packet-${ownerPacketStem}.zip`)
    assert.equal(status.latestOwnerPacket.checksumName, `SiraGPT-native-store-owner-packet-${ownerPacketStem}.zip.sha256`)
    assert.match(status.latestOwnerPacket.zipUrl, new RegExp(`/releases/download/${status.latestOwnerPacket.releaseTag}/`))
    assert.match(status.latestOwnerPacket.checksumUrl, new RegExp(`/releases/download/${status.latestOwnerPacket.releaseTag}/`))
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
    assert.equal(status.latestSignedPreflight.status, "ready-to-run")
    assert.equal(status.latestSignedPreflight.platform, "android")
    assert.equal(status.latestSignedPreflight.artifact.name, "siragpt-native-signed-release-preflight")
    assert.match(status.latestSignedPreflight.artifact.id, /^\d+$/)
    assert.equal(status.latestSignedPreflight.artifact.expired, false)
    assert.ok(status.latestSignedPreflight.artifact.verifiedFiles.includes("preflight.md"))
    assert.ok(status.latestSignedPreflight.artifact.verifiedFiles.includes("preflight.json"))
    assert.equal(
      status.latestSignedPreflight.summarySignals.status,
      "native-signed-preflight-status=ready-to-run",
    )
    assert.equal(status.latestSignedPreflight.summarySignals.platform, "native-signed-preflight-platform=android")
    assert.equal(status.latestSignedPreflight.summarySignals.missingSecrets, "native-signed-preflight-missing-secrets=0")

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
      ) ||
        status.latestCurrentProductionValidation.platforms.android.expectedFiles.includes(
          `SiraGPT-${currentWrapperShortSha}-signed-release.aab`,
        ),
    )
    assert.ok(
      status.latestCurrentProductionValidation.platforms.ios.expectedFiles.includes(
        `SiraGPT-${currentWrapperShortSha}-ios-simulator-app.zip`,
      ),
    )

    assert.equal(status.latestQaRelease.assetCount, status.latestQaRelease.artifacts.length)
    assert.ok(status.latestQaArtifactManifestRuns.releaseAssets.length > 0)

    assert.ok(Date.parse(status.latestSecretAudit.checkedAt) <= Date.parse(status.updatedAt))
    assert.equal(status.latestSecretAudit.status, "blocked-missing-native-signing-secrets")

    for (const value of [
      status.latestTraceabilityCommit.message,
      status.latestCurrentProductionValidation.sourceCommit,
      status.latestOwnerPacket.sourceCommit,
      status.latestOwnerPacket.zipName,
      status.latestOwnerPacket.checksumName,
      status.latestOwnerPacket.releaseTag,
      status.latestSignedAndroidRelease.tag,
      status.latestSignedAndroidRelease.aab.name,
      status.latestSignedPreflight.artifact.name,
    ]) {
      assert.doesNotMatch(value, /Siragpt\d+/i)
    }
  })
})
