import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

describe("Native QA GitHub Actions artifact manifests", () => {
  it("publishes Android and iOS QA artifacts with checksum manifests", () => {
    const workflow = readFileSync(".github/workflows/native-mobile.yml", "utf8")

    assert.match(workflow, /Stage Android QA artifacts with manifest/)
    assert.match(workflow, /SiraGPT-\$\{short_sha\}-debug\.apk/)
    assert.match(workflow, /SiraGPT-\$\{short_sha\}-\$\{signing_label\}\.aab/)
    assert.match(workflow, /Stage iOS simulator artifact with manifest/)
    assert.match(workflow, /ditto -c -k --sequesterRsrc --keepParent/)
    assert.match(workflow, /SiraGPT-\$\{short_sha\}-ios-simulator-app\.zip/)

    const manifestCalls = workflow.match(/scripts\/generate-native-release-manifest\.js/g) || []
    assert.equal(manifestCalls.length, 2)
    assert.match(workflow, /output\/native-qa\/native-release-manifest\.json/)
    assert.match(workflow, /output\/native-qa\/native-release-manifest\.md/)
    assert.match(workflow, /output\/native-qa\/SHA256SUMS\.txt/)
    assert.match(workflow, /output\/native-qa\/android\/\*/)
    assert.match(workflow, /output\/native-qa\/ios\/\*/)
  })

  it("publishes macOS and Windows QA artifacts with checksum manifests", () => {
    const workflow = readFileSync(".github/workflows/native-desktop.yml", "utf8")

    assert.match(workflow, /Stage macOS QA artifacts with manifest/)
    assert.match(workflow, /output\/native-qa\/macos/)
    assert.match(workflow, /Stage Windows QA artifacts with manifest/)
    assert.match(workflow, /output\/native-qa\/windows/)
    assert.match(workflow, /\$files = Get-ChildItem -Path "output\/desktop" -File/)

    const manifestCalls = workflow.match(/scripts\/generate-native-release-manifest\.js/g) || []
    assert.equal(manifestCalls.length, 3)
    assert.match(workflow, /Publish desktop beta prerelease/)
    assert.match(workflow, /desktop-beta-v\$\{version\}-\$\{short_sha\}/)
    assert.match(workflow, /normalized_name="\$\{file_name\/\/ \/\.\}"/)
    assert.match(workflow, /Release artifact name collision/)
    assert.match(workflow, /mv "\$artifact" "\$normalized_path"/)
    assert.match(workflow, /output\/native-qa\/native-release-manifest\.json/)
    assert.match(workflow, /output\/native-qa\/native-release-manifest\.md/)
    assert.match(workflow, /output\/native-qa\/SHA256SUMS\.txt/)
    assert.match(workflow, /output\/native-qa\/macos\/\*/)
    assert.match(workflow, /output\/native-qa\/windows\/\*/)
  })
})
