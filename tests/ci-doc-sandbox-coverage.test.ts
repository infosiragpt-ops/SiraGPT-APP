import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

const workflow = readFileSync(".github/workflows/ci.yml", "utf8")
const { scripts } = JSON.parse(readFileSync("backend/package.json", "utf8")) as {
  scripts: Record<string, string>
}

function jobSource(name: string): string {
  const marker = `\n  ${name}:`
  const start = workflow.indexOf(marker)
  assert.notEqual(start, -1, `missing CI job: ${name}`)
  const tailStart = start + marker.length
  const next = workflow.slice(tailStart).search(/\n  [\w-]+:\n/)
  return workflow.slice(start, next < 0 ? undefined : tailStart + next)
}

function backendStep(name: string): string {
  const backend = jobSource("backend")
  const marker = `      - name: ${name}`
  const start = backend.indexOf(marker)
  assert.notEqual(start, -1, `missing mandatory backend step: ${name}`)
  const next = backend.indexOf("\n      - name:", start + marker.length)
  return backend.slice(start, next < 0 ? undefined : next)
}

describe("document sandbox strict coverage release gate", () => {
  it("runs the 80 percent check as a blocking step in a required job", () => {
    const step = backendStep("Document sandbox strict unit coverage (80% hard gate)")
    assert.match(step, /^\s*if: matrix\.shard == 1\s*$/m)
    assert.match(step, /^\s*NODE_ENV: test\s*$/m)
    assert.match(step, /^\s*run: npm run test:doc-sandbox:coverage\s*$/m)
    assert.doesNotMatch(step, /continue-on-error|\|\|\s*true/)
    const gate = jobSource("ci")
    assert.match(gate, /needs:\s*\[[^\]]*\bbackend\b[^\]]*\]/)
    assert.match(gate, /needs\.backend\.result/)
    const backend = jobSource("backend")
    assert.doesNotMatch(backend, /^    continue-on-error:/m)
    const shards = backend.match(/^        shard: \[([^\]]+)\]/m)
    assert.ok(shards, "backend matrix must explicitly include coverage shard 1")
    assert.ok(shards[1].split(",").map(value => Number(value.trim())).includes(1))
  })

  it("retains every module source and excludes auxiliary and integration executions from the unit metric", () => {
    const command = scripts["test:doc-sandbox:coverage"]
    assert.match(command, /^c8 --all --src src\/modules\/doc-sandbox /)
    assert.match(command, /--include 'src\/modules\/doc-sandbox\/\*\*\/\*\.ts'/)
    assert.match(command, /--check-coverage --lines 80 npm run test:doc-sandbox:unit$/)
    assert.doesNotMatch(command, /--exclude(?:=|\s)|--per-file|\|\|/)
    assert.doesNotMatch(scripts["test:doc-sandbox:unit"], /auxiliary|\.integration\.|model-policy\.test|validation-lifecycle\.test|persistence\.queue/)
    assert.match(scripts["test:doc-sandbox:unit"], /tests\/doc-sandbox-lease-policy\.test\.ts(?:\s|$)/)
    assert.match(scripts["test:doc-sandbox:unit"], /tests\/doc-sandbox-attempt-budget\.test\.ts(?:\s|$)/)
    assert.match(scripts["test:doc-sandbox:auxiliary"], /doc-sandbox-validation-lifecycle\.test\.ts/)
    assert.match(backendStep("Document sandbox contracts and real database/queue tests"), /npm run test:doc-sandbox:auxiliary/)
  })

  it("retains the distinct unit report even when the threshold fails", () => {
    const step = backendStep("Upload document sandbox strict coverage")
    assert.match(step, /^\s*if: matrix\.shard == 1 && always\(\)\s*$/m)
    assert.match(step, /uses: actions\/upload-artifact@v6/)
    assert.match(step, /^\s*path: backend\/coverage\/doc-sandbox-unit\/coverage-summary\.json\s*$/m)
    assert.match(step, /^\s*if-no-files-found: error\s*$/m)
    assert.match(step, /^\s*retention-days: 14\s*$/m)
    assert.doesNotMatch(step, /coverage\/tmp|\.env|server\.log/)
  })

  it("runs the real failed-diff oracle as a document check without folding it into unit coverage", () => {
    const command = scripts["test:doc-sandbox:documents"]
    assert.match(command, /(?:^|&&\s*)node --import tsx --test tests\/doc-sandbox-failure-evidence-validator\.test\.ts(?:\s*&&|$)/)
    assert.doesNotMatch(command, /\|\|\s*true|--test-skip-pattern/)
    assert.doesNotMatch(scripts["test:doc-sandbox:unit"], /failure-evidence-validator/)
    const step = backendStep("Document sandbox contracts and real database/queue tests")
    assert.match(step, /npm run test:doc-sandbox:documents/)
    assert.doesNotMatch(step, /continue-on-error|\|\|\s*true/)
  })
})
