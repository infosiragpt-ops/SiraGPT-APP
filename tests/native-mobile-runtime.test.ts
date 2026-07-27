import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

describe("Native mobile runtime", () => {
  it("opens the primary chat instead of the marketing landing page", () => {
    const config = readFileSync("capacitor.config.ts", "utf8")
    const metadata = JSON.parse(
      readFileSync("docs/store-submission/native-store-metadata.json", "utf8"),
    ) as { app?: { webRuntimeUrl?: string } }

    assert.match(
      config,
      /CAPACITOR_SERVER_URL\?\.trim\(\)\s*\|\|\s*"https:\/\/siragpt\.com\/chat"/,
    )
    assert.equal(metadata.app?.webRuntimeUrl, "https://siragpt.com/chat")
    assert.match(config, /allowNavigation:\s*\["siragpt\.com",\s*"www\.siragpt\.com"\]/)
  })
})
