import assert from "node:assert/strict"
import test from "node:test"
import {
  findDesktopRelease,
  parseDesktopChannel,
  parseDesktopPlatform,
  type GitHubDesktopRelease,
} from "../lib/desktop-releases"

const releases: GitHubDesktopRelease[] = [
  {
    tag_name: "native-v0.4.4",
    html_url: "https://github.com/example/releases/native-v0.4.4",
    published_at: "2026-07-15T10:00:00Z",
    draft: false,
    prerelease: false,
    assets: [
      { name: "SiraGPT-0.4.4-arm64.dmg", browser_download_url: "https://github.com/example/arm64", size: 120 },
      { name: "SiraGPT-0.4.4.dmg", browser_download_url: "https://github.com/example/x64", size: 121 },
      { name: "SiraGPT-Setup-0.4.4.exe", browser_download_url: "https://github.com/example/windows", size: 122 },
      { name: "macos-SHA256SUMS.txt", browser_download_url: "https://github.com/example/mac-checksums", size: 10 },
      { name: "windows-SHA256SUMS.txt", browser_download_url: "https://github.com/example/windows-checksums", size: 10 },
    ],
  },
  {
    tag_name: "native-qa-v0.4.5",
    html_url: "https://github.com/example/releases/native-qa-v0.4.5",
    published_at: "2026-07-15T11:00:00Z",
    draft: false,
    prerelease: true,
    assets: [
      { name: "SiraGPT-0.4.5-arm64.dmg", browser_download_url: "https://github.com/example/beta-arm64", size: 123 },
    ],
  },
]

test("desktop release resolver selects architecture-specific signed assets", () => {
  const arm = findDesktopRelease(releases, "macos-arm64", "stable")
  const intel = findDesktopRelease(releases, "macos-x64", "stable")
  const windows = findDesktopRelease(releases, "windows-x64", "stable")
  assert.equal(arm?.fileName, "SiraGPT-0.4.4-arm64.dmg")
  assert.equal(intel?.fileName, "SiraGPT-0.4.4.dmg")
  assert.equal(windows?.fileName, "SiraGPT-Setup-0.4.4.exe")
  assert.equal(arm?.checksumUrl, "https://github.com/example/mac-checksums")
  assert.equal(windows?.signed, true)
})

test("stable channel excludes prereleases and beta channel can use them", () => {
  assert.equal(findDesktopRelease([releases[1]], "macos-arm64", "stable"), null)
  assert.equal(findDesktopRelease([releases[1]], "macos-arm64", "beta")?.version, "0.4.5")
})

test("desktop release resolver accepts electron-builder Windows names and shared checksums", () => {
  const release: GitHubDesktopRelease = {
    tag_name: "desktop-beta-v0.4.4-a11bc1d",
    html_url: "https://github.com/example/releases/desktop-beta-v0.4.4-a11bc1d",
    published_at: "2026-07-15T23:32:33Z",
    draft: false,
    prerelease: true,
    assets: [
      { name: "SiraGPT.0.4.4.exe", browser_download_url: "https://github.com/example/portable", size: 121 },
      { name: "SiraGPT.Setup.0.4.4.exe", browser_download_url: "https://github.com/example/setup", size: 122 },
      { name: "SHA256SUMS.txt", browser_download_url: "https://github.com/example/checksums", size: 10 },
    ],
  }

  const windows = findDesktopRelease([release], "windows-x64", "beta")
  assert.equal(windows?.fileName, "SiraGPT.Setup.0.4.4.exe")
  assert.equal(windows?.version, "0.4.4")
  assert.equal(windows?.checksumUrl, "https://github.com/example/checksums")
})

test("desktop release query values fail closed", () => {
  assert.equal(parseDesktopChannel("preview"), "stable")
  assert.equal(parseDesktopChannel("beta"), "beta")
  assert.equal(parseDesktopPlatform("macos-x64"), "macos-x64")
  assert.equal(parseDesktopPlatform("windows"), "windows-x64")
  assert.equal(parseDesktopPlatform("linux"), null)
})
