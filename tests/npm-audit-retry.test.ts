import assert from "node:assert/strict"
import path from "node:path"
import { describe, it } from "node:test"

// Resolved from the repo root: the compiled copy of this test runs from .test-dist/.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const retry = require(path.join(process.cwd(), "scripts/lib/npm-audit-retry.cjs"))

describe("npm audit retry (transport failures only)", () => {
  it("retries a transient npm audit failure and returns the later success", () => {
    const sleeps: number[] = []
    let calls = 0
    const result = retry.runWithAuditRetries(() => {
      calls += 1
      if (calls === 1) throw new Error("npm audit failed or was interrupted")
      return "ok"
    }, { sleep: (ms: number) => sleeps.push(ms), log: () => {} })
    assert.equal(result, "ok")
    assert.equal(calls, 2)
    assert.deepEqual(sleeps, [5000])
  })

  it("never retries a real blocked finding (backend or frontend)", () => {
    for (const message of [
      'Unpatched high/critical backend advisories: [{"name":"x"}]',
      "2 unallowlisted production advisories at high+ severity",
    ]) {
      let calls = 0
      assert.throws(() => retry.runWithAuditRetries(() => { calls += 1; throw new Error(message) },
        { sleep: () => { throw new Error("must not sleep") }, log: () => {} }), new RegExp(message.slice(0, 20).replace(/[[\]{}()*+?.\\^$|]/g, "\\$&")))
      assert.equal(calls, 1, message)
    }
  })

  it("gives up after the bounded attempts with the last transport error", () => {
    const sleeps: number[] = []
    let calls = 0
    assert.throws(() => retry.runWithAuditRetries(() => { calls += 1; throw new Error("npm audit produced no JSON output") },
      { sleep: (ms: number) => sleeps.push(ms), log: () => {} }), /produced no JSON/)
    assert.equal(calls, 3)
    assert.deepEqual(sleeps, [5000, 15000])
  })

  it("classifies transport vs finding errors", () => {
    for (const transient of ["npm audit failed or was interrupted", "npm audit produced invalid JSON",
      "failed to parse npm audit JSON", "Unsupported or failed npm audit report", "npm audit failed without reporting findings"]) {
      assert.equal(retry.isTransientAuditError(new Error(transient)), true, transient)
    }
    assert.equal(retry.isTransientAuditError(new Error("Unpatched high/critical backend advisories: []")), false)
  })

  it("uses a 120 s npm audit timeout by default, env-overridable and clamped", () => {
    assert.equal(retry.auditTimeoutMs({}), 120000)
    assert.equal(retry.auditTimeoutMs({ SIRAGPT_NPM_AUDIT_TIMEOUT_MS: "180000" }), 180000)
    assert.equal(retry.auditTimeoutMs({ SIRAGPT_NPM_AUDIT_TIMEOUT_MS: "5" }), 120000)
    assert.equal(retry.auditTimeoutMs({ SIRAGPT_NPM_AUDIT_TIMEOUT_MS: "9999999" }), 600000)
  })
})
