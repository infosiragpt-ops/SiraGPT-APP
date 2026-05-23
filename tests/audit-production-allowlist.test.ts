import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"

const auditAllowlist = require(path.join(
  process.cwd(),
  "scripts/audit-production-allowlist.js",
))

function writeConfig(config: unknown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "siragpt-audit-allowlist-"))
  const file = path.join(dir, "audit-production-allowlist.json")
  fs.writeFileSync(file, JSON.stringify(config, null, 2))
  return file
}

describe("audit-production-allowlist config", () => {
  it("loads a non-expired allowlist with severity rank and exact advisory keys", () => {
    const file = writeConfig({
      level: "high",
      expiresOn: "2026-07-31",
      allowed: [{ package: "next", source: 1112653 }],
    })

    const config = auditAllowlist.readConfig(file, new Date("2026-06-01T00:00:00.000Z"))

    assert.equal(config.level, "high")
    assert.equal(config.minRank, auditAllowlist.RANK.get("high"))
    assert.equal(config.allowed.has("next:1112653"), true)
  })

  it("rejects expired allowlists so temporary exceptions cannot become permanent", () => {
    const file = writeConfig({
      level: "high",
      expiresOn: "2026-01-31",
      allowed: [{ package: "next", source: 1112653 }],
    })

    assert.throws(
      () => auditAllowlist.readConfig(file, new Date("2026-02-01T00:00:00.000Z")),
      /expired on 2026-01-31/,
    )
  })

  it("rejects malformed severity levels and advisory entries", () => {
    const invalidLevel = writeConfig({
      level: "severe",
      expiresOn: "2026-07-31",
      allowed: [{ package: "next", source: 1112653 }],
    })
    const invalidEntry = writeConfig({
      level: "high",
      expiresOn: "2026-07-31",
      allowed: [{ package: "next", source: "1112653" }],
    })

    assert.throws(() => auditAllowlist.readConfig(invalidLevel), /unsupported audit allowlist level/)
    assert.throws(() => auditAllowlist.readConfig(invalidEntry), /package and numeric source/)
  })
})

describe("audit-production-allowlist findings", () => {
  it("separates allowlisted advisories from new blocking high severity advisories", () => {
    const report = {
      vulnerabilities: {
        next: {
          via: [
            {
              source: 1112653,
              severity: "high",
              title: "Known Next advisory",
              url: "https://github.com/advisories/GHSA-example",
            },
            {
              source: 9999999,
              severity: "critical",
              title: "New critical advisory",
            },
            {
              source: 2222222,
              severity: "moderate",
              title: "Below configured threshold",
            },
            "postcss",
          ],
        },
      },
    }
    const config = {
      level: "high",
      minRank: auditAllowlist.RANK.get("high"),
      allowed: new Set(["next:1112653"]),
    }

    const findings = auditAllowlist.collectFindings(report, config)

    assert.deepEqual(
      findings.accepted.map((finding: any) => finding.key),
      ["next:1112653"],
    )
    assert.deepEqual(
      findings.blocked.map((finding: any) => finding.key),
      ["next:9999999"],
    )
  })

  it("handles empty npm audit reports without false positives", () => {
    const findings = auditAllowlist.collectFindings(
      {},
      {
        level: "high",
        minRank: auditAllowlist.RANK.get("high"),
        allowed: new Set(),
      },
    )

    assert.deepEqual(findings, { accepted: [], blocked: [] })
  })
})
