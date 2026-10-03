import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { describe, it } from "node:test"

const workflow = readFileSync(".github/workflows/ci.yml", "utf8")
const vitestConfig = readFileSync("vitest.config.ts", "utf8")
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  scripts?: Record<string, string>
}

function jobSource(id: string): string {
  const start = workflow.indexOf(`\n  ${id}:\n`)
  assert.notEqual(start, -1, `CI workflow must define the ${id} job`)
  const rest = workflow.slice(start + 1)
  const next = rest.slice(1).search(/\n  [a-z0-9-]+:\n/)
  return next === -1 ? rest : rest.slice(0, next + 1)
}

function stepSource(job: string, name: string): string {
  const marker = `      - name: ${name}`
  const start = job.indexOf(marker)
  assert.notEqual(start, -1, `frontend job must define step: ${name}`)
  const next = job.indexOf("\n      - name:", start + marker.length)
  return job.slice(start, next === -1 ? job.length : next)
}

function configuredVitestIncludes(): string[] {
  const match = vitestConfig.match(/\binclude:\s*\[([^\]]+)\]/)
  assert.ok(match, "vitest.config.ts must declare explicit test include globs")
  return Array.from(match[1].matchAll(/["']([^"']+)["']/g), (entry) => entry[1])
}

function matchesGlob(file: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  const source = escaped
    .replace(/\*\*\//g, "(?:.*/)?")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*")
  return new RegExp(`^${source}$`).test(file)
}

describe("frontend CI test gates", () => {
  it("runs compiled root tests and stable-pool Vitest as blocking frontend steps", () => {
    // The test gates run in their own job, in parallel with `Frontend · build`.
    const frontend = jobSource("frontend-tests")
    const compiledRoot = stepSource(frontend, "Unit & integration tests")
    const vitest = stepSource(frontend, "Vitest component & lib tests (hard gate)")
    stepSource(frontend, "TypeScript check (hard gate)")

    assert.match(compiledRoot, /^\s*run:\s*npm test\s*$/m)
    assert.doesNotMatch(compiledRoot, /continue-on-error\s*:/)
    assert.match(vitest, /^\s*run:\s*npm run test:unit -- --pool=threads\s*$/m)
    assert.doesNotMatch(vitest, /continue-on-error\s*:/)

    const timeout = frontend.match(/\btimeout-minutes:\s*(\d+)/)
    assert.ok(timeout, "frontend-tests job must define a timeout")
    assert.ok(Number(timeout[1]) >= 20, "frontend-tests timeout must cover every test gate")

    // Both frontend jobs are required by the aggregate check.
    const build = jobSource("frontend")
    const buildStep = stepSource(build, "Next.js build")
    assert.match(buildStep, /^\s*run:\s*\|\s*$/m)
    assert.match(buildStep, /^\s*set -euo pipefail\s*$/m, "the multi-command build must fail on the first error")
    assert.match(buildStep, /^\s*npm run build\s*$/m, "the production build command remains mandatory")
    assert.doesNotMatch(buildStep, /continue-on-error\s*:|\|\||(?:^|\n)\s*set\s+\+e\b/,
      "the production build cannot ignore an error")
    const gate = jobSource("ci")
    assert.match(gate, /needs:\s*\[[^\]]*\bfrontend\b[^\]]*\bfrontend-tests\b[^\]]*\]/)
    assert.match(gate, /needs\.frontend-tests\.result/)
    assert.match(gate, /needs\.frontend\.result/)
  })

  it("discovers the I16 authenticated-fetch, password, and upload regressions", () => {
    assert.equal(
      packageJson.scripts?.["test:unit"],
      "NODE_ENV=test vitest run",
      "the CI-facing Vitest script must not inherit a production React runtime",
    )

    const includes = configuredVitestIncludes()
    const requiredTests = [
      "tests/lib/authenticated-fetch.test.ts",
      "tests/lib/authenticated-fetch-contract.test.ts",
      "tests/components/password-reset-cookie-session.test.tsx",
      "tests/lib/projects-upload-cookie-session.test.ts",
    ]

    for (const testFile of requiredTests) {
      assert.equal(existsSync(testFile), true, `${testFile} must exist`)
      assert.equal(
        includes.some((pattern) => matchesGlob(testFile, pattern)),
        true,
        `${testFile} must be included by vitest.config.ts`,
      )
    }
  })
})
