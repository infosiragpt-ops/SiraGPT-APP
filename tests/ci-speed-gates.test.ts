import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { describe, it } from "node:test"

// Contract for the faster CI layout (2026-09-26): parallel jobs and shards
// must never silently drop a gate or a spec.
const workflow = readFileSync(".github/workflows/ci.yml", "utf8")

function jobSource(id: string): string {
  const start = workflow.indexOf(`\n  ${id}:\n`)
  assert.notEqual(start, -1, `CI workflow must define the ${id} job`)
  const rest = workflow.slice(start + 1)
  const next = rest.slice(1).search(/\n  [a-z0-9-]+:\n/)
  return next === -1 ? rest : rest.slice(0, next + 1)
}

// The critical specs the single dev-server gate ran before the split.
const CRITICAL_SPECS = [
  "e2e/chat.spec.ts",
  "e2e/chat-upload.spec.ts",
  "e2e/chat-composer-stable-size.spec.ts",
  "e2e/document-artifact-consistency.spec.ts",
  "e2e/document-task-error-recovery.spec.ts",
  "e2e/chat-integrated-browser.spec.ts",
  "e2e/chat-browser-live-progress.spec.ts",
  "e2e/chat-computer-login-handoff.spec.ts",
  "e2e/voice-reference-layout.spec.ts",
  "e2e/chat-code-workspace.spec.ts",
  "e2e/chat-media-preview-players.spec.ts",
]

describe("fast CI layout", () => {
  it("cancels superseded pull-request runs only — never production-main pushes", () => {
    assert.match(workflow, /^concurrency:\n  group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}\n(?:  #.*\n)*  cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}\n/m)
  })

  it("runs every critical spec exactly once across the e2e shards, on a production build", () => {
    const e2e = jobSource("e2e-critical")
    const specs = Array.from(e2e.matchAll(/^\s+specs: (.+)$/gm), (m) => m[1].trim().split(/\s+/)).flat()
    assert.deepEqual([...specs].sort(), [...CRITICAL_SPECS].sort(), "each critical spec in exactly one shard")
    assert.equal(new Set(specs).size, specs.length, "no spec runs in two shards")
    for (const spec of specs) readFileSync(spec, "utf8")
    assert.match(e2e, /npx next build --no-lint/)
    // npx skips the npm prebuild hook that installs Monaco into public/.
    assert.match(e2e, /node scripts\/prepare-code-editor\.cjs\n\s*npx next build --no-lint/)
    assert.match(e2e, /npx next start --port 3005/)
    assert.doesNotMatch(e2e, /npm run dev -- --port/, "no dev-server gate")
    assert.match(e2e, /NEXT_PUBLIC_AGENT_COMPUTER: '1'/)
    assert.match(e2e, /NEXT_PUBLIC_API_URL: \/api/)
    assert.doesNotMatch(e2e, /continue-on-error/)
    // The real-desktop gate runs in exactly one shard and only retries the
    // Chrome-CDP-startup infrastructure failure.
    assert.equal((e2e.match(/desktop_gate: true/g) || []).length, 1)
    assert.match(e2e, /grep -q 'desktop Chrome must start its CDP endpoint'/)
    const gate = jobSource("ci")
    assert.match(gate, /needs\.e2e-critical\.result/)
  })

  it("covers every backend test bucket exactly once (shard 1: 1/7, shards 2–4: 2/7)", () => {
    const backend = jobSource("backend")
    assert.match(backend, /bash scripts\/test-shard\.sh 1 7/)
    assert.match(backend, /bash scripts\/test-shard\.sh \$\(\( 2 \* \$\{\{ matrix\.shard \}\} - 2 \)\) 7/)
    assert.match(backend, /bash scripts\/test-shard\.sh \$\(\( 2 \* \$\{\{ matrix\.shard \}\} - 1 \)\) 7/)
    const shards = backend.match(/^        shard: \[([^\]]+)\]/m)
    assert.ok(shards)
    const ids = shards[1].split(",").map((v) => Number(v.trim()))
    const buckets = new Set<number>([1])
    for (const k of ids.filter((v) => v !== 1)) { buckets.add(2 * k - 2); buckets.add(2 * k - 1) }
    assert.deepEqual([...buckets].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7])
  })

  it("keeps the informational smoke off pull requests but on pushes", () => {
    const smoke = jobSource("e2e")
    assert.match(smoke, /if: github\.event_name != 'pull_request'/)
    assert.match(smoke, /continue-on-error: true/)
  })

  it("audits dependencies on every push/nightly and on PRs that change them; retries only transport failures", () => {
    for (const id of ["dependency-audit", "security-audit"]) {
      const job = jobSource(id)
      assert.match(job, /fetch-depth: 2/, `${id} needs the merge parent to diff the PR`)
      assert.match(job, /id: deps/)
      assert.match(job, /if \[ "\$\{\{ github\.event_name \}\}" != "pull_request" \]; then\n\s+echo "changed=true"/,
        `${id}: every non-PR event audits`)
      assert.match(job, /package-lock\.json backend\/package\.json backend\/package-lock\.json/)
      const audits = job.match(/if: steps\.deps\.outputs\.changed == 'true'/g) || []
      assert.ok(audits.length >= 2, `${id}: audit steps are gated on the deps check`)
    }
    const nightly = readFileSync(".github/workflows/nightly-dependency-audit.yml", "utf8")
    assert.match(nightly, /schedule:\n\s+- cron:/)
    assert.match(nightly, /ref: production-main/)
    assert.match(nightly, /npm run audit:production/)
    assert.match(nightly, /node scripts\/audit-backend-production\.cjs/)
  })

  it("keeps every e2e spec file referenced by the critical gate on disk", () => {
    const onDisk = new Set(readdirSync("e2e").map((f) => `e2e/${f}`))
    for (const spec of CRITICAL_SPECS) assert.ok(onDisk.has(spec), `${spec} exists`)
  })
})
