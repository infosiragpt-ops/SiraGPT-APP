import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

describe("generate-native-owner-handoff", () => {
  it("generates a non-secret mobile owner handoff", () => {
    const dir = mkdtempSync(join(tmpdir(), "siragpt-native-handoff-"))

    try {
      const mdOut = join(dir, "handoff.md")
      const jsonOut = join(dir, "handoff.json")
      const stdout = execFileSync("node", [
        "scripts/generate-native-owner-handoff.js",
        "--platform=mobile",
        "--repo=infosiragpt-ops/SiraGPT-APP",
        `--out=${mdOut}`,
        `--json-out=${jsonOut}`,
        "--json",
      ], { encoding: "utf8" })

      const handoff = JSON.parse(stdout) as {
        status: string
        latestQaRelease: { tag: string; targetSha: string }
        latestTraceabilityCommit: { sha: string }
        latestVerifiedRuns: { docker?: string }
        platformPlans: Array<{ key: string; allSecrets: string[]; dryRunCommand: string }>
      }
      const markdown = readFileSync(mdOut, "utf8")
      const json = readFileSync(jsonOut, "utf8")

      assert.equal(handoff.status, "owner-action-required")
      assert.equal(handoff.latestQaRelease.tag, "native-qa-v0.4.3-0fb0493")
      assert.equal(handoff.latestQaRelease.targetSha, "0fb0493464b841c11924e9ff9a087209fb8d25dd")
      assert.equal(handoff.latestTraceabilityCommit.sha, "498374abc6dab1861170fb35bd0595fb4f1e56f7")
      assert.equal(handoff.latestVerifiedRuns.docker, "28726202674")
      assert.deepEqual(handoff.platformPlans.map((plan) => plan.key), ["android", "ios"])
      assert.ok(handoff.platformPlans[0].allSecrets.includes("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64"))
      assert.ok(handoff.platformPlans[1].allSecrets.includes("APP_STORE_CONNECT_API_KEY_BASE64"))
      assert.match(handoff.platformPlans[0].dryRunCommand, /--platform=android --dry-run/)

      for (const contents of [stdout, markdown, json]) {
        assert.doesNotMatch(contents, /BEGIN (RSA|OPENSSH|PRIVATE) KEY/)
        assert.doesNotMatch(contents, /sk-[A-Za-z0-9_-]{20,}/)
      }
      assert.match(markdown, /Do not use the normal mailbox password as native signing material/)
      assert.match(markdown, /Latest Repository Validation/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
