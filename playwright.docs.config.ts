import { defineConfig } from "@playwright/test"
import base from "./playwright.config"

export default defineConfig({
  ...base,
  testMatch: "**/document-sandbox.spec.ts",
  testIgnore: [],
  retries: 0,
  webServer: undefined, // Both isolated services must already be configured and healthy.
  use: { ...base.use, trace: "off", video: "off", screenshot: "off" },
})
