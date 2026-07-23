import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

describe("Signed native release workflow integrity", () => {
  const workflow = readFileSync(".github/workflows/native-release.yml", "utf8")

  it("verifies signed artifacts before publishing them", () => {
    assert.match(workflow, /name: Android signed AAB \+ APK/)
    assert.match(workflow, /:app:bundleRelease :app:assembleRelease/)
    assert.match(workflow, /SiraGPT-\$\{short_sha\}\.apk/)
    assert.match(workflow, /name: Verify Android artifact signatures/)
    assert.match(workflow, /jarsigner -verify -verbose -certs/)
    assert.match(workflow, /apksigner.*verify --verbose --print-certs/)
    assert.match(workflow, /name: Verify macOS signature and notarization/)
    assert.match(workflow, /xcrun stapler validate/)
    assert.match(workflow, /codesign --verify --deep --strict/)
    assert.match(workflow, /name: Verify Windows Authenticode signatures/)
    assert.match(workflow, /Get-AuthenticodeSignature/)
    assert.match(workflow, /signature\.Status -ne "Valid"/)
    assert.match(workflow, /exported_bundle_id.*com\.siragpt\.app/)
  })

  it("publishes both Android store and directly installable release artifacts", () => {
    assert.match(workflow, /output\/native-release\/android\/\*\.aab/)
    assert.match(workflow, /output\/native-release\/android\/\*\.apk/)
    assert.match(workflow, /aab_path=.*name '\*\.aab'/)
    assert.doesNotMatch(workflow, /--aab=\$apk_path/)
  })

  it("removes temporary mobile signing assets even after failures", () => {
    assert.match(workflow, /name: Remove Android signing assets/)
    assert.match(workflow, /rm -f android\/keystore\.properties/)
    assert.match(workflow, /name: Remove iOS signing assets/)
    assert.match(workflow, /security delete-keychain/)
    assert.match(workflow, /Provisioning Profiles\/\$PROFILE_UUID\.mobileprovision/)

    const cleanupConditions = workflow.match(/if:\s*\$\{\{\s*always\(\)\s*\}\}/g) || []
    assert.ok(cleanupConditions.length >= 2)
  })

  it("preserves release provenance and normalized artifact names", () => {
    assert.match(workflow, /name: Normalize release artifact names/)
    assert.match(workflow, /normalized_name="\$\{file_name\/\/ \/\.\}"/)
    assert.match(workflow, /Release artifact name collision/)
    assert.match(workflow, /name: Validate release tag provenance/)
    assert.match(workflow, /git\/ref\/tags\/\$\{RELEASE_TAG\}/)
    assert.match(workflow, /tag_target.*!=.*GITHUB_SHA/)
  })
})
