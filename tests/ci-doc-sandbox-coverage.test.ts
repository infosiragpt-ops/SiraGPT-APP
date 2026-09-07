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
  it("runs the 81 percent check as a blocking step in a required job", () => {
    const step = backendStep("Document sandbox strict unit coverage (81% hard gate)")
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
    assert.match(command, /--check-coverage --lines 81 npm run test:doc-sandbox:unit$/)
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

  it("requires real provider-reference persistence checks in CI and the isolated runner, outside unit coverage", () => {
    const command = scripts["test:doc-sandbox:persistence"]
    assert.match(command, /tests\/doc-sandbox-engine-reference-retention\.integration\.test\.ts(?:\s|$)/)
    assert.doesNotMatch(command, /\|\|\s*true|--test-skip-pattern/)
    assert.doesNotMatch(scripts["test:doc-sandbox:unit"], /engine-reference-retention/)
    const step = backendStep("Document sandbox contracts and real database/queue tests")
    assert.match(step, /npm run test:doc-sandbox:persistence/)
    assert.doesNotMatch(step, /continue-on-error|\|\|\s*true/)
    const isolated = readFileSync("infra/doc-validation/run-isolated-integration.sh", "utf8")
    assert.match(isolated, /^\s*backend\/tests\/doc-sandbox-engine-reference-retention\.integration\.test\.ts\s*$/m)
  })

  it("requires real private-storage cleanup regressions without counting them as unit coverage", () => {
    const command = scripts["test:doc-sandbox:http-storage"]
    assert.match(command, /tests\/doc-sandbox-cleanup-pagination\.integration\.test\.ts(?:\s|$)/)
    assert.doesNotMatch(command, /\|\|\s*true|--test-skip-pattern/)
    assert.doesNotMatch(scripts["test:doc-sandbox:unit"], /cleanup-pagination/)
    const step = backendStep("Document sandbox real private storage and cleanup")
    assert.match(step, /^\s*if: matrix\.shard == 1\s*$/m)
    assert.match(step, /minio\/minio@sha256:[a-f0-9]{64} server \/data/)
    assert.match(step, /--publish 127\.0\.0\.1:19000:9000/)
    assert.match(step, /trap 'docker stop "\$storage_id" >\/dev\/null' EXIT/)
    assert.match(step, /npm run test:doc-sandbox:http-storage/)
    assert.doesNotMatch(step, /continue-on-error|\|\|\s*true|--privileged|\/var\/run\/docker\.sock/)
    const isolated = readFileSync("infra/doc-validation/run-isolated-integration.sh", "utf8")
    assert.match(isolated, /backend\/tests\/doc-sandbox-cleanup-pagination\.integration\.test\.ts/)
  })

  it("requires independently pinned Python evidence and a bounded real failure-retention suite outside unit coverage", () => {
    assert.match(scripts["test:doc-sandbox:unit"], /tests\/doc-sandbox-failure-evidence-policy\.test\.ts(?:\s|$)/)
    assert.doesNotMatch(scripts["test:doc-sandbox:unit"], /failure-retention\.integration|failure-evidence-bundle/)
    const command = scripts["test:doc-sandbox:failure-retention"]
    assert.match(command, /^node --import tsx --test --test-concurrency=1 tests\/doc-sandbox-failure-retention\.integration\.test\.ts$/)
    assert.doesNotMatch(command, /c8|coverage|\|\||--test-skip-pattern/)

    const step = backendStep("Document sandbox real private storage and cleanup")
    assert.match(step, /mktemp -d/)
    assert.match(step, /realpath "\$failure_bundle_dir"/)
    assert.match(step, /stat -c %a "\$failure_bundle_dir".*= 700/)
    assert.match(step, /failure_bundle_sha=\$\(DOC_SANDBOX_TEST_PYTHON="\$\(command -v python\)"/)
    assert.match(step, /node --import tsx tests\/helpers\/doc-sandbox-failure-evidence-bundle\.ts/)
    assert.match(step, /\[\[ "\$failure_bundle_sha" =~ \^\[a-f0-9\]\{64\}\$ \]\]/)
    assert.match(step, /DOC_SANDBOX_TEST_FAILURE_BUNDLE_PATH="\$failure_bundle_dir\/failure-evidence\.json"/)
    assert.match(step, /DOC_SANDBOX_TEST_FAILURE_BUNDLE_SHA256="\$failure_bundle_sha"/)
    const exportAt = step.indexOf("tests/helpers/doc-sandbox-failure-evidence-bundle.ts")
    const startAt = step.indexOf("storage_id=$(docker run")
    const runAt = step.indexOf("npm run test:doc-sandbox:failure-retention")
    assert.ok(exportAt >= 0 && startAt > exportAt && runAt > startAt,
      "real Python export must precede service startup and the mandatory retention test")
    assert.doesNotMatch(step, /continue-on-error|\|\|\s*true|NODE_V8_COVERAGE|--test-skip-pattern/)

    const integration = readFileSync("backend/tests/doc-sandbox-failure-retention.integration.test.ts", "utf8")
    assert.match(integration, /assert\.ok\(bundlePath && bundleHash,/)
    const verifyAt = integration.indexOf("readVerifiedFailureEvidenceBundle(bundlePath, bundleHash)")
    assert.ok(verifyAt >= 0 && verifyAt < integration.indexOf("await createDocumentIntegrationFixture()"),
      "a missing or unverified bundle must fail before opening the actual services")
    for (const variable of ["DOC_SANDBOX_TEST_FAILURE_BUNDLE_PATH", "DOC_SANDBOX_TEST_FAILURE_BUNDLE_SHA256"]) {
      assert.match(integration, new RegExp(`process\\.env\\.${variable};`), "bundle settings cannot silently default")
    }

    const isolated = readFileSync("infra/doc-validation/run-isolated-failure-retention.sh", "utf8")
    const deadline = isolated.match(/timeout -s TERM -k (\d+) (\d+) docker run/)
    assert.ok(deadline, "the Docker client requires an external TERM/kill bound")
    assert.ok(Number(deadline[1]) > 0 && Number(deadline[1]) <= 15)
    assert.ok(Number(deadline[2]) > 0 && Number(deadline[2]) <= 180)
    assert.match(isolated, /--cidfile "\$runner_state\/id"/)
    assert.match(isolated, /docker inspect "\$target" --format '\{\{\.Id\}\}'/)
    assert.match(isolated, /service_ids\+=\("\$target_id"\)/)
    assert.match(isolated, /for target in "\$\{service_ids\[@\]\}"/)
    assert.match(isolated, /docker stop --time \d+ "\$runner_id"/)
    assert.match(isolated, /for started_id in "\$\{started\[@\]\}"/)
    assert.match(isolated, /docker stop --time \d+ "\$started_id"/)
    assert.match(isolated, /trap cleanup EXIT/)
    assert.match(isolated, /exit "\$original_status"/)
    assert.match(isolated, /DOC_SANDBOX_TEST_FAILURE_BUNDLE_SHA256=\$evidence_sha/)
    assert.doesNotMatch(isolated, /\|\|\s*true|--privileged|\/var\/run\/docker\.sock/)
  })
})
