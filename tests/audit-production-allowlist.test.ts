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
  it("allows a permanently empty exception list, not an exception without expiry", () => {
    const empty = writeConfig({ level: "high", allowed: [] })
    assert.equal(auditAllowlist.readConfig(empty).allowed.size, 0)
    const missingExpiry = writeConfig({ level: "high", allowed: [{ package: "sharp", source: 1124066 }] })
    assert.throws(() => auditAllowlist.readConfig(missingExpiry), /invalid expiresOn/)
  })

  it("loads a non-expired allowlist with severity rank and exact advisory keys", () => {
    const file = writeConfig({
      level: "high",
      expiresOn: "2026-08-31",
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
      expiresOn: "2099-08-31",
      allowed: [{ package: "next", source: 1112653 }],
    })
    const invalidEntry = writeConfig({
      level: "high",
      expiresOn: "2099-08-31",
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

function validAuditReport() {
  return {
    auditReportVersion: 2,
    vulnerabilities: {} as Record<string, any>,
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
      dependencies: { prod: 10, total: 10 },
    },
  }
}

describe("audit-production-allowlist process and schema gate", () => {
  it("accepts a real zero report shape, preserving its original metadata", () => {
    const report = validAuditReport()
    let args: string[] = []
    const actual = auditAllowlist.runAudit({ run: (_command: string, commandArgs: string[]) => {
      args = commandArgs
      return { status: 0, stdout: JSON.stringify(report) }
    } })
    assert.deepEqual(actual, report)
    assert.deepEqual(args, ["audit", "--omit=dev", "--json"])
  })

  it("rejects network errors, signals and all exit codes outside 0/1 even with valid JSON", () => {
    const stdout = JSON.stringify(validAuditReport())
    for (const result of [undefined, { status: 2, stdout }, { status: null, stdout },
      { status: 0, stdout, error: new Error("ENETUNREACH") }, { status: 1, stdout, signal: "SIGTERM" }]) {
      assert.throws(() => auditAllowlist.runAudit({ run: () => result }), /process failed|interrupted/)
    }
  })

  it("rejects missing/invalid JSON and npm error objects instead of collecting an empty success", () => {
    for (const stdout of ["", "not JSON", "null", "[]", "{}", JSON.stringify({ error: { code: "ENOTFOUND" } }),
      JSON.stringify({ ...validAuditReport(), error: {} })]) {
      assert.throws(() => auditAllowlist.runAudit({ run: () => ({ status: 0, stdout }) }))
    }
  })

  it("rejects missing schema, malformed counts and severity totals inconsistent with the findings", () => {
    for (const report of [
      { ...validAuditReport(), vulnerabilities: undefined }, { ...validAuditReport(), metadata: {} },
      { ...validAuditReport(), metadata: { vulnerabilities: {} } }, { ...validAuditReport(), auditReportVersion: 1 },
    ]) assert.throws(() => auditAllowlist.runAudit({ run: () => ({ status: 0, stdout: JSON.stringify(report) }) }))
    const wrongCount = validAuditReport()
    wrongCount.metadata.vulnerabilities.high = 1; wrongCount.metadata.vulnerabilities.total = 1
    assert.throws(() => auditAllowlist.runAudit({ run: () => ({ status: 1, stdout: JSON.stringify(wrongCount) }) }), /counts do not match/)
    assert.throws(() => auditAllowlist.runAudit({ run: () => ({ status: 1, stdout: JSON.stringify(validAuditReport()) }) }), /failed without reporting/)
  })

  it("never grants the backend image-size patch exception to root/frontend dependencies", () => {
    const report = validAuditReport()
    report.vulnerabilities["image-size"] = {
      name: "image-size", severity: "high", nodes: ["node_modules/image-size"],
      via: [{ name: "image-size", dependency: "image-size", source: 1138808, severity: "high",
        title: "Synthetic image advisory", url: "https://github.com/advisories/GHSA-w3rx-r6r6-pgpr" }],
    }
    report.metadata.vulnerabilities.high = 1; report.metadata.vulnerabilities.total = 1
    let calls = 0
    const actual = auditAllowlist.runAudit({ run: () => { calls++; return { status: 1, stdout: JSON.stringify(report) } } })
    const findings = auditAllowlist.collectFindings(actual, { minRank: 3, allowed: new Set() })
    assert.equal(calls, 1, "frontend audit must not invoke or trust the backend patch verifier")
    assert.equal(findings.blocked.length, 1)
    assert.deepEqual(findings.accepted, [])
    assert.equal(actual.metadata.vulnerabilities.high, 1)
  })
})
