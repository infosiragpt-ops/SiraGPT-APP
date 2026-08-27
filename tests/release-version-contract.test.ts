import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"

const ROOT = process.cwd()
const SCRIPT = path.join(ROOT, "scripts", "check-release-version.js")

const gate = require(SCRIPT)

function read(relative: string): string {
  return fs.readFileSync(path.join(ROOT, relative), "utf8")
}

function runScript(args: string[] = []): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      cwd: ROOT,
      encoding: "utf8",
    })
    return { status: 0, stdout, stderr: "" }
  } catch (err: any) {
    return { status: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" }
  }
}

describe("release version ↔ CHANGELOG integrity gate", () => {
  it("gate script exists and is wired into root npm test", () => {
    const pkg = JSON.parse(read("package.json"))
    assert.ok(pkg.scripts.test.includes("check-release-version"))
  })

  it("declares strict semver in root and backend package.json", () => {
    const pkg = JSON.parse(read("package.json"))
    const backend = JSON.parse(read("backend/package.json"))
    assert.match(pkg.version, gate.SEMVER_RE)
    assert.match(backend.version, gate.SEMVER_RE)
  })

  it("collects no findings when versions match released changelog entries", () => {
    const findings = gate.collectFindings()
    const blocking = findings.filter((f: any) => f.id !== "app-unreleased")
    assert.deepEqual(blocking, [], `unexpected findings: ${JSON.stringify(blocking)}`)
  })

  it("flags a version reuse as a regression", () => {
    const pkg = JSON.parse(read("package.json"))
    const releases = [...read("CHANGELOG.md").matchAll(/^## \[(\d+\.\d+\.\d+) \/ backend (\d+\.\d+\.\d+)\]/gm)]
    assert.ok(releases.length >= 2, "expected at least two released versions in CHANGELOG.md")
    const previous = releases[1][1]
    assert.ok(gate.compareSemver(pkg.version, previous) > 0, "declared version must exceed previous release")
  })

  it("compareSemver orders releases correctly", () => {
    assert.ok(gate.compareSemver("0.4.4", "0.4.3") > 0)
    assert.ok(gate.compareSemver("1.0.0", "0.9.9") > 0)
    assert.equal(gate.compareSemver("0.4.3", "0.4.3"), 0)
  })

  it("runs in report mode without failing the suite on current drift", () => {
    const result = runScript()
    assert.equal(result.status, 0, "report mode must exit 0 so adoption does not block CI")
  })
})
