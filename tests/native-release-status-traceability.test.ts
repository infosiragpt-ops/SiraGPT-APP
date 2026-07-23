import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

type ReleaseArtifact = {
  name: string
  kind: string
  size: number
  sha256: string
}

type NativeReleaseStatus = {
  schemaVersion: number
  updatedAt: string
  currentCandidate: {
    status: string
    version: string
    sourceSha: string
    branch: string
    runs: Record<string, string>
    distributionGates: Record<string, string>
    accountReadiness: Record<string, string>
  }
  distributionMilestone: {
    title: string
    url: string
    status: string
    openIssues: number
    closedIssues: number
    issues: Array<{ number: number; title: string; url: string; scope: string }>
  }
  latestQaRelease: {
    tag: string
    url: string
    targetSha: string
    assetCount: number
    artifacts: string[]
    publicationTruth: {
      googlePlayPublished: boolean
      appStorePublished: boolean
      containsPlayCompatibleAab: boolean
      containsSignedIpa: boolean
    }
  }
  latestDesktopRelease: {
    tag: string
    url: string
    targetSha: string
    appx: ReleaseArtifact & {
      packageMode: string
      storeSubmissionReady: boolean
      installableDirectly: boolean
    }
    publicationTruth: {
      microsoftStorePublished: boolean
      macosNotarized: boolean
      windowsDirectInstallSigned: boolean
    }
  }
  latestVerifiedRuns: Record<string, string>
  latestCurrentProductionValidation: {
    sourceSha: string
    status: string
    ciRun: string
    readinessRun: string
    mobileRun: string
    desktopRun: string
    platforms: Record<string, { artifact: string; expectedFiles: string[] }>
  }
  latestQaArtifactManifestRuns: {
    sourceSha: string
    status: string
    workflowPlatformArtifacts: Record<string, string[]>
    publicReleasePlatformArtifacts: Record<string, string[]>
    releaseAssets: string[]
  }
  latestTraceabilityCommit: {
    sourceSha: string
    sha: string
    validatedManagementSha: string
    validatedManagementRuns: { ci: string; readiness: string }
  }
  latestActionsDiagnostics: {
    repoVisibility: string
    isPrivate: boolean
    actionsEnabled: boolean
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
    scope: string
    doesNotProveStoreCompatibility: boolean
    platform: string
    artifact: {
      id: string
      name: string
      expired: boolean
      verifiedFiles: string[]
    }
  }
  latestHistoricalSignedAndroidRelease: {
    tag: string
    url: string
    run: string
    runUrl: string
    sourceSha: string
    status: string
    releaseClassification: string
    playUploadCompatible: boolean
    googlePlayUpload: string
    expectedUploadSha1: string
    actualUploadSha1: string
    aab: ReleaseArtifact
    apk: ReleaseArtifact
    historicalReleaseAudit: {
      auditedReleases: number
      prereleases: number
      stableReleases: number
    }
    verification: string
  }
  latestSecretAudit: {
    checkedAt: string
    status: string
    configuredNativeSecrets: string[]
    missingRequiredSecrets: string[]
    missingRepositoryVariables: string[]
  }
}

describe("native release status traceability", () => {
  it("keeps current QA evidence separate from historical non-compatible store artifacts", () => {
    const source = readFileSync("docs/store-submission/native-release-status.json", "utf8")
    const status = JSON.parse(source) as NativeReleaseStatus
    const currentSha = status.currentCandidate.sourceSha
    const currentShortSha = currentSha.slice(0, 7)
    const historical = status.latestHistoricalSignedAndroidRelease

    assert.equal(status.schemaVersion, 2)
    assert.match(status.updatedAt, /^\d{4}-\d{2}-\d{2}T/)
    assert.match(currentSha, /^[a-f0-9]{40}$/)
    assert.equal(status.currentCandidate.branch, "production-main")
    assert.equal(status.currentCandidate.status, "green-qa-artifacts-owner-action-required")

    for (const tracedSha of [
      status.latestQaRelease.targetSha,
      status.latestDesktopRelease.targetSha,
      status.latestCurrentProductionValidation.sourceSha,
      status.latestQaArtifactManifestRuns.sourceSha,
      status.latestTraceabilityCommit.sourceSha,
      status.latestTraceabilityCommit.sha,
      status.latestTraceabilityCommit.validatedManagementSha,
      status.latestSignedPreflight.sourceSha,
    ]) {
      assert.equal(tracedSha, currentSha)
    }

    assert.equal(status.latestQaRelease.tag, `native-mobile-qa-v${status.currentCandidate.version}-${currentShortSha}`)
    assert.equal(status.latestDesktopRelease.tag, `desktop-beta-v${status.currentCandidate.version}-${currentShortSha}`)
    assert.match(status.latestQaRelease.url, new RegExp(`/releases/tag/${status.latestQaRelease.tag}$`))
    assert.match(status.latestDesktopRelease.url, new RegExp(`/releases/tag/${status.latestDesktopRelease.tag}$`))
    assert.equal(status.latestQaRelease.assetCount, status.latestQaRelease.artifacts.length)
    assert.ok(status.latestQaRelease.artifacts.includes("android-upload-certificate-blocker.json"))
    assert.ok(status.latestQaRelease.artifacts.includes(`SiraGPT-${currentShortSha}-debug.apk`))
    assert.ok(status.latestQaRelease.artifacts.includes(`SiraGPT-${currentShortSha}-ios-simulator-app.zip`))
    assert.equal(status.latestQaRelease.artifacts.some((name) => name.endsWith(".aab")), false)
    assert.equal(status.latestQaRelease.artifacts.some((name) => name.endsWith(".ipa")), false)
    assert.deepEqual(status.latestQaRelease.publicationTruth, {
      googlePlayPublished: false,
      appStorePublished: false,
      containsPlayCompatibleAab: false,
      containsSignedIpa: false,
    })

    assert.equal(status.latestDesktopRelease.appx.packageMode, "qa")
    assert.equal(status.latestDesktopRelease.appx.storeSubmissionReady, false)
    assert.equal(status.latestDesktopRelease.appx.installableDirectly, false)
    assert.match(status.latestDesktopRelease.appx.sha256, /^[a-f0-9]{64}$/)
    assert.deepEqual(status.latestDesktopRelease.publicationTruth, {
      microsoftStorePublished: false,
      macosNotarized: false,
      windowsDirectInstallSigned: false,
    })

    assert.equal(status.latestCurrentProductionValidation.status, "green-current-production-main-qa-wrapper-builds")
    assert.equal(
      status.latestQaArtifactManifestRuns.status,
      "verified-current-workflow-artifacts-and-curated-public-qa-assets",
    )
    assert.deepEqual(status.latestQaArtifactManifestRuns.workflowPlatformArtifacts.android, [
      `SiraGPT-${currentShortSha}-debug.apk`,
      `SiraGPT-${currentShortSha}-signed-release.aab`,
    ])
    assert.deepEqual(status.latestQaArtifactManifestRuns.publicReleasePlatformArtifacts.android, [
      "android-upload-certificate-blocker.json",
      `SiraGPT-${currentShortSha}-debug.apk`,
    ])
    assert.equal(
      status.latestQaArtifactManifestRuns.releaseAssets.some((name) => name.endsWith(".aab")),
      false,
    )

    for (const key of ["android", "ios", "macos", "windows"]) {
      const platform = status.latestCurrentProductionValidation.platforms[key]
      assert.ok(platform, `missing ${key} validation`)
      assert.ok(platform.artifact)
      assert.ok(platform.expectedFiles.includes("native-release-manifest.json"))
      assert.ok(platform.expectedFiles.includes("native-release-manifest.md"))
      assert.ok(platform.expectedFiles.includes("SHA256SUMS.txt"))
    }
    assert.ok(
      status.latestCurrentProductionValidation.platforms.android.expectedFiles.includes(
        `SiraGPT-${currentShortSha}-signed-release.aab`,
      ),
    )

    assert.equal(status.latestSignedPreflight.status, "secret-preflight-passed-certificate-gate-failed")
    assert.equal(status.latestSignedPreflight.scope, "secret-names-only")
    assert.equal(status.latestSignedPreflight.doesNotProveStoreCompatibility, true)
    assert.equal(status.latestSignedPreflight.platform, "android")
    assert.match(status.latestSignedPreflight.run, /^\d+$/)
    assert.match(status.latestSignedPreflight.url, /\/actions\/runs\/\d+$/)
    assert.equal(status.latestSignedPreflight.artifact.name, "siragpt-native-signed-release-preflight")
    assert.equal(status.latestSignedPreflight.artifact.expired, false)
    assert.deepEqual(status.latestSignedPreflight.artifact.verifiedFiles, ["preflight.md", "preflight.json"])

    assert.match(historical.tag, /^native-android-signed-/)
    assert.match(historical.url, /\/releases\/tag\/native-android-signed-/)
    assert.match(historical.runUrl, /\/actions\/runs\/\d+$/)
    assert.equal(historical.status, "historical-qa-prerelease-blocked-upload-certificate-mismatch")
    assert.equal(historical.releaseClassification, "prerelease")
    assert.equal(historical.playUploadCompatible, false)
    assert.equal(historical.googlePlayUpload, "blocked-upload-certificate-mismatch")
    assert.notEqual(historical.expectedUploadSha1, historical.actualUploadSha1)
    assert.equal(historical.aab.kind, "historical-signed-aab")
    assert.equal(historical.apk.kind, "historical-release-apk")
    assert.match(historical.aab.sha256, /^[a-f0-9]{64}$/)
    assert.match(historical.apk.sha256, /^[a-f0-9]{64}$/)
    assert.deepEqual(historical.historicalReleaseAudit, {
      auditedReleases: 18,
      prereleases: 18,
      stableReleases: 0,
    })
    assert.match(historical.verification, /must not be uploaded/)

    assert.equal(status.latestActionsDiagnostics.repoVisibility, "PUBLIC")
    assert.equal(status.latestActionsDiagnostics.isPrivate, false)
    assert.equal(status.latestActionsDiagnostics.actionsEnabled, true)
    assert.equal(status.latestActionsDiagnostics.ciRun, status.latestVerifiedRuns.ci)
    assert.equal(status.latestActionsDiagnostics.readinessRun, status.latestVerifiedRuns.readiness)
    assert.equal(status.latestActionsDiagnostics.mobileRun, status.latestVerifiedRuns.mobile)
    assert.equal(status.latestActionsDiagnostics.desktopRun, status.latestVerifiedRuns.desktop)
    assert.equal(status.latestActionsDiagnostics.signedPreflightRun, status.latestSignedPreflight.run)
    assert.equal(status.latestTraceabilityCommit.validatedManagementRuns.ci, status.latestVerifiedRuns.ci)
    assert.equal(
      status.latestTraceabilityCommit.validatedManagementRuns.readiness,
      status.latestVerifiedRuns.readiness,
    )

    assert.equal(status.currentCandidate.runs.androidCertificateGate, status.latestSignedPreflight.run)
    assert.match(status.currentCandidate.distributionGates.googlePlayUpload, /certificate-mismatch/)
    assert.equal(status.currentCandidate.accountReadiness.googlePlay, "unverified-owner-portal-state")
    assert.equal(status.currentCandidate.accountReadiness.appleDeveloper, "unverified-owner-portal-state")
    assert.equal(status.currentCandidate.accountReadiness.microsoftPartnerCenter, "unverified-owner-portal-state")

    assert.equal(status.latestSecretAudit.status, "blocked-owner-store-enrollment-and-native-signing-material")
    assert.ok(status.latestSecretAudit.configuredNativeSecrets.includes("ANDROID_KEYSTORE_BASE64"))
    assert.ok(status.latestSecretAudit.missingRequiredSecrets.includes("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64"))
    assert.ok(status.latestSecretAudit.missingRequiredSecrets.includes("APP_STORE_CONNECT_API_KEY_BASE64"))
    assert.ok(status.latestSecretAudit.missingRequiredSecrets.includes("WINDOWS_CERTIFICATE_BASE64"))
    assert.ok(status.latestSecretAudit.missingRepositoryVariables.includes("WINDOWS_STORE_IDENTITY_NAME"))
    assert.ok(Date.parse(status.latestSecretAudit.checkedAt) <= Date.parse(status.updatedAt))

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

    assert.doesNotMatch(source, /BEGIN (RSA|OPENSSH|PRIVATE) KEY/)
    assert.doesNotMatch(source, /Siragpt\d+/i)
  })
})
