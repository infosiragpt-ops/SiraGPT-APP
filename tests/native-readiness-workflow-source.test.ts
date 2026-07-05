import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

describe("Native readiness GitHub Actions source", () => {
  it("passes the Google Play upload secret into the env-based readiness plan", () => {
    const workflow = readFileSync(".github/workflows/native-readiness-report.yml", "utf8")
    const planStep = workflow.slice(workflow.indexOf("- name: Generate non-secret readiness plan"))

    assert.match(planStep, /GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64:\s*\$\{\{\s*secrets\.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64\s*\}\}/)
    assert.match(planStep, /npm run native:release:plan:ci/)
    assert.match(planStep, /npm run native:github-secrets:report -- --source=env --out=output\/native-github-secrets-report\.md --json-out=output\/native-github-secrets-report\.json/)
    assert.match(planStep, /npm run native:release:handoff -- --out=output\/native-owner-handoff\.md --json-out=output\/native-owner-handoff\.json/)
    assert.match(planStep, /node scripts\/generate-native-store-owner-packet\.js --repo=\$\{\{ github\.repository \}\} --source-sha=\$\{\{ github\.sha \}\} --secret-source=env --json > output\/native-store-owner-packet-summary\.json/)
    assert.match(workflow, /scripts\/generate-native-github-secrets-template\.js/)
    assert.match(workflow, /scripts\/native-github-secrets-report\.js/)
    assert.match(workflow, /output\/native-github-secrets-report\.md/)
    assert.match(workflow, /output\/native-github-secrets-report\.json/)
    assert.match(workflow, /output\/native-owner-handoff\.md/)
    assert.match(workflow, /output\/native-owner-handoff\.json/)
    assert.match(workflow, /output\/native-store-owner-packet-summary\.json/)
    assert.match(workflow, /output\/SiraGPT-native-store-owner-packet-\*\.zip/)
    assert.match(workflow, /output\/SiraGPT-native-store-owner-packet-\*\.zip\.sha256/)
  })
})
