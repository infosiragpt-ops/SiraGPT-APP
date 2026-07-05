import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

describe("Native readiness GitHub Actions source", () => {
  it("passes the Google Play upload secret into the env-based readiness plan", () => {
    const workflow = readFileSync(".github/workflows/native-readiness-report.yml", "utf8")
    const planStep = workflow.slice(workflow.indexOf("- name: Generate non-secret readiness plan"))

    assert.match(planStep, /GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64:\s*\$\{\{\s*secrets\.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64\s*\}\}/)
    assert.match(planStep, /npm run native:release:plan:ci/)
  })
})
