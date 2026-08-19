import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"

const runtime = require(path.join(process.cwd(), "apps/desktop/runtime.cjs")) as {
  DEFAULT_APP_URL: string
  compareVersions: (left: string, right: string) => number
  deepLinkToAppUrl: (value: string) => string | null
  navigationDisposition: (value: string, options?: { allowLocalhost?: boolean }) => string
  normaliseAppUrl: (value?: string, options?: { allowLocalhost?: boolean }) => string
  releasePlatform: (platform: string, arch: string) => string | null
}

test("desktop runtime opens the authenticated chat by default", () => {
  assert.equal(runtime.DEFAULT_APP_URL, "https://siragpt.com/chat")
  assert.equal(runtime.normaliseAppUrl("https://evil.example/path"), runtime.DEFAULT_APP_URL)
  assert.equal(runtime.normaliseAppUrl("http://127.0.0.1:3000", { allowLocalhost: true }), "http://127.0.0.1:3000/")
  assert.equal(runtime.normaliseAppUrl("http://127.0.0.1:3000"), runtime.DEFAULT_APP_URL)
})

test("desktop navigation distinguishes app, OAuth, external, and blocked URLs", () => {
  assert.equal(runtime.navigationDisposition("https://siragpt.com/chat"), "app")
  assert.equal(runtime.navigationDisposition("https://api.siragpt.com/api/auth/google"), "app")
  assert.equal(runtime.navigationDisposition("https://accounts.google.com/o/oauth2/v2/auth"), "oauth")
  assert.equal(runtime.navigationDisposition("https://github.com/SiraGPT-ORg"), "external")
  assert.equal(runtime.navigationDisposition("javascript:alert(1)"), "blocked")
})

test("desktop deep links only target allowlisted SiraGPT screens", () => {
  assert.equal(runtime.deepLinkToAppUrl("siragpt://chat/abc?source=desktop"), "https://siragpt.com/chat/abc?source=desktop")
  assert.equal(runtime.deepLinkToAppUrl("siragpt://settings"), "https://siragpt.com/settings")
  assert.equal(runtime.deepLinkToAppUrl("siragpt://admin"), null)
  assert.equal(runtime.deepLinkToAppUrl("siragpt://chat/%2e%2e/settings"), null)
  assert.equal(runtime.deepLinkToAppUrl("https://siragpt.com/chat"), null)
})

test("desktop update comparison and platform mapping are deterministic", () => {
  assert.equal(runtime.compareVersions("0.4.4", "0.4.3"), 1)
  assert.equal(runtime.compareVersions("v0.4.3", "0.4.3"), 0)
  assert.equal(runtime.compareVersions("0.4.2", "0.4.3"), -1)
  assert.equal(runtime.releasePlatform("darwin", "arm64"), "macos-arm64")
  assert.equal(runtime.releasePlatform("darwin", "x64"), "macos-x64")
  assert.equal(runtime.releasePlatform("win32", "x64"), "windows-x64")
  assert.equal(runtime.releasePlatform("linux", "x64"), null)
})
