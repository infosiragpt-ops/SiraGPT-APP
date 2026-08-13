import assert from "node:assert/strict"
import test from "node:test"
import {
  findMobileRelease,
  parseMobilePlatform,
  resolveMobileRelease,
  type GitHubMobileRelease,
} from "../lib/mobile-releases"

const KNOWN_FALLBACK_APK =
  "https://github.com/infosiragpt-ops/SiraGPT-APP/releases/download/native-mobile-qa-v0.4.4-92849df/SiraGPT-92849df-debug.apk"

const releases: GitHubMobileRelease[] = [
  {
    tag_name: "native-mobile-qa-v0.4.4-92849df",
    html_url: "https://github.com/example/releases/native-mobile-qa-v0.4.4-92849df",
    published_at: "2026-07-23T03:01:40Z",
    draft: false,
    prerelease: true,
    assets: [
      { name: "SiraGPT-92849df-debug.apk", browser_download_url: "https://github.com/example/apk", size: 4117570 },
      { name: "SiraGPT-92849df-signed-release.aab", browser_download_url: "https://github.com/example/aab", size: 3024915 },
      { name: "SiraGPT-92849df-ios-simulator-app.zip", browser_download_url: "https://github.com/example/sim", size: 1580575 },
      { name: "SHA256SUMS.txt", browser_download_url: "https://github.com/example/checksums", size: 297 },
    ],
  },
  {
    tag_name: "desktop-beta-v0.4.4-92849df",
    html_url: "https://github.com/example/releases/desktop-beta-v0.4.4-92849df",
    published_at: "2026-07-23T04:00:00Z",
    draft: false,
    prerelease: true,
    assets: [
      { name: "SiraGPT-0.4.4-arm64.dmg", browser_download_url: "https://github.com/example/dmg", size: 121964048 },
    ],
  },
]

test("mobile release resolver maps a QA tag with an APK asset to a download URL", () => {
  const apk = findMobileRelease(releases, "android-apk")
  assert.equal(apk?.releaseTag, "native-mobile-qa-v0.4.4-92849df")
  assert.equal(apk?.fileName, "SiraGPT-92849df-debug.apk")
  assert.equal(apk?.downloadUrl, "https://github.com/example/apk")
  assert.equal(apk?.version, "0.4.4")
  assert.equal(apk?.checksumUrl, "https://github.com/example/checksums")
  assert.equal(apk?.pageUrl, "https://siragpt.com/descargas#android")
  assert.equal(apk?.signed, false)
})

test("mobile release resolver exposes the signed AAB as a separate Play Console platform", () => {
  const aab = findMobileRelease(releases, "android-aab")
  assert.equal(aab?.fileName, "SiraGPT-92849df-signed-release.aab")
  assert.equal(aab?.downloadUrl, "https://github.com/example/aab")
  assert.equal(aab?.signed, true)
})

test("mobile release resolver returns null when no release carries an APK", () => {
  const desktopOnly = releases.filter((release) => release.tag_name.startsWith("desktop-beta-"))
  assert.equal(findMobileRelease(desktopOnly, "android-apk"), null)
})

test("mobile release resolver skips drafts and picks the newest published APK", () => {
  const older = { ...releases[0], tag_name: "native-mobile-qa-v0.4.3-aaaaaaa", published_at: "2026-07-01T00:00:00Z" }
  const draft = { ...releases[0], tag_name: "native-mobile-qa-v0.4.5-draft", published_at: "2026-08-01T00:00:00Z", draft: true }
  const release = findMobileRelease([older, draft, releases[0]], "android-apk")
  assert.equal(release?.releaseTag, "native-mobile-qa-v0.4.4-92849df")
})

test("mobile release resolver prefers known mobile tag families on publish-time ties", () => {
  const publishedAt = "2026-07-23T03:01:40Z"
  const unknownTag: GitHubMobileRelease = {
    ...releases[0],
    tag_name: "misc-experiment-v9",
    published_at: publishedAt,
    assets: [{ name: "SiraGPT-exp.apk", browser_download_url: "https://github.com/example/exp", size: 1 }],
  }
  const signedTag: GitHubMobileRelease = {
    ...releases[0],
    tag_name: "native-android-signed-v0.4.4-92849df",
    published_at: publishedAt,
    assets: [{ name: "SiraGPT-92849df.apk", browser_download_url: "https://github.com/example/signed", size: 2 }],
  }
  const release = findMobileRelease([unknownTag, signedTag], "android-apk")
  assert.equal(release?.releaseTag, "native-android-signed-v0.4.4-92849df")
})

test("mobile platform query values fail closed", () => {
  assert.equal(parseMobilePlatform("android"), "android-apk")
  assert.equal(parseMobilePlatform("apk"), "android-apk")
  assert.equal(parseMobilePlatform("android-apk"), "android-apk")
  assert.equal(parseMobilePlatform("aab"), "android-aab")
  assert.equal(parseMobilePlatform("android-aab"), "android-aab")
  assert.equal(parseMobilePlatform("ios"), null)
  assert.equal(parseMobilePlatform("windows"), null)
  assert.equal(parseMobilePlatform(null), null)
})

test("mobile release resolution falls back to the known public APK when GitHub is unreachable", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    throw new Error("network_down")
  }) as typeof fetch
  try {
    const release = await resolveMobileRelease("android-apk")
    assert.equal(release?.downloadUrl, KNOWN_FALLBACK_APK)
    assert.equal(release?.releaseTag, "native-mobile-qa-v0.4.4-92849df")
  } finally {
    globalThis.fetch = originalFetch
  }
})
